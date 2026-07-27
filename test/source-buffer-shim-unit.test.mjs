import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SHIM_DIAGNOSTIC_ATTRIBUTE } from '../src/extension/bridge-contract.js';

const globalNames = ['document', 'window', 'MediaSource', 'SourceBuffer'];
const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const diagnosticPublishes = [];
const timers = new Map();
let nextTimerId = 0;
let currentTimeMilliseconds = 0;

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

const documentElement = {
  setAttribute(name, value) {
    if (name === SHIM_DIAGNOSTIC_ATTRIBUTE) diagnosticPublishes.push(JSON.parse(value));
  },
};
const documentObject = { documentElement };
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
  assert.equal(typeof diagnosticPublishes[0].removeStats.removeCalls, 'number');
  assert.equal(Object.hasOwn(diagnosticPublishes[0].removeStats, 'intercepted'), false);
  assert.equal(timers.size, 0);
});

test('remove forwards exact arguments and only records the native call', () => {
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  const statsBefore = { ...windowObject.__smoothBufferShim.stats };
  let updateEndDispatches = 0;
  sourceBuffer.addEventListener('updateend', () => {
    updateEndDispatches += 1;
  });

  assert.equal(sourceBuffer.remove(80.25, 90.75), 'original-remove');
  assert.deepEqual(sourceBuffer.removeCalls, [[80.25, 90.75]]);
  assert.deepEqual(windowObject.__smoothBufferShim.stats, {
    removeCalls: statsBefore.removeCalls + 1,
  });
  assert.equal(updateEndDispatches, 0);
});
