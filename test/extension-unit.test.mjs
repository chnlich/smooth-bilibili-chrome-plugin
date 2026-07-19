import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSION_MANIFEST, EXTENSION_PREFERENCES, HLS_DEPENDENCY } from '../src/constants.js';
import {
  BRIDGE_CORE_SYNC_METHODS,
  BRIDGE_OPERATIONS,
  BRIDGE_VERSION,
  decodeMessage,
  encodeMessage,
} from '../src/extension/bridge-contract.js';
import { BridgeCore, createPageWindowAdapter } from '../src/extension/bridge-client.js';
import { createCoreEventSubscription, supportsCoreEvents } from '../src/extension/core-events.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { StatusPanel } from '../src/ui/panel.js';

const ALL_CORE_CAPABILITIES = {
  getQuality: true,
  getSupportedQualityList: true,
  getBufferedRanges: true,
  getMediaInfo: true,
  getCurrentMediaInfo: false,
  getQualityInfo: false,
  getStableBufferTime: true,
  getStableBufferSeconds: false,
  setStableBufferTime: true,
  setScheduleWhilePaused: true,
  events: false,
};

function capabilities(overrides = {}) {
  return {
    player: {
      setAutoSyncProgressCfg: true,
      setAutoDiscardFrameCfg: true,
      pause: true,
      getQuality: true,
      getSupportedQualityList: true,
    },
    core: { ...ALL_CORE_CAPABILITIES, ...overrides },
  };
}

test('extension manifest derives its MV3, match, and permission contract from one source', () => {
  const manifest = createManifest();
  assert.equal(manifest.manifest_version, EXTENSION_MANIFEST.manifestVersion);
  assert.equal(manifest.minimum_chrome_version, EXTENSION_MANIFEST.minimumChromeVersion);
  assert.deepEqual(manifest.host_permissions, [...EXTENSION_MANIFEST.hostPermissions]);
  assert.deepEqual(manifest.content_scripts[0].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.content_scripts[1].matches, [...EXTENSION_MANIFEST.matches]);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[1].world, 'ISOLATED');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.content_scripts[1].run_at, 'document_start');
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[1].all_frames, false);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.options_page, undefined);
});

test('status surface is in-memory, versioned, and exposes only visible current actions', () => {
  let actionCalls = 0;
  const panel = new StatusPanel({
    createElement() {
      throw new Error('status surface must not create page elements');
    },
  }, '直播');
  panel.setModel({ mode: '直播', state: 'RECOVERING', message: '重试第 2 轮' });
  panel.setMessage('阶段消息');
  panel.setAction('toggle', '停用', () => { actionCalls += 1; });
  panel.setAction('skip-gap', '跨过缺口', () => {}, false);
  const snapshot = panel.getSnapshot();
  assert.equal(snapshot.version, 1);
  assert.match(snapshot.surfaceId, /^surface-/);
  assert.equal(snapshot.state, 'RECOVERING');
  assert.equal(snapshot.message, '阶段消息');
  assert.deepEqual(snapshot.actions, { toggle: '停用' });
  panel.runAction('toggle');
  assert.equal(actionCalls, 1);
  assert.throws(() => panel.runAction('skip-gap'), (error) => error.code === 'UI_ACTION_NOT_VISIBLE');
  panel.setFreshnessCheck(() => false);
  assert.throws(() => panel.getSnapshot(), (error) => error.code === 'UI_SURFACE_STALE');
  assert.throws(() => panel.runAction('toggle'), (error) => error.code === 'UI_SURFACE_STALE');
  assert.equal(actionCalls, 1);
  panel.destroy();
  assert.throws(() => panel.getSnapshot(), (error) => error.code === 'UI_SURFACE_DESTROYED');
  assert.throws(() => panel.runAction('toggle'), (error) => error.code === 'UI_SURFACE_DESTROYED');
});

test('status surfaces use independent cryptographic ids across isolated contexts', () => {
  const first = new StatusPanel({}, '直播');
  const second = new StatusPanel({}, '直播');
  assert.notEqual(first.surfaceId, second.surfaceId);
  first.destroy();
  second.destroy();
});

test('bridge schema accepts only versioned serializable messages and whitelisted operations', () => {
  const message = {
    version: BRIDGE_VERSION,
    id: 7,
    operation: 'getCoreSnapshot',
    args: [],
    mode: 'async',
  };
  assert.deepEqual(decodeMessage(encodeMessage(message)), message);
  assert.ok(BRIDGE_OPERATIONS.includes('getCoreSnapshot'));
  assert.ok(BRIDGE_OPERATIONS.includes('callPlayerSync'));
  assert.equal(BRIDGE_OPERATIONS.includes('callCoreAsync'), false);
  assert.ok(BRIDGE_CORE_SYNC_METHODS.includes('getQuality'));
  assert.ok(BRIDGE_CORE_SYNC_METHODS.includes('getSupportedQualityList'));
  assert.throws(() => decodeMessage(JSON.stringify({ ...message, version: 2 })), /not supported/);
  assert.throws(() => decodeMessage(JSON.stringify({ ...message, id: 0 })), /positive integer/);
});

test('MAIN bridge event support requires a paired removal API before it registers a listener', () => {
  let incompleteAddCalls = 0;
  const incompleteCore = {
    addListener() {
      incompleteAddCalls += 1;
    },
  };
  assert.equal(createCoreEventSubscription(incompleteCore), undefined);
  assert.equal(supportsCoreEvents(incompleteCore), false);
  assert.equal(incompleteAddCalls, 0);

  const listeners = new Map();
  const core = {
    on(name, callback) {
      listeners.set(name, callback);
    },
    off(name, callback) {
      assert.strictEqual(listeners.get(name), callback);
      listeners.delete(name);
    },
  };
  const subscribe = createCoreEventSubscription(core);
  assert.equal(supportsCoreEvents(core), true);
  const callback = () => {};
  const remove = subscribe('error', callback);
  assert.strictEqual(listeners.get('error'), callback);
  remove();
  assert.equal(listeners.size, 0);
});

test('bridge core reads current MAIN state through the whitelist without leaking page objects', async () => {
  const calls = [];
  const observed = {
    quality: { nowQ: 32, realQ: 32 },
    supportedQualityList: [64, 32],
    bufferedRanges: { video: [{ start: 0, end: 120 }], audio: [{ start: 0, end: 118 }] },
    mediaInfo: { bitrate: 1000, bandwidth: 900, video: { bitrate: 700 }, audio: { bitrate: 300 } },
    stableBufferTime: 180,
  };
  const client = {
    callSync(operation, args) {
      calls.push(['sync', operation, args]);
      assert.equal(operation, 'callCoreSync');
      const [, method, values] = args;
      if (method === 'setStableBufferTime') {
        observed.stableBufferTime = values[0];
        return true;
      }
      if (method === 'setScheduleWhilePaused') {
        return true;
      }
      if (method === 'getBufferedRanges') {
        return observed.bufferedRanges;
      }
      if (method === 'getQuality') {
        return observed.quality;
      }
      if (method === 'getSupportedQualityList') {
        return observed.supportedQualityList;
      }
      if (method === 'getMediaInfo') {
        return observed.mediaInfo;
      }
      if (method === 'getStableBufferTime') {
        return observed.stableBufferTime;
      }
      throw new Error(`unexpected bridge method ${method}`);
    },
    callAsync(operation, args) {
      calls.push(['async', operation, args]);
      return Promise.resolve({
        result: true,
        snapshot: {
          coreId: 3,
          source: 'test-source',
          supportsCoreEvents: false,
          capabilities: capabilities(),
          ...observed,
        },
      });
    },
    subscribeCore() {
      return 11;
    },
    unsubscribeCore() {},
  };
  const core = new BridgeCore(client, {
    coreId: 3,
    source: 'test-source',
    ...observed,
    supportsCoreEvents: false,
    capabilities: capabilities(),
  });
  assert.equal(core.getQuality().realQ, 32);
  assert.equal(core.getBufferedRanges().video.end(0), 120);
  assert.equal(core.getMediaInfo().video.bitrate, 700);
  assert.equal(core.getStableBufferTime(), 180);
  observed.quality = { nowQ: 64, realQ: 64 };
  observed.bufferedRanges = { video: [{ start: 2, end: 142 }], audio: [{ start: 2, end: 140 }] };
  observed.mediaInfo = { bitrate: 2000, bandwidth: 1800, video: { bitrate: 1500 }, audio: { bitrate: 500 } };
  observed.stableBufferTime = 120;
  assert.equal(core.getQuality().realQ, 64);
  assert.equal(core.getBufferedRanges().audio.end(0), 140);
  assert.equal(core.getMediaInfo().bitrate, 2000);
  assert.equal(core.getStableBufferTime(), 120);
  core.setStableBufferTime(120);
  assert.ok(calls.some((call) => call[2][1] === 'getQuality'));
  assert.ok(calls.some((call) => call[2][1] === 'getBufferedRanges'));
  assert.ok(calls.some((call) => call[2][1] === 'getMediaInfo'));
  assert.equal(HLS_DEPENDENCY.version, '1.5.17');
  assert.deepEqual(Object.values(EXTENSION_PREFERENCES), ['liveEnabled', 'vodEnabled']);
});

test('a fresh bridge snapshot stales the old core and page quality reads stay synchronous', async () => {
  let snapshotCalls = 0;
  const playerQuality = { realQ: 32 };
  const client = {
    callAsync(operation) {
      if (operation === 'getCoreSnapshot') {
        snapshotCalls += 1;
        return Promise.resolve({
          coreId: 5,
          source: snapshotCalls === 1 ? 'old-source' : 'new-source',
          quality: { realQ: 32 },
          supportsCoreEvents: false,
          capabilities: capabilities(),
        });
      }
      throw new Error(`unexpected async bridge operation: ${operation}`);
    },
    callSync(operation, args) {
      assert.equal(operation, 'callPlayerSync');
      assert.deepEqual(args, ['getQuality', []]);
      return playerQuality;
    },
  };
  const adapter = createPageWindowAdapter(client, {
    location: { href: 'https://www.bilibili.com/video/BVtest' },
    performance: { now: () => 0 },
    MediaSource: undefined,
    URL: undefined,
  });
  const firstRefresh = adapter.refreshCore();
  const secondRefresh = adapter.refreshCore();
  const [firstCore, secondCore] = await Promise.all([firstRefresh, secondRefresh]);
  assert.strictEqual(firstCore, secondCore);
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(adapter.pageWindow.player.getQuality(), { realQ: 32 });
  const currentCore = await adapter.refreshCore();
  assert.notStrictEqual(currentCore, firstCore);
  assert.equal(firstCore.stale, true);
  assert.equal(firstCore.snapshot.source, 'old-source');
});
