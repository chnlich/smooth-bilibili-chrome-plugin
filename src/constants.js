export const VERSION = '1.0.0';

export const HLS_DEPENDENCY = Object.freeze({
  version: '1.5.17',
  integrity: 'sha512-iFmKfXPRVIW5PBZ3gzXSLz/IYtC6BMsIqmY/K42iuykOoUZTChDwR6KYhPcwj5HuE4hNJhZxNPD+ZdHLJvRv8A==',
});

export const EXTENSION_MANIFEST = Object.freeze({
  manifestVersion: 3,
  minimumChromeVersion: '120',
  matches: Object.freeze([
    'https://live.bilibili.com/*',
    'https://www.bilibili.com/video/*',
  ]),
  hostPermissions: Object.freeze([
    'https://api.live.bilibili.com/*',
    'https://*.bilivideo.com/*',
  ]),
});

export const EXTENSION_PREFERENCES = Object.freeze({
  liveEnabled: 'liveEnabled',
  vodEnabled: 'vodEnabled',
});

export const LIVE_STATE = Object.freeze({
  LIVE: 'LIVE',
  STALL: 'STALL',
  RECOVERING: 'RECOVERING',
  DELAYED: 'DELAYED',
  USER_PAUSED: 'USER_PAUSED',
  GAP_UNRECOVERABLE: 'GAP_UNRECOVERABLE',
});

export const LIVE_CONFIG = Object.freeze({
  recoveryWatermarkSeconds: 15,
  aggressiveBufferSeconds: 60,
  hideDanmakuAfterSeconds: 3,
  playbackRate: 1,
  segmentConcurrency: 3,
  requestTimeoutMilliseconds: 5000,
  retryBackoffMilliseconds: Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]),
  manifestRefreshMilliseconds: 1000,
  statusRefreshMilliseconds: 500,
});

export const VOD_CONFIG = Object.freeze({
  qualityNumber: 64,
  playbackRate: 2,
  stableBufferSeconds: 180,
  startupBufferSeconds: 120,
  lowBufferSeconds: 30,
  quotaFallbackSeconds: Object.freeze([120, 90]),
  metricsWindowsSeconds: Object.freeze([30, 60]),
  qualityConfirmTimeoutMilliseconds: 5000,
  qualityConfirmPollMilliseconds: 100,
});
