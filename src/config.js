import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
    aitunnelBaseUrl: 'https://api.aitunnel.ru/v1',
    proxyHost: '127.0.0.1',
    proxyPort: 8787,
    cacheMode: 'auto',
    cacheTtl: '5m',
    sessionAffinity: true,
    prefixDiffLog: false,
    maxBodyBytes: 128 * 1024 * 1024,
    upstreamTimeoutMs: 10 * 60 * 1000,
};

/**
 * Load a small, dotenv-compatible KEY=value file without overriding real environment values.
 * The file is optional so the app can also be configured entirely through the process env.
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} Whether the file was read.
 */
export function loadEnvFile(filePath = path.resolve(process.cwd(), '.env'), env = process.env) {
    let contents;
    try {
        contents = readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }

    for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) {
            continue;
        }

        const [, name, rawValue] = match;
        if (env[name] !== undefined) {
            continue;
        }

        let value = rawValue.trim();
        if (value.startsWith('"')) {
            try {
                // JSON string parsing handles common escapes in double-quoted values.
                value = JSON.parse(value);
            } catch {
                value = value.slice(1).replace(/"\s+#.*$/, '').replace(/"$/, '');
            }
        } else if (value.startsWith("'")) {
            const closingQuote = value.indexOf("'", 1);
            value = closingQuote >= 0 ? value.slice(1, closingQuote) : value.slice(1);
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
        }

        env[name] = value;
    }

    return true;
}

function requiredString(env, key) {
    const value = env[key]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function parseInteger(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    if (!/^\d+$/.test(raw.trim())) {
        throw new Error(`${key} must be a whole number`);
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be between ${min} and ${max}`);
    }
    return value;
}

function parseBoolean(env, key, fallback) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    switch (raw.trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            throw new Error(`${key} must be one of: on/off, true/false, yes/no, 1/0`);
    }
}

/**
 * Optional fixed session ID. AITUNNEL keeps prompt caches at a specific provider, so a
 * value that never changes gives the most reliable affinity. Max length is AITUNNEL's.
 * @param {NodeJS.ProcessEnv} env
 */
function parseSessionId(env) {
    const raw = env.SESSION_ID;
    if (raw === undefined || raw.trim() === '') {
        return null;
    }

    const value = raw.trim();
    if (value.length > 256) {
        throw new Error('SESSION_ID must be a string no longer than 256 characters');
    }
    return value;
}

function parseBaseUrl(rawValue) {
    let url;
    try {
        url = new URL(rawValue);
    } catch {
        throw new Error('AITUNNEL_BASE_URL must be an absolute http(s) URL ending in /v1');
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('AITUNNEL_BASE_URL must be an http(s) URL without credentials, query, or fragment');
    }

    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/v1')) {
        throw new Error('AITUNNEL_BASE_URL must end in /v1, for example https://api.aitunnel.ru/v1');
    }

    return `${url.origin}${pathname}`;
}

/**
 * Read and validate runtime settings. Call loadEnvFile first when using a local .env file.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getConfig(env = process.env) {
    const aitunnelApiKey = requiredString(env, 'AITUNNEL_API_KEY');
    const proxyApiKey = requiredString(env, 'PROXY_API_KEY');

    if (aitunnelApiKey === 'sk-aitunnel-replace-me') {
        throw new Error('Replace the example AITUNNEL_API_KEY in .env with your real AITUNNEL key');
    }
    if (proxyApiKey === 'replace-with-a-long-random-secret' || proxyApiKey.length < 16) {
        throw new Error('PROXY_API_KEY must be a unique secret at least 16 characters long');
    }

    const cacheMode = (env.CACHE_MODE || DEFAULTS.cacheMode).trim().toLowerCase();
    if (!['auto', 'off', 'history'].includes(cacheMode)) {
        throw new Error('CACHE_MODE must be auto, history, or off');
    }

    const cacheTtl = (env.CACHE_TTL || DEFAULTS.cacheTtl).trim().toLowerCase();
    if (!['5m', '1h'].includes(cacheTtl)) {
        throw new Error('CACHE_TTL must be 5m or 1h');
    }

    return {
        aitunnelApiKey,
        aitunnelBaseUrl: parseBaseUrl(env.AITUNNEL_BASE_URL?.trim() || DEFAULTS.aitunnelBaseUrl),
        proxyApiKey,
        proxyHost: env.PROXY_HOST?.trim() || DEFAULTS.proxyHost,
        proxyPort: parseInteger(env, 'PROXY_PORT', DEFAULTS.proxyPort, { min: 0, max: 65535 }),
        cacheMode,
        cacheTtl,
        sessionAffinity: parseBoolean(env, 'SESSION_AFFINITY', DEFAULTS.sessionAffinity),
        sessionId: parseSessionId(env),
        prefixDiffLog: parseBoolean(env, 'PREFIX_DIFF_LOG', DEFAULTS.prefixDiffLog),
        maxBodyBytes: parseInteger(env, 'MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, { min: 1, max: 1024 * 1024 * 1024 }),
        upstreamTimeoutMs: parseInteger(env, 'UPSTREAM_TIMEOUT_MS', DEFAULTS.upstreamTimeoutMs, { min: 0, max: 24 * 60 * 60 * 1000 }),
    };
}
