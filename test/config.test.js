import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

const required = {
    AITUNNEL_API_KEY: 'sk-aitunnel-test-key',
    PROXY_API_KEY: 'a-local-proxy-secret-long-enough',
};

test('uses safe loopback defaults and validates configuration', () => {
    const config = getConfig(required);
    assert.equal(config.proxyHost, '127.0.0.1');
    assert.equal(config.proxyPort, 8787);
    assert.equal(config.aitunnelBaseUrl, 'https://api.aitunnel.ru/v1');
    assert.equal(config.cacheMode, 'auto');
    assert.equal(config.cacheTtl, '5m');
    assert.equal(config.sessionAffinity, true);
});

test('normalizes trailing slash on an AITUNNEL /v1 base URL', () => {
    const config = getConfig({ ...required, AITUNNEL_BASE_URL: 'https://ru-api.aitunnel.ru/v1/' });
    assert.equal(config.aitunnelBaseUrl, 'https://ru-api.aitunnel.ru/v1');
});

test('rejects upstream base URLs that would produce a wrong or unsafe path', () => {
    assert.throws(
        () => getConfig({ ...required, AITUNNEL_BASE_URL: 'https://api.aitunnel.ru/messages' }),
        /must end in \/v1/,
    );
    assert.throws(
        () => getConfig({ ...required, AITUNNEL_BASE_URL: 'https://user:pass@api.aitunnel.ru/v1' }),
        /without credentials/,
    );
});

test('rejects weak local keys and invalid cache settings', () => {
    assert.throws(() => getConfig({ ...required, PROXY_API_KEY: 'short' }), /at least 16 characters/);
    assert.throws(() => getConfig({ ...required, CACHE_MODE: 'sometimes' }), /CACHE_MODE must be auto or off/);
    assert.throws(() => getConfig({ ...required, CACHE_TTL: '30m' }), /CACHE_TTL must be 5m or 1h/);
});
