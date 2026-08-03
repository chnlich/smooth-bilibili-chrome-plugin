import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';
import { SHIM_APPEND_EVENT, SHIM_DIAGNOSTIC_ATTRIBUTE } from './bridge-contract.js';

let installed = false;
const mediaSourceInstances = new WeakMap();
const sourceBufferInstances = new WeakMap();
const sourceBufferRecords = new WeakMap();
const liveMediaSources = [];
let nextMediaSourceInstance = 1;

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

function registerMediaSource(mediaSource) {
  const existingInstance = mediaSourceInstances.get(mediaSource);
  if (existingInstance !== undefined) return existingInstance;
  const mediaSourceInstance = nextMediaSourceInstance;
  nextMediaSourceInstance += 1;
  mediaSourceInstances.set(mediaSource, mediaSourceInstance);
  sourceBufferInstances.set(mediaSource, 1);
  liveMediaSources.push(new WeakRef(mediaSource));
  for (const eventName of ['sourceopen', 'sourceended', 'sourceclose']) {
    mediaSource.addEventListener(eventName, dispatchDiagnostics);
  }
  return mediaSourceInstance;
}

function registerSourceBuffer(mediaSource, sourceBuffer, mimeType) {
  const mediaSourceInstance = registerMediaSource(mediaSource);
  const sourceBufferInstance = sourceBufferInstances.get(mediaSource);
  sourceBufferInstances.set(mediaSource, sourceBufferInstance + 1);
  sourceBufferRecords.set(sourceBuffer, {
    mediaSourceInstance,
    sourceBufferInstance,
    track: String(mimeType).split(';', 1)[0],
    appends: 0,
    appendErrors: Object.create(null),
    appendSequence: 0,
    pendingAppend: undefined,
    lastAppendAt: undefined,
    updateEndMsMax: undefined,
    lastUpdateEndAt: undefined,
    removeCalls: 0,
  });
}

function collectLiveMediaSources() {
  const liveReferences = [];
  const sources = [];
  for (const reference of liveMediaSources) {
    const mediaSource = reference.deref();
    if (mediaSource === undefined) continue;
    liveReferences.push(reference);
    sources.push(mediaSource);
  }
  liveMediaSources.length = 0;
  liveMediaSources.push(...liveReferences);
  return sources;
}

function forEachSourceBuffer(mediaSource, callback) {
  for (let index = 0; index < mediaSource.sourceBuffers.length; index += 1) {
    const sourceBuffer = mediaSource.sourceBuffers[index];
    callback(sourceBuffer, sourceBufferRecords.get(sourceBuffer));
  }
}

function aggregateRemoveCalls() {
  let removeCalls = 0;
  for (const mediaSource of collectLiveMediaSources()) {
    forEachSourceBuffer(mediaSource, (_sourceBuffer, record) => {
      removeCalls += record.removeCalls;
    });
  }
  return removeCalls;
}

function publishDiagnostics() {
  try {
    const sourceBufferRanges = [];
    const appendErrors = Object.create(null);
    const sources = collectLiveMediaSources();
    const now = window.performance.now();
    let appends = 0;
    let lastAppendAt;
    let updateEndMsMax;
    let updateEndAt;
    let removeCalls = 0;
    let mediaSourceState = null;
    let hasOpenMediaSource = false;

    for (const mediaSource of sources) {
      const state = mediaSource.readyState || null;
      mediaSourceState = state;
      hasOpenMediaSource ||= state === 'open';
      forEachSourceBuffer(mediaSource, (sourceBuffer, record) => {
        appends += record.appends;
        if (Number.isFinite(record.lastAppendAt)) {
          lastAppendAt = lastAppendAt === undefined
            ? record.lastAppendAt
            : Math.max(lastAppendAt, record.lastAppendAt);
        }
        if (Number.isFinite(record.updateEndMsMax)) {
          updateEndMsMax = updateEndMsMax === undefined
            ? record.updateEndMsMax
            : Math.max(updateEndMsMax, record.updateEndMsMax);
        }
        if (Number.isFinite(record.lastUpdateEndAt)) {
          updateEndAt = updateEndAt === undefined
            ? record.lastUpdateEndAt
            : Math.max(updateEndAt, record.lastUpdateEndAt);
        }
        removeCalls += record.removeCalls;
        for (const [name, count] of Object.entries(record.appendErrors)) {
          appendErrors[name] = (appendErrors[name] || 0) + count;
        }
        sourceBufferRanges.push({
          mediaSourceInstance: record.mediaSourceInstance,
          sourceBufferInstance: record.sourceBufferInstance,
          mediaSourceState: state,
          track: record.track,
          ranges: readSourceBufferRanges(sourceBuffer),
          updating: record.pendingAppend !== undefined,
          pendingSinceMs: record.pendingAppend === undefined
            ? null
            : Math.max(0, now - record.pendingAppend.startedAt),
          appends: record.appends,
          appendErrors: { ...record.appendErrors },
        });
      });
    }

    document.documentElement.setAttribute(SHIM_DIAGNOSTIC_ATTRIBUTE, JSON.stringify({
      sourceBufferRanges,
      mediaSourceState: hasOpenMediaSource ? 'open' : mediaSourceState,
      appendErrors: { ...appendErrors },
      removeStats: { removeCalls },
      appends,
      lastAppendAt: lastAppendAt ?? null,
      updateEndMsMax: updateEndMsMax ?? null,
      updateEndAt: updateEndAt ?? null,
    }));
    for (const mediaSource of sources) {
      forEachSourceBuffer(mediaSource, (_sourceBuffer, record) => {
        record.updateEndMsMax = undefined;
      });
    }
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

function errorName(error) {
  return typeof error?.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}

function readAppendBytes(argument) {
  try {
    const bytes = argument?.byteLength;
    return Number.isInteger(bytes) && bytes >= 0 ? bytes : UNKNOWN_VALUE;
  } catch (error) {
    console.error('[BilibiliBuffer] append byte length read failed', error);
    return UNKNOWN_VALUE;
  }
}

function dispatchAppendEvent(payload) {
  try {
    const CustomEventClass = document.defaultView?.CustomEvent || globalThis.CustomEvent;
    document.dispatchEvent(new CustomEventClass(SHIM_APPEND_EVENT, { detail: JSON.stringify(payload) }));
  } catch (error) {
    console.error('[BilibiliBuffer] source buffer append event dispatch failed', error);
  }
}

function settleAppend(sourceBuffer, result, error) {
  const record = sourceBufferRecords.get(sourceBuffer);
  const pendingAppend = record.pendingAppend;
  if (pendingAppend === undefined) return;
  record.pendingAppend = undefined;
  const settledAt = window.performance.now();
  if (result === 'ok') {
    record.updateEndMsMax = record.updateEndMsMax === undefined
      ? Math.max(0, settledAt - pendingAppend.startedAt)
      : Math.max(record.updateEndMsMax, Math.max(0, settledAt - pendingAppend.startedAt));
    record.lastUpdateEndAt = settledAt;
  } else {
    const name = errorName(error);
    record.appendErrors[name] = (record.appendErrors[name] || 0) + 1;
  }
  dispatchAppendEvent({
    mediaSourceInstance: record.mediaSourceInstance,
    sourceBufferInstance: record.sourceBufferInstance,
    appendSequence: pendingAppend.appendSequence,
    track: record.track,
    bytes: pendingAppend.bytes,
    bufferedBefore: pendingAppend.bufferedBefore,
    bufferedAfter: readSourceBufferRanges(sourceBuffer),
    durationMs: Math.max(0, settledAt - pendingAppend.startedAt),
    result,
    ...(result === 'ok' ? {} : { errorName: errorName(error) }),
  });
}

function recordUpdateEnd() {
  settleAppend(this, 'ok');
  dispatchUpdateEndDiagnostics();
}

function recordSourceBufferError(event) {
  settleAppend(this, 'error_event', event?.error ?? this.error);
  dispatchUpdateEndDiagnostics();
}

if (typeof MediaSource !== 'undefined' && typeof MediaSource.prototype?.addSourceBuffer === 'function') {
  const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function smoothAddSourceBuffer(mimeType) {
    const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
    registerSourceBuffer(this, sourceBuffer, mimeType);
    sourceBuffer.addEventListener('updateend', recordUpdateEnd);
    sourceBuffer.addEventListener('error', recordSourceBufferError);
    dispatchDiagnostics();
    return sourceBuffer;
  };
}

if (typeof SourceBuffer !== 'undefined' && typeof SourceBuffer.prototype?.appendBuffer === 'function') {
  const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function smoothAppendBuffer(...args) {
    const record = sourceBufferRecords.get(this);
    const startedAt = window.performance.now();
    record.appendSequence += 1;
    record.appends += 1;
    record.lastAppendAt = startedAt;
    record.pendingAppend = {
      appendSequence: record.appendSequence,
      startedAt,
      bytes: readAppendBytes(args[0]),
      bufferedBefore: readSourceBufferRanges(this),
    };
    try {
      const result = originalAppendBuffer.call(this, ...args);
      dispatchUpdateEndDiagnostics();
      return result;
    } catch (error) {
      settleAppend(this, 'throw', error);
      dispatchDiagnostics();
      throw error;
    }
  };
}

if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === 'function') {
  const originalRemove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function smoothRemove(start, end) {
    sourceBufferRecords.get(this).removeCalls += 1;
    return originalRemove.call(this, start, end);
  };
  installed = true;
}

window.__smoothBufferShim = {
  installed,
  get stats() {
    return { removeCalls: aggregateRemoveCalls() };
  },
};
dispatchDiagnostics();
