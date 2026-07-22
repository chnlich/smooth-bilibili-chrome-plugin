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
  'timeupdate',
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
  'video.core_replaced',
  'video.no_video',
  'media.sample',
  ...MEDIA_EVENT_NAMES.map((name) => `media.${name}`),
  'resource.observed',
  'resource.observer_unavailable',
  'video.buffer_hint.attempt',
  'video.buffer_hint.applied',
  'video.buffer_hint.unsupported',
  'video.buffer_hint.failed',
  'video.buffer_observed',
  'live.stall.detected',
  'live.stall.recovered',
  'live.delay.observed',
  'live.delay.corrected',
  'live.delay.unavailable',
  'live.buffer.retained',
  'live.source_replaced',
  'live.delay_protection.capability',
  'live.delay_protection.applied',
  'live.delay_protection.unsupported',
  'live.delay_protection.failed',
  'live.delay_protection.cancelled',
  'bridge.request',
  'bridge.response',
  'bridge.error',
  'extension.started',
  'extension.boot_error',
  'extension.observer_error',
  'extension.destroyed',
  'log.persist.result',
  'log.persist.degraded',
]);

const EXACT_CODES = new Set(EVENT_CODES);

export function assertEventCode(code) {
  if (typeof code !== 'string' || !EXACT_CODES.has(code)) {
    throw new Error(`未允许的诊断事件代码: ${code}`);
  }
  return code;
}

export function isMediaEventCode(code) {
  return typeof code === 'string' && code.startsWith('media.');
}

export const DATA_ALLOWLIST = Object.freeze({
  route: Object.freeze([
    'routeKind',
    'origin',
    'pathname',
    'reason',
    'roomId',
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
    'estimatedDelay',
    'source',
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
  live: Object.freeze([
    'reason',
    'delayBeforeStall',
    'stallDuration',
    'targetDelay',
    'protectedDelay',
    'targetTime',
    'currentTime',
    'estimatedDelay',
    'previousSource',
    'source',
    'videoInstance',
    'sourceInstance',
    'capability',
    'status',
    'waitedSeconds',
    'retainSeconds',
    'originalEnd',
  ]),
  bridge: Object.freeze(['operation', 'direction', 'status']),
  extension: Object.freeze(['action', 'reason', 'status']),
  persist: Object.freeze(['status', 'batchSize', 'eventCount', 'message']),
});

export function allowedDataFields(code) {
  if (code.startsWith('route.')) return DATA_ALLOWLIST.route;
  if (code.startsWith('preference.')) return DATA_ALLOWLIST.preference;
  if (code.startsWith('video.buffer_hint.') || code.startsWith('video.')) return DATA_ALLOWLIST.video;
  if (code.startsWith('media.')) return DATA_ALLOWLIST.media;
  if (code.startsWith('resource.')) return DATA_ALLOWLIST.resource;
  if (code.startsWith('live.')) return DATA_ALLOWLIST.live;
  if (code.startsWith('bridge.')) return DATA_ALLOWLIST.bridge;
  if (code.startsWith('extension.')) return DATA_ALLOWLIST.extension;
  if (code.startsWith('log.persist.')) return DATA_ALLOWLIST.persist;
  throw new Error(`诊断事件代码没有字段 allowlist: ${code}`);
}
