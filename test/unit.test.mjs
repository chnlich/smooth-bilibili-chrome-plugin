import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOD_CONFIG } from '../src/constants.js';
import { SHIM_APPEND_EVENT, serializeError } from '../src/extension/bridge-contract.js';
import { ExtensionCoordinator } from '../src/extension/controller.js';
import { computeForwardInventory } from '../src/vod/buffer.js';
import { VodBufferController } from '../src/vod/controller.js';
import { DiagnosticsClient, createRouteIdentity } from '../src/diagnostics/client.js';
import { MediaEventRecorder, classifyStall, readMediaFacts } from '../src/diagnostics/media.js';
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

function mediaRecorderFixture({ supportsFrameCallback = true, visibilityState = 'visible' } = {}) {
  const video = mediaVideo('https://media.example/diagnostic-video');
  const documentListeners = new Map();
  let shimDiagnostics;
  let now = 0;
  let frameCallback;
  const intervalCallbacks = [];
  const events = [];
  const documentObject = {
    visibilityState,
    documentElement: {
      getAttribute(name) {
        assert.equal(name, 'data-bilibili-buffer-shim-diagnostics');
        return shimDiagnostics === undefined ? null : JSON.stringify(shimDiagnostics);
      },
    },
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) || new Set();
      listeners.add(listener);
      documentListeners.set(name, listeners);
    },
    removeEventListener(name, listener) {
      documentListeners.get(name)?.delete(listener);
    },
    emit(name) {
      for (const listener of documentListeners.get(name) || []) listener();
    },
  };
  video.ownerDocument = documentObject;
  if (supportsFrameCallback) {
    video.requestVideoFrameCallback = (callback) => {
      frameCallback = callback;
      return 1;
    };
  }
  const recorder = new MediaEventRecorder({
    video,
    runtimeObject: {
      setInterval(callback) {
        intervalCallbacks.push(callback);
        return callback;
      },
      clearInterval() {},
    },
    now: () => now,
    logger: {
      log(code, data, error, context) {
        events.push({ code, data, error, context });
      },
    },
  });
  return {
    video,
    documentObject,
    recorder,
    events,
    setTime(value) { now = value; },
    setShimDiagnostics(value) { shimDiagnostics = value; },
    emitFrame(timestamp, metadata) {
      assert.notEqual(frameCallback, undefined);
      frameCallback(timestamp, metadata);
    },
    sample() {
      recorder.sample();
    },
    intervalCallbacks,
  };
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

function logsPageFixture() {
  const elements = new Map();
  const documentObject = {
    createElement(tagName) {
      return {
        tagName,
        ownerDocument: documentObject,
        children: [],
        textContent: '',
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = [...children]; },
      };
    },
    querySelector(selector) {
      const element = elements.get(selector);
      if (element === undefined) throw new Error(`missing test element: ${selector}`);
      return element;
    },
  };
  for (const selector of [
    '[data-session-filter]',
    '[data-export]',
    '[data-status]',
    '[data-session-details]',
    '[data-cdn-refresh]',
    '[data-cdn-status]',
    '[data-cdn-summary]',
    '[data-cdn-rows]',
  ]) {
    const listeners = new Map();
    elements.set(selector, {
      ownerDocument: documentObject,
      value: '',
      disabled: false,
      textContent: '',
      listeners,
      addEventListener(type, listener) { listeners.set(type, listener); },
      querySelector() { return { disabled: false }; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      children: [],
    });
  }
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    chrome: globalThis.chrome,
  };
  const messages = [];
  globalThis.document = documentObject;
  globalThis.window = { location: { hash: '' } };
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        throw new Error('test page sendMessage must be configured before use');
      },
    },
  };
  return {
    elements,
    messages,
    async importModule() {
      return import(`../src/diagnostics/logs.js?unit=${Date.now()}-${Math.random()}`);
    },
    restore() {
      globalThis.document = originalGlobals.document;
      globalThis.window = originalGlobals.window;
      globalThis.chrome = originalGlobals.chrome;
    },
  };
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
  fixture.coordinator.documentObject.emit(SHIM_APPEND_EVENT, {
    detail: JSON.stringify({
      mediaSourceInstance: 1,
      sourceBufferInstance: 1,
      appendSequence: 1,
      track: 'video/mp4',
      bytes: 8,
      bufferedBefore: [{ start: 0, end: 10 }],
      bufferedAfter: [{ start: 0, end: 12 }],
      durationMs: 4,
      result: 'ok',
    }),
  });
  assert.deepEqual(diagnostics.events.find((event) => event.code === 'media.append').data, {
    mediaSourceInstance: 1,
    sourceBufferInstance: 1,
    appendSequence: 1,
    track: 'video/mp4',
    bytes: 8,
    bufferedBefore: [{ start: 0, end: 10 }],
    bufferedAfter: [{ start: 0, end: 12 }],
    durationMs: 4,
    result: 'ok',
  });
  fixture.video.emit('playing');
  assert.equal(diagnostics.events.filter((event) => event.code === 'media.playing').length, 1);
  fixture.video.emit('timeupdate');
  assert.equal(diagnostics.events.filter((event) => event.code === 'media.timeupdate').length, 0);
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
  fixture.coordinator.documentObject.emit(SHIM_APPEND_EVENT, {
    detail: JSON.stringify({ result: 'ok' }),
  });
  assert.equal(diagnostics.events.length, eventCount);
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

test('media frame aggregation reports presented deltas and resets each interval', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(100, { presentedFrames: 10 });
  fixture.emitFrame(200, { presentedFrames: 13 });
  fixture.setTime(1000);
  fixture.sample();
  fixture.setTime(2000);
  fixture.sample();

  const samples = fixture.events.filter((event) => event.code === 'media.sample');
  assert.equal(samples[0].data.presented, 3);
  assert.equal(samples[1].data.presented, 0);
  assert.equal(Object.hasOwn(samples[0].data, 'frameTiming'), true);
  assert.equal(Object.hasOwn(samples[0].data, 'appends'), false);
  fixture.recorder.destroy();
});

test('frame timing aggregates display lead and media steps in rounded milliseconds', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(0, {
    presentedFrames: 1,
    expectedDisplayTime: 15.49,
    presentationTime: 10,
    mediaTime: 1,
  });
  fixture.emitFrame(100, {
    presentedFrames: 2,
    expectedDisplayTime: 30.51,
    presentationTime: 20,
    mediaTime: 1.04,
  });
  fixture.emitFrame(200, {
    presentedFrames: 3,
    expectedDisplayTime: 48.49,
    presentationTime: 35,
    mediaTime: 1.07,
  });
  fixture.emitFrame(300, {
    presentedFrames: 4,
    expectedDisplayTime: 54,
    presentationTime: 40,
    mediaTime: 1.12,
  });
  fixture.setTime(300);
  fixture.sample();

  const detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.displayLeadMsMedian, 12);
  assert.equal(detail.displayLeadMsMin, 5);
  assert.equal(detail.mediaStepMsMedian, 40);
  assert.equal(detail.mediaStepMsMax, 50);
  fixture.recorder.destroy();
});

test('classifyStall short-circuits data and frame conditions in order', () => {
  const bufferedRanges = [{ start: 0, end: 20 }];
  const base = {
    currentTime: 10,
    bufferedRanges,
    droppedDelta: 0,
    mediaStepMsMedian: 33,
    mediaStepMsMax: 33,
  };
  assert.equal(classifyStall({
    ...base,
    currentTime: 20,
    totalDelta: 0,
  }), '数据侧');
  assert.equal(classifyStall({ ...base, totalDelta: 0 }), '帧未产出');
  assert.equal(classifyStall({
    ...base,
    totalDelta: 4,
    mediaStepMsMax: 66,
  }), '帧未呈现');
  assert.equal(classifyStall({ ...base, totalDelta: 4 }), '未判定');
  assert.equal(classifyStall({ ...base, totalDelta: undefined, droppedDelta: undefined }), '未判定');
  assert.equal(classifyStall({
    ...base,
    totalDelta: 4,
    droppedDelta: 0,
    mediaStepMsMedian: '未提供',
    mediaStepMsMax: '未提供',
  }), '未判定');
});

test('media waiting retains its classified last stall', () => {
  const fixture = mediaRecorderFixture();
  let quality = { total: 10, dropped: 0 };
  fixture.video.getVideoPlaybackQuality = () => ({
    totalVideoFrames: quality.total,
    droppedVideoFrames: quality.dropped,
    corruptedVideoFrames: 0,
  });
  fixture.recorder.start();
  fixture.events.length = 0;

  quality = { total: 11, dropped: 1 };
  fixture.video.emit('waiting');

  const lastStall = fixture.recorder.getLastStall();
  assert.equal(lastStall.kind, '帧未呈现');
  assert.equal(Number.isFinite(lastStall.atMs), true);
  fixture.recorder.destroy();
});

test('media events other than waiting never set or replace the last stall', () => {
  const fixture = mediaRecorderFixture();
  let quality = { total: 10, dropped: 0 };
  fixture.video.getVideoPlaybackQuality = () => ({
    totalVideoFrames: quality.total,
    droppedVideoFrames: quality.dropped,
    corruptedVideoFrames: 0,
  });
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.video.emit('stalled');
  assert.equal(fixture.recorder.getLastStall(), undefined);

  quality = { total: 11, dropped: 1 };
  fixture.video.emit('waiting');
  assert.equal(fixture.recorder.getLastStall().kind, '帧未呈现');

  quality = { total: 12, dropped: 2 };
  fixture.video.emit('stalled');
  assert.equal(fixture.recorder.getLastStall().kind, '帧未呈现');
  fixture.recorder.destroy();
});

test('media waiting compares the rounded frame timing values for its stall kind', () => {
  const fixture = mediaRecorderFixture();
  let quality = { total: 10, dropped: 0 };
  fixture.video.getVideoPlaybackQuality = () => ({
    totalVideoFrames: quality.total,
    droppedVideoFrames: quality.dropped,
    corruptedVideoFrames: 0,
  });
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(0, { presentedFrames: 1, mediaTime: 1 });
  fixture.emitFrame(33.6, { presentedFrames: 2, mediaTime: 1.0336 });
  fixture.emitFrame(67.4, { presentedFrames: 3, mediaTime: 1.0674 });
  quality = { total: 11, dropped: 0 };
  fixture.video.emit('waiting');

  const timing = fixture.events.at(-1).data.frameTiming;
  assert.equal(timing.mediaStepMsMedian, 34);
  assert.equal(timing.mediaStepMsMax, 34);
  assert.equal(fixture.recorder.getLastStall().kind, '未判定');
  fixture.recorder.destroy();
});

test('media frame gap keeps its full duration across record boundaries and locates recovery', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(0, { presentedFrames: 1 });
  fixture.setTime(400);
  fixture.sample();
  fixture.setTime(1000);
  fixture.sample();
  const frameless = fixture.events.at(-1).data.frameTiming;
  assert.equal(frameless.maxFrameGapMs, 1000);
  assert.equal(frameless.maxFrameGapEndedAgoMs, '未提供');

  fixture.emitFrame(1800, { presentedFrames: 2 });
  fixture.setTime(2000);
  fixture.sample();
  const recovery = fixture.events.at(-1).data.frameTiming;
  assert.equal(recovery.maxFrameGapMs, 1800);
  assert.equal(recovery.maxFrameGapEndedAgoMs, 200);
  assert.equal(2000 - recovery.maxFrameGapEndedAgoMs, 1800);
  fixture.recorder.destroy();
});

test('each stall predicate arm fires independently', () => {
  const advancingClock = mediaRecorderFixture();
  advancingClock.recorder.start();
  advancingClock.events.length = 0;
  advancingClock.video.currentTime = 10.3;
  advancingClock.setTime(1000);
  advancingClock.sample();
  assert.equal(typeof advancingClock.events.at(-1).data.frameTiming, 'object');
  advancingClock.recorder.destroy();

  const lowReadyState = mediaRecorderFixture();
  lowReadyState.recorder.start();
  lowReadyState.events.length = 0;
  lowReadyState.video.readyState = 2;
  lowReadyState.setTime(1000);
  lowReadyState.sample();
  assert.equal(typeof lowReadyState.events.at(-1).data.frameTiming, 'object');
  lowReadyState.recorder.destroy();

  const longGap = mediaRecorderFixture();
  longGap.recorder.start();
  longGap.events.length = 0;
  longGap.emitFrame(0, { presentedFrames: 1 });
  longGap.setTime(0);
  longGap.sample();
  longGap.setTime(600);
  longGap.sample();
  assert.equal(longGap.events.at(-1).data.frameTiming.maxFrameGapMs, 600);
  longGap.recorder.destroy();
});

test('normal intervals include frameTiming and clear interval quantities before recovery', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(0, {
    presentedFrames: 1,
    processingDuration: 99,
    expectedDisplayTime: 20,
    presentationTime: 10,
    mediaTime: 1,
  });
  fixture.emitFrame(400, {
    presentedFrames: 2,
    processingDuration: 99,
    expectedDisplayTime: 40,
    presentationTime: 20,
    mediaTime: 1.04,
  });
  fixture.setTime(400);
  fixture.sample();
  const normalDetail = fixture.events.at(-1).data.frameTiming;
  assert.equal(typeof normalDetail, 'object');
  for (const field of [
    'displayLeadMsMedian',
    'displayLeadMsMin',
    'mediaStepMsMedian',
    'mediaStepMsMax',
  ]) {
    assert.ok(typeof normalDetail[field] === 'number' || normalDetail[field] === '未提供');
  }
  assert.equal(normalDetail.displayLeadMsMedian, 15);
  assert.equal(normalDetail.displayLeadMsMin, 10);
  assert.equal(normalDetail.mediaStepMsMedian, 40);
  assert.equal(normalDetail.mediaStepMsMax, 40);

  fixture.video.readyState = 2;
  fixture.setTime(600);
  fixture.sample();
  const detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.maxFrameGapMs, 200);
  assert.equal(detail.processingMsMax, '未提供');
  assert.equal(detail.processingMsMedian, '未提供');
  assert.equal(detail.displayLeadMsMedian, '未提供');
  assert.equal(detail.displayLeadMsMin, '未提供');
  assert.equal(detail.mediaStepMsMedian, '未提供');
  assert.equal(detail.mediaStepMsMax, '未提供');
  fixture.recorder.destroy();
});

test('processing duration aggregation excludes missing values and computes the even median', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;

  fixture.emitFrame(0, { presentedFrames: 1, processingDuration: 0.004 });
  fixture.emitFrame(100, { presentedFrames: 2 });
  fixture.emitFrame(200, { presentedFrames: 3, processingDuration: 0.010 });
  fixture.emitFrame(300, { presentedFrames: 4, processingDuration: 0.006 });
  fixture.emitFrame(400, { presentedFrames: 5, processingDuration: 0.008 });
  fixture.video.readyState = 2;
  fixture.setTime(400);
  fixture.sample();
  const detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.processingMsMax, 10);
  assert.equal(detail.processingMsMedian, 7);
  fixture.recorder.destroy();
});

test('missing requestVideoFrameCallback degrades presented without blocking readyState diagnostics', () => {
  const fixture = mediaRecorderFixture({ supportsFrameCallback: false });
  fixture.recorder.start();
  fixture.events.length = 0;
  fixture.video.readyState = 2;
  fixture.setTime(1000);
  assert.doesNotThrow(() => fixture.sample());
  const data = fixture.events.at(-1).data;
  assert.equal(data.presented, '未提供');
  assert.equal(typeof data.frameTiming, 'object');
  assert.equal(data.frameTiming.presentedTotal, '未提供');
  fixture.recorder.destroy();
});

test('append diagnostics use cumulative count, latest success age, and one updateend interval', () => {
  const fixture = mediaRecorderFixture();
  fixture.recorder.start();
  fixture.events.length = 0;
  fixture.video.readyState = 2;
  fixture.setTime(100);
  fixture.sample();
  let detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.appends, '未提供');
  assert.equal(detail.lastAppendAgoMs, '未提供');
  assert.equal(detail.updateEndMsMax, '未提供');

  fixture.setShimDiagnostics({
    appends: 3,
    lastAppendAt: 900,
    updateEndMsMax: 37,
    updateEndAt: 800,
  });
  fixture.setTime(1000);
  fixture.sample();
  detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.appends, 3);
  assert.equal(detail.lastAppendAgoMs, 100);
  assert.equal(detail.updateEndMsMax, 37);

  fixture.setTime(2000);
  fixture.sample();
  detail = fixture.events.at(-1).data.frameTiming;
  assert.equal(detail.appends, 3);
  assert.equal(detail.lastAppendAgoMs, 1100);
  assert.equal(detail.updateEndMsMax, '未提供');
  fixture.recorder.destroy();
});

test('visibility records initial and changed states without copying state to media samples', () => {
  const fixture = mediaRecorderFixture({ visibilityState: 'visible' });
  fixture.recorder.start();
  const startup = fixture.events.find((event) => event.code === 'video.visibility_changed');
  assert.deepEqual(startup.data, { state: 'visible', previousState: '未提供' });

  fixture.documentObject.visibilityState = 'hidden';
  fixture.documentObject.emit('visibilitychange');
  const changed = fixture.events.at(-1);
  assert.equal(changed.code, 'video.visibility_changed');
  assert.deepEqual(changed.data, { state: 'hidden', previousState: 'visible' });
  const sample = fixture.events.find((event) => event.code === 'media.sample');
  assert.equal(Object.hasOwn(sample.data, 'state'), false);
  assert.equal(Object.hasOwn(sample.data, 'previousState'), false);
  fixture.recorder.destroy();
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
  assert.equal(MEDIA_EVENT_NAMES.includes('timeupdate'), false);
  assert.equal(EVENT_CODES.includes('media.timeupdate'), false);
  assert.equal(EVENT_CODES.includes('video.visibility_changed'), true);
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
  const persistedFailure = normalizeEventForStorage({
    sessionId: 'session-persist-code',
    sequence: 1,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: 0,
    code: 'log.persist.degraded',
    data: { status: 'DEGRADED', code: 'IDB_EVENT_WRITE_FAILED' },
  });
  assert.equal(persistedFailure.data.code, 'IDB_EVENT_WRITE_FAILED');
  assert.equal(
    sanitizeEventData('log.persist.degraded', { code: 'free text with secret' }).code,
    '未提供',
  );
});

test('frame timing survives its dedicated privacy sanitizer field by field', () => {
  const sanitized = sanitizeEventData('media.sample', {
    presented: 0,
    frameTiming: {
      presentedTotal: { value: 0, reportedBy: 'browser' },
      maxFrameGapMs: 601,
      maxFrameGapEndedAgoMs: 12,
      processingMsMax: 8.5,
      processingMsMedian: 4.25,
      appends: 17,
      lastAppendAgoMs: 33,
      updateEndMsMax: 6.75,
      displayLeadMsMedian: { value: 0, reportedBy: 'browser' },
      displayLeadMsMin: 2.5,
      mediaStepMsMedian: 4,
      mediaStepMsMax: Number.NaN,
    },
  });
  assert.equal(sanitized.presented, 0);
  assert.deepEqual(sanitized.frameTiming.presentedTotal, { value: 0, reportedBy: 'browser' });
  assert.equal(sanitized.frameTiming.maxFrameGapMs, 601);
  assert.equal(sanitized.frameTiming.maxFrameGapEndedAgoMs, 12);
  assert.equal(sanitized.frameTiming.processingMsMax, 8.5);
  assert.equal(sanitized.frameTiming.processingMsMedian, 4.25);
  assert.equal(sanitized.frameTiming.appends, 17);
  assert.equal(sanitized.frameTiming.lastAppendAgoMs, 33);
  assert.equal(sanitized.frameTiming.updateEndMsMax, 6.75);
  assert.deepEqual(sanitized.frameTiming.displayLeadMsMedian, { value: 0, reportedBy: 'browser' });
  assert.equal(sanitized.frameTiming.displayLeadMsMin, 2.5);
  assert.equal(sanitized.frameTiming.mediaStepMsMedian, 4);
  assert.equal(sanitized.frameTiming.mediaStepMsMax, '未提供');
});

test('legacy media records without the additive fields remain valid', () => {
  assert.doesNotThrow(() => normalizeEventForStorage({
    sessionId: 'legacy-media-session',
    sequence: 1,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: 0,
    code: 'media.sample',
    data: { eventType: 'sample', currentTime: 10 },
  }));
  assert.deepEqual(sanitizeEventData('media.sample', { eventType: 'sample' }), {
    eventType: 'sample',
  });
});

test('bank race diagnostic slot and ttfb fields survive allowlist sanitisation', () => {
  assert.deepEqual(sanitizeEventData('bank.fetch.chunk', {
    slot: 1,
    ttfbMs: 12.5,
    bytes: 16,
    result: 'fetched',
  }), {
    slot: 1,
    ttfbMs: 12.5,
    bytes: 16,
    result: 'fetched',
  });
  assert.deepEqual(sanitizeEventData('bank.fetch.chunk', {
    slot: 0,
    bytes: 0,
    result: 'aborted',
  }), {
    slot: 0,
    bytes: 0,
    result: 'aborted',
  });
});

test('CDN panel aggregates paired legs by source pathname and renders no media URL', async () => {
  const fixture = logsPageFixture();
  try {
    const logs = await fixture.importModule();
    assert.deepEqual(fixture.messages, []);
    const event = ({ source, mirror, slot, chunkIndex, start, result, bytes, ttfbMs }) => ({
      code: 'bank.fetch.chunk',
      data: {
        source,
        mirror,
        slot,
        chunkIndex,
        start,
        result,
        bytes,
        ...(ttfbMs === undefined ? {} : { ttfbMs }),
      },
    });
    const events = [
      event({
        source: 'https://cdn-a.example/media/seg.m4s?signature=secret-a',
        mirror: 'cdn-a.example',
        slot: 0,
        chunkIndex: 0,
        start: 0,
        result: 'fetched',
        bytes: 100,
        ttfbMs: 10,
      }),
      event({
        source: 'https://cdn-b.example/media/seg.m4s?signature=secret-b',
        mirror: 'cdn-b.example',
        slot: 1,
        chunkIndex: 0,
        start: 0,
        result: 'lost_race',
        bytes: 50,
        ttfbMs: 20,
      }),
      event({
        source: 'https://cdn-b.example/media/seg.m4s?signature=secret-c',
        mirror: 'cdn-b.example',
        slot: 1,
        chunkIndex: 1,
        start: 16,
        result: 'lost_race',
        bytes: 20,
        ttfbMs: 40,
      }),
      event({
        source: 'https://cdn-a.example/media/seg.m4s?signature=secret-d',
        mirror: 'cdn-a.example',
        slot: 0,
        chunkIndex: 1,
        start: 16,
        result: 'fetched',
        bytes: 80,
        ttfbMs: 30,
      }),
      event({
        source: 'https://cdn-a.example/media/seg.m4s?signature=secret-e',
        mirror: 'cdn-a.example',
        slot: 0,
        chunkIndex: 2,
        start: 32,
        result: 'stalled',
        bytes: 0,
      }),
      event({
        source: 'https://cdn-c.example/media/seg.m4s?signature=secret-f',
        mirror: 'cdn-c.example',
        slot: 1,
        chunkIndex: 2,
        start: 32,
        result: 'fetched',
        bytes: 60,
        ttfbMs: 50,
      }),
      event({
        source: 'https://cdn-single.example/media/other.m4s?signature=secret-g',
        mirror: 'cdn-single.example',
        slot: 0,
        chunkIndex: 3,
        start: 48,
        result: 'fetched',
        bytes: 70,
        ttfbMs: 5,
      }),
    ];
    const summary = logs.aggregateCdnEvents(events);
    assert.equal(summary.totalChunks, 4);
    assert.equal(summary.pairedChunks, 3);
    assert.equal(summary.pairCoverage, 0.75);
    assert.equal(summary.wastedByteRatio, 70 / 310);
    assert.deepEqual(summary.byResult, {
      fetched: 4,
      lost_race: 2,
      stalled: 1,
      aborted: 0,
      superseded: 0,
      network_error: 0,
      http_error: 0,
      invalid_response: 0,
      gave_up: 0,
    });
    assert.deepEqual(summary.rows, [
      {
        mirror: 'cdn-a.example',
        racesEntered: 3,
        wins: 2,
        winRate: 2 / 3,
        ttfbP50: 20,
        ttfbP90: 28,
        stalled: 1,
        bytesDelivered: 180,
      },
      {
        mirror: 'cdn-b.example',
        racesEntered: 2,
        wins: 0,
        winRate: 0,
        ttfbP50: 30,
        ttfbP90: 38,
        stalled: 0,
        bytesDelivered: 0,
      },
      {
        mirror: 'cdn-c.example',
        racesEntered: 1,
        wins: 1,
        winRate: 1,
        ttfbP50: 50,
        ttfbP90: 50,
        stalled: 0,
        bytesDelivered: 60,
      },
      {
        mirror: 'cdn-single.example',
        racesEntered: 0,
        wins: 0,
        winRate: 0,
        ttfbP50: 5,
        ttfbP90: 5,
        stalled: 0,
        bytesDelivered: 70,
      },
    ]);

    const summaryElement = fixture.elements.get('[data-cdn-summary]');
    const rowsElement = fixture.elements.get('[data-cdn-rows]');
    logs.renderCdnPanel(summary, summaryElement, rowsElement);
    const rendered = [summaryElement.textContent, ...rowsElement.children.flatMap(
      (row) => row.children.map((cell) => cell.textContent),
    )].join(' ');
    assert.match(rendered, /cdn-a\.example/);
    assert.doesNotMatch(rendered, /https?:\/\/|signature=secret/);

    fixture.elements.get('[data-session-filter]').value = 'session-cdn';
    globalThis.chrome.runtime.sendMessage = async (message) => {
      fixture.messages.push(message);
      assert.equal(message.type, 'logs:cdn-summary');
      return { ok: true, maxEventId: 7, sampleCount: events.length, summary };
    };
    await fixture.elements.get('[data-cdn-refresh]').listeners.get('click')();
    assert.deepEqual(fixture.messages.map(({ type, sessionId }) => ({ type, sessionId })), [
      { type: 'logs:cdn-summary', sessionId: 'session-cdn' },
    ]);
    assert.equal(fixture.messages.some((message) => message.type === 'diagnostic:events'), false);
  } finally {
    fixture.restore();
  }
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
          sourceBufferRanges: [{
            mediaSourceInstance: 2,
            sourceBufferInstance: 1,
            mediaSourceState: 'open',
            track: 'video',
            ranges: [{ start: 0, end: 80 }],
            updating: false,
            pendingSinceMs: null,
            appends: 17,
            appendErrors: { QuotaExceededError: 2 },
          }],
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
  assert.deepEqual(sanitized.sourceBufferRanges, [{
    mediaSourceInstance: 2,
    sourceBufferInstance: 1,
    mediaSourceState: 'open',
    track: 'video',
    ranges: [{ start: 0, end: 80 }],
    updating: false,
    pendingSinceMs: null,
    appends: 17,
    appendErrors: { QuotaExceededError: 2 },
  }]);
  assert.equal(sanitized.mediaSourceState, 'open');
  assert.deepEqual(sanitized.appendErrors, { QuotaExceededError: 2 });
  assert.deepEqual(sanitized.removeStats, { removeCalls: 7 });
});

test('media.append fields pass through privacy normalization and discard unknown fields', () => {
  const data = {
    mediaSourceInstance: 2,
    sourceBufferInstance: 1,
    appendSequence: 3,
    track: 'video/mp4',
    bytes: 128,
    bufferedBefore: [{ start: 0, end: 80 }],
    bufferedAfter: [{ start: 0, end: 90 }],
    durationMs: 12.5,
    result: 'ok',
    secretField: 'removed',
  };
  const sanitized = sanitizeEventData('media.append', data);
  assert.deepEqual(sanitized, {
    mediaSourceInstance: 2,
    sourceBufferInstance: 1,
    appendSequence: 3,
    track: 'video/mp4',
    bytes: 128,
    bufferedBefore: [{ start: 0, end: 80 }],
    bufferedAfter: [{ start: 0, end: 90 }],
    durationMs: 12.5,
    result: 'ok',
  });
  const persisted = normalizeEventForStorage({
    sessionId: 'media-append-session',
    sequence: 1,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: 0,
    code: 'media.append',
    data,
  });
  assert.deepEqual(persisted.data, sanitized);
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
  assert.equal(
    sent.flatMap((message) => message.events).some((event) => event.code === 'log.persist.result'),
    false,
  );
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

test('diagnostic persistence retries the failed head with bounded backoff without reordering batches', async () => {
  const sent = [];
  const timers = [];
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVretry',
  };
  const windowObject = {
    location: locationObject,
    setTimeout(callback, milliseconds) {
      const timer = { milliseconds, cleared: false, fired: false };
      timer.callback = () => {
        timer.fired = true;
        callback();
      };
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
        if (sent.length === 1) {
          callback({ ok: false, error: { code: 'IDB_EVENT_WRITE_FAILED', message: 'synthetic failure' } });
          return;
        }
        callback({ ok: true, status: 'PERSISTED', eventCount: message.events.length });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  await client.flush();
  client.log('route.changed', { reason: 'spa_media_change' });
  const retryTimer = timers.find((timer) => timer.milliseconds === 100 && timer.cleared === false);
  assert.notEqual(retryTimer, undefined);
  retryTimer.callback();
  await tick();
  await client.flush();
  assert.deepEqual(sent.slice(0, 2).map((message) => message.events.map((event) => event.sequence)), [[1], [1]]);
  assert.deepEqual(sent.slice(2).flatMap((message) => message.events.map((event) => event.sequence)), [2, 3]);
  assert.ok(sent.slice(2).every((message) => message.events[0].sequence >= 2));
  const degradedEvent = sent.slice(2).flatMap((message) => message.events)
    .find((event) => event.code === 'log.persist.degraded');
  assert.equal(degradedEvent.data.code, 'IDB_EVENT_WRITE_FAILED');
  assert.equal(client.outbox.length, 0);
  client.destroy();
});

test('diagnostic persistence stops automatic retries at the bound and keeps the failed head', async () => {
  const timers = [];
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVretry-cap',
  };
  const windowObject = {
    location: locationObject,
    setTimeout(callback, milliseconds) {
      const timer = { milliseconds, cleared: false, fired: false };
      timer.callback = () => {
        timer.fired = true;
        callback();
      };
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
        callback({ ok: false, error: { code: 'IDB_EVENT_WRITE_FAILED', message: 'synthetic failure' } });
      },
    },
    locationObject,
    loggerObject: { log() {}, warn() {}, error() {} },
  });
  await client.flush();
  for (const delay of [100, 200, 400, 800, 1600]) {
    const retryTimer = timers.find((timer) => timer.milliseconds === delay
      && timer.cleared === false && timer.fired === false);
    assert.notEqual(retryTimer, undefined);
    retryTimer.callback();
    await tick();
  }
  assert.equal(client.outbox.length, 1);
  assert.equal(client.outbox[0].batch[0].sequence, 1);
  assert.equal(timers.some((timer) => timer.milliseconds > 0 && timer.milliseconds <= 5000
    && timer.cleared === false && timer.fired === false), false);
  client.log('route.changed', { reason: 'next_event_retries_head' });
  await client.flush();
  assert.equal(client.outbox.length, 2);
  assert.equal(client.outbox[0].batch[0].sequence, 1);
  assert.equal(timers.some((timer) => timer.milliseconds > 0 && timer.milliseconds <= 5000
    && timer.cleared === false && timer.fired === false), false);
  client.destroy();
});

test('diagnostics does not install a resource observer or emit resource observations', async () => {
  const sent = [];
  let observerCreated = false;
  class FakePerformanceObserver {
    constructor() {
      observerCreated = true;
    }
  }
  const locationObject = {
    origin: 'https://www.bilibili.com',
    hostname: 'www.bilibili.com',
    pathname: '/video/BVresource-removed',
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
  await client.flush();
  assert.equal(observerCreated, false);
  assert.equal(sent.flatMap((message) => message.events).some(
    (event) => event.code === 'resource.observed',
  ), false);
  client.destroy();
});
