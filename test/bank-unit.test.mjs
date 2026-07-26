import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANK_CONFIG } from '../src/constants.js';
import {
  BANK_ENABLED_ATTRIBUTE,
  BANK_MESSAGE_TYPES,
} from '../src/bank/contract.js';
import {
  bankKey,
  cacheKey,
  classifyRequest,
  compareQueueTasks,
  estimateBitrate,
  parseContentRange,
  parseRangeHeader,
  partialResponseHeaders,
  prefetchRange,
  selectEvictions,
} from '../src/bank/logic.js';
import { BankNetworkError } from '../src/bank/errors.js';
import { SegmentBank } from '../src/bank/main.js';
import { postBankControl } from '../src/bank/relay.js';
import { createBankXMLHttpRequestClass } from '../src/bank/xhr.js';

const MEDIA_URL = 'https://upos-sz-mirrorcosov.bilivideo.com/video/track.m4s?deadline=secret&upsig=secret';
const MEDIA_KEY = '/video/track.m4s';

function responseFor(start, end, totalSize = 100, body = new Uint8Array(end - start + 1)) {
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(body.byteLength),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    },
  });
}

function windowFixture() {
  const listeners = new Map();
  const timers = new Set();
  return {
    location: new URL('https://www.bilibili.com/video/BVbank'),
    Response,
    Event,
    Blob,
    performance: { now: () => Date.now() },
    document: { querySelectorAll: () => [] },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
      clearTimeout(timer);
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(message, _origin, transfer) {
      for (const listener of listeners.get('message') || []) {
        listener({ source: this, data: message, transfer });
      }
    },
  };
}

function storeFixture({ read = { hit: false }, readError, write = {} } = {}) {
  const calls = { reads: [], writes: [] };
  return {
    calls,
    readRange(...args) {
      calls.reads.push(args);
      if (readError !== undefined) return Promise.reject(readError);
      return typeof read === 'function' ? read(...args) : Promise.resolve(read);
    },
    writeChunk(value) {
      calls.writes.push(value);
      return typeof write === 'function' ? write(value) : Promise.resolve(write);
    },
    destroy() {},
  };
}

function createBank({ store, nativeFetch, config = BANK_CONFIG, maxConcurrency = 3 } = {}) {
  const windowObject = windowFixture();
  const calls = [];
  const fetchFunction = nativeFetch || (async (url, init) => {
    calls.push({ url, init });
    return responseFor(0, 9, 100, new Uint8Array(10).map((_value, index) => index));
  });
  const bank = new SegmentBank({
    windowObject,
    nativeFetch: fetchFunction,
    storeClient: store || storeFixture(),
    config,
    maxConcurrency,
  });
  return { bank, windowObject, calls };
}

async function fetchThrough(bank, input = MEDIA_URL, init = { headers: { Range: 'bytes=0-9' } }, originalFetch) {
  return bank.handleFetch(
    bank.windowObject,
    [input, init],
    originalFetch || bank.nativeFetch,
  );
}

test('bank keys discard query and mirror host changes share the same path key', () => {
  assert.equal(bankKey(MEDIA_URL), MEDIA_KEY);
  assert.equal(bankKey('https://upos-hz-mirrorakam.akamaized.net/video/track.m4s?deadline=other'), MEDIA_KEY);
  assert.equal(cacheKey(MEDIA_KEY, 3), `${MEDIA_KEY}#3`);
});

test('closed single Range and video media hosts are the only intercepted shape', () => {
  const locationObject = new URL('https://www.bilibili.com/video/BVbank');
  assert.deepEqual(parseRangeHeader('bytes=4-9'), { start: 4, end: 9 });
  for (const value of ['bytes=4-', 'bytes=4-9,20-30', 'bytes=9-4', undefined]) {
    assert.equal(parseRangeHeader(value), undefined);
  }
  assert.deepEqual(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-9' },
    locationObject,
  }).range, { start: 4, end: 9 });
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-' },
    locationObject,
  }).reason, 'range_not_closed');
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: {},
    locationObject,
  }).reason, 'range_missing');
  assert.equal(classifyRequest({
    url: 'https://api.bilibili.com/video/track.m4s',
    headers: { Range: 'bytes=4-9' },
    locationObject,
  }).reason, 'non_media_host');
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-9' },
    enabled: false,
    locationObject,
  }).reason, 'disabled');
});

test('response range headers, content-range parser, and prefetch estimate are exact', () => {
  assert.deepEqual(partialResponseHeaders(4, 9, 100), {
    'Accept-Ranges': 'bytes',
    'Content-Length': '6',
    'Content-Range': 'bytes 4-9/100',
    'Content-Type': 'video/mp4',
  });
  assert.deepEqual(parseContentRange('bytes 4-9/100'), { start: 4, end: 9, totalSize: 100 });
  assert.equal(parseContentRange('bytes 4-9/*'), undefined);
  assert.equal(estimateBitrate([{ time: 1, bytes: 100 }, { time: 3, bytes: 300 }]), 100);
  assert.deepEqual(prefetchRange({ start: 10, bitrate: 2, aheadSeconds: 5, totalSize: 100 }), { start: 10, end: 19 });
  assert.equal(prefetchRange({ start: 100, bitrate: 2, aheadSeconds: 5, totalSize: 100 }), undefined);
});

test('hit returns exact bytes and canonical fetch response fields without network', async () => {
  const store = storeFixture({ read: { hit: true, totalSize: 100, bytes: new Uint8Array([4, 5, 6]).buffer } });
  const calls = [];
  const { bank } = createBank({ store, nativeFetch: async () => { calls.push('network'); return responseFor(0, 2); } });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.statusText, 'Partial Content');
  assert.equal(response.url, new URL(MEDIA_URL).href);
  assert.equal(response.type, 'basic');
  assert.equal(await response.arrayBuffer().then((bytes) => bytes.byteLength), 3);
  assert.equal(response.headers.get('Content-Range'), 'bytes 4-6/100');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual(calls, []);
});

test('miss delivers network bytes before asynchronous persistence resolves', async () => {
  let releaseWrite;
  const write = new Promise((resolve) => { releaseWrite = resolve; });
  const store = storeFixture({ write: () => write });
  const { bank } = createBank({
    store,
    nativeFetch: async () => responseFor(0, 9, 100, new Uint8Array(10)),
  });
  const response = await fetchThrough(bank);
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 10);
  assert.equal(store.calls.writes.length, 1);
  releaseWrite();
  await new Promise((resolve) => setImmediate(resolve));
});

test('a pending asynchronous write still serves the next identical request without another network fetch', async () => {
  let releaseWrite;
  let networkCalls = 0;
  const write = new Promise((resolve) => { releaseWrite = resolve; });
  const store = storeFixture({ write: () => write });
  const { bank, calls } = createBank({
    store,
    nativeFetch: async () => {
      networkCalls += 1;
      calls.push(networkCalls);
      return responseFor(0, 9, 100, new Uint8Array(10).fill(networkCalls));
    },
  });
  await fetchThrough(bank);
  const second = await fetchThrough(bank);
  assert.equal(networkCalls, 1);
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], Array(10).fill(1));
  releaseWrite();
});

test('partial coverage remains a miss and requests the original Range', async () => {
  const store = storeFixture({ read: { hit: false, totalSize: 100 } });
  const { bank, calls } = createBank({
    store,
    nativeFetch: async (url, init) => {
      calls.push({ url, init });
      return responseFor(4, 9, 100, new Uint8Array(6));
    },
  });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-9' } });
  assert.equal(response.status, 206);
  assert.equal(calls[0].init.headers.Range, 'bytes=4-9');
});

test('open, multi-range, no-range and non-media fetches are passed with original arguments', async () => {
  const { bank } = createBank({ store: storeFixture() });
  const input = new Request('https://api.bilibili.com/data', { method: 'POST', body: 'body' });
  const init = { credentials: 'include', headers: { 'X-Test': 'keep' } };
  let received;
  let bodyUsedAtEntry;
  const original = async (...args) => {
    received = args;
    bodyUsedAtEntry = input.bodyUsed;
    return args[0].text();
  };
  assert.equal(await fetchThrough(bank, input, init, original), 'body');
  assert.equal(bodyUsedAtEntry, false);
  assert.equal(received[0], input);
  assert.equal(received[1], init);
  const passthrough = async () => 'passed';
  assert.equal(await fetchThrough(bank, MEDIA_URL, {}, passthrough), 'passed');
  assert.equal(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-' } }, passthrough), 'passed');
  assert.equal(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-9,20-30' } }, passthrough), 'passed');
});

test('the binary relay channel excludes preference control and stores it in the DOM boundary', () => {
  const attributes = new Map();
  const windowObject = {
    document: {
      documentElement: {
        setAttribute(name, value) { attributes.set(name, value); },
      },
    },
  };
  postBankControl(windowObject, false);
  assert.equal(attributes.get(BANK_ENABLED_ATTRIBUTE), 'false');
  postBankControl(windowObject, true);
  assert.equal(attributes.get(BANK_ENABLED_ATTRIBUTE), 'true');
  assert.equal(BANK_MESSAGE_TYPES.includes('configure'), false);
});

test('store timeout becomes a network fetch', async () => {
  const store = storeFixture({ read: () => new Promise(() => {}) });
  const config = { ...BANK_CONFIG, storeReadTimeoutMs: 5 };
  const { bank } = createBank({ store, config, nativeFetch: async () => responseFor(0, 9) });
  const response = await fetchThrough(bank);
  assert.equal(response.status, 206);
});

test('wrong network byte length is not persisted and falls back once', async () => {
  const store = storeFixture();
  const { bank } = createBank({ store, nativeFetch: async () => responseFor(0, 9, 100, new Uint8Array(9)) });
  let fallbackCalls = 0;
  const fallback = async () => {
    fallbackCalls += 1;
    return new Response(new Uint8Array(0), { status: 416, statusText: 'Range Not Satisfiable' });
  };
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-9' } }, fallback);
  assert.equal(response.status, 416);
  assert.equal(fallbackCalls, 1);
  assert.equal(store.calls.writes.length, 0);
});

test('non-2xx responses preserve status, statusText, headers and body', async () => {
  const networkResponse = new Response('failed', {
    status: 503,
    statusText: 'Unavailable',
    headers: { 'X-CDN': 'same' },
  });
  const { bank } = createBank({ nativeFetch: async () => networkResponse });
  const response = await fetchThrough(bank);
  assert.equal(response.status, 503);
  assert.equal(response.statusText, 'Unavailable');
  assert.equal(response.headers.get('X-CDN'), 'same');
  assert.equal(await response.text(), 'failed');
});

test('network errors reject with the original error', async () => {
  const networkError = new TypeError('cdn failed');
  const { bank } = createBank({ nativeFetch: async () => { throw networkError; } });
  await assert.rejects(fetchThrough(bank), (error) => error === networkError);
});

test('AbortSignal rejects with AbortError and aborts the bank fetch', async () => {
  let signalSeen;
  const { bank } = createBank({
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      signalSeen = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-9' }, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(signalSeen.aborted, true);
});

test('same cacheKey deduplicates in-flight foreground fetches', async () => {
  let release;
  let networkCalls = 0;
  const network = new Promise((resolve) => { release = resolve; });
  const { bank } = createBank({
    nativeFetch: async () => {
      networkCalls += 1;
      await network;
      return responseFor(0, 9);
    },
  });
  const first = fetchThrough(bank);
  const second = fetchThrough(bank);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkCalls, 1);
  release();
  assert.equal((await first).status, 206);
  assert.equal((await second).status, 206);
});

test('foreground promotion reuses an in-flight prefetch at foreground priority', async () => {
  let release;
  let networkCalls = 0;
  const network = new Promise((resolve) => { release = resolve; });
  const { bank } = createBank({
    nativeFetch: async () => {
      networkCalls += 1;
      await network;
      return responseFor(0, 9);
    },
  });
  const plan = {
    start: 0,
    end: 9,
    chunkIndex: 0,
    cacheKey: bank.cacheKeyForRange(MEDIA_KEY, 0),
  };
  const prefetch = bank.getTask(plan, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'include',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const foreground = bank.getTask(plan, {
    kind: 'foreground',
    url: MEDIA_URL,
    credentials: 'include',
    videoKey: '/video/BVbank',
  });
  const task = bank.inflight.get(plan.cacheKey);
  assert.equal(networkCalls, 1);
  assert.equal(task.kind, 'foreground');
  assert.equal(task.priority, 0);

  release();
  await Promise.all([prefetch, foreground]);
});

test('queue priority always sorts foreground before prefetch', () => {
  const tasks = [
    { priority: 1, sequence: 0 },
    { priority: 0, sequence: 2 },
    { priority: 0, sequence: 1 },
  ].sort(compareQueueTasks);
  assert.deepEqual(tasks.map((task) => task.sequence), [1, 2, 0]);
});

test('single-video and global eviction prefer played chunks before distant future chunks', () => {
  const entries = [
    { cacheKey: 'a#0', bankKey: 'a', start: 0, end: 9, byteLength: 10, storedAt: 1 },
    { cacheKey: 'a#1', bankKey: 'a', start: 100, end: 109, byteLength: 10, storedAt: 2 },
    { cacheKey: 'b#0', bankKey: 'b', start: 0, end: 9, byteLength: 10, storedAt: 3 },
  ];
  const perVideo = selectEvictions({
    entries,
    maxBankBytes: 100,
    maxBankBytesPerVideo: 15,
    currentByteByBank: { a: 50, b: 50 },
  });
  assert.deepEqual(perVideo.entries.map((entry) => entry.cacheKey), ['a#0']);
  const global = selectEvictions({
    entries,
    maxBankBytes: 20,
    maxBankBytesPerVideo: 100,
    currentByteByBank: { a: 50, b: 50 },
  });
  assert.equal(global.bytes, 10);
  assert.equal(global.entries[0].cacheKey, 'a#0');
});

class NativeXHR {
  constructor() {
    this.readyState = 0;
    this.responseType = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.listeners = new Map();
    this.sendCalls = [];
  }

  open(...args) {
    this.openArgs = args;
    this.readyState = 1;
  }

  setRequestHeader() {}

  addEventListener(type, listener) {
    const set = this.listeners.get(type) || new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener() {}

  send(body) { this.sendCalls.push(body); }

  abort() { this.abortCalls = (this.abortCalls || 0) + 1; }

  getResponseHeader() { return null; }

  getAllResponseHeaders() { return ''; }

  overrideMimeType() {}
}

test('XHR preserves readyState 2→3→4 and event ordering with arraybuffer response', async () => {
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    async serveRequest() {
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      return { intercepted: true, response: responseFor(0, 2, 3, new Uint8Array(bytes)), bytes };
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  const events = [];
  for (const name of ['readystatechange', 'progress', 'load', 'loadend']) {
    xhr.addEventListener(name, () => events.push(`${name}:${xhr.readyState}`));
  }
  await new Promise((resolve) => {
    xhr.addEventListener('loadend', resolve);
    xhr.open('GET', MEDIA_URL);
    xhr.setRequestHeader('Range', 'bytes=0-2');
    xhr.send();
  });
  assert.deepEqual(events, [
    'readystatechange:2',
    'readystatechange:3',
    'progress:3',
    'readystatechange:4',
    'load:4',
    'loadend:4',
  ]);
  assert.equal(xhr.response.byteLength, 3);
  assert.equal(xhr.responseURL, new URL(MEDIA_URL).href);
  assert.equal(xhr.status, 206);
});

test('XHR abort dispatches abort then loadend and cancels its request', async () => {
  let signalSeen;
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    serveRequest({ signal }) {
      signalSeen = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  const events = [];
  xhr.addEventListener('abort', () => events.push('abort'));
  xhr.addEventListener('loadend', () => events.push('loadend'));
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  await new Promise((resolve) => setImmediate(resolve));
  xhr.abort();
  assert.deepEqual(events, ['abort', 'loadend']);
  assert.equal(signalSeen.aborted, true);
});

test('XHR timeout dispatches readystatechange, timeout, then loadend', async () => {
  let signalSeen;
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    serveRequest({ signal }) {
      signalSeen = signal;
      return new Promise(() => {});
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.timeout = 1;
  const events = [];
  for (const name of ['readystatechange', 'timeout', 'loadend']) {
    xhr.addEventListener(name, () => events.push(`${name}:${xhr.readyState}`));
  }
  const finished = new Promise((resolve) => xhr.addEventListener('loadend', resolve, { once: true }));
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  await finished;
  assert.deepEqual(events, ['readystatechange:4', 'timeout:4', 'loadend:4']);
  assert.equal(signalSeen.aborted, true);
});

test('XHR network failures dispatch readystatechange, error, then loadend', async () => {
  const networkError = new TypeError('cdn failed');
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    async serveRequest() {
      throw new BankNetworkError('媒体分片网络取数失败', networkError);
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  const events = [];
  for (const name of ['readystatechange', 'error', 'loadend']) {
    xhr.addEventListener(name, () => events.push(`${name}:${xhr.readyState}`));
  }
  const finished = new Promise((resolve) => xhr.addEventListener('loadend', resolve, { once: true }));
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  await finished;
  assert.deepEqual(events, ['readystatechange:4', 'error:4', 'loadend:4']);
  assert.equal(xhr.status, 0);
});

test('XHR ignores a cancelled prior generation after open starts a replacement request', async () => {
  let resolveFirst;
  let resolveSecond;
  let calls = 0;
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    serveRequest() {
      calls += 1;
      return new Promise((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  let loadendCount = 0;
  xhr.addEventListener('loadend', () => { loadendCount += 1; });

  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  await new Promise((resolve) => setImmediate(resolve));

  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=3-5');
  xhr.send();
  await new Promise((resolve) => setImmediate(resolve));

  resolveFirst({
    intercepted: true,
    response: responseFor(0, 2, 6, new Uint8Array([1, 1, 1])),
    bytes: new Uint8Array([1, 1, 1]).buffer,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadendCount, 0);

  const finished = new Promise((resolve) => xhr.addEventListener('loadend', resolve, { once: true }));
  resolveSecond({
    intercepted: true,
    response: responseFor(3, 5, 6, new Uint8Array([2, 2, 2])),
    bytes: new Uint8Array([2, 2, 2]).buffer,
  });
  await finished;
  assert.equal(loadendCount, 1);
  assert.deepEqual([...new Uint8Array(xhr.response)], [2, 2, 2]);
});

assert.equal(BANK_CONFIG.storeReadTimeoutMs, 50);
