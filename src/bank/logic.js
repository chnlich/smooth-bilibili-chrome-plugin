import { BANK_CONFIG } from '../constants.js';

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负整数`);
  }
  return value;
}

export function isVideoLocation(locationObject) {
  return locationObject.hostname === 'www.bilibili.com' && (
    locationObject.pathname.startsWith('/video/')
    || locationObject.pathname === '/list/watchlater'
    || locationObject.pathname.startsWith('/list/watchlater/')
  );
}

export function bankKey(url) {
  return new URL(url).pathname;
}

export function chunkIndex(byteOffset, chunkBytes = BANK_CONFIG.chunkBytes) {
  requireNonNegativeInteger(byteOffset, '字节偏移');
  requireNonNegativeInteger(chunkBytes, '分片大小');
  if (chunkBytes === 0) throw new Error('分片大小不能为零');
  return Math.floor(byteOffset / chunkBytes);
}

export function cacheKey(bankKeyValue, index) {
  if (typeof bankKeyValue !== 'string' || bankKeyValue.length === 0) {
    throw new Error('bankKey 必须是非空字符串');
  }
  requireNonNegativeInteger(index, '分片索引');
  return `${bankKeyValue}#${index}`;
}

export function headerValue(headers, name) {
  if (headers !== null && typeof headers?.get === 'function') return headers.get(name);
  if (Array.isArray(headers)) {
    const wanted = name.toLowerCase();
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
    }
  }
  if (headers !== null && typeof headers === 'object') {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return String(value);
    }
  }
  return null;
}

export function parseRangeHeader(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return undefined;
  return { start, end };
}

export function isMediaHost(hostname) {
  return hostname.endsWith('.bilivideo.com') || hostname.endsWith('.akamaized.net');
}

export function classifyRequest({ url, headers, enabled = true, locationObject }) {
  if (enabled !== true) return { intercepted: false, reason: 'disabled' };
  if (locationObject !== undefined && !isVideoLocation(locationObject)) {
    return { intercepted: false, reason: 'not_video_route' };
  }
  const parsed = new URL(url, locationObject?.href);
  if (!isMediaHost(parsed.hostname)) return { intercepted: false, reason: 'non_media_host' };
  const rawRange = headerValue(headers, 'Range');
  const range = parseRangeHeader(rawRange);
  if (range === undefined) {
    return { intercepted: false, reason: rawRange === null ? 'range_missing' : 'range_not_closed' };
  }
  return { intercepted: true, url: parsed.href, range };
}

export function rangeLength(range) {
  const length = range.end - range.start + 1;
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Range 长度无效');
  return length;
}

export function parseContentRange(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalSize = Number(match[3]);
  if (![start, end, totalSize].every(Number.isSafeInteger) || start > end || end >= totalSize) return undefined;
  return { start, end, totalSize };
}

export function partialResponseHeaders(start, end, totalSize) {
  const range = { start, end };
  const length = rangeLength(range);
  if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error('媒体总长度无效');
  return {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Content-Type': 'video/mp4',
  };
}

export function clipBytes(bytes, sourceStart, requestedStart, requestedEnd) {
  if (!(bytes instanceof ArrayBuffer)) throw new Error('分片字节必须是 ArrayBuffer');
  const sourceEnd = sourceStart + bytes.byteLength - 1;
  if (requestedStart < sourceStart || requestedEnd > sourceEnd) {
    throw new Error('分片字节不覆盖请求区间');
  }
  const offset = requestedStart - sourceStart;
  return bytes.slice(offset, offset + rangeLength({ start: requestedStart, end: requestedEnd }));
}

export function planFetchRanges(start, end, {
  chunkBytes = BANK_CONFIG.chunkBytes,
  totalSize,
  bankKeyValue = 'resource',
  aligned = false,
} = {}) {
  const request = { start, end };
  const length = rangeLength(request);
  if (aligned !== true || length < chunkBytes / 2 || totalSize === undefined) {
    return [{
      ...request,
      chunkIndex: chunkIndex(start, chunkBytes),
      cacheKey: cacheKey(bankKeyValue, chunkIndex(start, chunkBytes)),
    }];
  }
  const result = [];
  let current = Math.floor(start / chunkBytes) * chunkBytes;
  while (current <= end) {
    const chunkEnd = Math.min(end, current + chunkBytes - 1, totalSize - 1);
    if (chunkEnd >= current) {
      const index = chunkIndex(current, chunkBytes);
      result.push({
        start: current,
        end: chunkEnd,
        chunkIndex: index,
        cacheKey: cacheKey(bankKeyValue, index),
      });
    }
    current += chunkBytes;
  }
  return result;
}

export function compareQueueTasks(left, right) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.sequence - right.sequence;
}

export function insertQueueTask(queue, task) {
  queue.push(task);
  queue.sort(compareQueueTasks);
  return queue;
}

export function priorityFor(kind) {
  if (kind === 'foreground') return 0;
  if (kind === 'prefetch') return 1;
  throw new Error(`未知取数任务类型: ${kind}`);
}

export function estimateBitrate(samples) {
  if (!Array.isArray(samples)) throw new Error('码率样本必须是数组');
  let latest;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsed = current.time - previous.time;
    const bytes = current.bytes - previous.bytes;
    if (Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(bytes) && bytes > 0) {
      latest = bytes / elapsed;
    }
  }
  return latest || 0;
}

export function prefetchRange({ start, bitrate, aheadSeconds, totalSize }) {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isFinite(bitrate) || bitrate <= 0) return undefined;
  if (!Number.isFinite(aheadSeconds) || aheadSeconds <= 0) throw new Error('预取秒数无效');
  const rawEnd = start + Math.ceil(bitrate * aheadSeconds) - 1;
  const end = totalSize === undefined ? rawEnd : Math.min(rawEnd, totalSize - 1);
  if (end < start) return undefined;
  return { start, end };
}

function entryBytes(entry) {
  if (Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0) return entry.byteLength;
  if (entry.bytes instanceof ArrayBuffer) return entry.bytes.byteLength;
  if (Array.isArray(entry.segments)) return entry.segments.reduce((total, segment) => total + segment.bytes.byteLength, 0);
  throw new Error('淘汰条目缺少字节数');
}

function evictionGroup(entry) {
  return entry.videoKey || entry.bankKey;
}

function evictionRank(entry, currentByte) {
  const played = Number.isFinite(currentByte) && Number.isFinite(entry.end) && entry.end < currentByte;
  if (played) return [0, 0, entry.storedAt || 0];
  const distance = Number.isFinite(currentByte) && Number.isFinite(entry.start)
    ? Math.max(0, entry.start - currentByte)
    : Number.MAX_SAFE_INTEGER;
  return [1, -distance, entry.storedAt || 0];
}

function currentByteForEntry(entry, currentByteByBank, currentByteByVideo) {
  return currentByteByBank[entry.bankKey] ?? currentByteByVideo[evictionGroup(entry)];
}

function compareEvictionEntries(left, right, currentByteByBank, currentByteByVideo) {
  const leftRank = evictionRank(left, currentByteForEntry(left, currentByteByBank, currentByteByVideo));
  const rightRank = evictionRank(right, currentByteForEntry(right, currentByteByBank, currentByteByVideo));
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  return left.cacheKey.localeCompare(right.cacheKey);
}

export function selectEvictions({
  entries,
  maxBankBytes,
  maxBankBytesPerVideo,
  currentByteByBank = {},
  currentByteByVideo = currentByteByBank,
}) {
  if (!Array.isArray(entries)) throw new Error('淘汰条目必须是数组');
  const total = entries.reduce((sum, entry) => sum + entryBytes(entry), 0);
  const perVideo = new Map();
  for (const entry of entries) {
    const group = evictionGroup(entry);
    perVideo.set(group, (perVideo.get(group) || 0) + entryBytes(entry));
  }
  const selected = [];
  const remaining = [...entries];
  let currentTotal = total;
  const currentPerVideo = new Map(perVideo);
  while (currentTotal > maxBankBytes || [...currentPerVideo.values()].some((value) => value > maxBankBytesPerVideo)) {
    const overVideo = new Set([...currentPerVideo.entries()]
      .filter(([, value]) => value > maxBankBytesPerVideo)
      .map(([key]) => key));
    const candidates = remaining.filter((entry) => overVideo.size === 0 || overVideo.has(evictionGroup(entry)));
    if (candidates.length === 0) throw new Error('存储超限但没有可淘汰分片');
    candidates.sort((left, right) => compareEvictionEntries(left, right, currentByteByBank, currentByteByVideo));
    const victim = candidates[0];
    selected.push(victim);
    remaining.splice(remaining.indexOf(victim), 1);
    const bytes = entryBytes(victim);
    currentTotal -= bytes;
    const group = evictionGroup(victim);
    currentPerVideo.set(group, currentPerVideo.get(group) - bytes);
  }
  return { entries: selected, bytes: selected.reduce((sum, entry) => sum + entryBytes(entry), 0) };
}
