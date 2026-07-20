import { BufferScriptError, fail } from '../errors.js';
import {
  assertOperation,
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
  'capabilities',
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

function validateSerializedError(value) {
  const seen = new WeakSet();
  let current = value;
  for (;;) {
    if (!isObject(current) || seen.has(current)) {
      fail('BRIDGE_RESPONSE_INVALID', '桥接错误对象格式无效');
    }
    seen.add(current);
    const allowedFields = new Set(['name', 'code', 'message', 'stack', 'cause']);
    if (Object.keys(current).some((field) => !allowedFields.has(field))) {
      fail('BRIDGE_RESPONSE_INVALID', '桥接错误对象包含未允许字段');
    }
    for (const field of ['name', 'code', 'message', 'stack']) {
      if (Object.prototype.hasOwnProperty.call(current, field) && typeof current[field] !== 'string') {
        fail('BRIDGE_RESPONSE_INVALID', `桥接错误字段 ${field} 无效`);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(current, 'cause') || typeof current.cause === 'string') return;
    current = current.cause;
  }
}

function logInvalidBridgePayload(kind, error) {
  console.warn(`[BilibiliBuffer] 忽略无效桥接${kind}`, serializeError(error));
}

function validateResponse(response) {
  if (!isObject(response) || typeof response.operation !== 'string' || typeof response.ok !== 'boolean') {
    fail('BRIDGE_RESPONSE_INVALID', '桥接响应格式无效');
  }
  const allowedFields = new Set(['version', 'id', 'operation', 'ok', 'value', 'error']);
  if (Object.keys(response).some((field) => !allowedFields.has(field))) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接响应包含未允许字段');
  }
  if (!Number.isInteger(response.id) || response.id <= 0 || response.version !== BRIDGE_VERSION) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接响应身份字段无效');
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
  if (response.ok && Object.prototype.hasOwnProperty.call(response, 'error')) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接成功响应不得包含错误');
  }
  if (!response.ok && Object.prototype.hasOwnProperty.call(response, 'value')) {
    fail('BRIDGE_RESPONSE_INVALID', '桥接失败响应不得包含值');
  }
  if (Object.prototype.hasOwnProperty.call(response, 'error')) validateSerializedError(response.error);
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
  const coreCapabilities = snapshot.capabilities?.core;
  if (!isObject(snapshot.capabilities) || !isObject(coreCapabilities)) {
    fail('BRIDGE_SNAPSHOT_INVALID', '桥接内核快照缺少真实能力标记');
  }
  if (Object.keys(snapshot).some((field) => !CORE_SNAPSHOT_FIELDS.includes(field)) ||
    Object.keys(snapshot.capabilities).some((field) => field !== 'core') ||
    Object.keys(coreCapabilities).some((field) => field !== 'setStableBufferTime')) {
    fail('BRIDGE_SNAPSHOT_INVALID', '桥接内核快照包含未允许字段');
  }
  for (const field of ['setStableBufferTime']) {
    if (typeof coreCapabilities[field] !== 'boolean') {
      fail('BRIDGE_SNAPSHOT_INVALID', `桥接内核快照缺少能力标记: ${field}`);
    }
  }
  for (const [field, value] of Object.entries(snapshot)) {
    if (!CORE_SNAPSHOT_FIELDS.includes(field) || !isSerializable(value)) {
      fail('BRIDGE_SNAPSHOT_INVALID', `桥接内核快照字段无效: ${field}`);
    }
  }
  return snapshot;
}

function validateLiveCapabilitySnapshot(snapshot) {
  if (
    !isObject(snapshot) ||
    !isObject(snapshot.live) ||
    typeof snapshot.live.disableAutoCatchup !== 'boolean'
  ) {
    fail('BRIDGE_LIVE_SNAPSHOT_INVALID', '桥接直播能力快照格式无效');
  }
  if (Object.keys(snapshot).some((field) => field !== 'live') ||
    Object.keys(snapshot.live).some((field) => field !== 'disableAutoCatchup')) {
    fail('BRIDGE_LIVE_SNAPSHOT_INVALID', '桥接直播能力快照包含未允许字段');
  }
  return snapshot;
}

function responseError(response) {
  const error = new BufferScriptError(
    response.error?.code || 'BRIDGE_CALL_FAILED',
    response.error?.message || '桥接调用失败',
    response.error?.cause,
  );
  if (typeof response.error?.name === 'string') error.name = response.error.name;
  if (typeof response.error?.stack === 'string') error.stack = response.error.stack;
  return error;
}

function customEventClass(documentObject) {
  return documentObject.defaultView?.CustomEvent || globalThis.CustomEvent;
}

export class BridgeClient {
  constructor(documentObject = document, runtimeObject = globalThis) {
    this.documentObject = documentObject;
    this.runtimeObject = runtimeObject;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = undefined;
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

  diagnostic(code, data, error) {
    try {
      this.diagnostics?.log(code, data, error);
    } catch (diagnosticError) {
      console.error('[BilibiliBuffer] bridge diagnostic failed', serializeError(diagnosticError));
    }
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
    this.diagnostic('bridge.request', { operation, direction: 'content-to-main' });
    if (this.documentObject.documentElement === null) {
      const error = new BufferScriptError('BRIDGE_DOCUMENT_UNAVAILABLE', '桥接调用时页面 documentElement 不可用');
      this.diagnostic('bridge.error', { operation, direction: 'content-to-main' }, error);
      throw error;
    }
    this.documentObject.documentElement.setAttribute(BRIDGE_RESPONSE_ATTRIBUTE, '');
    this.dispatch(request);
    const serialized = this.documentObject.documentElement.getAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
    this.documentObject.documentElement.removeAttribute(BRIDGE_RESPONSE_ATTRIBUTE);
    if (serialized === null || serialized.length === 0) {
      const error = new BufferScriptError('BRIDGE_RESPONSE_MISSING', `桥接同步操作没有响应: ${operation}`);
      this.diagnostic('bridge.error', { operation, direction: 'main-to-content' }, error);
      throw error;
    }
    try {
      const value = this.decodeResponse(serialized, request.id, request.operation);
      this.diagnostic('bridge.response', { operation, direction: 'main-to-content', status: 'ok' });
      return value;
    } catch (error) {
      logInvalidBridgePayload('同步响应', error);
      this.diagnostic('bridge.error', { operation, direction: 'main-to-content' }, error);
      throw error;
    }
  }

  callAsync(operation, args = []) {
    const request = this.createRequest(operation, args, 'async');
    this.diagnostic('bridge.request', { operation, direction: 'content-to-main' });
    return new Promise((resolve, reject) => {
      const timer = this.runtimeObject.setTimeout(() => {
        this.pending.delete(request.id);
        const error = new BufferScriptError('BRIDGE_RESPONSE_TIMEOUT', `桥接操作超时: ${operation}`);
        this.diagnostic('bridge.error', { operation, direction: 'main-to-content' }, error);
        reject(error);
      }, 15000);
      this.pending.set(request.id, { resolve, reject, timer, operation });
      try {
        this.dispatch(request);
      } catch (error) {
        this.runtimeObject.clearTimeout(timer);
        this.pending.delete(request.id);
        const wrapped = new BufferScriptError('BRIDGE_DISPATCH_FAILED', '桥接请求派发失败', error);
        this.diagnostic('bridge.error', { operation, direction: 'content-to-main' }, wrapped);
        reject(wrapped);
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
      const value = this.decodeResponse(serialized, response.id, pending.operation);
      this.diagnostic('bridge.response', {
        operation: pending.operation,
        direction: 'main-to-content',
        status: 'ok',
      });
      pending.resolve(value);
    } catch (error) {
      this.diagnostic('bridge.error', { operation: pending.operation, direction: 'main-to-content' }, error);
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
    this.stale = false;
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
      return this.client.callSync('callCoreSync', [this.coreId, method, args, this.snapshot.source]);
    } catch (error) {
      if (error?.code === 'BRIDGE_CORE_STALE') {
        this.markStale();
      }
      throw error;
    }
  }

  setStableBufferTime(seconds) {
    if (!this.supports('setStableBufferTime')) {
      fail('VOD_STABLE_BUFFER_UNAVAILABLE', '视频内核没有稳定缓存设置能力');
    }
    return this.callCoreSync('setStableBufferTime', [seconds]);
  }
}

export class LiveCapabilities {
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
      fail('LIVE_AUTO_CATCHUP_ALREADY_ATTEMPTED', '关闭自动追赶能力只能尝试一次');
    }
    this.used = true;
    return this.client.callAsync('disableLiveAutoCatchup', []);
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
  };
  const pageWindow = {
    location: windowObject.location,
    performance: windowObject.performance,
    player,
  };
  return {
    pageWindow,
    async refreshLiveCapabilities() {
      const snapshot = await client.callAsync('getLiveCapabilitySnapshot', []);
      return new LiveCapabilities(client, snapshot);
    },
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
