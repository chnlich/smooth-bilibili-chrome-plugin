import { BANK_CONFIG } from '../constants.js';
import { cacheKey, chunkIndex, rangeLength, selectEvictions } from './logic.js';

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

function requireChunks(chunks) {
  if (!(chunks instanceof Map)) throw new Error('媒体分片表必须是 Map');
  return chunks;
}

function requireStoredRecord(record, chunkBytes, cacheKeyValue) {
  if (record === undefined || record === null || typeof record !== 'object') {
    throw new Error(`媒体分片记录 ${cacheKeyValue} 无效`);
  }
  requireArrayBuffer(record.bytes);
  if (record.bytes.byteLength <= 0 || record.bytes.byteLength > chunkBytes) {
    throw new Error(`媒体分片记录 ${cacheKeyValue} 长度无效`);
  }
  if (!Number.isSafeInteger(record.totalSize) || record.totalSize < record.bytes.byteLength) {
    throw new Error(`媒体分片记录 ${cacheKeyValue} 总长度无效`);
  }
  if (!Number.isFinite(record.storedAt)) throw new Error(`媒体分片记录 ${cacheKeyValue} 时间无效`);
  return record;
}

function requireCompleteRecord(record, chunkBytes, chunkStart, cacheKeyValue) {
  requireStoredRecord(record, chunkBytes, cacheKeyValue);
  const expectedLength = Math.min(chunkBytes, record.totalSize - chunkStart);
  if (expectedLength <= 0 || record.bytes.byteLength !== expectedLength) {
    throw new Error(`媒体分片记录 ${cacheKeyValue} 不是完整分片`);
  }
  return record;
}

function cacheKeyParts(cacheKeyValue) {
  const separator = cacheKeyValue.lastIndexOf('#');
  if (separator <= 0) throw new Error(`媒体分片 cacheKey 无效: ${cacheKeyValue}`);
  const bankKeyValue = cacheKeyValue.slice(0, separator);
  const index = Number(cacheKeyValue.slice(separator + 1));
  chunkIndex(index);
  return { bankKey: bankKeyValue, chunkIndex: index };
}

function entriesFor(chunks, chunkBytes) {
  requireChunks(chunks);
  const entries = [];
  for (const [cacheKeyValue, record] of chunks) {
    const { bankKey: bankKeyValue, chunkIndex: index } = cacheKeyParts(cacheKeyValue);
    const start = index * chunkBytes;
    const stored = requireCompleteRecord(record, chunkBytes, start, cacheKeyValue);
    const end = start + stored.bytes.byteLength - 1;
    if (stored.totalSize <= end) throw new Error(`媒体分片记录 ${cacheKeyValue} 超出总长度`);
    entries.push({
      cacheKey: cacheKeyValue,
      bankKey: bankKeyValue,
      chunkIndex: index,
      start,
      end,
      byteLength: stored.bytes.byteLength,
      storedAt: stored.storedAt,
    });
  }
  return entries;
}

export function readMemoryRange(
  chunks,
  bankKeyValue,
  start,
  end,
  chunkBytes = BANK_CONFIG.chunkBytes,
) {
  requireChunks(chunks);
  requireRange(start, end);
  const bytes = new Uint8Array(rangeLength({ start, end }));
  let cursor = start;
  let totalSize;
  const firstIndex = chunkIndex(start, chunkBytes);
  const lastIndex = chunkIndex(end, chunkBytes);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const key = cacheKey(bankKeyValue, index);
    const record = chunks.get(key);
    if (record === undefined) return { hit: false, totalSize };
    const chunkStart = index * chunkBytes;
    requireCompleteRecord(record, chunkBytes, chunkStart, key);
    const chunkEnd = chunkStart + record.bytes.byteLength - 1;
    if (chunkStart > cursor || chunkEnd < cursor) return { hit: false, totalSize: record.totalSize };
    const copyStart = Math.max(cursor, chunkStart);
    const copyEnd = Math.min(end, chunkEnd);
    bytes.set(
      new Uint8Array(record.bytes).subarray(copyStart - chunkStart, copyEnd - chunkStart + 1),
      copyStart - start,
    );
    cursor = copyEnd + 1;
    totalSize = record.totalSize;
  }
  if (cursor <= end) return { hit: false, totalSize };
  return { hit: true, bytes: bytes.buffer, totalSize };
}

export function writeMemoryChunk({
  chunks,
  bankKey: bankKeyValue,
  start,
  end,
  totalSize,
  bytes,
  chunkBytes = BANK_CONFIG.chunkBytes,
  storedAt = Date.now(),
}) {
  requireChunks(chunks);
  requireRange(start, end);
  requireArrayBuffer(bytes);
  if (bytes.byteLength !== end - start + 1) throw new Error('媒体分片字节长度与区间不符');
  if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error('媒体分片总长度无效');
  const index = chunkIndex(start, chunkBytes);
  const expectedEnd = Math.min(totalSize - 1, (index + 1) * chunkBytes - 1);
  if (start !== index * chunkBytes || end !== expectedEnd) {
    throw new Error('媒体分片写入区间未按分片边界对齐');
  }
  if (bytes.byteLength < chunkBytes / 2) throw new Error('媒体分片写入区间过小');
  const key = cacheKey(bankKeyValue, index);
  const previous = chunks.get(key);
  const storedBytes = bytes.slice(0);
  const record = { bytes: storedBytes, totalSize, storedAt };
  requireCompleteRecord(record, chunkBytes, index * chunkBytes, key);
  chunks.set(key, record);
  return {
    cacheKey: key,
    bankKey: bankKeyValue,
    chunkIndex: index,
    bytes: storedBytes.byteLength,
    storedAt,
    previous,
  };
}

export function enforceMemoryLimit({
  chunks,
  maxBankBytes = BANK_CONFIG.maxBankBytes,
  chunkBytes = BANK_CONFIG.chunkBytes,
  currentByteByBank = {},
}) {
  requireChunks(chunks);
  if (!Number.isSafeInteger(maxBankBytes) || maxBankBytes < 0) throw new Error('内存上限无效');
  const candidates = entriesFor(chunks, chunkBytes);
  const selected = selectEvictions({
    entries: candidates,
    maxBankBytes,
    currentByteByBank,
  });
  for (const entry of selected.entries) {
    if (!chunks.delete(entry.cacheKey)) throw new Error(`媒体分片淘汰失败: ${entry.cacheKey}`);
  }
  return {
    entries: selected.entries,
    bytes: selected.bytes,
    reason: selected.entries.length === 0 ? undefined : 'limit',
  };
}

export function totalMemoryBytes(chunks, chunkBytes = BANK_CONFIG.chunkBytes) {
  return entriesFor(chunks, chunkBytes).reduce((total, entry) => total + entry.byteLength, 0);
}

export function clearMemory(chunks) {
  requireChunks(chunks);
  chunks.clear();
}
