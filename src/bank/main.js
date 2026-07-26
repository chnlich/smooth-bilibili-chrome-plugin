import { BANK_CONFIG } from '../constants.js';
import { scrubUrl } from '../diagnostics/privacy.js';
import { BankFallbackError, BankNetworkError } from './errors.js';
import {
  BANK_ENABLED_ATTRIBUTE,
  BANK_DIAGNOSTIC_MESSAGE_TYPE,
  BANK_MESSAGE_NAMESPACE,
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
import {
  clearMemory,
  enforceMemoryLimit,
  readMemoryRange,
  writeMemoryChunk,
} from './storage.js';
import { createBankXMLHttpRequestClass } from './xhr.js';

const MAX_CONCURRENCY = 3;

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error) {
  return error?.name === 'AbortError';
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

function waitWithSignal(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class SegmentBank {
  constructor({
    windowObject = window,
    nativeFetch = windowObject.fetch,
    maxConcurrency = MAX_CONCURRENCY,
    config = BANK_CONFIG,
    chunks = new Map(),
    now = Date.now,
  } = {}) {
    this.windowObject = windowObject;
    this.nativeFetch = nativeFetch;
    this.config = config;
    this.maxConcurrency = maxConcurrency;
    this.now = now;
    this.enabled = true;
    this.disabled = false;
    this.queue = [];
    this.inflight = new Map();
    this.activeTasks = new Set();
    this.sequence = 0;
    this.sessionGeneration = 0;
    this.resourceState = new Map();
    this.recentResourceKeys = [];
    this.chunks = chunks;
    this.fetchedChunks = new Map();
    this.refetchCounts = new Map();
    this.lastRouteWasVideo = this.windowObject.location === undefined
      || isVideoLocation(this.windowObject.location);
    this.prefetchTimer = this.windowObject.setInterval?.(() => {
      void this.prefetch().catch((error) => {
        console.error('[BilibiliBuffer] 媒体分片预取失败', error);
      });
    }, 1000);
  }

  isEnabled() {
    if (this.disabled) return false;
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
      type: BANK_DIAGNOSTIC_MESSAGE_TYPE,
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

  cacheKeyForRange(resourceKey, start) {
    return cacheKey(resourceKey, chunkIndex(start, this.config.chunkBytes));
  }

  currentByteByBank() {
    return Object.fromEntries(
      [...this.resourceState.entries()]
        .filter(([, state]) => Number.isSafeInteger(state.lastForegroundEnd))
        .map(([key, state]) => [key, state.lastForegroundEnd]),
    );
  }

  releaseSession() {
    this.sessionGeneration += 1;
    this.abortPrefetchTasks();
    for (const task of this.queue) {
      if (task.kind !== 'prefetch') continue;
      task.controller.abort();
      task.reject(abortError());
      if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
    }
    this.queue = this.queue.filter((task) => task.kind !== 'prefetch');
    clearMemory(this.chunks);
    this.fetchedChunks.clear();
    this.refetchCounts.clear();
    this.resourceState.clear();
    this.recentResourceKeys = [];
    this.playbackSamples = [];
  }

  syncRouteLifecycle() {
    if (this.windowObject.location === undefined) return true;
    const currentIsVideo = isVideoLocation(this.windowObject.location);
    if (!currentIsVideo) {
      if (this.lastRouteWasVideo) this.releaseSession();
      this.lastRouteWasVideo = false;
      return false;
    }
    this.lastRouteWasVideo = true;
    return true;
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
    if (!this.syncRouteLifecycle()) {
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

  readStoredRange(bankKeyValue, start, end) {
    return readMemoryRange(this.chunks, bankKeyValue, start, end, this.config.chunkBytes);
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

  serveRequest({ url, method, headers, credentials, signal }) {
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
    const stored = this.readStoredRange(resourceKey, start, end);
    if (signal?.aborted) throw abortError();
    if (stored?.hit === true) {
      if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== rangeLength({ start, end })) {
        throw new BankFallbackError('媒体分片存储命中长度不符');
      }
      if (!Number.isSafeInteger(stored.totalSize) || stored.totalSize <= end) {
        throw new BankFallbackError('媒体分片存储命中总长度无效');
      }
      state.totalSize = stored.totalSize;
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
      reason: 'stored_range_missing',
    });
    return this.fetchForeground({
      resourceKey,
      url,
      credentials: state.credentials,
      start,
      end,
      totalSize: state.totalSize || stored?.totalSize,
      signal,
      videoKey: state.videoKey,
    }).then((fetched) => {
      if (signal?.aborted) throw abortError();
      if (fetched.response !== undefined) return { intercepted: true, response: fetched.response };
      state.totalSize = fetched.totalSize;
      return {
        intercepted: true,
        response: this.createResponse(fetched.bytes, start, end, fetched.totalSize, url),
        bytes: fetched.bytes,
        totalSize: fetched.totalSize,
      };
    });
  }

  async fetchForeground({ resourceKey, url, credentials, start, end, totalSize, signal, videoKey }) {
    const plans = planFetchRanges(start, end, {
      chunkBytes: this.config.chunkBytes,
      totalSize,
      bankKeyValue: resourceKey,
      aligned: true,
    });
    const results = await Promise.all(plans.map((plan) => {
      const stored = readMemoryRange(
        this.chunks,
        resourceKey,
        plan.start,
        plan.end,
        this.config.chunkBytes,
      );
      if (stored.hit === true) {
        return {
          start: plan.start,
          end: plan.end,
          bytes: stored.bytes,
          totalSize: stored.totalSize,
        };
      }
      return this.getTask(plan, {
        kind: 'foreground',
        url,
        credentials,
        signal,
        videoKey,
      });
    }));
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

  disable(reason) {
    if (this.disabled) return;
    this.disabled = true;
    this.enabled = false;
    this.abortPrefetchTasks();
    const retained = [];
    for (const task of this.queue) {
      if (task.kind !== 'prefetch') {
        retained.push(task);
        continue;
      }
      task.controller.abort();
      task.reject(abortError());
      if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
    }
    this.queue = retained;
    this.emitDiagnostic('bank.disabled', { reason });
  }

  noteRefetch(plan) {
    if (plan.cacheable === false || !this.fetchedChunks.has(plan.cacheKey)) return;
    const count = (this.refetchCounts.get(plan.cacheKey) || 0) + 1;
    this.refetchCounts.set(plan.cacheKey, count);
    if (count >= this.config.refetchAlarmCount) this.disable('refetch_alarm');
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
    if (kind === 'prefetch' && plan.cacheable !== false
      && (this.fetchedChunks.has(plan.cacheKey) || this.chunks.has(plan.cacheKey))) {
      return Promise.resolve({ skipped: true, cacheKey: plan.cacheKey });
    }
    if (kind === 'foreground') this.noteRefetch(plan);
    const controller = new AbortController();
    const task = {
      ...plan,
      bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf('#')),
      url,
      credentials,
      videoKey,
      kind,
      sessionGeneration: this.sessionGeneration,
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
    return waitWithSignal(task.promise, signal).finally(() => {
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
    if (task.controller.signal.aborted) {
      this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, 'aborted');
      throw abortError();
    }
    const result = {
      start: task.start,
      end: task.end,
      bytes,
      totalSize: contentRange.totalSize,
    };
    if (task.cacheable !== false && task.sessionGeneration === this.sessionGeneration
      && this.enabled === true && this.disabled === false) {
      this.fetchedChunks.set(task.cacheKey, { fetchedAt: this.now() });
      try {
        this.storeTask(task, result);
      } catch (error) {
        this.emitDiagnostic('bank.store', {
          operation: 'write',
          chunkIndex: task.chunkIndex,
          bytes: bytes.byteLength,
          result: 'failed',
          reason: 'write_error',
        });
        console.error('[BilibiliBuffer] 媒体分片内存写入失败', error);
        this.disable('store_write_failed');
      }
    }
    this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, 'fetched');
    return result;
  }

  emitChunkDiagnostic(task, bytes, durationMs, result) {
    this.emitDiagnostic('bank.fetch.chunk', {
      source: scrubUrl(task.url),
      chunkIndex: task.chunkIndex,
      start: task.start,
      end: task.end,
      bytes,
      durationMs,
      priority: task.kind,
      result,
    });
  }

  storeTask(task, result) {
    const previous = this.chunks.get(task.cacheKey);
    try {
      const written = writeMemoryChunk({
        chunks: this.chunks,
        bankKey: task.bankKey,
        start: result.start,
        end: result.end,
        totalSize: result.totalSize,
        bytes: result.bytes,
        chunkBytes: this.config.chunkBytes,
        storedAt: this.now(),
      });
      const eviction = enforceMemoryLimit({
        chunks: this.chunks,
        maxBankBytes: this.config.maxBankBytes,
        chunkBytes: this.config.chunkBytes,
        currentByteByBank: this.currentByteByBank(),
      });
      this.emitDiagnostic('bank.store', {
        operation: 'write',
        chunkIndex: written.chunkIndex,
        bytes: written.bytes,
        result: 'stored',
        reason: 'memory',
      });
      for (const entry of eviction.entries) {
        this.fetchedChunks.delete(entry.cacheKey);
        this.refetchCounts.delete(entry.cacheKey);
        this.emitDiagnostic('bank.store', {
          operation: 'evict',
          chunkIndex: entry.chunkIndex,
          bytes: entry.byteLength,
          result: 'evicted',
          reason: eviction.reason,
        });
      }
      if (eviction.bytes > 0) {
        this.emitDiagnostic('bank.evict', {
          bytes: eviction.bytes,
          reason: eviction.reason,
        });
      }
      return eviction;
    } catch (error) {
      if (previous === undefined) this.chunks.delete(task.cacheKey);
      else this.chunks.set(task.cacheKey, previous);
      throw error;
    }
  }

  async prefetch() {
    if (!this.syncRouteLifecycle()) {
      this.abortPrefetchTasks();
      return;
    }
    if (!this.isEnabled()) {
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
        if (plan.cacheable !== false && (this.chunks.has(plan.cacheKey) || this.fetchedChunks.has(plan.cacheKey))) continue;
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
    for (const task of this.queue) task.reject(abortError());
    this.queue = [];
    this.releaseSession();
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
    setEnabled(enabled) {
      if (!bank.disabled) bank.enabled = enabled === true;
    },
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
