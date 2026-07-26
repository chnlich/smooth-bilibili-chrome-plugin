import { BANK_CONFIG } from '../constants.js';
import { cacheKey, chunkIndex, selectEvictions } from './logic.js';

export const BANK_DATABASE_NAME = 'bilibili-media-segment-bank';
export const BANK_DATABASE_VERSION = 1;
export const BANK_CHUNK_STORE = 'chunks';

function requireArrayBuffer(value) {
  if (!(value instanceof ArrayBuffer)) throw new Error('分片字节必须是 ArrayBuffer');
  return value;
}

function requireRange(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    throw new Error('分片区间无效');
  }
  return { start, end };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('媒体分片 IndexedDB 请求失败'));
  });
}

export function openBankDatabase(indexedDbObject = globalThis.indexedDB) {
  if (indexedDbObject === undefined || typeof indexedDbObject.open !== 'function') {
    throw new Error('媒体分片 IndexedDB 不可用');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDbObject.open(BANK_DATABASE_NAME, BANK_DATABASE_VERSION);
    request.onerror = () => reject(request.error || new Error('打开媒体分片数据库失败'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BANK_CHUNK_STORE)) {
        const chunks = database.createObjectStore(BANK_CHUNK_STORE, { keyPath: 'cacheKey' });
        chunks.createIndex('bankKey', 'bankKey', { unique: false });
        chunks.createIndex('storedAt', 'storedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function recordSegments(record) {
  if (record === undefined) return [];
  if (!Array.isArray(record.segments)) throw new Error('媒体分片存储记录缺少 segments');
  return record.segments.map((segment) => {
    const range = requireRange(segment.start, segment.end);
    const bytes = requireArrayBuffer(segment.bytes);
    if (bytes.byteLength !== range.end - range.start + 1) throw new Error('媒体分片存储记录长度不符');
    return { ...range, bytes };
  });
}

function mergeSegments(existing, next) {
  const all = [...existing, next].sort((left, right) => left.start - right.start);
  const merged = [];
  for (const segment of all) {
    const previous = merged.at(-1);
    if (previous === undefined || segment.start > previous.end + 1) {
      merged.push(segment);
      continue;
    }
    const start = previous.start;
    const end = Math.max(previous.end, segment.end);
    const bytes = new Uint8Array(end - start + 1);
    bytes.set(new Uint8Array(previous.bytes), previous.start - start);
    bytes.set(new Uint8Array(segment.bytes), segment.start - start);
    merged[merged.length - 1] = { start, end, bytes: bytes.buffer };
  }
  return merged;
}

function copySegments(segments, start, end) {
  const sorted = [...segments].sort((left, right) => left.start - right.start);
  const output = new Uint8Array(end - start + 1);
  let cursor = start;
  for (const segment of sorted) {
    if (segment.end < cursor) continue;
    if (segment.start > cursor) return undefined;
    const copyStart = Math.max(cursor, segment.start);
    const copyEnd = Math.min(end, segment.end);
    output.set(
      new Uint8Array(segment.bytes).subarray(copyStart - segment.start, copyEnd - segment.start + 1),
      copyStart - start,
    );
    cursor = copyEnd + 1;
    if (cursor > end) return output.buffer;
  }
  return undefined;
}

async function readAllRecords(database) {
  const transaction = database.transaction(BANK_CHUNK_STORE, 'readonly');
  const request = transaction.objectStore(BANK_CHUNK_STORE).getAll();
  const records = await requestResult(request);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('读取媒体分片事务失败'));
  });
  return records;
}

async function readRangeRecords(database, bankKeyValue, start, end) {
  const transaction = database.transaction(BANK_CHUNK_STORE, 'readonly');
  const store = transaction.objectStore(BANK_CHUNK_STORE);
  const firstIndex = Math.max(0, chunkIndex(start) - 1);
  const lastIndex = chunkIndex(end);
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('读取媒体分片事务中止'));
    transaction.onerror = () => reject(transaction.error || new Error('读取媒体分片事务失败'));
  });
  const requests = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    requests.push(requestResult(store.get(cacheKey(bankKeyValue, index))));
  }
  const [records] = await Promise.all([Promise.all(requests), completion]);
  return records.filter((record) => record !== undefined);
}

export async function readBankRange({
  bankKey: bankKeyValue,
  start,
  end,
  indexedDbObject = globalThis.indexedDB,
}) {
  requireRange(start, end);
  const database = await openBankDatabase(indexedDbObject);
  try {
    const records = await readRangeRecords(database, bankKeyValue, start, end);
    const totalSize = records.find((record) => Number.isSafeInteger(record.totalSize))?.totalSize;
    const segments = records.flatMap((record) => recordSegments(record));
    const bytes = copySegments(segments, start, end);
    if (bytes === undefined) return { hit: false, totalSize };
    return { hit: true, bytes, totalSize };
  } finally {
    database.close();
  }
}

export async function writeBankChunk({
  bankKey: bankKeyValue,
  videoKey,
  start,
  end,
  totalSize,
  bytes,
  indexedDbObject = globalThis.indexedDB,
  storedAt = Date.now(),
}) {
  requireRange(start, end);
  requireArrayBuffer(bytes);
  if (bytes.byteLength !== end - start + 1) throw new Error('媒体分片字节长度与区间不符');
  if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error('媒体分片总长度无效');
  const index = chunkIndex(start);
  const key = cacheKey(bankKeyValue, index);
  const database = await openBankDatabase(indexedDbObject);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(BANK_CHUNK_STORE, 'readwrite');
      const store = transaction.objectStore(BANK_CHUNK_STORE);
      const getRequest = store.get(key);
      getRequest.onerror = () => transaction.abort();
      getRequest.onsuccess = () => {
        const current = getRequest.result;
        const segments = mergeSegments(recordSegments(current), { start, end, bytes });
        store.put({
          cacheKey: key,
          bankKey: bankKeyValue,
          videoKey,
          chunkIndex: index,
          totalSize,
          storedAt,
          segments,
        });
      };
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('媒体分片写入事务中止'));
      transaction.onerror = () => reject(transaction.error || new Error('媒体分片写入事务失败'));
    });
    return { cacheKey: key, bankKey: bankKeyValue, chunkIndex: index, bytes: bytes.byteLength, storedAt };
  } finally {
    database.close();
  }
}

export async function enforceBankLimits({
  maxBankBytes = BANK_CONFIG.maxBankBytes,
  maxBankBytesPerVideo = BANK_CONFIG.maxBankBytesPerVideo,
  currentByteByBank = {},
  currentByteByVideo = currentByteByBank,
  indexedDbObject = globalThis.indexedDB,
}) {
  const database = await openBankDatabase(indexedDbObject);
  try {
    const records = await readAllRecords(database);
    const candidates = records.map((record) => ({
      ...record,
      byteLength: recordSegments(record).reduce((sum, segment) => sum + segment.bytes.byteLength, 0),
      start: Math.min(...recordSegments(record).map((segment) => segment.start)),
      end: Math.max(...recordSegments(record).map((segment) => segment.end)),
    }));
    const selected = selectEvictions({
      entries: candidates,
      maxBankBytes,
      maxBankBytesPerVideo,
      currentByteByBank,
      currentByteByVideo,
    });
    if (selected.entries.length === 0) return { evictedBytes: 0, reason: undefined, records: [] };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(BANK_CHUNK_STORE, 'readwrite');
      const store = transaction.objectStore(BANK_CHUNK_STORE);
      for (const record of selected.entries) store.delete(record.cacheKey);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('媒体分片淘汰事务中止'));
      transaction.onerror = () => reject(transaction.error || new Error('媒体分片淘汰事务失败'));
    });
    const initialTotal = candidates.reduce((sum, record) => sum + record.byteLength, 0);
    const initialPerVideo = new Map();
    for (const record of candidates) {
      const group = record.videoKey || record.bankKey;
      initialPerVideo.set(group, (initialPerVideo.get(group) || 0) + record.byteLength);
    }
    const reason = [...initialPerVideo.values()].some((value) => value > maxBankBytesPerVideo)
      ? 'video_limit'
      : initialTotal > maxBankBytes ? 'global_limit' : 'limit';
    return { evictedBytes: selected.bytes, reason, records: selected.entries };
  } finally {
    database.close();
  }
}

export function bankStoreNames() {
  return {
    BANK_DATABASE_NAME,
    BANK_DATABASE_VERSION,
    BANK_CHUNK_STORE,
  };
}
