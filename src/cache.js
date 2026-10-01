import { createHmac } from 'node:crypto';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasBlockMarker(value) {
    if (!Array.isArray(value)) {
        return false;
    }

    return value.some((block) => isObject(block) && block.cache_control != null);
}

/**
 * Detect Anthropic/AITUNNEL explicit cache breakpoints in the supported request fields.
 * If any are present, the proxy must not add an automatic top-level breakpoint as well.
 * @param {object} body
 */
export function hasExplicitCacheControl(body) {
    if (!isObject(body)) {
        return false;
    }

    if (body.cache_control != null) {
        return true;
    }

    if (hasBlockMarker(body.system)) {
        return true;
    }

    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            if (!isObject(message)) {
                continue;
            }
            if (message.cache_control != null || hasBlockMarker(message.content)) {
                return true;
            }
        }
    }

    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (isObject(tool) && (tool.cache_control != null || tool.function?.cache_control != null)) {
                return true;
            }
        }
    }

    return false;
}

/** @param {unknown} model */
export function isClaudeModel(model) {
    return typeof model === 'string' && /claude/i.test(model);
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (!isObject(value)) {
        return value;
    }

    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(key => [key, canonicalize(value[key])]),
    );
}

/**
 * Build the anchor used to derive a session ID.
 *
 * Provider affinity needs an ID that stays identical for the whole conversation, so the
 * anchor must only use parts of the request that do not change between turns. The system
 * prompt is the only such part: in a short chat the first non-system message *is* the
 * newest message, and SillyTavern rewrites it on every turn, which made the derived ID
 * change every request and reset provider affinity along with it.
 * @param {object} body
 */
function getSessionAnchor(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemMessage = messages.find(message => isObject(message) && ['system', 'developer'].includes(message.role));
    const systemPrompt = body.system ?? (systemMessage ? { role: systemMessage.role, content: systemMessage.content } : null);

    if (systemPrompt !== null && systemPrompt !== undefined) {
        return { model: body.model, system: systemPrompt };
    }

    // Without a system prompt there is nothing more stable than the first message.
    const firstMessage = messages.find(message => isObject(message));

    return {
        model: body.model,
        system: null,
        first: firstMessage
            ? { role: firstMessage.role, content: firstMessage.content }
            : (typeof body.prompt === 'string' ? { role: 'user', content: body.prompt } : null),
    };
}

/**
 * Produce an opaque, stable session ID from the model and the system prompt.
 * The HMAC keeps prompt text and the upstream API key out of the value sent over the wire.
 * @param {object} body
 * @param {string} secret
 */
export function createSessionId(body, secret) {
    const anchor = JSON.stringify(canonicalize(getSessionAnchor(body)));
    const digest = createHmac('sha256', secret)
        .update('sillytavern-aitunnel-cache-proxy:v1\0')
        .update(anchor)
        .digest('hex');
    return `st_${digest}`;
}

/**
 * Add AITUNNEL's top-level automatic Claude cache marker and/or stable session affinity.
 * Existing explicit Anthropic block markers are left untouched.
 * @param {object} body Parsed JSON request body; mutated in place.
 * @param {{cacheMode: 'auto'|'off', cacheTtl: '5m'|'1h', sessionAffinity: boolean, aitunnelApiKey: string}} config
 * @param {{sessionId?: string|string[]}} [headers]
 * @returns {{cacheAction: string, sessionAction: string}}
 */
export function addCacheAndAffinity(body, config, headers = {}) {
    const model = isObject(body) ? body.model : undefined;
    if (!isObject(body) || !isClaudeModel(model)) {
        return { cacheAction: 'not-claude', sessionAction: 'not-claude' };
    }

    let cacheAction = 'off';
    if (config.cacheMode === 'auto') {
        if (hasExplicitCacheControl(body)) {
            cacheAction = 'preserved';
        } else {
            body.cache_control = config.cacheTtl === '1h'
                ? { type: 'ephemeral', ttl: '1h' }
                : { type: 'ephemeral' };
            cacheAction = 'added';
        }
    } else if (hasExplicitCacheControl(body)) {
        cacheAction = 'preserved';
    }

    let sessionAction = 'off';
    if (config.sessionAffinity) {
        if (typeof body.session_id === 'string' && body.session_id.length > 0) {
            sessionAction = 'preserved';
        } else {
            const headerSessionId = Array.isArray(headers.sessionId)
                ? headers.sessionId[0]
                : headers.sessionId;
            if (typeof headerSessionId === 'string' && headerSessionId.length > 0) {
                body.session_id = headerSessionId;
                sessionAction = 'copied';
            } else if (typeof config.sessionId === 'string' && config.sessionId.length > 0) {
                body.session_id = config.sessionId;
                sessionAction = 'configured';
            } else {
                body.session_id = createSessionId(body, config.aitunnelApiKey);
                sessionAction = 'added';
            }
        }
    }

    return { cacheAction, sessionAction };
}
