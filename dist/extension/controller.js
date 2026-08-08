(() => {
  // src/constants.js
  var VERSION = "1.0.0";
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
    chunkBytes: 1024 ** 2,
    maxBankBytes: 512 * 1024 ** 2,
    stallMs: 1e4,
    lookAheadChunks: 48,
    maxChunkAttempts: 3,
    raceLegs: 2,
    pairFreshnessMs: 36e5
  });
  var DIAGNOSTIC_MESSAGE_VERSION = 1;

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
    "video.visibility_changed",
    "video.core_replaced",
    "media.sample",
    "media.append",
    ...MEDIA_EVENT_NAMES.map((name) => `media.${name}`),
    "video.buffer_hint.attempt",
    "video.buffer_hint.applied",
    "video.buffer_hint.unsupported",
    "video.buffer_hint.failed",
    "video.buffer_observed",
    "bridge.error",
    "bank.fetch.chunk",
    "bank.serve",
    "bank.evict",
    "bank.store",
    "bank.disabled",
    "bank.inventory",
    "extension.started",
    "extension.boot_error",
    "extension.observer_error",
    "extension.destroyed",
    "log.persist.degraded"
  ]);
  var EXACT_CODES = new Set(EVENT_CODES);
  var PERSIST_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
  function isSafePersistErrorCode(code) {
    return typeof code === "string" && PERSIST_ERROR_CODE_PATTERN.test(code);
  }
  function assertEventCode(code) {
    if (typeof code !== "string" || !EXACT_CODES.has(code)) {
      throw new Error(`未允许的诊断事件代码: ${code}`);
    }
    return code;
  }
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
      "previousState",
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
      "source",
      "videoQuality",
      "sourceBufferRanges",
      "mediaSourceState",
      "appendErrors",
      "removeStats",
      "presented",
      "frameTiming",
      "mediaSourceInstance",
      "sourceBufferInstance",
      "appendSequence",
      "track",
      "bytes",
      "bufferedBefore",
      "bufferedAfter",
      "durationMs",
      "result",
      "errorName"
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
      "mirror",
      "operation",
      "chunkIndex",
      "start",
      "end",
      "bytes",
      "durationMs",
      "slot",
      "ttfbMs",
      "priority",
      "result",
      "reason",
      "sessionGeneration",
      "storedBytes",
      "storedChunks",
      "maxBankBytes",
      "queued",
      "inflight",
      "prefetchConcurrency",
      "disabled",
      "routeActive",
      "pairedAddressAvailable",
      "resources"
    ]),
    extension: Object.freeze(["action", "reason", "status"]),
    persist: Object.freeze(["status", "batchSize", "eventCount", "message", "code"])
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
  function finiteOrUnknown(value) {
    return Number.isFinite(value) ? value : UNKNOWN_VALUE;
  }
  function browserMetric(value) {
    if (!Number.isFinite(value)) {
      return UNKNOWN_VALUE;
    }
    if (value === 0) {
      return { value: 0, reportedBy: "browser" };
    }
    return value;
  }
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
  function scrubOrigin(value) {
    if (typeof value !== "string" || value.length === 0) return UNKNOWN_VALUE;
    try {
      return new URL(value).origin;
    } catch (error) {
      return UNKNOWN_VALUE;
    }
  }
  function scrubPathname(value) {
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error("pathname 必须是绝对路径");
    }
    return value.split(/[?#]/, 1)[0];
  }
  function safeScalar(value) {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : UNKNOWN_VALUE;
    return UNKNOWN_VALUE;
  }
  function scrubIdentifier(value) {
    if (typeof value !== "string") return safeScalar(value);
    const identifier = value.split(/[?#]/, 1)[0];
    return identifier.length === 0 ? UNKNOWN_VALUE : identifier;
  }
  function scrubErrorText(value) {
    if (typeof value !== "string") return UNKNOWN_VALUE;
    return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => scrubUrl(url));
  }
  function safeRangeList(value) {
    if (!Array.isArray(value)) return UNKNOWN_VALUE;
    return value.map((range) => {
      if (range === null || typeof range !== "object" || Array.isArray(range)) {
        throw new Error("媒体 range 结构无效");
      }
      return {
        start: finiteOrUnknown(range.start),
        end: finiteOrUnknown(range.end)
      };
    });
  }
  function safePositiveInteger(value) {
    return Number.isInteger(value) && value >= 1 ? value : UNKNOWN_VALUE;
  }
  function safeNonnegativeInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : UNKNOWN_VALUE;
  }
  function safeNonnegativeNumber(value) {
    return Number.isFinite(value) && value >= 0 ? value : UNKNOWN_VALUE;
  }
  function safeSourceState(value) {
    return ["closed", "open", "ended"].includes(value) ? value : UNKNOWN_VALUE;
  }
  function safeSourceBufferRanges(value) {
    if (!Array.isArray(value)) return UNKNOWN_VALUE;
    return value.map((track) => {
      if (track === null || typeof track !== "object" || Array.isArray(track)) {
        throw new Error("track buffer range structure is invalid");
      }
      const result = {
        track: safeScalar(track.track),
        ranges: safeRangeList(track.ranges)
      };
      if (Object.prototype.hasOwnProperty.call(track, "mediaSourceInstance")) {
        result.mediaSourceInstance = safePositiveInteger(track.mediaSourceInstance);
      }
      if (Object.prototype.hasOwnProperty.call(track, "sourceBufferInstance")) {
        result.sourceBufferInstance = safePositiveInteger(track.sourceBufferInstance);
      }
      if (Object.prototype.hasOwnProperty.call(track, "mediaSourceState")) {
        result.mediaSourceState = safeSourceState(track.mediaSourceState);
      }
      if (Object.prototype.hasOwnProperty.call(track, "updating")) {
        result.updating = track.updating === true || track.updating === false ? track.updating : UNKNOWN_VALUE;
      }
      if (Object.prototype.hasOwnProperty.call(track, "pendingSinceMs")) {
        result.pendingSinceMs = track.pendingSinceMs === null ? null : safeNonnegativeNumber(track.pendingSinceMs);
      }
      if (Object.prototype.hasOwnProperty.call(track, "lastAppendAgoMs")) {
        result.lastAppendAgoMs = safeNonnegativeNumber(track.lastAppendAgoMs);
      }
      if (Object.prototype.hasOwnProperty.call(track, "attached")) {
        result.attached = track.attached === true || track.attached === false ? track.attached : UNKNOWN_VALUE;
      }
      if (Object.prototype.hasOwnProperty.call(track, "appends")) {
        result.appends = safeNonnegativeInteger(track.appends);
      }
      if (Object.prototype.hasOwnProperty.call(track, "appendErrors")) {
        result.appendErrors = safeAppendErrors(track.appendErrors);
      }
      return result;
    });
  }
  function safeInventoryResources(value) {
    if (!Array.isArray(value)) return UNKNOWN_VALUE;
    return value.map((resource) => {
      if (resource === null || typeof resource !== "object" || Array.isArray(resource)) {
        throw new Error("inventory resource structure is invalid");
      }
      const pathname = typeof resource.pathname === "string" && resource.pathname.startsWith("/") ? scrubPathname(resource.pathname) : UNKNOWN_VALUE;
      const kind = ["video", "audio"].includes(resource.kind) ? resource.kind : UNKNOWN_VALUE;
      const label = typeof resource.label === "string" ? resource.label : UNKNOWN_VALUE;
      const codecs = typeof resource.codecs === "string" ? resource.codecs : UNKNOWN_VALUE;
      const active = resource.active === true || resource.active === false ? resource.active : UNKNOWN_VALUE;
      return {
        pathname,
        kind,
        label,
        height: safeNonnegativeInteger(resource.height),
        codecs,
        bandwidth: safeNonnegativeInteger(resource.bandwidth),
        storedBytes: safeNonnegativeInteger(resource.storedBytes),
        storedChunks: safeNonnegativeInteger(resource.storedChunks),
        totalSize: safeNonnegativeInteger(resource.totalSize),
        lastForegroundEnd: safeNonnegativeInteger(resource.lastForegroundEnd),
        outstanding: safeNonnegativeInteger(resource.outstanding),
        retrying: safeNonnegativeInteger(resource.retrying),
        active
      };
    });
  }
  function safeAppendErrors(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_VALUE;
    const result = {};
    for (const [name, count] of Object.entries(value)) {
      result[safeScalar(name)] = Number.isInteger(count) && count >= 0 ? count : UNKNOWN_VALUE;
    }
    return result;
  }
  function safeVideoQuality(value) {
    if (value === null) return null;
    if (value === UNKNOWN_VALUE) return value;
    if (typeof value !== "object" || Array.isArray(value)) return UNKNOWN_VALUE;
    return {
      total: finiteOrUnknown(value.total),
      dropped: finiteOrUnknown(value.dropped),
      corrupted: finiteOrUnknown(value.corrupted)
    };
  }
  function safeReportedMetric(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value.value === 0 && value.reportedBy === "browser") {
      return { value: 0, reportedBy: "browser" };
    }
    return browserMetric(value);
  }
  function safeFrameTiming(value) {
    if (value === UNKNOWN_VALUE) return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_VALUE;
    return {
      presentedTotal: safeReportedMetric(value.presentedTotal),
      maxFrameGapMs: finiteOrUnknown(value.maxFrameGapMs),
      maxFrameGapEndedAgoMs: finiteOrUnknown(value.maxFrameGapEndedAgoMs),
      processingMsMax: safeReportedMetric(value.processingMsMax),
      processingMsMedian: safeReportedMetric(value.processingMsMedian),
      appends: finiteOrUnknown(value.appends),
      lastAppendAgoMs: finiteOrUnknown(value.lastAppendAgoMs),
      updateEndMsMax: finiteOrUnknown(value.updateEndMsMax),
      displayLeadMsMedian: safeReportedMetric(value.displayLeadMsMedian),
      displayLeadMsMin: safeReportedMetric(value.displayLeadMsMin),
      mediaStepMsMedian: safeReportedMetric(value.mediaStepMsMedian),
      mediaStepMsMax: safeReportedMetric(value.mediaStepMsMax)
    };
  }
  function safeRemoveStats(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_VALUE;
    return {
      removeCalls: Number.isInteger(value.removeCalls) && value.removeCalls >= 0 ? value.removeCalls : UNKNOWN_VALUE
    };
  }
  function safeResolution(value) {
    if (value === UNKNOWN_VALUE) return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_VALUE;
    return {
      width: finiteOrUnknown(value.width),
      height: finiteOrUnknown(value.height)
    };
  }
  function sanitizeField(field, value) {
    if (field === "origin") return scrubOrigin(value);
    if (field === "pathname") {
      if (typeof value !== "string" || !value.startsWith("/")) return UNKNOWN_VALUE;
      return scrubPathname(value);
    }
    if (["bvid", "part", "watchLaterItem"].includes(field)) return scrubIdentifier(value);
    if (field === "source" || field === "previousSource" || field === "name") return scrubUrl(value);
    if (field === "bufferedRanges" || field === "seekableRanges" || field === "bufferedBefore" || field === "bufferedAfter") return safeRangeList(value);
    if (field === "sourceBufferRanges") return safeSourceBufferRanges(value);
    if (field === "resources") return safeInventoryResources(value);
    if (field === "videoQuality") return safeVideoQuality(value);
    if (field === "appendErrors") return safeAppendErrors(value);
    if (field === "removeStats") return safeRemoveStats(value);
    if (field === "resolution") return safeResolution(value);
    if (field === "frameTiming") return safeFrameTiming(value);
    if (field === "transferSize" || field === "encodedBodySize" || field === "decodedBodySize" || field === "startTime" || field === "duration" || field === "responseStart" || field === "responseEnd") {
      return browserMetric(value);
    }
    if (field === "enabled") return value === true || value === false ? value : UNKNOWN_VALUE;
    if (["disabled", "routeActive", "pairedAddressAvailable"].includes(field)) {
      return value === true || value === false ? value : UNKNOWN_VALUE;
    }
    if ([
      "sessionGeneration",
      "storedBytes",
      "storedChunks",
      "maxBankBytes",
      "queued",
      "inflight",
      "prefetchConcurrency"
    ].includes(field)) return safeNonnegativeInteger(value);
    if (field === "code") return isSafePersistErrorCode(value) ? value : UNKNOWN_VALUE;
    if (field === "message") return scrubErrorText(value);
    if (field === "samples") return safeSampleList(value);
    if (field === "mediaSourceInstance" || field === "sourceBufferInstance" || field === "appendSequence") {
      return safePositiveInteger(value);
    }
    if (field === "durationMs") return safeNonnegativeNumber(value);
    return safeScalar(value);
  }
  function safeSampleList(value) {
    if (!Array.isArray(value)) return UNKNOWN_VALUE;
    const out = [];
    for (const item of value) {
      if (typeof item === "number" && Number.isFinite(item)) out.push(Math.round(item * 1e3) / 1e3);
      else out.push(UNKNOWN_VALUE);
      if (out.length >= 600) break;
    }
    return out;
  }
  function sanitizeEventData(code, data = {}) {
    assertEventCode(code);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`诊断事件 data 必须是固定字段对象: ${code}`);
    }
    const fields = allowedDataFields(code);
    const result = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        result[field] = sanitizeField(field, data[field]);
      }
    }
    return result;
  }
  function normalizeEventForStorage(event) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("诊断事件必须是对象");
    }
    const allowed = /* @__PURE__ */ new Set([
      "sessionId",
      "sequence",
      "wallTime",
      "elapsedMs",
      "code",
      "videoInstance",
      "sourceInstance",
      "coreInstance",
      "data",
      "error"
    ]);
    for (const field of Object.keys(event)) {
      if (!allowed.has(field)) {
        throw new Error(`诊断事件字段未允许: ${field}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(event, "eventId")) {
      throw new Error("页面不得自报 eventId");
    }
    if (typeof event.sessionId !== "string" || !Number.isInteger(event.sequence) || event.sequence <= 0) {
      throw new Error("诊断事件缺少连续 session sequence");
    }
    if (typeof event.wallTime !== "string" || !Number.isFinite(event.elapsedMs)) {
      throw new Error("诊断事件时间字段无效");
    }
    assertEventCode(event.code);
    const result = {
      sessionId: event.sessionId,
      sequence: event.sequence,
      wallTime: event.wallTime,
      elapsedMs: event.elapsedMs,
      code: event.code
    };
    for (const field of ["videoInstance", "sourceInstance", "coreInstance"]) {
      if (Object.prototype.hasOwnProperty.call(event, field)) {
        if (!Number.isInteger(event[field]) || event[field] <= 0) {
          throw new Error(`诊断事件 ${field} 无效`);
        }
        result[field] = event[field];
      }
    }
    if (Object.prototype.hasOwnProperty.call(event, "data")) {
      const sanitizedData = sanitizeEventData(event.code, event.data);
      if (Object.keys(sanitizedData).length > 0) result.data = sanitizedData;
    }
    if (Object.prototype.hasOwnProperty.call(event, "error")) {
      result.error = sanitizeSerializedError(event.error);
    }
    return result;
  }
  function sanitizeSerializedError(error) {
    if (typeof error === "string") return scrubErrorText(error);
    if (error === null || typeof error !== "object" || Array.isArray(error)) return UNKNOWN_VALUE;
    const seen = /* @__PURE__ */ new WeakSet();
    let source = error;
    let result = {};
    const root = result;
    for (; ; ) {
      if (seen.has(source)) {
        result = "[Circular]";
        break;
      }
      seen.add(source);
      for (const field of ["name", "code", "message", "stack"]) {
        if (typeof source[field] === "string") {
          result[field] = scrubErrorText(source[field]);
        } else if (field === "code" && typeof source[field] === "number" && Number.isFinite(source[field])) {
          result[field] = String(source[field]);
        }
      }
      if (!Object.prototype.hasOwnProperty.call(source, "cause")) break;
      const cause = source.cause;
      if (typeof cause === "string") {
        result.cause = scrubErrorText(cause);
        break;
      }
      if (cause === null || typeof cause !== "object" || Array.isArray(cause)) {
        result.cause = UNKNOWN_VALUE;
        break;
      }
      if (seen.has(cause)) {
        result.cause = "[Circular]";
        break;
      }
      const next = {};
      result.cause = next;
      result = next;
      source = cause;
    }
    return root;
  }

  // src/build-id.js
  var BUILT_BUILD_ID = true ? "src-0d451b251fd9700101736c81" : "source-build";
  function readBuildId() {
    return BUILT_BUILD_ID;
  }

  // src/diagnostics/session.js
  function requireString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`session ${field} 无效`);
    }
    return value;
  }
  function createSessionIdentity({
    locationObject,
    routeKind,
    runtimeObject = globalThis,
    now = /* @__PURE__ */ new Date(),
    sessionId = globalThis.crypto?.randomUUID?.(),
    bvid,
    part,
    watchLaterItem
  }) {
    if (locationObject === void 0 || typeof locationObject !== "object") {
      throw new Error("session location 不可用");
    }
    const normalizedSessionId = requireString(sessionId, "sessionId");
    const origin = new URL(requireString(locationObject.origin, "origin")).origin;
    const pathname = scrubPathname(locationObject.pathname);
    const identity = {
      schemaVersion: 1,
      sessionId: normalizedSessionId,
      startedAt: now.toISOString(),
      extensionVersion: VERSION,
      buildId: readBuildId(runtimeObject),
      routeKind: requireString(routeKind, "routeKind"),
      origin,
      pathname
    };
    for (const [field, value] of Object.entries({ bvid, part, watchLaterItem })) {
      if (value !== void 0) {
        identity[field] = typeof value === "string" ? value : String(value);
      }
    }
    return identity;
  }
  var SESSION_FIELDS = Object.freeze([
    "schemaVersion",
    "sessionId",
    "startedAt",
    "extensionVersion",
    "buildId",
    "tabId",
    "routeKind",
    "origin",
    "pathname",
    "bvid",
    "part",
    "watchLaterItem"
  ]);

  // src/extension/bridge-contract.js
  var BRIDGE_VERSION = 1;
  var BRIDGE_REQUEST_EVENT = "bilibili-buffer:bridge-request-v1";
  var BRIDGE_RESPONSE_EVENT = "bilibili-buffer:bridge-response-v1";
  var BRIDGE_RESPONSE_ATTRIBUTE = "data-bilibili-buffer-bridge-response-v1";
  var SHIM_DIAGNOSTIC_ATTRIBUTE = "data-bilibili-buffer-shim-diagnostics";
  var SHIM_APPEND_EVENT = "bilibili-buffer:shim-append-v1";
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callCoreSync"
  ]);
  var BRIDGE_CORE_SYNC_METHODS = Object.freeze(["setStableBufferTime"]);
  function encodeMessage(message) {
    return JSON.stringify(message);
  }
  function decodeMessage(serialized) {
    const message = JSON.parse(serialized);
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("bridge message must be an object");
    }
    if (message.version !== BRIDGE_VERSION) {
      throw new Error(`bridge version ${message.version} is not supported`);
    }
    if (!Number.isInteger(message.id) || message.id <= 0) {
      throw new Error("bridge message id must be a positive integer");
    }
    return message;
  }
  function assertOperation(operation) {
    if (!BRIDGE_OPERATIONS.includes(operation)) {
      throw new Error(`bridge operation is not allowed: ${operation}`);
    }
    return operation;
  }
  function serializeError(error) {
    const errorCode = (value2) => {
      if (typeof value2 === "string") return value2;
      if (typeof value2 === "number" && Number.isFinite(value2)) return String(value2);
      return void 0;
    };
    const seen = /* @__PURE__ */ new WeakSet();
    let value = error;
    let serialized;
    if (value === void 0 || value === null) {
      serialized = { message: "未知错误" };
    } else if (typeof value !== "object" && typeof value !== "function") {
      serialized = { name: typeof value, message: String(value) };
    } else {
      serialized = {};
      let current = serialized;
      for (; ; ) {
        if (seen.has(value)) {
          current.cause = "[Circular]";
          break;
        }
        seen.add(value);
        const name = typeof value.name === "string" ? value.name : void 0;
        const code = errorCode(value.code);
        const message = typeof value.message === "string" ? value.message : String(value);
        const stack = typeof value.stack === "string" ? value.stack : void 0;
        if (name !== void 0) current.name = name;
        if (code !== void 0) current.code = code;
        current.message = message;
        if (stack !== void 0) current.stack = stack;
        const cause = value.cause;
        if (cause === void 0 || cause === null) break;
        if (typeof cause !== "object" && typeof cause !== "function") {
          current.cause = { name: typeof cause, message: String(cause) };
          break;
        }
        if (seen.has(cause)) {
          current.cause = "[Circular]";
          break;
        }
        current.cause = {};
        current = current.cause;
        value = cause;
      }
    }
    return {
      name: serialized.name || "Error",
      code: serialized.code || "BRIDGE_CALL_FAILED",
      message: serialized.message,
      ...serialized.stack === void 0 ? {} : { stack: serialized.stack },
      ...serialized.cause === void 0 ? {} : { cause: serialized.cause }
    };
  }

  // src/route.js
  function routeIdentity(locationObject) {
    const pathname = locationObject.pathname || "/";
    const part = new URLSearchParams(locationObject.search || "").get("p") || void 0;
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/video/")) {
      return { routeKind: "video", bvid: pathname.split("/")[2] || void 0, part };
    }
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/list/watchlater")) {
      return { routeKind: "video", watchLaterItem: pathname.split("/")[3] || void 0, part };
    }
    return { routeKind: "other", part };
  }

  // src/diagnostics/client.js
  var PERSIST_RETRY_BASE_DELAY_MS = 100;
  var PERSIST_RETRY_MAX_DELAY_MS = 5e3;
  var PERSIST_RETRY_MAX_ATTEMPTS = 5;
  function persistenceErrorCode(value) {
    const code = typeof value === "string" ? value : value?.code;
    return isSafePersistErrorCode(code) ? code : "LOG_PERSIST_FAILED";
  }
  function runtimeSendMessage(runtimeObject, message) {
    if (runtimeObject === void 0 || typeof runtimeObject.sendMessage !== "function") {
      throw new Error("日志 runtime.sendMessage 不可用");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        const result = runtimeObject.sendMessage(message, (response) => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError !== void 0) {
            finish(reject, new Error(lastError.message));
            return;
          }
          finish(resolve, response);
        });
        if (result !== void 0 && typeof result.then === "function") {
          result.then((response) => finish(resolve, response), (error) => finish(reject, error));
        }
      } catch (error) {
        finish(reject, error);
      }
    });
  }
  function eventNow() {
    return /* @__PURE__ */ new Date();
  }
  function contextFields(context) {
    const result = {};
    for (const field of ["videoInstance", "sourceInstance", "coreInstance"]) {
      if (context?.[field] !== void 0) result[field] = context[field];
    }
    return result;
  }
  var DiagnosticsClient = class {
    constructor({
      documentObject = document,
      windowObject = window,
      runtimeObject = chrome.runtime,
      locationObject = windowObject.location,
      loggerObject = console,
      now = eventNow
    } = {}) {
      this.documentObject = documentObject;
      this.windowObject = windowObject;
      this.runtimeObject = runtimeObject;
      this.locationObject = locationObject;
      this.logger = loggerObject;
      this.now = now;
      this.session = void 0;
      this.startedAtMilliseconds = 0;
      this.sequence = 0;
      this.pending = [];
      this.outbox = [];
      this.flushScheduled = false;
      this.flushPromise = void 0;
      this.retryTimer = void 0;
      this.retryItem = void 0;
      this.destroyed = false;
      this.tearingDown = false;
      this.persistence = "未提供";
      this.pendingPersistResult = void 0;
      this.noVideoTimer = void 0;
      this.startSession(routeIdentity(locationObject));
      this.documentObject?.defaultView?.addEventListener?.("pagehide", () => {
        this.beginTeardown();
        void this.flushForTeardown().catch((error) => {
          this.logger.error?.("[BilibiliBuffer] diagnostic teardown flush failed", serializeError(error));
        }).finally(() => this.destroy());
      }, { once: true });
    }
    startSession(route) {
      if (this.destroyed) throw new Error("诊断客户端已经销毁");
      this.enqueuePendingBatch();
      void this.flush();
      this.session = createSessionIdentity({
        locationObject: this.locationObject,
        routeKind: route.routeKind,
        runtimeObject: this.windowObject,
        bvid: route.bvid,
        part: route.part,
        watchLaterItem: route.watchLaterItem,
        now: this.now()
      });
      this.startedAtMilliseconds = Date.parse(this.session.startedAt);
      this.sequence = 0;
      this.persistence = "未提供";
      this.log("route.session_started", {
        routeKind: this.session.routeKind,
        origin: this.session.origin,
        pathname: this.session.pathname,
        bvid: this.session.bvid,
        part: this.session.part,
        watchLaterItem: this.session.watchLaterItem
      });
      void this.flush();
      this.scheduleNoVideoNotice();
      return this.session;
    }
    scheduleNoVideoNotice() {
      if (this.noVideoTimer !== void 0) {
        this.windowObject.clearTimeout(this.noVideoTimer);
      }
      this.noVideoTimer = this.windowObject.setTimeout(() => {
        this.noVideoTimer = void 0;
        this.log("route.no_video", { reason: "30秒内没有 video" });
      }, 3e4);
    }
    markVideoAvailable() {
      if (this.noVideoTimer !== void 0) {
        this.windowObject.clearTimeout(this.noVideoTimer);
        this.noVideoTimer = void 0;
      }
    }
    log(code, data = {}, error, context = {}) {
      if (this.destroyed || this.tearingDown) return;
      try {
        if (this.pendingPersistResult !== void 0 && !code.startsWith("log.persist.")) {
          const result = this.pendingPersistResult;
          this.pendingPersistResult = void 0;
          if (result.status === "DEGRADED") {
            this.append("log.persist.degraded", result, void 0, {});
          }
        }
        this.append(code, data, error, context);
        if (!code.startsWith("log.persist.")) this.scheduleFlush();
      } catch (logError) {
        try {
          this.logger.error?.("[BilibiliBuffer] diagnostic event rejected", serializeError(logError));
        } catch (mirrorError) {
          console.error("[BilibiliBuffer] diagnostic event rejection mirror failed", mirrorError);
        }
      }
    }
    append(code, data, error, context) {
      const now = this.now();
      const event = {
        sessionId: this.session.sessionId,
        sequence: this.sequence + 1,
        wallTime: now.toISOString(),
        elapsedMs: Math.max(0, now.getTime() - this.startedAtMilliseconds),
        code,
        ...contextFields(context)
      };
      event.data = data;
      if (error !== void 0) event.error = serializeError(error);
      const normalized = normalizeEventForStorage(event);
      this.sequence = normalized.sequence;
      this.pending.push(normalized);
      try {
        this.logger.log("[BilibiliBuffer][diagnostic]", normalized);
      } catch (consoleError) {
        this.logger.warn?.("[BilibiliBuffer] diagnostic console mirror failed", serializeError(consoleError));
      }
    }
    scheduleFlush() {
      if (this.flushScheduled || this.destroyed || this.tearingDown) return;
      this.flushScheduled = true;
      this.windowObject.setTimeout(() => {
        this.flushScheduled = false;
        void this.flush();
      }, 0);
    }
    async flush() {
      this.enqueuePendingBatch();
      return this.flushOutbox();
    }
    async flushForTeardown() {
      this.enqueuePendingBatch();
      for (; ; ) {
        const result = await (this.flushPromise || this.flushOutbox());
        if (result === void 0 || result.status === "DEGRADED" || this.outbox.length === 0) return;
      }
    }
    enqueuePendingBatch() {
      if (this.pending.length === 0 || this.session === void 0) return;
      this.outbox.push({
        session: this.session,
        batch: this.pending.splice(0, this.pending.length),
        failed: false,
        retryCount: 0,
        retryScheduled: false
      });
    }
    flushOutbox() {
      if (this.flushPromise !== void 0) return this.flushPromise;
      if (this.outbox.length === 0) return void 0;
      const item = this.outbox.shift();
      this.cancelScheduledRetry(item);
      item.failed = false;
      const { batch, session } = item;
      this.flushPromise = runtimeSendMessage(this.runtimeObject, {
        version: DIAGNOSTIC_MESSAGE_VERSION,
        type: "diagnostic:events",
        session,
        events: batch
      }).then((response) => {
        if (response?.ok !== true || !["PERSISTED", "DUPLICATE"].includes(response.status)) {
          throw Object.assign(new Error(response?.error?.message || "日志事务没有提交"), {
            code: persistenceErrorCode(response?.error)
          });
        }
        this.persistence = response.status;
        this.pendingPersistResult = {
          status: response.status,
          batchSize: batch.length,
          eventCount: response.eventCount
        };
        return response;
      }).catch((error) => {
        this.persistence = "DEGRADED";
        item.failed = true;
        item.retryCount += 1;
        this.outbox.unshift(item);
        this.pendingPersistResult = {
          status: "DEGRADED",
          batchSize: batch.length,
          message: error.message || String(error),
          code: persistenceErrorCode(error)
        };
        try {
          this.logger.error?.("[BilibiliBuffer] diagnostic persistence degraded", serializeError(error));
        } catch (consoleError) {
          this.logger.warn?.("[BilibiliBuffer] diagnostic degraded mirror failed", serializeError(consoleError));
        }
        this.scheduleHeadRetry(item);
        return { status: "DEGRADED", error: serializeError(error) };
      }).finally(() => {
        this.flushPromise = void 0;
        if (!this.destroyed && !this.tearingDown && this.outbox.length > 0 && this.outbox[0].failed !== true) {
          void this.flushOutbox();
        }
      });
      return this.flushPromise;
    }
    cancelScheduledRetry(item) {
      if (this.retryItem !== item) return;
      this.windowObject.clearTimeout(this.retryTimer);
      this.retryTimer = void 0;
      this.retryItem = void 0;
      item.retryScheduled = false;
    }
    scheduleHeadRetry(item) {
      if (this.destroyed || this.tearingDown || this.outbox[0] !== item || item.retryCount > PERSIST_RETRY_MAX_ATTEMPTS || item.retryScheduled === true) return;
      const delay = Math.min(
        PERSIST_RETRY_BASE_DELAY_MS * 2 ** (item.retryCount - 1),
        PERSIST_RETRY_MAX_DELAY_MS
      );
      item.retryScheduled = true;
      this.retryItem = item;
      this.retryTimer = this.windowObject.setTimeout(() => {
        this.retryTimer = void 0;
        this.retryItem = void 0;
        item.retryScheduled = false;
        if (!this.destroyed && !this.tearingDown && this.outbox[0] === item) void this.flushOutbox();
      }, delay);
    }
    getStatus() {
      return {
        sessionId: this.session?.sessionId || "未提供",
        persistence: this.persistence
      };
    }
    beginTeardown() {
      if (this.tearingDown) return;
      this.tearingDown = true;
      if (this.retryItem !== void 0) this.cancelScheduledRetry(this.retryItem);
      if (this.noVideoTimer !== void 0) this.windowObject.clearTimeout(this.noVideoTimer);
    }
    destroy() {
      if (this.destroyed) return;
      this.beginTeardown();
      this.destroyed = true;
    }
  };

  // src/diagnostics/media.js
  function readRanges(timeRanges) {
    if (timeRanges === void 0 || timeRanges === null) return UNKNOWN_VALUE;
    const result = [];
    for (let index = 0; index < timeRanges.length; index += 1) {
      result.push({ start: timeRanges.start(index), end: timeRanges.end(index) });
    }
    return result;
  }
  function readNumber(value) {
    return Number.isFinite(value) ? value : UNKNOWN_VALUE;
  }
  function readVideoQuality(video) {
    if (typeof video.getVideoPlaybackQuality !== "function") return UNKNOWN_VALUE;
    try {
      const quality = video.getVideoPlaybackQuality();
      return {
        total: readNumber(quality.totalVideoFrames),
        dropped: readNumber(quality.droppedVideoFrames),
        corrupted: readNumber(quality.corruptedVideoFrames)
      };
    } catch (error) {
      console.error("[BilibiliBuffer] video playback quality read failed", error);
      return UNKNOWN_VALUE;
    }
  }
  function readShimDiagnostics(video) {
    const attribute = video.ownerDocument?.documentElement?.getAttribute(SHIM_DIAGNOSTIC_ATTRIBUTE);
    if (attribute === null || attribute === void 0) {
      return {
        sourceBufferRanges: UNKNOWN_VALUE,
        mediaSourceState: UNKNOWN_VALUE,
        appendErrors: UNKNOWN_VALUE,
        removeStats: UNKNOWN_VALUE,
        appends: UNKNOWN_VALUE,
        lastAppendAt: UNKNOWN_VALUE,
        updateEndMsMax: UNKNOWN_VALUE,
        updateEndAt: UNKNOWN_VALUE
      };
    }
    try {
      const value = JSON.parse(attribute);
      return {
        sourceBufferRanges: value.sourceBufferRanges,
        mediaSourceState: value.mediaSourceState,
        appendErrors: value.appendErrors,
        removeStats: value.removeStats,
        appends: value.appends,
        lastAppendAt: value.lastAppendAt,
        updateEndMsMax: value.updateEndMsMax,
        updateEndAt: value.updateEndAt
      };
    } catch (error) {
      console.error("[BilibiliBuffer] shim diagnostic read failed", error);
      return {
        sourceBufferRanges: UNKNOWN_VALUE,
        mediaSourceState: UNKNOWN_VALUE,
        appendErrors: UNKNOWN_VALUE,
        removeStats: UNKNOWN_VALUE,
        appends: UNKNOWN_VALUE,
        lastAppendAt: UNKNOWN_VALUE,
        updateEndMsMax: UNKNOWN_VALUE,
        updateEndAt: UNKNOWN_VALUE
      };
    }
  }
  function readMediaFacts(video, eventType = "sample") {
    if (video === void 0 || video === null) return UNKNOWN_VALUE;
    const bufferedRanges = readRanges(video.buffered);
    const seekableRanges = readRanges(video.seekable);
    const shimDiagnostics = readShimDiagnostics(video);
    return {
      eventType,
      bufferedRanges,
      seekableRanges,
      currentTime: readNumber(video.currentTime),
      duration: readNumber(video.duration),
      paused: typeof video.paused === "boolean" ? video.paused : UNKNOWN_VALUE,
      ended: typeof video.ended === "boolean" ? video.ended : UNKNOWN_VALUE,
      readyState: readNumber(video.readyState),
      networkState: readNumber(video.networkState),
      resolution: {
        width: readNumber(video.videoWidth),
        height: readNumber(video.videoHeight)
      },
      playbackRate: readNumber(video.playbackRate),
      source: video.currentSrc || video.src || UNKNOWN_VALUE,
      videoQuality: readVideoQuality(video),
      sourceBufferRanges: shimDiagnostics.sourceBufferRanges,
      mediaSourceState: shimDiagnostics.mediaSourceState,
      appendErrors: shimDiagnostics.appendErrors,
      removeStats: shimDiagnostics.removeStats,
      appends: shimDiagnostics.appends,
      lastAppendAt: shimDiagnostics.lastAppendAt,
      updateEndMsMax: shimDiagnostics.updateEndMsMax,
      updateEndAt: shimDiagnostics.updateEndAt
    };
  }
  function emptyMediaFacts(eventType) {
    return {
      eventType,
      bufferedRanges: UNKNOWN_VALUE,
      seekableRanges: UNKNOWN_VALUE,
      currentTime: UNKNOWN_VALUE,
      duration: UNKNOWN_VALUE,
      paused: UNKNOWN_VALUE,
      ended: UNKNOWN_VALUE,
      readyState: UNKNOWN_VALUE,
      networkState: UNKNOWN_VALUE,
      resolution: { width: UNKNOWN_VALUE, height: UNKNOWN_VALUE },
      playbackRate: UNKNOWN_VALUE,
      source: UNKNOWN_VALUE,
      videoQuality: UNKNOWN_VALUE,
      sourceBufferRanges: UNKNOWN_VALUE,
      mediaSourceState: UNKNOWN_VALUE,
      appendErrors: UNKNOWN_VALUE,
      removeStats: UNKNOWN_VALUE,
      appends: UNKNOWN_VALUE,
      lastAppendAt: UNKNOWN_VALUE,
      updateEndMsMax: UNKNOWN_VALUE,
      updateEndAt: UNKNOWN_VALUE
    };
  }
  function runtimeNow(runtimeObject) {
    const value = runtimeObject?.performance?.now?.();
    return Number.isFinite(value) ? value : UNKNOWN_VALUE;
  }
  function finiteDelta(value, previous) {
    if (!Number.isFinite(value) || !Number.isFinite(previous)) return 0;
    return Math.max(0, value - previous);
  }
  function rawMetric(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value.value === 0 && value.reportedBy === "browser") return 0;
    return value;
  }
  function qualityDelta(value, previous) {
    if (!Number.isFinite(value) || !Number.isFinite(previous)) return void 0;
    return value - previous;
  }
  function median(values) {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    if (ordered.length % 2 === 1) return ordered[middle];
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }
  function classifyStall({
    currentTime,
    bufferedRanges,
    totalDelta,
    droppedDelta,
    mediaStepMsMedian,
    mediaStepMsMax
  }) {
    const hasBufferedData = Number.isFinite(currentTime) && Array.isArray(bufferedRanges) && bufferedRanges.some((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.start <= currentTime && range.end > currentTime);
    if (!hasBufferedData) return "数据侧";
    if (totalDelta === 0) return "帧未产出";
    const mediaStepMedian = rawMetric(mediaStepMsMedian);
    const mediaStepMax = rawMetric(mediaStepMsMax);
    const mediaStepGap = Number.isFinite(mediaStepMedian) && Number.isFinite(mediaStepMax) && mediaStepMax > mediaStepMedian;
    if (totalDelta > 0 && (droppedDelta > 0 || mediaStepGap)) return "帧未呈现";
    return "未判定";
  }
  var MediaEventRecorder = class {
    constructor({
      video,
      logger: logger2,
      runtimeObject = globalThis,
      context = () => ({}),
      onEvent = () => {
      },
      onFrame = () => {
      },
      now = () => runtimeNow(runtimeObject),
      wallNow = () => Date.now()
    }) {
      this.video = video;
      this.logger = logger2 || {
        log() {
        }
      };
      this.runtimeObject = runtimeObject;
      this.context = context;
      this.onEvent = onEvent;
      this.onFrame = onFrame;
      this.now = now;
      this.wallNow = wallNow;
      this.listeners = [];
      this.sampleTimer = void 0;
      this.frameCallbackActive = false;
      this.destroyed = false;
      this.previousPresentedFrames = void 0;
      this.previousMediaTime = void 0;
      this.previousVideoQuality = void 0;
      this.presentedFramesTotal = void 0;
      this.frameCallbackSupported = typeof this.video.requestVideoFrameCallback === "function";
      this.intervalPresented = this.frameCallbackSupported ? 0 : UNKNOWN_VALUE;
      this.intervalFrameCount = 0;
      this.intervalMaxFrameGapMs = void 0;
      this.intervalMaxFrameGapEndedAt = void 0;
      this.intervalProcessingDurations = [];
      this.intervalDisplayLeads = [];
      this.intervalMediaSteps = [];
      this.lastFrameTimestamp = void 0;
      this.lastUpdateEndAt = void 0;
      this.updateEndBaselineEstablished = false;
      this.visibilityDocument = void 0;
      this.visibilityListener = void 0;
      this.visibilityState = UNKNOWN_VALUE;
      this.lastStall = void 0;
    }
    start() {
      if (this.destroyed) throw new Error("媒体日志 recorder 已销毁");
      for (const name of MEDIA_EVENT_NAMES) {
        const listener = () => {
          try {
            this.onEvent(name, this.video);
          } catch (error) {
            this.writeLog("extension.observer_error", { reason: `media-event:${name}` }, error);
          }
          this.logMediaEvent(name, name === "error" ? this.video.error : void 0);
        };
        this.video.addEventListener(name, listener);
        this.listeners.push([name, listener]);
      }
      this.startVisibilityRecording();
      this.sample();
      this.sampleTimer = this.runtimeObject.setInterval(() => this.sample(), 1e3);
      this.scheduleFrameCallback();
    }
    sample() {
      if (this.destroyed) return;
      this.logMediaEvent("sample");
    }
    logMediaEvent(name, error) {
      let facts;
      try {
        facts = readMediaFacts(this.video, name);
      } catch (error2) {
        this.writeLog("extension.observer_error", { reason: "media-facts" }, error2);
        facts = emptyMediaFacts(name);
      }
      const recordNow = this.now();
      const {
        data,
        currentTime,
        totalDelta,
        droppedDelta
      } = this.mediaRecordData(facts, recordNow);
      if (name === "waiting") {
        this.lastStall = {
          atMs: this.wallNow(),
          kind: classifyStall({
            currentTime,
            bufferedRanges: facts.bufferedRanges,
            totalDelta,
            droppedDelta,
            mediaStepMsMedian: data.frameTiming.mediaStepMsMedian,
            mediaStepMsMax: data.frameTiming.mediaStepMsMax
          })
        };
      }
      try {
        this.writeLog(`media.${name}`, data, error);
      } finally {
        this.previousVideoQuality = {
          total: Number.isFinite(facts.videoQuality?.total) ? facts.videoQuality.total : void 0,
          dropped: Number.isFinite(facts.videoQuality?.dropped) ? facts.videoQuality.dropped : void 0
        };
        this.resetInterval();
      }
    }
    writeLog(code, data, error) {
      try {
        this.logger.log(code, data, error, this.context());
      } catch (logError) {
        this.logger.error?.("[BilibiliBuffer] media diagnostic failed", logError);
      }
    }
    scheduleFrameCallback() {
      if (this.destroyed || this.frameCallbackActive || !this.frameCallbackSupported) return;
      this.frameCallbackActive = true;
      try {
        this.video.requestVideoFrameCallback((callbackNow, metadata) => {
          this.frameCallbackActive = false;
          if (this.destroyed) return;
          try {
            this.recordFrame(callbackNow, metadata);
            this.onFrame(this.video, metadata);
          } catch (error) {
            this.writeLog("extension.observer_error", { reason: "decoded-frame" }, error);
          }
          this.scheduleFrameCallback();
        });
      } catch (error) {
        this.frameCallbackActive = false;
        this.writeLog("extension.observer_error", { reason: "frame-callback" }, error);
      }
    }
    startVisibilityRecording() {
      this.visibilityDocument = this.video?.ownerDocument || this.runtimeObject?.document;
      this.visibilityState = this.readVisibilityState();
      this.writeLog("video.visibility_changed", {
        state: this.visibilityState,
        previousState: UNKNOWN_VALUE
      });
      if (typeof this.visibilityDocument?.addEventListener !== "function") return;
      this.visibilityListener = () => {
        const previousState = this.visibilityState;
        this.visibilityState = this.readVisibilityState();
        this.writeLog("video.visibility_changed", {
          state: this.visibilityState,
          previousState
        });
      };
      this.visibilityDocument.addEventListener("visibilitychange", this.visibilityListener);
    }
    readVisibilityState() {
      const state = this.visibilityDocument?.visibilityState;
      return state === "visible" || state === "hidden" ? state : UNKNOWN_VALUE;
    }
    recordFrame(callbackNow, metadata = {}) {
      const frameMetadata = metadata ?? {};
      const frameTimestamp = Number.isFinite(callbackNow) ? callbackNow : this.now();
      this.intervalFrameCount += 1;
      if (Number.isFinite(this.lastFrameTimestamp)) {
        const gapMs = Math.max(0, frameTimestamp - this.lastFrameTimestamp);
        if (this.intervalMaxFrameGapMs === void 0 || gapMs > this.intervalMaxFrameGapMs) {
          this.intervalMaxFrameGapMs = gapMs;
          this.intervalMaxFrameGapEndedAt = frameTimestamp;
        }
      }
      this.lastFrameTimestamp = frameTimestamp;
      if (Number.isFinite(frameMetadata.presentedFrames)) {
        this.presentedFramesTotal = frameMetadata.presentedFrames;
        this.intervalPresented = (this.intervalPresented === UNKNOWN_VALUE ? 0 : this.intervalPresented) + finiteDelta(frameMetadata.presentedFrames, this.previousPresentedFrames);
        this.previousPresentedFrames = frameMetadata.presentedFrames;
      }
      if (Number.isFinite(frameMetadata.processingDuration)) {
        this.intervalProcessingDurations.push(frameMetadata.processingDuration * 1e3);
      }
      if (Number.isFinite(frameMetadata.expectedDisplayTime) && Number.isFinite(frameMetadata.presentationTime)) {
        this.intervalDisplayLeads.push(
          frameMetadata.expectedDisplayTime - frameMetadata.presentationTime
        );
      }
      if (Number.isFinite(frameMetadata.mediaTime)) {
        if (Number.isFinite(this.previousMediaTime)) {
          const mediaStepSeconds = frameMetadata.mediaTime - this.previousMediaTime;
          if (Number.isFinite(mediaStepSeconds) && mediaStepSeconds > 0) {
            this.intervalMediaSteps.push(mediaStepSeconds * 1e3);
          }
        }
        this.previousMediaTime = frameMetadata.mediaTime;
      } else {
        this.previousMediaTime = void 0;
      }
    }
    mediaRecordData(facts, recordNow) {
      const {
        appends,
        lastAppendAt,
        updateEndMsMax: rawUpdateEndMsMax,
        updateEndAt,
        ...loggedFacts
      } = facts;
      const maxFrameGapMs = this.intervalFrameCount === 0 && Number.isFinite(recordNow) && Number.isFinite(this.lastFrameTimestamp) ? Math.max(0, recordNow - this.lastFrameTimestamp) : this.intervalMaxFrameGapMs === void 0 ? UNKNOWN_VALUE : this.intervalMaxFrameGapMs;
      const maxFrameGapEndedAgoMs = Number.isFinite(this.intervalMaxFrameGapEndedAt) && Number.isFinite(recordNow) ? Math.max(0, recordNow - this.intervalMaxFrameGapEndedAt) : UNKNOWN_VALUE;
      const processingMsMax = this.intervalProcessingDurations.length === 0 ? UNKNOWN_VALUE : browserMetric(Math.max(...this.intervalProcessingDurations));
      const processingMsMedian = this.intervalProcessingDurations.length === 0 ? UNKNOWN_VALUE : browserMetric(median(this.intervalProcessingDurations));
      const displayLeadMsMedian = this.intervalDisplayLeads.length === 0 ? UNKNOWN_VALUE : browserMetric(Math.round(median(this.intervalDisplayLeads)));
      const displayLeadMsMin = this.intervalDisplayLeads.length === 0 ? UNKNOWN_VALUE : browserMetric(Math.round(Math.min(...this.intervalDisplayLeads)));
      const mediaStepMsMedian = this.intervalMediaSteps.length === 0 ? UNKNOWN_VALUE : browserMetric(Math.round(median(this.intervalMediaSteps)));
      const mediaStepMsMax = this.intervalMediaSteps.length === 0 ? UNKNOWN_VALUE : browserMetric(Math.round(Math.max(...this.intervalMediaSteps)));
      const updateEndMsMax = this.readUpdateEndMsMax({ updateEndAt, updateEndMsMax: rawUpdateEndMsMax });
      const presented = this.intervalPresented;
      const currentTime = loggedFacts.currentTime;
      const totalDelta = qualityDelta(
        loggedFacts.videoQuality?.total,
        this.previousVideoQuality?.total
      );
      const droppedDelta = qualityDelta(
        loggedFacts.videoQuality?.dropped,
        this.previousVideoQuality?.dropped
      );
      const data = {
        ...loggedFacts,
        presented,
        frameTiming: {
          presentedTotal: Number.isFinite(this.presentedFramesTotal) ? browserMetric(this.presentedFramesTotal) : UNKNOWN_VALUE,
          maxFrameGapMs,
          maxFrameGapEndedAgoMs,
          processingMsMax,
          processingMsMedian,
          appends: Number.isFinite(appends) ? appends : UNKNOWN_VALUE,
          lastAppendAgoMs: Number.isFinite(recordNow) && Number.isFinite(lastAppendAt) ? Math.max(0, recordNow - lastAppendAt) : UNKNOWN_VALUE,
          updateEndMsMax,
          displayLeadMsMedian,
          displayLeadMsMin,
          mediaStepMsMedian,
          mediaStepMsMax
        }
      };
      return { data, currentTime, totalDelta, droppedDelta };
    }
    getLastStall() {
      return this.lastStall === void 0 ? void 0 : { ...this.lastStall };
    }
    readUpdateEndMsMax(facts) {
      if (!this.updateEndBaselineEstablished) {
        this.updateEndBaselineEstablished = true;
        this.lastUpdateEndAt = Number.isFinite(facts.updateEndAt) ? facts.updateEndAt : void 0;
        return UNKNOWN_VALUE;
      }
      if (!Number.isFinite(facts.updateEndAt) || facts.updateEndAt <= (this.lastUpdateEndAt ?? Number.NEGATIVE_INFINITY)) {
        return UNKNOWN_VALUE;
      }
      this.lastUpdateEndAt = facts.updateEndAt;
      return Number.isFinite(facts.updateEndMsMax) ? facts.updateEndMsMax : UNKNOWN_VALUE;
    }
    resetInterval() {
      this.intervalPresented = this.frameCallbackSupported ? 0 : UNKNOWN_VALUE;
      this.intervalFrameCount = 0;
      this.intervalMaxFrameGapMs = void 0;
      this.intervalMaxFrameGapEndedAt = void 0;
      this.intervalProcessingDurations = [];
      this.intervalDisplayLeads = [];
      this.intervalMediaSteps = [];
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const [name, listener] of this.listeners) this.video.removeEventListener(name, listener);
      this.listeners = [];
      if (this.visibilityListener !== void 0) {
        this.visibilityDocument?.removeEventListener?.("visibilitychange", this.visibilityListener);
        this.visibilityListener = void 0;
      }
      if (this.sampleTimer !== void 0) this.runtimeObject.clearInterval(this.sampleTimer);
      this.sampleTimer = void 0;
    }
  };

  // src/diagnostics/passive-media-observer.js
  function currentSource(video) {
    return video?.currentSrc || video?.src || "";
  }
  var PassiveMediaObserver = class {
    constructor({
      documentObject = document,
      windowObject = window,
      runtimeObject = windowObject,
      diagnostics,
      getVideo,
      initialVideo
    }) {
      if (typeof getVideo !== "function") throw new Error("被动媒体诊断缺少 video 选择器");
      this.documentObject = documentObject;
      this.windowObject = windowObject;
      this.runtimeObject = runtimeObject;
      this.diagnostics = diagnostics;
      this.getVideo = getVideo;
      this.video = initialVideo;
      this.videoInstance = 0;
      this.sourceInstance = 0;
      this.sourceKey = "";
      this.recorder = void 0;
      this.mutationObserver = void 0;
      this.reconcileTimer = void 0;
      this.started = false;
      this.destroyed = false;
      this.boundMutation = () => this.reconcile();
    }
    context() {
      return {
        videoInstance: this.videoInstance || void 0,
        sourceInstance: this.sourceInstance || void 0
      };
    }
    start() {
      if (this.destroyed) throw new Error("被动媒体诊断已经销毁");
      if (this.started) throw new Error("被动媒体诊断已经启动");
      this.started = true;
      if (typeof this.windowObject.MutationObserver === "function") {
        this.mutationObserver = new this.windowObject.MutationObserver(this.boundMutation);
        this.mutationObserver.observe(this.documentObject, { childList: true, subtree: true });
      }
      this.reconcileTimer = this.runtimeObject.setInterval(() => this.reconcile(), 500);
      const initialVideo = this.video;
      this.video = void 0;
      this.bindVideo(this.getVideo() || initialVideo);
    }
    reconcile() {
      if (this.destroyed || !this.started) return;
      const nextVideo = this.getVideo();
      if (nextVideo === void 0) return;
      if (nextVideo !== this.video) {
        this.bindVideo(nextVideo);
        return;
      }
      this.rebindSourceIfNeeded();
    }
    bindVideo(video) {
      if (video === void 0) return;
      const previousVideo = this.video;
      const previousSource = this.sourceKey;
      this.recorder?.destroy();
      this.video = video;
      this.videoInstance += 1;
      this.sourceKey = currentSource(video);
      if (this.sourceKey !== "") this.sourceInstance += 1;
      if (previousVideo !== void 0) {
        this.diagnostics?.log("video.replaced", { reason: "passive_video_replaced" }, void 0, this.context());
        if (previousSource !== this.sourceKey) {
          this.diagnostics?.log("video.source_replaced", {
            previousSource,
            source: this.sourceKey,
            reason: "video_replaced"
          }, void 0, this.context());
        }
      }
      this.diagnostics?.markVideoAvailable();
      this.diagnostics?.log("video.attached", {
        source: this.sourceKey,
        reason: "passive_video_bound"
      }, void 0, this.context());
      this.recorder = new MediaEventRecorder({
        video,
        logger: this.diagnostics,
        runtimeObject: this.runtimeObject,
        context: () => this.context()
      });
      this.recorder.start();
    }
    rebindSourceIfNeeded() {
      const nextSource = currentSource(this.video);
      if (nextSource === this.sourceKey) return;
      const previousSource = this.sourceKey;
      this.sourceKey = nextSource;
      this.sourceInstance += 1;
      this.diagnostics?.log("video.source_replaced", {
        previousSource,
        source: nextSource,
        reason: "passive_source_replaced"
      }, void 0, this.context());
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.started = false;
      this.mutationObserver?.disconnect();
      this.mutationObserver = void 0;
      if (this.reconcileTimer !== void 0) {
        this.runtimeObject.clearInterval(this.reconcileTimer);
        this.reconcileTimer = void 0;
      }
      this.recorder?.destroy();
      this.recorder = void 0;
      this.diagnostics?.log("video.destroyed", { reason: "passive_observer_destroyed" }, void 0, this.context());
    }
  };

  // src/errors.js
  var BufferScriptError = class extends Error {
    constructor(code, message, cause) {
      super(message, { cause });
      this.name = "BufferScriptError";
      this.code = code;
    }
  };
  function fail(code, message, cause) {
    throw new BufferScriptError(code, message, cause);
  }
  function toBufferScriptError(error, code, message) {
    if (error instanceof BufferScriptError) {
      return error;
    }
    return new BufferScriptError(code, message, error);
  }

  // src/vod/buffer.js
  function copyTimeRanges(timeRanges) {
    if (timeRanges === void 0 || timeRanges === null) {
      fail("VOD_BUFFER_RANGES_MISSING", "播放器没有提供 buffered ranges");
    }
    const ranges = [];
    for (let index = 0; index < timeRanges.length; index += 1) {
      const start = timeRanges.start(index);
      const end = timeRanges.end(index);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        fail("VOD_BUFFER_RANGES_INVALID", `buffered range ${index} 无效`);
      }
      ranges.push({ start, end });
    }
    return ranges;
  }
  function rangeContainingCurrentTime(ranges, currentTime) {
    const match = ranges.find((range) => range.start <= currentTime && currentTime <= range.end);
    return match === void 0 ? 0 : Math.max(0, match.end - currentTime);
  }
  function computeForwardInventory(currentTime, tracks) {
    if (!Number.isFinite(currentTime)) {
      fail("VOD_CURRENT_TIME_INVALID", `currentTime 无效: ${currentTime}`);
    }
    if (!Array.isArray(tracks) || tracks.length === 0) {
      fail("VOD_TRACKS_MISSING", "没有可用于计算库存的音视频轨道");
    }
    const inventories = tracks.map((track) => rangeContainingCurrentTime(track, currentTime));
    return Math.min(...inventories);
  }

  // src/vod/controller.js
  var WAITING_MESSAGE = "等待原生 video、媒体 source 和播放器内核";
  function createLogger() {
    return {
      warn(...args) {
        console.warn("[BilibiliBuffer]", ...args);
      },
      error(...args) {
        console.error("[BilibiliBuffer]", ...args);
      }
    };
  }
  function currentVideoSource(video) {
    return video?.currentSrc || video?.src || "";
  }
  function readNativeForwardBuffer(video) {
    if (video === void 0) return 0;
    return computeForwardInventory(video.currentTime, [copyTimeRanges(video.buffered)]);
  }
  function isWaitingForBridge(error) {
    return ["PLAYER_UNAVAILABLE", "VOD_CORE_UNAVAILABLE", "BRIDGE_CORE_STALE"].includes(error?.code);
  }
  var VodBufferController = class {
    constructor({
      video,
      panel,
      runtimeObject = globalThis,
      logger: logger2 = createLogger(),
      refreshCore,
      getVideo = () => video,
      onGeneration = () => {
      },
      diagnostics,
      config = VOD_CONFIG
    }) {
      if (typeof refreshCore !== "function") {
        fail("VOD_CORE_REFRESH_INVALID", "视频增强缺少播放器内核刷新函数");
      }
      this.video = video;
      this.getVideo = getVideo;
      this.onGeneration = onGeneration;
      this.diagnostics = diagnostics;
      this.panel = panel;
      this.runtimeObject = runtimeObject;
      this.logger = logger2;
      this.refreshCore = refreshCore;
      this.config = config;
      this.currentCore = void 0;
      this.currentSource = "";
      this.generation = 0;
      this.generationResult = void 0;
      this.videoInstance = 0;
      this.sourceInstance = 0;
      this.coreInstance = 0;
      this.mediaRecorder = void 0;
      this.hintState = "WAITING";
      this.message = WAITING_MESSAGE;
      this.reconcileTimer;
      this.statusTimer;
      this.bufferSamplerTimer;
      this.bufferSamples = [];
      this.peakForwardSeconds = 0;
      this.started = false;
      this.destroyed = false;
    }
    start() {
      if (this.destroyed) {
        fail("VOD_DESTROYED", "视频增强已经销毁");
      }
      if (this.started) {
        fail("VOD_ALREADY_STARTED", "视频增强已经启动");
      }
      this.started = true;
      this.ensureMediaRecorder();
      this.reconcileTimer = this.runtimeObject.setInterval(() => {
        void this.reconcile();
      }, 500);
      this.statusTimer = this.runtimeObject.setInterval(() => {
        this.updateStatus();
      }, 500);
      this.updateStatus();
      void this.reconcile();
    }
    async reconcile() {
      if (this.destroyed || !this.started) {
        return;
      }
      const selectedVideo = this.getVideo();
      if (selectedVideo !== void 0 && selectedVideo !== this.video) {
        this.mediaRecorder?.destroy();
        this.mediaRecorder = void 0;
        this.video = selectedVideo;
        this.currentCore = void 0;
        this.currentSource = "";
        this.generationResult = void 0;
        this.videoInstance += 1;
        this.onGeneration(this.generationContext("video_replaced"));
        this.diagnostics?.log("video.replaced", { reason: "video_replaced" }, void 0, this.generationContext("video_replaced"));
        this.ensureMediaRecorder();
      }
      const source = currentVideoSource(this.video);
      if (source === "") {
        this.hintState = "WAITING";
        this.message = WAITING_MESSAGE;
        this.updateStatus();
        return;
      }
      try {
        const core = await this.refreshCore();
        if (this.destroyed || !this.started) {
          return;
        }
        if (core === void 0 || core === null) {
          fail("VOD_CORE_UNAVAILABLE", "播放器内核刷新没有返回当前内核");
        }
        if (selectedVideo !== this.video || selectedVideo !== this.getVideo()) {
          return;
        }
        const currentSource2 = currentVideoSource(this.video);
        if (currentSource2 === "" || currentSource2 !== core.snapshot.source) {
          this.hintState = "WAITING";
          this.message = WAITING_MESSAGE;
          this.updateStatus();
          return;
        }
        const generationChanged = core !== this.currentCore || currentSource2 !== this.currentSource;
        if (generationChanged) {
          const coreChanged = core !== this.currentCore;
          const sourceChanged = currentSource2 !== this.currentSource;
          this.currentCore = core;
          this.currentSource = currentSource2;
          if (this.videoInstance === 0) this.videoInstance = 1;
          if (this.sourceInstance === 0 || sourceChanged) this.sourceInstance += 1;
          if (this.coreInstance === 0 || coreChanged) this.coreInstance += 1;
          this.generation += 1;
          this.generationResult = void 0;
          this.hintState = "WAITING";
          this.message = "";
          this.onGeneration(this.generationContext(sourceChanged ? "source_replaced" : "core_replaced"));
          if (sourceChanged) {
            this.diagnostics?.log("video.source_replaced", {
              source: currentSource2,
              reason: "source_replaced"
            }, void 0, this.generationContext("source_replaced"));
          }
          if (coreChanged) {
            this.diagnostics?.log("video.core_replaced", {
              source: currentSource2,
              reason: "core_replaced"
            }, void 0, this.generationContext("core_replaced"));
          }
          this.applyHintForGeneration(core);
        } else if (this.hintState === "WAITING" && this.generationResult !== void 0) {
          this.hintState = this.generationResult.state;
          this.message = this.generationResult.message;
        }
      } catch (error) {
        if (this.destroyed || !this.started) {
          return;
        }
        if (isWaitingForBridge(error)) {
          this.hintState = "WAITING";
          this.message = WAITING_MESSAGE;
        } else {
          const normalized = toBufferScriptError(error, "VOD_RECONCILE_FAILED", "视频播放器内核刷新失败");
          this.logger.error("视频播放器内核刷新失败", normalized);
          this.hintState = "WAITING";
          this.message = `${normalized.code}: ${normalized.message}`;
        }
      }
      this.updateStatus();
    }
    applyHintForGeneration(core) {
      this.clearBufferSampler();
      try {
        if (core.supports("setStableBufferTime") !== true) {
          this.hintState = "UNSUPPORTED";
          this.message = `当前内核不支持 ${this.config.stableBufferSeconds} 秒原生缓存提示`;
          this.generationResult = { state: this.hintState, message: this.message };
          this.diagnostics?.log("video.buffer_hint.unsupported", {
            targetSeconds: this.config.stableBufferSeconds,
            reason: "capability_missing"
          }, void 0, this.generationContext("buffer_hint"));
          return;
        }
        this.diagnostics?.log("video.buffer_hint.attempt", {
          targetSeconds: this.config.stableBufferSeconds
        }, void 0, this.generationContext("buffer_hint"));
        core.setStableBufferTime(this.config.stableBufferSeconds);
        let actualSeconds = UNKNOWN_VALUE;
        try {
          const measured = this.readForwardBuffer();
          if (Number.isFinite(measured)) actualSeconds = measured;
        } catch (error) {
          this.diagnostics?.log("extension.observer_error", {
            reason: "buffer-hint-actual-read"
          }, error, this.generationContext("buffer_hint"));
        }
        this.hintState = "APPLIED";
        this.message = "";
        this.diagnostics?.log("video.buffer_hint.applied", {
          targetSeconds: this.config.stableBufferSeconds,
          actualSeconds
        }, void 0, this.generationContext("buffer_hint"));
        this.startBufferSampler();
      } catch (error) {
        if (error?.code === "BRIDGE_CORE_STALE") {
          this.currentCore = void 0;
          this.currentSource = "";
          this.hintState = "WAITING";
          this.message = WAITING_MESSAGE;
          return;
        }
        const normalized = toBufferScriptError(error, "VOD_STABLE_BUFFER_FAILED", "原生缓存提示调用失败");
        this.logger.error("原生缓存提示调用失败", normalized);
        this.hintState = "FAILED";
        this.message = `${normalized.code}: ${normalized.message}`;
        this.diagnostics?.log("video.buffer_hint.failed", {
          targetSeconds: this.config.stableBufferSeconds,
          reason: normalized.code
        }, normalized, this.generationContext("buffer_hint"));
      }
      this.generationResult = { state: this.hintState, message: this.message };
    }
    readForwardBuffer() {
      return readNativeForwardBuffer(this.video);
    }
    clearBufferSampler() {
      if (this.bufferSamplerTimer !== void 0) {
        this.runtimeObject.clearInterval(this.bufferSamplerTimer);
        this.bufferSamplerTimer = void 0;
      }
      this.bufferSamples = [];
    }
    startBufferSampler() {
      this.clearBufferSampler();
      const intervalMs = 1e3;
      const maxSamples = 30;
      let elapsed = 0;
      this.bufferSamplerTimer = this.runtimeObject.setInterval(() => {
        if (this.destroyed || !this.started) {
          this.clearBufferSampler();
          return;
        }
        elapsed += intervalMs;
        let forward;
        try {
          forward = this.readForwardBuffer();
        } catch {
          forward = UNKNOWN_VALUE;
        }
        this.bufferSamples.push(Number.isFinite(forward) ? Math.round(forward * 1e3) / 1e3 : UNKNOWN_VALUE);
        if (this.bufferSamples.length >= maxSamples) {
          const samples = this.bufferSamples;
          const finiteSamples = samples.filter((v) => typeof v === "number" && Number.isFinite(v));
          const peakSeconds = finiteSamples.length > 0 ? Math.max(...finiteSamples) : UNKNOWN_VALUE;
          this.clearBufferSampler();
          this.diagnostics?.log("video.buffer_observed", {
            targetSeconds: this.config.stableBufferSeconds,
            sampledSeconds: maxSamples,
            peakSeconds,
            samples
          }, void 0, this.generationContext("buffer_observed"));
        }
      }, intervalMs);
    }
    generationContext(reason) {
      return {
        videoInstance: this.videoInstance || void 0,
        sourceInstance: this.sourceInstance || void 0,
        coreInstance: this.coreInstance || void 0,
        source: this.currentSource,
        reason
      };
    }
    ensureMediaRecorder() {
      if (this.diagnostics === void 0 || this.video === void 0 || this.mediaRecorder !== void 0) return;
      if (this.videoInstance === 0) this.videoInstance = 1;
      this.diagnostics.markVideoAvailable();
      this.diagnostics.log("video.attached", {
        source: currentVideoSource(this.video),
        reason: "video_bound"
      }, void 0, this.generationContext("video_attached"));
      this.mediaRecorder = new MediaEventRecorder({
        video: this.video,
        logger: this.diagnostics,
        runtimeObject: this.runtimeObject,
        context: () => this.generationContext("media")
      });
      this.mediaRecorder.start();
    }
    updateStatus() {
      if (this.destroyed || !this.started) {
        return;
      }
      let inventory = "未提供";
      let effective = "未提供";
      if (this.video !== void 0) {
        const forward = this.readForwardBuffer();
        inventory = `${forward.toFixed(1)} 秒`;
        if (Number.isFinite(forward) && forward > this.peakForwardSeconds) this.peakForwardSeconds = forward;
        if (this.hintState === "APPLIED") {
          effective = `已应用(目标${this.config.stableBufferSeconds}s, 实测峰值${this.peakForwardSeconds.toFixed(0)}s)`;
        } else if (this.hintState === "UNSUPPORTED") {
          effective = "不支持(setStableBufferTime 不可用)";
        } else if (this.hintState === "FAILED") {
          effective = "失败";
        } else {
          effective = "等待生效";
        }
      }
      this.panel.setModel({
        mode: "视频",
        state: this.hintState,
        buffered: inventory,
        target: `${this.config.stableBufferSeconds} 秒`,
        effective,
        error: this.message
      });
    }
    refreshStatus() {
      this.updateStatus();
    }
    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.started = false;
      this.clearBufferSampler();
      this.diagnostics?.log("video.destroyed", { reason: "controller_destroyed" }, void 0, this.generationContext("destroyed"));
      if (this.reconcileTimer !== void 0) {
        this.runtimeObject.clearInterval(this.reconcileTimer);
        this.reconcileTimer = void 0;
      }
      if (this.statusTimer !== void 0) {
        this.runtimeObject.clearInterval(this.statusTimer);
        this.statusTimer = void 0;
      }
      this.mediaRecorder?.destroy();
      this.mediaRecorder = void 0;
    }
  };

  // src/ui/panel.js
  var STATUS_MESSAGE_VERSION = 2;
  var MODE_LABELS = Object.freeze({ video: "视频" });
  var VIDEO_FIELDS = Object.freeze([
    "mode",
    "state",
    "buffered",
    "target",
    "effective",
    "error"
  ]);
  var VIDEO_STATE_LABELS = Object.freeze({
    WAITING: "等待",
    APPLIED: "已应用",
    UNSUPPORTED: "不支持",
    FAILED: "失败"
  });
  var currentSurface;
  function displayValue(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  function fieldsForMode(mode) {
    if (mode === "video") return VIDEO_FIELDS;
    fail("UI_MODE_INVALID", `状态 surface 模式未允许: ${mode}`);
  }
  function createSurfaceId() {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      fail("UI_SURFACE_ID_UNAVAILABLE", "当前环境不能生成唯一状态 surface id");
    }
    return `surface-${globalThis.crypto.randomUUID()}`;
  }
  var StatusPanel = class {
    constructor(_documentObject, mode) {
      fieldsForMode(mode);
      this.surfaceId = createSurfaceId();
      this.mode = mode;
      this.model = Object.fromEntries(fieldsForMode(mode).map((field) => [field, "未提供"]));
      this.destroyed = false;
      this.freshnessCheck = () => true;
      this.snapshotRefresh = () => {
      };
      currentSurface = this;
    }
    setModel(model) {
      if (this.destroyed) fail("UI_SURFACE_DESTROYED", "状态 surface 已销毁");
      for (const field of fieldsForMode(this.mode)) {
        if (Object.prototype.hasOwnProperty.call(model, field)) this.model[field] = displayValue(model[field]);
      }
    }
    setMessage(message) {
      this.setModel({ error: message });
    }
    setFreshnessCheck(callback) {
      if (this.destroyed) fail("UI_SURFACE_DESTROYED", "状态 surface 已销毁");
      if (typeof callback !== "function") fail("UI_SURFACE_FRESHNESS_INVALID", "状态 surface 缺少新鲜度检查");
      this.freshnessCheck = callback;
    }
    setSnapshotRefresh(callback) {
      if (this.destroyed) fail("UI_SURFACE_DESTROYED", "状态 surface 已销毁");
      if (typeof callback !== "function") fail("UI_SNAPSHOT_REFRESH_INVALID", "状态 surface 缺少刷新回调");
      this.snapshotRefresh = callback;
    }
    assertFresh() {
      if (this.freshnessCheck() !== true) fail("UI_SURFACE_STALE", "状态 surface 已不属于当前页面");
    }
    getSnapshot() {
      if (this.destroyed) fail("UI_SURFACE_DESTROYED", "状态 surface 已销毁");
      this.assertFresh();
      this.snapshotRefresh();
      this.assertFresh();
      const model = Object.fromEntries(fieldsForMode(this.mode).map((field) => [
        field,
        field === "state" && this.mode === "video" ? VIDEO_STATE_LABELS[this.model[field]] || displayValue(this.model[field]) : displayValue(this.model[field])
      ]));
      return {
        version: STATUS_MESSAGE_VERSION,
        surfaceId: this.surfaceId,
        ...model,
        mode: MODE_LABELS[this.mode]
      };
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (currentSurface === this) currentSurface = void 0;
    }
  };
  function createStatusPanel(documentObject, mode) {
    return new StatusPanel(documentObject, mode);
  }
  function getCurrentStatusSurface() {
    return currentSurface;
  }
  function createUnavailableStatusSnapshot(routeMode) {
    const mode = routeMode === "video" || routeMode === "vod" ? "video" : void 0;
    const fields = mode === void 0 ? ["mode"] : fieldsForMode(mode);
    return {
      version: STATUS_MESSAGE_VERSION,
      surfaceId: "surface-unavailable",
      ...Object.fromEntries(fields.map((field) => [field, "未提供"])),
      ...mode === void 0 ? {} : { mode: MODE_LABELS[mode] }
    };
  }

  // src/extension/bridge-client.js
  var CORE_SNAPSHOT_FIELDS = Object.freeze([
    "coreId",
    "source",
    "capabilities"
  ]);
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function isSerializable(value, depth = 0) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return true;
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    if (depth >= 4 || Array.isArray(value) && value.length > 256 || !isObject(value) && !Array.isArray(value)) {
      return false;
    }
    const values = Array.isArray(value) ? value : Object.values(value);
    return values.length <= (Array.isArray(value) ? 256 : 64) && values.every((item) => isSerializable(item, depth + 1));
  }
  function validateSerializedError(value) {
    const seen = /* @__PURE__ */ new WeakSet();
    let current = value;
    for (; ; ) {
      if (!isObject(current) || seen.has(current)) {
        fail("BRIDGE_RESPONSE_INVALID", "桥接错误对象格式无效");
      }
      seen.add(current);
      const allowedFields = /* @__PURE__ */ new Set(["name", "code", "message", "stack", "cause"]);
      if (Object.keys(current).some((field) => !allowedFields.has(field))) {
        fail("BRIDGE_RESPONSE_INVALID", "桥接错误对象包含未允许字段");
      }
      for (const field of ["name", "code", "message", "stack"]) {
        if (Object.prototype.hasOwnProperty.call(current, field) && typeof current[field] !== "string") {
          fail("BRIDGE_RESPONSE_INVALID", `桥接错误字段 ${field} 无效`);
        }
      }
      if (!Object.prototype.hasOwnProperty.call(current, "cause") || typeof current.cause === "string") return;
      current = current.cause;
    }
  }
  function logInvalidBridgePayload(kind, error) {
    console.warn(`[BilibiliBuffer] 忽略无效桥接${kind}`, serializeError(error));
  }
  function validateResponse(response) {
    if (!isObject(response) || typeof response.operation !== "string" || typeof response.ok !== "boolean") {
      fail("BRIDGE_RESPONSE_INVALID", "桥接响应格式无效");
    }
    const allowedFields = /* @__PURE__ */ new Set(["version", "id", "operation", "ok", "value", "error"]);
    if (Object.keys(response).some((field) => !allowedFields.has(field))) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接响应包含未允许字段");
    }
    if (!Number.isInteger(response.id) || response.id <= 0 || response.version !== BRIDGE_VERSION) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接响应身份字段无效");
    }
    assertOperation(response.operation);
    if (Object.prototype.hasOwnProperty.call(response, "value") && !isSerializable(response.value)) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接响应包含不可序列化值");
    }
    if (!response.ok && (!isObject(response.error) || typeof response.error.code !== "string" || typeof response.error.message !== "string")) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接失败响应缺少错误代码或消息");
    }
    if (response.ok && Object.prototype.hasOwnProperty.call(response, "error")) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接成功响应不得包含错误");
    }
    if (!response.ok && Object.prototype.hasOwnProperty.call(response, "value")) {
      fail("BRIDGE_RESPONSE_INVALID", "桥接失败响应不得包含值");
    }
    if (Object.prototype.hasOwnProperty.call(response, "error")) validateSerializedError(response.error);
    return response;
  }
  function validateCoreSnapshot(snapshot) {
    if (!isObject(snapshot) || !Number.isInteger(snapshot.coreId) || snapshot.coreId <= 0 || typeof snapshot.source !== "string") {
      fail("BRIDGE_SNAPSHOT_INVALID", "桥接内核快照缺少有效身份");
    }
    const coreCapabilities = snapshot.capabilities?.core;
    if (!isObject(snapshot.capabilities) || !isObject(coreCapabilities)) {
      fail("BRIDGE_SNAPSHOT_INVALID", "桥接内核快照缺少真实能力标记");
    }
    if (Object.keys(snapshot).some((field) => !CORE_SNAPSHOT_FIELDS.includes(field)) || Object.keys(snapshot.capabilities).some((field) => field !== "core") || Object.keys(coreCapabilities).some((field) => field !== "setStableBufferTime")) {
      fail("BRIDGE_SNAPSHOT_INVALID", "桥接内核快照包含未允许字段");
    }
    for (const field of ["setStableBufferTime"]) {
      if (typeof coreCapabilities[field] !== "boolean") {
        fail("BRIDGE_SNAPSHOT_INVALID", `桥接内核快照缺少能力标记: ${field}`);
      }
    }
    for (const [field, value] of Object.entries(snapshot)) {
      if (!CORE_SNAPSHOT_FIELDS.includes(field) || !isSerializable(value)) {
        fail("BRIDGE_SNAPSHOT_INVALID", `桥接内核快照字段无效: ${field}`);
      }
    }
    return snapshot;
  }
  function responseError(response) {
    const error = new BufferScriptError(
      response.error?.code || "BRIDGE_CALL_FAILED",
      response.error?.message || "桥接调用失败",
      response.error?.cause
    );
    if (typeof response.error?.name === "string") error.name = response.error.name;
    if (typeof response.error?.stack === "string") error.stack = response.error.stack;
    return error;
  }
  function customEventClass(documentObject) {
    return documentObject.defaultView?.CustomEvent || globalThis.CustomEvent;
  }
  var BridgeClient = class {
    constructor(documentObject = document, runtimeObject = globalThis) {
      this.documentObject = documentObject;
      this.runtimeObject = runtimeObject;
      this.nextId = 1;
      this.pending = /* @__PURE__ */ new Map();
      this.diagnostics = void 0;
      this.destroyed = false;
      this.onResponse = (event) => this.resolveResponse(event.detail);
      documentObject.addEventListener(BRIDGE_RESPONSE_EVENT, this.onResponse);
    }
    nextRequestId() {
      const id = this.nextId;
      this.nextId += 1;
      return id;
    }
    createRequest(operation, args, mode) {
      if (this.destroyed) {
        fail("BRIDGE_CLIENT_DESTROYED", "桥接客户端已经销毁");
      }
      assertOperation(operation);
      return { version: BRIDGE_VERSION, id: this.nextRequestId(), operation, args, mode };
    }
    dispatch(request) {
      const CustomEventClass = customEventClass(this.documentObject);
      this.documentObject.dispatchEvent(
        new CustomEventClass(BRIDGE_REQUEST_EVENT, { detail: encodeMessage(request) })
      );
    }
    diagnostic(code, data, error) {
      try {
        this.diagnostics?.log(code, data, error);
      } catch (diagnosticError) {
        console.error("[BilibiliBuffer] bridge diagnostic failed", serializeError(diagnosticError));
      }
    }
    decodeResponse(serialized, expectedId, expectedOperation) {
      const response = validateResponse(decodeMessage(serialized));
      if (response.id !== expectedId || response.operation !== expectedOperation) {
        fail("BRIDGE_RESPONSE_INVALID", "桥接响应编号或操作无效");
      }
      if (!response.ok) {
        throw responseError(response);
      }
      return response.value;
    }
    callSync(operation, args = []) {
      const request = this.createRequest(operation, args, "sync");
      if (this.documentObject.documentElement === null) {
        const error = new BufferScriptError("BRIDGE_DOCUMENT_UNAVAILABLE", "桥接调用时页面 documentElement 不可用");
        this.diagnostic("bridge.error", { operation, direction: "content-to-main" }, error);
        throw error;
      }
      this.documentObject.documentElement.setAttribute(BRIDGE_RESPONSE_ATTRIBUTE, "");
      this.dispatch(request);
      const serialized = this.documentObject.documentElement.getAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
      this.documentObject.documentElement.removeAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
      if (serialized === null || serialized.length === 0) {
        const error = new BufferScriptError("BRIDGE_RESPONSE_MISSING", `桥接同步操作没有响应: ${operation}`);
        this.diagnostic("bridge.error", { operation, direction: "main-to-content" }, error);
        throw error;
      }
      try {
        const value = this.decodeResponse(serialized, request.id, request.operation);
        return value;
      } catch (error) {
        logInvalidBridgePayload("同步响应", error);
        this.diagnostic("bridge.error", { operation, direction: "main-to-content" }, error);
        throw error;
      }
    }
    callAsync(operation, args = []) {
      const request = this.createRequest(operation, args, "async");
      return new Promise((resolve, reject) => {
        const timer = this.runtimeObject.setTimeout(() => {
          this.pending.delete(request.id);
          const error = new BufferScriptError("BRIDGE_RESPONSE_TIMEOUT", `桥接操作超时: ${operation}`);
          this.diagnostic("bridge.error", { operation, direction: "main-to-content" }, error);
          reject(error);
        }, 15e3);
        this.pending.set(request.id, { resolve, reject, timer, operation });
        try {
          this.dispatch(request);
        } catch (error) {
          this.runtimeObject.clearTimeout(timer);
          this.pending.delete(request.id);
          const wrapped = new BufferScriptError("BRIDGE_DISPATCH_FAILED", "桥接请求派发失败", error);
          this.diagnostic("bridge.error", { operation, direction: "content-to-main" }, wrapped);
          reject(wrapped);
        }
      });
    }
    resolveResponse(serialized) {
      let response;
      try {
        response = validateResponse(decodeMessage(serialized));
      } catch (error) {
        logInvalidBridgePayload("异步响应", error);
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === void 0) {
        return;
      }
      if (response.operation !== pending.operation) {
        logInvalidBridgePayload("异步响应", new Error("桥接响应操作不匹配待处理请求"));
        return;
      }
      this.pending.delete(response.id);
      this.runtimeObject.clearTimeout(pending.timer);
      try {
        const value = this.decodeResponse(serialized, response.id, pending.operation);
        pending.resolve(value);
      } catch (error) {
        this.diagnostic("bridge.error", { operation: pending.operation, direction: "main-to-content" }, error);
        pending.reject(error);
      }
    }
    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.documentObject.removeEventListener(BRIDGE_RESPONSE_EVENT, this.onResponse);
      for (const pending of this.pending.values()) {
        this.runtimeObject.clearTimeout(pending.timer);
        pending.reject(new BufferScriptError("BRIDGE_CLIENT_DESTROYED", "桥接客户端已经销毁"));
      }
      this.pending.clear();
    }
  };
  var BridgeCore = class {
    constructor(client, snapshot) {
      validateCoreSnapshot(snapshot);
      this.client = client;
      this.coreId = snapshot.coreId;
      this.snapshot = snapshot;
      this.stale = false;
    }
    update(snapshot) {
      this.assertActive();
      validateCoreSnapshot(snapshot);
      if (snapshot.coreId !== this.coreId) {
        fail("BRIDGE_CORE_ID_CHANGED", "桥接内核身份不能原地改变");
      }
      if (snapshot.source !== this.snapshot.source) {
        fail("BRIDGE_CORE_SOURCE_CHANGED", "桥接内核媒体 source 不能原地改变");
      }
      this.snapshot = snapshot;
    }
    assertActive() {
      if (this.stale) {
        fail("BRIDGE_CORE_STALE", `桥接内核 ${this.coreId} 已过期`);
      }
    }
    supports(method) {
      this.assertActive();
      return this.snapshot.capabilities.core[method] === true;
    }
    markStale() {
      if (this.stale) {
        return;
      }
      this.stale = true;
    }
    callCoreSync(method, args = []) {
      this.assertActive();
      try {
        return this.client.callSync("callCoreSync", [this.coreId, method, args, this.snapshot.source]);
      } catch (error) {
        if (error?.code === "BRIDGE_CORE_STALE") {
          this.markStale();
        }
        throw error;
      }
    }
    setStableBufferTime(seconds) {
      if (!this.supports("setStableBufferTime")) {
        fail("VOD_STABLE_BUFFER_UNAVAILABLE", "视频内核没有稳定缓存设置能力");
      }
      return this.callCoreSync("setStableBufferTime", [seconds]);
    }
  };
  function createPageWindowAdapter(client, windowObject = window) {
    const state = { core: void 0 };
    let refreshPromise;
    const player = {
      __core() {
        if (state.core === void 0) {
          fail("VOD_CORE_UNAVAILABLE", "window.player.__core() 尚未可用");
        }
        return state.core;
      }
    };
    const pageWindow = {
      location: windowObject.location,
      performance: windowObject.performance,
      player
    };
    return {
      pageWindow,
      async refreshCore() {
        if (refreshPromise === void 0) {
          refreshPromise = client.callAsync("getCoreSnapshot", []).then((snapshot) => {
            validateCoreSnapshot(snapshot);
            if (state.core === void 0 || state.core.stale || state.core.coreId !== snapshot.coreId || state.core.snapshot.source !== snapshot.source) {
              state.core?.markStale();
              state.core = new BridgeCore(client, snapshot);
            } else {
              state.core.update(snapshot);
            }
            return state.core;
          }).finally(() => {
            refreshPromise = void 0;
          });
        }
        return refreshPromise;
      },
      get core() {
        return state.core;
      }
    };
  }

  // src/extension/readouts.js
  var OTHER_LIVE_MEDIA_SOURCES_FIELD = [
    "otherLive",
    String.fromCharCode(77, 101, 100, 105, 97),
    "Sources"
  ].join("");
  function forwardSeconds(currentTime, ranges) {
    if (!Number.isFinite(currentTime) || !Array.isArray(ranges)) return UNKNOWN_VALUE;
    return computeForwardInventory(currentTime, [ranges]);
  }
  function trackReadout(currentTime, sourceBuffer) {
    const ranges = Array.isArray(sourceBuffer.ranges) ? sourceBuffer.ranges : UNKNOWN_VALUE;
    return {
      track: sourceBuffer.track,
      attached: sourceBuffer.attached === true,
      forwardSeconds: forwardSeconds(currentTime, ranges),
      ranges,
      updating: sourceBuffer.updating,
      pendingSinceMs: sourceBuffer.pendingSinceMs,
      lastAppendAgoMs: sourceBuffer.lastAppendAgoMs,
      appendErrors: sourceBuffer.appendErrors,
      mediaSourceInstance: sourceBuffer.mediaSourceInstance,
      mediaSourceState: sourceBuffer.mediaSourceState
    };
  }
  function limiterTrack(tracks) {
    const attached = tracks.filter((track) => track.attached === true);
    if (attached.length <= 1 || attached.some((track) => !Number.isFinite(track.forwardSeconds))) {
      return UNKNOWN_VALUE;
    }
    const minimum = Math.min(...attached.map((track) => track.forwardSeconds));
    const limiting = attached.filter((track) => track.forwardSeconds === minimum);
    return limiting.length === 1 ? limiting[0].track : UNKNOWN_VALUE;
  }
  function attachedSourceState(tracks) {
    if (tracks.length === 0 || tracks.some((track) => !["closed", "open", "ended"].includes(track.mediaSourceState))) {
      return UNKNOWN_VALUE;
    }
    const states = new Set(tracks.map((track) => track.mediaSourceState));
    return states.size === 1 ? [...states][0] : UNKNOWN_VALUE;
  }
  function deriveMediaReadout(facts) {
    if (facts === UNKNOWN_VALUE) return UNKNOWN_VALUE;
    const sourceBufferRanges = Array.isArray(facts.sourceBufferRanges) ? facts.sourceBufferRanges : [];
    const tracks = sourceBufferRanges.map((sourceBuffer) => trackReadout(facts.currentTime, sourceBuffer));
    const mediaSourceInstances = new Set(
      tracks.map((track) => track.mediaSourceInstance).filter((instance) => Number.isInteger(instance) && instance > 0)
    );
    const attachedSourceInstances = new Set(
      tracks.filter((track) => track.attached === true).map((track) => track.mediaSourceInstance).filter((instance) => Number.isInteger(instance) && instance > 0)
    );
    const attachmentResolved = attachedSourceInstances.size === 1;
    const attachedTracks = attachmentResolved ? tracks.filter((track) => track.attached === true) : [];
    return {
      forwardSeconds: forwardSeconds(facts.currentTime, facts.bufferedRanges),
      limiterTrack: attachmentResolved ? limiterTrack(attachedTracks) : UNKNOWN_VALUE,
      tracks: attachedTracks.map(({ mediaSourceInstance: _ignoredInstance, mediaSourceState: _ignoredState, ...track }) => track),
      mediaSourceState: attachedSourceState(attachedTracks),
      [OTHER_LIVE_MEDIA_SOURCES_FIELD]: attachmentResolved ? mediaSourceInstances.size - attachedSourceInstances.size : UNKNOWN_VALUE,
      element: {
        readyState: facts.readyState,
        networkState: facts.networkState,
        currentTime: facts.currentTime,
        duration: facts.duration,
        playbackRate: facts.playbackRate,
        resolution: facts.resolution,
        videoQuality: facts.videoQuality,
        paused: facts.paused,
        ended: facts.ended
      }
    };
  }
  function estimateBankSeconds(inventory, duration) {
    if (inventory === UNKNOWN_VALUE || !Array.isArray(inventory.resources)) return {};
    return Object.fromEntries(inventory.resources.map((resource) => {
      const estimate = Number.isFinite(resource.storedBytes) && Number.isFinite(resource.totalSize) && resource.totalSize > 0 && Number.isFinite(duration) && duration > 0 ? resource.storedBytes / (resource.totalSize / duration) : UNKNOWN_VALUE;
      return [resource.pathname, estimate];
    }));
  }
  function buildReadouts({
    surfaceId,
    video,
    bankInventory,
    lastStall,
    diagnostics,
    now = Date.now()
  }) {
    let media = UNKNOWN_VALUE;
    if (video !== void 0) media = deriveMediaReadout(readMediaFacts(video, "readout"));
    const mediaDuration = media === UNKNOWN_VALUE ? UNKNOWN_VALUE : media.element.duration;
    const bank = bankInventory === void 0 ? UNKNOWN_VALUE : {
      ...bankInventory.data,
      ageMs: Math.max(0, now - bankInventory.receivedAtMs)
    };
    return {
      version: 2,
      surfaceId,
      media,
      lastStall: lastStall === void 0 ? UNKNOWN_VALUE : {
        agoMs: Math.max(0, now - lastStall.atMs),
        kind: lastStall.kind
      },
      bank,
      bankSecondsEstimated: estimateBankSeconds(bank, mediaDuration),
      diagnostics: {
        sessionId: diagnostics?.sessionId || UNKNOWN_VALUE,
        persistence: diagnostics?.persistence || UNKNOWN_VALUE
      }
    };
  }

  // src/bank/contract.js
  var BANK_ENABLED_ATTRIBUTE = "data-bilibili-buffer-bank-enabled";
  var BANK_MESSAGE_NAMESPACE = "bilibili-buffer:segment-bank-v1";
  var BANK_DIAGNOSTIC_MESSAGE_TYPE = "diagnostic";
  function isBankDiagnosticMessage(message) {
    return message !== null && typeof message === "object" && !Array.isArray(message) && message.namespace === BANK_MESSAGE_NAMESPACE && message.direction === "event" && message.type === BANK_DIAGNOSTIC_MESSAGE_TYPE && typeof message.code === "string";
  }
  function postBankControl(windowObject, enabled) {
    const root = windowObject?.document?.documentElement;
    if (root === void 0 || root === null || typeof root.setAttribute !== "function") return;
    root.setAttribute(BANK_ENABLED_ATTRIBUTE, enabled === true ? "true" : "false");
  }

  // src/bank/logic.js
  function isVideoLocation(locationObject) {
    return locationObject.hostname === "www.bilibili.com" && (locationObject.pathname.startsWith("/video/") || locationObject.pathname === "/list/watchlater" || locationObject.pathname.startsWith("/list/watchlater/"));
  }

  // src/extension/controller.js
  function isVideoPage(locationObject) {
    return isVideoLocation(locationObject);
  }
  var isVodPage = isVideoPage;
  function modeForLocation(locationObject) {
    if (isVideoPage(locationObject)) return "video";
    return void 0;
  }
  function collectSameOriginVideos(documentObject) {
    const videos = [...documentObject.querySelectorAll("video")];
    for (const iframe of documentObject.querySelectorAll("iframe")) {
      try {
        const iframeDocument = iframe.contentDocument;
        if (iframeDocument !== null) videos.push(...iframeDocument.querySelectorAll("video"));
      } catch {
      }
    }
    return videos;
  }
  function findLargestVideo(documentObject) {
    const videos = collectSameOriginVideos(documentObject).filter((video) => video.isConnected !== false);
    return videos.sort((left, right) => {
      const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
      const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
      return rightArea - leftArea;
    })[0];
  }
  function logger() {
    return {
      warn(...args) {
        console.warn("[BilibiliBuffer]", ...args);
      },
      error(...args) {
        console.error("[BilibiliBuffer]", ...args);
      }
    };
  }
  function installBankDiagnostics({
    windowObject = window,
    diagnostics,
    onInventory = () => {
    },
    now = Date.now
  } = {}) {
    let latestInventory;
    const listener = (event) => {
      if (event.source !== windowObject || !isBankDiagnosticMessage(event.data)) return;
      const data = event.data.data || {};
      diagnostics?.log(event.data.code, data);
      if (event.data.code === "bank.inventory") {
        const sanitized = sanitizeEventData(event.data.code, data);
        latestInventory = { data: sanitized, receivedAtMs: now() };
        onInventory(latestInventory);
      }
    };
    windowObject.addEventListener("message", listener);
    return {
      latestInventory() {
        return latestInventory;
      },
      destroy() {
        windowObject.removeEventListener("message", listener);
      }
    };
  }
  function setBootError(panel, error) {
    const normalized = toBufferScriptError(error, "BOOT_FAILED", "扩展控制器启动失败");
    panel.setModel({
      mode: "视频",
      state: "FAILED",
      error: `${normalized.code}: ${normalized.message}`,
      target: "120 秒"
    });
  }
  function readPreferences(storage) {
    return storage.get([EXTENSION_PREFERENCES.vodEnabled]);
  }
  function popupError(error) {
    return {
      name: typeof error?.name === "string" ? error.name : "Error",
      code: typeof error?.code === "string" ? error.code : "POPUP_REQUEST_FAILED",
      message: error?.message || String(error),
      ...typeof error?.stack === "string" ? { stack: error.stack } : {}
    };
  }
  function assertPopupMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      fail("POPUP_MESSAGE_INVALID", "popup 消息必须是对象");
    }
    if (message.version !== STATUS_MESSAGE_VERSION || !["status:get", "diagnostics:session-id:get", "readouts:get"].includes(message.type)) {
      fail("POPUP_MESSAGE_INVALID", "popup 消息版本或类型未允许");
    }
    if (Object.keys(message).some((field) => !["version", "type"].includes(field))) {
      fail("POPUP_MESSAGE_INVALID", "popup 消息包含未允许字段");
    }
    return message;
  }
  async function handlePopupMessage(message, getDiagnosticsSessionId, getReadouts) {
    assertPopupMessage(message);
    if (message.type === "diagnostics:session-id:get") {
      return {
        version: STATUS_MESSAGE_VERSION,
        ok: true,
        sessionId: getDiagnosticsSessionId()
      };
    }
    if (message.type === "readouts:get") return getReadouts();
    const surface = getCurrentStatusSurface();
    if (surface === void 0) return createUnavailableStatusSnapshot(modeForLocation(window.location));
    return surface.getSnapshot();
  }
  function installPopupMessageHandler(runtimeObject = chrome.runtime, getDiagnosticsSessionId = () => "未提供", getReadouts = () => {
    throw new Error("popup readouts provider is unavailable");
  }) {
    if (runtimeObject?.onMessage === void 0 || typeof runtimeObject.onMessage.addListener !== "function") {
      throw new Error("Chrome runtime message API 不可用");
    }
    runtimeObject.onMessage.addListener((message, _sender, sendResponse) => {
      void handlePopupMessage(message, getDiagnosticsSessionId, getReadouts).then((response) => sendResponse(response)).catch((error) => sendResponse({
        version: STATUS_MESSAGE_VERSION,
        ok: false,
        error: popupError(error)
      }));
      return true;
    });
  }
  var ExtensionCoordinator = class {
    constructor({
      documentObject = document,
      windowObject = window,
      storage = chrome.storage.local,
      runtimeObject = globalThis,
      bridgeClient = new BridgeClient(documentObject, runtimeObject),
      diagnostics,
      loggerObject = logger(),
      getBankInventory = () => void 0,
      now = Date.now
    } = {}) {
      this.documentObject = documentObject;
      this.windowObject = windowObject;
      this.storage = storage;
      this.runtimeObject = runtimeObject;
      this.bridgeClient = bridgeClient;
      this.diagnostics = diagnostics;
      this.bridgeClient.diagnostics = diagnostics;
      this.logger = loggerObject;
      this.getBankInventory = getBankInventory;
      this.now = now;
      this.preferences = void 0;
      this.active = void 0;
      this.routeKey = "";
      this.routeGeneration = 0;
      this.syncPromise = void 0;
      this.pendingRouteHref = "";
      this.routeAbort = void 0;
      this.routeTimer = void 0;
      this.destroyed = false;
      this.onShimAppend = (event) => {
        this.diagnostics?.log("media.append", JSON.parse(event.detail));
      };
      this.documentObject.addEventListener(SHIM_APPEND_EVENT, this.onShimAppend);
    }
    getReadouts() {
      const panel = this.active?.panel;
      const recorder = this.active?.controller?.mediaRecorder || this.active?.passiveObserver?.recorder;
      return buildReadouts({
        surfaceId: panel?.surfaceId || "surface-unavailable",
        video: findLargestVideo(this.documentObject),
        bankInventory: this.getBankInventory(),
        lastStall: recorder?.getLastStall(),
        diagnostics: this.diagnostics?.getStatus(),
        now: this.now()
      });
    }
    async start() {
      if (this.routeTimer !== void 0) throw new Error("扩展路由协调器已经启动");
      this.diagnostics?.log("extension.started", { action: "coordinator" });
      this.preferences = await readPreferences(this.storage);
      if (this.windowObject.location.hostname === "www.bilibili.com") {
        postBankControl(this.windowObject, this.preferences[EXTENSION_PREFERENCES.vodEnabled] !== false);
      }
      this.diagnostics?.log("preference.read", {
        name: EXTENSION_PREFERENCES.vodEnabled,
        enabled: this.preferences[EXTENSION_PREFERENCES.vodEnabled] !== false
      });
      const runtimeId = this.runtimeObject.chrome?.runtime?.id || this.runtimeObject.runtime?.id;
      if (this.documentObject.documentElement !== null && runtimeId !== void 0) {
        this.documentObject.documentElement.dataset.bilibiliBufferExtensionRuntimeId = runtimeId;
      }
      this.routeTimer = this.runtimeObject.setInterval(() => {
        void this.syncRoute().catch((error) => {
          this.logger.error("扩展路由同步失败", error);
          this.diagnostics?.log("extension.observer_error", { reason: "route-sync" }, error);
        });
      }, 250);
      await this.syncRoute();
    }
    enabledFor() {
      return this.preferences[EXTENSION_PREFERENCES.vodEnabled] !== false;
    }
    syncRoute() {
      if (this.syncPromise !== void 0) {
        if (this.pendingRouteHref !== this.windowObject.location.href) this.routeAbort?.abort();
        return this.syncPromise;
      }
      this.syncPromise = this.performSyncRoute().finally(() => {
        this.syncPromise = void 0;
      });
      return this.syncPromise;
    }
    async performSyncRoute() {
      if (this.destroyed) return;
      const href = this.windowObject.location.href;
      const mode = modeForLocation(this.windowObject.location);
      if (href === this.routeKey) return;
      const generation = this.routeGeneration + 1;
      this.routeGeneration = generation;
      this.routeAbort?.abort();
      const routeAbort = new AbortController();
      this.routeAbort = routeAbort;
      this.pendingRouteHref = href;
      const changedRoute = this.routeKey !== "";
      await this.teardownActive();
      if (changedRoute) {
        this.diagnostics?.startSession(routeIdentity(this.windowObject.location));
        this.diagnostics?.log("route.changed", { reason: "location_changed" });
      }
      if (generation !== this.routeGeneration || this.destroyed || routeAbort.signal.aborted) return;
      this.routeKey = href;
      if (mode === void 0) {
        this.diagnostics?.log("route.unsupported", { reason: "no_video_enhancement_route" });
        this.finishRoute(routeAbort);
        return;
      }
      if (!this.enabledFor()) {
        this.diagnostics?.log("preference.disabled", {
          name: EXTENSION_PREFERENCES.vodEnabled,
          enabled: false
        });
        this.active = {
          mode,
          href,
          video: findLargestVideo(this.documentObject),
          controller: void 0,
          controllerStarted: false,
          passiveObserver: void 0
        };
        try {
          this.startPassiveObserver();
        } catch (error) {
          this.active.passiveObserver?.destroy();
          this.active.passiveObserver = void 0;
          this.logger.error("被动媒体诊断启动失败", error);
          this.diagnostics?.log("extension.boot_error", { action: `${mode}_passive` }, error);
        }
        this.finishRoute(routeAbort);
        return;
      }
      const panel = createStatusPanel(this.documentObject, mode);
      this.active = {
        mode,
        href,
        panel,
        video: findLargestVideo(this.documentObject),
        controller: void 0,
        controllerStarted: false,
        passiveObserver: void 0
      };
      panel.setFreshnessCheck(() => generation === this.routeGeneration && !this.destroyed && !routeAbort.signal.aborted && this.active?.panel === panel && this.routeKey === href && this.windowObject.location.href === href && modeForLocation(this.windowObject.location) === mode);
      panel.setModel({
        mode: "视频",
        state: "WAITING",
        buffered: "未提供",
        target: "120 秒",
        error: "等待原生 video、媒体 source 和播放器内核"
      });
      this.diagnostics?.log("preference.changed", { name: EXTENSION_PREFERENCES.vodEnabled, enabled: true });
      const routeStillCurrent = () => generation === this.routeGeneration && !this.destroyed && !routeAbort.signal.aborted && href === this.windowObject.location.href && mode === modeForLocation(this.windowObject.location) && this.active?.panel === panel;
      try {
        const pageAdapter = createPageWindowAdapter(this.bridgeClient, this.windowObject);
        const controller = new VodBufferController({
          video: this.active.video,
          getVideo: () => findLargestVideo(this.documentObject),
          panel,
          runtimeObject: this.runtimeObject,
          logger: this.logger,
          diagnostics: this.diagnostics,
          refreshCore: () => pageAdapter.refreshCore()
        });
        this.active.controller = controller;
        panel.setSnapshotRefresh(() => controller.refreshStatus());
        controller.start();
        this.active.controllerStarted = true;
        if (!routeStillCurrent()) {
          await this.teardownActive();
        }
      } catch (error) {
        if (!routeStillCurrent()) return;
        const active = this.active;
        if (active?.controllerStarted !== true) {
          active?.controller?.destroy();
          if (this.active !== active || active === void 0) return;
          active.controller = void 0;
          panel.setSnapshotRefresh(() => {
          });
          try {
            this.startPassiveObserver();
          } catch (passiveError) {
            if (this.active === active) {
              active.passiveObserver?.destroy();
              active.passiveObserver = void 0;
            }
            this.logger.error("被动媒体诊断启动失败", passiveError);
            this.diagnostics?.log("extension.boot_error", { action: `${mode}_passive` }, passiveError);
          }
        }
        setBootError(panel, error);
        this.diagnostics?.log("extension.boot_error", { action: mode }, error);
      } finally {
        this.finishRoute(routeAbort);
      }
    }
    finishRoute(routeAbort) {
      if (this.routeAbort === routeAbort) {
        this.routeAbort = void 0;
        this.pendingRouteHref = "";
      }
    }
    startPassiveObserver() {
      if (this.active === void 0 || this.diagnostics === void 0 || this.active.passiveObserver !== void 0) return;
      const observer = new PassiveMediaObserver({
        documentObject: this.documentObject,
        windowObject: this.windowObject,
        runtimeObject: this.runtimeObject,
        diagnostics: this.diagnostics,
        getVideo: () => findLargestVideo(this.documentObject),
        initialVideo: this.active.video
      });
      this.active.passiveObserver = observer;
      observer.start();
    }
    async teardownActive() {
      if (this.active === void 0) return;
      const active = this.active;
      this.active = void 0;
      active.controller?.destroy();
      active.passiveObserver?.destroy();
      active.panel?.destroy();
    }
    async destroy() {
      if (this.destroyed) return;
      this.routeGeneration += 1;
      this.routeAbort?.abort();
      if (this.routeTimer !== void 0) this.runtimeObject.clearInterval(this.routeTimer);
      this.routeTimer = void 0;
      await this.teardownActive();
      this.diagnostics?.log("extension.destroyed", { action: "coordinator" });
      this.destroyed = true;
      this.documentObject.removeEventListener(SHIM_APPEND_EVENT, this.onShimAppend);
      this.diagnostics?.destroy();
      this.bridgeClient.destroy();
    }
  };
  if (typeof chrome !== "undefined" && typeof document !== "undefined" && typeof window !== "undefined") {
    const diagnostics = new DiagnosticsClient();
    const bankDiagnostics = window.location.hostname === "www.bilibili.com" ? installBankDiagnostics({ diagnostics }) : void 0;
    const coordinator = new ExtensionCoordinator({
      diagnostics,
      getBankInventory: () => bankDiagnostics?.latestInventory()
    });
    installPopupMessageHandler(
      chrome.runtime,
      () => diagnostics.getStatus().sessionId,
      () => coordinator.getReadouts()
    );
    void coordinator.start().catch((error) => {
      console.error("[BilibiliBuffer] 扩展启动失败", error);
      diagnostics.log("extension.boot_error", { action: "coordinator" }, error);
    });
  }
})();
//# sourceMappingURL=controller.js.map
