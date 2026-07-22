export const VERSION = '1.0.0';

export const EXTENSION_MANIFEST = Object.freeze({
  manifestVersion: 3,
  minimumChromeVersion: '120',
  matches: Object.freeze([
    'https://live.bilibili.com/*',
    'https://www.bilibili.com/*',
  ]),
  hostPermissions: Object.freeze([]),
});

export const EXTENSION_PREFERENCES = Object.freeze({
  liveEnabled: 'liveEnabled',
  vodEnabled: 'vodEnabled',
});

export const VOD_CONFIG = Object.freeze({
  stableBufferSeconds: 120,
});

export const LIVE_CONFIG = Object.freeze({
  noDecodedFrameStallMilliseconds: 2000,
  userSeekAuthorizationMilliseconds: 1000,
  correctionToleranceSeconds: 2.5,
  statusRefreshMilliseconds: 500,
  delayUnavailableCheckMilliseconds: 5000,
  liveRetainSeconds: 30,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
