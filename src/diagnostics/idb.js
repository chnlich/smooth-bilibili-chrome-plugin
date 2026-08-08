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
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: 'sessionId' });
      }
      if (!database.objectStoreNames.contains(EVENT_STORE)) {
        const events = database.createObjectStore(EVENT_STORE, { keyPath: 'eventId', autoIncrement: true });
        events.createIndex(EVENT_INDEX, ['sessionId', 'sequence'], { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export { SESSION_STORE, EVENT_STORE, EVENT_INDEX };
