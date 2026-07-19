export const BRIDGE_VERSION = 1;
export const BRIDGE_REQUEST_EVENT = 'bilibili-buffer:bridge-request-v1';
export const BRIDGE_RESPONSE_EVENT = 'bilibili-buffer:bridge-response-v1';
export const BRIDGE_EVENT_EVENT = 'bilibili-buffer:bridge-event-v1';
export const BRIDGE_RESPONSE_ATTRIBUTE = 'data-bilibili-buffer-bridge-response-v1';

export const BRIDGE_OPERATIONS = Object.freeze([
  'getCoreSnapshot',
  'callPlayer',
  'callCoreSync',
  'callCoreAsync',
  'subscribeCoreEvents',
  'unsubscribeCoreEvents',
]);

export const BRIDGE_PLAYER_METHODS = Object.freeze([
  'setAutoSyncProgressCfg',
  'setAutoDiscardFrameCfg',
  'pause',
  'requestQuality',
]);

export const BRIDGE_PLAYER_CAPABILITIES = Object.freeze([...BRIDGE_PLAYER_METHODS]);

export const BRIDGE_CORE_SYNC_METHODS = Object.freeze([
  'getQuality',
  'getCurrentQuality',
  'getCurrentQn',
  'getSupportedQualityList',
  'getQualityList',
  'getBufferedRanges',
  'getMediaInfo',
  'getCurrentMediaInfo',
  'getQualityInfo',
  'getStableBufferTime',
  'getStableBufferSeconds',
  'setStableBufferTime',
  'setScheduleWhilePaused',
]);

export const BRIDGE_CORE_ASYNC_METHODS = Object.freeze(['requestQuality']);

export const BRIDGE_CORE_EVENTS = Object.freeze(['error']);

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
  return {
    code: typeof error?.code === 'string' ? error.code : 'BRIDGE_CALL_FAILED',
    message: error?.message || String(error),
  };
}
