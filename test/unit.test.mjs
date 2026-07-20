import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_CONFIG, VOD_CONFIG } from '../src/constants.js';
import { serializeError } from '../src/extension/bridge-contract.js';
import { LiveObserver } from '../src/live/observer.js';
import { computeForwardInventory } from '../src/vod/buffer.js';
import { VodBufferController } from '../src/vod/controller.js';
import { DiagnosticsClient } from '../src/diagnostics/client.js';
import { MEDIA_EVENT_NAMES, EVENT_CODES } from '../src/diagnostics/catalog.js';
import { browserMetric, sanitizeEventData, scrubUrl } from '../src/diagnostics/privacy.js';

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

function runtimeWithIntervals() {
  const callbacks = [];
  return {
    performance: { now: () => 1000 },
    setInterval(callback) {
      callbacks.push(callback);
      return callback;
    },
    clearInterval() {},
    callbacks,
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

test('native live observer does not touch playback before a genuine post-frame stall', async () => {
  const video = mediaVideo('https://media.example/live-1');
  const documentObject = eventDocument(video);
  const runtimeObject = runtimeWithIntervals();
  const diagnostics = diagnosticsRecorder();
  let capabilityChecks = 0;
  let disableCalls = 0;
  const observer = new LiveObserver({
    documentObject,
    windowObject: {},
    runtimeObject,
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics,
    pageAdapter: {
      refreshLiveCapabilities() {
        capabilityChecks += 1;
        return Promise.resolve({
          supportsDisableAutoCatchup: () => false,
          disableAutoCatchup: async () => { disableCalls += 1; },
        });
      },
    },
    config: { ...LIVE_CONFIG, noDecodedFrameStallMilliseconds: 2000 },
  });
  observer.start();
  video.emit('waiting');
  assert.equal(capabilityChecks, 0);
  assert.equal(video.playCalls, 0);
  assert.equal(video.pauseCalls, 0);
  assert.deepEqual(video.assignments, []);

  video.emit('loadeddata');
  video.emit('waiting');
  await tick();
  assert.equal(capabilityChecks, 1);
  assert.equal(disableCalls, 0);
  assert.equal(video.playCalls, 0);
  assert.equal(video.pauseCalls, 0);
  assert.deepEqual(video.assignments, []);
  assert.ok(diagnostics.events.some((event) => event.code === 'live.stall.detected'));

  video.assignments.length = 0;
  video.currentTime = 80;
  video.emit('seeking');
  assert.deepEqual(video.assignments, [80, 10]);
  observer.destroy();
});

test('a normal video without requestVideoFrameCallback does not arm a no-frame stall', () => {
  const video = mediaVideo('https://media.example/live-no-rvfc');
  const documentObject = eventDocument(video);
  let milliseconds = 0;
  const runtimeObject = {
    performance: { now: () => milliseconds },
    setInterval() { return 1; },
    clearInterval() {},
  };
  let capabilityChecks = 0;
  const observer = new LiveObserver({
    documentObject,
    windowObject: {},
    runtimeObject,
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics: diagnosticsRecorder(),
    pageAdapter: {
      refreshLiveCapabilities() {
        capabilityChecks += 1;
        return Promise.resolve({ supportsDisableAutoCatchup: () => false });
      },
    },
    config: { ...LIVE_CONFIG, noDecodedFrameStallMilliseconds: 2000 },
  });
  observer.start();
  video.emit('loadeddata');
  milliseconds = 3000;
  observer.sample();
  assert.equal(observer.activeStall, undefined);
  assert.equal(capabilityChecks, 0);
  assert.deepEqual(video.assignments, []);
  observer.destroy();
});

test('a trusted user seek cancels live protection and suppresses pre-first-frame rearming', async () => {
  const video = mediaVideo('https://media.example/live-2');
  const documentObject = eventDocument(video);
  const runtimeObject = runtimeWithIntervals();
  const observer = new LiveObserver({
    documentObject,
    windowObject: {},
    runtimeObject,
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics: diagnosticsRecorder(),
    pageAdapter: { refreshLiveCapabilities: async () => ({ supportsDisableAutoCatchup: () => false }) },
  });
  observer.start();
  video.emit('loadeddata');
  video.emit('waiting');
  documentObject.emit('pointerdown', { isTrusted: true });
  video.currentTime = 70;
  video.emit('seeking');
  video.emit('waiting');
  assert.equal(observer.activeStall, undefined);
  assert.equal(observer.awaitingUserSeekFrame, true);
  video.emit('loadeddata');
  assert.equal(observer.awaitingUserSeekFrame, false);
  observer.destroy();
});

test('live source replacement corrects only active protection and preserves the target when possible', () => {
  const video = mediaVideo('https://media.example/live-3');
  const documentObject = eventDocument(video);
  const observer = new LiveObserver({
    documentObject,
    windowObject: {},
    runtimeObject: runtimeWithIntervals(),
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics: diagnosticsRecorder(),
    pageAdapter: { refreshLiveCapabilities: async () => ({ supportsDisableAutoCatchup: () => false }) },
  });
  observer.start();
  video.emit('loadeddata');
  video.emit('waiting');
  video.assignments.length = 0;
  video.currentSrc = 'https://media.example/live-4';
  video.src = video.currentSrc;
  video.currentTime = 90;
  observer.sample();
  assert.deepEqual(video.assignments, [90, 10]);

  const normal = mediaVideo('https://media.example/live-5');
  const normalObserver = new LiveObserver({
    documentObject: eventDocument(normal),
    windowObject: {},
    runtimeObject: runtimeWithIntervals(),
    initialVideo: normal,
    panel: { setModel() {} },
    diagnostics: diagnosticsRecorder(),
    pageAdapter: { refreshLiveCapabilities: async () => ({ supportsDisableAutoCatchup: () => false }) },
  });
  normalObserver.start();
  normal.assignments.length = 0;
  normal.currentSrc = 'https://media.example/live-6';
  normal.src = normal.currentSrc;
  normalObserver.sample();
  assert.deepEqual(normal.assignments, []);
  observer.destroy();
  normalObserver.destroy();
});

test('live visual cover appears only for an active-stall media gap', () => {
  const video = mediaVideo('https://media.example/live-cover-old');
  const observer = new LiveObserver({
    documentObject: eventDocument(video),
    windowObject: {},
    runtimeObject: runtimeWithIntervals(),
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics: diagnosticsRecorder(),
    pageAdapter: { refreshLiveCapabilities: async () => ({ supportsDisableAutoCatchup: () => false }) },
  });
  observer.start();
  video.emit('loadeddata');
  video.emit('waiting');
  assert.notEqual(observer.activeStall, undefined);

  let coverCalls = 0;
  observer.showOverlay = () => { coverCalls += 1; };
  video.currentSrc = 'https://media.example/live-cover-new';
  video.src = video.currentSrc;
  observer.sample();
  assert.equal(coverCalls, 0);

  video.currentSrc = '';
  video.src = '';
  observer.sample();
  assert.equal(coverCalls, 1);
  video.emit('emptied');
  assert.equal(coverCalls, 2);

  observer.bindVideo(mediaVideo('https://media.example/live-cover-replacement'));
  assert.equal(coverCalls, 3);
  observer.destroy();
});

test('live replacement rebases an unavailable protected time and skips cleared sources', () => {
  const video = mediaVideo('https://media.example/live-rebase-old');
  const diagnostics = diagnosticsRecorder();
  const observer = new LiveObserver({
    documentObject: eventDocument(video),
    windowObject: {},
    runtimeObject: runtimeWithIntervals(),
    initialVideo: video,
    panel: { setModel() {} },
    diagnostics,
    pageAdapter: { refreshLiveCapabilities: async () => ({ supportsDisableAutoCatchup: () => false }) },
  });
  observer.start();
  video.emit('loadeddata');
  video.emit('waiting');
  video.seekable = ranges([[100, 120]]);
  video.currentSrc = 'https://media.example/live-rebase-new';
  video.src = video.currentSrc;
  video.assignments.length = 0;
  video.currentTime = 115;
  observer.sample();
  assert.deepEqual(video.assignments, [115, 100]);
  assert.equal(observer.activeStall.protectedTime, 100);
  assert.equal(
    diagnostics.events.find((event) => event.code === 'live.delay.corrected').data.currentTime,
    115,
  );

  video.seekable = ranges([[50, 120]]);
  video.assignments.length = 0;
  video.currentTime = 115;
  video.emit('seeking');
  assert.deepEqual(video.assignments, [115, 100]);

  video.currentSrc = '';
  video.src = '';
  video.currentTime = 110;
  video.assignments.length = 0;
  observer.sample();
  assert.deepEqual(video.assignments, []);
  observer.destroy();
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
    roomId: '123?secret=1',
  }), {
    origin: 'https://www.example.test',
    pathname: '/video/BVprivacy',
    bvid: 'BVprivacy',
    roomId: '123',
  });
});

test('bridge error serialization keeps stack and a bounded circular cause chain', () => {
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
