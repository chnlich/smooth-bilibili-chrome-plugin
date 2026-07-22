import { LIVE_CONFIG } from '../constants.js';
import { SHIM_OBSERVATION_ATTRIBUTE, SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE } from './bridge-contract.js';
import { computeRetentionAction } from '../live/buffer-retention.js';

const RETAIN_SECONDS = LIVE_CONFIG.liveRetainSeconds;
let installed = false;
let observationSequence = 0;
const stats = {
  removeCalls: 0,
  intercepted: 0,
  lastReason: null,
  lastCurrentTime: null,
  lastRemoveStart: null,
  lastRemoveEnd: null,
  lastOriginalEnd: null,
};

function findLiveVideoCurrentTime() {
  const videos = [...document.querySelectorAll('video')];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iframeDocument = iframe.contentDocument;
      if (iframeDocument !== null) {
        videos.push(...iframeDocument.querySelectorAll('video'));
      }
    } catch { /* cross-origin iframe */ }
  }
  let latest = undefined;
  for (const video of videos) {
    if (video !== null && Number.isFinite(video.currentTime) && video.currentTime > 0) {
      if (latest === undefined || video.currentTime > latest) latest = video.currentTime;
    }
  }
  return latest;
}

function dispatchObservation(detail) {
  try {
    observationSequence += 1;
    document.documentElement.setAttribute(
      SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE,
      String(observationSequence),
    );
    document.documentElement.setAttribute(
      SHIM_OBSERVATION_ATTRIBUTE,
      JSON.stringify(detail),
    );
  } catch { /* page tearing down */ }
}

if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === 'function') {
  const originalRemove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function smoothRemove(start, end) {
    stats.removeCalls += 1;
    const currentTime = findLiveVideoCurrentTime();
    const action = computeRetentionAction(currentTime, start, end, RETAIN_SECONDS);
    if (action === null) {
      return originalRemove.call(this, start, end);
    }
    stats.intercepted += 1;
    stats.lastCurrentTime = currentTime;
    stats.lastRemoveStart = start;
    stats.lastOriginalEnd = end;
    if (action.action === 'skipped') {
      stats.lastReason = 'skipped';
      stats.lastRemoveEnd = end;
      dispatchObservation({ reason: 'skipped', currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
      const buffer = this;
      setTimeout(() => {
        try { buffer.dispatchEvent(new Event('updateend')); } catch { /* tearing down */ }
      }, 0);
      return;
    }
    stats.lastReason = 'truncated';
    stats.lastRemoveEnd = action.adjustedEnd;
    dispatchObservation({ reason: 'truncated', targetTime: action.adjustedEnd, currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
    return originalRemove.call(this, start, action.adjustedEnd);
  };
  installed = true;
}

window.__smoothBufferShim = { retainSeconds: RETAIN_SECONDS, installed, stats };
