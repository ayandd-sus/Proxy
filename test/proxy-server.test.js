import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxyServer } from '../src/proxy-server.js';

const LOCAL_KEY = 'local-proxy-secret-for-tests';
const UPSTREAM_KEY = 'sk-aitunnel-test-secret';

function listen(server) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function collectBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function createPair(upstreamHandler, configOverrides = {}) {
    const requests = [];
    const logs = [];
    const upstream = createServer(async (request, response) => {
        const body = await collectBody(request);
        requests.push({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body,
        });
        await upstreamHandler(request, response, body);
    });
    const upstreamPort = await listen(upstream);

    const proxy = createProxyServer({
        aitunnelApiKey: UPSTREAM_KEY,
        aitunnelBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        proxyApiKey: LOCAL_KEY,
        cacheMode: 'auto',
        cacheTtl: '5m',
        sessionAffinity: true,
        maxBodyBytes: 1024 * 1024,
        upstreamTimeoutMs: 5_000,
        ...configOverrides,
    }, {
        logger: {
            info(message) { logs.push(message); },
            error(message) { logs.push(message); },
        },
    });
    const proxyPort = await listen(proxy);

    return {
        requests,
        logs,
        url: `http://127.0.0.1:${proxyPort}`,
        close: async () => {
            await Promise.all([close(proxy), close(upstream)]);
        },
    };
}

test('translates local x-api-key to AITUNNEL Bearer auth and injects Claude cache + affinity', async () => {
    const upstreamReply = '{"id":"msg_test","type":"message","usage":{"cache_creation_input_tokens":1200}}';
    const pair = await createPair(async (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(upstreamReply);
    });

    try {
        const response = await fetch(`${pair.url}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': LOCAL_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4.6',
                max_tokens: 32,
                system: 'Stable system prefix',
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(await response.text(), upstreamReply);
        assert.equal(pair.requests.length, 1);

        const sent = pair.requests[0];
        const sentBody = JSON.parse(sent.body);
        assert.equal(sent.method, 'POST');
        assert.equal(sent.url, '/v1/messages');
        assert.equal(sent.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
        assert.equal(sent.headers['x-api-key'], undefined);
        assert.equal(sent.headers['anthropic-version'], '2023-06-01');
        assert.equal(sent.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
        assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' });
        assert.match(sentBody.session_id, /^st_[0-9a-f]{64}$/);
        assert.ok(pair.logs.some(line => line.includes('cache usage') && line.includes('read=0 write=1200')));
    } finally {
        await pair.close();
    }
});

test('streams SSE response bytes and preserves explicit SillyTavern cache markers', async () => {
    const sse = [
        'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":700,"cache_creation_input_tokens":0}}}\r\n\r\n',
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\r\n\r\n',
        'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
    ].join('');
    let upstreamBody;
    const pair = await createPair(async (_request, response, body) => {
        upstreamBody = JSON.parse(body);
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('cache-control', 'no-cache');
        response.write(sse.slice(0, 55));
        await new Promise(resolve => setTimeout(resolve, 5));
        response.end(sse.slice(55));
    });

    try {
        const response = await fetch(`${pair.url}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${LOCAL_KEY}`,
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4.6',
                max_tokens: 32,
                system: [{ type: 'text', text: 'Stable system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        assert.equal(await response.text(), sse);
        assert.equal(Object.hasOwn(upstreamBody, 'cache_control'), false);
        assert.deepEqual(upstreamBody.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
        assert.match(upstreamBody.session_id, /^st_[0-9a-f]{64}$/);
        assert.ok(pair.logs.some(line => line.includes('cache usage') && line.includes('read=700 write=0')));
    } finally {
        await pair.close();
    }
});

test('supports the OpenAI-compatible Claude route with standard Bearer client auth', async () => {
    const reply = '{"usage":{"prompt_tokens_details":{"cached_tokens":90,"cache_write_tokens":0}}}';
    const pair = await createPair(async (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(reply);
    });

    try {
        const response = await fetch(`${pair.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}` },
            body: JSON.stringify({
                model: 'anthropic/claude-sonnet-4.6',
                messages: [{ role: 'system', content: 'Stable prefix' }, { role: 'user', content: 'Hello' }],
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(await response.text(), reply);
        assert.equal(pair.requests[0].url, '/v1/chat/completions');
        assert.equal(pair.requests[0].headers.authorization, `Bearer ${UPSTREAM_KEY}`);
        assert.deepEqual(JSON.parse(pair.requests[0].body).cache_control, { type: 'ephemeral' });
        assert.ok(pair.logs.some(line => line.includes('cache usage') && line.includes('read=90 write=0')));
    } finally {
        await pair.close();
    }
});

test('relays GET /v1/models and its query string with Bearer auth', async () => {
    const reply = '{"data":[{"id":"claude-sonnet-4.6"}]}';
    const pair = await createPair(async (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(reply);
    });

    try {
        const response = await fetch(`${pair.url}/v1/models?limit=10`, {
            headers: { 'x-api-key': LOCAL_KEY },
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), reply);
        assert.equal(pair.requests[0].url, '/v1/models?limit=10');
        assert.equal(pair.requests[0].headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    } finally {
        await pair.close();
    }
});

test('rejects missing or incorrect local credentials without contacting AITUNNEL', async () => {
    const pair = await createPair(async (_request, response) => {
        response.end('unexpected');
    });

    try {
        const response = await fetch(`${pair.url}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-secret' },
            body: JSON.stringify({ model: 'claude-sonnet-4.6', messages: [] }),
        });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.type, 'authentication_error');
        assert.equal(pair.requests.length, 0);
    } finally {
        await pair.close();
    }
});

test('rejects oversized prompt bodies before forwarding them', async () => {
    const pair = await createPair(async (_request, response) => {
        response.end('unexpected');
    }, { maxBodyBytes: 64 });

    try {
        const response = await fetch(`${pair.url}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_KEY },
            body: JSON.stringify({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
        });
        assert.equal(response.status, 413);
        assert.equal(pair.requests.length, 0);
    } finally {
        await pair.close();
    }
});

test('health check is unauthenticated and reveals no credential/config values', async () => {
    const pair = await createPair(async (_request, response) => response.end('unexpected'));

    try {
        const response = await fetch(`${pair.url}/healthz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
        assert.equal(pair.requests.length, 0);
    } finally {
        await pair.close();
    }
});

test('prefix diff logging is opt-in and reports growth versus a rewrite (chat completions)', async () => {
    const upstreamReply = JSON.stringify({
        id: 'chatcmpl_test',
        usage: { prompt_tokens: 4096, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4096 } },
    });

    const send = async (pair, messages) => {
        const response = await fetch(`${pair.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_KEY}` },
            body: JSON.stringify({ model: 'claude-sonnet-4.6', messages }),
        });
        assert.equal(response.status, 200);
        await response.text();
    };

    const history = [{ role: 'user', content: 'first turn' }];

    const pair = await createPair(async (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(upstreamReply);
    }, { prefixDiffLog: true });

    try {
        await send(pair, [...history]);
        await send(pair, [...history, { role: 'assistant', content: 'reply' }]);

        const messages = pair.logs.filter(line => line.startsWith('[proxy] prefix'));
        assert.equal(messages.length, 2);
        assert.match(messages[0], /prefix baseline segments=1/);
        assert.match(messages[1], /prefix GREW ONLY segments=1 -> 2/);

        const sessions = pair.logs.filter(line => line.startsWith('[proxy] session fingerprint'));
        assert.equal(sessions.length, 2);
        assert.match(sessions[1], /\(stable\)/);
    } finally {
        await pair.close();
    }

    const quiet = await createPair(async (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(upstreamReply);
    });

    try {
        await send(quiet, [...history]);
        await send(quiet, [...history, { role: 'assistant', content: 'reply' }]);
        assert.equal(quiet.logs.filter(line => line.startsWith('[proxy] prefix')).length, 0);
    } finally {
        await quiet.close();
    }
});
