export const VERSION = '1.0.0';

export const EXTENSION_MANIFEST = Object.freeze({
  manifestVersion: 3,
  minimumChromeVersion: '120',
  matches: Object.freeze([
    'https://www.bilibili.com/*',
  ]),
  hostPermissions: Object.freeze([]),
});

export const EXTENSION_PREFERENCES = Object.freeze({
  vodEnabled: 'vodEnabled',
});

export const VOD_CONFIG = Object.freeze({
  stableBufferSeconds: 120,
});

export const BANK_CONFIG = Object.freeze({
  chunkBytes: 4 * 1024 ** 2,
  prefetchAheadSeconds: 900,
  maxBankBytes: 512 * 1024 ** 2,
  refetchAlarmCount: 3,
  foregroundDeadlineMs: 5000,
  prefetchDeadlineMs: 20000,
  latencyAlarmCount: 3,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
