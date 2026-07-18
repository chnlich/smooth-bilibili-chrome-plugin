import { VOD_CONFIG } from '../constants.js';

function isMediaEntry(entry) {
  const name = entry.name || '';
  return entry.initiatorType === 'video' || /\.(m4s|mp4|mpd)(?:[?#]|$)/i.test(name);
}

export function calculateDownloadMultiplier(
  performanceObject,
  nowMilliseconds,
  mediaBitrateBps,
  playbackRate = VOD_CONFIG.playbackRate,
) {
  const entries = performanceObject.getEntriesByType('resource').filter(isMediaEntry);
  const windows = {};
  for (const windowSeconds of VOD_CONFIG.metricsWindowsSeconds) {
    const lowerBound = nowMilliseconds - windowSeconds * 1000;
    const bytes = entries.reduce((sum, entry) => {
      const completedAt = entry.responseEnd || entry.startTime;
      return completedAt >= lowerBound && completedAt <= nowMilliseconds
        ? sum + (entry.transferSize || entry.encodedBodySize || 0)
        : sum;
    }, 0);
    const downloadBps = (bytes * 8) / windowSeconds;
    const consumeBps = mediaBitrateBps === undefined ? undefined : mediaBitrateBps * playbackRate;
    windows[windowSeconds] = {
      windowSeconds,
      bytes,
      downloadBps,
      consumeBps,
      multiplier: consumeBps === undefined ? undefined : downloadBps / consumeBps,
      message: consumeBps === undefined ? '内核未提供媒体码率，无法计算下载倍率' : undefined,
    };
  }
  return windows;
}
