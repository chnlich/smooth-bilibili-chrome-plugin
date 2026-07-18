import { BufferScriptError, fail } from '../errors.js';
import {
  assertOperation,
  BRIDGE_CORE_EVENTS,
  BRIDGE_EVENT_EVENT,
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_ATTRIBUTE,
  BRIDGE_RESPONSE_EVENT,
  BRIDGE_VERSION,
  decodeMessage,
  encodeMessage,
  serializeError,
} from './bridge-contract.js';

const CORE_SNAPSHOT_FIELDS = Object.freeze([
  'coreId',
  'source',
  'quality',
  'supportedQualityList',
  'qualityList',
  'bufferedRanges',
  'mediaInfo',
  'stableBufferTime',
  'supportsCoreEvents',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSerializable(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (
    depth >= 4 ||
    (Array.isArray(value) && value.length > 256) ||
    (!isObject(value) && !Array.isArray(value))
  ) {
    return false;
  }
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.length <= (Array.isArray(value) ? 256 : 64) && values.every((item) => isSerializable(item, depth + 1));
}

function logInvalidBridgePayload(kind, error) {
  console.warn(`[BilibiliBuffer] 忽略无效桥接${kind}`, serializeError(error));
}

function validateResponse(response) {
  if (!isObject(response) || typeof response.operation !== 'string' || typeof response.ok !== 'boolean') {
    fail('BRIDGE_RESPONSE_INVALID', '桥接响应格式无效');
  }
  assertOperation(response.operation);
  if (Object.prototype.hasOwnProperty.call(response, 'value') && !isSerializable(response.value)) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接响应包含不可序列化值');
  }
  if (
    !response.ok &&
    (!isObject(response.error) || typeof response.error.code !== 'string' || typeof response.error.message !== 'string')
  ) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接失败响应缺少错误代码或消息');
  }
  return response;
}

function validateCoreSnapshot(snapshot) {
  if (
    !isObject(snapshot) ||
    !Number.isInteger(snapshot.coreId) ||
    snapshot.coreId <= 0 ||
    typeof snapshot.source !== 'string'
  ) {
    fail('BRIDGE_SNAPSHOT_INVALID', '桥接内核快照缺少有效身份');
  }
  if (typeof snapshot.supportsCoreEvents !== 'boolean') {
    fail('BRIDGE_SNAPSHOT_INVALID', '桥接内核快照缺少事件能力标记');
  }
  for (const [field, value] of Object.entries(snapshot)) {
    if (!CORE_SNAPSHOT_FIELDS.includes(field) || !isSerializable(value)) {
      fail('BRIDGE_SNAPSHOT_INVALID', `桥接内核快照字段无效: ${field}`);
    }
  }
  return snapshot;
}

function parseCoreEvent(serialized) {
  if (typeof serialized !== 'string') {
    fail('BRIDGE_EVENT_INVALID', '桥接内核事件不是字符串');
  }
  const event = JSON.parse(serialized);
  if (
    !isObject(event) ||
    event.version !== BRIDGE_VERSION ||
    !Number.isInteger(event.coreId) ||
    event.coreId <= 0 ||
    typeof event.source !== 'string' ||
    !BRIDGE_CORE_EVENTS.includes(event.name) ||
    !isObject(event.value) ||
    Object.keys(event.value).some((field) => field !== 'error') ||
    (Object.prototype.hasOwnProperty.call(event.value, 'error') && !isSerializable(event.value.error))
  ) {
    fail('BRIDGE_EVENT_INVALID', '桥接内核事件格式无效');
  }
  return event;
}

function customEventClass(documentObject) {
  return documentObject.defaultView?.CustomEvent || globalThis.CustomEvent;
}

function timeRangesFromSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) {
    return undefined;
  }
  const createRanges = (ranges) => {
    if (ranges === undefined) {
      return undefined;
    }
    return {
      length: ranges.length,
      start(index) {
        return ranges[index].start;
      },
      end(index) {
        return ranges[index].end;
      },
    };
  };
  if (snapshot.video !== undefined || snapshot.audio !== undefined) {
    return { video: createRanges(snapshot.video), audio: createRanges(snapshot.audio) };
  }
  return createRanges(snapshot);
}

function responseError(response) {
  return new BufferScriptError(response.error?.code || 'BRIDGE_CALL_FAILED', response.error?.message || '桥接调用失败');
}

export class BridgeClient {
  constructor(documentObject = document, runtimeObject = globalThis) {
    this.documentObject = documentObject;
    this.runtimeObject = runtimeObject;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.destroyed = false;
    this.onResponse = (event) => this.resolveResponse(event.detail);
    this.onCoreEvent = (event) => this.emitCoreEvent(event.detail);
    documentObject.addEventListener(BRIDGE_RESPONSE_EVENT, this.onResponse);
    documentObject.addEventListener(BRIDGE_EVENT_EVENT, this.onCoreEvent);
  }

  nextRequestId() {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  createRequest(operation, args, mode) {
    if (this.destroyed) {
      fail('BRIDGE_CLIENT_DESTROYED', '桥接客户端已经销毁');
    }
    assertOperation(operation);
    return { version: BRIDGE_VERSION, id: this.nextRequestId(), operation, args, mode };
  }

  dispatch(request) {
    const CustomEventClass = customEventClass(this.documentObject);
    this.documentObject.dispatchEvent(
      new CustomEventClass(BRIDGE_REQUEST_EVENT, { detail: encodeMessage(request) }),
    );
  }

  decodeResponse(serialized, expectedId, expectedOperation) {
    const response = validateResponse(decodeMessage(serialized));
    if (response.id !== expectedId || response.operation !== expectedOperation) {
      fail('BRIDGE_RESPONSE_INVALID', '桥接响应编号或操作无效');
    }
    if (!response.ok) {
      throw responseError(response);
    }
    return response.value;
  }

  callSync(operation, args = []) {
    const request = this.createRequest(operation, args, 'sync');
    if (this.documentObject.documentElement === null) {
      fail('BRIDGE_DOCUMENT_UNAVAILABLE', '桥接调用时页面 documentElement 不可用');
    }
    this.documentObject.documentElement.setAttribute(BRIDGE_RESPONSE_ATTRIBUTE, '');
    this.dispatch(request);
    const serialized = this.documentObject.documentElement.getAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
    this.documentObject.documentElement.removeAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
    if (serialized === null || serialized.length === 0) {
      fail('BRIDGE_RESPONSE_MISSING', `桥接同步操作没有响应: ${operation}`);
    }
    try {
      return this.decodeResponse(serialized, request.id, request.operation);
    } catch (error) {
      logInvalidBridgePayload('同步响应', error);
      throw error;
    }
  }

  callAsync(operation, args = []) {
    const request = this.createRequest(operation, args, 'async');
    return new Promise((resolve, reject) => {
      const timer = this.runtimeObject.setTimeout(() => {
        this.pending.delete(request.id);
        reject(new BufferScriptError('BRIDGE_RESPONSE_TIMEOUT', `桥接操作超时: ${operation}`));
      }, 15000);
      this.pending.set(request.id, { resolve, reject, timer, operation });
      try {
        this.dispatch(request);
      } catch (error) {
        this.runtimeObject.clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new BufferScriptError('BRIDGE_DISPATCH_FAILED', '桥接请求派发失败', error));
      }
    });
  }

  resolveResponse(serialized) {
    let response;
    try {
      response = validateResponse(decodeMessage(serialized));
    } catch (error) {
      logInvalidBridgePayload('异步响应', error);
      return;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    if (response.operation !== pending.operation) {
      logInvalidBridgePayload('异步响应', new Error('桥接响应操作不匹配待处理请求'));
      return;
    }
    this.pending.delete(response.id);
    this.runtimeObject.clearTimeout(pending.timer);
    try {
      pending.resolve(this.decodeResponse(serialized, response.id, pending.operation));
    } catch (error) {
      pending.reject(error);
    }
  }

  subscribeCore(coreId, name, source, callback) {
    if (!Number.isInteger(coreId) || coreId <= 0 || !BRIDGE_CORE_EVENTS.includes(name) || typeof source !== 'string') {
      fail('BRIDGE_SUBSCRIPTION_INVALID', '桥接内核订阅参数无效');
    }
    const result = this.callSync('subscribeCoreEvents', [coreId, name]);
    const subscriptionId = result.subscriptionId;
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      fail('BRIDGE_SUBSCRIPTION_INVALID', '桥接内核订阅没有返回有效编号');
    }
    this.eventListeners.set(subscriptionId, { coreId, name, source, callback });
    return subscriptionId;
  }

  unsubscribeCore(subscriptionId) {
    this.callSync('unsubscribeCoreEvents', [subscriptionId]);
    this.eventListeners.delete(subscriptionId);
  }

  emitCoreEvent(serialized) {
    let event;
    try {
      event = parseCoreEvent(serialized);
    } catch (error) {
      logInvalidBridgePayload('内核事件', error);
      return;
    }
    for (const subscription of this.eventListeners.values()) {
      if (
        subscription.coreId === event.coreId &&
        subscription.name === event.name &&
        subscription.source === event.source
      ) {
        try {
          subscription.callback(event.value);
        } catch (error) {
          console.error('[BilibiliBuffer] 桥接内核事件回调失败', serializeError(error));
        }
      }
    }
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    for (const subscriptionId of this.eventListeners.keys()) {
      try {
        this.callSync('unsubscribeCoreEvents', [subscriptionId]);
      } catch (error) {
        console.warn('[BilibiliBuffer] 清理桥接事件订阅失败', serializeError(error));
      }
    }
    this.eventListeners.clear();
    this.destroyed = true;
    this.documentObject.removeEventListener(BRIDGE_RESPONSE_EVENT, this.onResponse);
    this.documentObject.removeEventListener(BRIDGE_EVENT_EVENT, this.onCoreEvent);
    for (const pending of this.pending.values()) {
      this.runtimeObject.clearTimeout(pending.timer);
      pending.reject(new BufferScriptError('BRIDGE_CLIENT_DESTROYED', '桥接客户端已经销毁'));
    }
    this.pending.clear();
  }
}

export class BridgeCore {
  constructor(client, snapshot) {
    validateCoreSnapshot(snapshot);
    this.client = client;
    this.coreId = snapshot.coreId;
    this.snapshot = snapshot;
    this.subscriptions = new Map();
    this.stale = false;
    if (!snapshot.supportsCoreEvents) {
      this.addEventListener = undefined;
      this.removeEventListener = undefined;
    }
  }

  update(snapshot) {
    this.assertActive();
    validateCoreSnapshot(snapshot);
    if (snapshot.coreId !== this.coreId) {
      fail('BRIDGE_CORE_ID_CHANGED', '桥接内核身份不能原地改变');
    }
    if (snapshot.source !== this.snapshot.source) {
      fail('BRIDGE_CORE_SOURCE_CHANGED', '桥接内核媒体 source 不能原地改变');
    }
    this.snapshot = snapshot;
  }

  assertActive() {
    if (this.stale) {
      fail('BRIDGE_CORE_STALE', `桥接内核 ${this.coreId} 已过期`);
    }
  }

  markStale() {
    if (this.stale) {
      return;
    }
    this.stale = true;
    for (const subscriptionId of this.subscriptions.values()) {
      try {
        this.client.unsubscribeCore(subscriptionId);
      } catch (error) {
        console.warn('[BilibiliBuffer] 清理过期桥接内核订阅失败', serializeError(error));
      }
    }
    this.subscriptions.clear();
  }

  callCoreSync(method, args = []) {
    this.assertActive();
    try {
      return this.client.callSync('callCoreSync', [this.coreId, method, args]);
    } catch (error) {
      if (error?.code === 'BRIDGE_CORE_STALE') {
        this.markStale();
      }
      throw error;
    }
  }

  readFirstAvailable(methods, snapshotField, args = []) {
    let unavailable;
    for (const method of methods) {
      try {
        const value = this.callCoreSync(method, args);
        this.snapshot[snapshotField] = value;
        return value;
      } catch (error) {
        if (error?.code !== 'BRIDGE_METHOD_UNAVAILABLE') {
          throw error;
        }
        unavailable = error;
      }
    }
    if (unavailable !== undefined) {
      return this.snapshot[snapshotField];
    }
    return undefined;
  }

  getQuality() {
    return this.readFirstAvailable(['getQuality', 'getCurrentQuality', 'getCurrentQn'], 'quality');
  }

  getSupportedQualityList() {
    return this.readFirstAvailable(['getSupportedQualityList'], 'supportedQualityList');
  }

  getQualityList(...args) {
    return this.readFirstAvailable(['getQualityList'], 'qualityList', args);
  }

  getBufferedRanges() {
    return timeRangesFromSnapshot(this.readFirstAvailable(['getBufferedRanges'], 'bufferedRanges'));
  }

  getMediaInfo() {
    return this.readFirstAvailable(['getMediaInfo', 'getCurrentMediaInfo', 'getQualityInfo'], 'mediaInfo');
  }

  getCurrentMediaInfo() {
    return this.getMediaInfo();
  }

  getQualityInfo() {
    return this.getMediaInfo();
  }

  getStableBufferTime() {
    return this.readFirstAvailable(['getStableBufferTime', 'getStableBufferSeconds'], 'stableBufferTime');
  }

  setStableBufferTime(seconds) {
    const result = this.callCoreSync('setStableBufferTime', [seconds]);
    this.snapshot.stableBufferTime = seconds;
    return result;
  }

  setScheduleWhilePaused(enabled) {
    return this.callCoreSync('setScheduleWhilePaused', [enabled]);
  }

  requestQuality(qualityNumber) {
    this.assertActive();
    const source = this.snapshot.source;
    return this.client
      .callAsync('callCoreAsync', [this.coreId, 'requestQuality', [qualityNumber]])
      .then((value) => {
        if (value?.snapshot !== undefined) {
          validateCoreSnapshot(value.snapshot);
          if (value.snapshot.coreId !== this.coreId || value.snapshot.source !== source || this.stale) {
            this.markStale();
            fail('BRIDGE_CORE_STALE', `桥接内核 ${this.coreId} 的异步画质请求已过期`);
          }
          this.update(value.snapshot);
        }
        return value?.result === undefined ? value : value.result;
      })
      .catch((error) => {
        if (error?.code === 'BRIDGE_CORE_STALE') {
          this.markStale();
        }
        throw error;
      });
  }

  addEventListener(name, callback) {
    this.assertActive();
    const subscriptionId = this.client.subscribeCore(this.coreId, name, this.snapshot.source, callback);
    this.subscriptions.set(callback, subscriptionId);
  }

  removeEventListener(name, callback) {
    const subscriptionId = this.subscriptions.get(callback);
    if (subscriptionId === undefined) {
      return;
    }
    if (!this.stale) {
      this.client.unsubscribeCore(subscriptionId);
    }
    this.subscriptions.delete(callback);
  }
}

export function createPageWindowAdapter(client, windowObject = window) {
  const state = { core: undefined };
  let refreshPromise;
  const player = {
    __core() {
      if (state.core === undefined) {
        fail('VOD_CORE_UNAVAILABLE', 'window.player.__core() 尚未可用');
      }
      return state.core;
    },
    setAutoSyncProgressCfg(value) {
      return client.callAsync('callPlayer', ['setAutoSyncProgressCfg', value]);
    },
    setAutoDiscardFrameCfg(value) {
      return client.callAsync('callPlayer', ['setAutoDiscardFrameCfg', value]);
    },
    pause() {
      return client.callAsync('callPlayer', ['pause']);
    },
  };
  const pageWindow = {
    location: windowObject.location,
    performance: windowObject.performance,
    MediaSource: windowObject.MediaSource,
    URL: windowObject.URL,
    player,
  };
  return {
    pageWindow,
    async refreshCore() {
      if (refreshPromise === undefined) {
        refreshPromise = client
          .callAsync('getCoreSnapshot', [])
          .then((snapshot) => {
            validateCoreSnapshot(snapshot);
            if (
              state.core === undefined ||
              state.core.stale ||
              state.core.coreId !== snapshot.coreId ||
              state.core.snapshot.source !== snapshot.source
            ) {
              state.core?.markStale();
              state.core = new BridgeCore(client, snapshot);
            } else {
              state.core.update(snapshot);
            }
            return state.core;
          })
          .finally(() => {
            refreshPromise = undefined;
          });
      }
      return refreshPromise;
    },
    get core() {
      return state.core;
    },
  };
}
