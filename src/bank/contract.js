export const BANK_ENABLED_ATTRIBUTE = 'data-bilibili-buffer-bank-enabled';
export const BANK_MESSAGE_NAMESPACE = 'bilibili-buffer:segment-bank-v1';

export const BANK_DIAGNOSTIC_MESSAGE_TYPE = 'diagnostic';

export function isBankDiagnosticMessage(message) {
  return message !== null
    && typeof message === 'object'
    && !Array.isArray(message)
    && message.namespace === BANK_MESSAGE_NAMESPACE
    && message.direction === 'event'
    && message.type === BANK_DIAGNOSTIC_MESSAGE_TYPE
    && typeof message.code === 'string';
}

export function postBankControl(windowObject, enabled) {
  const root = windowObject?.document?.documentElement;
  if (root === undefined || root === null || typeof root.setAttribute !== 'function') return;
  root.setAttribute(BANK_ENABLED_ATTRIBUTE, enabled === true ? 'true' : 'false');
}
