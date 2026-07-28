import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { readStoredEvents } from '../scripts/extension-log-pull.mjs';
import { EXTENSION_MANIFEST, EXTENSION_PREFERENCES, VOD_CONFIG } from '../src/constants.js';
import {
  BRIDGE_CORE_SYNC_METHODS,
  BRIDGE_OPERATIONS,
  serializeError,
} from '../src/extension/bridge-contract.js';
import { BridgeCore } from '../src/extension/bridge-client.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { installPopupMessageHandler, isVideoPage, isVodPage, modeForLocation } from '../src/extension/controller.js';
import { createStatusPanel, createUnavailableStatusSnapshot, STATUS_MESSAGE_VERSION } from '../src/ui/panel.js';
import { logSessionFragment, sessionIdFromHash } from '../src/diagnostics/log-session.js';
import { assertAppendSessionPolicy, isSessionWithinEventCutoff, readLogs } from '../src/diagnostics/worker.js';

test('manifest is MV3 with only storage permissions, unlimited diagnostic storage, worker, and approved routes', () => {
  const manifest = createManifest();
  assert.equal(manifest.manifest_version, EXTENSION_MANIFEST.manifestVersion);
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage']);
  assert.deepEqual(manifest.host_permissions, []);
  assert.deepEqual(manifest.content_scripts[0].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.content_scripts[1].matches, [...EXTENSION_MANIFEST.matches]);
  assert.deepEqual(manifest.content_scripts[1].js, ['bank.js']);
  assert.equal(manifest.content_scripts[1].world, 'MAIN');
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
});

test('status panel exposes only direct video facts and no playback or recovery actions', () => {
  const unavailable = createUnavailableStatusSnapshot('video');
  assert.equal(unavailable.mode, '视频');
  assert.equal(unavailable.target, '未提供');
  assert.equal(Object.hasOwn(unavailable, 'actions'), false);
});

test('video status surface exposes exactly the approved snapshot fields', () => {
  const panel = createStatusPanel({}, 'video');
  panel.setModel({
    mode: '视频',
    state: 'APPLIED',
    buffered: '8.0 秒',
    target: '120 秒',
    effective: '已应用(目标120s, 实测峰值8s)',
    error: '未提供',
    recentEvent: 'playing',
    sessionId: 'unapproved-session',
    persistence: 'PERSISTED',
  });
  const snapshot = panel.getSnapshot();
  assert.deepEqual(Object.keys(snapshot), [
    'version',
    'surfaceId',
    'mode',
    'state',
    'buffered',
    'target',
    'effective',
    'error',
  ]);
  assert.equal(Object.hasOwn(snapshot, 'recentEvent'), false);
  assert.equal(Object.hasOwn(snapshot, 'sessionId'), false);
  assert.equal(Object.hasOwn(snapshot, 'persistence'), false);
  panel.destroy();
});

test('tab-scoped popup status requests do not require a popup sender tab', async () => {
  let listener;
  const panel = createStatusPanel({}, 'video');
  panel.setModel({ state: 'APPLIED', buffered: '12.0 秒', target: '120 秒' });
  installPopupMessageHandler({
    onMessage: {
      addListener(callback) {
        listener = callback;
      },
    },
  });
  const response = await new Promise((resolve) => {
    const result = listener({ version: STATUS_MESSAGE_VERSION, type: 'status:get' }, {}, resolve);
    assert.equal(result, true);
  });
  assert.equal(response.mode, '视频');
  assert.equal(response.state, '已应用');
  panel.destroy();
});

test('popup diagnostics session request is a fixed narrow message and never expands video status', async () => {
  let listener;
  const panel = createStatusPanel({}, 'video');
  panel.setModel({ state: 'APPLIED', buffered: '12.0 秒', target: '120 秒' });
  installPopupMessageHandler({
    onMessage: {
      addListener(callback) {
        listener = callback;
      },
    },
  }, () => 'session-video-popup');
  const response = await new Promise((resolve) => {
    const result = listener({ version: STATUS_MESSAGE_VERSION, type: 'diagnostics:session-id:get' }, {}, resolve);
    assert.equal(result, true);
  });
  assert.deepEqual(response, {
    version: STATUS_MESSAGE_VERSION,
    ok: true,
    sessionId: 'session-video-popup',
  });
  panel.destroy();
});

test('bridge contract allows only the native video hint operations', () => {
  assert.deepEqual(BRIDGE_CORE_SYNC_METHODS, ['setStableBufferTime']);
  assert.deepEqual(BRIDGE_OPERATIONS, [
    'getCoreSnapshot',
    'callCoreSync',
  ]);
});

test('BridgeCore preserves stale-generation errors', () => {
  const calls = [];
  const client = {
    callSync(operation, args) {
      calls.push({ operation, args });
      throw Object.assign(new Error('stale'), { code: 'BRIDGE_CORE_STALE' });
    },
  };
  const core = new BridgeCore(client, {
    coreId: 1,
    source: 'https://media.example/video',
    capabilities: { core: { setStableBufferTime: true } },
  });
  assert.throws(() => core.setStableBufferTime(120), (error) => error.code === 'BRIDGE_CORE_STALE');
  assert.throws(() => core.setStableBufferTime(120), (error) => error.code === 'BRIDGE_CORE_STALE');
});

test('diagnostic sender policy checks origin while allowing pathname changes in one SPA session', () => {
  const session = {
    schemaVersion: 1,
    sessionId: 'session-sender-policy',
    startedAt: '2026-07-20T00:00:00.000Z',
    extensionVersion: '1.0.0',
    buildId: 'src-test',
    tabId: 7,
    routeKind: 'video',
    origin: 'https://www.bilibili.com',
    pathname: '/video/BVold',
    bvid: 'BVold',
  };
  const oldRouteSender = { tab: { id: 7 }, url: 'https://www.bilibili.com/video/BVold?from=test' };
  const newRouteSender = { tab: { id: 7 }, url: 'https://www.bilibili.com/video/BVnew?from=test' };
  assert.doesNotThrow(() => assertAppendSessionPolicy(undefined, session, oldRouteSender));
  assert.doesNotThrow(() => assertAppendSessionPolicy(undefined, session, newRouteSender));
  assert.doesNotThrow(() => assertAppendSessionPolicy({ ...session }, session, newRouteSender));
  assert.throws(
    () => assertAppendSessionPolicy({ ...session }, session, { tab: { id: 7 }, url: 'https://other.example/video/BVother' }),
    (error) => error.code === 'SESSION_ROUTE_CONFLICT',
  );
  assert.throws(
    () => assertAppendSessionPolicy({ ...session }, { ...session, tabId: 8 }, newRouteSender),
    (error) => error.code === 'SESSION_CONFLICT',
  );
});

test('session export cutoff admits only a session first event present in the snapshot', async () => {
  assert.equal(isSessionWithinEventCutoff({ eventId: 41, sequence: 1 }, 41), true);
  assert.equal(isSessionWithinEventCutoff({ eventId: 42, sequence: 1 }, 41), false);
  assert.equal(isSessionWithinEventCutoff({ eventId: 41, sequence: 2 }, 41), false);
  assert.equal(isSessionWithinEventCutoff(undefined, 41), false);
  await assert.rejects(
    readLogs({ type: 'logs:sessions-page', version: 1, limit: 1, maxEventId: -1 }),
    (error) => error.code === 'MAX_EVENT_ID_INVALID',
  );
});

test('log session fragments carry only a precise encoded session filter', () => {
  const sessionId = 'session /?&=测试';
  const fragment = logSessionFragment(sessionId);
  assert.equal(fragment, '#sessionId=session%20%2F%3F%26%3D%E6%B5%8B%E8%AF%95');
  assert.equal(sessionIdFromHash(fragment), sessionId);
  assert.equal(logSessionFragment(undefined), '');
  assert.equal(logSessionFragment(''), '');
  assert.equal(logSessionFragment('未提供'), '');
  assert.equal(sessionIdFromHash('#other=value'), undefined);
  assert.equal(sessionIdFromHash('#sessionId='), undefined);
});

test('error serialization rejects arbitrary cause objects while keeping safe cause fields', () => {
  const error = Object.assign(new Error('safe'), { code: 'SAFE', cause: { name: 'Cause', message: 'nested' } });
  const serialized = serializeError(error);
  assert.equal(serialized.code, 'SAFE');
  assert.deepEqual(serialized.cause, { name: 'Cause', message: 'nested' });
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

assert.equal(EXTENSION_PREFERENCES.vodEnabled, 'vodEnabled');
assert.equal(VOD_CONFIG.stableBufferSeconds, 120);
