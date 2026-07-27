import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  SHIM_DIAGNOSTIC_ATTRIBUTE,
  SHIM_OBSERVATION_ATTRIBUTE,
} from '../src/extension/bridge-contract.js';

const globalNames = ['document', 'window', 'MediaSource', 'SourceBuffer'];
const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const diagnosticPublishes = [];
const observationPublishes = [];
const timers = new Map();
let nextTimerId = 0;
let currentTimeMilliseconds = 0;
let querySelectorAllCalls = 0;

function advanceTime(milliseconds) {
  currentTimeMilliseconds += milliseconds;
  while (true) {
    const dueTimers = [...timers.values()]
      .filter((timer) => timer.dueAt <= currentTimeMilliseconds)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
    if (dueTimers.length === 0) return;
    const timer = dueTimers[0];
    timers.delete(timer.id);
    timer.callback();
  }
}

class FakeSourceBuffer {
  constructor() {
    this.listeners = new Map();
    this.range = [0, 100];
    this.removeCalls = [];
    this.buffered = {
      length: 1,
      start: () => this.range[0],
      end: () => this.range[1],
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }

  appendBuffer() {}

  remove(start, end) {
    this.removeCalls.push([start, end]);
    return 'original-remove';
  }
}

class FakeMediaSource {
  constructor() {
    this.listeners = new Map();
    this.sourceBuffers = [];
    this.readyState = 'open';
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  addSourceBuffer() {
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }
}

const video = { currentTime: 100 };
const documentElement = {
  setAttribute(name, value) {
    if (name === SHIM_DIAGNOSTIC_ATTRIBUTE) diagnosticPublishes.push(JSON.parse(value));
    if (name === SHIM_OBSERVATION_ATTRIBUTE) observationPublishes.push(JSON.parse(value));
  },
};
const documentObject = {
  documentElement,
  querySelectorAll(selector) {
    querySelectorAllCalls += 1;
    if (selector === 'video') return [video];
    if (selector === 'iframe') return [];
    throw new Error(`unexpected selector ${selector}`);
  },
};
const windowObject = {
  performance: { now: () => currentTimeMilliseconds },
  setTimeout(callback, milliseconds) {
    const timer = { id: ++nextTimerId, callback, dueAt: currentTimeMilliseconds + milliseconds };
    timers.set(timer.id, timer);
    return timer.id;
  },
  clearTimeout(timerId) {
    timers.delete(timerId);
  },
  location: { hostname: 'live.bilibili.com' },
};
windowObject.top = windowObject;
windowObject.parent = windowObject;

globalThis.document = documentObject;
globalThis.window = windowObject;
globalThis.MediaSource = FakeMediaSource;
globalThis.SourceBuffer = FakeSourceBuffer;
const shimUrl = new URL('../src/extension/source-buffer-shim.js', import.meta.url);
await import(`${shimUrl.href}?unit-test=${Date.now()}`);

after(() => {
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

test('updateend diagnostics publish at most once per second and trail the latest state', () => {
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  diagnosticPublishes.length = 0;

  for (const [milliseconds, end] of [[100, 101], [200, 102], [300, 103], [400, 104]]) {
    currentTimeMilliseconds = milliseconds;
    sourceBuffer.range[1] = end;
    sourceBuffer.dispatchEvent({ type: 'updateend' });
  }
  assert.equal(diagnosticPublishes.length, 0);

  advanceTime(600);
  assert.equal(diagnosticPublishes.length, 1);
  assert.equal(diagnosticPublishes[0].sourceBufferRanges[0].ranges[0].end, 104);
  assert.equal(timers.size, 0);
});

test('an intercepted remove publishes diagnostics exactly once', () => {
  windowObject.location.hostname = 'live.bilibili.com';
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  diagnosticPublishes.length = 0;
  observationPublishes.length = 0;
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };

  assert.equal(sourceBuffer.remove(60, 90), 'original-remove');
  assert.equal(diagnosticPublishes.length, 1);
  assert.deepEqual(sourceBuffer.removeCalls, [[60, 70]]);
  assert.deepEqual(diagnosticPublishes[0].removeStats, {
    removeCalls: statsBefore.removeCalls + 1,
    intercepted: statsBefore.intercepted + 1,
  });
  assert.deepEqual(observationPublishes, [{
    reason: 'truncated',
    targetTime: 70,
    currentTime: 100,
    retainSeconds: 30,
    originalEnd: 90,
  }]);
});

test('video-host remove forwards the exact arguments without synthetic updateend', async () => {
  windowObject.location.hostname = 'www.bilibili.com';
  querySelectorAllCalls = 0;
  observationPublishes.length = 0;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  let updateEndDispatches = 0;
  sourceBuffer.addEventListener('updateend', () => {
    updateEndDispatches += 1;
  });
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };

  assert.equal(sourceBuffer.remove(80.25, 90.75), 'original-remove');
  assert.deepEqual(sourceBuffer.removeCalls, [[80.25, 90.75]]);
  assert.equal(querySelectorAllCalls, 0);
  assert.deepEqual(observationPublishes, []);
  assert.deepEqual(windowObject.__smoothBufferShim.stats, {
    ...statsBefore,
    removeCalls: statsBefore.removeCalls + 1,
  });

  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(updateEndDispatches, 0);
});

test('video-host remove forwards the interval that live retention would skip', async () => {
  windowObject.location.hostname = 'www.bilibili.com';
  querySelectorAllCalls = 0;
  observationPublishes.length = 0;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  let updateEndDispatches = 0;
  sourceBuffer.addEventListener('updateend', () => {
    updateEndDispatches += 1;
  });
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };

  assert.equal(sourceBuffer.remove(80, 90), 'original-remove');
  assert.deepEqual(sourceBuffer.removeCalls, [[80, 90]]);
  assert.equal(querySelectorAllCalls, 0);
  assert.deepEqual(observationPublishes, []);
  assert.equal(windowObject.__smoothBufferShim.stats.removeCalls, statsBefore.removeCalls + 1);
  assert.equal(windowObject.__smoothBufferShim.stats.intercepted, statsBefore.intercepted);

  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(updateEndDispatches, 0);
});

test('live-host remove passes through intervals before the retention floor', () => {
  windowObject.location.hostname = 'live.bilibili.com';
  querySelectorAllCalls = 0;
  observationPublishes.length = 0;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };

  assert.equal(sourceBuffer.remove(0, 60), 'original-remove');
  assert.deepEqual(sourceBuffer.removeCalls, [[0, 60]]);
  assert.deepEqual(observationPublishes, []);
  assert.equal(querySelectorAllCalls, 2);
  assert.equal(windowObject.__smoothBufferShim.stats.removeCalls, statsBefore.removeCalls + 1);
  assert.equal(windowObject.__smoothBufferShim.stats.intercepted, statsBefore.intercepted);
});

test('live-host remove skips intervals inside the retention window and synthesizes updateend', async () => {
  windowObject.location.hostname = 'live.bilibili.com';
  observationPublishes.length = 0;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  let updateEndDispatches = 0;
  sourceBuffer.addEventListener('updateend', () => {
    updateEndDispatches += 1;
  });
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };

  assert.equal(sourceBuffer.remove(80, 90), undefined);
  assert.deepEqual(sourceBuffer.removeCalls, []);
  assert.deepEqual(observationPublishes, [{
    reason: 'skipped',
    currentTime: 100,
    retainSeconds: 30,
    originalEnd: 90,
  }]);
  assert.equal(windowObject.__smoothBufferShim.stats.removeCalls, statsBefore.removeCalls + 1);
  assert.equal(windowObject.__smoothBufferShim.stats.intercepted, statsBefore.intercepted + 1);

  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(updateEndDispatches, 1);
});
