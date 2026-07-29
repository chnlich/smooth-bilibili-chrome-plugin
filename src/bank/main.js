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
  headerValue,
  parseContentRange,
  partialResponseHeaders,
  planFetchRanges,
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

const MAX_PREFETCH_CONCURRENCY = 2;

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function performanceNow(windowObject) {
  return typeof windowObject.performance?.now === 'function' ? windowObject.performance.now() : Date.now();
}

function mirrorForUrl(url) {
  return new URL(url).hostname;
}

function videoIdentityFor(locationObject) {
  if (locationObject === undefined) return undefined;
  return `${locationObject.pathname}${locationObject.search || ''}`;
}

function playurlRepresentationUrls(value) {
  if (value === null || typeof value !== 'object' || typeof value.baseUrl !== 'string') return undefined;
  const backupUrls = Array.isArray(value.backupUrl)
    ? value.backupUrl.filter((url) => typeof url === 'string')
    : [];
  return [value.baseUrl, ...backupUrls].slice(0, 4);
}

function visitPlayurlRepresentations(value, callback) {
  if (value === null || typeof value !== 'object') return;
  const urls = playurlRepresentationUrls(value);
  if (urls !== undefined) callback(urls);
  for (const child of Object.values(value)) visitPlayurlRepresentations(child, callback);
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

export class SegmentBank {
  constructor({
    windowObject = window,
    nativeFetch = windowObject.fetch,
    maxPrefetchConcurrency = MAX_PREFETCH_CONCURRENCY,
    config = BANK_CONFIG,
    chunks = new Map(),
    now = Date.now,
  } = {}) {
    this.windowObject = windowObject;
    this.nativeFetch = nativeFetch;
    this.config = config;
    this.maxPrefetchConcurrency = maxPrefetchConcurrency;
    this.now = now;
    this.enabled = true;
    this.disabled = false;
    this.queue = [];
    this.inflight = new Map();
    this.activePrefetch = new Set();
    this.sessionGeneration = 0;
    this.resourceState = new Map();
    this.recentResourceKeys = [];
    this.addressBook = new Map();
    this.videoIdentity = videoIdentityFor(this.windowObject.location);
    this.chunks = chunks;
    this.lastRouteWasVideo = this.windowObject.location === undefined
      || isVideoLocation(this.windowObject.location);
    this.observePlayurlData(this.windowObject.__playinfo__);
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
        lastForegroundStart: undefined,
        lastForegroundEnd: undefined,
        outstanding: new Set(),
        chunkAttempts: new Map(),
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
      task.controller.abort();
      task.settled = true;
      task.reject(abortError());
      if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
    }
    this.queue = [];
    clearMemory(this.chunks);
    this.resourceState.clear();
    this.recentResourceKeys = [];
    this.addressBook.clear();
  }

  syncRouteLifecycle() {
    if (this.windowObject.location === undefined) return true;
    const currentIsVideo = isVideoLocation(this.windowObject.location);
    if (!currentIsVideo) {
      if (this.lastRouteWasVideo) this.releaseSession();
      this.lastRouteWasVideo = false;
      this.videoIdentity = undefined;
      return false;
    }
    const currentVideoIdentity = videoIdentityFor(this.windowObject.location);
    if (this.lastRouteWasVideo && this.videoIdentity !== currentVideoIdentity) this.releaseSession();
    this.videoIdentity = currentVideoIdentity;
    this.lastRouteWasVideo = true;
    return true;
  }

  touchResource(resourceKey) {
    const nextKeys = [
      ...this.recentResourceKeys.filter((key) => key !== resourceKey),
      resourceKey,
    ].slice(-2);
    this.recentResourceKeys = nextKeys;
  }

  abortPrefetchTasks(predicate = () => true) {
    for (const task of this.inflight.values()) {
      if (predicate(task)) {
        this.clearTaskStall(task);
        task.controller.abort();
      }
    }
  }

  requestClassification(url, headers) {
    return classifyRequest({
      url,
      headers,
      enabled: this.isEnabled(),
      locationObject: this.windowObject.location,
    });
  }

  isPlayurlUrl(url) {
    return new URL(url).pathname.endsWith('/playurl');
  }

  async observePlayurlResponse(response) {
    const clone = response.clone();
    const data = await clone.json();
    this.observePlayurlData(data);
  }

  observePlayurlText(responseText) {
    try {
      this.observePlayurlData(JSON.parse(responseText));
    } catch (error) {
      console.error('[BilibiliBuffer] playurl 地址簿解析失败');
    }
  }

  observePlayurlData(data) {
    if (data === undefined || data === null) return;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (error) {
        console.error('[BilibiliBuffer] __playinfo__ 地址簿解析失败');
        return;
      }
    }
    const observedAt = this.now();
    visitPlayurlRepresentations(data, (urls) => {
      try {
        const parsedUrls = urls.map((url) => new URL(url));
        const pathname = parsedUrls[0].pathname;
        this.addressBook.set(pathname, { urls, observedAt });
      } catch (error) {
        console.error('[BilibiliBuffer] playurl 地址簿 URL 无效');
      }
    });
  }

  pairUrlFor(url) {
    const playerUrl = new URL(url);
    const entry = this.addressBook.get(playerUrl.pathname);
    if (entry === undefined || this.now() - entry.observedAt > this.config.pairFreshnessMs) return undefined;
    for (const candidateUrl of entry.urls) {
      const candidate = new URL(candidateUrl);
      if (candidate.hostname === playerUrl.hostname) continue;
      if (candidate.pathname !== playerUrl.pathname) return undefined;
      return candidateUrl;
    }
    return undefined;
  }

  createTaskLeg(task, slot, url) {
    return {
      slot,
      url,
      mirror: mirrorForUrl(url),
      reader: undefined,
      stallTimer: undefined,
      startedAt: undefined,
      ttfbAt: undefined,
      byteCount: 0,
      abortReported: false,
      outcome: undefined,
      controller: new AbortController(),
      settled: false,
      abortReason: undefined,
    };
  }

  buildTaskLegs(task) {
    const urls = [task.url];
    if (this.config.raceLegs > 1) {
      const pairUrl = this.pairUrlFor(task.url);
      if (pairUrl !== undefined) urls.push(pairUrl);
    }
    task.legs = urls.map((url, slot) => this.createTaskLeg(task, slot, url));
    if (task.controller.signal.aborted) {
      for (const leg of task.legs) leg.controller.abort();
    }
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
          mirror: mirrorForUrl(request.url),
          result: 'pass',
          reason: classification.reason,
        });
      }
      const response = await originalFetch.apply(thisArg, args);
      if (this.isPlayurlUrl(request.url)) {
        void this.observePlayurlResponse(response).catch((error) => {
          console.error('[BilibiliBuffer] playurl 地址簿读取失败');
        });
      }
      return response;
    }
    try {
      const served = await this.serveRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
        credentials: request.credentials,
        signal: request.signal,
      });
      if (!served.intercepted) {
        return originalFetch.apply(thisArg, args);
      }
      try {
        return served.response;
      } finally {
        served.release?.();
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof BankNetworkError) {
        console.error('[BilibiliBuffer] 媒体分片前台取数失败', error);
        throw error;
      }
      if (error instanceof BankFallbackError) {
        this.emitDiagnostic('bank.serve', {
          source: scrubUrl(request.url),
          mirror: mirrorForUrl(request.url),
          start: classification.range.start,
          end: classification.range.end,
          result: 'pass',
          reason: 'internal_fallback',
        });
        return originalFetch.apply(thisArg, args);
      }
      console.error('[BilibiliBuffer] 媒体分片供数失败', error);
      this.emitDiagnostic('bank.serve', {
        source: scrubUrl(request.url),
        mirror: mirrorForUrl(request.url),
        result: 'pass',
        reason: 'internal_error',
      });
      return originalFetch.apply(thisArg, args);
    }
  }

  readStoredRange(bankKeyValue, start, end) {
    return readMemoryRange(this.chunks, bankKeyValue, start, end, this.config.chunkBytes);
  }

  recordTotalSize(url, totalSize) {
    this.stateFor(bankKey(url)).totalSize = totalSize;
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
    const startedAt = performanceNow(this.windowObject);
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
    state.lastForegroundStart = start;
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
      this.scheduleResourceWindow(state);
      const response = this.createResponse(stored.bytes, start, end, stored.totalSize, url);
      this.emitDiagnostic('bank.serve', {
        source: scrubUrl(url),
        mirror: mirrorForUrl(url),
        start,
        end,
        durationMs: performanceNow(this.windowObject) - startedAt,
        result: 'hit',
        reason: 'stored_range',
      });
      return {
        intercepted: true,
        response,
        bytes: stored.bytes,
        totalSize: stored.totalSize,
      };
    }

    const requestPlans = planFetchRanges(start, end, {
      chunkBytes: this.config.chunkBytes,
      totalSize: state.totalSize,
      bankKeyValue: resourceKey,
    });
    const missingPlans = requestPlans.filter((plan) => !this.chunks.has(plan.cacheKey));
    const gaveUpPlans = missingPlans.filter((plan) => {
      const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
      return attempts >= this.config.maxChunkAttempts;
    });
    const foreground = { start, end, state, completed: false };
    state.outstanding.add(foreground);
    const completeOnAbort = () => this.completeForegroundRequest(foreground);
    signal?.addEventListener('abort', completeOnAbort, { once: true });
    try {
      if (gaveUpPlans.length > 0) {
        for (const plan of gaveUpPlans) {
          this.emitTaskChunkDiagnostic(
            { ...plan, url, kind: 'foreground' },
            0,
            0,
            'gave_up',
          );
        }
        for (const plan of missingPlans) state.chunkAttempts.delete(plan.chunkIndex);
        throw new BankNetworkError('媒体分片连续取数失败，已达到尝试上限');
      }
      for (const plan of missingPlans) state.chunkAttempts.delete(plan.chunkIndex);
      this.scheduleResourceWindow(state);
      await Promise.all(missingPlans.map((plan) => this.getTask(plan, {
        kind: 'foreground',
        url,
        credentials: state.credentials,
        videoKey: state.videoKey,
      })));
      if (signal?.aborted) throw abortError();
      const supplied = this.readStoredRange(resourceKey, start, end);
      if (supplied?.hit !== true) {
        throw new BankNetworkError('媒体分片取数完成后未找到完整分片');
      }
      if (!(supplied.bytes instanceof ArrayBuffer)
        || supplied.bytes.byteLength !== rangeLength({ start, end })) {
        throw new BankFallbackError('媒体分片供数长度不符');
      }
      if (!Number.isSafeInteger(supplied.totalSize) || supplied.totalSize <= end) {
        throw new BankFallbackError('媒体分片供数总长度无效');
      }
      state.totalSize = supplied.totalSize;
      const response = this.createResponse(supplied.bytes, start, end, supplied.totalSize, url);
      this.emitDiagnostic('bank.serve', {
        source: scrubUrl(url),
        mirror: mirrorForUrl(url),
        start,
        end,
        durationMs: performanceNow(this.windowObject) - startedAt,
        result: 'hit',
        reason: 'fetched_range',
      });
      return {
        intercepted: true,
        response,
        bytes: supplied.bytes,
        totalSize: supplied.totalSize,
        release: () => {
          signal?.removeEventListener('abort', completeOnAbort);
          this.completeForegroundRequest(foreground);
        },
      };
    } catch (error) {
      signal?.removeEventListener('abort', completeOnAbort);
      this.completeForegroundRequest(foreground, false);
      throw error;
    }
  }

  completeForegroundRequest(request, schedule = true) {
    if (request.completed) return;
    request.completed = true;
    request.state.outstanding.delete(request);
    if (schedule && this.resourceState.get(request.state.bankKey) === request.state) {
      this.scheduleResourceWindow(request.state);
    }
  }

  anchorChunkForState(state) {
    const outstanding = [...state.outstanding];
    if (outstanding.length > 0) {
      return Math.min(...outstanding.map((request) => chunkIndex(request.start, this.config.chunkBytes)));
    }
    if (!Number.isSafeInteger(state.lastForegroundStart)) return undefined;
    return chunkIndex(state.lastForegroundStart, this.config.chunkBytes);
  }

  windowPlansForState(state, anchorChunk) {
    const start = anchorChunk * this.config.chunkBytes;
    const end = (anchorChunk + this.config.lookAheadChunks) * this.config.chunkBytes - 1;
    return planFetchRanges(start, end, {
      chunkBytes: this.config.chunkBytes,
      totalSize: state.totalSize,
      bankKeyValue: state.bankKey,
    });
  }

  supersedeTasksBefore(bankKeyValue, anchorChunk) {
    for (const task of this.inflight.values()) {
      if (task.bankKey !== bankKeyValue || task.chunkIndex >= anchorChunk || task.controller.signal.aborted) continue;
      task.abortReason = 'superseded';
      this.clearTaskStall(task);
      task.controller.abort();
    }
  }

  scheduleResourceWindow(state) {
    if (!this.isEnabled()) return;
    const anchorChunk = this.anchorChunkForState(state);
    if (anchorChunk === undefined || state.latestUrl === undefined) return;
    this.supersedeTasksBefore(state.bankKey, anchorChunk);
    const candidates = this.windowPlansForState(state, anchorChunk).filter((plan) => {
      if (this.chunks.has(plan.cacheKey)) return false;
      const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
      return attempts < this.config.maxChunkAttempts;
    });
    for (const plan of candidates.slice(0, this.maxPrefetchConcurrency)) {
      if (this.inflight.has(plan.cacheKey)) continue;
      void this.getTask(plan, {
        kind: 'prefetch',
        url: state.latestUrl,
        credentials: state.credentials,
        videoKey: state.videoKey,
      }).catch((error) => {
        if (isAbortError(error) || error instanceof BankNetworkError || error instanceof BankFallbackError) return;
        throw error;
      });
    }
    this.pump();
  }

  disable(reason) {
    if (this.disabled) return;
    this.disabled = true;
    this.enabled = false;
    this.abortPrefetchTasks();
    for (const task of this.queue) {
      task.controller.abort();
      task.settled = true;
      task.reject(abortError());
      if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
    }
    this.queue = [];
    this.emitDiagnostic('bank.disabled', { reason });
  }

  clearLegStall(leg) {
    if (leg.stallTimer !== undefined) {
      this.windowObject.clearTimeout(leg.stallTimer);
      leg.stallTimer = undefined;
    }
    leg.reader = undefined;
  }

  clearTaskStall(task) {
    for (const leg of task.legs) this.clearLegStall(leg);
  }

  armLegStall(task, leg) {
    if (leg.stallTimer !== undefined) this.windowObject.clearTimeout(leg.stallTimer);
    leg.stallTimer = this.windowObject.setTimeout(() => {
      if (task.settled || leg.settled || leg.controller.signal.aborted) return;
      leg.abortReason = 'stalled';
      leg.controller.abort();
      if (leg.reader !== undefined) {
        void leg.reader.cancel().catch((error) => {
          if (!isAbortError(error)) console.error('[BilibiliBuffer] 停滞媒体分片读取取消失败', error);
        });
      }
    }, this.config.stallMs);
  }

  emitTaskAbortDiagnostic(task, leg, bytes, durationMs, result) {
    if (leg.abortReported === true) return;
    leg.abortReported = true;
    this.emitChunkDiagnostic(task, leg, bytes, durationMs, result);
  }

  taskAbortError(task, leg, error) {
    const result = task.abortReason === 'superseded'
      ? 'superseded'
      : leg.abortReason === 'stalled' ? 'stalled' : 'aborted';
    this.emitTaskAbortDiagnostic(
      task,
      leg,
      leg.byteCount,
      performanceNow(this.windowObject) - leg.startedAt,
      result,
    );
    return error;
  }

  recordTaskFailure(task, error) {
    if (task.sessionGeneration !== this.sessionGeneration) return;
    if (task.abortReason !== undefined && task.abortReason !== 'stalled') return;
    if (isAbortError(error) && task.abortReason !== 'stalled'
      && !task.legs.some((leg) => leg.outcome === 'stalled')) return;
    const state = this.resourceState.get(task.bankKey);
    if (state === undefined) return;
    const attempts = state.chunkAttempts.get(task.chunkIndex) || 0;
    state.chunkAttempts.set(task.chunkIndex, attempts + 1);
  }

  resetTaskAttempts(task) {
    if (task.sessionGeneration !== this.sessionGeneration) return;
    const state = this.resourceState.get(task.bankKey);
    if (state !== undefined) state.chunkAttempts.delete(task.chunkIndex);
  }

  startTask(task) {
    task.started = true;
    this.activePrefetch.add(task);
    let succeeded = false;
    void this.runTask(task)
      .then((result) => {
        succeeded = true;
        if (!task.settled) {
          task.settled = true;
          task.resolve(result);
        }
      }, (error) => {
        this.recordTaskFailure(task, error);
        task.settled = true;
        task.reject(error);
      })
      .finally(() => {
        this.clearTaskStall(task);
        this.activePrefetch.delete(task);
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
        if (succeeded
          && task.sessionGeneration === this.sessionGeneration
          && this.recentResourceKeys.includes(task.bankKey)) {
          const state = this.resourceState.get(task.bankKey);
          if (state !== undefined) this.scheduleResourceWindow(state);
        }
        this.pump();
      });
  }

  getTask(plan, { kind, url, credentials, videoKey }) {
    const existing = this.inflight.get(plan.cacheKey);
    if (existing !== undefined) return existing.promise;
    if (this.chunks.has(plan.cacheKey)) {
      return Promise.resolve({ skipped: true, cacheKey: plan.cacheKey });
    }
    if (kind === 'foreground') {
      const state = this.stateFor(plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf('#')));
      const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
      if (attempts >= this.config.maxChunkAttempts) {
        this.emitTaskChunkDiagnostic({ ...plan, url, kind }, 0, 0, 'gave_up');
        return Promise.reject(new BankNetworkError('媒体分片连续取数失败，已达到尝试上限'));
      }
    }
    const controller = new AbortController();
    const task = {
      ...plan,
      bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf('#')),
      url,
      credentials,
      videoKey,
      kind,
      sessionGeneration: this.sessionGeneration,
      controller,
      started: false,
      abortReason: undefined,
      settled: false,
      legs: [],
      promise: undefined,
      resolve: undefined,
      reject: undefined,
    };
    controller.signal.addEventListener('abort', () => {
      for (const leg of task.legs) leg.controller.abort();
    }, { once: true });
    task.promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    this.inflight.set(plan.cacheKey, task);
    this.queue.push(task);
    this.pump();
    return task.promise;
  }

  pump() {
    while (this.activePrefetch.size < this.maxPrefetchConcurrency
      && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task.controller.signal.aborted) {
        if (task.abortReason === 'superseded') this.emitTaskChunkDiagnostic(task, 0, 0, 'superseded');
        task.settled = true;
        task.reject(abortError());
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
        continue;
      }
      this.startTask(task);
    }
  }

  async runLeg(task, leg) {
    leg.startedAt = performanceNow(this.windowObject);
    this.armLegStall(task, leg);
    try {
      let response;
      try {
        response = await this.nativeFetch.call(this.windowObject, leg.url, {
          headers: { Range: `bytes=${task.start}-${task.end}` },
          credentials: task.credentials,
          signal: leg.controller.signal,
        });
      } catch (error) {
        if (isAbortError(error) || leg.controller.signal.aborted) throw error;
        leg.outcome = 'network_error';
        throw new BankNetworkError('媒体分片网络取数失败', error);
      }
      if (leg.controller.signal.aborted) throw abortError();
      if (response.status < 200 || response.status >= 300) {
        leg.outcome = 'http_error';
        throw new BankNetworkError(`媒体分片网络响应状态无效: ${response.status}`);
      }
      const bodyChunks = [];
      try {
        const reader = response.body.getReader();
        leg.reader = reader;
        this.armLegStall(task, leg);
        while (true) {
          const read = await reader.read();
          if (read.done) break;
          const chunk = read.value.slice();
          if (chunk.byteLength > 0) {
            if (leg.ttfbAt === undefined) leg.ttfbAt = performanceNow(this.windowObject);
            bodyChunks.push(chunk);
            leg.byteCount += chunk.byteLength;
            this.armLegStall(task, leg);
          }
          if (leg.controller.signal.aborted) throw abortError();
        }
        if (leg.controller.signal.aborted) throw abortError();
      } catch (error) {
        if (isAbortError(error) || leg.controller.signal.aborted) throw error;
        leg.outcome = 'network_error';
        throw new BankNetworkError('媒体分片响应读取失败', error);
      }
      if (leg.controller.signal.aborted) throw abortError();
      const body = new Uint8Array(leg.byteCount);
      let offset = 0;
      for (const chunk of bodyChunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const bytes = body.buffer;
      const contentRange = parseContentRange(headerValue(response.headers, 'Content-Range'));
      const isCompleteTailChunk = contentRange !== undefined
        && contentRange.start === task.start
        && contentRange.end < task.end
        && contentRange.end === contentRange.totalSize - 1;
      if (contentRange === undefined || contentRange.start !== task.start
        || (contentRange.end !== task.end && !isCompleteTailChunk)) {
        leg.outcome = 'invalid_response';
        throw new BankFallbackError('媒体分片网络 Content-Range 不匹配');
      }
      const resultRange = { start: contentRange.start, end: contentRange.end };
      if (leg.byteCount !== rangeLength(resultRange)) {
        leg.outcome = 'invalid_response';
        throw new BankFallbackError('媒体分片网络字节长度不匹配');
      }
      if (leg.controller.signal.aborted) throw abortError();
      return {
        ...resultRange,
        bytes,
        totalSize: contentRange.totalSize,
      };
    } finally {
      this.clearLegStall(leg);
      leg.settled = true;
    }
  }

  classifyTaskFailure(task) {
    if (task.controller.signal.aborted) return abortError();
    // Preserve the single-leg stall error contract while a raced task keeps stalls leg-local.
    if (task.legs.length === 1 && task.legs[0].outcome === 'stalled') return abortError();
    if (task.legs.every((leg) => leg.outcome === 'invalid_response')) {
      return new BankFallbackError('媒体分片所有网络响应均无效');
    }
    return new BankNetworkError('媒体分片网络取数失败');
  }

  emitTaskChunkDiagnostic(task, bytes, durationMs, result, range = task) {
    this.emitChunkDiagnostic(task, {
      slot: 0,
      url: task.url,
      mirror: mirrorForUrl(task.url),
      byteCount: bytes,
      ttfbAt: undefined,
      startedAt: undefined,
      abortReported: false,
    }, bytes, durationMs, result, range);
  }

  async runTask(task) {
    this.buildTaskLegs(task);
    return new Promise((resolve, reject) => {
      let remaining = task.legs.length;
      for (const leg of task.legs) {
        const legPromise = this.runLeg(task, leg);
        void legPromise.catch(() => {});
        legPromise.then((result) => {
          if (task.settled) {
            leg.outcome = 'lost_race';
            this.emitChunkDiagnostic(
              task,
              leg,
              leg.byteCount,
              performanceNow(this.windowObject) - leg.startedAt,
              'lost_race',
              result,
            );
            return;
          }
          task.settled = true;
          for (const loser of task.legs) {
            if (loser === leg) continue;
            loser.abortReason = 'lost_race';
            loser.controller.abort();
          }
          for (const loser of task.legs) {
            if (loser === leg || loser.reader === undefined) continue;
            void loser.reader.cancel().catch((error) => {
              if (!isAbortError(error)) console.error('[BilibiliBuffer] 败选媒体分片读取取消失败', error);
            });
          }
          leg.outcome = 'fetched';
          if (task.sessionGeneration === this.sessionGeneration) {
            this.recordTotalSize(leg.url, result.totalSize);
            if (this.enabled === true && this.disabled === false) {
              try {
                this.storeTask(task, result);
              } catch (error) {
                this.emitDiagnostic('bank.store', {
                  operation: 'write',
                  chunkIndex: task.chunkIndex,
                  bytes: result.bytes.byteLength,
                  result: 'failed',
                  reason: 'write_error',
                });
                console.error('[BilibiliBuffer] 媒体分片内存写入失败', error);
                this.disable('store_write_failed');
              }
              this.resetTaskAttempts(task);
            }
          }
          this.emitChunkDiagnostic(
            task,
            leg,
            leg.byteCount,
            performanceNow(this.windowObject) - leg.startedAt,
            'fetched',
            result,
          );
          task.resolve(result);
          resolve(result);
        }, (error) => {
          if (task.settled) {
            leg.outcome = 'lost_race';
            this.emitChunkDiagnostic(
              task,
              leg,
              leg.byteCount,
              performanceNow(this.windowObject) - leg.startedAt,
              'lost_race',
            );
            return;
          }
          if (leg.abortReason === 'stalled' || task.controller.signal.aborted || isAbortError(error)) {
            leg.outcome = leg.abortReason === 'stalled' ? 'stalled' : 'aborted';
            this.taskAbortError(task, leg, error);
          } else {
            const result = leg.outcome || 'network_error';
            this.emitChunkDiagnostic(
              task,
              leg,
              leg.byteCount,
              performanceNow(this.windowObject) - leg.startedAt,
              result,
            );
          }
          remaining -= 1;
          if (remaining === 0) reject(this.classifyTaskFailure(task));
        });
      }
    });
  }

  emitChunkDiagnostic(task, leg, bytes, durationMs, result, range = task) {
    const data = {
      source: scrubUrl(leg.url),
      mirror: mirrorForUrl(leg.url),
      chunkIndex: task.chunkIndex,
      start: range.start,
      end: range.end,
      bytes,
      durationMs,
      slot: leg.slot,
      priority: task.kind,
      result,
    };
    if (leg.byteCount > 0) data.ttfbMs = leg.ttfbAt - leg.startedAt;
    this.emitDiagnostic('bank.fetch.chunk', data);
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
    for (const state of this.resourceState.values()) {
      if (!this.recentResourceKeys.includes(state.bankKey)) continue;
      this.scheduleResourceWindow(state);
    }
  }

  destroy() {
    if (this.prefetchTimer !== undefined) this.windowObject.clearInterval(this.prefetchTimer);
    for (const task of this.inflight.values()) {
      this.clearTaskStall(task);
      task.controller.abort();
    }
    for (const task of this.queue) {
      task.settled = true;
      task.reject(abortError());
      if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
    }
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
