import { MEDIA_EVENT_NAMES } from './catalog.js';
import { SHIM_DIAGNOSTIC_ATTRIBUTE } from '../extension/bridge-contract.js';
import { browserMetric, UNKNOWN_VALUE } from './privacy.js';

function readRanges(timeRanges) {
  if (timeRanges === undefined || timeRanges === null) return UNKNOWN_VALUE;
  const result = [];
  for (let index = 0; index < timeRanges.length; index += 1) {
    result.push({ start: timeRanges.start(index), end: timeRanges.end(index) });
  }
  return result;
}

function readNumber(value) {
  return Number.isFinite(value) ? value : UNKNOWN_VALUE;
}

function readVideoQuality(video) {
  if (typeof video.getVideoPlaybackQuality !== 'function') return UNKNOWN_VALUE;
  try {
    const quality = video.getVideoPlaybackQuality();
    return {
      total: readNumber(quality.totalVideoFrames),
      dropped: readNumber(quality.droppedVideoFrames),
      corrupted: readNumber(quality.corruptedVideoFrames),
    };
  } catch (error) {
    console.error('[BilibiliBuffer] video playback quality read failed', error);
    return UNKNOWN_VALUE;
  }
}

function readShimDiagnostics(video) {
  const attribute = video.ownerDocument?.documentElement?.getAttribute(SHIM_DIAGNOSTIC_ATTRIBUTE);
  if (attribute === null || attribute === undefined) {
    return {
      sourceBufferRanges: UNKNOWN_VALUE,
      mediaSourceState: UNKNOWN_VALUE,
      appendErrors: UNKNOWN_VALUE,
      removeStats: UNKNOWN_VALUE,
      appends: UNKNOWN_VALUE,
      lastAppendAt: UNKNOWN_VALUE,
      updateEndMsMax: UNKNOWN_VALUE,
      updateEndAt: UNKNOWN_VALUE,
    };
  }
  try {
    const value = JSON.parse(attribute);
    return {
      sourceBufferRanges: value.sourceBufferRanges,
      mediaSourceState: value.mediaSourceState,
      appendErrors: value.appendErrors,
      removeStats: value.removeStats,
      appends: value.appends,
      lastAppendAt: value.lastAppendAt,
      updateEndMsMax: value.updateEndMsMax,
      updateEndAt: value.updateEndAt,
    };
  } catch (error) {
    console.error('[BilibiliBuffer] shim diagnostic read failed', error);
    return {
      sourceBufferRanges: UNKNOWN_VALUE,
      mediaSourceState: UNKNOWN_VALUE,
      appendErrors: UNKNOWN_VALUE,
      removeStats: UNKNOWN_VALUE,
      appends: UNKNOWN_VALUE,
      lastAppendAt: UNKNOWN_VALUE,
      updateEndMsMax: UNKNOWN_VALUE,
      updateEndAt: UNKNOWN_VALUE,
    };
  }
}

export function readMediaFacts(video, eventType = 'sample') {
  if (video === undefined || video === null) return UNKNOWN_VALUE;
  const bufferedRanges = readRanges(video.buffered);
  const seekableRanges = readRanges(video.seekable);
  const shimDiagnostics = readShimDiagnostics(video);
  let estimatedDelay = UNKNOWN_VALUE;
  if (Array.isArray(seekableRanges) && seekableRanges.length > 0 && Number.isFinite(video.currentTime)) {
    const end = seekableRanges[seekableRanges.length - 1].end;
    estimatedDelay = Number.isFinite(end) ? Math.max(0, end - video.currentTime) : UNKNOWN_VALUE;
  }
  return {
    eventType,
    bufferedRanges,
    seekableRanges,
    currentTime: readNumber(video.currentTime),
    duration: readNumber(video.duration),
    paused: typeof video.paused === 'boolean' ? video.paused : UNKNOWN_VALUE,
    ended: typeof video.ended === 'boolean' ? video.ended : UNKNOWN_VALUE,
    readyState: readNumber(video.readyState),
    networkState: readNumber(video.networkState),
    resolution: {
      width: readNumber(video.videoWidth),
      height: readNumber(video.videoHeight),
    },
    playbackRate: readNumber(video.playbackRate),
    estimatedDelay,
    source: video.currentSrc || video.src || UNKNOWN_VALUE,
    videoQuality: readVideoQuality(video),
    sourceBufferRanges: shimDiagnostics.sourceBufferRanges,
    mediaSourceState: shimDiagnostics.mediaSourceState,
    appendErrors: shimDiagnostics.appendErrors,
    removeStats: shimDiagnostics.removeStats,
    appends: shimDiagnostics.appends,
    lastAppendAt: shimDiagnostics.lastAppendAt,
    updateEndMsMax: shimDiagnostics.updateEndMsMax,
    updateEndAt: shimDiagnostics.updateEndAt,
  };
}

function emptyMediaFacts(eventType) {
  return {
    eventType,
    bufferedRanges: UNKNOWN_VALUE,
    seekableRanges: UNKNOWN_VALUE,
    currentTime: UNKNOWN_VALUE,
    duration: UNKNOWN_VALUE,
    paused: UNKNOWN_VALUE,
    ended: UNKNOWN_VALUE,
    readyState: UNKNOWN_VALUE,
    networkState: UNKNOWN_VALUE,
    resolution: { width: UNKNOWN_VALUE, height: UNKNOWN_VALUE },
    playbackRate: UNKNOWN_VALUE,
    estimatedDelay: UNKNOWN_VALUE,
    source: UNKNOWN_VALUE,
    videoQuality: UNKNOWN_VALUE,
    sourceBufferRanges: UNKNOWN_VALUE,
    mediaSourceState: UNKNOWN_VALUE,
    appendErrors: UNKNOWN_VALUE,
    removeStats: UNKNOWN_VALUE,
    appends: UNKNOWN_VALUE,
    lastAppendAt: UNKNOWN_VALUE,
    updateEndMsMax: UNKNOWN_VALUE,
    updateEndAt: UNKNOWN_VALUE,
  };
}

function runtimeNow(runtimeObject) {
  const value = runtimeObject?.performance?.now?.();
  return Number.isFinite(value) ? value : UNKNOWN_VALUE;
}

function finiteDelta(value, previous) {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return 0;
  return Math.max(0, value - previous);
}

function rawMetric(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.value === 0 && value.reportedBy === 'browser') return 0;
  return value;
}

function qualityDelta(value, previous) {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return undefined;
  return value - previous;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

export function classifyStall({
  currentTime,
  bufferedRanges,
  totalDelta,
  droppedDelta,
  mediaStepMsMedian,
  mediaStepMsMax,
}) {
  const hasBufferedData = Number.isFinite(currentTime)
    && Array.isArray(bufferedRanges)
    && bufferedRanges.some((range) => Number.isFinite(range?.start)
      && Number.isFinite(range?.end)
      && range.start <= currentTime
      && range.end > currentTime);
  if (!hasBufferedData) return '数据侧';
  if (totalDelta === 0) return '帧未产出';
  const mediaStepMedian = rawMetric(mediaStepMsMedian);
  const mediaStepMax = rawMetric(mediaStepMsMax);
  const mediaStepGap = Number.isFinite(mediaStepMedian)
    && Number.isFinite(mediaStepMax)
    && mediaStepMax > mediaStepMedian;
  if (totalDelta > 0 && (droppedDelta > 0 || mediaStepGap)) return '帧未呈现';
  return '未判定';
}

export class MediaEventRecorder {
  constructor({
    video,
    logger,
    runtimeObject = globalThis,
    context = () => ({}),
    onEvent = () => {},
    onFrame = () => {},
    now = () => runtimeNow(runtimeObject),
    wallNow = () => Date.now(),
  }) {
    this.video = video;
    this.logger = logger || {
      log() {},
    };
    this.runtimeObject = runtimeObject;
    this.context = context;
    this.onEvent = onEvent;
    this.onFrame = onFrame;
    this.now = now;
    this.wallNow = wallNow;
    this.listeners = [];
    this.sampleTimer = undefined;
    this.frameCallbackActive = false;
    this.destroyed = false;
    this.previousPresentedFrames = undefined;
    this.previousMediaTime = undefined;
    this.previousVideoQuality = undefined;
    this.presentedFramesTotal = undefined;
    this.frameCallbackSupported = typeof this.video.requestVideoFrameCallback === 'function';
    this.intervalPresented = this.frameCallbackSupported ? 0 : UNKNOWN_VALUE;
    this.intervalFrameCount = 0;
    this.intervalMaxFrameGapMs = undefined;
    this.intervalMaxFrameGapEndedAt = undefined;
    this.intervalProcessingDurations = [];
    this.intervalDisplayLeads = [];
    this.intervalMediaSteps = [];
    this.lastFrameTimestamp = undefined;
    this.lastUpdateEndAt = undefined;
    this.updateEndBaselineEstablished = false;
    this.visibilityDocument = undefined;
    this.visibilityListener = undefined;
    this.visibilityState = UNKNOWN_VALUE;
    this.lastStall = undefined;
  }

  start() {
    if (this.destroyed) throw new Error('媒体日志 recorder 已销毁');
    for (const name of MEDIA_EVENT_NAMES) {
      const listener = () => {
        try {
          this.onEvent(name, this.video);
        } catch (error) {
          this.writeLog('extension.observer_error', { reason: `media-event:${name}` }, error);
        }
        this.logMediaEvent(name, name === 'error' ? this.video.error : undefined);
      };
      this.video.addEventListener(name, listener);
      this.listeners.push([name, listener]);
    }
    this.startVisibilityRecording();
    this.sample();
    this.sampleTimer = this.runtimeObject.setInterval(() => this.sample(), 1000);
    this.scheduleFrameCallback();
  }

  sample() {
    if (this.destroyed) return;
    this.logMediaEvent('sample');
  }

  logMediaEvent(name, error) {
    let facts;
    try {
      facts = readMediaFacts(this.video, name);
    } catch (error) {
      this.writeLog('extension.observer_error', { reason: 'media-facts' }, error);
      facts = emptyMediaFacts(name);
    }
    const recordNow = this.now();
    const {
      data,
      currentTime,
      totalDelta,
      droppedDelta,
    } = this.mediaRecordData(facts, recordNow);
    if (name === 'waiting') {
      this.lastStall = {
        atMs: this.wallNow(),
        kind: classifyStall({
          currentTime,
          bufferedRanges: facts.bufferedRanges,
          totalDelta,
          droppedDelta,
          mediaStepMsMedian: this.intervalMediaSteps.length === 0
            ? UNKNOWN_VALUE
            : median(this.intervalMediaSteps),
          mediaStepMsMax: this.intervalMediaSteps.length === 0
            ? UNKNOWN_VALUE
            : Math.max(...this.intervalMediaSteps),
        }),
      };
    }
    try {
      this.writeLog(`media.${name}`, data, error);
    } finally {
      this.previousVideoQuality = {
        total: Number.isFinite(facts.videoQuality?.total) ? facts.videoQuality.total : undefined,
        dropped: Number.isFinite(facts.videoQuality?.dropped) ? facts.videoQuality.dropped : undefined,
      };
      this.resetInterval();
    }
  }

  writeLog(code, data, error) {
    try {
      this.logger.log(code, data, error, this.context());
    } catch (logError) {
      this.logger.error?.('[BilibiliBuffer] media diagnostic failed', logError);
    }
  }

  scheduleFrameCallback() {
    if (this.destroyed || this.frameCallbackActive
      || !this.frameCallbackSupported) return;
    this.frameCallbackActive = true;
    try {
      this.video.requestVideoFrameCallback((callbackNow, metadata) => {
        this.frameCallbackActive = false;
        if (this.destroyed) return;
        try {
          this.recordFrame(callbackNow, metadata);
          this.onFrame(this.video, metadata);
        } catch (error) {
          this.writeLog('extension.observer_error', { reason: 'decoded-frame' }, error);
        }
        this.scheduleFrameCallback();
      });
    } catch (error) {
      this.frameCallbackActive = false;
      this.writeLog('extension.observer_error', { reason: 'frame-callback' }, error);
    }
  }

  startVisibilityRecording() {
    this.visibilityDocument = this.video?.ownerDocument || this.runtimeObject?.document;
    this.visibilityState = this.readVisibilityState();
    this.writeLog('video.visibility_changed', {
      state: this.visibilityState,
      previousState: UNKNOWN_VALUE,
    });
    if (typeof this.visibilityDocument?.addEventListener !== 'function') return;
    this.visibilityListener = () => {
      const previousState = this.visibilityState;
      this.visibilityState = this.readVisibilityState();
      this.writeLog('video.visibility_changed', {
        state: this.visibilityState,
        previousState,
      });
    };
    this.visibilityDocument.addEventListener('visibilitychange', this.visibilityListener);
  }

  readVisibilityState() {
    const state = this.visibilityDocument?.visibilityState;
    return state === 'visible' || state === 'hidden' ? state : UNKNOWN_VALUE;
  }

  recordFrame(callbackNow, metadata = {}) {
    const frameMetadata = metadata ?? {};
    const frameTimestamp = Number.isFinite(callbackNow) ? callbackNow : this.now();
    this.intervalFrameCount += 1;
    if (Number.isFinite(this.lastFrameTimestamp)) {
      const gapMs = Math.max(0, frameTimestamp - this.lastFrameTimestamp);
      if (this.intervalMaxFrameGapMs === undefined || gapMs > this.intervalMaxFrameGapMs) {
        this.intervalMaxFrameGapMs = gapMs;
        this.intervalMaxFrameGapEndedAt = frameTimestamp;
      }
    }
    this.lastFrameTimestamp = frameTimestamp;

    if (Number.isFinite(frameMetadata.presentedFrames)) {
      this.presentedFramesTotal = frameMetadata.presentedFrames;
      this.intervalPresented = (this.intervalPresented === UNKNOWN_VALUE ? 0 : this.intervalPresented)
        + finiteDelta(frameMetadata.presentedFrames, this.previousPresentedFrames);
      this.previousPresentedFrames = frameMetadata.presentedFrames;
    }
    if (Number.isFinite(frameMetadata.processingDuration)) {
      // requestVideoFrameCallback reports processingDuration in seconds.
      this.intervalProcessingDurations.push(frameMetadata.processingDuration * 1000);
    }
    if (Number.isFinite(frameMetadata.expectedDisplayTime)
      && Number.isFinite(frameMetadata.presentationTime)) {
      this.intervalDisplayLeads.push(
        frameMetadata.expectedDisplayTime - frameMetadata.presentationTime,
      );
    }
    if (Number.isFinite(frameMetadata.mediaTime)) {
      if (Number.isFinite(this.previousMediaTime)) {
        const mediaStepSeconds = frameMetadata.mediaTime - this.previousMediaTime;
        if (Number.isFinite(mediaStepSeconds) && mediaStepSeconds > 0) {
          this.intervalMediaSteps.push(mediaStepSeconds * 1000);
        }
      }
      this.previousMediaTime = frameMetadata.mediaTime;
    } else {
      this.previousMediaTime = undefined;
    }
  }

  mediaRecordData(facts, recordNow) {
    const {
      appends,
      lastAppendAt,
      updateEndMsMax: rawUpdateEndMsMax,
      updateEndAt,
      ...loggedFacts
    } = facts;
    const maxFrameGapMs = this.intervalFrameCount === 0
      && Number.isFinite(recordNow)
      && Number.isFinite(this.lastFrameTimestamp)
      ? Math.max(0, recordNow - this.lastFrameTimestamp)
      : (this.intervalMaxFrameGapMs === undefined ? UNKNOWN_VALUE : this.intervalMaxFrameGapMs);
    const maxFrameGapEndedAgoMs = Number.isFinite(this.intervalMaxFrameGapEndedAt)
      && Number.isFinite(recordNow)
      ? Math.max(0, recordNow - this.intervalMaxFrameGapEndedAt)
      : UNKNOWN_VALUE;
    const processingMsMax = this.intervalProcessingDurations.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(Math.max(...this.intervalProcessingDurations));
    const processingMsMedian = this.intervalProcessingDurations.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(median(this.intervalProcessingDurations));
    const displayLeadMsMedian = this.intervalDisplayLeads.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(Math.round(median(this.intervalDisplayLeads)));
    const displayLeadMsMin = this.intervalDisplayLeads.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(Math.round(Math.min(...this.intervalDisplayLeads)));
    const mediaStepMsMedian = this.intervalMediaSteps.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(Math.round(median(this.intervalMediaSteps)));
    const mediaStepMsMax = this.intervalMediaSteps.length === 0
      ? UNKNOWN_VALUE
      : browserMetric(Math.round(Math.max(...this.intervalMediaSteps)));
    const updateEndMsMax = this.readUpdateEndMsMax({ updateEndAt, updateEndMsMax: rawUpdateEndMsMax });
    const presented = this.intervalPresented;
    const currentTime = loggedFacts.currentTime;
    const totalDelta = qualityDelta(
      loggedFacts.videoQuality?.total,
      this.previousVideoQuality?.total,
    );
    const droppedDelta = qualityDelta(
      loggedFacts.videoQuality?.dropped,
      this.previousVideoQuality?.dropped,
    );
    const data = {
      ...loggedFacts,
      presented,
      frameTiming: {
        presentedTotal: Number.isFinite(this.presentedFramesTotal)
          ? browserMetric(this.presentedFramesTotal)
          : UNKNOWN_VALUE,
        maxFrameGapMs,
        maxFrameGapEndedAgoMs,
        processingMsMax,
        processingMsMedian,
        appends: Number.isFinite(appends) ? appends : UNKNOWN_VALUE,
        lastAppendAgoMs: Number.isFinite(recordNow) && Number.isFinite(lastAppendAt)
          ? Math.max(0, recordNow - lastAppendAt)
          : UNKNOWN_VALUE,
        updateEndMsMax,
        displayLeadMsMedian,
        displayLeadMsMin,
        mediaStepMsMedian,
        mediaStepMsMax,
      },
    };
    return { data, currentTime, totalDelta, droppedDelta };
  }

  getLastStall() {
    return this.lastStall === undefined ? undefined : { ...this.lastStall };
  }

  readUpdateEndMsMax(facts) {
    if (!this.updateEndBaselineEstablished) {
      this.updateEndBaselineEstablished = true;
      this.lastUpdateEndAt = Number.isFinite(facts.updateEndAt) ? facts.updateEndAt : undefined;
      return UNKNOWN_VALUE;
    }
    if (!Number.isFinite(facts.updateEndAt) || facts.updateEndAt <= (this.lastUpdateEndAt ?? Number.NEGATIVE_INFINITY)) {
      return UNKNOWN_VALUE;
    }
    this.lastUpdateEndAt = facts.updateEndAt;
    return Number.isFinite(facts.updateEndMsMax) ? facts.updateEndMsMax : UNKNOWN_VALUE;
  }

  resetInterval() {
    this.intervalPresented = this.frameCallbackSupported ? 0 : UNKNOWN_VALUE;
    this.intervalFrameCount = 0;
    this.intervalMaxFrameGapMs = undefined;
    this.intervalMaxFrameGapEndedAt = undefined;
    this.intervalProcessingDurations = [];
    this.intervalDisplayLeads = [];
    this.intervalMediaSteps = [];
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [name, listener] of this.listeners) this.video.removeEventListener(name, listener);
    this.listeners = [];
    if (this.visibilityListener !== undefined) {
      this.visibilityDocument?.removeEventListener?.('visibilitychange', this.visibilityListener);
      this.visibilityListener = undefined;
    }
    if (this.sampleTimer !== undefined) this.runtimeObject.clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
  }
}
