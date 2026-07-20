(() => {
  // src/constants.js
  var VERSION = "1.0.0";
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
  var LIVE_CONFIG = Object.freeze({
    noDecodedFrameStallMilliseconds: 2e3,
    userSeekAuthorizationMilliseconds: 1e3,
    correctionToleranceSeconds: 2.5,
    statusRefreshMilliseconds: 500
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
    "live.stall.detected",
    "live.stall.recovered",
    "live.delay.observed",
    "live.delay.corrected",
    "live.source_replaced",
    "live.delay_protection.capability",
    "live.delay_protection.applied",
    "live.delay_protection.unsupported",
    "live.delay_protection.failed",
    "live.delay_protection.cancelled",
    "bridge.request",
    "bridge.response",
    "bridge.error",
    "extension.started",
    "extension.boot_error",
    "extension.observer_error",
    "extension.destroyed",
    "log.persist.result",
    "log.persist.degraded"
  ]);
  var EXACT_CODES = new Set(EVENT_CODES);
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
      "source"
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
      "protectedDelay",
      "targetTime",
      "currentTime",
      "estimatedDelay",
      "previousSource",
      "source",
      "videoInstance",
      "sourceInstance",
      "capability",
      "status"
    ]),
    bridge: Object.freeze(["operation", "direction", "status"]),
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
    if (code.startsWith("extension.")) return DATA_ALLOWLIST.extension;
    if (code.startsWith("log.persist.")) return DATA_ALLOWLIST.persist;
    throw new Error(`诊断事件代码没有字段 allowlist: ${code}`);
  }

  // src/diagnostics/privacy.js
  var UNKNOWN_VALUE = "未提供";
  var RESOURCE_FIELDS = Object.freeze([...allowedDataFields("resource.observed")]);
  var MEDIA_RESOURCE_INITIATOR_TYPES = /* @__PURE__ */ new Set(["audio", "video"]);
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
    if (["roomId", "bvid", "part", "watchLaterItem"].includes(field)) return scrubIdentifier(value);
    if (field === "source" || field === "previousSource" || field === "name") return scrubUrl(value);
    if (field === "bufferedRanges" || field === "seekableRanges") return safeRangeList(value);
    if (field === "resolution") return safeResolution(value);
    if (field === "transferSize" || field === "encodedBodySize" || field === "decodedBodySize" || field === "startTime" || field === "duration" || field === "responseStart" || field === "responseEnd") {
      return browserMetric(value);
    }
    if (field === "enabled") return value === true || value === false ? value : UNKNOWN_VALUE;
    if (field === "message") return scrubErrorText(value);
    return safeScalar(value);
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
        if (typeof source[field] === "string") result[field] = scrubErrorText(source[field]);
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
  function resourceTimingFields(entry) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("PerformanceResourceTiming 条目无效");
    }
    const initiatorType = entry.initiatorType;
    const fields = {};
    for (const field of RESOURCE_FIELDS) {
      if (field === "name" && !MEDIA_RESOURCE_INITIATOR_TYPES.has(initiatorType)) continue;
      fields[field] = field === "initiatorType" ? initiatorType : entry[field];
    }
    return fields;
  }

  // src/build-id.js
  var BUILT_BUILD_ID = true ? "src-681c2b0de2cfc8ce40af4197" : "source-build";
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
    roomId,
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
    for (const [field, value] of Object.entries({ roomId, bvid, part, watchLaterItem })) {
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
    "roomId",
    "bvid",
    "part",
    "watchLaterItem"
  ]);

  // src/extension/bridge-contract.js
  var BRIDGE_VERSION = 1;
  var BRIDGE_REQUEST_EVENT = "bilibili-buffer:bridge-request-v1";
  var BRIDGE_RESPONSE_EVENT = "bilibili-buffer:bridge-response-v1";
  var BRIDGE_RESPONSE_ATTRIBUTE = "data-bilibili-buffer-bridge-response-v1";
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callCoreSync",
    "getLiveCapabilitySnapshot",
    "disableLiveAutoCatchup"
  ]);
  var BRIDGE_LIVE_METHODS = Object.freeze([
    "setAutoSyncProgressCfg",
    "setAutoDiscardFrameCfg"
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
        const code = typeof value.code === "string" ? value.code : void 0;
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

  // src/diagnostics/client.js
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
  function routeIdentity(locationObject) {
    const pathname = locationObject.pathname || "/";
    const part = new URLSearchParams(locationObject.search || "").get("p") || void 0;
    if (locationObject.hostname === "live.bilibili.com") {
      return { routeKind: "live", roomId: pathname.split("/")[1] || void 0, part };
    }
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/video/")) {
      return { routeKind: "video", bvid: pathname.split("/")[2] || void 0, part };
    }
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/list/watchlater")) {
      return { routeKind: "video", watchLaterItem: pathname.split("/")[3] || void 0, part };
    }
    return { routeKind: "other", part };
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
      this.destroyed = false;
      this.tearingDown = false;
      this.persistence = "未提供";
      this.pendingPersistResult = void 0;
      this.noVideoTimer = void 0;
      this.resourceObserver = void 0;
      this.startSession(routeIdentity(locationObject));
      this.installResourceObserver();
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
        roomId: route.roomId,
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
        roomId: this.session.roomId,
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
    installResourceObserver() {
      const Observer = this.windowObject.PerformanceObserver;
      if (typeof Observer !== "function") {
        this.log("resource.observer_unavailable");
        return;
      }
      try {
        this.resourceObserver = new Observer((list) => {
          for (const entry of list.getEntries()) {
            try {
              this.log("resource.observed", resourceTimingFields(entry));
            } catch (error) {
              this.log("extension.observer_error", { reason: "resource" }, error);
            }
          }
        });
        this.resourceObserver.observe({ type: "resource", buffered: true });
      } catch (error) {
        this.log("extension.observer_error", { reason: "resource-observer" }, error);
      }
    }
    log(code, data = {}, error, context = {}) {
      if (this.destroyed || this.tearingDown) return;
      try {
        if (this.pendingPersistResult !== void 0 && !code.startsWith("log.persist.")) {
          const result = this.pendingPersistResult;
          this.pendingPersistResult = void 0;
          this.append(result.status === "DEGRADED" ? "log.persist.degraded" : "log.persist.result", result, void 0, {});
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
      this.outbox.push({ session: this.session, batch: this.pending.splice(0, this.pending.length), failed: false });
    }
    flushOutbox() {
      if (this.flushPromise !== void 0) return this.flushPromise;
      if (this.outbox.length === 0) return void 0;
      const item = this.outbox.shift();
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
            code: response?.error?.code || "LOG_PERSIST_FAILED"
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
        this.outbox.unshift(item);
        this.pendingPersistResult = {
          status: "DEGRADED",
          batchSize: batch.length,
          message: error.message || String(error)
        };
        try {
          this.logger.error?.("[BilibiliBuffer] diagnostic persistence degraded", serializeError(error));
        } catch (consoleError) {
          this.logger.warn?.("[BilibiliBuffer] diagnostic degraded mirror failed", serializeError(consoleError));
        }
        return { status: "DEGRADED", error: serializeError(error) };
      }).finally(() => {
        this.flushPromise = void 0;
        if (!this.destroyed && !this.tearingDown && this.outbox.length > 0 && this.outbox[0].failed !== true) {
          void this.flushOutbox();
        }
      });
      return this.flushPromise;
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
      if (this.noVideoTimer !== void 0) this.windowObject.clearTimeout(this.noVideoTimer);
      this.resourceObserver?.disconnect?.();
    }
    destroy() {
      if (this.destroyed) return;
      this.beginTeardown();
      this.destroyed = true;
    }
  };
  function createRouteIdentity(locationObject) {
    return routeIdentity(locationObject);
  }

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
  function readMediaFacts(video, eventType = "sample") {
    if (video === void 0 || video === null) return UNKNOWN_VALUE;
    const bufferedRanges = readRanges(video.buffered);
    const seekableRanges = readRanges(video.seekable);
    let estimatedDelay = UNKNOWN_VALUE;
    if (Array.isArray(seekableRanges) && seekableRanges.length > 0 && Number.isFinite(video.currentTime)) {
      const end = seekableRanges[seekableRanges.length - 1].end;
      estimatedDelay = Number.isFinite(end) ? Math.max(0, end - video.currentTime) : UNKNOWN_VALUE;
    }
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
      estimatedDelay,
      source: video.currentSrc || video.src || UNKNOWN_VALUE
    };
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
      }
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
      this.listeners = [];
      this.sampleTimer = void 0;
      this.frameCallbackActive = false;
      this.destroyed = false;
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
        facts = {
          eventType: name,
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
          estimatedDelay: UNKNOWN_VALUE,
          source: UNKNOWN_VALUE
        };
      }
      this.writeLog(`media.${name}`, facts, error);
    }
    writeLog(code, data, error) {
      try {
        this.logger.log(code, data, error, this.context());
      } catch (logError) {
        this.logger.error?.("[BilibiliBuffer] media diagnostic failed", logError);
      }
    }
    scheduleFrameCallback() {
      if (this.destroyed || this.frameCallbackActive || typeof this.video.requestVideoFrameCallback !== "function") return;
      this.frameCallbackActive = true;
      try {
        this.video.requestVideoFrameCallback((_now, metadata) => {
          this.frameCallbackActive = false;
          if (this.destroyed) return;
          try {
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
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const [name, listener] of this.listeners) this.video.removeEventListener(name, listener);
      this.listeners = [];
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

  // src/live/observer.js
  var UNKNOWN = "未提供";
  function currentSource2(video) {
    return video?.currentSrc || video?.src || "";
  }
  function nowMilliseconds(runtimeObject) {
    return typeof runtimeObject.performance?.now === "function" ? runtimeObject.performance.now() : Date.now();
  }
  function readTimeRanges(timeRanges) {
    if (timeRanges === void 0 || timeRanges === null) return void 0;
    const ranges = [];
    for (let index = 0; index < timeRanges.length; index += 1) {
      const start = timeRanges.start(index);
      const end = timeRanges.end(index);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error(`直播媒体 range ${index} 无效`);
      }
      ranges.push({ start, end });
    }
    return ranges;
  }
  function readSeekable(video) {
    return readTimeRanges(video?.seekable);
  }
  function continuousBuffer(video) {
    const ranges = readTimeRanges(video?.buffered);
    if (ranges === void 0 || !Number.isFinite(video.currentTime)) return UNKNOWN;
    const match = ranges.find((range) => range.start <= video.currentTime && video.currentTime <= range.end);
    return match === void 0 ? 0 : Math.max(0, match.end - video.currentTime);
  }
  function delayFromSeekable(video) {
    const ranges = readSeekable(video);
    if (ranges === void 0 || ranges.length === 0 || !Number.isFinite(video.currentTime)) return UNKNOWN;
    const end = ranges[ranges.length - 1].end;
    return Number.isFinite(end) ? Math.max(0, end - video.currentTime) : UNKNOWN;
  }
  function delayOrUnknown(video, diagnostics, reason, context) {
    try {
      return delayFromSeekable(video);
    } catch (error) {
      diagnostics?.log("extension.observer_error", { reason }, error, context);
      return UNKNOWN;
    }
  }
  function closestSeekablePosition(ranges, target, earliestWhenOutside) {
    if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(target)) return void 0;
    for (const range of ranges) {
      if (range.start <= target && target <= range.end) return target;
    }
    if (earliestWhenOutside) return ranges[0].start;
    if (target < ranges[0].start) return ranges[0].start;
    if (target > ranges[ranges.length - 1].end) return ranges[ranges.length - 1].end;
    for (let index = 1; index < ranges.length; index += 1) {
      const previousEnd = ranges[index - 1].end;
      const nextStart = ranges[index].start;
      if (previousEnd < target && target < nextStart) {
        return target - previousEnd <= nextStart - target ? previousEnd : nextStart;
      }
    }
    throw new Error("无法为直播目标位置选择 seekable 端点");
  }
  function seekablePositionForDelay(ranges, targetDelay) {
    if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(targetDelay)) return void 0;
    const seekableEnd = ranges[ranges.length - 1].end;
    const targetTime = seekableEnd - targetDelay;
    return closestSeekablePosition(ranges, targetTime, true);
  }
  var SEEK_KEYS = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
  var CONTROL_EXCLUSIONS = /volume|音量|quality|画质|speed|倍速|rate|播放速度|chat|comment|弹幕/i;
  var TIMELINE_MARKERS = /seek|timeline|progress|position|进度|时间轴/i;
  function eventPath(event) {
    if (typeof event?.composedPath === "function") return event.composedPath();
    const path = [];
    let current = event?.target;
    while (current !== void 0 && current !== null) {
      path.push(current);
      current = current.parentElement;
    }
    return path;
  }
  function elementText(element) {
    const attributes = ["id", "class", "aria-label", "title", "name", "data-seek", "data-timeline", "data-progress"];
    return attributes.map((attribute) => element?.getAttribute?.(attribute) || element?.[attribute] || "").join(" ");
  }
  function isTimelineControl(element) {
    if (element === void 0 || element === null || typeof element !== "object") return false;
    const text = elementText(element);
    const explicit = ["data-seek", "data-timeline", "data-progress"].some((attribute) => typeof element.getAttribute === "function" && element.getAttribute(attribute) !== null);
    if (CONTROL_EXCLUSIONS.test(text)) return false;
    if (explicit) return true;
    const tagName = String(element.tagName || "").toLowerCase();
    const inputType = String(element.type || element.getAttribute?.("type") || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || element.role || "").toLowerCase();
    if (tagName === "input" && inputType === "range") return TIMELINE_MARKERS.test(text);
    if (role === "slider") return TIMELINE_MARKERS.test(text);
    return TIMELINE_MARKERS.test(text) && !CONTROL_EXCLUSIONS.test(text);
  }
  function isUserSeekIntent(event, video, documentObject) {
    const path = eventPath(event);
    const timeline = path.some((element) => isTimelineControl(element));
    if (event?.type === "pointerdown") return timeline;
    if (event?.type !== "keydown" || !SEEK_KEYS.has(event.key)) return false;
    return timeline || path.includes(video) || documentObject.activeElement === video;
  }
  function selectVideo(documentObject) {
    const videos = [...documentObject.querySelectorAll("video")].filter((video) => video.isConnected !== false);
    return videos.sort((left, right) => {
      const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
      const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
      return rightArea - leftArea;
    })[0];
  }
  var LiveObserver = class {
    constructor({
      documentObject = document,
      windowObject = window,
      runtimeObject = windowObject,
      panel,
      logger: logger2,
      diagnostics,
      pageAdapter,
      initialVideo,
      config = LIVE_CONFIG
    }) {
      this.documentObject = documentObject;
      this.windowObject = windowObject;
      this.runtimeObject = runtimeObject;
      this.panel = panel;
      this.logger = logger2;
      this.diagnostics = diagnostics;
      this.pageAdapter = pageAdapter;
      this.config = config;
      this.video = initialVideo;
      this.videoInstance = 0;
      this.sourceInstance = 0;
      this.videoReplacements = 0;
      this.sourceReplacements = 0;
      this.sourceKey = "";
      this.videoParent = void 0;
      this.recorder = void 0;
      this.mutationObserver = void 0;
      this.statusTimer = void 0;
      this.started = false;
      this.destroyed = false;
      this.hasDecodedFrame = false;
      this.lastDecodedAtMilliseconds = void 0;
      this.recentEvent = UNKNOWN;
      this.recentError = UNKNOWN;
      this.activeStall = void 0;
      this.awaitingUserSeekFrame = false;
      this.userSeekAuthorization = void 0;
      this.correcting = false;
      this.replacementNeedsCorrection = false;
      this.frameCanvas = void 0;
      this.overlayCanvas = void 0;
      this.autoCatchupAttempted = false;
      this.liveCapabilities = void 0;
      this.liveCapabilitiesPromise = void 0;
      this.boundUserInput = (event) => this.noteUserInput(event);
      this.boundMutation = () => this.reconcileVideo();
    }
    start() {
      if (this.destroyed) throw new Error("直播观察器已经销毁");
      if (this.started) throw new Error("直播观察器已经启动");
      this.started = true;
      this.documentObject.addEventListener("pointerdown", this.boundUserInput, true);
      this.documentObject.addEventListener("keydown", this.boundUserInput, true);
      if (typeof this.windowObject.MutationObserver === "function") {
        this.mutationObserver = new this.windowObject.MutationObserver(this.boundMutation);
        this.mutationObserver.observe(this.documentObject, { childList: true, subtree: true });
      }
      this.statusTimer = this.runtimeObject.setInterval(() => this.sample(), this.config.statusRefreshMilliseconds);
      if (this.video !== void 0) {
        const initialVideo = this.video;
        this.video = void 0;
        this.bindVideo(selectVideo(this.documentObject) || initialVideo);
      } else {
        this.reconcileVideo();
      }
      this.updateStatus();
    }
    context() {
      return {
        videoInstance: this.videoInstance || void 0,
        sourceInstance: this.sourceInstance || void 0
      };
    }
    reconcileVideo() {
      if (this.destroyed || !this.started) return;
      const nextVideo = selectVideo(this.documentObject);
      if (nextVideo === void 0) {
        if (this.video !== void 0 && this.video.isConnected === false) {
          this.showOverlay();
        }
        this.updateStatus();
        return;
      }
      if (nextVideo !== this.video) {
        if (this.video !== void 0) {
          this.videoReplacements += 1;
          this.showOverlay();
        }
        this.bindVideo(nextVideo);
        return;
      }
      this.rebindSourceIfNeeded();
    }
    bindVideo(video) {
      const previousVideo = this.video;
      const previousSource = this.sourceKey;
      const previousStall = this.activeStall;
      this.hideOverlay();
      this.recorder?.destroy();
      this.video = video;
      this.videoParent = video.parentElement || this.videoParent;
      this.videoInstance += 1;
      this.hasDecodedFrame = false;
      this.lastDecodedAtMilliseconds = void 0;
      this.recentError = UNKNOWN;
      this.sourceKey = currentSource2(video);
      if (this.sourceKey !== "") this.sourceInstance += 1;
      if (previousVideo !== void 0 && previousSource !== this.sourceKey) {
        this.sourceReplacements += 1;
        this.diagnostics?.log("live.source_replaced", {
          previousSource,
          source: this.sourceKey,
          status: previousStall === void 0 ? "observed" : "protected"
        }, void 0, this.context());
        this.diagnostics?.log("video.source_replaced", {
          previousSource,
          source: this.sourceKey,
          reason: "video_replaced"
        }, void 0, this.context());
      }
      if (previousVideo !== void 0) {
        this.diagnostics?.log("video.replaced", {
          reason: "video_replaced"
        }, void 0, this.context());
      }
      if (previousStall !== void 0) {
        this.activeStall = {
          ...previousStall,
          video,
          videoInstance: this.videoInstance,
          sourceInstance: this.sourceInstance
        };
        this.replacementNeedsCorrection = true;
      }
      this.diagnostics?.markVideoAvailable();
      this.diagnostics?.log("video.attached", { source: this.sourceKey }, void 0, this.context());
      this.recorder = new MediaEventRecorder({
        video,
        logger: this.diagnostics,
        runtimeObject: this.runtimeObject,
        context: () => this.context(),
        onEvent: (name, currentVideo) => this.onMediaEvent(name, currentVideo),
        onFrame: (currentVideo) => this.onDecodedFrame(currentVideo)
      });
      this.recorder.start();
      if (previousStall !== void 0) this.showOverlay();
      this.applyReplacementCorrection();
      this.updateStatus();
    }
    rebindSourceIfNeeded() {
      const nextSource = currentSource2(this.video);
      if (nextSource === this.sourceKey) return;
      const previousSource = this.sourceKey;
      this.sourceKey = nextSource;
      this.sourceInstance += 1;
      if (previousSource !== "") this.sourceReplacements += 1;
      if (this.activeStall !== void 0) this.showOverlay();
      if (this.activeStall !== void 0) {
        this.activeStall = { ...this.activeStall, sourceInstance: this.sourceInstance };
      }
      this.replacementNeedsCorrection = this.activeStall !== void 0;
      this.diagnostics?.log("live.source_replaced", {
        previousSource,
        source: nextSource,
        status: this.activeStall === void 0 ? "observed" : "protected"
      }, void 0, this.context());
      this.diagnostics?.log("video.source_replaced", { previousSource, source: nextSource }, void 0, this.context());
      if (this.replacementNeedsCorrection) this.applyReplacementCorrection();
      this.updateStatus();
    }
    onMediaEvent(name, video) {
      if (video !== this.video || this.destroyed) return;
      this.recentEvent = name;
      if (name === "loadeddata" && !this.hasDecodedFrame) this.onDecodedFrame(video);
      if (name === "emptied" && this.activeStall !== void 0) this.showOverlay();
      if (name === "waiting" || name === "stalled") this.maybeArmStall(name);
      if (name === "seeking") this.handleSeeking(video);
      if (name === "loadedmetadata" || name === "canplay" || name === "loadeddata" || name === "playing") {
        this.applyReplacementCorrection();
      }
      if (name === "error") {
        const serialized = serializeError(video.error || new Error("原生 video error"));
        this.recentError = serialized.code === "BRIDGE_CALL_FAILED" ? serialized.message : `${serialized.code}: ${serialized.message}`;
      }
      this.updateStatus();
    }
    onDecodedFrame(video) {
      if (video !== this.video || this.destroyed) return;
      const wasAwaiting = this.awaitingUserSeekFrame;
      this.hasDecodedFrame = true;
      this.lastDecodedAtMilliseconds = nowMilliseconds(this.runtimeObject);
      this.captureFrame(video);
      this.hideOverlay();
      if (wasAwaiting) this.awaitingUserSeekFrame = false;
      const observedDelay = delayOrUnknown(video, this.diagnostics, "decoded-seekable-read", this.context());
      if (this.activeStall !== void 0 && Number.isFinite(observedDelay)) {
        this.activeStall.lastObservedDelay = observedDelay;
        if (this.activeStall.recoveredAt === void 0) {
          this.activeStall.protectedDelay = Math.max(this.activeStall.protectedDelay, observedDelay);
        } else if (observedDelay > this.activeStall.protectedDelay) {
          this.activeStall.protectedDelay = observedDelay;
        }
      }
      if (this.activeStall !== void 0 && this.activeStall.recoveredAt === void 0) {
        this.activeStall.recoveredAt = this.lastDecodedAtMilliseconds;
        this.diagnostics?.log("live.stall.recovered", {
          delayBeforeStall: this.activeStall.delayBeforeStall,
          stallDuration: Math.max(0, this.lastDecodedAtMilliseconds - this.activeStall.startedAt) / 1e3,
          protectedDelay: this.activeStall.protectedDelay
        }, void 0, this.context());
      }
      this.updateStatus();
    }
    noteUserInput(event) {
      if (this.destroyed || event?.isTrusted !== true) return;
      if (!isUserSeekIntent(event, this.video, this.documentObject)) {
        this.userSeekAuthorization = void 0;
        return;
      }
      if (this.video === void 0) return;
      this.userSeekAuthorization = {
        video: this.video,
        initialTime: Number.isFinite(this.video?.currentTime) ? this.video.currentTime : void 0,
        expiresAt: nowMilliseconds(this.runtimeObject) + this.config.userSeekAuthorizationMilliseconds
      };
    }
    consumeUserSeekAuthorization(video) {
      const authorization = this.userSeekAuthorization;
      if (authorization === void 0) return false;
      if (authorization.video !== video || nowMilliseconds(this.runtimeObject) > authorization.expiresAt) {
        this.userSeekAuthorization = void 0;
        return false;
      }
      if (!Number.isFinite(video.currentTime) || authorization.initialTime !== void 0 && video.currentTime === authorization.initialTime) return false;
      this.userSeekAuthorization = void 0;
      return true;
    }
    handleSeeking(video) {
      if (this.correcting || video !== this.video) return;
      if (this.consumeUserSeekAuthorization(video)) {
        this.cancelProtection("user_seek");
        this.awaitingUserSeekFrame = true;
        this.hasDecodedFrame = false;
        this.frameCanvas = void 0;
        return;
      }
      if (this.userSeekAuthorization !== void 0) return;
      if (this.activeStall === void 0 || this.activeStall.video !== video || this.activeStall.videoInstance !== this.videoInstance || this.activeStall.sourceInstance !== this.sourceInstance || this.awaitingUserSeekFrame || video.paused !== false) return;
      const protectedDelay = this.activeStall.protectedDelay;
      const requestedTime = video.currentTime;
      const requestedDelay = delayOrUnknown(video, this.diagnostics, "seeking-delay-read", this.context());
      if (!Number.isFinite(protectedDelay) || !Number.isFinite(requestedTime) || !Number.isFinite(requestedDelay) || requestedDelay >= protectedDelay) return;
      let ranges;
      try {
        ranges = readSeekable(video);
      } catch (error) {
        this.diagnostics?.log("extension.observer_error", { reason: "seekable-read" }, error, this.context());
        return;
      }
      const target = seekablePositionForDelay(ranges, protectedDelay);
      if (!Number.isFinite(target) || target >= requestedTime) return;
      this.correcting = true;
      try {
        video.currentTime = target;
        this.diagnostics?.log("live.delay.corrected", {
          reason: "automatic_forward_seek",
          targetTime: target,
          currentTime: requestedTime,
          protectedDelay
        }, void 0, this.context());
      } catch (error) {
        this.diagnostics?.log("live.delay_protection.failed", {
          reason: "event_correction",
          status: "failed"
        }, error, this.context());
      } finally {
        this.correcting = false;
      }
    }
    maybeArmStall(reason) {
      if (this.activeStall !== void 0 || this.awaitingUserSeekFrame || this.video === void 0) return;
      if (this.video.paused !== false || !this.hasDecodedFrame) return;
      const delayBeforeStall = delayOrUnknown(
        this.video,
        this.diagnostics,
        "stall-seekable-read",
        this.context()
      );
      const currentTime = this.video.currentTime;
      if (!Number.isFinite(delayBeforeStall) || !Number.isFinite(currentTime)) return;
      const startedAt = nowMilliseconds(this.runtimeObject);
      this.activeStall = {
        video: this.video,
        videoInstance: this.videoInstance,
        sourceInstance: this.sourceInstance,
        startedAt,
        delayBeforeStall,
        protectedDelay: delayBeforeStall,
        lastObservedDelay: delayBeforeStall
      };
      this.replacementNeedsCorrection = false;
      this.diagnostics?.log("live.stall.detected", {
        reason,
        delayBeforeStall,
        currentTime,
        protectedDelay: delayBeforeStall
      }, void 0, this.context());
      this.attemptDisableAutoCatchup();
    }
    checkForNoFrameStall() {
      if (this.video === void 0 || this.video.paused !== false || !this.hasDecodedFrame || this.lastDecodedAtMilliseconds === void 0) return;
      if (typeof this.video.requestVideoFrameCallback !== "function") return;
      const elapsed = nowMilliseconds(this.runtimeObject) - this.lastDecodedAtMilliseconds;
      if (elapsed >= this.config.noDecodedFrameStallMilliseconds) this.maybeArmStall("no_decoded_frame");
    }
    attemptDisableAutoCatchup() {
      if (this.autoCatchupAttempted) return;
      this.autoCatchupAttempted = true;
      const stall = this.activeStall;
      let capabilityPromise;
      try {
        capabilityPromise = this.liveCapabilities === void 0 ? this.pageAdapter?.refreshLiveCapabilities?.() : Promise.resolve(this.liveCapabilities);
      } catch (error) {
        this.diagnostics?.log("bridge.error", { operation: "getLiveCapabilitySnapshot", direction: "response" }, error, this.context());
        this.diagnostics?.log("live.delay_protection.failed", {
          capability: "disableAutoCatchup",
          status: "failed"
        }, error, this.context());
        return;
      }
      if (capabilityPromise === void 0) {
        this.diagnostics?.log("live.delay_protection.unsupported", {
          reason: "capability_not_available",
          status: "unsupported"
        }, void 0, this.context());
        return;
      }
      this.liveCapabilitiesPromise = Promise.resolve(capabilityPromise).then((capabilities) => {
        this.liveCapabilities = capabilities;
        const supported = capabilities.supportsDisableAutoCatchup();
        this.diagnostics?.log("live.delay_protection.capability", {
          capability: supported ? "disableAutoCatchup" : "none",
          status: supported ? "supported" : "unsupported"
        }, void 0, this.context());
        if (!supported || this.activeStall !== stall) {
          if (!supported) {
            this.diagnostics?.log("live.delay_protection.unsupported", {
              reason: "capability_missing",
              status: "unsupported"
            }, void 0, this.context());
          }
          return void 0;
        }
        return capabilities.disableAutoCatchup().then(() => {
          this.diagnostics?.log("live.delay_protection.applied", {
            capability: "disableAutoCatchup",
            status: "applied"
          }, void 0, this.context());
        });
      }).catch((error) => {
        this.diagnostics?.log("bridge.error", { operation: "getLiveCapabilitySnapshot", direction: "response" }, error, this.context());
        this.diagnostics?.log("live.delay_protection.failed", {
          capability: "disableAutoCatchup",
          status: "failed"
        }, error, this.context());
      });
    }
    applyReplacementCorrection() {
      if (!this.replacementNeedsCorrection || this.activeStall === void 0 || this.video === void 0 || this.sourceKey === "" || this.video.paused !== false || this.userSeekAuthorization !== void 0) return;
      let ranges;
      try {
        ranges = readSeekable(this.video);
      } catch (error) {
        this.diagnostics?.log("extension.observer_error", { reason: "replacement-seekable-read" }, error, this.context());
        return;
      }
      const target = seekablePositionForDelay(ranges, this.activeStall.protectedDelay);
      if (!Number.isFinite(target) || !Number.isFinite(this.video.currentTime)) return;
      const currentTime = this.video.currentTime;
      const currentDelay = delayOrUnknown(
        this.video,
        this.diagnostics,
        "replacement-seekable-read-current",
        this.context()
      );
      if (Number.isFinite(currentDelay) && currentDelay >= this.activeStall.protectedDelay) {
        this.activeStall.protectedDelay = currentDelay;
        this.replacementNeedsCorrection = false;
        return;
      }
      this.correcting = true;
      try {
        this.video.currentTime = target;
        if (!Number.isFinite(this.video.currentTime) || Math.abs(this.video.currentTime - target) > this.config.correctionToleranceSeconds) return;
        this.activeStall.protectedDelay = delayOrUnknown(
          this.video,
          this.diagnostics,
          "replacement-seekable-read-after-correction",
          this.context()
        );
        this.replacementNeedsCorrection = false;
        this.diagnostics?.log("live.delay.corrected", {
          reason: "source_replaced",
          targetTime: target,
          currentTime,
          protectedDelay: this.activeStall.protectedDelay
        }, void 0, this.context());
      } catch (error) {
        this.diagnostics?.log("live.delay_protection.failed", { reason: "source_replaced", status: "failed" }, error, this.context());
      } finally {
        this.correcting = false;
      }
    }
    captureFrame(video) {
      if (video.videoWidth <= 0 || video.videoHeight <= 0 || typeof this.documentObject.createElement !== "function") return;
      let canvas;
      try {
        canvas = this.documentObject.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (context === null) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (typeof context.getImageData === "function") {
          try {
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonBlack = false;
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 12 && pixels[index + 3] > 0) {
                nonBlack = true;
                break;
              }
            }
            if (!nonBlack) return;
          } catch (error) {
            if (error?.name !== "SecurityError") throw error;
          }
        }
        this.frameCanvas = canvas;
      } catch (error) {
        this.diagnostics?.log("extension.observer_error", { reason: "frame-capture" }, error, this.context());
      }
    }
    showOverlay() {
      if (this.activeStall === void 0 || this.frameCanvas === void 0 || this.overlayCanvas !== void 0) return;
      const parent = this.video?.parentElement || this.videoParent;
      if (parent === null || parent === void 0 || typeof this.documentObject.createElement !== "function") return;
      try {
        const canvas = this.documentObject.createElement("canvas");
        canvas.width = this.frameCanvas.width;
        canvas.height = this.frameCanvas.height;
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.pointerEvents = "none";
        canvas.setAttribute("aria-hidden", "true");
        const context = canvas.getContext("2d");
        context?.drawImage(this.frameCanvas, 0, 0, canvas.width, canvas.height);
        parent.append(canvas);
        this.overlayCanvas = canvas;
      } catch (error) {
        this.diagnostics?.log("extension.observer_error", { reason: "overlay" }, error, this.context());
      }
    }
    hideOverlay() {
      if (this.overlayCanvas === void 0) return;
      try {
        this.overlayCanvas.remove();
        this.overlayCanvas = void 0;
      } catch (error) {
        this.diagnostics?.log("extension.observer_error", { reason: "overlay-remove" }, error, this.context());
      }
    }
    sample() {
      if (this.destroyed) return;
      if (this.userSeekAuthorization !== void 0 && nowMilliseconds(this.runtimeObject) > this.userSeekAuthorization.expiresAt) {
        this.userSeekAuthorization = void 0;
      }
      this.reconcileVideo();
      this.checkForNoFrameStall();
      this.applyReplacementCorrection();
      if (this.activeStall !== void 0 && this.video !== void 0) {
        const estimatedDelay = delayOrUnknown(
          this.video,
          this.diagnostics,
          "sample-seekable-read",
          this.context()
        );
        if (Number.isFinite(estimatedDelay)) {
          this.activeStall.lastObservedDelay = estimatedDelay;
          if (estimatedDelay > this.activeStall.protectedDelay) this.activeStall.protectedDelay = estimatedDelay;
        }
        this.diagnostics?.log("live.delay.observed", {
          estimatedDelay,
          currentTime: this.video.currentTime,
          protectedDelay: this.activeStall.protectedDelay
        }, void 0, this.context());
      }
      this.updateStatus();
    }
    snapshot() {
      const video = this.video;
      let facts;
      if (video !== void 0) {
        try {
          facts = readMediaFacts(video);
        } catch (error) {
          this.diagnostics?.log("extension.observer_error", { reason: "snapshot-media-facts" }, error, this.context());
        }
      }
      const status = this.diagnostics?.getStatus() || { sessionId: UNKNOWN, persistence: UNKNOWN };
      const resolution = Number.isFinite(facts?.resolution?.width) && Number.isFinite(facts?.resolution?.height) ? `${facts.resolution.width}×${facts.resolution.height}` : UNKNOWN;
      return {
        mode: "直播",
        paused: typeof video?.paused === "boolean" ? video.paused ? "是" : "否" : UNKNOWN,
        recentFrame: this.lastDecodedAtMilliseconds === void 0 ? UNKNOWN : nowMilliseconds(this.runtimeObject) - this.lastDecodedAtMilliseconds <= 1e3 ? "是" : "否",
        buffered: video === void 0 ? UNKNOWN : (() => {
          try {
            return continuousBuffer(video);
          } catch (error) {
            this.diagnostics?.log("extension.observer_error", { reason: "snapshot-buffered" }, error, this.context());
            return UNKNOWN;
          }
        })(),
        delay: video === void 0 ? UNKNOWN : (() => {
          try {
            return delayFromSeekable(video);
          } catch (error) {
            this.diagnostics?.log("extension.observer_error", { reason: "snapshot-seekable" }, error, this.context());
            return UNKNOWN;
          }
        })(),
        resolution,
        quality: UNKNOWN,
        speed: Number.isFinite(video?.playbackRate) ? `${video.playbackRate}×` : UNKNOWN,
        videoReplacements: this.videoReplacements,
        sourceReplacements: this.sourceReplacements,
        recentEvent: this.recentEvent,
        error: this.recentError,
        sessionId: status.sessionId,
        persistence: status.persistence,
        videoInstance: this.videoInstance || UNKNOWN,
        sourceInstance: this.sourceInstance || UNKNOWN
      };
    }
    updateStatus() {
      if (this.destroyed || !this.started) return;
      const snapshot = this.snapshot();
      this.panel.setModel(snapshot);
    }
    refreshStatus() {
      this.updateStatus();
    }
    cancelProtection(reason) {
      if (this.activeStall === void 0) return;
      this.diagnostics?.log("live.delay_protection.cancelled", {
        reason,
        status: "cancelled",
        currentTime: this.video?.currentTime
      }, void 0, this.context());
      this.activeStall = void 0;
      this.replacementNeedsCorrection = false;
      this.hideOverlay();
    }
    destroy() {
      if (this.destroyed) return;
      this.diagnostics?.log("video.destroyed", { reason: "live_observer_destroyed" }, void 0, this.context());
      this.destroyed = true;
      this.mutationObserver?.disconnect();
      this.mutationObserver = void 0;
      this.documentObject.removeEventListener("pointerdown", this.boundUserInput, true);
      this.documentObject.removeEventListener("keydown", this.boundUserInput, true);
      this.recorder?.destroy();
      this.recorder = void 0;
      if (this.statusTimer !== void 0) this.runtimeObject.clearInterval(this.statusTimer);
      this.statusTimer = void 0;
      this.hideOverlay();
      this.frameCanvas = void 0;
      this.videoParent = void 0;
      this.activeStall = void 0;
      this.video = void 0;
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
        const currentSource3 = currentVideoSource(this.video);
        if (currentSource3 === "" || currentSource3 !== core.snapshot.source) {
          this.hintState = "WAITING";
          this.message = WAITING_MESSAGE;
          this.updateStatus();
          return;
        }
        const generationChanged = core !== this.currentCore || currentSource3 !== this.currentSource;
        if (generationChanged) {
          const coreChanged = core !== this.currentCore;
          const sourceChanged = currentSource3 !== this.currentSource;
          this.currentCore = core;
          this.currentSource = currentSource3;
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
              source: currentSource3,
              reason: "source_replaced"
            }, void 0, this.generationContext("source_replaced"));
          }
          if (coreChanged) {
            this.diagnostics?.log("video.core_replaced", {
              source: currentSource3,
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
        this.hintState = "APPLIED";
        this.message = "";
        this.diagnostics?.log("video.buffer_hint.applied", {
          targetSeconds: this.config.stableBufferSeconds,
          actualSeconds: this.config.stableBufferSeconds
        }, void 0, this.generationContext("buffer_hint"));
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
      if (this.video !== void 0) {
        inventory = `${this.readForwardBuffer().toFixed(1)} 秒`;
      }
      this.panel.setModel({
        mode: "视频",
        state: this.hintState,
        buffered: inventory,
        target: `${this.config.stableBufferSeconds} 秒`,
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
  var MODE_LABELS = Object.freeze({ live: "直播", video: "视频" });
  var VIDEO_FIELDS = Object.freeze([
    "mode",
    "state",
    "buffered",
    "target",
    "error"
  ]);
  var LIVE_FIELDS = Object.freeze([
    "mode",
    "paused",
    "recentFrame",
    "buffered",
    "delay",
    "resolution",
    "quality",
    "speed",
    "videoReplacements",
    "sourceReplacements",
    "recentEvent",
    "error",
    "sessionId",
    "persistence"
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
    if (mode === "live") return LIVE_FIELDS;
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
    const mode = routeMode === "live" ? "live" : routeMode === "video" || routeMode === "vod" ? "video" : void 0;
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
  function validateLiveCapabilitySnapshot(snapshot) {
    if (!isObject(snapshot) || !isObject(snapshot.live) || typeof snapshot.live.disableAutoCatchup !== "boolean") {
      fail("BRIDGE_LIVE_SNAPSHOT_INVALID", "桥接直播能力快照格式无效");
    }
    if (Object.keys(snapshot).some((field) => field !== "live") || Object.keys(snapshot.live).some((field) => field !== "disableAutoCatchup")) {
      fail("BRIDGE_LIVE_SNAPSHOT_INVALID", "桥接直播能力快照包含未允许字段");
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
      this.diagnostic("bridge.request", { operation, direction: "content-to-main" });
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
        this.diagnostic("bridge.response", { operation, direction: "main-to-content", status: "ok" });
        return value;
      } catch (error) {
        logInvalidBridgePayload("同步响应", error);
        this.diagnostic("bridge.error", { operation, direction: "main-to-content" }, error);
        throw error;
      }
    }
    callAsync(operation, args = []) {
      const request = this.createRequest(operation, args, "async");
      this.diagnostic("bridge.request", { operation, direction: "content-to-main" });
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
        this.diagnostic("bridge.response", {
          operation: pending.operation,
          direction: "main-to-content",
          status: "ok"
        });
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
  var LiveCapabilities = class {
    constructor(client, snapshot) {
      validateLiveCapabilitySnapshot(snapshot);
      this.client = client;
      this.snapshot = snapshot;
      this.used = false;
    }
    supportsDisableAutoCatchup() {
      return this.snapshot.live.disableAutoCatchup === true;
    }
    async disableAutoCatchup() {
      if (this.used) {
        fail("LIVE_AUTO_CATCHUP_ALREADY_ATTEMPTED", "关闭自动追赶能力只能尝试一次");
      }
      this.used = true;
      return this.client.callAsync("disableLiveAutoCatchup", []);
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
      async refreshLiveCapabilities() {
        const snapshot = await client.callAsync("getLiveCapabilitySnapshot", []);
        return new LiveCapabilities(client, snapshot);
      },
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

  // src/extension/controller.js
  function isLivePage(locationObject) {
    return locationObject.hostname === "live.bilibili.com";
  }
  function isVideoPage(locationObject) {
    return locationObject.hostname === "www.bilibili.com" && (locationObject.pathname.startsWith("/video/") || locationObject.pathname === "/list/watchlater" || locationObject.pathname.startsWith("/list/watchlater/"));
  }
  var isVodPage = isVideoPage;
  function modeForLocation(locationObject) {
    if (isLivePage(locationObject)) return "live";
    if (isVideoPage(locationObject)) return "video";
    return void 0;
  }
  function findLargestVideo(documentObject) {
    const videos = [...documentObject.querySelectorAll("video")].filter((video) => video.isConnected !== false);
    return videos.sort((left, right) => {
      const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
      const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
      return rightArea - leftArea;
    })[0];
  }
  function preferenceKeyForMode(mode) {
    return mode === "live" ? EXTENSION_PREFERENCES.liveEnabled : EXTENSION_PREFERENCES.vodEnabled;
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
  function setBootError(panel, error, mode) {
    const normalized = toBufferScriptError(error, "BOOT_FAILED", "扩展控制器启动失败");
    panel.setModel({
      mode: mode === "live" ? "直播" : "视频",
      state: "FAILED",
      error: `${normalized.code}: ${normalized.message}`,
      target: "120 秒"
    });
  }
  function readPreferences(storage) {
    return storage.get([EXTENSION_PREFERENCES.liveEnabled, EXTENSION_PREFERENCES.vodEnabled]);
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
    if (message.version !== STATUS_MESSAGE_VERSION || message.type !== "status:get") {
      fail("POPUP_MESSAGE_INVALID", "popup 消息版本或类型未允许");
    }
    if (Object.keys(message).some((field) => !["version", "type"].includes(field))) {
      fail("POPUP_MESSAGE_INVALID", "popup 消息包含未允许字段");
    }
    return message;
  }
  async function handlePopupMessage(message) {
    assertPopupMessage(message);
    const surface = getCurrentStatusSurface();
    if (surface === void 0) return createUnavailableStatusSnapshot(modeForLocation(window.location));
    return surface.getSnapshot();
  }
  function installPopupMessageHandler(runtimeObject = chrome.runtime) {
    if (runtimeObject?.onMessage === void 0 || typeof runtimeObject.onMessage.addListener !== "function") {
      throw new Error("Chrome runtime message API 不可用");
    }
    runtimeObject.onMessage.addListener((message, _sender, sendResponse) => {
      void handlePopupMessage(message).then((response) => sendResponse(response)).catch((error) => sendResponse({
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
      loggerObject = logger()
    } = {}) {
      this.documentObject = documentObject;
      this.windowObject = windowObject;
      this.storage = storage;
      this.runtimeObject = runtimeObject;
      this.bridgeClient = bridgeClient;
      this.diagnostics = diagnostics;
      this.bridgeClient.diagnostics = diagnostics;
      this.logger = loggerObject;
      this.preferences = void 0;
      this.active = void 0;
      this.routeKey = "";
      this.routeGeneration = 0;
      this.syncPromise = void 0;
      this.pendingRouteHref = "";
      this.routeAbort = void 0;
      this.routeTimer = void 0;
      this.destroyed = false;
    }
    async start() {
      if (this.routeTimer !== void 0) throw new Error("扩展路由协调器已经启动");
      this.diagnostics?.log("extension.started", { action: "coordinator" });
      this.preferences = await readPreferences(this.storage);
      this.diagnostics?.log("preference.read", {
        name: EXTENSION_PREFERENCES.liveEnabled,
        enabled: this.preferences[EXTENSION_PREFERENCES.liveEnabled] !== false
      });
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
    enabledFor(mode) {
      return this.preferences[preferenceKeyForMode(mode)] !== false;
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
        this.diagnostics?.startSession(createRouteIdentity(this.windowObject.location));
        this.diagnostics?.log("route.changed", { reason: "location_changed" });
      }
      if (generation !== this.routeGeneration || this.destroyed || routeAbort.signal.aborted) return;
      this.routeKey = href;
      if (mode === void 0) {
        this.diagnostics?.log("route.unsupported", { reason: "no_video_enhancement_route" });
        this.finishRoute(routeAbort);
        return;
      }
      if (!this.enabledFor(mode)) {
        this.diagnostics?.log("preference.disabled", {
          name: preferenceKeyForMode(mode),
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
        mode: mode === "live" ? "直播" : "视频",
        ...mode === "live" ? {
          paused: "未提供",
          recentFrame: "未提供",
          buffered: "未提供",
          delay: "未提供",
          sessionId: this.diagnostics?.getStatus?.().sessionId,
          persistence: this.diagnostics?.getStatus?.().persistence
        } : {
          state: "WAITING",
          buffered: "未提供",
          target: "120 秒",
          error: "等待原生 video、媒体 source 和播放器内核"
        }
      });
      this.diagnostics?.log("preference.changed", { name: preferenceKeyForMode(mode), enabled: true });
      const routeStillCurrent = () => generation === this.routeGeneration && !this.destroyed && !routeAbort.signal.aborted && href === this.windowObject.location.href && mode === modeForLocation(this.windowObject.location) && this.active?.panel === panel;
      try {
        const pageAdapter = createPageWindowAdapter(this.bridgeClient, this.windowObject);
        if (mode === "live") {
          const controller = new LiveObserver({
            windowObject: this.windowObject,
            documentObject: this.documentObject,
            runtimeObject: this.runtimeObject,
            initialVideo: this.active.video,
            panel,
            pageAdapter,
            diagnostics: this.diagnostics,
            logger: this.logger
          });
          this.active.controller = controller;
          panel.setSnapshotRefresh(() => controller.refreshStatus());
          controller.start();
          this.active.controllerStarted = true;
        } else {
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
        }
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
        setBootError(panel, error, mode);
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
      this.diagnostics?.destroy();
      this.bridgeClient.destroy();
    }
  };
  if (typeof chrome !== "undefined" && typeof document !== "undefined" && typeof window !== "undefined") {
    const diagnostics = new DiagnosticsClient();
    installPopupMessageHandler();
    const coordinator = new ExtensionCoordinator({ diagnostics });
    void coordinator.start().catch((error) => {
      console.error("[BilibiliBuffer] 扩展启动失败", error);
      diagnostics.log("extension.boot_error", { action: "coordinator" }, error);
    });
  }
})();
//# sourceMappingURL=controller.js.map
