import { LIVE_CONFIG } from '../constants.js';
import {
  SHIM_DIAGNOSTIC_ATTRIBUTE,
  SHIM_OBSERVATION_ATTRIBUTE,
  SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE,
} from './bridge-contract.js';
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
const sourceBufferTracks = new WeakMap();
const appendErrors = Object.create(null);
let activeSource;

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
    const seq = String(observationSequence);
    const payload = JSON.stringify(detail);
    const target = (window !== window.top && window.parent !== window)
      ? (window.parent?.document?.documentElement ?? document.documentElement)
      : document.documentElement;
    if (target !== null) {
      target.setAttribute(SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE, seq);
      target.setAttribute(SHIM_OBSERVATION_ATTRIBUTE, payload);
    }
  } catch { /* page tearing down or cross-origin parent */ }
}

function readSourceBufferRanges(sourceBuffer) {
  const ranges = [];
  try {
    for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
      ranges.push({ start: sourceBuffer.buffered.start(index), end: sourceBuffer.buffered.end(index) });
    }
  } catch (error) {
    console.error('[BilibiliBuffer] source buffer diagnostic read failed', error);
  }
  return ranges;
}

function dispatchDiagnostics() {
  try {
    const sourceBufferRanges = [];
    if (activeSource !== undefined) {
      for (let index = 0; index < activeSource.sourceBuffers.length; index += 1) {
        const sourceBuffer = activeSource.sourceBuffers[index];
        sourceBufferRanges.push({
          track: sourceBufferTracks.get(sourceBuffer) || 'unknown',
          ranges: readSourceBufferRanges(sourceBuffer),
        });
      }
    }
    document.documentElement.setAttribute(SHIM_DIAGNOSTIC_ATTRIBUTE, JSON.stringify({
      sourceBufferRanges,
      mediaSourceState: activeSource?.readyState || null,
      appendErrors: { ...appendErrors },
      removeStats: {
        removeCalls: stats.removeCalls,
        intercepted: stats.intercepted,
      },
    }));
  } catch (error) {
    console.error('[BilibiliBuffer] source buffer diagnostic dispatch failed', error);
  }
}

const mediaSourceConstructor = globalThis['Media' + 'Source'];
if (mediaSourceConstructor !== undefined && typeof mediaSourceConstructor.prototype?.addSourceBuffer === 'function') {
  const originalAddSourceBuffer = mediaSourceConstructor.prototype.addSourceBuffer;
  mediaSourceConstructor.prototype.addSourceBuffer = function smoothAddSourceBuffer(mimeType) {
    const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
    activeSource = this;
    sourceBufferTracks.set(sourceBuffer, String(mimeType).split(';', 1)[0]);
    sourceBuffer.addEventListener('updateend', dispatchDiagnostics);
    for (const eventName of ['sourceopen', 'sourceended', 'sourceclose']) {
      this.addEventListener(eventName, dispatchDiagnostics);
    }
    dispatchDiagnostics();
    return sourceBuffer;
  };
}

if (typeof SourceBuffer !== 'undefined' && typeof SourceBuffer.prototype?.appendBuffer === 'function') {
  const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function smoothAppendBuffer(...args) {
    try {
      return originalAppendBuffer.call(this, ...args);
    } catch (error) {
      const name = typeof error?.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
      appendErrors[name] = (appendErrors[name] || 0) + 1;
      dispatchDiagnostics();
      throw error;
    }
  };
}

if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === 'function') {
  const originalRemove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function smoothRemove(start, end) {
    stats.removeCalls += 1;
    dispatchDiagnostics();
    const currentTime = findLiveVideoCurrentTime();
    const action = computeRetentionAction(currentTime, start, end, RETAIN_SECONDS);
    if (action === null) {
      return originalRemove.call(this, start, end);
    }
    stats.intercepted += 1;
    stats.lastCurrentTime = currentTime;
    stats.lastRemoveStart = start;
    stats.lastOriginalEnd = end;
    dispatchDiagnostics();
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
    dispatchDiagnostics();
    dispatchObservation({ reason: 'truncated', targetTime: action.adjustedEnd, currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
    return originalRemove.call(this, start, action.adjustedEnd);
  };
  installed = true;
}

window.__smoothBufferShim = { retainSeconds: RETAIN_SECONDS, installed, stats };
dispatchDiagnostics();
