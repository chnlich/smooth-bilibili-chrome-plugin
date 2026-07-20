import { DIAGNOSTIC_MESSAGE_VERSION } from './catalog.js';
import { EVENT_INDEX, EVENT_STORE, SESSION_STORE, openLogDatabase } from './idb.js';
import { normalizeEventForStorage } from './privacy.js';
import { sessionWithTabId, validateSession } from './session.js';
import { serializeError } from '../extension/bridge-contract.js';

const BATCH_TYPE = 'diagnostic:events';
const READ_TYPES = new Set([
  'logs:max-event-id',
  'logs:sessions-page',
  'logs:events-page',
]);

function storageError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function withoutEventId(event) {
  const copy = { ...event };
  if (Object.prototype.hasOwnProperty.call(copy, 'eventId')) {
    throw storageError('EVENT_ID_FORBIDDEN', '页面不得自报 eventId');
  }
  return copy;
}

function comparableEvent(event) {
  const { eventId: _ignoredEventId, ...copy } = event;
  return copy;
}

function senderUrl(sender) {
  if (typeof sender?.url !== 'string' || sender.url.length === 0) {
    throw storageError('SENDER_URL_MISSING', '日志 sender URL 不可用');
  }
  return new URL(sender.url);
}

function assertSenderMatchesSession(session, sender) {
  const pageUrl = senderUrl(sender);
  if (pageUrl.origin !== session.origin || pageUrl.pathname !== session.pathname) {
    throw storageError('SESSION_ROUTE_CONFLICT', 'sender URL 与 session origin/pathname 不一致');
  }
}

function validateBatchMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw storageError('MESSAGE_INVALID', '日志消息必须是对象');
  }
  const keys = Object.keys(message).sort().join(',');
  if (keys !== 'events,session,type,version') {
    throw storageError('MESSAGE_INVALID', '日志消息字段未允许');
  }
  if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || message.type !== BATCH_TYPE) {
    throw storageError('MESSAGE_INVALID', '日志消息版本或类型不支持');
  }
  if (!Array.isArray(message.events) || message.events.length === 0) {
    throw storageError('MESSAGE_INVALID', '日志批次不能为空');
  }
  return message;
}

async function appendBatch(message, sender, indexedDbObject) {
  validateBatchMessage(message);
  const pageSession = validateSession(message.session, { requireTabId: false });
  if (Object.prototype.hasOwnProperty.call(pageSession, 'tabId')) {
    throw storageError('TAB_ID_FORBIDDEN', 'content page 不得自报 tabId');
  }
  const session = sessionWithTabId(pageSession, sender?.tab?.id);
  assertSenderMatchesSession(session, sender);
  const normalizedEvents = message.events.map((event) => {
    const normalized = normalizeEventForStorage(withoutEventId(event));
    if (normalized.sessionId !== session.sessionId) {
      throw storageError('SESSION_EVENT_CONFLICT', 'event sessionId 与批次不一致');
    }
    return normalized;
  });
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE, EVENT_STORE], 'readwrite');
    const sessions = transaction.objectStore(SESSION_STORE);
    const events = transaction.objectStore(EVENT_STORE);
    const sessionRequest = sessions.get(session.sessionId);
    const eventStatuses = [];
    let transactionFailure;
    let settled = false;
    const abortWith = (error) => {
      transactionFailure = error;
      if (!settled) transaction.abort();
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(value);
    };
    sessionRequest.onerror = () => {
      abortWith(storageError('IDB_SESSION_READ_FAILED', '读取日志 session 失败', sessionRequest.error));
    };
    sessionRequest.onsuccess = () => {
      try {
        const existingSession = sessionRequest.result;
        if (existingSession !== undefined && stableStringify(existingSession) !== stableStringify(session)) {
          throw storageError('SESSION_CONFLICT', '相同 sessionId 的 session 身份不一致');
        }
        if (existingSession === undefined) {
          sessions.add(session);
        }
        const index = events.index(EVENT_INDEX);
        const maxRequest = index.openCursor(
          IDBKeyRange.bound([session.sessionId, 0], [session.sessionId, Number.MAX_SAFE_INTEGER]),
          'prev',
        );
        maxRequest.onerror = () => abortWith(storageError('IDB_EVENT_READ_FAILED', '读取日志 sequence 失败', maxRequest.error));
        maxRequest.onsuccess = () => {
          const existingMax = maxRequest.result?.value?.sequence || 0;
          let expectedNext = existingMax + 1;
          const processEvent = (eventIndex) => {
            if (eventIndex >= normalizedEvents.length) return;
            const event = normalizedEvents[eventIndex];
            const request = index.get([event.sessionId, event.sequence]);
            request.onerror = () => abortWith(storageError('IDB_EVENT_READ_FAILED', '读取日志 event 失败', request.error));
            request.onsuccess = () => {
              try {
                const existing = request.result;
                if (existing !== undefined) {
                  if (stableStringify(comparableEvent(existing)) !== stableStringify(event)) {
                    throw storageError('SEQUENCE_CONFLICT', `sequence ${event.sequence} 内容冲突`);
                  }
                  eventStatuses.push({ sequence: event.sequence, status: 'DUPLICATE' });
                  processEvent(eventIndex + 1);
                  return;
                }
                if (event.sequence !== expectedNext) {
                  throw storageError('SEQUENCE_CONFLICT', `sequence ${event.sequence} 不连续，期望 ${expectedNext}`);
                }
                const addRequest = events.add(event);
                addRequest.onerror = () => abortWith(storageError('IDB_EVENT_WRITE_FAILED', '写入日志 event 失败', addRequest.error));
                addRequest.onsuccess = () => {
                  eventStatuses.push({ sequence: event.sequence, status: 'PERSISTED' });
                  expectedNext += 1;
                  processEvent(eventIndex + 1);
                };
              } catch (error) {
                abortWith(error);
              }
            };
          };
          processEvent(0);
        };
      } catch (error) {
        abortWith(error);
      }
    };
    transaction.oncomplete = () => {
      const hasNew = eventStatuses.some((status) => status.status === 'PERSISTED');
      finishResolve({
        status: hasNew ? 'PERSISTED' : 'DUPLICATE',
        statuses: eventStatuses,
        eventCount: normalizedEvents.length,
      });
    };
    transaction.onabort = () => {
      finishReject(transactionFailure || storageError('IDB_TRANSACTION_FAILED', '日志事务未提交', transaction.error));
    };
    transaction.onerror = () => {
      transactionFailure = transaction.error || storageError('IDB_TRANSACTION_FAILED', '日志事务失败');
    };
  });
}

function validateReadMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw storageError('MESSAGE_INVALID', '日志读取消息必须是对象');
  }
  if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || !READ_TYPES.has(message.type)) {
    throw storageError('MESSAGE_INVALID', '日志读取消息版本或类型不支持');
  }
  const allowed = {
    'logs:max-event-id': ['type', 'version', 'sessionId'],
    'logs:sessions-page': ['type', 'version', 'limit', 'afterSessionId', 'sessionId'],
    'logs:events-page': ['type', 'version', 'limit', 'afterEventId', 'maxEventId', 'sessionId'],
  }[message.type];
  if (Object.keys(message).some((field) => !allowed.includes(field))) {
    throw storageError('MESSAGE_INVALID', '日志读取消息包含未允许字段');
  }
  for (const field of ['sessionId', 'afterSessionId']) {
    if (message[field] !== undefined && (typeof message[field] !== 'string' || message[field].length === 0)) {
      throw storageError('MESSAGE_INVALID', `${field} 无效`);
    }
  }
  return message;
}

function positiveLimit(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 250) {
    throw storageError('READ_LIMIT_INVALID', '日志分页 limit 必须是 1 到 250');
  }
  return value;
}

async function readMaxEventId(message, indexedDbObject) {
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const store = transaction.objectStore(EVENT_STORE);
    const request = store.openCursor(null, 'prev');
    request.onerror = () => reject(request.error || new Error('读取最大 eventId 失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({ maxEventId: 0 });
        return;
      }
      if (message.sessionId === undefined || cursor.value.sessionId === message.sessionId) {
        resolve({ maxEventId: cursor.key });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取最大 eventId 事务失败'));
  });
}

async function readSessionsPage(message, indexedDbObject) {
  const limit = positiveLimit(message.limit);
  const after = message.afterSessionId === undefined ? undefined : String(message.afterSessionId);
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const store = transaction.objectStore(SESSION_STORE);
    const request = message.sessionId !== undefined
      ? store.get(message.sessionId)
      : store.openCursor(after === undefined ? null : IDBKeyRange.lowerBound(after, true));
    const sessions = [];
    request.onerror = () => reject(request.error || new Error('读取 session 分页失败'));
    request.onsuccess = () => {
      if (message.sessionId !== undefined) {
        if (request.result !== undefined) sessions.push(request.result);
        resolve({ sessions, hasMore: false });
        return;
      }
      const cursor = request.result;
      if (cursor === null || sessions.length >= limit) {
        resolve({ sessions, hasMore: cursor !== null });
        return;
      }
      sessions.push(cursor.value);
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 session 分页事务失败'));
  });
}

async function readEventsPage(message, indexedDbObject) {
  const limit = positiveLimit(message.limit);
  if (!Number.isInteger(message.maxEventId) || message.maxEventId < 0) {
    throw storageError('MAX_EVENT_ID_INVALID', 'maxEventId 无效');
  }
  if (!Number.isInteger(message.afterEventId) || message.afterEventId < 0) {
    throw storageError('AFTER_EVENT_ID_INVALID', 'afterEventId 无效');
  }
  if (message.maxEventId <= message.afterEventId) {
    return { events: [], hasMore: false, nextAfterEventId: message.afterEventId };
  }
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const range = IDBKeyRange.bound(message.afterEventId + 1, message.maxEventId);
    const request = transaction.objectStore(EVENT_STORE).openCursor(range);
    const events = [];
    let lastScannedEventId = message.afterEventId;
    request.onerror = () => reject(request.error || new Error('读取 event 分页失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || events.length >= limit) {
        resolve({ events, hasMore: cursor !== null, nextAfterEventId: lastScannedEventId });
        return;
      }
      lastScannedEventId = cursor.key;
      if (message.sessionId === undefined || cursor.value.sessionId === message.sessionId) {
        events.push(cursor.value);
      }
      if (events.length >= limit) {
        resolve({ events, hasMore: true, nextAfterEventId: lastScannedEventId });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 event 分页事务失败'));
  });
}

async function readLogs(message, indexedDbObject) {
  validateReadMessage(message);
  if (message.type === 'logs:max-event-id') return readMaxEventId(message, indexedDbObject);
  if (message.type === 'logs:sessions-page') return readSessionsPage(message, indexedDbObject);
  return readEventsPage(message, indexedDbObject);
}

async function handleMessage(message, sender, indexedDbObject = globalThis.indexedDB) {
  if (message?.type === BATCH_TYPE) {
    try {
      return await appendBatch(message, sender, indexedDbObject);
    } catch (error) {
      const status = ['SESSION_CONFLICT', 'SEQUENCE_CONFLICT', 'SESSION_EVENT_CONFLICT'].includes(error?.code)
        ? error.code
        : 'DEGRADED';
      return { status, error: serializeError(error), eventCount: message.events?.length || 0 };
    }
  }
  if (READ_TYPES.has(message?.type)) {
    return readLogs(message, indexedDbObject);
  }
  throw storageError('MESSAGE_OPERATION_DENIED', '日志消息操作未允许');
}

export { appendBatch, handleMessage, readLogs, stableStringify };

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender)
      .then((response) => sendResponse({ version: DIAGNOSTIC_MESSAGE_VERSION, ok: true, ...response }))
      .catch((error) => sendResponse({
        version: DIAGNOSTIC_MESSAGE_VERSION,
        ok: false,
        error: serializeError(error),
      }));
    return true;
  });
}
