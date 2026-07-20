import { MEDIA_EVENT_NAMES } from './catalog.js';
import { UNKNOWN_VALUE } from './privacy.js';

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

export function readMediaFacts(video) {
  if (video === undefined || video === null) return UNKNOWN_VALUE;
  const bufferedRanges = readRanges(video.buffered);
  const seekableRanges = readRanges(video.seekable);
  let estimatedDelay = UNKNOWN_VALUE;
  if (Array.isArray(seekableRanges) && seekableRanges.length > 0 && Number.isFinite(video.currentTime)) {
    const end = seekableRanges[seekableRanges.length - 1].end;
    estimatedDelay = Number.isFinite(end) ? Math.max(0, end - video.currentTime) : UNKNOWN_VALUE;
  }
  return {
    eventType: 'sample',
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
  };
}

export class MediaEventRecorder {
  constructor({
    video,
    logger,
    runtimeObject = globalThis,
    context = () => ({}),
    onEvent = () => {},
    onFrame = () => {},
  }) {
    this.video = video;
    this.logger = logger || {
      log() {},
    };
    this.runtimeObject = runtimeObject;
    this.context = context;
    this.onEvent = onEvent;
    this.onFrame = onFrame;
    this.listeners = [];
    this.sampleTimer = undefined;
    this.frameCallbackActive = false;
    this.destroyed = false;
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
      facts = readMediaFacts(this.video);
    } catch (error) {
      this.writeLog('extension.observer_error', { reason: 'media-facts' }, error);
      facts = {
        eventType: name,
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
      };
    }
    this.writeLog(`media.${name}`, facts, error);
  }

  writeLog(code, data, error) {
    try {
      this.logger.log(code, data, error, this.context());
    } catch (logError) {
      this.logger.error?.('[BilibiliBuffer] media diagnostic failed', logError);
    }
  }

  scheduleFrameCallback() {
    if (this.destroyed || this.frameCallbackActive || typeof this.video.requestVideoFrameCallback !== 'function') return;
    this.frameCallbackActive = true;
    try {
      this.video.requestVideoFrameCallback((_now, metadata) => {
        this.frameCallbackActive = false;
        if (this.destroyed) return;
        try {
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [name, listener] of this.listeners) this.video.removeEventListener(name, listener);
    this.listeners = [];
    if (this.sampleTimer !== undefined) this.runtimeObject.clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
  }
}
