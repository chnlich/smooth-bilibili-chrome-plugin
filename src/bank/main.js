import { BANK_CONFIG } from '../constants.js';
import { scrubUrl } from '../diagnostics/privacy.js';
import { BankFallbackError, BankNetworkError } from './errors.js';
import {
  BANK_ENABLED_ATTRIBUTE,
  BANK_MESSAGE_NAMESPACE,
  isBankMessage,
} from './contract.js';
import {
  bankKey,
  cacheKey,
  classifyRequest,
  chunkIndex,
  compareQueueTasks,
  estimateBitrate,
  headerValue,
  insertQueueTask,
  parseContentRange,
  partialResponseHeaders,
  planFetchRanges,
  prefetchRange,
  priorityFor,
  rangeLength,
  isVideoLocation,
} from './logic.js';
import { createBankXMLHttpRequestClass } from './xhr.js';

const MAX_CONCURRENCY = 3;

class StoreReadTimeoutError extends Error {
  constructor() {
    super('媒体分片存储读取超时');
    this.name = 'StoreReadTimeoutError';
    this.code = 'BANK_STORE_READ_TIMEOUT';
  }
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function messageError(error) {
  const result = new Error(error?.message || String(error));
  result.name = error?.name || 'Error';
  result.code = error?.code || 'BANK_RELAY_FAILED';
  return result;
}

function performanceNow(windowObject) {
  return typeof windowObject.performance?.now === 'function' ? windowObject.performance.now() : Date.now();
}

function responseTypeConstructor(windowObject, name) {
  return windowObject[name] || globalThis[name];
}

function isRequestLike(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.url === 'string'
    && value.headers !== undefined;
}

function initField(init, field, inherited) {
  if (init !== null && (typeof init === 'object' || typeof init === 'function')) {
    const value = init[field];
    if (value !== undefined) return value;
  }
  return inherited;
}

function inspectFetchArguments(args, locationObject) {
  const [input, init] = args;
  const inherited = isRequestLike(input) ? input : undefined;
  const rawUrl = inherited === undefined ? String(input) : inherited.url;
  const url = new URL(rawUrl, locationObject?.href).href;
  return {
    url,
    headers: initField(init, 'headers', inherited?.headers),
    method: initField(init, 'method', inherited?.method) || 'GET',
    credentials: initField(init, 'credentials', inherited?.credentials) || 'same-origin',
    signal: initField(init, 'signal', inherited?.signal),
  };
}

function waitWithSignal(promise, signal, windowObject, timeoutMs) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) windowObject.clearTimeout(timer);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = windowObject.setTimeout(() => finish(reject, new StoreReadTimeoutError()), timeoutMs);
    }
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

class BankStoreClient {
  constructor(windowObject) {
    this.windowObject = windowObject;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.onMessage = (event) => {
      if (event.source !== this.windowObject || !isBankMessage(event.data)) return;
      const message = event.data;
      if (message.direction !== 'response') return;
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) return;
      this.pending.delete(message.requestId);
      if (message.ok !== true) {
        pending.reject(messageError(message.error));
        return;
      }
      pending.resolve(message.value);
    };
    windowObject.addEventListener('message', this.onMessage);
  }

  request(type, payload, transfer = []) {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const message = {
      namespace: BANK_MESSAGE_NAMESPACE,
      direction: 'request',
      type,
      requestId,
      ...payload,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.windowObject.postMessage(message, '*', transfer);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  readRange(bankKeyValue, start, end) {
    return this.request('read-range', { bankKey: bankKeyValue, start, end });
  }

  writeChunk({
    bankKey: bankKeyValue,
    videoKey,
    start,
    end,
    totalSize,
    bytes,
    currentByteByBank,
    currentByteByVideo,
  }) {
    return this.request(
      'write-chunk',
      {
        bankKey: bankKeyValue,
        videoKey,
        start,
        end,
        totalSize,
        bytes,
        currentByteByBank,
        currentByteByVideo,
      },
      [bytes],
    );
  }

  destroy() {
    this.windowObject.removeEventListener('message', this.onMessage);
    for (const pending of this.pending.values()) pending.reject(new Error('媒体分片存储客户端已经销毁'));
    this.pending.clear();
  }
}

export class SegmentBank {
  constructor({
    windowObject = window,
    nativeFetch = windowObject.fetch,
    storeClient = new BankStoreClient(windowObject),
    maxConcurrency = MAX_CONCURRENCY,
    config = BANK_CONFIG,
  } = {}) {
    this.windowObject = windowObject;
    this.nativeFetch = nativeFetch;
    this.storeClient = storeClient;
    this.config = config;
    this.maxConcurrency = maxConcurrency;
    this.enabled = true;
    this.queue = [];
    this.inflight = new Map();
    this.activeTasks = new Set();
    this.sequence = 0;
    this.resourceState = new Map();
    this.recentResourceKeys = [];
    this.knownStoredRanges = new Map();
    this.pendingStoreRanges = new Map();
    this.memoryRanges = new Map();
    this.prefetchTimer = this.windowObject.setInterval?.(() => {
      void this.prefetch().catch((error) => {
        console.error('[BilibiliBuffer] 媒体分片预取失败', error);
      });
    }, 1000);
  }

  isEnabled() {
    const root = this.windowObject.document?.documentElement;
    const configured = root?.getAttribute?.(BANK_ENABLED_ATTRIBUTE);
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return this.enabled === true;
  }

  emitDiagnostic(code, data) {
    const message = {
      namespace: BANK_MESSAGE_NAMESPACE,
      direction: 'event',
      type: 'diagnostic',
      code,
      data,
    };
    try {
      this.windowObject.postMessage(message, '*');
    } catch (error) {
      console.error('[BilibiliBuffer] 媒体分片诊断派发失败', error);
    }
  }

  stateFor(bankKeyValue) {
    let state = this.resourceState.get(bankKeyValue);
    if (state === undefined) {
      state = {
        bankKey: bankKeyValue,
        videoKey: this.windowObject.location.pathname,
        latestUrl: undefined,
        credentials: 'same-origin',
        totalSize: undefined,
        lastForegroundEnd: undefined,
        prefetchEnd: undefined,
        samples: [],
      };
      this.resourceState.set(bankKeyValue, state);
    }
    return state;
  }

  rangeIsCovered(rangeMap, key, start, end) {
    return (rangeMap.get(key) || []).some((range) => range.start <= start && range.end >= end);
  }

  rememberRange(rangeMap, key, start, end) {
    const ranges = rangeMap.get(key) || [];
    ranges.push({ start, end });
    rangeMap.set(key, ranges);
  }

  forgetRange(rangeMap, key, start, end) {
    const ranges = rangeMap.get(key) || [];
    const remaining = ranges.filter((range) => range.start !== start || range.end !== end);
    if (remaining.length === 0) rangeMap.delete(key);
    else rangeMap.set(key, remaining);
  }

  rememberMemoryRange(bankKeyValue, result) {
    const ranges = this.memoryRanges.get(bankKeyValue) || [];
    ranges.push({
      start: result.start,
      end: result.end,
      totalSize: result.totalSize,
      bytes: result.bytes,
    });
    this.memoryRanges.set(bankKeyValue, ranges);
  }

  forgetMemoryRange(bankKeyValue, start, end) {
    const ranges = this.memoryRanges.get(bankKeyValue) || [];
    const remaining = ranges.filter((range) => range.start !== start || range.end !== end);
    if (remaining.length === 0) this.memoryRanges.delete(bankKeyValue);
    else this.memoryRanges.set(bankKeyValue, remaining);
  }

  readMemoryRange(bankKeyValue, start, end) {
    const segments = [...this.memoryRanges.get(bankKeyValue) || []].sort((left, right) => left.start - right.start);
    const bytes = new Uint8Array(rangeLength({ start, end }));
    let cursor = start;
    let totalSize;
    for (const segment of segments) {
      if (segment.end < cursor) continue;
      if (segment.start > cursor) return undefined;
      const copyStart = Math.max(cursor, segment.start);
      const copyEnd = Math.min(end, segment.end);
      bytes.set(
        new Uint8Array(segment.bytes).subarray(copyStart - segment.start, copyEnd - segment.start + 1),
        copyStart - start,
      );
      cursor = copyEnd + 1;
      totalSize = segment.totalSize;
      if (cursor > end) return { hit: true, bytes: bytes.buffer, totalSize };
    }
    return undefined;
  }

  cacheKeyForRange(resourceKey, start) {
    return cacheKey(resourceKey, chunkIndex(start, this.config.chunkBytes));
  }

  touchResource(resourceKey) {
    const nextKeys = [
      ...this.recentResourceKeys.filter((key) => key !== resourceKey),
      resourceKey,
    ].slice(-2);
    const retained = new Set(nextKeys);
    this.abortPrefetchTasks((task) => !retained.has(task.bankKey));
    this.recentResourceKeys = nextKeys;
  }

  abortPrefetchTasks(predicate = () => true) {
    for (const task of this.inflight.values()) {
      if (task.kind === 'prefetch' && predicate(task)) task.controller.abort();
    }
  }

  updatePlaybackSample() {
    const videos = [...this.windowObject.document?.querySelectorAll?.('video') || []];
    const video = videos.sort((left, right) =>
      (right.clientWidth || 0) * (right.clientHeight || 0)
      - (left.clientWidth || 0) * (left.clientHeight || 0)).at(0);
    if (video === undefined) return 0;
    const bytes = Number(video.webkitVideoDecodedByteCount);
    const time = Number(video.currentTime);
    if (!Number.isFinite(bytes) || !Number.isFinite(time)) return 0;
    const stateSamples = this.playbackSamples || [];
    stateSamples.push({ time, bytes });
    while (stateSamples.length > 4) stateSamples.shift();
    this.playbackSamples = stateSamples;
    return estimateBitrate(stateSamples);
  }

  requestClassification(url, headers) {
    return classifyRequest({
      url,
      headers,
      enabled: this.isEnabled(),
      locationObject: this.windowObject.location,
    });
  }

  async handleFetch(thisArg, args, originalFetch) {
    if (this.windowObject.location !== undefined && !isVideoLocation(this.windowObject.location)) {
      return originalFetch.apply(thisArg, args);
    }
    let request;
    try {
      request = inspectFetchArguments(args, this.windowObject.location);
    } catch (error) {
      return originalFetch.apply(thisArg, args);
    }
    let classification;
    try {
      classification = this.requestClassification(request.url, request.headers);
    } catch (error) {
      return originalFetch.apply(thisArg, args);
    }
    if (!classification.intercepted) {
      if (this.isEnabled()) {
        this.emitDiagnostic('bank.serve', {
          source: scrubUrl(request.url),
          result: 'pass',
          reason: classification.reason,
        });
      }
      return originalFetch.apply(thisArg, args);
    }
    try {
      const served = await this.serveRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
        credentials: request.credentials,
        signal: request.signal,
      });
      return served.response;
    } catch (error) {
      if (error instanceof BankNetworkError) throw error.cause;
      if (isAbortError(error)) throw error;
      if (error instanceof BankFallbackError) {
        this.emitDiagnostic('bank.serve', {
          source: scrubUrl(request.url),
          start: classification.range.start,
          end: classification.range.end,
          result: 'pass',
          reason: 'internal_fallback',
        });
        return originalFetch.apply(thisArg, args);
      }
      this.emitDiagnostic('bank.serve', {
        source: scrubUrl(request.url),
        result: 'pass',
        reason: 'internal_error',
      });
      return originalFetch.apply(thisArg, args);
    }
  }

  async readStoredRange(bankKeyValue, start, end, signal) {
    const memory = this.readMemoryRange(bankKeyValue, start, end);
    if (memory?.hit === true) return memory;
    let read;
    try {
      read = this.storeClient.readRange(bankKeyValue, start, end);
    } catch (error) {
      throw new BankFallbackError('媒体分片存储读取失败', error);
    }
    try {
      return await waitWithSignal(read, signal, this.windowObject, this.config.storeReadTimeoutMs);
    } catch (error) {
      if (error instanceof StoreReadTimeoutError) {
        void read.catch((readError) => {
          console.error('[BilibiliBuffer] 媒体分片存储读取超时后的错误', readError);
        });
        return undefined;
      }
      if (isAbortError(error)) throw error;
      throw new BankFallbackError('媒体分片存储读取失败', error);
    }
  }

  createResponse(bytes, start, end, totalSize, url) {
    const ResponseConstructor = responseTypeConstructor(this.windowObject, 'Response');
    const response = new ResponseConstructor(bytes, {
      status: 206,
      statusText: 'Partial Content',
      headers: partialResponseHeaders(start, end, totalSize),
    });
    Object.defineProperty(response, 'url', { configurable: true, value: url });
    Object.defineProperty(response, 'type', { configurable: true, value: 'basic' });
    return response;
  }

  async serveRequest({ url, method, headers, credentials, signal }) {
    const classification = this.requestClassification(url, headers);
    if (!classification.intercepted) return { intercepted: false };
    if (signal?.aborted) throw abortError();
    const { start, end } = classification.range;
    const resourceKey = bankKey(url);
    this.touchResource(resourceKey);
    const state = this.stateFor(resourceKey);
    state.videoKey = this.windowObject.location.pathname;
    state.latestUrl = url;
    state.credentials = credentials || 'same-origin';
    if (state.lastForegroundEnd !== end) state.prefetchEnd = undefined;
    state.lastForegroundEnd = end;
    const stored = await this.readStoredRange(resourceKey, start, end, signal);
    if (signal?.aborted) throw abortError();
    if (stored?.hit === true) {
      if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== rangeLength({ start, end })) {
        throw new BankFallbackError('媒体分片存储命中长度不符');
      }
      if (!Number.isSafeInteger(stored.totalSize) || stored.totalSize <= end) {
        throw new BankFallbackError('媒体分片存储命中总长度无效');
      }
      state.totalSize = stored.totalSize;
      this.rememberRange(
        this.knownStoredRanges,
        this.cacheKeyForRange(resourceKey, start),
        start,
        end,
      );
      this.emitDiagnostic('bank.serve', {
        source: scrubUrl(url),
        start,
        end,
        result: 'hit',
        reason: 'stored_range',
      });
      return {
        intercepted: true,
        response: this.createResponse(stored.bytes, start, end, stored.totalSize, url),
        bytes: stored.bytes,
        totalSize: stored.totalSize,
      };
    }
    this.emitDiagnostic('bank.serve', {
      source: scrubUrl(url),
      start,
      end,
      result: 'fetch',
      reason: stored === undefined ? 'store_read_timeout' : stored?.hit === false ? 'stored_range_missing' : 'store_unavailable',
    });
    const fetched = await this.fetchForeground({
      resourceKey,
      url,
      credentials: state.credentials,
      start,
      end,
      totalSize: state.totalSize || stored?.totalSize,
      signal,
      videoKey: state.videoKey,
    });
    if (signal?.aborted) throw abortError();
    if (fetched.response !== undefined) return { intercepted: true, response: fetched.response };
    state.totalSize = fetched.totalSize;
    return {
      intercepted: true,
      response: this.createResponse(fetched.bytes, start, end, fetched.totalSize, url),
      bytes: fetched.bytes,
      totalSize: fetched.totalSize,
    };
  }

  async fetchForeground({ resourceKey, url, credentials, start, end, totalSize, signal, videoKey }) {
    const plans = planFetchRanges(start, end, {
      chunkBytes: this.config.chunkBytes,
      totalSize,
      bankKeyValue: resourceKey,
      aligned: false,
    });
    const results = await Promise.all(plans.map((plan) => this.getTask(plan, {
      kind: 'foreground',
      url,
      credentials,
      signal,
      videoKey,
    })));
    const httpError = results.find((result) => result.response !== undefined);
    if (httpError !== undefined) return httpError;
    const total = results.find((result) => Number.isSafeInteger(result.totalSize))?.totalSize;
    if (!Number.isSafeInteger(total) || total <= end) throw new BankFallbackError('媒体网络响应缺少有效总长度');
    const bytes = new Uint8Array(rangeLength({ start, end }));
    const covered = new Uint8Array(bytes.byteLength);
    for (const result of results) {
      const resultStart = result.start;
      const resultEnd = result.start + result.bytes.byteLength - 1;
      const copyStart = Math.max(start, resultStart);
      const copyEnd = Math.min(end, resultEnd);
      if (copyEnd < copyStart) continue;
      const source = new Uint8Array(result.bytes);
      bytes.set(
        source.subarray(copyStart - resultStart, copyEnd - resultStart + 1),
        copyStart - start,
      );
      covered.fill(1, copyStart - start, copyEnd - start + 1);
    }
    if (covered.some((value) => value !== 1)) throw new BankFallbackError('媒体网络响应没有覆盖请求区间');
    return { bytes: bytes.buffer, start, end, totalSize: total };
  }

  getTask(plan, { kind, url, credentials, signal, videoKey }) {
    const existing = this.inflight.get(plan.cacheKey);
    if (existing !== undefined) {
      if (existing.start <= plan.start && existing.end >= plan.end) {
        if (priorityFor(kind) < existing.priority) {
          existing.priority = priorityFor(kind);
          existing.kind = kind;
          this.queue.sort(compareQueueTasks);
        }
        return this.waitForTask(existing, signal);
      }
      return existing.promise
        .catch((error) => {
          if (kind === 'foreground' && existing.kind === 'prefetch' && !signal?.aborted) return undefined;
          throw error;
        })
        .then(() => this.getTask(plan, { kind, url, credentials, signal, videoKey }));
    }
    const controller = new AbortController();
    const task = {
      ...plan,
      bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf('#')),
      url,
      credentials,
      videoKey,
      kind,
      priority: priorityFor(kind),
      sequence: this.sequence,
      controller,
      started: false,
      waiters: 0,
      promise: undefined,
      resolve: undefined,
      reject: undefined,
    };
    this.sequence += 1;
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    this.inflight.set(plan.cacheKey, task);
    insertQueueTask(this.queue, task);
    if (kind === 'foreground' && this.activeTasks.size >= this.maxConcurrency) this.abortOnePrefetch();
    this.pump();
    return this.waitForTask(task, signal);
  }

  waitForTask(task, signal) {
    task.waiters += 1;
    return waitWithSignal(task.promise, signal, this.windowObject).finally(() => {
      task.waiters -= 1;
      if (signal !== undefined && signal.aborted && task.waiters === 0 && task.kind === 'foreground') {
        task.controller.abort();
      }
    });
  }

  abortOnePrefetch() {
    const task = [...this.activeTasks].find((candidate) => candidate.kind === 'prefetch');
    task?.controller.abort();
  }

  pump() {
    while (this.activeTasks.size < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task.controller.signal.aborted) {
        task.reject(abortError());
        this.inflight.delete(task.cacheKey);
        continue;
      }
      task.started = true;
      this.activeTasks.add(task);
      void this.runTask(task)
        .then((result) => task.resolve(result), (error) => task.reject(error))
        .finally(() => {
          this.activeTasks.delete(task);
          if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
          this.pump();
        });
    }
  }

  async runTask(task) {
    const startedAt = performanceNow(this.windowObject);
    let response;
    try {
      response = await this.nativeFetch.call(this.windowObject, task.url, {
        headers: { Range: `bytes=${task.start}-${task.end}` },
        credentials: task.credentials,
        signal: task.controller.signal,
      });
    } catch (error) {
      const result = isAbortError(error) ? 'aborted' : 'network_error';
      this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, result);
      if (isAbortError(error)) throw error;
      throw new BankNetworkError('媒体分片网络取数失败', error);
    }
    if (response.status < 200 || response.status >= 300) {
      this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, 'http_error');
      return { response };
    }
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (isAbortError(error)) {
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, 'aborted');
        throw error;
      }
      this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, 'network_error');
      throw new BankNetworkError('媒体分片响应读取失败', error);
    }
    const contentRange = parseContentRange(headerValue(response.headers, 'Content-Range'));
    if (contentRange === undefined || contentRange.start !== task.start || contentRange.end !== task.end) {
      this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, 'invalid_response');
      throw new BankFallbackError('媒体分片网络 Content-Range 不匹配');
    }
    if (bytes.byteLength !== rangeLength(task)) {
      this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, 'invalid_response');
      throw new BankFallbackError('媒体分片网络字节长度不匹配');
    }
    const result = {
      start: task.start,
      end: task.end,
      bytes,
      totalSize: contentRange.totalSize,
    };
    this.rememberMemoryRange(task.bankKey, result);
    this.persistTask(task, result);
    this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, 'fetched');
    return result;
  }

  emitChunkDiagnostic(task, bytes, durationMs, result) {
    this.emitDiagnostic('bank.fetch.chunk', {
      source: scrubUrl(task.url),
      chunkIndex: task.chunkIndex,
      bytes,
      durationMs,
      priority: task.kind,
      result,
    });
  }

  persistTask(task, result) {
    if (this.rangeIsCovered(this.knownStoredRanges, task.cacheKey, result.start, result.end)
      || this.rangeIsCovered(this.pendingStoreRanges, task.cacheKey, result.start, result.end)) return;
    this.rememberRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
    const storedBytes = result.bytes.slice(0);
    const currentByteByBank = Object.fromEntries(
      [...this.resourceState.entries()]
        .filter(([, state]) => Number.isFinite(state.lastForegroundEnd))
        .map(([key, state]) => [key, state.lastForegroundEnd]),
    );
    const currentByteByVideo = Object.fromEntries(
      [...this.resourceState.values()]
        .filter((state) => Number.isFinite(state.lastForegroundEnd))
        .map((state) => [state.videoKey, state.lastForegroundEnd]),
    );
    let write;
    try {
      write = this.storeClient.writeChunk({
        bankKey: task.bankKey,
        videoKey: task.videoKey,
        start: result.start,
        end: result.end,
        totalSize: result.totalSize,
        bytes: storedBytes,
        currentByteByBank,
        currentByteByVideo,
      });
    } catch (error) {
      this.forgetRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
      this.forgetMemoryRange(task.bankKey, result.start, result.end);
      console.error('[BilibiliBuffer] 媒体分片异步落盘失败', error);
      return;
    }
    void Promise.resolve(write).then((writeResult) => {
      this.rememberRange(this.knownStoredRanges, task.cacheKey, result.start, result.end);
      this.forgetMemoryRange(task.bankKey, result.start, result.end);
      for (const record of writeResult?.records || []) {
        this.knownStoredRanges.delete(record.cacheKey);
      }
      if (writeResult?.evictedBytes > 0) {
        this.emitDiagnostic('bank.evict', {
          bytes: writeResult.evictedBytes,
          reason: writeResult.reason || 'limit',
        });
      }
    }).catch((error) => {
      this.forgetMemoryRange(task.bankKey, result.start, result.end);
      console.error('[BilibiliBuffer] 媒体分片异步落盘失败', error);
    }).finally(() => {
      this.forgetRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
    });
  }

  async prefetch() {
    if (!this.isEnabled()) {
      this.abortPrefetchTasks();
      return;
    }
    if (!isVideoLocation(this.windowObject.location)) {
      this.abortPrefetchTasks();
      return;
    }
    const bitrate = this.updatePlaybackSample();
    if (bitrate <= 0) return;
    for (const state of this.resourceState.values()) {
      if (!this.recentResourceKeys.includes(state.bankKey)) continue;
      if (state.latestUrl === undefined || !Number.isSafeInteger(state.totalSize) || !Number.isSafeInteger(state.lastForegroundEnd)) {
        continue;
      }
      const start = Math.max(
        state.lastForegroundEnd + 1,
        (chunkIndex(state.lastForegroundEnd, this.config.chunkBytes) + 1) * this.config.chunkBytes,
      );
      const range = prefetchRange({
        start,
        bitrate,
        aheadSeconds: this.config.prefetchAheadSeconds,
        totalSize: state.totalSize,
      });
      if (range === undefined || range.end <= (state.prefetchEnd ?? -1)) continue;
      state.prefetchEnd = range.end;
      const plans = planFetchRanges(range.start, range.end, {
        chunkBytes: this.config.chunkBytes,
        totalSize: state.totalSize,
        bankKeyValue: state.bankKey,
        aligned: true,
      });
      for (const plan of plans) {
        if (this.rangeIsCovered(this.knownStoredRanges, plan.cacheKey, plan.start, plan.end)
          || this.rangeIsCovered(this.pendingStoreRanges, plan.cacheKey, plan.start, plan.end)
          || this.inflight.has(plan.cacheKey)) continue;
        let stored;
        try {
          stored = await this.readStoredRange(state.bankKey, plan.start, plan.end);
        } catch (error) {
          console.error('[BilibiliBuffer] 媒体分片预取读取存储失败', error);
        }
        if (stored?.hit === true) {
          this.rememberRange(this.knownStoredRanges, plan.cacheKey, plan.start, plan.end);
          continue;
        }
        if (this.inflight.has(plan.cacheKey)) continue;
        void this.getTask(plan, {
          kind: 'prefetch',
          url: state.latestUrl,
          credentials: state.credentials,
          videoKey: state.videoKey,
        }).catch((error) => {
          if (!isAbortError(error)) console.error('[BilibiliBuffer] 媒体分片投机预取失败', error);
        });
      }
      this.pump();
    }
  }

  destroy() {
    if (this.prefetchTimer !== undefined) this.windowObject.clearInterval(this.prefetchTimer);
    for (const task of this.inflight.values()) task.controller.abort();
    this.storeClient.destroy();
  }
}

export function installSegmentBank(windowObject = window) {
  if (!windowObject.location) throw new Error('媒体分片页面位置不可用');
  if (windowObject.__smoothSegmentBank !== undefined) return windowObject.__smoothSegmentBank;
  if (!windowObject.fetch || !windowObject.XMLHttpRequest) throw new Error('页面网络 API 不可用');
  const originalFetch = windowObject.fetch;
  const originalXMLHttpRequest = windowObject.XMLHttpRequest;
  const bank = new SegmentBank({ windowObject, nativeFetch: originalFetch });
  windowObject.fetch = function smoothSegmentBankFetch(...args) {
    return bank.handleFetch(this, args, originalFetch);
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: originalXMLHttpRequest,
    bank,
  });
  const marker = {
    bank,
    installed: true,
    setEnabled(enabled) { bank.enabled = enabled === true; },
    destroy() {
      windowObject.fetch = originalFetch;
      windowObject.XMLHttpRequest = originalXMLHttpRequest;
      bank.destroy();
      delete windowObject.__smoothSegmentBank;
    },
  };
  windowObject.__smoothSegmentBank = marker;
  return marker;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const locationObject = window.location;
  if (locationObject !== undefined && locationObject.hostname === 'www.bilibili.com') {
    installSegmentBank(window);
  }
}
