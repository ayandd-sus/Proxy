import { createHash } from 'node:crypto';

/**
 * Prompt caching only pays off when the prefix of consecutive requests is byte-identical.
 * This module fingerprints that prefix (system prompt + every message, in order) and reports
 * the first segment that differs from the previous request.
 *
 * Only short hashes of the previous request are kept in memory; prompt text is never stored.
 */

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Serialize with sorted keys so that key reordering is not reported as a content change.
 * @param {unknown} value
 */
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    if (isObject(value)) {
        const entries = Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
        return `{${entries.join(',')}}`;
    }

    return JSON.stringify(value ?? null);
}

/** @param {string} value */
function shortHash(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Fingerprint the segments that form the cached prefix: the top-level system prompt
 * first, then each message in the order the model receives it.
 * @param {object} body
 * @returns {{label: string, hash: string}[]}
 */
export function segmentHashes(body) {
    const segments = [];
    if (!isObject(body)) {
        return segments;
    }

    if (body.system !== undefined) {
        segments.push({ label: 'system', hash: shortHash(stableStringify(body.system)) });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (let i = 0; i < messages.length; i += 1) {
        const message = isObject(messages[i]) ? messages[i] : {};
        const role = typeof message.role === 'string' ? message.role : '?';
        segments.push({
            label: `msg[${i}] role=${role}`,
            hash: shortHash(stableStringify({ role: message.role, content: message.content })),
        });
    }

    return segments;
}

/**
 * Compare two segment lists and locate the first divergence.
 * @param {{label: string, hash: string}[]} previous
 * @param {{label: string, hash: string}[]} next
 */
export function diffSegments(previous, next) {
    const shared = Math.min(previous.length, next.length);
    let firstChangeIndex = -1;

    for (let i = 0; i < shared; i += 1) {
        if (previous[i].hash !== next[i].hash) {
            firstChangeIndex = i;
            break;
        }
    }

    // Length change alone means the shared prefix is intact and only the tail grew.
    if (firstChangeIndex === -1 && previous.length !== next.length) {
        firstChangeIndex = shared;
    }

    return {
        changed: firstChangeIndex !== -1,
        // A change at or past the end of the shorter list means nothing was rewritten.
        rewritten: firstChangeIndex !== -1 && firstChangeIndex < Math.min(previous.length, next.length),
        firstChangeIndex,
        previousCount: previous.length,
        nextCount: next.length,
        label: firstChangeIndex === -1
            ? null
            : (next[firstChangeIndex]?.label ?? previous[firstChangeIndex]?.label ?? null),
        previousHash: firstChangeIndex === -1 ? null : (previous[firstChangeIndex]?.hash ?? null),
        nextHash: firstChangeIndex === -1 ? null : (next[firstChangeIndex]?.hash ?? null),
    };
}

/**
 * Track prefix fingerprints across consecutive requests and log the verdict.
 * Disabled by default: it is a diagnostic, not part of normal operation.
 * @param {{logger?: Console, enabled?: boolean, maxSegments?: number}} options
 */
export function createPrefixTracker({ logger, enabled = false, maxSegments = 100_000 } = {}) {
    let previousSegments = null;
    let previousSession = null;

    function log(message) {
        try {
            logger?.info?.(message);
        } catch {
            // Diagnostics must never interrupt a proxied request.
        }
    }

    return {
        /**
         * @param {object} body The request body after proxy transformations.
         * @param {string} [sessionId] The effective session_id sent upstream, if any.
         */
        record(body, sessionId) {
            if (!enabled) {
                return;
            }

            const session = typeof sessionId === 'string' && sessionId.length > 0
                ? shortHash(sessionId)
                : null;

            if (session) {
                if (previousSession === null) {
                    log(`[proxy] session fingerprint=${session} (baseline)`);
                } else if (previousSession === session) {
                    log(`[proxy] session fingerprint=${session} (stable)`);
                } else {
                    log(`[proxy] session fingerprint ${previousSession} -> ${session} (CHANGED: AITUNNEL provider affinity may reset)`);
                }
            }

            const segments = segmentHashes(body);
            if (segments.length > maxSegments) {
                log(`[proxy] prefix diff skipped: ${segments.length} segments exceeds the ${maxSegments}-segment limit`);
                previousSegments = null;
                previousSession = session;
                return;
            }

            if (previousSegments === null) {
                log(`[proxy] prefix baseline segments=${segments.length}`);
            } else {
                const diff = diffSegments(previousSegments, segments);
                if (!diff.changed) {
                    log(`[proxy] prefix unchanged segments=${segments.length}`);
                } else if (!diff.rewritten) {
                    log(`[proxy] prefix GREW ONLY segments=${diff.previousCount} -> ${diff.nextCount} (shared prefix intact; cache should hit)`);
                } else {
                    log(`[proxy] prefix REWRITTEN at ${diff.label} ${diff.previousHash} -> ${diff.nextHash} (segments ${diff.previousCount} -> ${diff.nextCount})`);
                }
            }

            previousSegments = segments;
            previousSession = session;
        },
    };
}
