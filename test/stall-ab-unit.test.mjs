import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computeStallScore } from '../scripts/stall-score.mjs';
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

test('JSONL redaction assertion rejects cookie-like fields', () => {
  assert.throws(() => assertSafePayload({ nested: { cookieHeader: 'secret' } }), /forbidden field/i);
  assert.doesNotThrow(() => assertSafePayload([{ type: 'timeupdate', currentTime: 1 }]));
});
