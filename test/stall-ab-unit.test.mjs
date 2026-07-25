import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { computeStallScore } from '../scripts/stall-score.mjs';
import { readStoredEvents } from '../scripts/extension-log-pull.mjs';
import { STALL_PROBE_SOURCE } from '../scripts/stall-probe.mjs';
import { assertSafePayload, probeSourceForArm } from '../scripts/stall-ab.mjs';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function readProbeFixture(name) {
  const content = await fs.readFile(path.join(fixtureDirectory, name), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line));
}

test('stall score handles a zero-stall rate-2 fixture', async () => {
  const score = computeStallScore(await readProbeFixture('stall-probe-zero.jsonl'), 100);
  assert.deepEqual(score, {
    waitingCount: 0,
    stalledWallMs: 0,
    playbackEfficiency: 1,
    bufferTargetHeldPct: 1,
    reproduced: false,
  });
});

test('stall score counts an unresolved waiting through the observation boundary', async () => {
  const score = computeStallScore(await readProbeFixture('stall-probe-unresolved.jsonl'), 20);
  assert.equal(score.waitingCount, 1);
  assert.equal(score.stalledWallMs, 2000);
  assert.equal(score.reproduced, true);
});

test('stall score sums multiple waiting-to-playing intervals', async () => {
  const score = computeStallScore(await readProbeFixture('stall-probe-multiple.jsonl'), 20);
  assert.equal(score.waitingCount, 2);
  assert.equal(score.stalledWallMs, 3000);
  assert.equal(score.bufferTargetHeldPct, 2 / 3);
  assert.equal(score.reproduced, true);
});

test('stall score reports efficiency below one when rate-2 playback advances too slowly', async () => {
  const score = computeStallScore(await readProbeFixture('stall-probe-rate2.jsonl'), 100);
  assert.equal(score.playbackEfficiency, 0.5);
});

test('both arms expose the exact same injected probe source', () => {
  assert.equal(probeSourceForArm('extension-on'), STALL_PROBE_SOURCE);
  assert.equal(probeSourceForArm('extension-off'), STALL_PROBE_SOURCE);
  assert.equal(probeSourceForArm('extension-on'), probeSourceForArm('extension-off'));
});

test('injected probe source runs independently in the page realm and resets its score window', () => {
  const listeners = new Map();
  const video = {
    clientWidth: 320,
    clientHeight: 180,
    currentTime: 1,
    readyState: 4,
    paused: false,
    playbackRate: 2,
    isConnected: true,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 120,
    },
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: 10,
      droppedVideoFrames: 0,
      corruptedVideoFrames: 0,
    }),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let elapsed = 100;
  const page = {
    console: { error() {} },
    performance: { now: () => elapsed },
    document: {
      querySelectorAll: (selector) => selector === 'video' ? [video] : [],
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: () => 1,
    clearInterval() {},
  };
  page.window = page;

  runInNewContext(STALL_PROBE_SOURCE, page);
  assert.equal(page.window.__stallProbe.records()[0].elapsedMs, 100);
  elapsed = 300;
  page.window.__stallProbe.reset();
  const records = page.window.__stallProbe.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].elapsedMs, 300);
  assert.equal(records[0].playbackRate, 2);
});

test('extension log autopull reads every events page through its snapshot', async () => {
  const messages = [];
  let closed = false;
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === 'logs:max-event-id') {
          callback({ ok: true, maxEventId: 12 });
          return;
        }
        if (message.afterEventId === 4) {
          callback({
            ok: true,
            events: [{ eventId: 5 }, { eventId: 8 }],
            hasMore: true,
            nextAfterEventId: 8,
          });
          return;
        }
        assert.equal(message.afterEventId, 8);
        callback({ ok: true, events: [{ eventId: 12 }], hasMore: false, nextAfterEventId: 12 });
      },
    },
  };
  const page = {
    async goto() {},
    async evaluate(callback, argument) {
      return runInNewContext(`(${callback.toString()})(${JSON.stringify(argument)})`, { chrome });
    },
    async close() { closed = true; },
  };
  const result = await readStoredEvents({ newPage: async () => page }, 'extension-id', 4);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    maxEventId: 12,
    events: [{ eventId: 5 }, { eventId: 8 }, { eventId: 12 }],
  });
  assert.deepEqual(messages.map(({ type }) => type), [
    'logs:max-event-id',
    'logs:events-page',
    'logs:events-page',
  ]);
  assert.equal(closed, true);
});

test('JSONL redaction assertion rejects cookie-like fields', () => {
  assert.throws(() => assertSafePayload({ nested: { cookieHeader: 'secret' } }), /forbidden field/i);
  assert.doesNotThrow(() => assertSafePayload([{ type: 'timeupdate', currentTime: 1 }]));
});
