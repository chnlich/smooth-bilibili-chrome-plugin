const DATABASE_NAME = 'bilibili-development-logs';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const EVENT_STORE = 'events';
const EVENT_INDEX = 'sessionSequence';

export function openLogDatabase(indexedDbObject = globalThis.indexedDB) {
  if (indexedDbObject === undefined || typeof indexedDbObject.open !== 'function') {
    throw new Error('IndexedDB 不可用');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDbObject.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error || new Error('打开日志数据库失败'));
    request.onupgradeneeded = () => {
      const database = request.result;
      const sessions = database.objectStoreNames.contains(SESSION_STORE)
        ? request.transaction.objectStore(SESSION_STORE)
        : database.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
      if (!database.objectStoreNames.contains(EVENT_STORE)) {
        const events = database.createObjectStore(EVENT_STORE, { keyPath: 'eventId', autoIncrement: true });
        events.createIndex(EVENT_INDEX, ['sessionId', 'sequence'], { unique: true });
      }
      if (!sessions) throw new Error('sessions store 创建失败');
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

export function logStoreNames() {
  return { DATABASE_NAME, DATABASE_VERSION, SESSION_STORE, EVENT_STORE, EVENT_INDEX };
}

export { DATABASE_NAME, DATABASE_VERSION, SESSION_STORE, EVENT_STORE, EVENT_INDEX };
