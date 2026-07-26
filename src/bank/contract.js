export const BANK_MESSAGE_NAMESPACE = 'bilibili-buffer:segment-bank-v1';

export const BANK_MESSAGE_TYPES = Object.freeze([
  'read-range',
  'write-chunk',
  'diagnostic',
  'configure',
]);

export function isBankMessage(message) {
  return message !== null
    && typeof message === 'object'
    && !Array.isArray(message)
    && message.namespace === BANK_MESSAGE_NAMESPACE
    && BANK_MESSAGE_TYPES.includes(message.type);
}
