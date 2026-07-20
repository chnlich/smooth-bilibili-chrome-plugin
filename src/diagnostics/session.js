import { VERSION } from '../constants.js';
import { readBuildId } from '../build-id.js';
import { scrubPathname } from './privacy.js';

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session ${field} 无效`);
  }
  return value;
}

function optionalString(value, field) {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

export function createSessionIdentity({
  locationObject,
  routeKind,
  runtimeObject = globalThis,
  now = new Date(),
  sessionId = globalThis.crypto?.randomUUID?.(),
  roomId,
  bvid,
  part,
  watchLaterItem,
}) {
  if (locationObject === undefined || typeof locationObject !== 'object') {
    throw new Error('session location 不可用');
  }
  const normalizedSessionId = requireString(sessionId, 'sessionId');
  const origin = new URL(requireString(locationObject.origin, 'origin')).origin;
  const pathname = scrubPathname(locationObject.pathname);
  const identity = {
    schemaVersion: 1,
    sessionId: normalizedSessionId,
    startedAt: now.toISOString(),
    extensionVersion: VERSION,
    buildId: readBuildId(runtimeObject),
    routeKind: requireString(routeKind, 'routeKind'),
    origin,
    pathname,
  };
  for (const [field, value] of Object.entries({ roomId, bvid, part, watchLaterItem })) {
    if (value !== undefined) {
      identity[field] = typeof value === 'string' ? value : String(value);
    }
  }
  return identity;
}

export function sessionWithTabId(identity, tabId) {
  if (Object.prototype.hasOwnProperty.call(identity, 'tabId')) {
    throw new Error('content page 不得提供 tabId');
  }
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('sender.tab.id 无效');
  }
  return { ...identity, tabId };
}

export const SESSION_FIELDS = Object.freeze([
  'schemaVersion',
  'sessionId',
  'startedAt',
  'extensionVersion',
  'buildId',
  'tabId',
  'routeKind',
  'origin',
  'pathname',
  'roomId',
  'bvid',
  'part',
  'watchLaterItem',
]);

export function validateSession(session, { requireTabId = true } = {}) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('session 必须是对象');
  }
  for (const field of Object.keys(session)) {
    if (!SESSION_FIELDS.includes(field)) {
      throw new Error(`session 字段未允许: ${field}`);
    }
  }
  for (const field of ['sessionId', 'startedAt', 'extensionVersion', 'buildId', 'routeKind', 'origin', 'pathname']) {
    requireString(session[field], field);
  }
  if (session.schemaVersion !== 1) throw new Error('session schemaVersion 不支持');
  if (new URL(session.origin).origin !== session.origin) throw new Error('session origin 必须是干净 origin');
  if (scrubPathname(session.pathname) !== session.pathname) throw new Error('session pathname 必须没有 query/hash');
  if (requireTabId && (!Number.isInteger(session.tabId) || session.tabId <= 0)) {
    throw new Error('session 缺少可信 tabId');
  }
  if (!requireTabId && Object.prototype.hasOwnProperty.call(session, 'tabId')) {
    throw new Error('页面 session 不得包含 tabId');
  }
  for (const field of ['roomId', 'bvid', 'part', 'watchLaterItem']) {
    optionalString(session[field], field);
    if (typeof session[field] === 'string' && /[?#]/.test(session[field])) {
      throw new Error(`session ${field} 必须没有 query/hash`);
    }
  }
  return session;
}

export function sessionIdentityWithoutTabId(session) {
  const { tabId: _ignoredTabId, ...copy } = session;
  return copy;
}
