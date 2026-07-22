export const BRIDGE_VERSION = 1;
export const BRIDGE_REQUEST_EVENT = 'bilibili-buffer:bridge-request-v1';
export const BRIDGE_RESPONSE_EVENT = 'bilibili-buffer:bridge-response-v1';
export const BRIDGE_RESPONSE_ATTRIBUTE = 'data-bilibili-buffer-bridge-response-v1';
export const SHIM_OBSERVATION_ATTRIBUTE = 'data-bilibili-buffer-shim-observation';
export const SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE = 'data-bilibili-buffer-shim-seq';

export const BRIDGE_OPERATIONS = Object.freeze([
  'getCoreSnapshot',
  'callCoreSync',
  'getLiveCapabilitySnapshot',
  'disableLiveAutoCatchup',
]);

export const BRIDGE_LIVE_METHODS = Object.freeze([
  'setChasingFrameThreshold',
]);

// 探测证实真实 Bilibili 直播播放器的自动追赶关闭杠杆是 setChasingFrameThreshold，
// 它接受一个数值阈值（放大以容忍更大延迟、换取缓存）。
export const BRIDGE_LIVE_DISABLE_ARGS = Object.freeze({
  setChasingFrameThreshold: 600,
});

export const BRIDGE_CORE_SYNC_METHODS = Object.freeze(['setStableBufferTime']);

export function encodeMessage(message) {
  return JSON.stringify(message);
}

export function decodeMessage(serialized) {
  const message = JSON.parse(serialized);
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('bridge message must be an object');
  }
  if (message.version !== BRIDGE_VERSION) {
    throw new Error(`bridge version ${message.version} is not supported`);
  }
  if (!Number.isInteger(message.id) || message.id <= 0) {
    throw new Error('bridge message id must be a positive integer');
  }
  return message;
}

export function assertOperation(operation) {
  if (!BRIDGE_OPERATIONS.includes(operation)) {
    throw new Error(`bridge operation is not allowed: ${operation}`);
  }
  return operation;
}

export function serializeError(error) {
  const errorCode = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  };
  const seen = new WeakSet();
  let value = error;
  let serialized;
  if (value === undefined || value === null) {
    serialized = { message: '未知错误' };
  } else if (typeof value !== 'object' && typeof value !== 'function') {
    serialized = { name: typeof value, message: String(value) };
  } else {
    serialized = {};
    let current = serialized;
    for (;;) {
      if (seen.has(value)) {
        current.cause = '[Circular]';
        break;
      }
      seen.add(value);
      const name = typeof value.name === 'string' ? value.name : undefined;
      const code = errorCode(value.code);
      const message = typeof value.message === 'string' ? value.message : String(value);
      const stack = typeof value.stack === 'string' ? value.stack : undefined;
      if (name !== undefined) current.name = name;
      if (code !== undefined) current.code = code;
      current.message = message;
      if (stack !== undefined) current.stack = stack;
      const cause = value.cause;
      if (cause === undefined || cause === null) break;
      if (typeof cause !== 'object' && typeof cause !== 'function') {
        current.cause = { name: typeof cause, message: String(cause) };
        break;
      }
      if (seen.has(cause)) {
        current.cause = '[Circular]';
        break;
      }
      current.cause = {};
      current = current.cause;
      value = cause;
    }
  }
  return {
    name: serialized.name || 'Error',
    code: serialized.code || 'BRIDGE_CALL_FAILED',
    message: serialized.message,
    ...(serialized.stack === undefined ? {} : { stack: serialized.stack }),
    ...(serialized.cause === undefined ? {} : { cause: serialized.cause }),
  };
}
