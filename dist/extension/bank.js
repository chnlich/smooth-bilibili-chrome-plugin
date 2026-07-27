(() => {
  // src/constants.js
  var EXTENSION_MANIFEST = Object.freeze({
    manifestVersion: 3,
    minimumChromeVersion: "120",
    matches: Object.freeze([
      "https://www.bilibili.com/*"
    ]),
    hostPermissions: Object.freeze([])
  });
  var EXTENSION_PREFERENCES = Object.freeze({
    vodEnabled: "vodEnabled"
  });
  var VOD_CONFIG = Object.freeze({
    stableBufferSeconds: 120
  });
  var BANK_CONFIG = Object.freeze({
    chunkBytes: 4 * 1024 ** 2,
    prefetchAheadSeconds: 900,
    maxBankBytes: 512 * 1024 ** 2,
    refetchAlarmCount: 3,
    foregroundDeadlineMs: 5e3,
    prefetchDeadlineMs: 2e4,
    latencyAlarmCount: 3
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
    "bridge.request",
    "bridge.response",
    "bridge.error",
    "bank.fetch.chunk",
    "bank.serve",
    "bank.evict",
    "bank.store",
    "bank.disabled",
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
    bridge: Object.freeze(["operation", "direction", "status"]),
    bank: Object.freeze([
      "source",
      "operation",
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
  var BANK_ENABLED_ATTRIBUTE = "data-bilibili-buffer-bank-enabled";
  var BANK_MESSAGE_NAMESPACE = "bilibili-buffer:segment-bank-v1";
  var BANK_DIAGNOSTIC_MESSAGE_TYPE = "diagnostic";

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
    if (Array.isArray(headers)) {
      const wanted = name.toLowerCase();
      for (const entry of headers) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
      }
    }
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
    rangeLength(request);
    if (aligned !== true) {
      return [{
        ...request,
        chunkIndex: chunkIndex(start, chunkBytes),
        cacheKey: cacheKey(bankKeyValue, chunkIndex(start, chunkBytes)),
        cacheable: false
      }];
    }
    const result = [];
    let current = Math.floor(start / chunkBytes) * chunkBytes;
    while (current <= end) {
      const chunkEnd = totalSize === void 0 ? current + chunkBytes - 1 : Math.min(current + chunkBytes - 1, totalSize - 1);
      if (chunkEnd >= current) {
        const index = chunkIndex(current, chunkBytes);
        result.push({
          start: current,
          end: chunkEnd,
          chunkIndex: index,
          cacheKey: cacheKey(bankKeyValue, index),
          cacheable: true
        });
      }
      current += chunkBytes;
    }
    return result;
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
  function entryBytes(entry) {
    if (Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0) return entry.byteLength;
    if (entry.bytes instanceof ArrayBuffer) return entry.bytes.byteLength;
    throw new Error("淘汰条目缺少字节数");
  }
  function evictionRank(entry, currentByte) {
    const played = Number.isFinite(currentByte) && Number.isFinite(entry.end) && entry.end < currentByte;
    if (played) return [0, 0, entry.storedAt || 0];
    const distance = Number.isFinite(currentByte) && Number.isFinite(entry.start) ? Math.max(0, entry.start - currentByte) : Number.MAX_SAFE_INTEGER;
    return [1, -distance, entry.storedAt || 0];
  }
  function currentByteForEntry(entry, currentByteByBank) {
    return currentByteByBank[entry.bankKey];
  }
  function compareEvictionEntries(left, right, currentByteByBank) {
    const leftRank = evictionRank(left, currentByteForEntry(left, currentByteByBank));
    const rightRank = evictionRank(right, currentByteForEntry(right, currentByteByBank));
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return left.cacheKey.localeCompare(right.cacheKey);
  }
  function selectEvictions({
    entries,
    maxBankBytes,
    currentByteByBank = {}
  }) {
    if (!Array.isArray(entries)) throw new Error("淘汰条目必须是数组");
    const total = entries.reduce((sum, entry) => sum + entryBytes(entry), 0);
    const selected = [];
    const remaining = [...entries];
    let currentTotal = total;
    while (currentTotal > maxBankBytes) {
      const candidates = remaining;
      if (candidates.length === 0) throw new Error("存储超限但没有可淘汰分片");
      candidates.sort((left, right) => compareEvictionEntries(left, right, currentByteByBank));
      const victim = candidates[0];
      selected.push(victim);
      remaining.splice(remaining.indexOf(victim), 1);
      const bytes = entryBytes(victim);
      currentTotal -= bytes;
    }
    return { entries: selected, bytes: selected.reduce((sum, entry) => sum + entryBytes(entry), 0) };
  }

  // src/bank/storage.js
  function requireArrayBuffer(value) {
    if (!(value instanceof ArrayBuffer)) throw new Error("分片字节必须是 ArrayBuffer");
    return value;
  }
  function requireRange(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      throw new Error("分片区间无效");
    }
    return { start, end };
  }
  function requireChunks(chunks) {
    if (!(chunks instanceof Map)) throw new Error("媒体分片表必须是 Map");
    return chunks;
  }
  function requireStoredRecord(record, chunkBytes, cacheKeyValue) {
    if (record === void 0 || record === null || typeof record !== "object") {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 无效`);
    }
    requireArrayBuffer(record.bytes);
    if (record.bytes.byteLength <= 0 || record.bytes.byteLength > chunkBytes) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 长度无效`);
    }
    if (!Number.isSafeInteger(record.totalSize) || record.totalSize < record.bytes.byteLength) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 总长度无效`);
    }
    if (!Number.isFinite(record.storedAt)) throw new Error(`媒体分片记录 ${cacheKeyValue} 时间无效`);
    return record;
  }
  function requireCompleteRecord(record, chunkBytes, chunkStart, cacheKeyValue) {
    requireStoredRecord(record, chunkBytes, cacheKeyValue);
    const expectedLength = Math.min(chunkBytes, record.totalSize - chunkStart);
    if (expectedLength <= 0 || record.bytes.byteLength !== expectedLength) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 不是完整分片`);
    }
    return record;
  }
  function cacheKeyParts(cacheKeyValue) {
    const separator = cacheKeyValue.lastIndexOf("#");
    if (separator <= 0) throw new Error(`媒体分片 cacheKey 无效: ${cacheKeyValue}`);
    const bankKeyValue = cacheKeyValue.slice(0, separator);
    const index = Number(cacheKeyValue.slice(separator + 1));
    chunkIndex(index);
    return { bankKey: bankKeyValue, chunkIndex: index };
  }
  function entriesFor(chunks, chunkBytes) {
    requireChunks(chunks);
    const entries = [];
    for (const [cacheKeyValue, record] of chunks) {
      const { bankKey: bankKeyValue, chunkIndex: index } = cacheKeyParts(cacheKeyValue);
      const start = index * chunkBytes;
      const stored = requireCompleteRecord(record, chunkBytes, start, cacheKeyValue);
      const end = start + stored.bytes.byteLength - 1;
      if (stored.totalSize <= end) throw new Error(`媒体分片记录 ${cacheKeyValue} 超出总长度`);
      entries.push({
        cacheKey: cacheKeyValue,
        bankKey: bankKeyValue,
        chunkIndex: index,
        start,
        end,
        byteLength: stored.bytes.byteLength,
        storedAt: stored.storedAt
      });
    }
    return entries;
  }
  function readMemoryRange(chunks, bankKeyValue, start, end, chunkBytes = BANK_CONFIG.chunkBytes) {
    requireChunks(chunks);
    requireRange(start, end);
    const bytes = new Uint8Array(rangeLength({ start, end }));
    let cursor = start;
    let totalSize;
    const firstIndex = chunkIndex(start, chunkBytes);
    const lastIndex = chunkIndex(end, chunkBytes);
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const key = cacheKey(bankKeyValue, index);
      const record = chunks.get(key);
      if (record === void 0) return { hit: false, totalSize };
      const chunkStart = index * chunkBytes;
      requireCompleteRecord(record, chunkBytes, chunkStart, key);
      const chunkEnd = chunkStart + record.bytes.byteLength - 1;
      if (chunkStart > cursor || chunkEnd < cursor) return { hit: false, totalSize: record.totalSize };
      const copyStart = Math.max(cursor, chunkStart);
      const copyEnd = Math.min(end, chunkEnd);
      bytes.set(
        new Uint8Array(record.bytes).subarray(copyStart - chunkStart, copyEnd - chunkStart + 1),
        copyStart - start
      );
      cursor = copyEnd + 1;
      totalSize = record.totalSize;
    }
    if (cursor <= end) return { hit: false, totalSize };
    return { hit: true, bytes: bytes.buffer, totalSize };
  }
  function writeMemoryChunk({
    chunks,
    bankKey: bankKeyValue,
    start,
    end,
    totalSize,
    bytes,
    chunkBytes = BANK_CONFIG.chunkBytes,
    storedAt = Date.now()
  }) {
    requireChunks(chunks);
    requireRange(start, end);
    requireArrayBuffer(bytes);
    if (bytes.byteLength !== end - start + 1) throw new Error("媒体分片字节长度与区间不符");
    if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error("媒体分片总长度无效");
    const index = chunkIndex(start, chunkBytes);
    const expectedEnd = Math.min(totalSize - 1, (index + 1) * chunkBytes - 1);
    if (start !== index * chunkBytes || end !== expectedEnd) {
      throw new Error("媒体分片写入区间未按分片边界对齐");
    }
    const key = cacheKey(bankKeyValue, index);
    const previous = chunks.get(key);
    const storedBytes = bytes.slice(0);
    const record = { bytes: storedBytes, totalSize, storedAt };
    requireCompleteRecord(record, chunkBytes, index * chunkBytes, key);
    chunks.set(key, record);
    return {
      cacheKey: key,
      bankKey: bankKeyValue,
      chunkIndex: index,
      bytes: storedBytes.byteLength,
      storedAt,
      previous
    };
  }
  function enforceMemoryLimit({
    chunks,
    maxBankBytes = BANK_CONFIG.maxBankBytes,
    chunkBytes = BANK_CONFIG.chunkBytes,
    currentByteByBank = {}
  }) {
    requireChunks(chunks);
    if (!Number.isSafeInteger(maxBankBytes) || maxBankBytes < 0) throw new Error("内存上限无效");
    const candidates = entriesFor(chunks, chunkBytes);
    const selected = selectEvictions({
      entries: candidates,
      maxBankBytes,
      currentByteByBank
    });
    for (const entry of selected.entries) {
      if (!chunks.delete(entry.cacheKey)) throw new Error(`媒体分片淘汰失败: ${entry.cacheKey}`);
    }
    return {
      entries: selected.entries,
      bytes: selected.bytes,
      reason: selected.entries.length === 0 ? void 0 : "limit"
    };
  }
  function clearMemory(chunks) {
    requireChunks(chunks);
    chunks.clear();
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
  function bankEnabled(bank) {
    return typeof bank.isEnabled === "function" ? bank.isEnabled() : bank.enabled === true;
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
        this._generation = 0;
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
        this._abortController?.abort();
        this.clearTimer();
        this._generation += 1;
        this._openArgs = args;
        this._headers = {};
        this._range = void 0;
        this._body = void 0;
        this._intercepted = false;
        this._done = false;
        this._aborted = false;
        this._timedOut = false;
        this._suppressNativeLoadstart = false;
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        const result = this._native.open(...args);
        this._responseType = this._native.responseType;
        return result;
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
          enabled: bankEnabled(bank),
          locationObject: windowObject.location
        });
        this._range = classification.range;
        if (!asyncFlag || !classification.intercepted) {
          return this._native.send(body);
        }
        this._intercepted = true;
        this._state = 1;
        this._abortController = new AbortController();
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        const generation = this._generation;
        this.dispatchEvent(eventFor(windowObject, "loadstart"));
        if (this.timeout > 0) {
          this._timer = windowObject.setTimeout(() => {
            if (this._done || generation !== this._generation) return;
            this._timedOut = true;
            this._abortController.abort();
            this._done = true;
            this._state = 4;
            this.dispatchEvent(eventFor(windowObject, "readystatechange"));
            this.dispatchEvent(eventFor(windowObject, "timeout"));
            this.dispatchEvent(eventFor(windowObject, "loadend"));
          }, this.timeout);
        }
        void this.serve(url, method, this._headers, body, generation);
      }
      async serve(url, method, headers, body, generation) {
        try {
          const result = await bank.serveRequest({
            url,
            method,
            headers,
            credentials: this.withCredentials ? "include" : "same-origin",
            signal: this._abortController.signal,
            body
          });
          if (this._done || generation !== this._generation) return;
          if (!result.intercepted) {
            this.clearTimer();
            this._suppressNativeLoadstart = true;
            this._intercepted = false;
            this._native.send(body);
            return;
          }
          await this.finishResponse(result.response, result.bytes, url, generation);
        } catch (error) {
          if (this._done || generation !== this._generation) return;
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
            this.finishError(error.cause, generation);
            return;
          }
          if (error?.name === "AbortError") {
            if (!this._aborted && !this._timedOut) this.finishError(error, generation);
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
      async finishResponse(response, knownBytes, requestUrl, generation) {
        const bytes = knownBytes || await responseBytes(response);
        if (this._done || generation !== this._generation) return;
        this._status = response.status;
        this._statusText = response.statusText;
        this._responseURL = response.url || requestUrl;
        this._responseHeaders = response.headers;
        this._response = responseValue(windowObject, this._responseType, bytes);
        const contentLength = response.headers.get("Content-Length");
        const total = contentLength === null ? 0 : Number(contentLength);
        const lengthComputable = Number.isFinite(total) && total >= 0;
        this._state = 2;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this._state = 3;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "progress", {
          loaded: bytes.byteLength,
          total: lengthComputable ? total : 0,
          lengthComputable
        }));
        this._state = 4;
        this._done = true;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "load"));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      finishError(error, generation) {
        if (this._done || generation !== this._generation) return;
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
  var MAX_PREFETCH_CONCURRENCY = 2;
  function abortError() {
    return new DOMException("The operation was aborted", "AbortError");
  }
  function isAbortError(error) {
    return error?.name === "AbortError";
  }
  function performanceNow(windowObject) {
    return typeof windowObject.performance?.now === "function" ? windowObject.performance.now() : Date.now();
  }
  function responseTypeConstructor(windowObject, name) {
    return windowObject[name] || globalThis[name];
  }
  function isRequestLike(value) {
    return value !== null && typeof value === "object" && typeof value.url === "string" && value.headers !== void 0;
  }
  function initField(init, field, inherited) {
    if (init !== null && (typeof init === "object" || typeof init === "function")) {
      const value = init[field];
      if (value !== void 0) return value;
    }
    return inherited;
  }
  function inspectFetchArguments(args, locationObject) {
    const [input, init] = args;
    const inherited = isRequestLike(input) ? input : void 0;
    const rawUrl = inherited === void 0 ? String(input) : inherited.url;
    const url = new URL(rawUrl, locationObject?.href).href;
    return {
      url,
      headers: initField(init, "headers", inherited?.headers),
      method: initField(init, "method", inherited?.method) || "GET",
      credentials: initField(init, "credentials", inherited?.credentials) || "same-origin",
      signal: initField(init, "signal", inherited?.signal)
    };
  }
  function waitWithSignal(promise, signal, windowObject, timeoutMs, timeoutError) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
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
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
      if (timeoutMs !== void 0) {
        timer = windowObject.setTimeout(() => finish(reject, timeoutError()), timeoutMs);
        if (settled) windowObject.clearTimeout(timer);
      }
    });
  }
  var SegmentBank = class {
    constructor({
      windowObject = window,
      nativeFetch = windowObject.fetch,
      maxPrefetchConcurrency = MAX_PREFETCH_CONCURRENCY,
      config = BANK_CONFIG,
      chunks = /* @__PURE__ */ new Map(),
      now = Date.now
    } = {}) {
      this.windowObject = windowObject;
      this.nativeFetch = nativeFetch;
      this.config = config;
      this.maxPrefetchConcurrency = maxPrefetchConcurrency;
      this.now = now;
      this.enabled = true;
      this.disabled = false;
      this.queue = [];
      this.inflight = /* @__PURE__ */ new Map();
      this.activePrefetch = /* @__PURE__ */ new Set();
      this.activeForeground = /* @__PURE__ */ new Set();
      this.sessionGeneration = 0;
      this.resourceState = /* @__PURE__ */ new Map();
      this.recentResourceKeys = [];
      this.chunks = chunks;
      this.fetchedChunks = /* @__PURE__ */ new Map();
      this.refetchCounts = /* @__PURE__ */ new Map();
      this.foregroundLatencyCount = 0;
      this.lastRouteWasVideo = this.windowObject.location === void 0 || isVideoLocation(this.windowObject.location);
      this.prefetchTimer = this.windowObject.setInterval?.(() => {
        void this.prefetch().catch((error) => {
          console.error("[BilibiliBuffer] 媒体分片预取失败", error);
        });
      }, 1e3);
    }
    isEnabled() {
      if (this.disabled) return false;
      const root = this.windowObject.document?.documentElement;
      const configured = root?.getAttribute?.(BANK_ENABLED_ATTRIBUTE);
      if (configured === "true") return true;
      if (configured === "false") return false;
      return this.enabled === true;
    }
    emitDiagnostic(code, data) {
      const message = {
        namespace: BANK_MESSAGE_NAMESPACE,
        direction: "event",
        type: BANK_DIAGNOSTIC_MESSAGE_TYPE,
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
    cacheKeyForRange(resourceKey, start) {
      return cacheKey(resourceKey, chunkIndex(start, this.config.chunkBytes));
    }
    currentByteByBank() {
      return Object.fromEntries(
        [...this.resourceState.entries()].filter(([, state]) => Number.isSafeInteger(state.lastForegroundEnd)).map(([key, state]) => [key, state.lastForegroundEnd])
      );
    }
    releaseSession() {
      this.sessionGeneration += 1;
      this.abortPrefetchTasks();
      for (const task of this.inflight.values()) {
        if (task.kind === "prefetch") continue;
        this.clearTaskDeadline(task);
        task.controller.abort();
      }
      for (const task of this.queue) {
        task.controller.abort();
        task.settled = true;
        task.reject(abortError());
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
      }
      this.queue = [];
      clearMemory(this.chunks);
      this.fetchedChunks.clear();
      this.refetchCounts.clear();
      this.foregroundLatencyCount = 0;
      this.resourceState.clear();
      this.recentResourceKeys = [];
      this.playbackSamples = [];
    }
    syncRouteLifecycle() {
      if (this.windowObject.location === void 0) return true;
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
        resourceKey
      ].slice(-2);
      const retained = new Set(nextKeys);
      this.abortPrefetchTasks((task) => !retained.has(task.bankKey));
      this.recentResourceKeys = nextKeys;
    }
    abortPrefetchTasks(predicate = () => true) {
      for (const task of this.inflight.values()) {
        if (task.kind === "prefetch" && predicate(task)) {
          this.clearTaskDeadline(task);
          task.controller.abort();
        }
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
        enabled: this.isEnabled(),
        locationObject: this.windowObject.location
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
    readStoredRange(bankKeyValue, start, end) {
      return readMemoryRange(this.chunks, bankKeyValue, start, end, this.config.chunkBytes);
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
      state.credentials = credentials || "same-origin";
      if (state.lastForegroundEnd !== end) state.prefetchEnd = void 0;
      state.lastForegroundEnd = end;
      const stored = this.readStoredRange(resourceKey, start, end);
      if (signal?.aborted) throw abortError();
      if (stored?.hit === true) {
        if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== rangeLength({ start, end })) {
          throw new BankFallbackError("媒体分片存储命中长度不符");
        }
        if (!Number.isSafeInteger(stored.totalSize) || stored.totalSize <= end) {
          throw new BankFallbackError("媒体分片存储命中总长度无效");
        }
        state.totalSize = stored.totalSize;
        this.noteForegroundSuccess();
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
        reason: "stored_range_missing"
      });
      return this.fetchForeground({
        resourceKey,
        url,
        credentials: state.credentials,
        start,
        end,
        totalSize: state.totalSize || stored?.totalSize,
        signal,
        videoKey: state.videoKey
      }).then((fetched) => {
        if (signal?.aborted) throw abortError();
        if (fetched.response !== void 0) return { intercepted: true, response: fetched.response };
        state.totalSize = fetched.totalSize;
        this.noteForegroundSuccess();
        return {
          intercepted: true,
          response: this.createResponse(fetched.bytes, start, end, fetched.totalSize, url),
          bytes: fetched.bytes,
          totalSize: fetched.totalSize
        };
      });
    }
    async fetchForeground({ resourceKey, url, credentials, start, end, totalSize, signal, videoKey }) {
      const plans = planFetchRanges(start, end, {
        chunkBytes: this.config.chunkBytes,
        totalSize,
        bankKeyValue: resourceKey
      });
      const results = await Promise.all(plans.map((plan) => {
        const stored = readMemoryRange(
          this.chunks,
          resourceKey,
          plan.start,
          plan.end,
          this.config.chunkBytes
        );
        if (stored.hit === true) {
          return {
            start: plan.start,
            end: plan.end,
            bytes: stored.bytes,
            totalSize: stored.totalSize
          };
        }
        return this.getTask(plan, {
          kind: "foreground",
          url,
          credentials,
          signal,
          videoKey
        });
      }));
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
      this.emitDiagnostic("bank.disabled", { reason });
    }
    noteRefetch(plan) {
      if (plan.cacheable === false || !this.fetchedChunks.has(plan.cacheKey)) return;
      const count = (this.refetchCounts.get(plan.cacheKey) || 0) + 1;
      this.refetchCounts.set(plan.cacheKey, count);
      if (count >= this.config.refetchAlarmCount) this.disable("refetch_alarm");
    }
    noteForegroundFallback() {
      this.foregroundLatencyCount += 1;
      if (this.foregroundLatencyCount >= this.config.latencyAlarmCount) this.disable("foreground_latency");
    }
    noteForegroundSuccess() {
      this.foregroundLatencyCount = 0;
    }
    clearTaskDeadline(task) {
      if (task.deadlineTimer !== void 0) {
        this.windowObject.clearTimeout(task.deadlineTimer);
        task.deadlineTimer = void 0;
      }
    }
    emitDeadlineDiagnostic(task) {
      if (task.deadlineReported === true) return;
      task.deadlineReported = true;
      this.emitChunkDiagnostic(
        task,
        0,
        performanceNow(this.windowObject) - task.startedAt,
        "deadline"
      );
    }
    startTask(task, activeSet) {
      task.started = true;
      task.startedAt = performanceNow(this.windowObject);
      activeSet.add(task);
      const deadlineMs = task.kind === "prefetch" ? this.config.prefetchDeadlineMs : this.config.foregroundDeadlineMs;
      task.deadlineTimer = this.windowObject.setTimeout(() => {
        if (task.settled || task.controller.signal.aborted) return;
        task.abortReason = "deadline";
        task.controller.abort();
        this.emitDeadlineDiagnostic(task);
      }, deadlineMs);
      void this.runTask(task).then((result) => {
        task.settled = true;
        task.resolve(result);
      }, (error) => {
        task.settled = true;
        task.reject(error);
      }).finally(() => {
        this.clearTaskDeadline(task);
        activeSet.delete(task);
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
        this.pump();
      });
    }
    getTask(plan, { kind, url, credentials, signal, videoKey }) {
      const existing = this.inflight.get(plan.cacheKey);
      if (existing !== void 0) {
        return this.waitForTask(existing, signal, kind, kind === "foreground");
      }
      if (kind === "prefetch" && plan.cacheable !== false && (this.fetchedChunks.has(plan.cacheKey) || this.chunks.has(plan.cacheKey))) {
        return Promise.resolve({ skipped: true, cacheKey: plan.cacheKey });
      }
      if (kind === "foreground") this.noteRefetch(plan);
      const controller = new AbortController();
      const task = {
        ...plan,
        bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf("#")),
        url,
        credentials,
        videoKey,
        kind,
        sessionGeneration: this.sessionGeneration,
        controller,
        started: false,
        startedAt: void 0,
        deadlineTimer: void 0,
        deadlineReported: false,
        abortReason: void 0,
        settled: false,
        waiters: 0,
        promise: void 0,
        resolve: void 0,
        reject: void 0
      };
      task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
      });
      this.inflight.set(plan.cacheKey, task);
      if (kind === "foreground") this.startTask(task, this.activeForeground);
      else this.queue.push(task);
      if (kind === "prefetch") this.pump();
      return this.waitForTask(task, signal, kind, false);
    }
    waitForTask(task, signal, kind, enforceDeadline) {
      task.waiters += 1;
      let timeoutError;
      return waitWithSignal(
        task.promise,
        signal,
        this.windowObject,
        enforceDeadline ? this.config.foregroundDeadlineMs : void 0,
        () => {
          timeoutError = new BankFallbackError("媒体分片等待超过补取死线");
          return timeoutError;
        }
      ).catch((error) => {
        if (error === timeoutError) {
          this.noteForegroundFallback();
          throw error;
        }
        if (kind === "foreground" && task.abortReason === "deadline") {
          this.noteForegroundFallback();
          if (isAbortError(error)) {
            throw new BankFallbackError("媒体分片网络取数超过死线", error);
          }
        }
        throw error;
      }).finally(() => {
        task.waiters -= 1;
        if (signal !== void 0 && signal.aborted && task.waiters === 0 && task.kind === "foreground" && !task.settled) {
          task.controller.abort();
        }
      });
    }
    pump() {
      while (this.activeForeground.size === 0 && this.activePrefetch.size < this.maxPrefetchConcurrency && this.queue.length > 0) {
        const task = this.queue.shift();
        if (task.controller.signal.aborted) {
          task.settled = true;
          task.reject(abortError());
          if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
          continue;
        }
        this.startTask(task, this.activePrefetch);
      }
    }
    taskAbortError(task, bytes, startedAt, error) {
      if (task.abortReason === "deadline") {
        this.emitDeadlineDiagnostic(task);
        if (task.kind === "foreground") {
          return new BankFallbackError("媒体分片网络取数超过死线", error);
        }
      } else {
        this.emitChunkDiagnostic(task, bytes, performanceNow(this.windowObject) - startedAt, "aborted");
      }
      return error;
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
        if (isAbortError(error)) throw this.taskAbortError(task, 0, startedAt, error);
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, result2);
        throw new BankNetworkError("媒体分片网络取数失败", error);
      }
      if (task.controller.signal.aborted) {
        throw this.taskAbortError(task, 0, startedAt, abortError());
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
          throw this.taskAbortError(task, 0, startedAt, error);
        }
        this.emitChunkDiagnostic(task, 0, performanceNow(this.windowObject) - startedAt, "network_error");
        throw new BankNetworkError("媒体分片响应读取失败", error);
      }
      if (task.controller.signal.aborted) {
        throw this.taskAbortError(task, bytes.byteLength, startedAt, abortError());
      }
      const contentRange = parseContentRange(headerValue(response.headers, "Content-Range"));
      const isCompleteTailChunk = contentRange !== void 0 && task.cacheable !== false && contentRange.start === task.start && contentRange.end < task.end && contentRange.end === contentRange.totalSize - 1;
      if (contentRange === void 0 || contentRange.start !== task.start || contentRange.end !== task.end && !isCompleteTailChunk) {
        this.emitChunkDiagnostic(
          task,
          bytes.byteLength,
          performanceNow(this.windowObject) - startedAt,
          "invalid_response"
        );
        throw new BankFallbackError("媒体分片网络 Content-Range 不匹配");
      }
      const resultRange = { start: contentRange.start, end: contentRange.end };
      if (bytes.byteLength !== rangeLength(resultRange)) {
        this.emitChunkDiagnostic(
          task,
          bytes.byteLength,
          performanceNow(this.windowObject) - startedAt,
          "invalid_response"
        );
        throw new BankFallbackError("媒体分片网络字节长度不匹配");
      }
      if (task.controller.signal.aborted) {
        throw this.taskAbortError(task, bytes.byteLength, startedAt, abortError());
      }
      const result = {
        ...resultRange,
        bytes,
        totalSize: contentRange.totalSize
      };
      if (task.cacheable !== false && task.sessionGeneration === this.sessionGeneration && this.enabled === true && this.disabled === false) {
        this.fetchedChunks.set(task.cacheKey, { fetchedAt: this.now() });
        try {
          this.storeTask(task, result);
        } catch (error) {
          this.emitDiagnostic("bank.store", {
            operation: "write",
            chunkIndex: task.chunkIndex,
            bytes: bytes.byteLength,
            result: "failed",
            reason: "write_error"
          });
          console.error("[BilibiliBuffer] 媒体分片内存写入失败", error);
          this.disable("store_write_failed");
        }
      }
      this.emitChunkDiagnostic(
        task,
        bytes.byteLength,
        performanceNow(this.windowObject) - startedAt,
        "fetched",
        resultRange
      );
      return result;
    }
    emitChunkDiagnostic(task, bytes, durationMs, result, range = task) {
      this.emitDiagnostic("bank.fetch.chunk", {
        source: scrubUrl(task.url),
        chunkIndex: task.chunkIndex,
        start: range.start,
        end: range.end,
        bytes,
        durationMs,
        priority: task.kind,
        result
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
          storedAt: this.now()
        });
        const eviction = enforceMemoryLimit({
          chunks: this.chunks,
          maxBankBytes: this.config.maxBankBytes,
          chunkBytes: this.config.chunkBytes,
          currentByteByBank: this.currentByteByBank()
        });
        this.emitDiagnostic("bank.store", {
          operation: "write",
          chunkIndex: written.chunkIndex,
          bytes: written.bytes,
          result: "stored",
          reason: "memory"
        });
        for (const entry of eviction.entries) {
          this.fetchedChunks.delete(entry.cacheKey);
          this.refetchCounts.delete(entry.cacheKey);
          this.emitDiagnostic("bank.store", {
            operation: "evict",
            chunkIndex: entry.chunkIndex,
            bytes: entry.byteLength,
            result: "evicted",
            reason: eviction.reason
          });
        }
        if (eviction.bytes > 0) {
          this.emitDiagnostic("bank.evict", {
            bytes: eviction.bytes,
            reason: eviction.reason
          });
        }
        return eviction;
      } catch (error) {
        if (previous === void 0) this.chunks.delete(task.cacheKey);
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
          if (plan.cacheable !== false && (this.chunks.has(plan.cacheKey) || this.fetchedChunks.has(plan.cacheKey))) continue;
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
      for (const task of this.inflight.values()) {
        this.clearTaskDeadline(task);
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
        if (!bank.disabled) bank.enabled = enabled === true;
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
