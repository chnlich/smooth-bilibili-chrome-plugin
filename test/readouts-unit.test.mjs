import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReadouts,
  deriveMediaReadout,
  estimateBankSeconds,
  inventoryStoppedPublishing,
} from '../src/extension/readouts.js';
import { INVENTORY_HEARTBEAT_FLOOR_MS } from '../src/bank/inventory.js';

function facts(sourceBufferRanges, bufferedRanges = [{ start: 0, end: 60 }]) {
  return {
    bufferedRanges,
    currentTime: 10,
    duration: 100,
    sourceBufferRanges,
    mediaSourceState: 'open',
    readyState: 4,
    networkState: 2,
    playbackRate: 1,
    resolution: { width: 1920, height: 1080 },
    videoQuality: { total: 10, dropped: 0, corrupted: 0 },
    paused: false,
    ended: false,
  };
}

function track({ track, attached = true, ranges = [{ start: 0, end: 30 }], mediaSourceInstance = 1 }) {
  return {
    track,
    attached,
    ranges,
    updating: false,
    pendingSinceMs: null,
    lastAppendAgoMs: 12,
    appendErrors: {},
    mediaSourceInstance,
  };
}

test('panel media derivation computes per-track forward seconds and the unique limiter', () => {
  const media = deriveMediaReadout(facts([
    track({ track: 'video/mp4', ranges: [{ start: 0, end: 50 }] }),
    track({ track: 'audio/mp4', ranges: [{ start: 0, end: 30 }] }),
  ]));
  assert.equal(media.forwardSeconds, 50);
  assert.equal(media.tracks[0].forwardSeconds, 40);
  assert.equal(media.tracks[1].forwardSeconds, 20);
  assert.equal(media.limiterTrack, 'audio/mp4');
  assert.equal(media.otherLiveMediaSources, 0);
});

test('panel derivation does not name a limiter for a tie, one track, or unresolved attachment', () => {
  assert.equal(deriveMediaReadout(facts([
    track({ track: 'video/mp4' }),
    track({ track: 'audio/mp4' }),
  ])).limiterTrack, '未提供');
  assert.equal(deriveMediaReadout(facts([
    track({ track: 'video/mp4' }),
  ])).limiterTrack, '未提供');
  const unresolved = deriveMediaReadout(facts([
    track({ track: 'video/mp4', attached: false }),
    track({ track: 'audio/mp4', attached: false, mediaSourceInstance: 2 }),
  ]));
  assert.equal(unresolved.limiterTrack, '未提供');
  assert.equal(unresolved.otherLiveMediaSources, '未提供');
});

test('bank seconds estimates stay unavailable when total size or duration is unavailable', () => {
  const inventory = {
    resources: [
      { pathname: '/video/a.m4s', storedBytes: 50, totalSize: 100 },
      { pathname: '/video/b.m4s', storedBytes: 50, totalSize: '未提供' },
    ],
  };
  assert.deepEqual(estimateBankSeconds(inventory, 100), {
    '/video/a.m4s': 50,
    '/video/b.m4s': '未提供',
  });
  assert.equal(estimateBankSeconds(inventory, '未提供')['/video/a.m4s'], '未提供');
});

test('inventory age past the heartbeat floor is explicitly stale', () => {
  assert.equal(inventoryStoppedPublishing(INVENTORY_HEARTBEAT_FLOOR_MS), false);
  assert.equal(inventoryStoppedPublishing(INVENTORY_HEARTBEAT_FLOOR_MS + 1), true);
  const readouts = buildReadouts({
    surfaceId: 'surface-test',
    video: undefined,
    bankInventory: {
      data: { resources: [], storedBytes: 0 },
      receivedAtMs: 100,
    },
    diagnostics: { sessionId: 'session-test', persistence: 'PERSISTED' },
    now: 100 + INVENTORY_HEARTBEAT_FLOOR_MS + 1,
  });
  assert.equal(readouts.bank.ageMs, INVENTORY_HEARTBEAT_FLOOR_MS + 1);
  assert.equal(inventoryStoppedPublishing(readouts.bank.ageMs), true);
});
