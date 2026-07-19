(() => {
  // src/extension/bridge-contract.js
  var BRIDGE_VERSION = 1;
  var BRIDGE_REQUEST_EVENT = "bilibili-buffer:bridge-request-v1";
  var BRIDGE_RESPONSE_EVENT = "bilibili-buffer:bridge-response-v1";
  var BRIDGE_EVENT_EVENT = "bilibili-buffer:bridge-event-v1";
  var BRIDGE_RESPONSE_ATTRIBUTE = "data-bilibili-buffer-bridge-response-v1";
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callPlayer",
    "callCoreSync",
    "callCoreAsync",
    "subscribeCoreEvents",
    "unsubscribeCoreEvents"
  ]);
  var BRIDGE_PLAYER_METHODS = Object.freeze([
    "setAutoSyncProgressCfg",
    "setAutoDiscardFrameCfg",
    "pause",
    "requestQuality"
  ]);
  var BRIDGE_PLAYER_CAPABILITIES = Object.freeze([...BRIDGE_PLAYER_METHODS]);
  var BRIDGE_CORE_SYNC_METHODS = Object.freeze([
    "getQuality",
    "getCurrentQuality",
    "getCurrentQn",
    "getSupportedQualityList",
    "getQualityList",
    "getBufferedRanges",
    "getMediaInfo",
    "getCurrentMediaInfo",
    "getQualityInfo",
    "getStableBufferTime",
    "getStableBufferSeconds",
    "setStableBufferTime",
    "setScheduleWhilePaused"
  ]);
  var BRIDGE_CORE_ASYNC_METHODS = Object.freeze(["requestQuality"]);
  var BRIDGE_CORE_EVENTS = Object.freeze(["error"]);
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
    return {
      code: typeof error?.code === "string" ? error.code : "BRIDGE_CALL_FAILED",
      message: error?.message || String(error)
    };
  }

  // src/extension/core-events.js
  function createCoreEventSubscription(core) {
    if (typeof core.addEventListener === "function" && typeof core.removeEventListener === "function") {
      return (name, callback) => {
        core.addEventListener(name, callback);
        return () => core.removeEventListener(name, callback);
      };
    }
    if (typeof core.on === "function" && typeof core.off === "function") {
      return (name, callback) => {
        core.on(name, callback);
        return () => core.off(name, callback);
      };
    }
    if (typeof core.on === "function" && typeof core.removeListener === "function") {
      return (name, callback) => {
        core.on(name, callback);
        return () => core.removeListener(name, callback);
      };
    }
    if (typeof core.addListener === "function" && typeof core.removeListener === "function") {
      return (name, callback) => {
        core.addListener(name, callback);
        return () => core.removeListener(name, callback);
      };
    }
    if (typeof core.addListener === "function" && typeof core.off === "function") {
      return (name, callback) => {
        core.addListener(name, callback);
        return () => core.off(name, callback);
      };
    }
    return void 0;
  }
  function supportsCoreEvents(core) {
    return createCoreEventSubscription(core) !== void 0;
  }

  // src/extension/main-bridge.js
  var coreRecords = /* @__PURE__ */ new WeakMap();
  var coreRecordsById = /* @__PURE__ */ new Map();
  var subscriptions = /* @__PURE__ */ new Map();
  var nextCoreId = 1;
  var activeCoreRecord;
  var QUALITY_FIELDS = Object.freeze([
    "qn",
    "qualityNumber",
    "quality",
    "nowQ",
    "realQ",
    "id",
    "value",
    "oldA",
    "nowA",
    "newA",
    "acceptQuality",
    "accept_quality",
    "acceptQn",
    "accept_qn",
    "availableQuality",
    "availableQualities",
    "qualities",
    "oldQ",
    "newQ",
    "oldRQ"
  ]);
  var MEDIA_INFO_FIELDS = Object.freeze(["bitrate", "bandwidth", "video", "audio"]);
  function pagePlayerObject() {
    const player = globalThis.player;
    if (player === void 0 || player === null || typeof player !== "object" && typeof player !== "function") {
      throw Object.assign(new Error("window.player 尚未可用"), { code: "PLAYER_UNAVAILABLE" });
    }
    return player;
  }
  function pagePlayer() {
    const player = pagePlayerObject();
    if (typeof player.__core !== "function") {
      throw Object.assign(new Error("window.player.__core() 尚未可用"), { code: "VOD_CORE_UNAVAILABLE" });
    }
    return player;
  }
  function currentCore() {
    const core = pagePlayer().__core();
    if (core === void 0 || core === null || typeof core !== "object" && typeof core !== "function") {
      throw Object.assign(new Error("window.player.__core() 返回空内核"), { code: "VOD_CORE_UNAVAILABLE" });
    }
    return core;
  }
  function detachSubscriptionsForCore(coreId) {
    for (const [subscriptionId, subscription] of subscriptions) {
      if (subscription.coreId !== coreId) {
        continue;
      }
      try {
        subscription.remove();
      } catch (error) {
        console.warn("[BilibiliBuffer] 清理已替换内核的桥接订阅失败", serializeError(error));
      }
      subscriptions.delete(subscriptionId);
    }
  }
  function recordFor(core) {
    if (activeCoreRecord?.core === core) {
      return activeCoreRecord;
    }
    if (activeCoreRecord !== void 0) {
      detachSubscriptionsForCore(activeCoreRecord.id);
    }
    let record = coreRecords.get(core);
    if (record === void 0) {
      record = { core, id: nextCoreId };
      nextCoreId += 1;
      coreRecords.set(core, record);
    }
    coreRecordsById.clear();
    coreRecordsById.set(record.id, record);
    activeCoreRecord = record;
    return record;
  }
  function findLargestVideo() {
    const videos = [...document.querySelectorAll("video")];
    if (videos.length === 0) {
      return void 0;
    }
    return videos.sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
  }
  function readCurrentVideoSource() {
    const video = findLargestVideo();
    return video === void 0 ? "" : video.currentSrc || video.src || "";
  }
  function readCurrentVideoSession() {
    const href = globalThis.location?.href || "";
    if (href.length === 0) {
      return "";
    }
    const url = new URL(href);
    return `${url.pathname}#p=${url.searchParams.get("p") || "1"}`;
  }
  function serializeObserved(value, allowedFields = QUALITY_FIELDS, depth = 0) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (depth >= 4 || value === void 0 || typeof value === "function") {
      return void 0;
    }
    if (Array.isArray(value)) {
      return value.map((item) => serializeObserved(item, allowedFields, depth + 1)).filter((item) => item !== void 0);
    }
    const output = {};
    for (const field of allowedFields) {
      if (!(field in value)) {
        continue;
      }
      const serialized = serializeObserved(value[field], allowedFields, depth + 1);
      if (serialized !== void 0) {
        output[field] = serialized;
      }
    }
    return output;
  }
  function serializeMediaInfo(value) {
    return serializeObserved(value, MEDIA_INFO_FIELDS);
  }
  function serializeTimeRanges(value) {
    if (value === void 0 || value === null) {
      return void 0;
    }
    const ranges = [];
    for (let index = 0; index < value.length; index += 1) {
      const start = Number(value.start(index));
      const end = Number(value.end(index));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw Object.assign(new Error(`播放器 buffered range ${index} 无效`), { code: "VOD_BUFFER_RANGES_INVALID" });
      }
      ranges.push({ start, end });
    }
    return ranges;
  }
  function serializeBufferedRanges(core) {
    if (typeof core.getBufferedRanges !== "function") {
      return void 0;
    }
    const ranges = core.getBufferedRanges();
    if (ranges === void 0 || ranges === null) {
      return void 0;
    }
    if (ranges.video !== void 0 || ranges.audio !== void 0) {
      return {
        video: serializeTimeRanges(ranges.video),
        audio: serializeTimeRanges(ranges.audio)
      };
    }
    return serializeTimeRanges(ranges);
  }
  function readCoreCapabilities(core) {
    return {
      getQuality: typeof core.getQuality === "function",
      getCurrentQuality: typeof core.getCurrentQuality === "function",
      getCurrentQn: typeof core.getCurrentQn === "function",
      getSupportedQualityList: typeof core.getSupportedQualityList === "function",
      getQualityList: typeof core.getQualityList === "function",
      requestQuality: typeof core.requestQuality === "function",
      getBufferedRanges: typeof core.getBufferedRanges === "function",
      getMediaInfo: typeof core.getMediaInfo === "function",
      getCurrentMediaInfo: typeof core.getCurrentMediaInfo === "function",
      getQualityInfo: typeof core.getQualityInfo === "function",
      getStableBufferTime: typeof core.getStableBufferTime === "function",
      getStableBufferSeconds: typeof core.getStableBufferSeconds === "function",
      setStableBufferTime: typeof core.setStableBufferTime === "function",
      setScheduleWhilePaused: typeof core.setScheduleWhilePaused === "function",
      events: supportsCoreEvents(core)
    };
  }
  function readPlayerCapabilities(player) {
    return Object.fromEntries(
      BRIDGE_PLAYER_CAPABILITIES.map((method) => [method, typeof player[method] === "function"])
    );
  }
  function readOptional(core, names, serializer = serializeObserved) {
    for (const name of names) {
      if (typeof core[name] === "function") {
        return serializer(core[name]());
      }
    }
    return void 0;
  }
  function getCoreSnapshot() {
    const player = pagePlayer();
    const core = currentCore();
    const record = recordFor(core);
    const hasCoreEventSupport = supportsCoreEvents(core);
    const snapshot = {
      coreId: record.id,
      source: readCurrentVideoSource(),
      quality: readOptional(core, ["getQuality", "getCurrentQuality", "getCurrentQn"]),
      supportedQualityList: typeof core.getSupportedQualityList === "function" ? serializeObserved(core.getSupportedQualityList()) : void 0,
      qualityList: typeof core.getQualityList === "function" ? serializeObserved(core.getQualityList("video")) : void 0,
      bufferedRanges: serializeBufferedRanges(core),
      mediaInfo: readOptional(core, ["getMediaInfo", "getCurrentMediaInfo", "getQualityInfo"], serializeMediaInfo),
      stableBufferTime: readOptional(core, ["getStableBufferTime", "getStableBufferSeconds"]),
      supportsCoreEvents: hasCoreEventSupport,
      capabilities: {
        player: readPlayerCapabilities(player),
        core: readCoreCapabilities(core)
      }
    };
    return snapshot;
  }
  function requireCurrentRecord(coreId) {
    const current = recordFor(currentCore());
    const record = coreRecordsById.get(coreId);
    if (record === void 0 || record !== current) {
      throw Object.assign(new Error(`页面播放器内核 ${coreId} 已过期`), { code: "BRIDGE_CORE_STALE" });
    }
    return record;
  }
  function requireArguments(args, count) {
    if (!Array.isArray(args) || args.length !== count) {
      throw Object.assign(new Error(`桥接操作参数数量错误，期望 ${count}`), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    return args;
  }
  async function callPlayer(args) {
    if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
      throw Object.assign(new Error("页面播放器操作参数数量错误"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    const [method, value] = args;
    if (!BRIDGE_PLAYER_METHODS.includes(method)) {
      throw Object.assign(new Error(`页面播放器操作未允许: ${method}`), { code: "BRIDGE_OPERATION_DENIED" });
    }
    const player = pagePlayerObject();
    if (typeof player[method] !== "function") {
      throw Object.assign(new Error(`当前页面播放器没有 ${method}`), { code: "BRIDGE_METHOD_UNAVAILABLE" });
    }
    if (method === "pause") {
      if (args.length !== 1) {
        throw Object.assign(new Error("pause 不接受参数"), { code: "BRIDGE_ARGUMENTS_INVALID" });
      }
      await player.pause();
      return true;
    }
    if (method === "requestQuality") {
      if (args.length !== 2 || !Number.isInteger(value) || value <= 0) {
        throw Object.assign(new Error("页面播放器 requestQuality 参数必须是正整数清晰度"), {
          code: "BRIDGE_ARGUMENTS_INVALID"
        });
      }
      const core = currentCore();
      const source = readCurrentVideoSource();
      const session = readCurrentVideoSession();
      const result = await player.requestQuality(value);
      if (pagePlayerObject() !== player || currentCore() !== core || readCurrentVideoSource() !== source || readCurrentVideoSession() !== session) {
        throw Object.assign(new Error("页面播放器画质请求完成时页面会话已经变化"), { code: "BRIDGE_CORE_STALE" });
      }
      return { result: result === void 0 ? true : serializeObserved(result), snapshot: getCoreSnapshot() };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || value.enable !== false && value.enable !== true) {
      throw Object.assign(new Error(`${method} 参数必须是 {enable:boolean}`), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    await player[method](value);
    return true;
  }
  function callCoreSync(args) {
    const [coreId, method, methodArgs] = requireArguments(args, 3);
    if (!Number.isInteger(coreId) || !BRIDGE_CORE_SYNC_METHODS.includes(method)) {
      throw Object.assign(new Error(`内核同步操作未允许: ${method}`), { code: "BRIDGE_OPERATION_DENIED" });
    }
    const record = requireCurrentRecord(coreId);
    const values = methodArgs === void 0 ? [] : methodArgs;
    if (!Array.isArray(values)) {
      throw Object.assign(new Error("内核操作参数必须是数组"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (typeof record.core[method] !== "function") {
      throw Object.assign(new Error(`当前内核没有 ${method}`), { code: "BRIDGE_METHOD_UNAVAILABLE" });
    }
    if ([
      "getQuality",
      "getCurrentQuality",
      "getCurrentQn",
      "getSupportedQualityList",
      "getBufferedRanges",
      "getMediaInfo",
      "getCurrentMediaInfo",
      "getQualityInfo",
      "getStableBufferTime",
      "getStableBufferSeconds"
    ].includes(method) && values.length !== 0) {
      throw Object.assign(new Error(`${method} 不接受参数`), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (method === "getQualityList" && (values.length !== 1 || values[0] !== "video")) {
      throw Object.assign(new Error("getQualityList 只接受 video 轨道参数"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (method === "setStableBufferTime" && (values.length !== 1 || !Number.isFinite(values[0]) || values[0] <= 0)) {
      throw Object.assign(new Error("稳定缓冲秒数必须是正数"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (method === "setScheduleWhilePaused" && (values.length !== 1 || typeof values[0] !== "boolean")) {
      throw Object.assign(new Error("暂停调度参数必须是布尔值"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    const result = record.core[method](...values);
    if (method === "getBufferedRanges") {
      return serializeBufferedRanges(record.core);
    }
    if (["getMediaInfo", "getCurrentMediaInfo", "getQualityInfo"].includes(method)) {
      return serializeMediaInfo(result);
    }
    return serializeObserved(result);
  }
  async function callCoreAsync(args) {
    const [coreId, method, methodArgs] = requireArguments(args, 3);
    if (!Number.isInteger(coreId) || !BRIDGE_CORE_ASYNC_METHODS.includes(method)) {
      throw Object.assign(new Error(`内核异步操作未允许: ${method}`), { code: "BRIDGE_OPERATION_DENIED" });
    }
    const record = requireCurrentRecord(coreId);
    const values = methodArgs === void 0 ? [] : methodArgs;
    if (!Array.isArray(values)) {
      throw Object.assign(new Error("内核异步操作参数必须是数组"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (method !== "requestQuality" || values.length !== 1 || !Number.isInteger(values[0]) || values[0] <= 0) {
      throw Object.assign(new Error("requestQuality 参数必须是正整数清晰度"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    if (typeof record.core[method] !== "function") {
      throw Object.assign(new Error(`当前内核没有 ${method}`), { code: "BRIDGE_METHOD_UNAVAILABLE" });
    }
    const result = await record.core[method](...values);
    return {
      result: result === void 0 ? true : serializeObserved(result),
      snapshot: getCoreSnapshot()
    };
  }
  function errorFromEvent(event) {
    const value = event?.error ?? event?.detail?.error ?? event?.detail ?? event;
    return serializeObserved(value, ["code", "name", "message", "type", "error"], 0);
  }
  function emitCoreEvent(coreId, name, event) {
    document.dispatchEvent(
      new CustomEvent(BRIDGE_EVENT_EVENT, {
        detail: encodeMessage({
          version: BRIDGE_VERSION,
          coreId,
          source: readCurrentVideoSource(),
          name,
          value: { error: errorFromEvent(event) }
        })
      })
    );
  }
  function subscribeCoreEvents(args, subscriptionId) {
    const [coreId, name] = requireArguments(args, 2);
    if (!Number.isInteger(coreId) || !BRIDGE_CORE_EVENTS.includes(name)) {
      throw Object.assign(new Error(`内核事件未允许: ${name}`), { code: "BRIDGE_OPERATION_DENIED" });
    }
    const record = requireCurrentRecord(coreId);
    const callback = (event) => emitCoreEvent(coreId, name, event);
    const subscribe = createCoreEventSubscription(record.core);
    if (subscribe === void 0) {
      throw Object.assign(new Error("当前内核没有事件接口"), { code: "BRIDGE_METHOD_UNAVAILABLE" });
    }
    subscriptions.set(subscriptionId, { coreId, remove: subscribe(name, callback) });
    return { subscriptionId };
  }
  function unsubscribeCoreEvents(args) {
    const [subscriptionId] = requireArguments(args, 1);
    if (!Number.isInteger(subscriptionId)) {
      throw Object.assign(new Error("订阅编号无效"), { code: "BRIDGE_ARGUMENTS_INVALID" });
    }
    const subscription = subscriptions.get(subscriptionId);
    if (subscription !== void 0) {
      subscription.remove();
      subscriptions.delete(subscriptionId);
    }
    return true;
  }
  function invoke(request) {
    assertOperation(request.operation);
    switch (request.operation) {
      case "getCoreSnapshot":
        requireArguments(request.args, 0);
        return getCoreSnapshot();
      case "callPlayer":
        return callPlayer(request.args);
      case "callCoreSync":
        return callCoreSync(request.args);
      case "callCoreAsync":
        return callCoreAsync(request.args);
      case "subscribeCoreEvents":
        return subscribeCoreEvents(request.args, request.id);
      case "unsubscribeCoreEvents":
        return unsubscribeCoreEvents(request.args);
      default:
        throw new Error(`未处理的桥接操作: ${request.operation}`);
    }
  }
  function sendResponse(request, response) {
    const serialized = encodeMessage({ ...response, operation: request.operation });
    if (request.mode === "sync") {
      document.documentElement.setAttribute(BRIDGE_RESPONSE_ATTRIBUTE, serialized);
    } else {
      document.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: serialized }));
    }
  }
  function respond(request, operation) {
    try {
      const value = operation();
      if (value instanceof Promise) {
        void value.then((result) => {
          sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: true, value: result });
        }).catch((error) => {
          sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
        });
        return;
      }
      sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: true, value });
    } catch (error) {
      sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
    }
  }
  document.addEventListener(BRIDGE_REQUEST_EVENT, (event) => {
    try {
      const request = decodeMessage(event.detail);
      if (request.mode !== "sync" && request.mode !== "async") {
        throw new Error("bridge request mode is invalid");
      }
      if (!Array.isArray(request.args)) {
        throw new Error("bridge request args must be an array");
      }
      assertOperation(request.operation);
      respond(request, () => invoke(request));
    } catch (error) {
      const raw = typeof event.detail === "string" ? event.detail : "";
      let request;
      try {
        request = JSON.parse(raw);
      } catch (parseError) {
        console.error("[BilibiliBuffer] 无法解析桥接请求", serializeError(parseError));
        return;
      }
      console.warn("[BilibiliBuffer] 拒绝无效桥接请求", serializeError(error));
      if (Number.isInteger(request?.id) && (request.mode === "sync" || request.mode === "async")) {
        sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
      }
    }
  });
})();
