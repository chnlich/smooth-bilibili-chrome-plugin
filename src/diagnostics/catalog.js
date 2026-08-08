import { DIAGNOSTIC_MESSAGE_VERSION } from '../constants.js';

export { DIAGNOSTIC_MESSAGE_VERSION };

export const MEDIA_EVENT_NAMES = Object.freeze([
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'progress',
  'seeking',
  'seeked',
  'ratechange',
  'volumechange',
  'durationchange',
  'resize',
  'suspend',
  'emptied',
  'abort',
  'error',
  'ended',
]);

export const EVENT_CODES = Object.freeze([
  'route.session_started',
  'route.changed',
  'route.unsupported',
  'route.no_video',
  'preference.read',
  'preference.changed',
  'preference.disabled',
  'video.attached',
  'video.replaced',
  'video.destroyed',
  'video.source_replaced',
  'video.visibility_changed',
  'video.core_replaced',
  'media.sample',
  'media.append',
  ...MEDIA_EVENT_NAMES.map((name) => `media.${name}`),
  'video.buffer_hint.attempt',
  'video.buffer_hint.applied',
  'video.buffer_hint.unsupported',
  'video.buffer_hint.failed',
  'video.buffer_observed',
  'bridge.error',
  'bank.fetch.chunk',
  'bank.serve',
  'bank.evict',
  'bank.store',
  'bank.disabled',
  'bank.inventory',
  'extension.started',
  'extension.boot_error',
  'extension.observer_error',
  'extension.destroyed',
  'log.persist.degraded',
]);

const EXACT_CODES = new Set(EVENT_CODES);
const PERSIST_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isSafePersistErrorCode(code) {
  return typeof code === 'string' && PERSIST_ERROR_CODE_PATTERN.test(code);
}

export function assertEventCode(code) {
  if (typeof code !== 'string' || !EXACT_CODES.has(code)) {
    throw new Error(`未允许的诊断事件代码: ${code}`);
  }
  return code;
}

export const DATA_ALLOWLIST = Object.freeze({
  route: Object.freeze([
    'routeKind',
    'origin',
    'pathname',
    'reason',
    'bvid',
    'part',
    'watchLaterItem',
  ]),
  preference: Object.freeze(['name', 'enabled']),
  video: Object.freeze([
    'videoInstance',
    'sourceInstance',
    'coreInstance',
    'source',
    'previousSource',
    'state',
    'previousState',
    'targetSeconds',
    'actualSeconds',
    'peakSeconds',
    'sampledSeconds',
    'samples',
    'reason',
  ]),
  media: Object.freeze([
    'eventType',
    'bufferedRanges',
    'seekableRanges',
    'currentTime',
    'duration',
    'paused',
    'ended',
    'readyState',
    'networkState',
    'resolution',
    'playbackRate',
    'source',
    'videoQuality',
    'sourceBufferRanges',
    'mediaSourceState',
    'appendErrors',
    'removeStats',
    'presented',
    'frameTiming',
    'mediaSourceInstance',
    'sourceBufferInstance',
    'appendSequence',
    'track',
    'bytes',
    'bufferedBefore',
    'bufferedAfter',
    'durationMs',
    'result',
    'errorName',
  ]),
  resource: Object.freeze([
    'name',
    'initiatorType',
    'startTime',
    'duration',
    'responseStart',
    'responseEnd',
    'transferSize',
    'encodedBodySize',
    'decodedBodySize',
  ]),
  bridge: Object.freeze(['operation', 'direction', 'status']),
  bank: Object.freeze([
    'source',
    'mirror',
    'operation',
    'chunkIndex',
    'start',
    'end',
    'bytes',
    'durationMs',
    'slot',
    'ttfbMs',
    'priority',
    'result',
    'reason',
    'sessionGeneration',
    'storedBytes',
    'storedChunks',
    'maxBankBytes',
    'queued',
    'inflight',
    'prefetchConcurrency',
    'disabled',
    'routeActive',
    'pairedAddressAvailable',
    'resources',
  ]),
  extension: Object.freeze(['action', 'reason', 'status']),
  persist: Object.freeze(['status', 'batchSize', 'eventCount', 'message', 'code']),
});

export function allowedDataFields(code) {
  if (code.startsWith('route.')) return DATA_ALLOWLIST.route;
  if (code.startsWith('preference.')) return DATA_ALLOWLIST.preference;
  if (code.startsWith('video.buffer_hint.') || code.startsWith('video.')) return DATA_ALLOWLIST.video;
  if (code.startsWith('media.')) return DATA_ALLOWLIST.media;
  if (code.startsWith('resource.')) return DATA_ALLOWLIST.resource;
  if (code.startsWith('bridge.')) return DATA_ALLOWLIST.bridge;
  if (code.startsWith('bank.')) return DATA_ALLOWLIST.bank;
  if (code.startsWith('extension.')) return DATA_ALLOWLIST.extension;
  if (code.startsWith('log.persist.')) return DATA_ALLOWLIST.persist;
  throw new Error(`诊断事件代码没有字段 allowlist: ${code}`);
}
