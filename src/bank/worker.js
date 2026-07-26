import { BANK_CONFIG } from '../constants.js';
import { BANK_MESSAGE_NAMESPACE, isBankMessage } from './contract.js';
import { enforceBankLimits, readBankRange, writeBankChunk } from './storage.js';

function validateRequestId(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error('媒体分片消息 requestId 无效');
  return value;
}

function validateBankKey(value) {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/')) {
    throw new Error('媒体分片 bankKey 无效');
  }
  return value;
}

function validateRange(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    throw new Error('媒体分片消息区间无效');
  }
}

function serializeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'BANK_STORAGE_FAILED',
    message: error?.message || String(error),
  };
}

export async function handleBankMessage(message, indexedDbObject) {
  if (!isBankMessage(message) || message.direction !== 'request' || !Number.isInteger(message.requestId)) return undefined;
  validateRequestId(message.requestId);
  if (message.type === 'read-range') {
    validateBankKey(message.bankKey);
    validateRange(message.start, message.end);
    return readBankRange({
      bankKey: message.bankKey,
      start: message.start,
      end: message.end,
      indexedDbObject,
    });
  }
  if (message.type === 'write-chunk') {
    validateBankKey(message.bankKey);
    validateRange(message.start, message.end);
    if (!(message.bytes instanceof ArrayBuffer)) throw new Error('媒体分片消息 bytes 必须是 ArrayBuffer');
    const result = await writeBankChunk({
      bankKey: message.bankKey,
      videoKey: message.videoKey,
      start: message.start,
      end: message.end,
      totalSize: message.totalSize,
      bytes: message.bytes,
      indexedDbObject,
    });
    const eviction = await enforceBankLimits({
      maxBankBytes: BANK_CONFIG.maxBankBytes,
      maxBankBytesPerVideo: BANK_CONFIG.maxBankBytesPerVideo,
      currentByteByBank: message.currentByteByBank || {},
      currentByteByVideo: message.currentByteByVideo || message.currentByteByBank || {},
      indexedDbObject,
    });
    return { ...result, ...eviction };
  }
  if (message.type === 'diagnostic' || message.type === 'configure') return undefined;
  throw new Error(`未处理的媒体分片消息: ${message.type}`);
}

export function installBankWorker(runtimeObject = globalThis.chrome?.runtime) {
  if (typeof runtimeObject?.onMessage?.addListener !== 'function') {
    throw new Error('媒体分片 worker runtime.onMessage 不可用');
  }
  runtimeObject.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isBankMessage(message) || message.direction !== 'request' || !Number.isInteger(message.requestId)) return false;
    void handleBankMessage(message)
      .then((value) => sendResponse({
        namespace: BANK_MESSAGE_NAMESPACE,
        type: message.type,
        requestId: message.requestId,
        ok: true,
        value,
      }))
      .catch((error) => sendResponse({
        namespace: BANK_MESSAGE_NAMESPACE,
        type: message.type,
        requestId: message.requestId,
        ok: false,
        error: serializeError(error),
      }));
    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  installBankWorker(chrome.runtime);
}
