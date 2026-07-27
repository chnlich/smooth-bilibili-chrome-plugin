import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOD_CONFIG } from '../src/constants.js';
import { serializeError } from '../src/extension/bridge-contract.js';
import { ExtensionCoordinator } from '../src/extension/controller.js';
import { computeForwardInventory } from '../src/vod/buffer.js';
import { VodBufferController } from '../src/vod/controller.js';
import { DiagnosticsClient, createRouteIdentity } from '../src/diagnostics/client.js';
import { MediaEventRecorder, readMediaFacts } from '../src/diagnostics/media.js';
import { MEDIA_EVENT_NAMES, EVENT_CODES } from '../src/diagnostics/catalog.js';
import {
  browserMetric,
  normalizeEventForStorage,
  sanitizeEventData,
  scrubUrl,
} from '../src/diagnostics/privacy.js';
import { BridgeClient } from '../src/extension/bridge-client.js';
import { encodeMessage } from '../src/extension/bridge-contract.js';

function ranges(values) {
  return {
    length: values.length,
    start(index) { return values[index][0]; },
    end(index) { return values[index][1]; },
  };
}

function mediaVideo(source = 'https://media.example/video-1.m3u8') {
  const listeners = new Map();
  let currentTime = 10;
  const assignments = [];
  const video = {
    src: source,
    currentSrc: source,
    paused: false,
    ended: false,
    readyState: 4,
    networkState: 2,
    duration: Infinity,
    playbackRate: 1,
    muted: false,
    volume: 0.7,
    quality: 32,
    videoWidth: 1280,
    videoHeight: 720,
    buffered: ranges([[0, 80]]),
    seekable: ranges([[0, 120]]),
    error: null,
    isConnected: true,
    clientWidth: 1280,
    clientHeight: 720,
    parentElement: null,
    playCalls: 0,
    pauseCalls: 0,
    assignments,
    addEventListener(name, listener) {
      const set = listeners.get(name) || new Set();
      set.add(listener);
      listeners.set(name, set);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name) {
      for (const listener of listeners.get(name) || []) listener({ type: name });
    },
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
    },
  };
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get() { return currentTime; },
    set(value) {
      assignments.push(value);
      currentTime = value;
    },
  });
  return video;
}

function nativeOwnership(video) {
  return {
    paused: video.paused,
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    muted: video.muted,
    volume: video.volume,
    quality: video.quality,
    currentSrc: video.currentSrc,
    src: video.src,
    playCalls: video.playCalls,
    pauseCalls: video.pauseCalls,
  };
}

function eventDocument(video) {
  const listeners = new Map();
  return {
    documentElement: { dataset: {} },
    defaultView: {},
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; },
    addEventListener(name, listener) {
      const set = listeners.get(name) || new Set();
      set.add(listener);
      listeners.set(name, set);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name, event = { isTrusted: true }) {
      for (const listener of listeners.get(name) || []) listener(event);
    },
    createElement() {
      return {
        width: 0,
        height: 0,
        style: {},
        setAttribute() {},
        getContext() { return { drawImage() {} }; },
        remove() {},
      };
    },
  };
}

function diagnosticsRecorder() {
  return {
    events: [],
    log(code, data, error, context) { this.events.push({ code, data, error, context }); },
    markVideoAvailable() {},
    getStatus() { return { sessionId: 'session-test', persistence: 'PERSISTED' }; },
  };
}

function coordinatorFixture({ diagnostics = diagnosticsRecorder(), enabled = false } = {}) {
  const video = mediaVideo('https://media.example/video-passive-1');
  const documentObject = eventDocument(video);
  const callbacks = [];
  const runtimeObject = {
    setInterval(callback) {
      callbacks.push(callback);
      return callback;
    },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  const location = {
    href: 'https://www.bilibili.com/video/BVpassive',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVpassive',
  };
  const bridgeClient = {
    destroy() {},
    callAsync() { throw new Error('被动诊断不得调用 bridge'); },
  };
  const coordinator = new ExtensionCoordinator({
    documentObject,
    windowObject: { location },
    runtimeObject,
    storage: {
      async get() {
        return { vodEnabled: enabled };
      },
    },
    bridgeClient,
    diagnostics,
    loggerObject: { error() {}, warn() {} },
  });
  return { coordinator, diagnostics, video, callbacks };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('video buffered inventory uses only the contiguous range covering currentTime', () => {
  assert.equal(computeForwardInventory(12, [[{ start: 0, end: 30 }, { start: 40, end: 90 }]]), 18);
  assert.equal(computeForwardInventory(35, [[{ start: 0, end: 30 }, { start: 40, end: 90 }]]), 0);
  assert.equal(computeForwardInventory(50, [
    [{ start: 0, end: 90 }],
    [{ start: 45, end: 70 }],
  ]), 20);
});

function videoControllerFixture({ supports = true, failure, source = 'https://media.example/video-1' } = {}) {
  const calls = [];
  const models = [];
  const intervals = [];
  const video = mediaVideo(source);
  const core = {
    snapshot: { source },
    supports() { return supports; },
    setStableBufferTime(seconds) {
      calls.push(seconds);
      if (failure !== undefined) throw failure;
    },
  };
  let activeCore = core;
  const controller = new VodBufferController({
    video,
    getVideo: () => video,
    panel: { setModel(model) { models.push(model); } },
    runtimeObject: {
      setInterval(callback) { intervals.push(callback); return callback; },
      clearInterval() {},
    },
    refreshCore: async () => activeCore,
  });
  return {
    controller,
    video,
    core,
    calls,
    models,
    intervals,
    replaceCore(nextCore) { activeCore = nextCore; },
  };
}

test('each coherent video core/source generation receives one native 120-second hint', async () => {
  const fixture = videoControllerFixture();
  fixture.controller.start();
  await fixture.controller.reconcile();
  await fixture.controller.reconcile();
  assert.deepEqual(fixture.calls, [VOD_CONFIG.stableBufferSeconds]);

  fixture.video.src = 'https://media.example/video-2';
  fixture.video.currentSrc = fixture.video.src;
  fixture.replaceCore({
    snapshot: { source: fixture.video.src },
    supports() { return true; },
    setStableBufferTime(seconds) { fixture.calls.push(seconds); },
  });
  await fixture.controller.reconcile();
  assert.deepEqual(fixture.calls, [120, 120]);

  fixture.replaceCore({
    snapshot: { source: fixture.video.src },
    supports() { return true; },
    setStableBufferTime(seconds) { fixture.calls.push(seconds); },
  });
  await fixture.controller.reconcile();
  assert.deepEqual(fixture.calls, [120, 120, 120]);
  fixture.controller.destroy();
});

test('video buffer hint logs requested target separately from measured native contiguous buffer', async () => {
  const diagnostics = diagnosticsRecorder();
  const fixture = videoControllerFixture();
  fixture.controller.diagnostics = diagnostics;
  fixture.video.currentTime = 10;
  fixture.video.buffered = ranges([[0, 70], [90, 120]]);
  fixture.controller.start();
  await fixture.controller.reconcile();
  const applied = diagnostics.events.find((event) => event.code === 'video.buffer_hint.applied');
  assert.equal(applied.data.targetSeconds, 120);
  assert.equal(applied.data.actualSeconds, 60);
  assert.notEqual(applied.data.actualSeconds, applied.data.targetSeconds);
  fixture.controller.destroy();
});

test('a stale or mixed video generation never receives the native hint', async () => {
  const video = mediaVideo('https://media.example/old');
  const calls = [];
  let resolveCore;
  const controller = new VodBufferController({
    video,
    getVideo: () => video,
    panel: { setModel() {} },
    runtimeObject: { setInterval() { return 1; }, clearInterval() {} },
    refreshCore: () => new Promise((resolve) => { resolveCore = resolve; }),
  });
  controller.start();
  const pending = controller.reconcile();
  video.src = 'https://media.example/new';
  video.currentSrc = video.src;
  resolveCore({
    snapshot: { source: 'https://media.example/old' },
    supports() { return true; },
    setStableBufferTime(seconds) { calls.push(seconds); },
  });
  await pending;
  assert.deepEqual(calls, []);
  controller.destroy();
});

test('a replaced video with the same source cannot receive an old core hint', async () => {
  const source = 'https://media.example/shared';
  const oldVideo = mediaVideo(source);
  const newVideo = mediaVideo(source);
  const calls = [];
  let activeVideo = oldVideo;
  let resolveFirstCore;
  let firstCore = true;
  const oldCore = {
    snapshot: { source },
    supports() { return true; },
    setStableBufferTime(seconds) { calls.push({ core: 'old', seconds }); },
  };
  const newCore = {
    snapshot: { source },
    supports() { return true; },
    setStableBufferTime(seconds) { calls.push({ core: 'new', seconds }); },
  };
  const controller = new VodBufferController({
    video: oldVideo,
    getVideo: () => activeVideo,
    panel: { setModel() {} },
    runtimeObject: { setInterval() { return 1; }, clearInterval() {} },
    refreshCore() {
      if (!firstCore) return Promise.resolve(newCore);
      firstCore = false;
      return new Promise((resolve) => { resolveFirstCore = resolve; });
    },
  });
  controller.start();
  activeVideo = newVideo;
  resolveFirstCore(oldCore);
  await tick();
  assert.deepEqual(calls, []);
  await controller.reconcile();
  assert.deepEqual(calls, [{ core: 'new', seconds: VOD_CONFIG.stableBufferSeconds }]);
  controller.destroy();
});

test('unsupported and throwing native buffer capabilities are reported without takeover', async () => {
  const unsupported = videoControllerFixture({ supports: false });
  const unsupportedOwnership = nativeOwnership(unsupported.video);
  unsupported.controller.start();
  await unsupported.controller.reconcile();
  assert.deepEqual(unsupported.calls, []);
  assert.equal(unsupported.models.at(-1).state, 'UNSUPPORTED');
  assert.deepEqual(nativeOwnership(unsupported.video), unsupportedOwnership);
  unsupported.controller.destroy();

  const failed = videoControllerFixture({ failure: Object.assign(new Error('native setter failed'), { code: 'NATIVE_FAILED' }) });
  const failedOwnership = nativeOwnership(failed.video);
  failed.controller.start();
  await failed.controller.reconcile();
  assert.deepEqual(failed.calls, [120]);
  assert.equal(failed.models.at(-1).state, 'FAILED');
  assert.deepEqual(nativeOwnership(failed.video), failedOwnership);
  failed.controller.destroy();
});

test('video bridge refresh errors wait and recover without repeating a stable hint', async () => {
  const source = 'https://media.example/recovery';
  const calls = [];
  const models = [];
  const core = {
    snapshot: { source },
    supports() { return true; },
    setStableBufferTime(seconds) { calls.push(seconds); },
  };
  let refreshCore = async () => core;
  const controller = new VodBufferController({
    video: mediaVideo(source),
    panel: { setModel(model) { models.push(model); } },
    runtimeObject: { setInterval() { return 1; }, clearInterval() {} },
    logger: { error() {}, warn() {} },
    refreshCore: () => refreshCore(),
  });
  controller.start();
  await controller.reconcile();
  assert.deepEqual(calls, [120]);

  refreshCore = async () => { throw Object.assign(new Error('bridge unavailable'), { code: 'PLAYER_UNAVAILABLE' }); };
  await controller.reconcile();
  assert.equal(models.at(-1).state, 'WAITING');
  refreshCore = async () => core;
  await controller.reconcile();
  assert.deepEqual(calls, [120]);
  assert.equal(models.at(-1).state, 'APPLIED');

  refreshCore = async () => { throw new Error('bridge response failed'); };
  await controller.reconcile();
  assert.equal(models.at(-1).state, 'WAITING');
  refreshCore = async () => core;
  await controller.reconcile();
  assert.deepEqual(calls, [120]);
  assert.equal(models.at(-1).state, 'APPLIED');
  controller.destroy();
});

test('a stale video buffer setter retries only the replacement core', async () => {
  const source = 'https://media.example/stale-setter';
  const staleCalls = [];
  const replacementCalls = [];
  let resolveFirstCore;
  let firstRefresh = true;
  let currentCore;
  const staleCore = {
    snapshot: { source },
    supports() { return true; },
    setStableBufferTime(seconds) {
      staleCalls.push(seconds);
      throw Object.assign(new Error('stale core'), { code: 'BRIDGE_CORE_STALE' });
    },
  };
  const replacementCore = {
    snapshot: { source },
    supports() { return true; },
    setStableBufferTime(seconds) { replacementCalls.push(seconds); },
  };
  currentCore = staleCore;
  const controller = new VodBufferController({
    video: mediaVideo(source),
    panel: { setModel() {} },
    runtimeObject: { setInterval() { return 1; }, clearInterval() {} },
    refreshCore() {
      if (!firstRefresh) return Promise.resolve(currentCore);
      firstRefresh = false;
      return new Promise((resolve) => { resolveFirstCore = resolve; });
    },
  });
  controller.start();
  resolveFirstCore(staleCore);
  await tick();
  assert.deepEqual(staleCalls, [120]);
  currentCore = replacementCore;
  await controller.reconcile();
  assert.deepEqual(staleCalls, [120]);
  assert.deepEqual(replacementCalls, [120]);
  controller.destroy();
});

test('video controller reports zero native buffer when current time has no covering range', async () => {
  const fixture = videoControllerFixture();
  fixture.video.buffered = ranges([[0, 4], [20, 120]]);
  fixture.video.currentTime = 10;
  fixture.controller.start();
  await fixture.controller.reconcile();
  assert.equal(fixture.controller.readForwardBuffer(), 0);
  fixture.controller.updateStatus();
  assert.equal(fixture.models.at(-1).buffered, '0.0 秒');
  fixture.controller.destroy();
});

test('disabled video route passively records media without media or bridge ownership', async () => {
  const diagnostics = diagnosticsRecorder();
  let availableCount = 0;
  let noVideoPending = true;
  diagnostics.markVideoAvailable = () => {
    availableCount += 1;
    noVideoPending = false;
  };
  diagnostics.destroy = () => {};
  const fixture = coordinatorFixture({ diagnostics });
  const ownership = nativeOwnership(fixture.video);

  await fixture.coordinator.start();
  assert.equal(fixture.coordinator.active.controller, undefined);
  assert.notEqual(fixture.coordinator.active.passiveObserver, undefined);
  assert.equal(availableCount, 1);
  assert.equal(noVideoPending, false);
  assert.equal(diagnostics.events.filter((event) => event.code === 'media.sample').length, 1);
  fixture.video.emit('playing');
  assert.equal(diagnostics.events.filter((event) => event.code === 'media.playing').length, 1);
  assert.deepEqual(nativeOwnership(fixture.video), ownership);

  fixture.video.src = 'https://media.example/video-passive-2';
  fixture.video.currentSrc = fixture.video.src;
  fixture.coordinator.active.passiveObserver.reconcile();
  const replacement = diagnostics.events.find((event) => event.code === 'video.source_replaced');
  assert.equal(replacement.context.videoInstance, 1);
  assert.equal(replacement.context.sourceInstance, 2);
  assert.equal(fixture.video.playCalls, 0);
  assert.equal(fixture.video.pauseCalls, 0);
  assert.deepEqual(fixture.video.assignments, []);

  await fixture.coordinator.destroy();
  const eventCount = diagnostics.events.length;
  fixture.video.emit('timeupdate');
  assert.equal(diagnostics.events.length, eventCount);
});

test('a failed controller boot falls back to passive diagnostics after destroying the partial controller', async () => {
  const diagnostics = diagnosticsRecorder();
  let availableCount = 0;
  diagnostics.markVideoAvailable = () => {
    availableCount += 1;
    if (availableCount === 1) throw new Error('diagnostic recorder boot failure');
  };
  diagnostics.destroy = () => {};
  const fixture = coordinatorFixture({ diagnostics, enabled: true });

  await fixture.coordinator.start();
  assert.equal(fixture.coordinator.active.controller, undefined);
  assert.notEqual(fixture.coordinator.active.passiveObserver, undefined);
  assert.equal(availableCount, 2);
  assert.ok(diagnostics.events.some((event) => event.code === 'extension.boot_error'));
  assert.ok(diagnostics.events.some((event) => event.code === 'media.sample'));
  await fixture.coordinator.destroy();
});

test('every catalog media event records its own eventType while samples remain sample', () => {
  const video = mediaVideo('https://media.example/media-events');
  const events = [];
  const recorder = new MediaEventRecorder({
    video,
    runtimeObject: { setInterval(callback) { return callback; }, clearInterval() {} },
    logger: { log(code, data) { events.push({ code, data }); } },
  });
  recorder.start();
  for (const name of MEDIA_EVENT_NAMES) video.emit(name);
  recorder.destroy();
  assert.equal(events.find((event) => event.code === 'media.sample').data.eventType, 'sample');
  for (const name of MEDIA_EVENT_NAMES) {
    assert.equal(events.find((event) => event.code === `media.${name}`).data.eventType, name);
  }
  assert.equal(readMediaFacts(video, 'volumechange').eventType, 'volumechange');
});

test('native numeric MediaError code survives media.error persistence with the fixed error schema', async () => {
  const video = mediaVideo('https://media.example/media-error');
  const sent = [];
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVmedia-error',
  };
  const windowObject = {
    location: locationObject,
    setTimeout(callback) {
      return { callback };
    },
    clearTimeout() {},
  };
  const diagnostics = new DiagnosticsClient({
    documentObject: { defaultView: { addEventListener() {} } },
    windowObject,
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  const recorder = new MediaEventRecorder({
    video,
    runtimeObject: { setInterval() { return 1; }, clearInterval() {} },
    logger: diagnostics,
  });
  recorder.start();
  video.error = { name: 'MediaError', code: 3, message: 'decode failed', stack: 'native stack' };
  video.emit('error');
  await diagnostics.flush();
  const errorEvent = sent.flatMap((message) => message.events).find((event) => event.code === 'media.error');
  assert.equal(errorEvent.error.name, 'MediaError');
  assert.equal(errorEvent.error.code, '3');
  assert.equal(errorEvent.error.message, 'decode failed');
  assert.equal(errorEvent.error.stack, 'native stack');
  recorder.destroy();
  diagnostics.destroy();
});

test('diagnostic catalog covers all required media events and preserves browser-reported zero', () => {
  assert.ok(MEDIA_EVENT_NAMES.includes('volumechange'));
  for (const name of MEDIA_EVENT_NAMES) assert.ok(EVENT_CODES.includes(`media.${name}`));
  assert.deepEqual(browserMetric(0), { value: 0, reportedBy: 'browser' });
  assert.equal(scrubUrl('https://cdn.example/media.m4s?signature=secret#fragment'), 'https://cdn.example/media.m4s');
  assert.deepEqual(sanitizeEventData('media.sample', {
    currentTime: 0,
    bufferedRanges: [{ start: 0, end: 12 }],
    secretBody: 'must be removed',
    source: 'https://cdn.example/seg.m4s?token=secret',
  }), {
    currentTime: 0,
    bufferedRanges: [{ start: 0, end: 12 }],
    source: 'https://cdn.example/seg.m4s',
  });
  assert.deepEqual(sanitizeEventData('route.session_started', {
    origin: 'https://www.example.test/?account=secret',
    pathname: '/video/BVprivacy?token=secret#fragment',
    bvid: 'BVprivacy?secret=1',
  }), {
    origin: 'https://www.example.test',
    pathname: '/video/BVprivacy',
    bvid: 'BVprivacy',
  });
});

test('media attribution fields pass through the existing privacy path', () => {
  const video = mediaVideo('https://media.example/attribution');
  video.getVideoPlaybackQuality = () => ({
    totalVideoFrames: 100,
    droppedVideoFrames: 4,
    corruptedVideoFrames: 1,
  });
  video.ownerDocument = {
    documentElement: {
      getAttribute(name) {
        assert.equal(name, 'data-bilibili-buffer-shim-diagnostics');
        return JSON.stringify({
          sourceBufferRanges: [{ track: 'video', ranges: [{ start: 0, end: 80 }] }],
          mediaSourceState: 'open',
          appendErrors: { QuotaExceededError: 2 },
          removeStats: { removeCalls: 7 },
        });
      },
    },
  };
  const facts = readMediaFacts(video, 'waiting');
  const sanitized = sanitizeEventData('media.waiting', facts);
  assert.deepEqual(sanitized.videoQuality, { total: 100, dropped: 4, corrupted: 1 });
  assert.deepEqual(sanitized.sourceBufferRanges, [{ track: 'video', ranges: [{ start: 0, end: 80 }] }]);
  assert.equal(sanitized.mediaSourceState, 'open');
  assert.deepEqual(sanitized.appendErrors, { QuotaExceededError: 2 });
  assert.deepEqual(sanitized.removeStats, { removeCalls: 7 });
});

test('watch-later route identity preserves the real item and omits an absent item', () => {
  const item = createRouteIdentity({
    hostname: 'www.bilibili.com',
    pathname: '/list/watchlater/item-actual',
    search: '?p=part-1',
  });
  assert.deepEqual(item, {
    routeKind: 'video',
    watchLaterItem: 'item-actual',
    part: 'part-1',
  });
  assert.deepEqual(createRouteIdentity({
    hostname: 'www.bilibili.com',
    pathname: '/list/watchlater',
    search: '',
  }), { routeKind: 'video', watchLaterItem: undefined, part: undefined });
});

test('bridge and privacy error contracts preserve deep causes, scrub URLs, and mark cycles', () => {
  let deepest = Object.assign(new Error('deep https://secret.example/path?token=redact'), { code: 'DEEP' });
  for (let index = 0; index < 24; index += 1) {
    deepest = Object.assign(new Error(`cause-${index} https://secret.example/${index}?token=redact`), {
      code: `CAUSE_${index}`,
      cause: deepest,
    });
  }
  const error = Object.assign(new Error('outer https://secret.example/root?token=redact'), {
    code: 'OUTER',
    cause: deepest,
  });
  const serialized = serializeError(error);
  let serializedDepth = 0;
  let serializedCause = serialized.cause;
  while (typeof serializedCause === 'object') {
    serializedDepth += 1;
    serializedCause = serializedCause.cause;
  }
  assert.equal(serializedDepth, 25);
  assert.doesNotMatch(JSON.stringify(serialized), /CauseDepthLimit/);

  const privacyEvent = normalizeEventForStorage({
    sessionId: 'session-deep-error',
    sequence: 1,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: 0,
    code: 'extension.observer_error',
    error: serialized,
  });
  assert.doesNotMatch(JSON.stringify(privacyEvent), /token=redact|CauseDepthLimit/);
  assert.match(privacyEvent.error.cause.cause.message, /https:\/\/secret\.example\/\d+$/);

  const circular = new Error('circular');
  circular.cause = circular;
  const circularEvent = normalizeEventForStorage({
    sessionId: 'session-circular-error',
    sequence: 1,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: 0,
    code: 'extension.observer_error',
    error: serializeError(circular),
  });
  assert.equal(circularEvent.error.cause, '[Circular]');

  const bridgeDocument = {
    defaultView: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const bridgeClient = new BridgeClient(bridgeDocument, {
    setTimeout() { return 1; },
    clearTimeout() {},
  });
  const bridgeResponse = encodeMessage({
    version: 1,
    id: 1,
    operation: 'getCoreSnapshot',
    ok: false,
    error: serialized,
  });
  assert.throws(
    () => bridgeClient.decodeResponse(bridgeResponse, 1, 'getCoreSnapshot'),
    (bridgeError) => bridgeError.cause?.cause?.cause?.cause?.cause !== undefined,
  );
  bridgeClient.destroy();
});

test('bridge error serialization keeps stack and a circular cause chain', () => {
  const cause = new Error('cause');
  const error = new Error('outer', { cause });
  cause.cause = error;
  const serialized = serializeError(error);
  assert.equal(serialized.message, 'outer');
  assert.equal(typeof serialized.stack, 'string');
  assert.equal(serialized.cause.cause, '[Circular]');
});

test('diagnostics initializes before controls, creates fresh sessions, and flushes each batch', async () => {
  const sent = [];
  const timers = [];
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVtest',
  };
  const windowObject = {
    location: locationObject,
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  };
  const client = new DiagnosticsClient({
    documentObject: { defaultView: { addEventListener() {} } },
    windowObject,
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  const first = client.getStatus().sessionId;
  client.log('video.attached', { source: 'https://cdn.example/video?token=secret' });
  await client.flush();
  client.startSession({ routeKind: 'video', bvid: 'BVnext' });
  const second = client.getStatus().sessionId;
  assert.notEqual(first, second);
  client.log('route.changed', { reason: 'spa_media_change' });
  await client.flush();
  assert.ok(sent.length >= 2);
  assert.equal(sent[0].session.sessionId, first);
  assert.equal(sent.at(-1).session.sessionId, second);
  assert.equal(sent[0].events[0].sequence, 1);
  client.destroy();
  assert.ok(timers.some((timer) => timer.milliseconds === 30000));
});

test('diagnostics immediately sends a new session identity before scheduled flushes', () => {
  const sent = [];
  const timers = [];
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVinitial',
  };
  class SilentPerformanceObserver {
    observe() {}

    disconnect() {}
  }
  const client = new DiagnosticsClient({
    documentObject: { defaultView: { addEventListener() {} } },
    windowObject: {
      location: locationObject,
      PerformanceObserver: SilentPerformanceObserver,
      setTimeout(callback, milliseconds) {
        const timer = { callback, milliseconds };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { timer.cleared = true; },
    },
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].events.map((event) => event.code), ['route.session_started']);
  assert.equal(sent[0].session.pathname, '/video/BVinitial');
  assert.ok(timers.some((timer) => timer.milliseconds === 0));
  client.destroy();
});

test('diagnostics pagehide drains queued batches after an in-flight commit', async () => {
  const sent = [];
  const acknowledgements = [];
  let onPagehide;
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVpagehide',
  };
  const client = new DiagnosticsClient({
    documentObject: {
      defaultView: {
        addEventListener(name, callback) {
          if (name === 'pagehide') onPagehide = callback;
        },
      },
    },
    windowObject: {
      location: locationObject,
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        acknowledgements.push(() => callback({
          ok: true,
          status: 'PERSISTED',
          eventCount: message.events.length,
        }));
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  client.log('video.attached', { source: 'https://cdn.example/video' });
  client.log('route.changed', { reason: 'spa_media_change' });
  onPagehide();
  assert.equal(sent.length, 1);
  acknowledgements.shift()();
  await tick();
  assert.equal(sent.length, 2);
  acknowledgements.shift()();
  await tick();
  assert.equal(client.destroyed, true);
  assert.ok(sent[0].events.some((event) => event.code === 'route.session_started'));
  assert.ok(sent[1].events.some((event) => event.code === 'video.attached'));
  assert.ok(sent[1].events.some((event) => event.code === 'route.changed'));
});

test('resource timing observer snapshots prototype fields before privacy filtering', async () => {
  const sent = [];
  const timers = [];
  let resourceObserverCallback;
  class FakePerformanceObserver {
    constructor(callback) {
      resourceObserverCallback = callback;
    }

    observe() {}

    disconnect() {}
  }
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVresource',
  };
  const client = new DiagnosticsClient({
    documentObject: { defaultView: { addEventListener() {} } },
    windowObject: {
      location: locationObject,
      PerformanceObserver: FakePerformanceObserver,
      setTimeout(callback, milliseconds) {
        const timer = { callback, milliseconds };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { timer.cleared = true; },
    },
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  const entry = Object.create({
    get name() { return 'https://cdn.example/video.m4s?token=secret#fragment'; },
    get initiatorType() { return 'video'; },
    get startTime() { return 0; },
    get duration() { return 1; },
    get responseStart() { return 0; },
    get responseEnd() { return 2; },
    get transferSize() { return 0; },
    get encodedBodySize() { return 3; },
    get decodedBodySize() { return 0; },
  });
  resourceObserverCallback({ getEntries() { return [entry]; } });
  await client.flush();
  const resourceEvent = sent.flatMap((message) => message.events).find((event) => event.code === 'resource.observed');
  assert.deepEqual(resourceEvent.data, {
    name: 'https://cdn.example/video.m4s',
    initiatorType: 'video',
    startTime: { value: 0, reportedBy: 'browser' },
    duration: 1,
    responseStart: { value: 0, reportedBy: 'browser' },
    responseEnd: 2,
    transferSize: { value: 0, reportedBy: 'browser' },
    encodedBodySize: 3,
    decodedBodySize: { value: 0, reportedBy: 'browser' },
  });
  assert.equal(JSON.stringify(resourceEvent.data).includes('token'), false);
  assert.equal(JSON.stringify(resourceEvent.data).includes('fragment'), false);
  client.destroy();
  assert.ok(timers.some((timer) => timer.milliseconds === 30000));
});

test('resource timing omits non-media and unknown resource names while retaining metrics', async () => {
  const sent = [];
  let resourceObserverCallback;
  class FakePerformanceObserver {
    constructor(callback) {
      resourceObserverCallback = callback;
    }

    observe() {}

    disconnect() {}
  }
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVresource-privacy',
  };
  const client = new DiagnosticsClient({
    documentObject: { defaultView: { addEventListener() {} } },
    windowObject: {
      location: locationObject,
      PerformanceObserver: FakePerformanceObserver,
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    runtimeObject: {
      sendMessage(message, callback) {
        sent.push(message);
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  const scriptEntry = Object.create({
    get name() { return 'https://api.bilibili.com/account/private?token=secret#fragment'; },
    get initiatorType() { return 'script'; },
    get startTime() { return 0; },
    get duration() { return 1; },
    get responseStart() { return 0; },
    get responseEnd() { return 2; },
    get transferSize() { return 0; },
    get encodedBodySize() { return 3; },
    get decodedBodySize() { return 0; },
  });
  const unknownEntry = Object.create({
    get name() { return 'https://api.bilibili.com/x/web-interface/nav?cookie=secret#fragment'; },
    get initiatorType() { return 'other'; },
    get startTime() { return 4; },
    get duration() { return 0; },
    get responseStart() { return 5; },
    get responseEnd() { return 6; },
    get transferSize() { return 7; },
    get encodedBodySize() { return 0; },
    get decodedBodySize() { return 8; },
  });
  resourceObserverCallback({ getEntries() { return [scriptEntry, unknownEntry]; } });
  await client.flush();
  const resourceEvents = sent.flatMap((message) => message.events)
    .filter((event) => event.code === 'resource.observed');
  assert.deepEqual(resourceEvents.map((event) => event.data), [
    {
      initiatorType: 'script',
      startTime: { value: 0, reportedBy: 'browser' },
      duration: 1,
      responseStart: { value: 0, reportedBy: 'browser' },
      responseEnd: 2,
      transferSize: { value: 0, reportedBy: 'browser' },
      encodedBodySize: 3,
      decodedBodySize: { value: 0, reportedBy: 'browser' },
    },
    {
      initiatorType: 'other',
      startTime: 4,
      duration: { value: 0, reportedBy: 'browser' },
      responseStart: 5,
      responseEnd: 6,
      transferSize: 7,
      encodedBodySize: { value: 0, reportedBy: 'browser' },
      decodedBodySize: 8,
    },
  ]);
  assert.equal(JSON.stringify(resourceEvents).includes('account'), false);
  assert.equal(JSON.stringify(resourceEvents).includes('cookie'), false);
  client.destroy();
});
