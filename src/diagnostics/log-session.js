const UNKNOWN_SESSION_ID = '未提供';

export function logSessionFragment(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === UNKNOWN_SESSION_ID) return '';
  return `#sessionId=${encodeURIComponent(sessionId)}`;
}

export function sessionIdFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#')) return undefined;
  const sessionId = new URLSearchParams(hash.slice(1)).get('sessionId');
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId !== UNKNOWN_SESSION_ID
    ? sessionId
    : undefined;
}
