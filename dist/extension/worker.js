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

  // src/diagnostics/idb.js
  var DATABASE_NAME = "bilibili-development-logs";
  var DATABASE_VERSION = 1;
  var SESSION_STORE = "sessions";
  var EVENT_STORE = "events";
  var EVENT_INDEX = "sessionSequence";
  function openLogDatabase(indexedDbObject = globalThis.indexedDB) {
    if (indexedDbObject === void 0 || typeof indexedDbObject.open !== "function") {
      throw new Error("IndexedDB 不可用");
    }
    return new Promise((resolve, reject) => {
      const request = indexedDbObject.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error || new Error("打开日志数据库失败"));
      request.onupgradeneeded = () => {
        const database = request.result;
        const sessions = database.objectStoreNames.contains(SESSION_STORE) ? request.transaction.objectStore(SESSION_STORE) : database.createObjectStore(SESSION_STORE, { keyPath: "sessionId" });
        if (!database.objectStoreNames.contains(EVENT_STORE)) {
          const events = database.createObjectStore(EVENT_STORE, { keyPath: "eventId", autoIncrement: true });
          events.createIndex(EVENT_INDEX, ["sessionId", "sequence"], { unique: true });
        }
        if (!sessions) throw new Error("sessions store 创建失败");
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  // src/diagnostics/privacy.js
  var UNKNOWN_VALUE = "未提供";
  var RESOURCE_FIELDS = Object.freeze([...allowedDataFields("resource.observed")]);
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
  function sanitizeSerializedError(error, seen = /* @__PURE__ */ new WeakSet(), depth = 0) {
    if (typeof error === "string") return scrubErrorText(error);
    if (error === null || typeof error !== "object" || Array.isArray(error)) {
      return UNKNOWN_VALUE;
    }
    if (seen.has(error)) return "[Circular]";
    if (depth >= 8) return "[CauseDepthLimit]";
    seen.add(error);
    const result = {};
    for (const field of ["name", "code", "message", "stack"]) {
      if (typeof error[field] === "string") result[field] = scrubErrorText(error[field]);
    }
    if (Object.prototype.hasOwnProperty.call(error, "cause")) {
      result.cause = sanitizeSerializedError(error.cause, seen, depth + 1);
    }
    return result;
  }

  // src/diagnostics/session.js
  function requireString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`session ${field} 无效`);
    }
    return value;
  }
  function optionalString(value, field) {
    if (value === void 0) return void 0;
    return requireString(value, field);
  }
  function sessionWithTabId(identity, tabId) {
    if (Object.prototype.hasOwnProperty.call(identity, "tabId")) {
      throw new Error("content page 不得提供 tabId");
    }
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error("sender.tab.id 无效");
    }
    return { ...identity, tabId };
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
  function validateSession(session, { requireTabId = true } = {}) {
    if (session === null || typeof session !== "object" || Array.isArray(session)) {
      throw new Error("session 必须是对象");
    }
    for (const field of Object.keys(session)) {
      if (!SESSION_FIELDS.includes(field)) {
        throw new Error(`session 字段未允许: ${field}`);
      }
    }
    for (const field of ["sessionId", "startedAt", "extensionVersion", "buildId", "routeKind", "origin", "pathname"]) {
      requireString(session[field], field);
    }
    if (session.schemaVersion !== 1) throw new Error("session schemaVersion 不支持");
    if (new URL(session.origin).origin !== session.origin) throw new Error("session origin 必须是干净 origin");
    if (scrubPathname(session.pathname) !== session.pathname) throw new Error("session pathname 必须没有 query/hash");
    if (requireTabId && (!Number.isInteger(session.tabId) || session.tabId <= 0)) {
      throw new Error("session 缺少可信 tabId");
    }
    if (!requireTabId && Object.prototype.hasOwnProperty.call(session, "tabId")) {
      throw new Error("页面 session 不得包含 tabId");
    }
    for (const field of ["roomId", "bvid", "part", "watchLaterItem"]) {
      optionalString(session[field], field);
      if (typeof session[field] === "string" && /[?#]/.test(session[field])) {
        throw new Error(`session ${field} 必须没有 query/hash`);
      }
    }
    return session;
  }

  // src/extension/bridge-contract.js
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
  function serializeError(error) {
    const seen = /* @__PURE__ */ new WeakSet();
    const serialize = (value, depth) => {
      if (value === void 0 || value === null) {
        return void 0;
      }
      if (typeof value !== "object" && typeof value !== "function") {
        return { name: typeof value, message: String(value) };
      }
      if (seen.has(value)) {
        return "[Circular]";
      }
      if (depth >= 8) {
        return "[CauseDepthLimit]";
      }
      seen.add(value);
      const result = {};
      const name = typeof value.name === "string" ? value.name : void 0;
      const code = typeof value.code === "string" ? value.code : void 0;
      const message = typeof value.message === "string" ? value.message : String(value);
      const stack = typeof value.stack === "string" ? value.stack : void 0;
      if (name !== void 0) result.name = name;
      if (code !== void 0) result.code = code;
      result.message = message;
      if (stack !== void 0) result.stack = stack;
      const cause = serialize(value.cause, depth + 1);
      if (cause !== void 0) result.cause = cause;
      return result;
    };
    const serialized = serialize(error, 0) || { message: "未知错误" };
    return {
      name: serialized.name || "Error",
      code: serialized.code || "BRIDGE_CALL_FAILED",
      message: serialized.message,
      ...serialized.stack === void 0 ? {} : { stack: serialized.stack },
      ...serialized.cause === void 0 ? {} : { cause: serialized.cause }
    };
  }

  // src/diagnostics/worker.js
  var BATCH_TYPE = "diagnostic:events";
  var READ_TYPES = /* @__PURE__ */ new Set([
    "logs:max-event-id",
    "logs:sessions-page",
    "logs:events-page"
  ]);
  function storageError(code, message, cause) {
    return Object.assign(new Error(message, { cause }), { code });
  }
  function stableValue(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(stableValue);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }
  function withoutEventId(event) {
    const copy = { ...event };
    if (Object.prototype.hasOwnProperty.call(copy, "eventId")) {
      throw storageError("EVENT_ID_FORBIDDEN", "页面不得自报 eventId");
    }
    return copy;
  }
  function comparableEvent(event) {
    const { eventId: _ignoredEventId, ...copy } = event;
    return copy;
  }
  function senderUrl(sender) {
    if (typeof sender?.url !== "string" || sender.url.length === 0) {
      throw storageError("SENDER_URL_MISSING", "日志 sender URL 不可用");
    }
    return new URL(sender.url);
  }
  function assertSenderMatchesSession(session, sender) {
    const pageUrl = senderUrl(sender);
    if (pageUrl.origin !== session.origin || pageUrl.pathname !== session.pathname) {
      throw storageError("SESSION_ROUTE_CONFLICT", "sender URL 与 session origin/pathname 不一致");
    }
  }
  function validateBatchMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw storageError("MESSAGE_INVALID", "日志消息必须是对象");
    }
    const keys = Object.keys(message).sort().join(",");
    if (keys !== "events,session,type,version") {
      throw storageError("MESSAGE_INVALID", "日志消息字段未允许");
    }
    if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || message.type !== BATCH_TYPE) {
      throw storageError("MESSAGE_INVALID", "日志消息版本或类型不支持");
    }
    if (!Array.isArray(message.events) || message.events.length === 0) {
      throw storageError("MESSAGE_INVALID", "日志批次不能为空");
    }
    return message;
  }
  async function appendBatch(message, sender, indexedDbObject) {
    validateBatchMessage(message);
    const pageSession = validateSession(message.session, { requireTabId: false });
    if (Object.prototype.hasOwnProperty.call(pageSession, "tabId")) {
      throw storageError("TAB_ID_FORBIDDEN", "content page 不得自报 tabId");
    }
    const session = sessionWithTabId(pageSession, sender?.tab?.id);
    assertSenderMatchesSession(session, sender);
    const normalizedEvents = message.events.map((event) => {
      const normalized = normalizeEventForStorage(withoutEventId(event));
      if (normalized.sessionId !== session.sessionId) {
        throw storageError("SESSION_EVENT_CONFLICT", "event sessionId 与批次不一致");
      }
      return normalized;
    });
    const database = await openLogDatabase(indexedDbObject);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([SESSION_STORE, EVENT_STORE], "readwrite");
      const sessions = transaction.objectStore(SESSION_STORE);
      const events = transaction.objectStore(EVENT_STORE);
      const sessionRequest = sessions.get(session.sessionId);
      const eventStatuses = [];
      let transactionFailure;
      let settled = false;
      const abortWith = (error) => {
        transactionFailure = error;
        if (!settled) transaction.abort();
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        database.close();
        reject(error);
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        database.close();
        resolve(value);
      };
      sessionRequest.onerror = () => {
        abortWith(storageError("IDB_SESSION_READ_FAILED", "读取日志 session 失败", sessionRequest.error));
      };
      sessionRequest.onsuccess = () => {
        try {
          const existingSession = sessionRequest.result;
          if (existingSession !== void 0 && stableStringify(existingSession) !== stableStringify(session)) {
            throw storageError("SESSION_CONFLICT", "相同 sessionId 的 session 身份不一致");
          }
          if (existingSession === void 0) {
            sessions.add(session);
          }
          const index = events.index(EVENT_INDEX);
          const maxRequest = index.openCursor(
            IDBKeyRange.bound([session.sessionId, 0], [session.sessionId, Number.MAX_SAFE_INTEGER]),
            "prev"
          );
          maxRequest.onerror = () => abortWith(storageError("IDB_EVENT_READ_FAILED", "读取日志 sequence 失败", maxRequest.error));
          maxRequest.onsuccess = () => {
            const existingMax = maxRequest.result?.value?.sequence || 0;
            let expectedNext = existingMax + 1;
            const processEvent = (eventIndex) => {
              if (eventIndex >= normalizedEvents.length) return;
              const event = normalizedEvents[eventIndex];
              const request = index.get([event.sessionId, event.sequence]);
              request.onerror = () => abortWith(storageError("IDB_EVENT_READ_FAILED", "读取日志 event 失败", request.error));
              request.onsuccess = () => {
                try {
                  const existing = request.result;
                  if (existing !== void 0) {
                    if (stableStringify(comparableEvent(existing)) !== stableStringify(event)) {
                      throw storageError("SEQUENCE_CONFLICT", `sequence ${event.sequence} 内容冲突`);
                    }
                    eventStatuses.push({ sequence: event.sequence, status: "DUPLICATE" });
                    processEvent(eventIndex + 1);
                    return;
                  }
                  if (event.sequence !== expectedNext) {
                    throw storageError("SEQUENCE_CONFLICT", `sequence ${event.sequence} 不连续，期望 ${expectedNext}`);
                  }
                  const addRequest = events.add(event);
                  addRequest.onerror = () => abortWith(storageError("IDB_EVENT_WRITE_FAILED", "写入日志 event 失败", addRequest.error));
                  addRequest.onsuccess = () => {
                    eventStatuses.push({ sequence: event.sequence, status: "PERSISTED" });
                    expectedNext += 1;
                    processEvent(eventIndex + 1);
                  };
                } catch (error) {
                  abortWith(error);
                }
              };
            };
            processEvent(0);
          };
        } catch (error) {
          abortWith(error);
        }
      };
      transaction.oncomplete = () => {
        const hasNew = eventStatuses.some((status) => status.status === "PERSISTED");
        finishResolve({
          status: hasNew ? "PERSISTED" : "DUPLICATE",
          statuses: eventStatuses,
          eventCount: normalizedEvents.length
        });
      };
      transaction.onabort = () => {
        finishReject(transactionFailure || storageError("IDB_TRANSACTION_FAILED", "日志事务未提交", transaction.error));
      };
      transaction.onerror = () => {
        transactionFailure = transaction.error || storageError("IDB_TRANSACTION_FAILED", "日志事务失败");
      };
    });
  }
  function validateReadMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw storageError("MESSAGE_INVALID", "日志读取消息必须是对象");
    }
    if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || !READ_TYPES.has(message.type)) {
      throw storageError("MESSAGE_INVALID", "日志读取消息版本或类型不支持");
    }
    const allowed = {
      "logs:max-event-id": ["type", "version", "sessionId"],
      "logs:sessions-page": ["type", "version", "limit", "afterSessionId", "sessionId"],
      "logs:events-page": ["type", "version", "limit", "afterEventId", "maxEventId", "sessionId"]
    }[message.type];
    if (Object.keys(message).some((field) => !allowed.includes(field))) {
      throw storageError("MESSAGE_INVALID", "日志读取消息包含未允许字段");
    }
    for (const field of ["sessionId", "afterSessionId"]) {
      if (message[field] !== void 0 && (typeof message[field] !== "string" || message[field].length === 0)) {
        throw storageError("MESSAGE_INVALID", `${field} 无效`);
      }
    }
    return message;
  }
  function positiveLimit(value) {
    if (!Number.isInteger(value) || value <= 0 || value > 250) {
      throw storageError("READ_LIMIT_INVALID", "日志分页 limit 必须是 1 到 250");
    }
    return value;
  }
  async function readMaxEventId(message, indexedDbObject) {
    const database = await openLogDatabase(indexedDbObject);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(EVENT_STORE, "readonly");
      const store = transaction.objectStore(EVENT_STORE);
      const request = store.openCursor(null, "prev");
      request.onerror = () => reject(request.error || new Error("读取最大 eventId 失败"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve({ maxEventId: 0 });
          return;
        }
        if (message.sessionId === void 0 || cursor.value.sessionId === message.sessionId) {
          resolve({ maxEventId: cursor.key });
          return;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error || new Error("读取最大 eventId 事务失败"));
    });
  }
  async function readSessionsPage(message, indexedDbObject) {
    const limit = positiveLimit(message.limit);
    const after = message.afterSessionId === void 0 ? void 0 : String(message.afterSessionId);
    const database = await openLogDatabase(indexedDbObject);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const store = transaction.objectStore(SESSION_STORE);
      const request = message.sessionId !== void 0 ? store.get(message.sessionId) : store.openCursor(after === void 0 ? null : IDBKeyRange.lowerBound(after, true));
      const sessions = [];
      request.onerror = () => reject(request.error || new Error("读取 session 分页失败"));
      request.onsuccess = () => {
        if (message.sessionId !== void 0) {
          if (request.result !== void 0) sessions.push(request.result);
          resolve({ sessions, hasMore: false });
          return;
        }
        const cursor = request.result;
        if (cursor === null || sessions.length >= limit) {
          resolve({ sessions, hasMore: cursor !== null });
          return;
        }
        sessions.push(cursor.value);
        cursor.continue();
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error || new Error("读取 session 分页事务失败"));
    });
  }
  async function readEventsPage(message, indexedDbObject) {
    const limit = positiveLimit(message.limit);
    if (!Number.isInteger(message.maxEventId) || message.maxEventId < 0) {
      throw storageError("MAX_EVENT_ID_INVALID", "maxEventId 无效");
    }
    if (!Number.isInteger(message.afterEventId) || message.afterEventId < 0) {
      throw storageError("AFTER_EVENT_ID_INVALID", "afterEventId 无效");
    }
    if (message.maxEventId <= message.afterEventId) {
      return { events: [], hasMore: false, nextAfterEventId: message.afterEventId };
    }
    const database = await openLogDatabase(indexedDbObject);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(EVENT_STORE, "readonly");
      const range = IDBKeyRange.bound(message.afterEventId + 1, message.maxEventId);
      const request = transaction.objectStore(EVENT_STORE).openCursor(range);
      const events = [];
      let lastScannedEventId = message.afterEventId;
      request.onerror = () => reject(request.error || new Error("读取 event 分页失败"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || events.length >= limit) {
          resolve({ events, hasMore: cursor !== null, nextAfterEventId: lastScannedEventId });
          return;
        }
        lastScannedEventId = cursor.key;
        if (message.sessionId === void 0 || cursor.value.sessionId === message.sessionId) {
          events.push(cursor.value);
        }
        if (events.length >= limit) {
          resolve({ events, hasMore: true, nextAfterEventId: lastScannedEventId });
          return;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error || new Error("读取 event 分页事务失败"));
    });
  }
  async function readLogs(message, indexedDbObject) {
    validateReadMessage(message);
    if (message.type === "logs:max-event-id") return readMaxEventId(message, indexedDbObject);
    if (message.type === "logs:sessions-page") return readSessionsPage(message, indexedDbObject);
    return readEventsPage(message, indexedDbObject);
  }
  async function handleMessage(message, sender, indexedDbObject = globalThis.indexedDB) {
    if (message?.type === BATCH_TYPE) {
      try {
        return await appendBatch(message, sender, indexedDbObject);
      } catch (error) {
        const status = ["SESSION_CONFLICT", "SEQUENCE_CONFLICT", "SESSION_EVENT_CONFLICT"].includes(error?.code) ? error.code : "DEGRADED";
        return { status, error: serializeError(error), eventCount: message.events?.length || 0 };
      }
    }
    if (READ_TYPES.has(message?.type)) {
      return readLogs(message, indexedDbObject);
    }
    throw storageError("MESSAGE_OPERATION_DENIED", "日志消息操作未允许");
  }
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void handleMessage(message, sender).then((response) => sendResponse({ version: DIAGNOSTIC_MESSAGE_VERSION, ok: true, ...response })).catch((error) => sendResponse({
        version: DIAGNOSTIC_MESSAGE_VERSION,
        ok: false,
        error: serializeError(error)
      }));
      return true;
    });
  }
})();
//# sourceMappingURL=worker.js.map
