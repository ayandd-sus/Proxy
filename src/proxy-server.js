import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { addCacheAndAffinity } from './cache.js';
import { createUsageObserver } from './usage-observer.js';

const ROUTES = new Map([
    ['GET /v1/models', { transform: false }],
    ['POST /v1/messages', { transform: true }],
    ['POST /v1/messages/count_tokens', { transform: false }],
    ['POST /v1/chat/completions', { transform: true }],
]);

const RESPONSE_HEADERS = [
    'content-type',
    'cache-control',
    'retry-after',
    'etag',
    'last-modified',
    'vary',
    'content-language',
    'anthropic-request-id',
    'anthropic-version',
    'request-id',
    'x-request-id',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
];

class HttpError extends Error {
    constructor(statusCode, message, type = 'invalid_request_error') {
        super(message);
        this.statusCode = statusCode;
        this.type = type;
    }
}

function safeLog(logger, level, message) {
    try {
        logger?.[level]?.(message);
    } catch {
        // Logging must never interrupt a proxied request.
    }
}

function safeLabel(value) {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
}

function sendJson(response, statusCode, payload) {
    if (response.headersSent || response.destroyed) {
        return;
    }

    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    response.end(body);
}

function isAuthorized(request, expectedKey) {
    const apiKey = request.headers['x-api-key'];
    const authorization = request.headers.authorization;
    const bearerMatch = typeof authorization === 'string'
        ? authorization.match(/^Bearer\s+(.+)$/i)
        : null;
    const supplied = typeof apiKey === 'string' && apiKey.length > 0
        ? apiKey
        : (bearerMatch?.[1] ?? '');

    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expectedKey);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function parseTarget(requestTarget) {
    if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/')) {
        throw new HttpError(400, 'Expected an origin-form request path');
    }

    let url;
    try {
        url = new URL(requestTarget, 'http://proxy.invalid');
    } catch {
        throw new HttpError(400, 'Malformed request URL');
    }

    const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return { pathname, search: url.search };
}

function validateJsonContentType(request) {
    const contentType = request.headers['content-type'];
    if (typeof contentType === 'string' && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
        throw new HttpError(415, 'This endpoint accepts JSON request bodies only', 'unsupported_media_type');
    }

    const contentEncoding = request.headers['content-encoding'];
    if (typeof contentEncoding === 'string' && !['identity', ''].includes(contentEncoding.toLowerCase())) {
        throw new HttpError(415, 'Compressed request bodies are not supported', 'unsupported_media_type');
    }
}

async function readLimitedBody(request, maxBodyBytes) {
    const contentLength = request.headers['content-length'];
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > maxBodyBytes) {
        throw new HttpError(413, `Request body exceeds the ${maxBodyBytes}-byte limit`, 'request_too_large');
    }

    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBodyBytes) {
            throw new HttpError(413, `Request body exceeds the ${maxBodyBytes}-byte limit`, 'request_too_large');
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks, length);
}

function parseRequestBody(buffer) {
    if (buffer.length === 0) {
        throw new HttpError(400, 'A JSON request body is required');
    }

    let body;
    try {
        body = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new HttpError(400, 'Request body is not valid JSON');
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'The JSON request body must be an object');
    }

    return body;
}

function getSessionHeader(request) {
    const value = request.headers['x-session-id'];
    if (Array.isArray(value)) {
        if (value.some(item => typeof item !== 'string' || item.length > 256)) {
            throw new HttpError(400, 'x-session-id must be no longer than 256 characters');
        }
        return value;
    }
    if (typeof value === 'string' && value.length > 256) {
        throw new HttpError(400, 'x-session-id must be no longer than 256 characters');
    }
    return value;
}

function makeUpstreamUrl(baseUrl, pathname, search) {
    const apiPrefix = '/v1';
    if (!pathname.startsWith(`${apiPrefix}/`)) {
        throw new HttpError(404, 'Endpoint not found', 'not_found_error');
    }
    return `${baseUrl}${pathname.slice(apiPrefix.length)}${search}`;
}

function makeUpstreamHeaders(request, routePath, config, sessionHeader) {
    const headers = {
        authorization: `Bearer ${config.aitunnelApiKey}`,
        accept: typeof request.headers.accept === 'string'
            ? request.headers.accept
            : 'application/json, text/event-stream',
    };

    if (request.method !== 'GET') {
        headers['content-type'] = typeof request.headers['content-type'] === 'string'
            ? request.headers['content-type']
            : 'application/json';
    }

    if (routePath === '/v1/messages' || routePath === '/v1/messages/count_tokens') {
        for (const name of ['anthropic-version', 'anthropic-beta']) {
            const value = request.headers[name];
            if (typeof value === 'string') {
                headers[name] = value;
            }
        }
    }

    if (typeof sessionHeader === 'string') {
        headers['x-session-id'] = sessionHeader;
    }

    return headers;
}

function copyUpstreamHeaders(upstreamResponse, response) {
    for (const name of RESPONSE_HEADERS) {
        const value = upstreamResponse.headers.get(name);
        if (value !== null) {
            response.setHeader(name, value);
        }
    }
}

function errorPayload(error, requestId) {
    return {
        type: 'error',
        error: {
            type: error.type || 'api_error',
            message: error.message,
        },
        ...(requestId ? { request_id: requestId } : {}),
    };
}

function validateSessionValues(request, body) {
    if (Object.hasOwn(body, 'session_id') && (typeof body.session_id !== 'string' || body.session_id.length > 256)) {
        throw new HttpError(400, 'session_id must be a string no longer than 256 characters');
    }
    return getSessionHeader(request);
}

/**
 * Create the HTTP server. Kept separate from the entry point for integration testing.
 * @param {object} config Validated config from getConfig().
 * @param {{fetchImpl?: typeof fetch, logger?: Console}} [options]
 */
export function createProxyServer(config, { fetchImpl = fetch, logger = console } = {}) {
    const server = createServer(async (request, response) => {
        const startedAt = Date.now();
        let target;
        try {
            target = parseTarget(request.url);
        } catch (error) {
            sendJson(response, error.statusCode || 400, errorPayload(error));
            return;
        }

        if (target.pathname === '/healthz') {
            if (request.method !== 'GET') {
                response.setHeader('allow', 'GET');
                sendJson(response, 405, errorPayload(new HttpError(405, 'Method not allowed', 'method_not_allowed_error')));
                return;
            }
            sendJson(response, 200, { status: 'ok' });
            return;
        }

        const route = ROUTES.get(`${request.method} ${target.pathname}`);
        if (!route) {
            const methodExists = [...ROUTES.keys()].some(key => key.endsWith(` ${target.pathname}`));
            if (methodExists) {
                response.setHeader('allow', [...ROUTES.keys()]
                    .filter(key => key.endsWith(` ${target.pathname}`))
                    .map(key => key.slice(0, key.indexOf(' ')))
                    .join(', '));
                sendJson(response, 405, errorPayload(new HttpError(405, 'Method not allowed', 'method_not_allowed_error')));
            } else {
                sendJson(response, 404, errorPayload(new HttpError(404, 'Endpoint not found', 'not_found_error')));
            }
            return;
        }

        if (!isAuthorized(request, config.proxyApiKey)) {
            sendJson(response, 401, errorPayload(new HttpError(401, 'Invalid local proxy API key', 'authentication_error')));
            return;
        }

        let requestBody;
        let parsedBody;
        let sessionHeader;
        let cacheAction = 'none';
        let sessionAction = 'none';

        try {
            if (request.method !== 'GET') {
                validateJsonContentType(request);
                requestBody = await readLimitedBody(request, config.maxBodyBytes);

                if (route.transform) {
                    parsedBody = parseRequestBody(requestBody);
                    sessionHeader = validateSessionValues(request, parsedBody);
                    const result = addCacheAndAffinity(parsedBody, config, { sessionId: sessionHeader });
                    cacheAction = result.cacheAction;
                    sessionAction = result.sessionAction;
                    requestBody = Buffer.from(JSON.stringify(parsedBody));
                } else {
                    sessionHeader = getSessionHeader(request);
                }
            } else {
                sessionHeader = getSessionHeader(request);
            }
        } catch (error) {
            const statusCode = error.statusCode || 400;
            sendJson(response, statusCode, errorPayload(error));
            return;
        }

        const upstreamUrl = makeUpstreamUrl(config.aitunnelBaseUrl, target.pathname, target.search);
        const upstreamHeaders = makeUpstreamHeaders(request, target.pathname, config, sessionHeader);
        const safeModel = typeof parsedBody?.model === 'string' ? ` model=${safeLabel(parsedBody.model)}` : '';
        const safeCache = cacheAction !== 'none' ? ` cache=${cacheAction}` : '';
        const safeSession = sessionAction !== 'none' ? ` affinity=${sessionAction}` : '';
        response.once('finish', () => {
            const durationMs = Date.now() - startedAt;
            safeLog(logger, 'info', `[proxy] ${request.method} ${target.pathname} -> ${response.statusCode} in ${durationMs}ms${safeModel}${safeCache}${safeSession}`);
        });

        const controller = new AbortController();
        let timedOut = false;
        const abortForClientDisconnect = () => {
            if (!response.writableEnded) {
                controller.abort();
            }
        };
        request.once('aborted', abortForClientDisconnect);
        response.once('close', abortForClientDisconnect);

        const timeout = config.upstreamTimeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, config.upstreamTimeoutMs)
            : null;
        timeout?.unref?.();

        try {
            const upstreamResponse = await fetchImpl(upstreamUrl, {
                method: request.method,
                headers: upstreamHeaders,
                ...(request.method === 'GET' ? {} : { body: requestBody }),
                signal: controller.signal,
                // Do not forward the AITUNNEL credential to a redirect target.
                redirect: 'manual',
            });

            response.statusCode = upstreamResponse.status;
            if (upstreamResponse.statusText) {
                response.statusMessage = upstreamResponse.statusText;
            }
            copyUpstreamHeaders(upstreamResponse, response);

            if (!upstreamResponse.body) {
                response.end();
                return;
            }

            const upstreamStream = Readable.fromWeb(upstreamResponse.body);
            if (route.transform) {
                const observer = createUsageObserver({
                    contentType: upstreamResponse.headers.get('content-type'),
                    logger,
                    model: parsedBody?.model,
                });
                await pipeline(upstreamStream, observer, response);
            } else {
                await pipeline(upstreamStream, response);
            }
        } catch (error) {
            if (response.destroyed || response.writableEnded) {
                return;
            }

            if (response.headersSent) {
                response.destroy(error);
                return;
            }

            if (timedOut) {
                sendJson(response, 504, errorPayload(new HttpError(504, 'AITUNNEL request timed out', 'timeout_error')));
                return;
            }

            safeLog(logger, 'error', `[proxy] upstream request failed for ${target.pathname}: ${error?.name || 'Error'}`);
            sendJson(response, 502, errorPayload(new HttpError(502, 'Could not reach the AITUNNEL API', 'api_connection_error')));
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            request.removeListener('aborted', abortForClientDisconnect);
            response.removeListener('close', abortForClientDisconnect);
        }
    });

    return server;
}
