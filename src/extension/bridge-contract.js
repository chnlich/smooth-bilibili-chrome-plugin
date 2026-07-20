export const BRIDGE_VERSION = 1;
export const BRIDGE_REQUEST_EVENT = 'bilibili-buffer:bridge-request-v1';
export const BRIDGE_RESPONSE_EVENT = 'bilibili-buffer:bridge-response-v1';
export const BRIDGE_RESPONSE_ATTRIBUTE = 'data-bilibili-buffer-bridge-response-v1';

export const BRIDGE_OPERATIONS = Object.freeze([
  'getCoreSnapshot',
  'callCoreSync',
  'getLiveCapabilitySnapshot',
  'disableLiveAutoCatchup',
]);

export const BRIDGE_LIVE_METHODS = Object.freeze([
  'setAutoSyncProgressCfg',
  'setAutoDiscardFrameCfg',
]);

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
  const seen = new WeakSet();
  const serialize = (value, depth) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'object' && typeof value !== 'function') {
      return { name: typeof value, message: String(value) };
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    if (depth >= 8) {
      return '[CauseDepthLimit]';
    }
    seen.add(value);
    const result = {};
    const name = typeof value.name === 'string' ? value.name : undefined;
    const code = typeof value.code === 'string' ? value.code : undefined;
    const message = typeof value.message === 'string' ? value.message : String(value);
    const stack = typeof value.stack === 'string' ? value.stack : undefined;
    if (name !== undefined) result.name = name;
    if (code !== undefined) result.code = code;
    result.message = message;
    if (stack !== undefined) result.stack = stack;
    const cause = serialize(value.cause, depth + 1);
    if (cause !== undefined) result.cause = cause;
    return result;
  };
  const serialized = serialize(error, 0) || { message: '未知错误' };
  return {
    name: serialized.name || 'Error',
    code: serialized.code || 'BRIDGE_CALL_FAILED',
    message: serialized.message,
    ...(serialized.stack === undefined ? {} : { stack: serialized.stack }),
    ...(serialized.cause === undefined ? {} : { cause: serialized.cause }),
  };
}
