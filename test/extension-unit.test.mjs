import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSION_MANIFEST, EXTENSION_PREFERENCES, VOD_CONFIG } from '../src/constants.js';
import {
  BRIDGE_CORE_SYNC_METHODS,
  BRIDGE_LIVE_METHODS,
  BRIDGE_OPERATIONS,
  serializeError,
} from '../src/extension/bridge-contract.js';
import { BridgeCore, LiveCapabilities } from '../src/extension/bridge-client.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { isVideoPage, isVodPage, modeForLocation } from '../src/extension/controller.js';
import { createStatusPanel, createUnavailableStatusSnapshot, STATUS_MESSAGE_VERSION } from '../src/ui/panel.js';
import { createSessionIdentity, validateSession } from '../src/diagnostics/session.js';

test('manifest is MV3 with only storage permissions, unlimited diagnostic storage, worker, and approved routes', () => {
  const manifest = createManifest();
  assert.equal(manifest.manifest_version, EXTENSION_MANIFEST.manifestVersion);
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage']);
  assert.deepEqual(manifest.host_permissions, []);
  assert.deepEqual(manifest.content_scripts[0].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.content_scripts[1].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.background, { service_worker: 'worker.js' });
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.options_page, undefined);
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(manifest.permissions.includes('downloads'), false);
});

test('video route selection has one behavior for video and Watch Later only', () => {
  const location = (href) => new URL(href);
  for (const url of [
    'https://www.bilibili.com/video/BVtest',
    'https://www.bilibili.com/list/watchlater',
    'https://www.bilibili.com/list/watchlater/',
    'https://www.bilibili.com/list/watchlater/item-1',
  ]) {
    assert.equal(isVideoPage(location(url)), true);
    assert.equal(isVodPage(location(url)), true);
    assert.equal(modeForLocation(location(url)), 'video');
  }
  for (const url of [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/search?keyword=video',
    'https://www.bilibili.com/read/cv1',
  ]) {
    assert.equal(isVideoPage(location(url)), false);
    assert.equal(modeForLocation(location(url)), undefined);
  }
  assert.equal(modeForLocation(location('https://live.bilibili.com/123')), 'live');
});

test('status panel exposes only direct facts and no playback or recovery actions', () => {
  const panel = createStatusPanel({}, 'live');
  panel.setModel({
    mode: '直播',
    paused: '否',
    recentFrame: '是',
    buffered: 8,
    delay: 12,
    resolution: '1280×720',
    speed: '1×',
    videoReplacements: 1,
    sourceReplacements: 2,
    recentEvent: 'playing',
  });
  const snapshot = panel.getSnapshot();
  assert.equal(snapshot.version, STATUS_MESSAGE_VERSION);
  assert.equal(snapshot.mode, '直播');
  assert.equal(Object.hasOwn(snapshot, 'actions'), false);
  assert.equal(Object.hasOwn(snapshot, 'stage'), false);
  assert.equal(Object.hasOwn(snapshot, 'state'), false);
  panel.destroy();

  const unavailable = createUnavailableStatusSnapshot('video');
  assert.equal(unavailable.mode, '视频');
  assert.equal(unavailable.target, '未提供');
  assert.equal(Object.hasOwn(unavailable, 'actions'), false);
});

test('bridge contract allows only native video hint and narrow live capability operations', () => {
  assert.deepEqual(BRIDGE_CORE_SYNC_METHODS, ['setStableBufferTime']);
  assert.deepEqual(BRIDGE_LIVE_METHODS, ['setAutoSyncProgressCfg', 'setAutoDiscardFrameCfg']);
  assert.deepEqual(BRIDGE_OPERATIONS, [
    'getCoreSnapshot',
    'callCoreSync',
    'getLiveCapabilitySnapshot',
    'disableLiveAutoCatchup',
  ]);
});

test('BridgeCore preserves stale-generation errors and LiveCapabilities calls only once', async () => {
  const calls = [];
  const client = {
    callSync(operation, args) {
      calls.push({ operation, args });
      throw Object.assign(new Error('stale'), { code: 'BRIDGE_CORE_STALE' });
    },
    callAsync(operation) {
      calls.push({ operation });
      return Promise.resolve(true);
    },
  };
  const core = new BridgeCore(client, {
    coreId: 1,
    source: 'https://media.example/video',
    capabilities: { core: { setStableBufferTime: true } },
  });
  assert.throws(() => core.setStableBufferTime(120), (error) => error.code === 'BRIDGE_CORE_STALE');
  assert.throws(() => core.setStableBufferTime(120), (error) => error.code === 'BRIDGE_CORE_STALE');
  const capabilities = new LiveCapabilities(client, { live: { disableAutoCatchup: true } });
  await capabilities.disableAutoCatchup();
  await assert.rejects(() => capabilities.disableAutoCatchup(), (error) => error.code === 'LIVE_AUTO_CATCHUP_ALREADY_ATTEMPTED');
  assert.equal(calls.filter((call) => call.operation === 'disableLiveAutoCatchup').length, 1);
});

test('session identity omits page tab id and keeps route identity fields', () => {
  const session = createSessionIdentity({
    locationObject: {
      origin: 'https://live.bilibili.com',
      pathname: '/6363772?foo=secret',
    },
    routeKind: 'live',
    runtimeObject: {},
    sessionId: 'session-fixed',
    roomId: 6363772,
  });
  assert.equal(session.tabId, undefined);
  assert.equal(session.pathname, '/6363772');
  assert.equal(session.roomId, '6363772');
  assert.doesNotThrow(() => validateSession(session, { requireTabId: false }));
  assert.throws(() => validateSession({ ...session, tabId: 3 }, { requireTabId: false }));
});

test('error serialization rejects arbitrary cause objects while keeping safe cause fields', () => {
  const error = Object.assign(new Error('safe'), { code: 'SAFE', cause: { name: 'Cause', message: 'nested' } });
  const serialized = serializeError(error);
  assert.equal(serialized.code, 'SAFE');
  assert.deepEqual(serialized.cause, { name: 'Cause', message: 'nested' });
});

assert.equal(EXTENSION_PREFERENCES.vodEnabled, 'vodEnabled');
assert.equal(VOD_CONFIG.stableBufferSeconds, 120);
