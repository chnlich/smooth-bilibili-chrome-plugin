import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSION_MANIFEST, EXTENSION_PREFERENCES, HLS_DEPENDENCY, VOD_CONFIG } from '../src/constants.js';
import {
  BRIDGE_CORE_SYNC_METHODS,
  BRIDGE_OPERATIONS,
  BRIDGE_PLAYER_METHODS,
  BRIDGE_VERSION,
  decodeMessage,
  encodeMessage,
} from '../src/extension/bridge-contract.js';
import { BridgeCore, createPageWindowAdapter } from '../src/extension/bridge-client.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { isVodPage, modeForLocation } from '../src/extension/controller.js';
import { StatusPanel } from '../src/ui/panel.js';

function snapshot(coreId, source, supportsStable = true) {
  return {
    coreId,
    source,
    capabilities: {
      core: { setStableBufferTime: supportsStable },
    },
  };
}

test('extension manifest keeps live mode and adds only the two supported VOD route patterns', () => {
  const manifest = createManifest();
  assert.equal(manifest.manifest_version, EXTENSION_MANIFEST.manifestVersion);
  assert.equal(manifest.minimum_chrome_version, EXTENSION_MANIFEST.minimumChromeVersion);
  assert.deepEqual(manifest.host_permissions, [...EXTENSION_MANIFEST.hostPermissions]);
  assert.deepEqual(manifest.content_scripts[0].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.content_scripts[1].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.options_page, undefined);
  assert.match(manifest.description, /原生缓存提示/);
});

test('route selection activates normal video and Watch Later but not unrelated www paths', () => {
  const location = (href) => new URL(href);
  assert.equal(isVodPage(location('https://www.bilibili.com/video/BVtest')), true);
  assert.equal(isVodPage(location('https://www.bilibili.com/list/watchlater')), true);
  assert.equal(isVodPage(location('https://www.bilibili.com/list/watchlater/')), true);
  assert.equal(isVodPage(location('https://www.bilibili.com/')), false);
  assert.equal(isVodPage(location('https://www.bilibili.com/read/cv123')), false);
  assert.equal(modeForLocation(location('https://live.bilibili.com/6363772')), 'live');
  assert.equal(modeForLocation(location('https://www.bilibili.com/video/BVtest')), 'vod');
  assert.equal(modeForLocation(location('https://www.bilibili.com/list/watchlater')), 'vod');
  assert.equal(modeForLocation(location('https://www.bilibili.com/')), undefined);
});

test('bridge schema exposes only live player controls and the one VOD core mutation', () => {
  const message = {
    version: BRIDGE_VERSION,
    id: 7,
    operation: 'getCoreSnapshot',
    args: [],
    mode: 'async',
  };
  assert.deepEqual(decodeMessage(encodeMessage(message)), message);
  assert.deepEqual(BRIDGE_OPERATIONS, ['getCoreSnapshot', 'callPlayer', 'callCoreSync']);
  assert.deepEqual(BRIDGE_PLAYER_METHODS, ['setAutoSyncProgressCfg', 'setAutoDiscardFrameCfg', 'pause']);
  assert.deepEqual(BRIDGE_CORE_SYNC_METHODS, ['setStableBufferTime']);
  assert.equal(HLS_DEPENDENCY.version, '1.5.17');
  assert.deepEqual(Object.values(EXTENSION_PREFERENCES), ['liveEnabled', 'vodEnabled']);
  assert.equal(VOD_CONFIG.stableBufferSeconds, 120);
  assert.throws(() => decodeMessage(JSON.stringify({ ...message, version: 2 })), /not supported/);
  assert.throws(() => decodeMessage(JSON.stringify({ ...message, id: 0 })), /positive integer/);
});

test('bridge core invokes only the stable-buffer setter and reports capability absence', () => {
  const calls = [];
  const client = {
    callSync(operation, args) {
      calls.push([operation, args]);
      return true;
    },
  };
  const supported = new BridgeCore(client, snapshot(3, 'test-source', true));
  assert.equal(supported.supports('setStableBufferTime'), true);
  supported.setStableBufferTime(120);
  assert.deepEqual(calls, [['callCoreSync', [3, 'setStableBufferTime', [120]]]]);

  const unsupported = new BridgeCore(client, snapshot(4, 'other-source', false));
  assert.equal(unsupported.supports('setStableBufferTime'), false);
  assert.throws(
    () => unsupported.setStableBufferTime(120),
    (error) => error.code === 'VOD_STABLE_BUFFER_UNAVAILABLE',
  );
});

test('adapter reuses a stable BridgeCore and replaces it when core identity or source changes', async () => {
  let snapshotCalls = 0;
  const calls = [];
  const client = {
    callAsync(operation) {
      assert.equal(operation, 'getCoreSnapshot');
      snapshotCalls += 1;
      return Promise.resolve(snapshot(snapshotCalls <= 2 ? 5 : 6, snapshotCalls <= 2 ? 'old' : 'new'));
    },
    callSync(operation, args) {
      calls.push([operation, args]);
      return true;
    },
  };
  const adapter = createPageWindowAdapter(client, {
    location: { href: 'https://www.bilibili.com/video/BVtest' },
    performance: { now: () => 0 },
    MediaSource: undefined,
    URL: undefined,
  });
  const first = await adapter.refreshCore();
  const same = await adapter.refreshCore();
  assert.strictEqual(first, same);
  assert.equal(snapshotCalls, 2);
  const replacement = await adapter.refreshCore();
  assert.notStrictEqual(replacement, first);
  assert.equal(first.stale, true);
  assert.equal(replacement.coreId, 6);
  replacement.setStableBufferTime(120);
  assert.equal(calls.length, 1);
});

test('VOD status snapshots omit legacy quality, rate, multiplier, delay, stage, and actions', () => {
  const panel = new StatusPanel({}, '点播');
  panel.setModel({ mode: '点播', state: 'APPLIED', inventory: '120.0 秒', message: '' });
  const snapshotValue = panel.getSnapshot();
  assert.deepEqual(Object.keys(snapshotValue).sort(), ['actions', 'inventory', 'message', 'mode', 'state', 'surfaceId', 'version']);
  assert.deepEqual(snapshotValue.actions, {});
  panel.destroy();
});

test('live status snapshots retain every live field and action surface', () => {
  let actionCalls = 0;
  const panel = new StatusPanel({}, '直播');
  panel.setModel({
    mode: '直播',
    state: 'RECOVERING',
    inventory: '15.0 秒',
    delay: '4.0 秒',
    quality: '高清 / qn250 / avc',
    speed: '1×',
    multiplier: '库存已满',
    stage: '库存形成',
    message: '重试第 2 轮',
  });
  panel.setAction('toggle', '停用', () => { actionCalls += 1; });
  panel.setAction('skip-gap', '跨过缺口', () => {}, true);
  panel.setAction('return-live', '回到直播', () => {}, true);
  const snapshotValue = panel.getSnapshot();
  assert.equal(snapshotValue.delay, '4.0 秒');
  assert.equal(snapshotValue.quality, '高清 / qn250 / avc');
  assert.equal(snapshotValue.speed, '1×');
  assert.equal(snapshotValue.multiplier, '库存已满');
  assert.equal(snapshotValue.stage, '库存形成');
  assert.deepEqual(snapshotValue.actions, {
    toggle: '停用',
    'skip-gap': '跨过缺口',
    'return-live': '回到直播',
  });
  panel.runAction('toggle');
  assert.equal(actionCalls, 1);
  panel.destroy();
});
