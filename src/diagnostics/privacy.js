import { allowedDataFields, assertEventCode } from './catalog.js';

export const UNKNOWN_VALUE = '未提供';

const RESOURCE_FIELDS = Object.freeze([...allowedDataFields('resource.observed')]);
const MEDIA_RESOURCE_INITIATOR_TYPES = new Set(['audio', 'video']);

function finiteOrUnknown(value) {
  return Number.isFinite(value) ? value : UNKNOWN_VALUE;
}

export function browserMetric(value) {
  if (!Number.isFinite(value)) {
    return UNKNOWN_VALUE;
  }
  if (value === 0) {
    return { value: 0, reportedBy: 'browser' };
  }
  return value;
}

export function scrubUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return UNKNOWN_VALUE;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return UNKNOWN_VALUE;
  }
  return `${parsed.origin}${parsed.pathname}`;
}

function scrubOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return UNKNOWN_VALUE;
  try {
    return new URL(value).origin;
  } catch (error) {
    return UNKNOWN_VALUE;
  }
}

export function scrubPathname(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error('pathname 必须是绝对路径');
  }
  return value.split(/[?#]/, 1)[0];
}

function safeScalar(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNKNOWN_VALUE;
  return UNKNOWN_VALUE;
}

function scrubIdentifier(value) {
  if (typeof value !== 'string') return safeScalar(value);
  const identifier = value.split(/[?#]/, 1)[0];
  return identifier.length === 0 ? UNKNOWN_VALUE : identifier;
}

function scrubErrorText(value) {
  if (typeof value !== 'string') return UNKNOWN_VALUE;
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => scrubUrl(url));
}

function safeRangeList(value) {
  if (!Array.isArray(value)) return UNKNOWN_VALUE;
  return value.map((range) => {
    if (range === null || typeof range !== 'object' || Array.isArray(range)) {
      throw new Error('媒体 range 结构无效');
    }
    return {
      start: finiteOrUnknown(range.start),
      end: finiteOrUnknown(range.end),
    };
  });
}

function safeResolution(value) {
  if (value === UNKNOWN_VALUE) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN_VALUE;
  return {
    width: finiteOrUnknown(value.width),
    height: finiteOrUnknown(value.height),
  };
}

function sanitizeField(field, value) {
  if (field === 'origin') return scrubOrigin(value);
  if (field === 'pathname') {
    if (typeof value !== 'string' || !value.startsWith('/')) return UNKNOWN_VALUE;
    return scrubPathname(value);
  }
  if (['roomId', 'bvid', 'part', 'watchLaterItem'].includes(field)) return scrubIdentifier(value);
  if (field === 'source' || field === 'previousSource' || field === 'name') return scrubUrl(value);
  if (field === 'bufferedRanges' || field === 'seekableRanges') return safeRangeList(value);
  if (field === 'resolution') return safeResolution(value);
  if (
    field === 'transferSize' ||
    field === 'encodedBodySize' ||
    field === 'decodedBodySize' ||
    field === 'startTime' ||
    field === 'duration' ||
    field === 'responseStart' ||
    field === 'responseEnd'
  ) {
    return browserMetric(value);
  }
  if (field === 'enabled') return value === true || value === false ? value : UNKNOWN_VALUE;
  if (field === 'message') return scrubErrorText(value);
  return safeScalar(value);
}

export function sanitizeEventData(code, data = {}) {
  assertEventCode(code);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`诊断事件 data 必须是固定字段对象: ${code}`);
  }
  const fields = allowedDataFields(code);
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      result[field] = sanitizeField(field, data[field]);
    }
  }
  return result;
}

export function normalizeEventForStorage(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('诊断事件必须是对象');
  }
  const allowed = new Set([
    'sessionId',
    'sequence',
    'wallTime',
    'elapsedMs',
    'code',
    'videoInstance',
    'sourceInstance',
    'coreInstance',
    'data',
    'error',
  ]);
  for (const field of Object.keys(event)) {
    if (!allowed.has(field)) {
      throw new Error(`诊断事件字段未允许: ${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, 'eventId')) {
    throw new Error('页面不得自报 eventId');
  }
  if (typeof event.sessionId !== 'string' || !Number.isInteger(event.sequence) || event.sequence <= 0) {
    throw new Error('诊断事件缺少连续 session sequence');
  }
  if (typeof event.wallTime !== 'string' || !Number.isFinite(event.elapsedMs)) {
    throw new Error('诊断事件时间字段无效');
  }
  assertEventCode(event.code);
  const result = {
    sessionId: event.sessionId,
    sequence: event.sequence,
    wallTime: event.wallTime,
    elapsedMs: event.elapsedMs,
    code: event.code,
  };
  for (const field of ['videoInstance', 'sourceInstance', 'coreInstance']) {
    if (Object.prototype.hasOwnProperty.call(event, field)) {
      if (!Number.isInteger(event[field]) || event[field] <= 0) {
        throw new Error(`诊断事件 ${field} 无效`);
      }
      result[field] = event[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, 'data')) {
    const sanitizedData = sanitizeEventData(event.code, event.data);
    if (Object.keys(sanitizedData).length > 0) result.data = sanitizedData;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'error')) {
    result.error = sanitizeSerializedError(event.error);
  }
  return result;
}

function sanitizeSerializedError(error) {
  if (typeof error === 'string') return scrubErrorText(error);
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return UNKNOWN_VALUE;
  const seen = new WeakSet();
  let source = error;
  let result = {};
  const root = result;
  for (;;) {
    if (seen.has(source)) {
      result = '[Circular]';
      break;
    }
    seen.add(source);
    for (const field of ['name', 'code', 'message', 'stack']) {
      if (typeof source[field] === 'string') {
        result[field] = scrubErrorText(source[field]);
      } else if (field === 'code' && typeof source[field] === 'number' && Number.isFinite(source[field])) {
        result[field] = String(source[field]);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(source, 'cause')) break;
    const cause = source.cause;
    if (typeof cause === 'string') {
      result.cause = scrubErrorText(cause);
      break;
    }
    if (cause === null || typeof cause !== 'object' || Array.isArray(cause)) {
      result.cause = UNKNOWN_VALUE;
      break;
    }
    if (seen.has(cause)) {
      result.cause = '[Circular]';
      break;
    }
    const next = {};
    result.cause = next;
    result = next;
    source = cause;
  }
  return root;
}

export function resourceTimingFields(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error('PerformanceResourceTiming 条目无效');
  }
  const initiatorType = entry.initiatorType;
  const fields = {};
  for (const field of RESOURCE_FIELDS) {
    if (field === 'name' && !MEDIA_RESOURCE_INITIATOR_TYPES.has(initiatorType)) continue;
    fields[field] = field === 'initiatorType' ? initiatorType : entry[field];
  }
  return fields;
}

export function sanitizeResourceTiming(entry) {
  return sanitizeEventData('resource.observed', resourceTimingFields(entry));
}
