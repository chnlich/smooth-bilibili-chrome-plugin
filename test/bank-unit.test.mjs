import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANK_CONFIG } from '../src/constants.js';
import {
  BANK_ENABLED_ATTRIBUTE,
  BANK_MESSAGE_NAMESPACE,
  isBankDiagnosticMessage,
  postBankControl,
} from '../src/bank/contract.js';
import {
  bankKey,
  cacheKey,
  classifyRequest,
  estimateBitrate,
  parseContentRange,
  parseRangeHeader,
  partialResponseHeaders,
  planFetchRanges,
  prefetchRange,
  selectEvictions,
} from '../src/bank/logic.js';
import { BankFallbackError, BankNetworkError } from '../src/bank/errors.js';
import {
  enforceMemoryLimit,
  readMemoryRange,
  totalMemoryBytes,
  writeMemoryChunk,
} from '../src/bank/storage.js';
import { SegmentBank } from '../src/bank/main.js';
import { createBankXMLHttpRequestClass } from '../src/bank/xhr.js';

const MEDIA_URL = 'https://upos-sz-mirrorcosov.bilivideo.com/video/track.m4s?deadline=secret&upsig=secret';
const MEDIA_KEY = '/video/track.m4s';

function responseFor(start, end, totalSize = 100, body = new Uint8Array(end - start + 1), options = {}) {
  return new Response(body, {
    status: options.status || 206,
    statusText: options.statusText || 'Partial Content',
    headers: options.headers || {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(body.byteLength),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    },
  });
}

function rangeFromInit(init) {
  return parseRangeHeader(init.headers.Range || init.headers.get('Range'));
}

function manualTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const id = ++nextId;
      pending.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(milliseconds) {
      for (const [id, timer] of [...pending]) {
        if (timer.milliseconds !== milliseconds) continue;
        pending.delete(id);
        timer.callback();
      }
    },
    pending,
  };
}

function windowFixture({ timers } = {}) {
  const listeners = new Map();
  const realTimers = new Set();
  const messages = [];
  return {
    location: new URL('https://www.bilibili.com/video/BVbank'),
    Response,
    Event,
    Blob,
    performance: { now: () => Date.now() },
    document: {
      querySelectorAll: () => [],
      documentElement: { getAttribute: () => undefined },
    },
    messages,
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      if (timers !== undefined) return timers.setTimeout(callback, milliseconds);
      const timer = setTimeout(callback, milliseconds);
      realTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timers !== undefined) return timers.clearTimeout(timer);
      realTimers.delete(timer);
      clearTimeout(timer);
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(message, _origin, transfer) {
      messages.push(message);
      for (const listener of listeners.get('message') || []) {
        listener({ source: this, data: message, transfer });
      }
    },
  };
}

function configFor(overrides = {}) {
  return {
    ...BANK_CONFIG,
    chunkBytes: 16,
    maxBankBytes: 64,
    prefetchAheadSeconds: 4,
    ...overrides,
  };
}

function bytesFor(start, end) {
  return Uint8Array.from({ length: end - start + 1 }, (_value, index) => (start + index) % 251);
}

function createBank({
  nativeFetch,
  config = BANK_CONFIG,
  maxPrefetchConcurrency = 2,
  chunks,
  timers,
} = {}) {
  const windowObject = windowFixture({ timers });
  const calls = [];
  const fetchFunction = nativeFetch || (async (url, init) => {
    const range = rangeFromInit(init);
    calls.push({ url, init, range });
    return responseFor(range.start, range.end, 100, bytesFor(range.start, range.end));
  });
  const bank = new SegmentBank({
    windowObject,
    nativeFetch: fetchFunction,
    config,
    maxPrefetchConcurrency,
    chunks,
  });
  return { bank, windowObject, calls };
}

async function fetchThrough(
  bank,
  input = MEDIA_URL,
  init = { headers: { Range: 'bytes=0-9' } },
  originalFetch,
) {
  return bank.handleFetch(
    bank.windowObject,
    [input, init],
    originalFetch || bank.nativeFetch,
  );
}

function putChunk(bank, index, config = bank.config, totalSize = 100) {
  const start = index * config.chunkBytes;
  const end = Math.min(start + config.chunkBytes - 1, totalSize - 1);
  bank.chunks.set(cacheKey(MEDIA_KEY, index), {
    bytes: bytesFor(start, end).buffer,
    totalSize,
    storedAt: index + 1,
  });
  return { start, end, cacheKey: cacheKey(MEDIA_KEY, index) };
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

test('response headers, content-range parser, fetch plans and bitrate estimate are exact', () => {
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
  assert.deepEqual(planFetchRanges(5, 20, {
    chunkBytes: 16,
    totalSize: 100,
    bankKeyValue: MEDIA_KEY,
    aligned: true,
  }), [
    { start: 0, end: 15, chunkIndex: 0, cacheKey: `${MEDIA_KEY}#0`, cacheable: true },
    { start: 16, end: 31, chunkIndex: 1, cacheKey: `${MEDIA_KEY}#1`, cacheable: true },
  ]);
  assert.deepEqual(planFetchRanges(4, 10, {
    chunkBytes: 16,
    totalSize: 100,
    bankKeyValue: MEDIA_KEY,
    aligned: true,
  }), [{
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }]);
  assert.deepEqual(planFetchRanges(4, 10, {
    chunkBytes: 16,
    totalSize: 100,
    bankKeyValue: MEDIA_KEY,
  }), [{
    start: 4,
    end: 10,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: false,
  }]);
});

test('control stays in the DOM boundary and diagnostic messages carry no binary payload', () => {
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
  assert.equal(isBankDiagnosticMessage({
    namespace: BANK_MESSAGE_NAMESPACE,
    direction: 'event',
    type: 'diagnostic',
    code: 'bank.serve',
    data: { result: 'hit' },
  }), true);
  assert.equal(isBankDiagnosticMessage({
    namespace: BANK_MESSAGE_NAMESPACE,
    direction: 'request',
    type: 'write-chunk',
  }), false);
});

test('memory hit returns exact bytes and canonical response fields without network', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  putChunk(bank, 0, config);
  bank.fetchedChunks.set(`${MEDIA_KEY}#0`, { fetchedAt: 1 });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.statusText, 'Partial Content');
  assert.equal(response.url, new URL(MEDIA_URL).href);
  assert.equal(response.type, 'basic');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
  assert.equal(response.headers.get('Content-Range'), 'bytes 4-6/100');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual(calls, []);
});

test('a foreground miss fetches the original Range once and never stores it', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-11' } });
  assert.deepEqual(calls.map((call) => call.range), [{ start: 4, end: 11 }]);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(4, 11)]);
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
  assert.equal(bank.activeForeground.size, 0);
});

test('one foreground request produces one network request even when it spans two MiB', async () => {
  const config = configFor({ chunkBytes: 4 * 1024 ** 2 });
  const { bank, calls } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      calls.push({ range });
      return responseFor(range.start, range.end, 8 * 1024 ** 2, bytesFor(range.start, range.end));
    },
  });
  const start = 123;
  const end = 2 * 1024 ** 2 + 123;
  const response = await fetchThrough(bank, MEDIA_URL, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  assert.deepEqual(calls.map(({ range }) => range), [{ start, end }]);
  assert.equal((await response.arrayBuffer()).byteLength, end - start + 1);
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
});

test('a foreground request at an unknown resource tail keeps its original Range', async () => {
  const config = configFor();
  const { bank, calls } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      const end = Math.min(range.end, 59);
      calls.push({ range });
      return responseFor(range.start, end, 60, bytesFor(range.start, end));
    },
  });
  let fallbackCalls = 0;
  const response = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=44-59' } },
    async () => {
      fallbackCalls += 1;
      return responseFor(44, 59, 60, bytesFor(44, 59));
    },
  );
  assert.deepEqual(calls.map(({ range }) => range), [{ start: 44, end: 59 }]);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(44, 59)]);
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
});

test('a foreground request spanning stored and missing chunks still uses one original Range', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  putChunk(bank, 0, config, 64);
  bank.fetchedChunks.set(`${MEDIA_KEY}#0`, { fetchedAt: 1 });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-20' } });
  assert.deepEqual(calls.map((call) => call.range), [{ start: 4, end: 20 }]);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(4, 20)]);
  assert.equal(bank.fetchedChunks.has(`${MEDIA_KEY}#1`), false);
});

test('a foreground direct request keeps its original Range and never enters either table', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-3' } });
  assert.deepEqual(calls.map((call) => call.range), [{ start: 0, end: 3 }]);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
});

test('open, multi-range, no-range and non-media fetches pass the original arguments before body consumption', async () => {
  const { bank } = createBank();
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
  const passthrough = async (...args) => args;
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, {}, passthrough), [MEDIA_URL, {}]);
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-' } }, passthrough), [
    MEDIA_URL,
    { headers: { Range: 'bytes=4-' } },
  ]);
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-9,20-30' } }, passthrough), [
    MEDIA_URL,
    { headers: { Range: 'bytes=4-9,20-30' } },
  ]);
});

test('same cacheKey deduplicates in-flight foreground fetches', async () => {
  const config = configFor();
  let release;
  let networkCalls = 0;
  const network = new Promise((resolve) => { release = resolve; });
  const { bank } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      networkCalls += 1;
      await network;
      const range = rangeFromInit(init);
      return responseFor(range.start, range.end, 64, bytesFor(range.start, range.end));
    },
  });
  const first = fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-11' } });
  const second = fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-11' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkCalls, 1);
  release();
  assert.equal((await first).status, 206);
  assert.equal((await second).status, 206);
});

test('two hanging prefetches do not block an immediate foreground request', async () => {
  const config = configFor({ prefetchDeadlineMs: 1000 });
  const pending = new Map();
  const { bank } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      if (range.start >= 48) return responseFor(range.start, range.end, 100, bytesFor(range.start, range.end));
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const prefetches = [0, 16, 32].map((start) => bank.getTask({
    start,
    end: start + 15,
    chunkIndex: start / 16,
    cacheKey: `${MEDIA_KEY}#${start / 16}`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.size, 2);
  assert.equal(bank.activePrefetch.size, 2);
  assert.equal(bank.queue.length, 1);

  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=48-55' } });
  assert.equal(response.status, 206);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(48, 55)]);
  assert.deepEqual([...pending.keys()], ['0-15', '16-31']);

  bank.destroy();
  const results = await Promise.allSettled(prefetches);
  assert.equal(results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'), true);
});

test('a foreground task blocks new prefetches and settlement resumes the queue', async () => {
  const config = configFor({ prefetchDeadlineMs: 1000 });
  const pending = new Map();
  const { bank } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const firstPrefetch = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const foreground = bank.getTask({
    start: 32,
    end: 35,
    chunkIndex: 2,
    cacheKey: `${MEDIA_KEY}#2`,
    cacheable: false,
  }, {
    kind: 'foreground',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  const queuedPrefetch = bank.getTask({
    start: 16,
    end: 31,
    chunkIndex: 1,
    cacheKey: `${MEDIA_KEY}#1`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.activeForeground.size, 1);
  assert.equal(pending.has('16-31'), false);
  assert.equal(bank.queue.length, 1);

  pending.get('32-35').resolve(responseFor(32, 35, 64, bytesFor(32, 35)));
  await foreground;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.has('16-31'), true);
  assert.equal(bank.activeForeground.size, 0);
  assert.equal(bank.activePrefetch.size, 2);

  pending.get('0-15').resolve(responseFor(0, 15, 64, bytesFor(0, 15)));
  pending.get('16-31').resolve(responseFor(16, 31, 64, bytesFor(16, 31)));
  await Promise.all([firstPrefetch, queuedPrefetch]);
});

test('prefetch concurrency never exceeds two active tasks', async () => {
  const config = configFor({ prefetchDeadlineMs: 1000 });
  const pending = new Map();
  const { bank } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const tasks = [0, 16, 32, 48].map((start) => bank.getTask({
    start,
    end: start + 15,
    chunkIndex: start / 16,
    cacheKey: `${MEDIA_KEY}#${start / 16}`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.activePrefetch.size <= 2, true);
  assert.equal(bank.activePrefetch.size, 2);
  assert.equal(bank.queue.length, 2);
  pending.get('0-15').resolve(responseFor(0, 15, 80, bytesFor(0, 15)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.activePrefetch.size <= 2, true);
  assert.equal(pending.has('32-47'), true);
  bank.destroy();
  const results = await Promise.allSettled(tasks);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results.slice(1).every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'), true);
});

test('the fetched hard gate blocks speculative work even when the chunk table is empty', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  const plan = {
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  };
  bank.fetchedChunks.set(plan.cacheKey, { fetchedAt: 1 });
  const result = await bank.getTask(plan, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.deepEqual(result, { skipped: true, cacheKey: plan.cacheKey });
  assert.deepEqual(calls, []);
  assert.equal(bank.inflight.size, 0);
});

test('eviction removes the same cacheKey from the fetched hard gate', () => {
  const config = configFor({ maxBankBytes: 32 });
  const { bank } = createBank({ config });
  const first = putChunk(bank, 0, config, 64);
  putChunk(bank, 1, config, 64);
  bank.fetchedChunks.set(first.cacheKey, { fetchedAt: 1 });
  bank.fetchedChunks.set(`${MEDIA_KEY}#1`, { fetchedAt: 2 });
  bank.stateFor(MEDIA_KEY).lastForegroundEnd = 20;
  bank.storeTask({
    cacheKey: `${MEDIA_KEY}#2`,
    bankKey: MEDIA_KEY,
    chunkIndex: 2,
  }, {
    start: 32,
    end: 47,
    totalSize: 64,
    bytes: bytesFor(32, 47).buffer,
  });
  assert.equal(bank.chunks.has(first.cacheKey), false);
  assert.equal(bank.fetchedChunks.has(first.cacheKey), false);
  assert.equal(bank.chunks.size, 2);
  assert.equal(bank.windowObject.messages.some((message) => message.code === 'bank.evict'), true);
});

test('memory eviction prefers played chunks and then the farthest future chunk', () => {
  const entries = [
    { cacheKey: 'a#0', bankKey: 'a', start: 0, end: 9, byteLength: 10, storedAt: 1 },
    { cacheKey: 'a#1', bankKey: 'a', start: 100, end: 109, byteLength: 10, storedAt: 2 },
    { cacheKey: 'b#0', bankKey: 'b', start: 20, end: 29, byteLength: 10, storedAt: 3 },
  ];
  const selected = selectEvictions({
    entries,
    maxBankBytes: 20,
    currentByteByBank: { a: 50, b: 50 },
  });
  assert.equal(selected.bytes, 10);
  assert.equal(selected.entries[0].cacheKey, 'a#0');
  const farther = selectEvictions({
    entries: entries.slice(1),
    maxBankBytes: 10,
    currentByteByBank: { a: 50, b: 0 },
  });
  assert.equal(farther.entries[0].cacheKey, 'a#1');
});

test('memory limit is enforced after each write', async () => {
  const config = configFor({ maxBankBytes: 32 });
  const { bank } = createBank({ config });
  for (const start of [0, 16, 32]) {
    await bank.getTask({
      start,
      end: start + 15,
      chunkIndex: start / 16,
      cacheKey: `${MEDIA_KEY}#${start / 16}`,
      cacheable: true,
    }, {
      kind: 'prefetch',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    });
  }
  assert.equal(totalMemoryBytes(bank.chunks, config.chunkBytes) <= config.maxBankBytes, true);
  assert.equal(bank.chunks.size, 2);
});

test('memory storage is atomic and never exposes a half chunk after an invalid response', async () => {
  const config = configFor();
  const { bank } = createBank({
    config,
    nativeFetch: async () => responseFor(0, 15, 64, new Uint8Array(15)),
  });
  let fallbackCalls = 0;
  const response = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-7' } },
    async () => {
      fallbackCalls += 1;
      return new Response(new Uint8Array(0), { status: 416, statusText: 'Range Not Satisfiable' });
    },
  );
  assert.equal(response.status, 416);
  assert.equal(fallbackCalls, 1);
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
});

test('a memory write failure disables the bank and lets subsequent requests pass', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({ config });
  bank.storeTask = () => { throw new Error('allocation failed'); };
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(bank.disabled, true);
  assert.equal(windowObject.messages.some((message) => message.code === 'bank.store' && message.data.result === 'failed'), true);
  assert.equal(windowObject.messages.filter((message) => message.code === 'bank.disabled').length, 1);
  let passCalls = 0;
  const passed = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-7' } },
    async () => {
      passCalls += 1;
      return new Response('pass', { status: 200 });
    },
  );
  assert.equal(await passed.text(), 'pass');
  assert.equal(passCalls, 1);
});

test('refetch alarm closes the bank on the configured count', async () => {
  const config = configFor({ refetchAlarmCount: 3 });
  let calls = 0;
  const { bank, windowObject } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      calls += 1;
      const range = rangeFromInit(init);
      return responseFor(range.start, range.end, 64, bytesFor(range.start, range.end));
    },
  });
  const plan = {
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  };
  bank.fetchedChunks.set(plan.cacheKey, { fetchedAt: 1 });
  for (let index = 0; index < 3; index += 1) {
    bank.chunks.clear();
    await bank.getTask(plan, {
      kind: 'foreground',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    });
  }
  assert.equal(calls, 3);
  assert.equal(bank.disabled, true);
  assert.equal(windowObject.messages.filter((message) => message.code === 'bank.disabled').length, 1);
  assert.equal(windowObject.messages.find((message) => message.code === 'bank.disabled').data.reason, 'refetch_alarm');
});

test('non-2xx responses preserve the CDN result and network errors preserve identity', async () => {
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

  const networkError = new TypeError('cdn failed');
  const failedBank = createBank({ nativeFetch: async () => { throw networkError; } }).bank;
  await assert.rejects(fetchThrough(failedBank), (error) => error === networkError);
});

test('AbortSignal rejects with AbortError and aborts the in-flight bank fetch', async () => {
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
  assert.equal(bank.chunks.size, 0);
});

test('a foreground deadline falls back unchanged instead of exposing AbortError', async () => {
  const config = configFor({ foregroundDeadlineMs: 5, prefetchDeadlineMs: 20 });
  const timers = manualTimers();
  const { bank, windowObject } = createBank({
    config,
    timers,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  let fallbackCalls = 0;
  const pending = fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-9' } },
    async () => {
      fallbackCalls += 1;
      return new Response('native', { status: 200 });
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  timers.fire(config.foregroundDeadlineMs);
  const response = await pending;
  assert.equal(await response.text(), 'native');
  assert.equal(fallbackCalls, 1);
  assert.equal(windowObject.messages.filter(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'deadline',
  ).length, 1);
  assert.equal(bank.activeForeground.size, 0);
  assert.equal(bank.inflight.size, 0);
});

test('coverage and noncoverage foreground attachments both have wait deadlines', async () => {
  const config = configFor({ foregroundDeadlineMs: 5, prefetchDeadlineMs: 20 });
  const timers = manualTimers();
  const { bank } = createBank({
    config,
    timers,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const prefetch = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  let fallbackCalls = 0;
  const original = async () => {
    fallbackCalls += 1;
    return new Response('native', { status: 200 });
  };
  const covered = fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-7' } }, original);
  timers.fire(config.foregroundDeadlineMs);
  assert.equal(await (await covered).text(), 'native');
  const noncovered = fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-31' } }, original);
  timers.fire(config.foregroundDeadlineMs);
  assert.equal(await (await noncovered).text(), 'native');
  assert.equal(fallbackCalls, 2);
  assert.equal(bank.inflight.get(`${MEDIA_KEY}#0`).controller.signal.aborted, false);
  assert.equal(bank.activeForeground.size, 0);
  bank.destroy();
  await assert.rejects(prefetch, (error) => error.name === 'AbortError');
});

test('a foreground waiter falls back when the attached prefetch hits its own deadline', async () => {
  const config = configFor({ foregroundDeadlineMs: 50, prefetchDeadlineMs: 20 });
  const timers = manualTimers();
  const { bank, windowObject } = createBank({
    config,
    timers,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const prefetch = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  let fallbackCalls = 0;
  const foreground = fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=4-7' } },
    async () => {
      fallbackCalls += 1;
      return new Response('native', { status: 200 });
    },
  );
  timers.fire(config.prefetchDeadlineMs);
  assert.equal(await (await foreground).text(), 'native');
  assert.equal(fallbackCalls, 1);
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'deadline',
  ), true);
  await assert.rejects(prefetch, (error) => error.name === 'AbortError');
  bank.destroy();
});

test('three latency fallbacks disable the bank, while one success clears the streak', async () => {
  const config = configFor({ foregroundDeadlineMs: 5, prefetchDeadlineMs: 20 });
  const timers = manualTimers();
  let networkCalls = 0;
  const { bank, windowObject } = createBank({
    config,
    timers,
    nativeFetch: async (_url, init) => {
      networkCalls += 1;
      const range = rangeFromInit(init);
      if (networkCalls === 3) return responseFor(range.start, range.end, 100, bytesFor(range.start, range.end));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const fallbackRequest = async (index) => {
    const start = index * 10;
    const pending = fetchThrough(
      bank,
      MEDIA_URL,
      { headers: { Range: `bytes=${start}-${start + 3}` } },
      async () => new Response('native', { status: 200 }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    timers.fire(config.foregroundDeadlineMs);
    await pending;
  };
  await fallbackRequest(0);
  await fallbackRequest(1);
  const successful = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=20-23' } });
  assert.equal(successful.status, 206);
  assert.equal(bank.foregroundLatencyCount, 0);
  await fallbackRequest(3);
  await fallbackRequest(4);
  assert.equal(bank.disabled, false);
  await fallbackRequest(5);
  assert.equal(bank.disabled, true);
  assert.equal(windowObject.messages.filter((message) => message.code === 'bank.disabled').length, 1);
  assert.equal(windowObject.messages.find((message) => message.code === 'bank.disabled').data.reason, 'foreground_latency');
});

test('a prefetch deadline leaves fetchedChunks empty', async () => {
  const config = configFor({ prefetchDeadlineMs: 20 });
  const timers = manualTimers();
  const { bank, windowObject } = createBank({
    config,
    timers,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const pending = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
    cacheable: true,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const task = bank.inflight.get(`${MEDIA_KEY}#0`);
  timers.fire(config.prefetchDeadlineMs);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(task.abortReason, 'deadline');
  assert.equal(bank.fetchedChunks.has(`${MEDIA_KEY}#0`), false);
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#0`), false);
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'deadline',
  ), true);
});

test('leaving the video route releases chunks and the fetched hard gate', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({ config });
  putChunk(bank, 0, config);
  bank.fetchedChunks.set(`${MEDIA_KEY}#0`, { fetchedAt: 1 });
  windowObject.location = new URL('https://www.bilibili.com/');
  await bank.prefetch();
  assert.equal(bank.chunks.size, 0);
  assert.equal(bank.fetchedChunks.size, 0);
});

test('prefetch uses the playback sample and stores aligned future chunks', async () => {
  const config = configFor({ prefetchAheadSeconds: 4 });
  const { bank, windowObject, calls } = createBank({ config });
  windowObject.document.querySelectorAll = () => [{
    clientWidth: 100,
    clientHeight: 100,
    currentTime: 1,
    webkitVideoDecodedByteCount: 100,
  }];
  bank.playbackSamples = [{ time: 0, bytes: 0 }];
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.totalSize = 64;
  state.lastForegroundEnd = 3;
  bank.touchResource(MEDIA_KEY);

  await bank.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls.map(({ range }) => range), [
    { start: 16, end: 31 },
    { start: 32, end: 47 },
    { start: 48, end: 63 },
  ]);
  assert.equal(bank.chunks.size, 3);
  assert.equal(bank.fetchedChunks.size, 3);
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

test('XHR BankFallbackError returns the request to the native XHR unchanged', async () => {
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    emitDiagnostic() {},
    async serveRequest() {
      throw new BankFallbackError('等待超过补取死线');
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send('body');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(xhr._native.sendCalls, ['body']);
  assert.equal(xhr.readyState, 1);
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

test('pure memory functions keep records complete and enforce the global cap', () => {
  const config = configFor({ maxBankBytes: 16 });
  const chunks = new Map();
  const partialChunks = new Map([[`${MEDIA_KEY}#0`, {
    bytes: bytesFor(0, 7).buffer,
    totalSize: 64,
    storedAt: 1,
  }]]);
  assert.throws(() => readMemoryRange(partialChunks, MEDIA_KEY, 0, 7, config.chunkBytes));
  writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 0,
    end: 15,
    totalSize: 64,
    bytes: bytesFor(0, 15).buffer,
    chunkBytes: config.chunkBytes,
    storedAt: 1,
  });
  assert.deepEqual([...new Uint8Array(readMemoryRange(chunks, MEDIA_KEY, 4, 6, 16).bytes)], [4, 5, 6]);
  assert.throws(() => writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 0,
    end: 7,
    totalSize: 64,
    bytes: bytesFor(0, 7).buffer,
    chunkBytes: config.chunkBytes,
  }));
  writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 16,
    end: 31,
    totalSize: 64,
    bytes: bytesFor(16, 31).buffer,
    chunkBytes: config.chunkBytes,
    storedAt: 2,
  });
  const eviction = enforceMemoryLimit({ chunks, maxBankBytes: 16, chunkBytes: config.chunkBytes });
  assert.equal(eviction.bytes, 16);
  assert.equal(totalMemoryBytes(chunks, config.chunkBytes), 16);
});
