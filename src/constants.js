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
  chunkBytes: 1024 ** 2,
  maxBankBytes: 512 * 1024 ** 2,
  stallMs: 10000,
  lookAheadChunks: 48,
  maxChunkAttempts: 3,
  raceLegs: 2,
  pairFreshnessMs: 3600000,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
