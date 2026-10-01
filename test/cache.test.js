import test from 'node:test';
import assert from 'node:assert/strict';
import { addCacheAndAffinity, addHistoryBreakpoint, createSessionId, hasExplicitCacheControl, isClaudeModel } from '../src/cache.js';

const key = 'sk-aitunnel-test-secret';

function config(overrides = {}) {
    return {
        cacheMode: 'auto',
        cacheTtl: '5m',
        sessionAffinity: true,
        aitunnelApiKey: key,
        ...overrides,
    };
}

test('recognizes Anthropic Claude model IDs, including provider-prefixed IDs', () => {
    assert.equal(isClaudeModel('claude-sonnet-4.6'), true);
    assert.equal(isClaudeModel('anthropic/claude-opus-5'), true);
    assert.equal(isClaudeModel('gpt-6-astra'), false);
    assert.equal(isClaudeModel(undefined), false);
});

test('adds the 5-minute automatic cache marker and opaque session affinity only for Claude', () => {
    const body = {
        model: 'claude-sonnet-4.6',
        system: [{ type: 'text', text: 'A stable system prompt' }],
        messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = addCacheAndAffinity(body, config());

    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.match(body.session_id, /^st_[0-9a-f]{64}$/);
    assert.equal(result.cacheAction, 'added');
    assert.equal(result.sessionAction, 'added');
});

test('uses the configured one-hour TTL for automatic cache markers', () => {
    const body = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'Hello' }] };
    addCacheAndAffinity(body, config({ cacheTtl: '1h' }));
    assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('preserves existing top-level and block-level cache markers without adding another', () => {
    const topLevel = {
        model: 'claude-sonnet-4.6',
        cache_control: { type: 'ephemeral', ttl: '1h' },
        messages: [{ role: 'user', content: 'Hello' }],
    };
    const blockLevel = {
        model: 'claude-sonnet-4.6',
        system: [{ type: 'text', text: 'Prompt', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Hello' }],
    };

    assert.equal(hasExplicitCacheControl(topLevel), true);
    assert.equal(hasExplicitCacheControl(blockLevel), true);
    assert.equal(addCacheAndAffinity(topLevel, config()).cacheAction, 'preserved');
    assert.equal(addCacheAndAffinity(blockLevel, config()).cacheAction, 'preserved');
    assert.equal(Object.hasOwn(blockLevel, 'cache_control'), false);
});

test('does not add proxy cache markers when cache mode is off', () => {
    const body = { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'Hello' }] };
    const result = addCacheAndAffinity(body, config({ cacheMode: 'off' }));
    assert.equal(Object.hasOwn(body, 'cache_control'), false);
    assert.equal(result.cacheAction, 'off');
    assert.equal(typeof body.session_id, 'string');
});

test('session ID is deterministic and opaque', () => {
    const body = {
        model: 'claude-sonnet-4.6',
        system: 'Private system prompt text',
        messages: [{ role: 'user', content: 'Private first message text' }],
    };
    const first = createSessionId(body, key);

    assert.equal(first, createSessionId(structuredClone(body), key));
    assert.match(first, /^st_[0-9a-f]{64}$/);
    assert.doesNotMatch(first, /Private/);
});

test('session ID survives a changing newest message, because that would reset provider affinity', () => {
    // SillyTavern rewrites the newest (and in a short chat, first) message every turn.
    // The derived ID must not move with it, or AITUNNEL affinity resets on every request.
    const body = {
        model: 'claude-sonnet-4.6',
        system: 'Stable character system prompt',
        messages: [{ role: 'user', content: 'Turn one' }],
    };
    const nextTurn = {
        model: 'claude-sonnet-4.6',
        system: 'Stable character system prompt',
        messages: [
            { role: 'user', content: 'Turn one' },
            { role: 'assistant', content: 'A reply' },
            { role: 'user', content: 'Turn two' },
        ],
    };

    assert.equal(createSessionId(body, key), createSessionId(nextTurn, key));
});

test('session ID still tracks the system prompt when there is one', () => {
    const withSystem = createSessionId({ model: 'claude-sonnet-4.6', system: 'Character A', messages: [] }, key);
    const otherSystem = createSessionId({ model: 'claude-sonnet-4.6', system: 'Character B', messages: [] }, key);

    assert.notEqual(withSystem, otherSystem);
});

test('SESSION_ID override pins affinity to one value', () => {
    const body = { model: 'claude-sonnet-4.6', system: 'Any system prompt', messages: [] };
    const result = addCacheAndAffinity(body, config({ sessionId: 'pinned-session' }));

    assert.equal(result.sessionAction, 'configured');
    assert.equal(body.session_id, 'pinned-session');
});

test('respects user-provided body or x-session-id affinity values', () => {
    const bodySession = { model: 'claude-sonnet-4.6', session_id: 'chosen-session', messages: [] };
    const headerSession = { model: 'claude-sonnet-4.6', messages: [] };

    assert.equal(addCacheAndAffinity(bodySession, config()).sessionAction, 'preserved');
    assert.equal(bodySession.session_id, 'chosen-session');

    assert.equal(addCacheAndAffinity(headerSession, config(), { sessionId: 'header-session' }).sessionAction, 'copied');
    assert.equal(headerSession.session_id, 'header-session');
});

test('history mode places an explicit breakpoint before the newest message', () => {
    const body = {
        model: 'claude-sonnet-4.6',
        messages: [
            { role: 'system', content: 'Stable system prompt' },
            { role: 'user', content: 'Turn one' },
            { role: 'assistant', content: 'A reply' },
            { role: 'user', content: 'Turn two plus a big appended instruction block' },
        ],
    };

    const result = addCacheAndAffinity(body, config({ cacheMode: 'history' }));

    assert.equal(result.cacheAction, 'added-history');
    assert.equal(Object.hasOwn(body, 'cache_control'), false);

    // The breakpoint sits on the last message before the newest one.
    assert.deepEqual(body.messages[2].content, [
        { type: 'text', text: 'A reply', cache_control: { type: 'ephemeral' } },
    ]);
    // The newest message is left untouched, so rewriting it cannot invalidate the prefix.
    assert.equal(body.messages[3].content, 'Turn two plus a big appended instruction block');
});

test('history mode honours the one-hour TTL and block-form content', () => {
    const body = {
        model: 'claude-sonnet-4.6',
        messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'one' },
            { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
            { role: 'user', content: 'two' },
        ],
    };

    addCacheAndAffinity(body, config({ cacheMode: 'history', cacheTtl: '1h' }));

    assert.deepEqual(body.messages[2].content, [
        { type: 'text', text: 'reply', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
});

test('history mode falls back to the automatic marker on very short prompts', () => {
    const body = { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'Only one' }] };
    const result = addCacheAndAffinity(body, config({ cacheMode: 'history' }));

    assert.equal(result.cacheAction, 'added-fallback');
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
});

test('history mode leaves client-supplied cache markers alone', () => {
    const body = {
        model: 'claude-sonnet-4.6',
        cache_control: { type: 'ephemeral', ttl: '1h' },
        messages: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'two' },
        ],
    };

    const result = addCacheAndAffinity(body, config({ cacheMode: 'history' }));

    assert.equal(result.cacheAction, 'preserved');
    assert.equal(body.messages[1].content, 'reply');
});
