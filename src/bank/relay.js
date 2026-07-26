import { BANK_ENABLED_ATTRIBUTE, BANK_MESSAGE_NAMESPACE, isBankMessage } from './contract.js';

function serializeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'BANK_RELAY_FAILED',
    message: error?.message || String(error),
  };
}

function runtimeRequest(runtimeObject, message) {
  if (runtimeObject === undefined || typeof runtimeObject.sendMessage !== 'function') {
    throw new Error('媒体分片 relay runtime.sendMessage 不可用');
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
        const lastError = runtimeObject.lastError || globalThis.chrome?.runtime?.lastError;
        if (lastError !== undefined) {
          finish(reject, new Error(lastError.message));
          return;
        }
        finish(resolve, response);
      });
      if (result !== undefined && typeof result.then === 'function') {
        result.then((response) => finish(resolve, response), (error) => finish(reject, error));
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

function postWindowMessage(windowObject, message, transfer = []) {
  windowObject.postMessage(message, '*', transfer);
}

export function postBankControl(windowObject, enabled) {
  const root = windowObject?.document?.documentElement;
  if (root === undefined || root === null || typeof root.setAttribute !== 'function') return;
  root.setAttribute(BANK_ENABLED_ATTRIBUTE, enabled === true ? 'true' : 'false');
}

export function installBankRelay({
  windowObject = window,
  runtimeObject = chrome.runtime,
  diagnostics,
} = {}) {
  let currentDiagnostics = diagnostics;
  const listener = (event) => {
    if (event.source !== windowObject || !isBankMessage(event.data)) return;
    const message = event.data;
    if (message.direction === 'event') {
      if (message.type !== 'diagnostic' || typeof message.code !== 'string') {
        throw new Error('媒体分片诊断消息格式无效');
      }
      currentDiagnostics?.log(message.code, message.data || {});
      return;
    }
    if (message.direction !== 'request') return;
    const response = async () => {
      try {
        const result = await runtimeRequest(runtimeObject, message);
        const value = result?.value;
        const transfer = value?.bytes instanceof ArrayBuffer ? [value.bytes] : [];
        postWindowMessage(windowObject, {
          namespace: BANK_MESSAGE_NAMESPACE,
          direction: 'response',
          type: message.type,
          requestId: message.requestId,
          ok: result?.ok === true,
          ...(result?.ok === true ? { value } : { error: result?.error || serializeError(new Error('媒体分片 worker 没有返回结果')) }),
        }, transfer);
      } catch (error) {
        postWindowMessage(windowObject, {
          namespace: BANK_MESSAGE_NAMESPACE,
          direction: 'response',
          type: message.type,
          requestId: message.requestId,
          ok: false,
          error: serializeError(error),
        });
      }
    };
    void response();
  };
  windowObject.addEventListener('message', listener);
  return {
    setDiagnostics(nextDiagnostics) {
      currentDiagnostics = nextDiagnostics;
    },
    destroy() {
      windowObject.removeEventListener('message', listener);
    },
  };
}
