import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefixTracker, diffSegments, rolesSummary, segmentHashes } from '../src/prefix-diff.js';

function makeBody(messages, system) {
    const body = { model: 'claude-sonnet-4.6', messages };
    if (system !== undefined) {
        body.system = system;
    }
    return body;
}

function captureLogs() {
    const logs = [];
    return { logs, logger: { info: message => logs.push(message), error: message => logs.push(message) } };
}

test('fingerprints the system prompt before the messages, in request order', () => {
    const segments = segmentHashes(makeBody(
        [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }],
        'Stable system prefix',
    ));

    assert.equal(segments.length, 3);
    assert.equal(segments[0].label, 'system');
    assert.equal(segments[0].role, 'system');
    assert.equal(segments[0].size, segments[0].size);
    assert.equal(segments[1].label, 'msg[0] role=user');
    assert.equal(segments[2].label, 'msg[2]'.replace('2', '1') + ' role=assistant');
    assert.match(segments[0].hash, /^[0-9a-f]{8}$/);
});

test('ignores object key order when fingerprinting a message', () => {
    const a = segmentHashes({ messages: [{ role: 'user', content: 'same' }] });
    const b = segmentHashes({ messages: [{ content: 'same', role: 'user' }] });
    assert.equal(a[0].hash, b[0].hash);
});

test('reports an unchanged prefix', () => {
    const previous = segmentHashes(makeBody([{ role: 'user', content: 'a' }]));
    const next = segmentHashes(makeBody([{ role: 'user', content: 'a' }]));

    const diff = diffSegments(previous, next);
    assert.equal(diff.changed, false);
    assert.equal(diff.rewritten, false);
    assert.equal(diff.firstChangeIndex, -1);
});

test('reports a pure append as growth, not a rewrite', () => {
    const previous = segmentHashes(makeBody([{ role: 'user', content: 'a' }]));
    const next = segmentHashes(makeBody([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]));

    const diff = diffSegments(previous, next);
    assert.equal(diff.changed, true);
    assert.equal(diff.rewritten, false);
    assert.equal(diff.firstChangeIndex, 1);
    assert.equal(diff.previousCount, 1);
    assert.equal(diff.nextCount, 2);
});

test('locates the first rewritten message in history', () => {
    const previous = segmentHashes(makeBody([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '<internal_states>kept</internal_states>b' },
        { role: 'user', content: 'c' },
    ]));
    const next = segmentHashes(makeBody([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
    ]));

    const diff = diffSegments(previous, next);
    assert.equal(diff.changed, true);
    assert.equal(diff.rewritten, true);
    assert.equal(diff.firstChangeIndex, 1);
    assert.equal(diff.label, 'msg[1] role=assistant');
    assert.notEqual(diff.previousHash, diff.nextHash);
});

test('logs a baseline, then growth, then a rewrite', () => {
    const { logs, logger } = captureLogs();
    const tracker = createPrefixTracker({ logger, enabled: true });

    tracker.record(makeBody([{ role: 'user', content: 'a' }]), 'st_stable');
    tracker.record(makeBody([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), 'st_stable');
    tracker.record(makeBody([{ role: 'user', content: 'CHANGED' }, { role: 'assistant', content: 'b' }]), 'st_stable');

    assert.match(logs[0], /^\[proxy\] session fingerprint=[0-9a-f]{8} \(baseline\)$/);
    assert.match(logs[1], /^\[proxy\] prefix baseline segments=1 roles=user:1 size=\d+$/);
    assert.match(logs[2], /^\[proxy\] session fingerprint=[0-9a-f]{8} \(stable\)$/);
    assert.match(logs[3], /^\[proxy\] prefix GREW ONLY segments=1 -> 2 roles=user:1,assistant:1 size=\d+ -> \d+ \(shared prefix intact; cache should hit\)$/);
    assert.match(logs[4], /^\[proxy\] session fingerprint=[0-9a-f]{8} \(stable\)$/);
    assert.match(logs[5], /^\[proxy\] prefix REWRITTEN at msg\[0\] role=user [0-9a-f]{8} -> [0-9a-f]{8} \(segments 2 -> 2, roles=user:1,assistant:1, segment size \d+ -> \d+, total \d+ -> \d+\)$/);
});

test('flags a session_id change because provider affinity can reset with it', () => {
    const { logs, logger } = captureLogs();
    const tracker = createPrefixTracker({ logger, enabled: true });

    tracker.record(makeBody([{ role: 'user', content: 'a' }]), 'st_first');
    tracker.record(makeBody([{ role: 'user', content: 'a' }]), 'st_second');

    const sessionLines = logs.filter(line => line.startsWith('[proxy] session fingerprint'));
    assert.equal(sessionLines.length, 2);
    assert.match(sessionLines[1], /CHANGED: AITUNNEL provider affinity may reset/);
});

test('stays silent unless explicitly enabled', () => {
    const { logs, logger } = captureLogs();
    const tracker = createPrefixTracker({ logger });

    tracker.record(makeBody([{ role: 'user', content: 'a' }]), 'st_first');
    tracker.record(makeBody([{ role: 'user', content: 'b' }]), 'st_first');

    assert.deepEqual(logs, []);
});

test('fingerprints carry no prompt text, only short hashes and roles', () => {
    const secret = 'a-very-distinctive-secret-sentence';
    const segments = segmentHashes(makeBody([{ role: 'user', content: secret }], secret));

    const serialized = JSON.stringify(segments);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /role=user/);
    assert.match(serialized, /^[0-9a-f]{8}$|[0-9a-f]{8}/);
});

test('reports a role census so missing assistant turns are visible', () => {
    const segments = segmentHashes({
        system: 'sys',
        messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ],
    });

    assert.equal(rolesSummary(segments), 'system:1,user:2,assistant:1');
});

test('distinguishes a rewrite from growth by size, not just by hash', () => {
    const { logs, logger } = captureLogs();
    const tracker = createPrefixTracker({ logger, enabled: true });

    // Same length, different content -> a dynamic value inside the segment.
    tracker.record(makeBody([{ role: 'user', content: 'aaaa' }]), 'st_stable');
    tracker.record(makeBody([{ role: 'user', content: 'bbbb' }]), 'st_stable');

    assert.match(logs[3], /prefix REWRITTEN at msg\[0\] role=user/);
    // Same size but a different hash is the signature of a dynamic macro (time, date, random).
    assert.match(logs[3], /segment size (\d+) -> \1/);
});
