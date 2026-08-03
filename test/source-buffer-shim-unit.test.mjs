import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SHIM_APPEND_EVENT, SHIM_DIAGNOSTIC_ATTRIBUTE } from '../src/extension/bridge-contract.js';

const globalNames = ['document', 'window', 'MediaSource', 'SourceBuffer', 'CustomEvent'];
const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const diagnosticPublishes = [];
const shimAppendEvents = [];
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

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }

  appendBuffer() {
    if (this.appendError !== undefined) {
      const error = this.appendError;
      this.appendError = undefined;
      throw error;
    }
  }

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

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
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
class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init.detail;
  }
}
const documentListeners = new Map();
const documentObject = {
  documentElement,
  defaultView: { CustomEvent: FakeCustomEvent },
  addEventListener(name, listener) {
    const listeners = documentListeners.get(name) || new Set();
    listeners.add(listener);
    documentListeners.set(name, listeners);
  },
  removeEventListener(name, listener) {
    documentListeners.get(name)?.delete(listener);
  },
  dispatchEvent(event) {
    if (event.type === SHIM_APPEND_EVENT) shimAppendEvents.push(JSON.parse(event.detail));
    for (const listener of documentListeners.get(event.type) || []) listener(event);
    return true;
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
};
windowObject.top = windowObject;
windowObject.parent = windowObject;

globalThis.document = documentObject;
globalThis.window = windowObject;
globalThis.MediaSource = FakeMediaSource;
globalThis.SourceBuffer = FakeSourceBuffer;
globalThis.CustomEvent = FakeCustomEvent;
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

test('append diagnostics count calls and measure their updateend', () => {
  const mediaSource = new FakeMediaSource();
  currentTimeMilliseconds = 10000;
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  diagnosticPublishes.length = 0;
  shimAppendEvents.length = 0;

  sourceBuffer.appendBuffer(new Uint8Array([1]));
  currentTimeMilliseconds = 10040;
  sourceBuffer.dispatchEvent({ type: 'updateend' });
  advanceTime(960);

  const published = diagnosticPublishes.at(-1);
  assert.equal(published.appends, 1);
  assert.equal(published.lastAppendAt, 10000);
  assert.equal(published.updateEndMsMax, 40);
  assert.equal(published.updateEndAt, 10040);
  assert.equal(shimAppendEvents.length, 1);
  assert.equal(shimAppendEvents[0].result, 'ok');

  currentTimeMilliseconds = 12000;
  sourceBuffer.appendError = Object.assign(new Error('buffer full'), { name: 'QuotaExceededError' });
  assert.throws(() => sourceBuffer.appendBuffer(new Uint8Array([2])), /buffer full/);
  const failedPublish = diagnosticPublishes.at(-1);
  assert.equal(failedPublish.appends, 2);
  assert.equal(failedPublish.lastAppendAt, 12000);
  assert.deepEqual(failedPublish.appendErrors, { QuotaExceededError: 1 });
  assert.equal(shimAppendEvents.length, 2);
  assert.equal(shimAppendEvents[1].result, 'throw');
});

test('successful append diagnostics publish before its updateend arrives', () => {
  const mediaSource = new FakeMediaSource();
  currentTimeMilliseconds = 14000;
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  const appendsBefore = diagnosticPublishes.at(-1).appends;
  diagnosticPublishes.length = 0;

  sourceBuffer.appendBuffer(new Uint8Array([1]));
  advanceTime(1000);

  const published = diagnosticPublishes.at(-1);
  assert.equal(published.appends, appendsBefore + 1);
  assert.equal(published.lastAppendAt, 14000);
  assert.equal(published.updateEndMsMax, null);
});

test('two live MediaSources publish independent track attribution and counters', () => {
  currentTimeMilliseconds = 20000;
  const firstSource = new FakeMediaSource();
  const firstVideo = firstSource.addSourceBuffer('video/mp4');
  const firstAudio = firstSource.addSourceBuffer('audio/mp4');
  const secondSource = new FakeMediaSource();
  secondSource.readyState = 'closed';
  const secondVideo = secondSource.addSourceBuffer('video/mp4');
  diagnosticPublishes.length = 0;

  firstVideo.appendBuffer(new Uint8Array([1]));
  secondVideo.appendBuffer(new Uint8Array([1, 2]));
  currentTimeMilliseconds = 20010;
  firstVideo.dispatchEvent({ type: 'updateend' });
  secondVideo.dispatchEvent({ type: 'updateend' });
  advanceTime(990);

  const published = diagnosticPublishes.at(-1);
  const latestMediaSourceInstance = Math.max(
    ...published.sourceBufferRanges.map(({ mediaSourceInstance }) => mediaSourceInstance),
  );
  const firstEntries = published.sourceBufferRanges.filter(
    ({ mediaSourceInstance }) => mediaSourceInstance === latestMediaSourceInstance - 1,
  );
  const secondEntries = published.sourceBufferRanges.filter(
    ({ mediaSourceInstance }) => mediaSourceInstance === latestMediaSourceInstance,
  );
  assert.equal(firstEntries.length, 2);
  assert.equal(secondEntries.length, 1);
  assert.equal(firstEntries.find(({ sourceBufferInstance }) => sourceBufferInstance === 1).appends, 1);
  assert.equal(firstEntries.find(({ sourceBufferInstance }) => sourceBufferInstance === 2).appends, 0);
  assert.equal(secondEntries[0].appends, 1);
  assert.equal(firstEntries[0].mediaSourceState, 'open');
  assert.equal(secondEntries[0].mediaSourceState, 'closed');
  assert.equal(published.mediaSourceState, 'open');
});

test('a settled append emits exact attribution with bytes and buffered boundaries', () => {
  currentTimeMilliseconds = 22000;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  sourceBuffer.range = [0, 10];
  shimAppendEvents.length = 0;

  sourceBuffer.appendBuffer(new Uint8Array([1, 2, 3]));
  assert.equal(shimAppendEvents.length, 0);
  currentTimeMilliseconds = 22025;
  sourceBuffer.range[1] = 12;
  sourceBuffer.dispatchEvent({ type: 'updateend' });

  assert.equal(shimAppendEvents.length, 1);
  const event = shimAppendEvents[0];
  assert.deepEqual(Object.keys(event).sort(), [
    'appendSequence',
    'bufferedAfter',
    'bufferedBefore',
    'bytes',
    'durationMs',
    'mediaSourceInstance',
    'result',
    'sourceBufferInstance',
    'track',
  ]);
  assert.equal(event.appendSequence, 1);
  assert.equal(event.track, 'video/mp4');
  assert.equal(event.bytes, 3);
  assert.deepEqual(event.bufferedBefore, [{ start: 0, end: 10 }]);
  assert.deepEqual(event.bufferedAfter, [{ start: 0, end: 12 }]);
  assert.equal(event.durationMs, 25);
  assert.equal(event.result, 'ok');
});

test('a synchronous append throw emits one failed append record', () => {
  currentTimeMilliseconds = 24000;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  sourceBuffer.appendError = Object.assign(new Error('buffer full'), { name: 'QuotaExceededError' });
  shimAppendEvents.length = 0;

  assert.throws(() => sourceBuffer.appendBuffer(new Uint8Array([1])), /buffer full/);
  assert.equal(shimAppendEvents.length, 1);
  assert.equal(shimAppendEvents[0].result, 'throw');
  assert.equal(shimAppendEvents[0].errorName, 'QuotaExceededError');
});

test('a SourceBuffer error event settles one failed append record', () => {
  currentTimeMilliseconds = 25000;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  shimAppendEvents.length = 0;

  sourceBuffer.appendBuffer(new Uint8Array([1]));
  currentTimeMilliseconds = 25008;
  sourceBuffer.dispatchEvent({ type: 'error', error: { name: 'DecodeError' } });
  sourceBuffer.dispatchEvent({ type: 'updateend' });

  assert.equal(shimAppendEvents.length, 1);
  assert.equal(shimAppendEvents[0].result, 'error_event');
  assert.equal(shimAppendEvents[0].errorName, 'DecodeError');
});

test('an unsettled append stays visible in the sampled snapshot without an append event', () => {
  currentTimeMilliseconds = 26000;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  shimAppendEvents.length = 0;

  sourceBuffer.appendBuffer(new Uint8Array([1]));
  currentTimeMilliseconds = 26037;
  advanceTime(1000);

  const latestMediaSourceInstance = Math.max(
    ...diagnosticPublishes.at(-1).sourceBufferRanges.map(({ mediaSourceInstance }) => mediaSourceInstance),
  );
  const entry = diagnosticPublishes.at(-1).sourceBufferRanges.find(
    ({ mediaSourceInstance }) => mediaSourceInstance === latestMediaSourceInstance,
  );
  assert.equal(entry.updating, true);
  assert.equal(Number.isFinite(entry.pendingSinceMs), true);
  assert.equal(shimAppendEvents.length, 0);
});

test('appendSequence stays monotonic on a SourceBuffer after MediaSource rebuild', () => {
  currentTimeMilliseconds = 28000;
  const firstSource = new FakeMediaSource();
  const firstBuffer = firstSource.addSourceBuffer('video/mp4');
  shimAppendEvents.length = 0;

  firstBuffer.appendBuffer(new Uint8Array([1]));
  currentTimeMilliseconds = 28001;
  firstBuffer.dispatchEvent({ type: 'updateend' });
  firstSource.readyState = 'closed';
  const secondSource = new FakeMediaSource();
  secondSource.addSourceBuffer('video/mp4');

  currentTimeMilliseconds = 28002;
  firstBuffer.appendBuffer(new Uint8Array([2]));
  currentTimeMilliseconds = 28003;
  firstBuffer.dispatchEvent({ type: 'updateend' });

  assert.equal(shimAppendEvents.length, 2);
  assert.equal(shimAppendEvents[0].appendSequence, 1);
  assert.equal(shimAppendEvents[1].appendSequence, 2);
});

test('an unreadable byteLength is recorded as the existing unknown sentinel', () => {
  currentTimeMilliseconds = 30000;
  const mediaSource = new FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4');
  const argument = {};
  Object.defineProperty(argument, 'byteLength', {
    get() {
      throw new Error('byte length unavailable');
    },
  });
  shimAppendEvents.length = 0;

  sourceBuffer.appendBuffer(argument);
  currentTimeMilliseconds = 30001;
  sourceBuffer.dispatchEvent({ type: 'updateend' });

  assert.equal(shimAppendEvents.length, 1);
  assert.equal(shimAppendEvents[0].bytes, '未提供');
});
