import { SHIM_DIAGNOSTIC_ATTRIBUTE } from './bridge-contract.js';

let installed = false;
const stats = {
  removeCalls: 0,
};
const sourceBufferTracks = new WeakMap();
const appendStartedAt = new WeakMap();
const appendErrors = Object.create(null);
let appends = 0;
let lastAppendAt;
let updateEndMsMax;
let lastUpdateEndAt;
let activeSource;

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

function publishDiagnostics() {
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
      },
      appends,
      lastAppendAt: lastAppendAt ?? null,
      updateEndMsMax: updateEndMsMax ?? null,
      updateEndAt: lastUpdateEndAt ?? null,
    }));
    updateEndMsMax = undefined;
  } catch (error) {
    console.error('[BilibiliBuffer] source buffer diagnostic dispatch failed', error);
  }
}

const DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS = 1000;
let lastDiagnosticDispatchAt = Number.NEGATIVE_INFINITY;
let diagnosticTimer;

function dispatchDiagnostics() {
  if (diagnosticTimer !== undefined) {
    window.clearTimeout(diagnosticTimer);
    diagnosticTimer = undefined;
  }
  lastDiagnosticDispatchAt = window.performance.now();
  publishDiagnostics();
}

function dispatchUpdateEndDiagnostics() {
  const now = window.performance.now();
  const elapsed = now - lastDiagnosticDispatchAt;
  if (elapsed >= DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS) {
    dispatchDiagnostics();
    return;
  }
  if (diagnosticTimer === undefined) {
    diagnosticTimer = window.setTimeout(() => {
      diagnosticTimer = undefined;
      lastDiagnosticDispatchAt = window.performance.now();
      publishDiagnostics();
    }, DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS - elapsed);
  }
}

function recordUpdateEnd() {
  const startedAt = appendStartedAt.get(this);
  if (Number.isFinite(startedAt)) {
    const duration = Math.max(0, window.performance.now() - startedAt);
    updateEndMsMax = updateEndMsMax === undefined ? duration : Math.max(updateEndMsMax, duration);
    lastUpdateEndAt = window.performance.now();
    appendStartedAt.delete(this);
  }
  dispatchUpdateEndDiagnostics();
}

if (typeof MediaSource !== 'undefined' && typeof MediaSource.prototype?.addSourceBuffer === 'function') {
  const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function smoothAddSourceBuffer(mimeType) {
    const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
    activeSource = this;
    sourceBufferTracks.set(sourceBuffer, String(mimeType).split(';', 1)[0]);
    sourceBuffer.addEventListener('updateend', recordUpdateEnd);
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
    const startedAt = window.performance.now();
    let result;
    try {
      result = originalAppendBuffer.call(this, ...args);
    } catch (error) {
      const name = typeof error?.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
      appendErrors[name] = (appendErrors[name] || 0) + 1;
      dispatchDiagnostics();
      throw error;
    }
    appends += 1;
    lastAppendAt = startedAt;
    appendStartedAt.set(this, startedAt);
    try {
      dispatchUpdateEndDiagnostics();
    } catch (error) {
      console.error('[BilibiliBuffer] source buffer diagnostic dispatch failed', error);
    }
    return result;
  };
}

if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === 'function') {
  const originalRemove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function smoothRemove(start, end) {
    stats.removeCalls += 1;
    return originalRemove.call(this, start, end);
  };
  installed = true;
}

window.__smoothBufferShim = { installed, stats };
dispatchDiagnostics();
