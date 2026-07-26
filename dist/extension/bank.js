(() => {
  // src/constants.js
  var EXTENSION_MANIFEST = Object.freeze({
    manifestVersion: 3,
    minimumChromeVersion: "120",
    matches: Object.freeze([
      "https://live.bilibili.com/*",
      "https://www.bilibili.com/*"
    ]),
    hostPermissions: Object.freeze([])
  });
  var EXTENSION_PREFERENCES = Object.freeze({
    liveEnabled: "liveEnabled",
    vodEnabled: "vodEnabled"
  });
  var VOD_CONFIG = Object.freeze({
    stableBufferSeconds: 120
  });
  var BANK_CONFIG = Object.freeze({
    chunkBytes: 4 * 1024 ** 2,
    prefetchAheadSeconds: 900,
    maxBankBytes: 2 * 1024 ** 3,
    maxBankBytesPerVideo: 512 * 1024 ** 2,
    storeReadTimeoutMs: 50
  });
  var LIVE_CONFIG = Object.freeze({
    noDecodedFrameStallMilliseconds: 2e3,
    userSeekAuthorizationMilliseconds: 1e3,
    correctionToleranceSeconds: 2.5,
    statusRefreshMilliseconds: 500,
    delayUnavailableCheckMilliseconds: 5e3,
    liveRetainSeconds: 30
  });

  // src/diagnostics/catalog.js
  var MEDIA_EVENT_NAMES = Object.freeze([
    "loadstart",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "play",
    "playing",
    "pause",
    "waiting",
    "stalled",
    "progress",
    "timeupdate",
    "seeking",
    "seeked",
    "ratechange",
    "volumechange",
    "durationchange",
    "resize",
    "suspend",
    "emptied",
    "abort",
    "error",
    "ended"
  ]);
  var EVENT_CODES = Object.freeze([
    "route.session_started",
    "route.changed",
    "route.unsupported",
    "route.no_video",
    "preference.read",
    "preference.changed",
    "preference.disabled",
    "video.attached",
    "video.replaced",
    "video.destroyed",
    "video.source_replaced",
    "video.core_replaced",
    "video.no_video",
    "media.sample",
    ...MEDIA_EVENT_NAMES.map((name) => `media.${name}`),
    "resource.observed",
    "resource.observer_unavailable",
    "video.buffer_hint.attempt",
    "video.buffer_hint.applied",
    "video.buffer_hint.unsupported",
    "video.buffer_hint.failed",
    "video.buffer_observed",
    "live.stall.detected",
    "live.stall.recovered",
    "live.delay.observed",
    "live.delay.corrected",
    "live.delay.unavailable",
    "live.buffer.retained",
    "live.source_replaced",
    "live.delay_protection.capability",
    "live.delay_protection.applied",
    "live.delay_protection.unsupported",
    "live.delay_protection.failed",
    "live.delay_protection.cancelled",
    "bridge.request",
    "bridge.response",
    "bridge.error",
    "bank.fetch.chunk",
    "bank.serve",
    "bank.evict",
    "extension.started",
    "extension.boot_error",
    "extension.observer_error",
    "extension.destroyed",
    "log.persist.result",
    "log.persist.degraded"
  ]);
  var EXACT_CODES = new Set(EVENT_CODES);
  var DATA_ALLOWLIST = Object.freeze({
    route: Object.freeze([
      "routeKind",
      "origin",
      "pathname",
      "reason",
      "roomId",
      "bvid",
      "part",
      "watchLaterItem"
    ]),
    preference: Object.freeze(["name", "enabled"]),
    video: Object.freeze([
      "videoInstance",
      "sourceInstance",
      "coreInstance",
      "source",
      "previousSource",
      "state",
      "targetSeconds",
      "actualSeconds",
      "peakSeconds",
      "sampledSeconds",
      "samples",
      "reason"
    ]),
    media: Object.freeze([
      "eventType",
      "bufferedRanges",
      "seekableRanges",
      "currentTime",
      "duration",
      "paused",
      "ended",
      "readyState",
      "networkState",
      "resolution",
      "playbackRate",
      "estimatedDelay",
      "source",
      "videoQuality",
      "sourceBufferRanges",
      "mediaSourceState",
      "appendErrors",
      "removeStats"
    ]),
    resource: Object.freeze([
      "name",
      "initiatorType",
      "startTime",
      "duration",
      "responseStart",
      "responseEnd",
      "transferSize",
      "encodedBodySize",
      "decodedBodySize"
    ]),
    live: Object.freeze([
      "reason",
      "delayBeforeStall",
      "stallDuration",
      "targetDelay",
      "protectedDelay",
      "targetTime",
      "currentTime",
      "estimatedDelay",
      "previousSource",
      "source",
      "videoInstance",
      "sourceInstance",
      "capability",
      "status",
      "waitedSeconds",
      "retainSeconds",
      "originalEnd"
    ]),
    bridge: Object.freeze(["operation", "direction", "status"]),
    bank: Object.freeze([
      "source",
      "chunkIndex",
      "start",
      "end",
      "bytes",
      "durationMs",
      "priority",
      "result",
      "reason"
    ]),
    extension: Object.freeze(["action", "reason", "status"]),
    persist: Object.freeze(["status", "batchSize", "eventCount", "message"])
  });
  function allowedDataFields(code) {
    if (code.startsWith("route.")) return DATA_ALLOWLIST.route;
    if (code.startsWith("preference.")) return DATA_ALLOWLIST.preference;
    if (code.startsWith("video.buffer_hint.") || code.startsWith("video.")) return DATA_ALLOWLIST.video;
    if (code.startsWith("media.")) return DATA_ALLOWLIST.media;
    if (code.startsWith("resource.")) return DATA_ALLOWLIST.resource;
    if (code.startsWith("live.")) return DATA_ALLOWLIST.live;
    if (code.startsWith("bridge.")) return DATA_ALLOWLIST.bridge;
    if (code.startsWith("bank.")) return DATA_ALLOWLIST.bank;
    if (code.startsWith("extension.")) return DATA_ALLOWLIST.extension;
    if (code.startsWith("log.persist.")) return DATA_ALLOWLIST.persist;
    throw new Error(`诊断事件代码没有字段 allowlist: ${code}`);
  }

  // src/diagnostics/privacy.js
  var UNKNOWN_VALUE = "未提供";
  var RESOURCE_FIELDS = Object.freeze([...allowedDataFields("resource.observed")]);
  function scrubUrl(value) {
    if (typeof value !== "string" || value.length === 0) {
      return UNKNOWN_VALUE;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      return UNKNOWN_VALUE;
    }
    return `${parsed.origin}${parsed.pathname}`;
  }

  // src/bank/errors.js
  var BankFallbackError = class extends Error {
    constructor(message, cause) {
      super(message, { cause });
      this.name = "BankFallbackError";
      this.code = "BANK_FALLBACK";
    }
  };
  var BankNetworkError = class extends Error {
    constructor(message, cause) {
      super(message, { cause });
      this.name = "BankNetworkError";
      this.code = "BANK_NETWORK_FAILED";
    }
  };

  // src/bank/contract.js
  var BANK_MESSAGE_NAMESPACE = "bilibili-buffer:segment-bank-v1";
  var BANK_MESSAGE_TYPES = Object.freeze([
    "read-range",
    "write-chunk",
    "diagnostic",
    "configure"
  ]);
  function isBankMessage(message) {
    return message !== null && typeof message === "object" && !Array.isArray(message) && message.namespace === BANK_MESSAGE_NAMESPACE && BANK_MESSAGE_TYPES.includes(message.type);
  }

  // src/bank/logic.js
  function requireNonNegativeInteger(value, field) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} 必须是非负整数`);
    }
    return value;
  }
  function isVideoLocation(locationObject) {
    return locationObject.hostname === "www.bilibili.com" && (locationObject.pathname.startsWith("/video/") || locationObject.pathname === "/list/watchlater" || locationObject.pathname.startsWith("/list/watchlater/"));
  }
  function bankKey(url) {
    return new URL(url).pathname;
  }
  function chunkIndex(byteOffset, chunkBytes = BANK_CONFIG.chunkBytes) {
    requireNonNegativeInteger(byteOffset, "字节偏移");
    requireNonNegativeInteger(chunkBytes, "分片大小");
    if (chunkBytes === 0) throw new Error("分片大小不能为零");
    return Math.floor(byteOffset / chunkBytes);
  }
  function cacheKey(bankKeyValue, index) {
    if (typeof bankKeyValue !== "string" || bankKeyValue.length === 0) {
      throw new Error("bankKey 必须是非空字符串");
    }
    requireNonNegativeInteger(index, "分片索引");
    return `${bankKeyValue}#${index}`;
  }
  function headerValue(headers, name) {
    if (headers !== null && typeof headers?.get === "function") return headers.get(name);
    if (headers !== null && typeof headers === "object") {
      const wanted = name.toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return String(value);
      }
    }
    return null;
  }
  function parseRangeHeader(value) {
    if (typeof value !== "string") return void 0;
    const match = /^bytes=(\d+)-(\d+)$/.exec(value);
    if (match === null) return void 0;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return void 0;
    return { start, end };
  }
  function isMediaHost(hostname) {
    return hostname.endsWith(".bilivideo.com") || hostname.endsWith(".akamaized.net");
  }
  function classifyRequest({ url, headers, enabled = true, locationObject }) {
    if (enabled !== true) return { intercepted: false, reason: "disabled" };
    if (locationObject !== void 0 && !isVideoLocation(locationObject)) {
      return { intercepted: false, reason: "not_video_route" };
    }
    const parsed = new URL(url, locationObject?.href);
    if (!isMediaHost(parsed.hostname)) return { intercepted: false, reason: "non_media_host" };
    const rawRange = headerValue(headers, "Range");
    const range = parseRangeHeader(rawRange);
    if (range === void 0) {
      return { intercepted: false, reason: rawRange === null ? "range_missing" : "range_not_closed" };
    }
    return { intercepted: true, url: parsed.href, range };
  }
  function rangeLength(range) {
    const length = range.end - range.start + 1;
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Range 长度无效");
    return length;
  }
  function parseContentRange(value) {
    if (typeof value !== "string") return void 0;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
    if (match === null) return void 0;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const totalSize = Number(match[3]);
    if (![start, end, totalSize].every(Number.isSafeInteger) || start > end || end >= totalSize) return void 0;
    return { start, end, totalSize };
  }
  function partialResponseHeaders(start, end, totalSize) {
    const range = { start, end };
    const length = rangeLength(range);
    if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error("媒体总长度无效");
    return {
      "Accept-Ranges": "bytes",
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Type": "video/mp4"
    };
  }
  function planFetchRanges(start, end, {
    chunkBytes = BANK_CONFIG.chunkBytes,
    totalSize,
    bankKeyValue = "resource",
    aligned = false
  } = {}) {
    const request = { start, end };
    const length = rangeLength(request);
    if (aligned !== true || length < chunkBytes / 2 || totalSize === void 0) {
      return [{
        ...request,
        chunkIndex: chunkIndex(start, chunkBytes),
        cacheKey: cacheKey(bankKeyValue, chunkIndex(start, chunkBytes))
      }];
    }
    const result = [];
    let current = Math.floor(start / chunkBytes) * chunkBytes;
    while (current <= end) {
      const chunkEnd = Math.min(end, current + chunkBytes - 1, totalSize - 1);
      if (chunkEnd >= current) {
        const index = chunkIndex(current, chunkBytes);
        result.push({
          start: current,
          end: chunkEnd,
          chunkIndex: index,
          cacheKey: cacheKey(bankKeyValue, index)
        });
      }
      current += chunkBytes;
    }
    return result;
  }
  function compareQueueTasks(left, right) {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.sequence - right.sequence;
  }
  function insertQueueTask(queue, task) {
    queue.push(task);
    queue.sort(compareQueueTasks);
    return queue;
  }
  function priorityFor(kind) {
    if (kind === "foreground") return 0;
    if (kind === "prefetch") return 1;
    throw new Error(`未知取数任务类型: ${kind}`);
  }
  function estimateBitrate(samples) {
    if (!Array.isArray(samples)) throw new Error("码率样本必须是数组");
    let latest;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const elapsed = current.time - previous.time;
      const bytes = current.bytes - previous.bytes;
      if (Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(bytes) && bytes > 0) {
        latest = bytes / elapsed;
      }
    }
    return latest || 0;
  }
  function prefetchRange({ start, bitrate, aheadSeconds, totalSize }) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isFinite(bitrate) || bitrate <= 0) return void 0;
    if (!Number.isFinite(aheadSeconds) || aheadSeconds <= 0) throw new Error("预取秒数无效");
    const rawEnd = start + Math.ceil(bitrate * aheadSeconds) - 1;
    const end = totalSize === void 0 ? rawEnd : Math.min(rawEnd, totalSize - 1);
    if (end < start) return void 0;
    return { start, end };
  }

  // src/bank/xhr.js
  var EVENT_NAMES = Object.freeze([
    "readystatechange",
    "progress",
    "loadstart",
    "load",
    "error",
    "abort",
    "timeout",
    "loadend"
  ]);
  function eventFor(windowObject, type, init = {}) {
    const EventConstructor = windowObject.Event || globalThis.Event;
    const event = new EventConstructor(type);
    for (const [field, value] of Object.entries(init)) {
      Object.defineProperty(event, field, { configurable: true, value });
    }
    return event;
  }
  function responseBytes(response) {
    return response.arrayBuffer();
  }
  function decodeText(bytes) {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  function responseValue(windowObject, responseType, bytes) {
    if (responseType === "" || responseType === "text") return decodeText(bytes);
    if (responseType === "arraybuffer") return bytes;
    if (responseType === "blob") {
      const BlobConstructor = windowObject.Blob || globalThis.Blob;
      return new BlobConstructor([bytes]);
    }
    if (responseType === "json") return JSON.parse(decodeText(bytes));
    return bytes;
  }
  function responseHeadersText(headers) {
    const rows = [];
    for (const [name, value] of headers.entries()) rows.push(`${name}: ${value}`);
    return rows.length === 0 ? "" : `${rows.join("\r\n")}\r
`;
  }
  function createBankXMLHttpRequestClass({ windowObject, nativeConstructor, bank }) {
    return class SegmentBankXMLHttpRequest {
      static UNSENT = 0;
      static OPENED = 1;
      static HEADERS_RECEIVED = 2;
      static LOADING = 3;
      static DONE = 4;
      constructor() {
        this._native = new nativeConstructor();
        this._listeners = /* @__PURE__ */ new Map();
        this._openArgs = void 0;
        this._headers = {};
        this._range = void 0;
        this._body = void 0;
        this._intercepted = false;
        this._state = 0;
        this._responseType = "";
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        this._abortController = void 0;
        this._timer = void 0;
        this._done = false;
        this._aborted = false;
        this._timedOut = false;
        this._suppressNativeLoadstart = false;
        for (const eventName of EVENT_NAMES) {
          this._native.addEventListener(eventName, (event) => {
            if (!this._intercepted) {
              if (event.type === "loadstart" && this._suppressNativeLoadstart) {
                this._suppressNativeLoadstart = false;
                return;
              }
              this.dispatchEvent(event);
            }
          });
        }
      }
      get readyState() {
        return this._intercepted ? this._state : this._native.readyState;
      }
      get response() {
        return this._intercepted ? this._response : this._native.response;
      }
      get responseText() {
        if (this._intercepted) {
          if (this.responseType !== "" && this.responseType !== "text") {
            throw new DOMException("responseText is unavailable for this responseType", "InvalidStateError");
          }
          return this._response || "";
        }
        return this._native.responseText;
      }
      get responseType() {
        return this._intercepted ? this._responseType : this._native.responseType;
      }
      set responseType(value) {
        this._responseType = value;
        this._native.responseType = value;
      }
      get responseURL() {
        return this._intercepted ? this._responseURL : this._native.responseURL;
      }
      get status() {
        return this._intercepted ? this._status : this._native.status;
      }
      get statusText() {
        return this._intercepted ? this._statusText : this._native.statusText;
      }
      get timeout() {
        return this._native.timeout;
      }
      set timeout(value) {
        this._native.timeout = value;
      }
      get withCredentials() {
        return this._native.withCredentials;
      }
      set withCredentials(value) {
        this._native.withCredentials = value;
      }
      open(...args) {
        this._openArgs = args;
        this._headers = {};
        this._range = void 0;
        this._body = void 0;
        this._intercepted = false;
        this._done = false;
        this._aborted = false;
        this._timedOut = false;
        this._suppressNativeLoadstart = false;
        return this._native.open(...args);
      }
      setRequestHeader(name, value) {
        const existing = this._headers[name];
        this._headers[name] = existing === void 0 ? String(value) : `${existing}, ${value}`;
        return this._native.setRequestHeader(name, value);
      }
      getResponseHeader(name) {
        if (!this._intercepted) return this._native.getResponseHeader(name);
        return this._responseHeaders?.get(name) || null;
      }
      getAllResponseHeaders() {
        if (!this._intercepted) return this._native.getAllResponseHeaders();
        if (this._responseHeaders === void 0) return "";
        return responseHeadersText(this._responseHeaders);
      }
      overrideMimeType(...args) {
        return this._native.overrideMimeType(...args);
      }
      addEventListener(type, listener, options) {
        const listeners = this._listeners.get(type) || /* @__PURE__ */ new Set();
        listeners.add(listener);
        this._listeners.set(type, listeners);
        return void 0;
      }
      removeEventListener(type, listener, options) {
        this._listeners.get(type)?.delete(listener);
        return void 0;
      }
      dispatchEvent(event) {
        const type = event.type;
        const handler = this[`on${type}`];
        if (typeof handler === "function") handler.call(this, event);
        for (const listener of this._listeners.get(type) || []) listener.call(this, event);
        return true;
      }
      send(body) {
        this._body = body;
        const method = this._openArgs?.[0];
        const url = new URL(this._openArgs?.[1], windowObject.location.href).href;
        const asyncFlag = this._openArgs?.[2] !== false;
        const classification = classifyRequest({
          url,
          headers: this._headers,
          enabled: bank.enabled,
          locationObject: windowObject.location
        });
        this._range = classification.range;
        if (!asyncFlag || !classification.intercepted) {
          return this._native.send(body);
        }
        this._intercepted = true;
        this._state = 1;
        this._abortController = new AbortController();
        this.dispatchEvent(eventFor(windowObject, "loadstart"));
        if (this.timeout > 0) {
          this._timer = windowObject.setTimeout(() => {
            if (this._done) return;
            this._timedOut = true;
            this._abortController.abort();
            this._done = true;
            this._state = 4;
            this.dispatchEvent(eventFor(windowObject, "readystatechange"));
            this.dispatchEvent(eventFor(windowObject, "timeout"));
            this.dispatchEvent(eventFor(windowObject, "loadend"));
          }, this.timeout);
        }
        void this.serve(url, method, this._headers, body);
      }
      async serve(url, method, headers, body) {
        try {
          const result = await bank.serveRequest({
            url,
            method,
            headers,
            credentials: this.withCredentials ? "include" : "same-origin",
            signal: this._abortController.signal,
            body
          });
          if (this._done) return;
          if (!result.intercepted) {
            this.clearTimer();
            this._suppressNativeLoadstart = true;
            this._intercepted = false;
            this._native.send(body);
            return;
          }
          await this.finishResponse(result.response, result.bytes, url);
        } catch (error) {
          if (this._done) return;
          if (error instanceof BankFallbackError) {
            bank.emitDiagnostic("bank.serve", {
              source: scrubUrl(url),
              ...this._range,
              result: "pass",
              reason: "internal_fallback"
            });
            this.clearTimer();
            this._suppressNativeLoadstart = true;
            this._intercepted = false;
            this._native.send(body);
            return;
          }
          if (error instanceof BankNetworkError) {
            this.finishError(error.cause);
            return;
          }
          if (error?.name === "AbortError") {
            if (!this._aborted && !this._timedOut) this.finishError(error);
            return;
          }
          bank.emitDiagnostic("bank.serve", {
            source: scrubUrl(url),
            ...this._range,
            result: "pass",
            reason: "internal_error"
          });
          this.clearTimer();
          this._suppressNativeLoadstart = true;
          this._intercepted = false;
          this._native.send(body);
        }
      }
      async finishResponse(response, knownBytes, requestUrl) {
        const bytes = knownBytes || await responseBytes(response);
        this._status = response.status;
        this._statusText = response.statusText;
        this._responseURL = response.url || requestUrl;
        this._responseHeaders = response.headers;
        this._response = responseValue(windowObject, this._responseType, bytes);
        this._state = 2;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this._state = 3;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "progress", {
          loaded: bytes.byteLength,
          total: Number(response.headers.get("Content-Length")) || bytes.byteLength,
          lengthComputable: true
        }));
        this._state = 4;
        this._done = true;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "load"));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      finishError(error) {
        if (this._done) return;
        this._state = 4;
        this._done = true;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "error", { error }));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      abort() {
        if (!this._intercepted) {
          this._native.abort();
          return;
        }
        if (this._done) return;
        this._aborted = true;
        this._abortController.abort();
        this._done = true;
        this._state = 0;
        this.dispatchEvent(eventFor(windowObject, "abort"));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      clearTimer() {
        if (this._timer !== void 0) {
          windowObject.clearTimeout(this._timer);
          this._timer = void 0;
        }
      }
    };
  }

  // src/bank/main.js
  var MAX_CONCURRENCY = 3;
  var StoreReadTimeoutError = class extends Error {
    constructor() {
      super("媒体分片存储读取超时");
      this.name = "StoreReadTimeoutError";
      this.code = "BANK_STORE_READ_TIMEOUT";
    }
  };
  function abortError() {
    return new DOMException("The operation was aborted", "AbortError");
  }
  function isAbortError(error) {
    return error?.name === "AbortError";
  }
  function messageError(error) {
    const result = new Error(error?.message || String(error));
    result.name = error?.name || "Error";
    result.code = error?.code || "BANK_RELAY_FAILED";
    return result;
  }
  function performanceNow(windowObject) {
    return typeof windowObject.performance?.now === "function" ? windowObject.performance.now() : Date.now();
  }
  function responseTypeConstructor(windowObject, name) {
    return windowObject[name] || globalThis[name];
  }
  function waitWithSignal(promise, signal, windowObject, timeoutMs) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        if (timer !== void 0) windowObject.clearTimeout(timer);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => finish(reject, abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== void 0) {
        timer = windowObject.setTimeout(() => finish(reject, new StoreReadTimeoutError()), timeoutMs);
      }
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }
  var BankStoreClient = class {
    constructor(windowObject) {
      this.windowObject = windowObject;
      this.nextRequestId = 1;
      this.pending = /* @__PURE__ */ new Map();
      this.onMessage = (event) => {
        if (event.source !== this.windowObject || !isBankMessage(event.data)) return;
        const message = event.data;
        if (message.direction !== "response") return;
        const pending = this.pending.get(message.requestId);
        if (pending === void 0) return;
        this.pending.delete(message.requestId);
        if (message.ok !== true) {
          pending.reject(messageError(message.error));
          return;
        }
        pending.resolve(message.value);
      };
      windowObject.addEventListener("message", this.onMessage);
    }
    request(type, payload, transfer = []) {
      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      const message = {
        namespace: BANK_MESSAGE_NAMESPACE,
        direction: "request",
        type,
        requestId,
        ...payload
      };
      return new Promise((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        try {
          this.windowObject.postMessage(message, "*", transfer);
        } catch (error) {
          this.pending.delete(requestId);
          reject(error);
        }
      });
    }
    readRange(bankKeyValue, start, end) {
      return this.request("read-range", { bankKey: bankKeyValue, start, end });
    }
    writeChunk({
      bankKey: bankKeyValue,
      videoKey,
      start,
      end,
      totalSize,
      bytes,
      currentByteByBank,
      currentByteByVideo
    }) {
      return this.request(
        "write-chunk",
        {
          bankKey: bankKeyValue,
          videoKey,
          start,
          end,
          totalSize,
          bytes,
          currentByteByBank,
          currentByteByVideo
        },
        [bytes]
      );
    }
    destroy() {
      this.windowObject.removeEventListener("message", this.onMessage);
      for (const pending of this.pending.values()) pending.reject(new Error("媒体分片存储客户端已经销毁"));
      this.pending.clear();
    }
  };
  var SegmentBank = class {
    constructor({
      windowObject = window,
      nativeFetch = windowObject.fetch,
      storeClient = new BankStoreClient(windowObject),
      maxConcurrency = MAX_CONCURRENCY,
      config = BANK_CONFIG
    } = {}) {
      this.windowObject = windowObject;
      this.nativeFetch = nativeFetch;
      this.storeClient = storeClient;
      this.config = config;
      this.maxConcurrency = maxConcurrency;
      this.enabled = true;
      this.queue = [];
      this.inflight = /* @__PURE__ */ new Map();
      this.activeTasks = /* @__PURE__ */ new Set();
      this.sequence = 0;
      this.resourceState = /* @__PURE__ */ new Map();
      this.recentResourceKeys = [];
      this.knownStoredRanges = /* @__PURE__ */ new Map();
      this.pendingStoreRanges = /* @__PURE__ */ new Map();
      this.memoryRanges = /* @__PURE__ */ new Map();
      this.prefetchTimer = this.windowObject.setInterval?.(() => {
        void this.prefetch().catch((error) => {
          console.error("[BilibiliBuffer] 媒体分片预取失败", error);
        });
      }, 1e3);
      this.onControlMessage = (event) => {
        if (event.source !== this.windowObject || !isBankMessage(event.data)) return;
        if (event.data.direction !== "control" || event.data.type !== "configure") return;
        this.enabled = event.data.enabled === true;
      };
      this.windowObject.addEventListener("message", this.onControlMessage);
    }
    emitDiagnostic(code, data) {
      const message = {
        namespace: BANK_MESSAGE_NAMESPACE,
        direction: "event",
        type: "diagnostic",
        code,
        data
      };
      try {
        this.windowObject.postMessage(message, "*");
      } catch (error) {
        console.error("[BilibiliBuffer] 媒体分片诊断派发失败", error);
      }
    }
    stateFor(bankKeyValue) {
      let state = this.resourceState.get(bankKeyValue);
      if (state === void 0) {
        state = {
          bankKey: bankKeyValue,
          videoKey: this.windowObject.location.pathname,
          latestUrl: void 0,
          credentials: "same-origin",
          totalSize: void 0,
          lastForegroundEnd: void 0,
          prefetchEnd: void 0,
          samples: []
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
        bytes: result.bytes
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
        if (segment.start > cursor) return void 0;
        const copyStart = Math.max(cursor, segment.start);
        const copyEnd = Math.min(end, segment.end);
        bytes.set(
          new Uint8Array(segment.bytes).subarray(copyStart - segment.start, copyEnd - segment.start + 1),
          copyStart - start
        );
        cursor = copyEnd + 1;
        totalSize = segment.totalSize;
        if (cursor > end) return { hit: true, bytes: bytes.buffer, totalSize };
      }
      return void 0;
    }
    cacheKeyForRange(resourceKey, start) {
      return cacheKey(resourceKey, chunkIndex(start, this.config.chunkBytes));
    }
    touchResource(resourceKey) {
      const nextKeys = [
        ...this.recentResourceKeys.filter((key) => key !== resourceKey),
        resourceKey
      ].slice(-2);
      const retained = new Set(nextKeys);
      this.abortPrefetchTasks((task) => !retained.has(task.bankKey));
      this.recentResourceKeys = nextKeys;
    }
    abortPrefetchTasks(predicate = () => true) {
      for (const task of this.inflight.values()) {
        if (task.kind === "prefetch" && predicate(task)) task.controller.abort();
      }
    }
    updatePlaybackSample() {
      const videos = [...this.windowObject.document?.querySelectorAll?.("video") || []];
      const video = videos.sort((left, right) => (right.clientWidth || 0) * (right.clientHeight || 0) - (left.clientWidth || 0) * (left.clientHeight || 0)).at(0);
      if (video === void 0) return 0;
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
        enabled: this.enabled,
        locationObject: this.windowObject.location
      });
    }
    async handleFetch(thisArg, args, originalFetch) {
      if (this.windowObject.location !== void 0 && !isVideoLocation(this.windowObject.location)) {
        return originalFetch.apply(thisArg, args);
      }
      let request;
      try {
        request = new Request(...args);
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
        if (this.enabled === true) {
          this.emitDiagnostic("bank.serve", {
            source: scrubUrl(request.url),
            result: "pass",
            reason: classification.reason
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
          signal: request.signal
        });
        return served.response;
      } catch (error) {
        if (error instanceof BankNetworkError) throw error.cause;
        if (isAbortError(error)) throw error;
        if (error instanceof BankFallbackError) {
          this.emitDiagnostic("bank.serve", {
            source: scrubUrl(request.url),
            start: classification.range.start,
            end: classification.range.end,
            result: "pass",
            reason: "internal_fallback"
          });
          return originalFetch.apply(thisArg, args);
        }
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(request.url),
          result: "pass",
          reason: "internal_error"
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
        throw new BankFallbackError("媒体分片存储读取失败", error);
      }
      try {
        return await waitWithSignal(read, signal, this.windowObject, this.config.storeReadTimeoutMs);
      } catch (error) {
        if (error instanceof StoreReadTimeoutError) {
          void read.catch((readError) => {
            console.error("[BilibiliBuffer] 媒体分片存储读取超时后的错误", readError);
          });
          return void 0;
        }
        if (isAbortError(error)) throw error;
        throw new BankFallbackError("媒体分片存储读取失败", error);
      }
    }
    createResponse(bytes, start, end, totalSize, url) {
      const ResponseConstructor = responseTypeConstructor(this.windowObject, "Response");
      const response = new ResponseConstructor(bytes, {
        status: 206,
        statusText: "Partial Content",
        headers: partialResponseHeaders(start, end, totalSize)
      });
      Object.defineProperty(response, "url", { configurable: true, value: url });
      Object.defineProperty(response, "type", { configurable: true, value: "basic" });
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
      state.credentials = credentials || "same-origin";
      if (state.lastForegroundEnd !== end) state.prefetchEnd = void 0;
      state.lastForegroundEnd = end;
      const stored = await this.readStoredRange(resourceKey, start, end, signal);
      if (signal?.aborted) throw abortError();
      if (stored?.hit === true) {
        if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== rangeLength({ start, end })) {
          throw new BankFallbackError("媒体分片存储命中长度不符");
        }
        if (!Number.isSafeInteger(stored.totalSize) || stored.totalSize <= end) {
          throw new BankFallbackError("媒体分片存储命中总长度无效");
        }
        state.totalSize = stored.totalSize;
        this.rememberRange(
          this.knownStoredRanges,
          this.cacheKeyForRange(resourceKey, start),
          start,
          end
        );
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          start,
          end,
          result: "hit",
          reason: "stored_range"
        });
        return {
          intercepted: true,
          response: this.createResponse(stored.bytes, start, end, stored.totalSize, url),
          bytes: stored.bytes,
          totalSize: stored.totalSize
        };
      }
      this.emitDiagnostic("bank.serve", {
        source: scrubUrl(url),
        start,
        end,
        result: "fetch",
        reason: stored === void 0 ? "store_read_timeout" : stored?.hit === false ? "stored_range_missing" : "store_unavailable"
      });
      const fetched = await this.fetchForeground({
        resourceKey,
        url,
        credentials: state.credentials,
        start,
        end,
        totalSize: state.totalSize || stored?.totalSize,
        signal,
        videoKey: state.videoKey
      });
      if (signal?.aborted) throw abortError();
      if (fetched.response !== void 0) return { intercepted: true, response: fetched.response };
      state.totalSize = fetched.totalSize;
      return {
        intercepted: true,
        response: this.createResponse(fetched.bytes, start, end, fetched.totalSize, url),
        bytes: fetched.bytes,
        totalSize: fetched.totalSize
      };
    }
    async fetchForeground({ resourceKey, url, credentials, start, end, totalSize, signal, videoKey }) {
      const plans = planFetchRanges(start, end, {
        chunkBytes: this.config.chunkBytes,
        totalSize,
        bankKeyValue: resourceKey,
        aligned: false
      });
      const results = await Promise.all(plans.map((plan) => this.getTask(plan, {
        kind: "foreground",
        url,
        credentials,
        signal,
        videoKey
      })));
      const httpError = results.find((result) => result.response !== void 0);
      if (httpError !== void 0) return httpError;
      const total = results.find((result) => Number.isSafeInteger(result.totalSize))?.totalSize;
      if (!Number.isSafeInteger(total) || total <= end) throw new BankFallbackError("媒体网络响应缺少有效总长度");
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
          copyStart - start
        );
        covered.fill(1, copyStart - start, copyEnd - start + 1);
      }
      if (covered.some((value) => value !== 1)) throw new BankFallbackError("媒体网络响应没有覆盖请求区间");
      return { bytes: bytes.buffer, start, end, totalSize: total };
    }
    getTask(plan, { kind, url, credentials, signal, videoKey }) {
      const existing = this.inflight.get(plan.cacheKey);
      if (existing !== void 0) {
        if (existing.start <= plan.start && existing.end >= plan.end) {
          if (priorityFor(kind) < existing.priority) {
            existing.priority = priorityFor(kind);
            existing.kind = kind;
            this.queue.sort(compareQueueTasks);
          }
          return this.waitForTask(existing, signal);
        }
        return existing.promise.catch((error) => {
          if (kind === "foreground" && existing.kind === "prefetch" && !signal?.aborted) return void 0;
          throw error;
        }).then(() => this.getTask(plan, { kind, url, credentials, signal, videoKey }));
      }
      const controller = new AbortController();
      const task = {
        ...plan,
        bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf("#")),
        url,
        credentials,
        videoKey,
        kind,
        priority: priorityFor(kind),
        sequence: this.sequence,
        controller,
        started: false,
        waiters: 0,
        promise: void 0,
        resolve: void 0,
        reject: void 0
      };
      this.sequence += 1;
      task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
      });
      this.inflight.set(plan.cacheKey, task);
      insertQueueTask(this.queue, task);
      if (kind === "foreground" && this.activeTasks.size >= this.maxConcurrency) this.abortOnePrefetch();
      this.pump();
      return this.waitForTask(task, signal);
    }
    waitForTask(task, signal) {
      task.waiters += 1;
      return waitWithSignal(task.promise, signal, this.windowObject).finally(() => {
        task.waiters -= 1;
        if (signal !== void 0 && signal.aborted && task.waiters === 0 && task.kind === "foreground") {
          task.controller.abort();
        }
      });
    }
    abortOnePrefetch() {
      const task = [...this.activeTasks].find((candidate) => candidate.kind === "prefetch");
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
        void this.runTask(task).then((result) => task.resolve(result), (error) => task.reject(error)).finally(() => {
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
          signal: task.controller.signal
        });
      } catch (error) {
        const result2 = isAbortError(error) ? "aborted" : "network_error";
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, result2);
        if (isAbortError(error)) throw error;
        throw new BankNetworkError("媒体分片网络取数失败", error);
      }
      if (response.status < 200 || response.status >= 300) {
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, "http_error");
        return { response };
      }
      let bytes;
      try {
        bytes = await response.arrayBuffer();
      } catch (error) {
        if (isAbortError(error)) {
          this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, "aborted");
          throw error;
        }
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, "network_error");
        throw new BankNetworkError("媒体分片响应读取失败", error);
      }
      const contentRange = parseContentRange(headerValue(response.headers, "Content-Range"));
      if (contentRange === void 0 || contentRange.start !== task.start || contentRange.end !== task.end) {
        this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, "invalid_response");
        throw new BankFallbackError("媒体分片网络 Content-Range 不匹配");
      }
      if (bytes.byteLength !== rangeLength(task)) {
        this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, "invalid_response");
        throw new BankFallbackError("媒体分片网络字节长度不匹配");
      }
      const result = {
        start: task.start,
        end: task.end,
        bytes,
        totalSize: contentRange.totalSize
      };
      this.rememberMemoryRange(task.bankKey, result);
      this.persistTask(task, result);
      this.emitChunkDiagnostic(task, bytes.byteLength, performanceNow(this.windowObject) - startedAt, "fetched");
      return result;
    }
    emitChunkDiagnostic(task, bytes, durationMs, result) {
      this.emitDiagnostic("bank.fetch.chunk", {
        source: scrubUrl(task.url),
        chunkIndex: task.chunkIndex,
        bytes,
        durationMs,
        priority: task.kind,
        result
      });
    }
    persistTask(task, result) {
      if (this.rangeIsCovered(this.knownStoredRanges, task.cacheKey, result.start, result.end) || this.rangeIsCovered(this.pendingStoreRanges, task.cacheKey, result.start, result.end)) return;
      this.rememberRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
      const storedBytes = result.bytes.slice(0);
      const currentByteByBank = Object.fromEntries(
        [...this.resourceState.entries()].filter(([, state]) => Number.isFinite(state.lastForegroundEnd)).map(([key, state]) => [key, state.lastForegroundEnd])
      );
      const currentByteByVideo = Object.fromEntries(
        [...this.resourceState.values()].filter((state) => Number.isFinite(state.lastForegroundEnd)).map((state) => [state.videoKey, state.lastForegroundEnd])
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
          currentByteByVideo
        });
      } catch (error) {
        this.forgetRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
        console.error("[BilibiliBuffer] 媒体分片异步落盘失败", error);
        return;
      }
      void Promise.resolve(write).then((writeResult) => {
        this.rememberRange(this.knownStoredRanges, task.cacheKey, result.start, result.end);
        this.forgetMemoryRange(task.bankKey, result.start, result.end);
        for (const record of writeResult?.records || []) {
          this.knownStoredRanges.delete(record.cacheKey);
        }
        if (writeResult?.evictedBytes > 0) {
          this.emitDiagnostic("bank.evict", {
            bytes: writeResult.evictedBytes,
            reason: writeResult.reason || "limit"
          });
        }
      }).catch((error) => {
        console.error("[BilibiliBuffer] 媒体分片异步落盘失败", error);
      }).finally(() => {
        this.forgetRange(this.pendingStoreRanges, task.cacheKey, result.start, result.end);
      });
    }
    async prefetch() {
      if (this.enabled !== true) return;
      if (!isVideoLocation(this.windowObject.location)) {
        this.abortPrefetchTasks();
        return;
      }
      const bitrate = this.updatePlaybackSample();
      if (bitrate <= 0) return;
      for (const state of this.resourceState.values()) {
        if (!this.recentResourceKeys.includes(state.bankKey)) continue;
        if (state.latestUrl === void 0 || !Number.isSafeInteger(state.totalSize) || !Number.isSafeInteger(state.lastForegroundEnd)) {
          continue;
        }
        const start = Math.max(
          state.lastForegroundEnd + 1,
          (chunkIndex(state.lastForegroundEnd, this.config.chunkBytes) + 1) * this.config.chunkBytes
        );
        const range = prefetchRange({
          start,
          bitrate,
          aheadSeconds: this.config.prefetchAheadSeconds,
          totalSize: state.totalSize
        });
        if (range === void 0 || range.end <= (state.prefetchEnd ?? -1)) continue;
        state.prefetchEnd = range.end;
        const plans = planFetchRanges(range.start, range.end, {
          chunkBytes: this.config.chunkBytes,
          totalSize: state.totalSize,
          bankKeyValue: state.bankKey,
          aligned: true
        });
        for (const plan of plans) {
          if (this.rangeIsCovered(this.knownStoredRanges, plan.cacheKey, plan.start, plan.end) || this.rangeIsCovered(this.pendingStoreRanges, plan.cacheKey, plan.start, plan.end) || this.inflight.has(plan.cacheKey)) continue;
          let stored;
          try {
            stored = await this.readStoredRange(state.bankKey, plan.start, plan.end);
          } catch (error) {
            console.error("[BilibiliBuffer] 媒体分片预取读取存储失败", error);
          }
          if (stored?.hit === true) {
            this.rememberRange(this.knownStoredRanges, plan.cacheKey, plan.start, plan.end);
            continue;
          }
          if (this.inflight.has(plan.cacheKey)) continue;
          void this.getTask(plan, {
            kind: "prefetch",
            url: state.latestUrl,
            credentials: state.credentials,
            videoKey: state.videoKey
          }).catch((error) => {
            if (!isAbortError(error)) console.error("[BilibiliBuffer] 媒体分片投机预取失败", error);
          });
        }
        this.pump();
      }
    }
    destroy() {
      if (this.prefetchTimer !== void 0) this.windowObject.clearInterval(this.prefetchTimer);
      this.windowObject.removeEventListener("message", this.onControlMessage);
      for (const task of this.inflight.values()) task.controller.abort();
      this.storeClient.destroy();
    }
  };
  function installSegmentBank(windowObject = window) {
    if (!windowObject.location) throw new Error("媒体分片页面位置不可用");
    if (windowObject.__smoothSegmentBank !== void 0) return windowObject.__smoothSegmentBank;
    if (!windowObject.fetch || !windowObject.XMLHttpRequest) throw new Error("页面网络 API 不可用");
    const originalFetch = windowObject.fetch;
    const originalXMLHttpRequest = windowObject.XMLHttpRequest;
    const bank = new SegmentBank({ windowObject, nativeFetch: originalFetch });
    windowObject.fetch = function smoothSegmentBankFetch(...args) {
      return bank.handleFetch(this, args, originalFetch);
    };
    windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
      windowObject,
      nativeConstructor: originalXMLHttpRequest,
      bank
    });
    const marker = {
      bank,
      installed: true,
      setEnabled(enabled) {
        bank.enabled = enabled === true;
      },
      destroy() {
        windowObject.fetch = originalFetch;
        windowObject.XMLHttpRequest = originalXMLHttpRequest;
        bank.destroy();
        delete windowObject.__smoothSegmentBank;
      }
    };
    windowObject.__smoothSegmentBank = marker;
    return marker;
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const locationObject = window.location;
    if (locationObject !== void 0 && locationObject.hostname === "www.bilibili.com") {
      installSegmentBank(window);
    }
  }
})();
//# sourceMappingURL=bank.js.map
