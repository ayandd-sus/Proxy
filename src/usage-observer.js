import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';

const MAX_JSON_INSPECTION_BYTES = 4 * 1024 * 1024;
const MAX_SSE_EVENT_BUFFER_BYTES = 64 * 1024;

function safeInfo(logger, message) {
    try {
        logger?.info?.(message);
    } catch {
        // Metrics are observational; they must not affect the upstream response stream.
    }
}

function safeLabel(value) {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
}

function numericValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumNumericValues(values) {
    const numbers = values.map(numericValue).filter(value => value !== null);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function readCacheCounts(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const promptDetails = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
    const creation = usage.cache_creation;
    const writeFromCreation = creation && typeof creation === 'object'
        ? sumNumericValues(Object.values(creation))
        : null;

    const read = numericValue(usage.cache_read_input_tokens)
        ?? numericValue(promptDetails.cached_tokens)
        ?? numericValue(usage.cached_tokens);
    const write = numericValue(usage.cache_creation_input_tokens)
        ?? numericValue(promptDetails.cache_write_tokens)
        ?? numericValue(usage.cache_write_tokens)
        ?? writeFromCreation;

    if (read === null && write === null) {
        return null;
    }

    return { read: read ?? 0, write: write ?? 0 };
}

function logUsageData(data, logger, model) {
    const usage = data?.usage ?? data?.message?.usage ?? data?.response?.usage;
    const counts = readCacheCounts(usage);
    if (!counts) {
        return;
    }

    const safeModel = typeof model === 'string' ? ` model=${safeLabel(model)}` : '';
    safeInfo(logger, `[proxy] cache usage${safeModel} read=${counts.read} write=${counts.write}`);
}

function inspectSseEvent(eventText, logger, model) {
    const data = eventText
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
    if (!data || data === '[DONE]') {
        return;
    }

    try {
        logUsageData(JSON.parse(data), logger, model);
    } catch {
        // Ignore keep-alives, partial/non-JSON events, and provider-specific event payloads.
    }
}

function createSseInspector(logger, model) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const inspect = (text) => {
        buffer += text;
        let delimiter;
        while ((delimiter = /\r?\n\r?\n/.exec(buffer)) !== null) {
            const eventText = buffer.slice(0, delimiter.index);
            buffer = buffer.slice(delimiter.index + delimiter[0].length);
            inspectSseEvent(eventText, logger, model);
        }

        // A malformed/unknown stream should not make the metrics side-buffer unbounded.
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BUFFER_BYTES) {
            buffer = buffer.slice(-MAX_SSE_EVENT_BUFFER_BYTES);
        }
    };

    return {
        write(chunk) {
            inspect(decoder.write(chunk));
        },
        end() {
            inspect(decoder.end());
            if (buffer.trim()) {
                inspectSseEvent(buffer, logger, model);
            }
            buffer = '';
        },
    };
}

/**
 * Pass response bytes through unchanged while logging only provider cache-token counters.
 * JSON inspection is capped; SSE events are inspected incrementally.
 * @param {{contentType?: string|null, logger?: Console, model?: string}} options
 */
export function createUsageObserver({ contentType = '', logger = console, model } = {}) {
    const isEventStream = /text\/event-stream/i.test(contentType || '');
    const sseInspector = isEventStream ? createSseInspector(logger, model) : null;
    let jsonBytes = 0;
    let jsonParts = [];
    let canInspectJson = !isEventStream;

    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                if (sseInspector) {
                    sseInspector.write(chunk);
                } else if (canInspectJson) {
                    jsonBytes += chunk.length;
                    if (jsonBytes <= MAX_JSON_INSPECTION_BYTES) {
                        jsonParts.push(Buffer.from(chunk));
                    } else {
                        canInspectJson = false;
                        jsonParts = [];
                    }
                }
                callback(null, chunk);
            } catch {
                callback(null, chunk);
            }
        },
        flush(callback) {
            try {
                if (sseInspector) {
                    sseInspector.end();
                } else if (canInspectJson && jsonParts.length > 0) {
                    const responseText = Buffer.concat(jsonParts, jsonBytes).toString('utf8');
                    logUsageData(JSON.parse(responseText), logger, model);
                }
            } catch {
                // Bad JSON or unsupported usage shape does not affect the response.
            }
            callback();
        },
    });
}
