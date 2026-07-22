import { LIVE_CONFIG } from '../constants.js';
import { serializeError } from '../extension/bridge-contract.js';
import { MediaEventRecorder, readMediaFacts } from '../diagnostics/media.js';

const UNKNOWN = '未提供';
const CORRECTION_SETTLE_MILLISECONDS = 500;
const FRAME_PROGRESS_EPSILON_SECONDS = 0.001;

function currentSource(video) {
  return video?.currentSrc || video?.src || '';
}

function nowMilliseconds(runtimeObject) {
  return typeof runtimeObject.performance?.now === 'function'
    ? runtimeObject.performance.now()
    : Date.now();
}

function readTimeRanges(timeRanges) {
  if (timeRanges === undefined || timeRanges === null) return undefined;
  const ranges = [];
  for (let index = 0; index < timeRanges.length; index += 1) {
    const start = timeRanges.start(index);
    const end = timeRanges.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error(`直播媒体 range ${index} 无效`);
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function readSeekable(video) {
  return readTimeRanges(video?.seekable);
}

function continuousBuffer(video) {
  const ranges = readTimeRanges(video?.buffered);
  if (ranges === undefined || !Number.isFinite(video.currentTime)) return UNKNOWN;
  const match = ranges.find((range) => range.start <= video.currentTime && video.currentTime <= range.end);
  return match === undefined ? 0 : Math.max(0, match.end - video.currentTime);
}

function delayFromSeekable(video) {
  const ranges = readSeekable(video);
  if (ranges === undefined || ranges.length === 0 || !Number.isFinite(video.currentTime)) return UNKNOWN;
  const end = ranges[ranges.length - 1].end;
  return Number.isFinite(end) ? Math.max(0, end - video.currentTime) : UNKNOWN;
}

function delayOrUnknown(video, diagnostics, reason, context) {
  try {
    return delayFromSeekable(video);
  } catch (error) {
    diagnostics?.log('extension.observer_error', { reason }, error, context);
    return UNKNOWN;
  }
}

function closestSeekablePosition(ranges, target, earliestWhenOutside) {
  if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(target)) return undefined;
  for (const range of ranges) {
    if (range.start <= target && target <= range.end) return target;
  }
  if (earliestWhenOutside) return ranges[0].start;
  if (target < ranges[0].start) return ranges[0].start;
  if (target > ranges[ranges.length - 1].end) return ranges[ranges.length - 1].end;
  for (let index = 1; index < ranges.length; index += 1) {
    const previousEnd = ranges[index - 1].end;
    const nextStart = ranges[index].start;
    if (previousEnd < target && target < nextStart) {
      return target - previousEnd <= nextStart - target ? previousEnd : nextStart;
    }
  }
  throw new Error('无法为直播目标位置选择 seekable 端点');
}

function seekablePositionForDelay(ranges, targetDelay) {
  if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(targetDelay)) return undefined;
  const seekableEnd = ranges[ranges.length - 1].end;
  const targetTime = seekableEnd - targetDelay;
  return closestSeekablePosition(ranges, targetTime, true);
}

const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const CONTROL_EXCLUSIONS = /volume|音量|quality|画质|speed|倍速|rate|播放速度|chat|comment|弹幕/i;
const TIMELINE_MARKERS = /seek|timeline|progress|position|进度|时间轴/i;

function eventPath(event) {
  if (typeof event?.composedPath === 'function') return event.composedPath();
  const path = [];
  let current = event?.target;
  while (current !== undefined && current !== null) {
    path.push(current);
    current = current.parentElement;
  }
  return path;
}

function elementText(element) {
  const attributes = ['id', 'class', 'aria-label', 'title', 'name', 'data-seek', 'data-timeline', 'data-progress'];
  return attributes
    .map((attribute) => element?.getAttribute?.(attribute) || element?.[attribute] || '')
    .join(' ');
}

function isTimelineControl(element) {
  if (element === undefined || element === null || typeof element !== 'object') return false;
  const text = elementText(element);
  const explicit = ['data-seek', 'data-timeline', 'data-progress']
    .some((attribute) => typeof element.getAttribute === 'function' && element.getAttribute(attribute) !== null);
  if (CONTROL_EXCLUSIONS.test(text)) return false;
  if (explicit) return true;
  const tagName = String(element.tagName || '').toLowerCase();
  const inputType = String(element.type || element.getAttribute?.('type') || '').toLowerCase();
  const role = String(element.getAttribute?.('role') || element.role || '').toLowerCase();
  if (tagName === 'input' && inputType === 'range') return TIMELINE_MARKERS.test(text);
  if (role === 'slider') return TIMELINE_MARKERS.test(text);
  return TIMELINE_MARKERS.test(text) && !CONTROL_EXCLUSIONS.test(text);
}

function isUserSeekIntent(event, video, documentObject) {
  const path = eventPath(event);
  const timeline = path.some((element) => isTimelineControl(element));
  if (event?.type === 'pointerdown') return timeline;
  if (event?.type === 'input') return timeline;
  if (event?.type !== 'keydown' || !SEEK_KEYS.has(event.key)) return false;
  return timeline || path.includes(video) || documentObject.activeElement === video;
}

function collectSameOriginVideos(documentObject) {
  const videos = [...documentObject.querySelectorAll('video')];
  for (const iframe of documentObject.querySelectorAll('iframe')) {
    try {
      const iframeDocument = iframe.contentDocument;
      if (iframeDocument !== null) videos.push(...iframeDocument.querySelectorAll('video'));
    } catch { /* cross-origin iframe */ }
  }
  return videos;
}

function selectVideo(documentObject) {
  const videos = collectSameOriginVideos(documentObject).filter((video) => video.isConnected !== false);
  return videos.sort((left, right) => {
    const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
    const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
    return rightArea - leftArea;
  })[0];
}

export class LiveObserver {
  constructor({
    documentObject = document,
    windowObject = window,
    runtimeObject = windowObject,
    panel,
    logger,
    diagnostics,
    pageAdapter,
    initialVideo,
    config = LIVE_CONFIG,
  }) {
    this.documentObject = documentObject;
    this.windowObject = windowObject;
    this.runtimeObject = runtimeObject;
    this.panel = panel;
    this.logger = logger;
    this.diagnostics = diagnostics;
    this.pageAdapter = pageAdapter;
    this.config = config;
    this.video = initialVideo;
    this.videoInstance = 0;
    this.sourceInstance = 0;
    this.videoReplacements = 0;
    this.sourceReplacements = 0;
    this.sourceKey = '';
    this.videoParent = undefined;
    this.recorder = undefined;
    this.mutationObserver = undefined;
    this.statusTimer = undefined;
    this.started = false;
    this.destroyed = false;
    this.hasDecodedFrame = false;
    this.lastDecodedAtMilliseconds = undefined;
    this.lastDecodedMediaTime = undefined;
    this.recentEvent = UNKNOWN;
    this.recentError = UNKNOWN;
    // activeStall is only the currently unresolved genuine stall.  A separate
    // delayProtection fact survives the first decoded recovery frame.
    this.activeStall = undefined;
    this.delayProtection = undefined;
    this.awaitingUserSeekFrame = false;
    this.userSeekAuthorization = undefined;
    this.lastCorrection = undefined;
    this.correcting = false;
    this.replacementNeedsCorrection = false;
    this.iframeMutationObservers = [];
    this.frameCanvas = undefined;
    this.overlayCanvas = undefined;
    this.autoCatchupAttempted = false;
    this.delayUnavailableTimer = undefined;
    this.delayUnavailableEmitted = false;
    this.liveCapabilities = undefined;
    this.liveCapabilitiesPromise = undefined;
    this.boundUserInput = (event) => this.noteUserInput(event);
    this.boundMutation = () => this.reconcileVideo();
  }

  currentProtectedDelay() {
    if (this.activeStall !== undefined) {
      this.updateStallTarget(this.activeStall);
      return this.activeStall.targetDelay;
    }
    if (this.delayProtection !== undefined) return this.delayProtection.protectedDelay;
    return undefined;
  }

  updateStallTarget(stall) {
    const elapsedSeconds = Math.max(0, nowMilliseconds(this.runtimeObject) - stall.startedAt) / 1000;
    const timedTarget = stall.delayBeforeStall + elapsedSeconds;
    stall.targetDelay = Math.max(stall.targetDelay, timedTarget);
    if (Number.isFinite(stall.lastObservedDelay)) stall.protectedDelay = stall.lastObservedDelay;
    return stall.targetDelay;
  }

  observeProtectedDelay(video, observedDelay) {
    if (this.delayProtection === undefined || this.delayProtection.video !== video ||
      this.delayProtection.videoInstance !== this.videoInstance ||
      this.delayProtection.sourceInstance !== this.sourceInstance || !Number.isFinite(observedDelay)) return;
    this.delayProtection.lastObservedDelay = observedDelay;
    this.delayProtection.protectedDelay = observedDelay;
  }

  start() {
    if (this.destroyed) throw new Error('直播观察器已经销毁');
    if (this.started) throw new Error('直播观察器已经启动');
    this.started = true;
    this.documentObject.addEventListener('pointerdown', this.boundUserInput, true);
    this.documentObject.addEventListener('keydown', this.boundUserInput, true);
    this.documentObject.addEventListener('input', this.boundUserInput, true);
    if (typeof this.windowObject.MutationObserver === 'function') {
      this.mutationObserver = new this.windowObject.MutationObserver(this.boundMutation);
      this.mutationObserver.observe(this.documentObject, { childList: true, subtree: true });
    }
    this.statusTimer = this.runtimeObject.setInterval(() => this.sample(), this.config.statusRefreshMilliseconds);
    this.attachIframeObservers();
    if (this.video !== undefined) {
      const initialVideo = this.video;
      this.video = undefined;
      this.bindVideo(selectVideo(this.documentObject) || initialVideo);
    } else {
      this.reconcileVideo();
    }
    this.updateStatus();
  }

  attachIframeObservers() {
    this.detachIframeObservers();
    if (typeof this.windowObject.MutationObserver !== 'function') return;
    for (const iframe of this.documentObject.querySelectorAll('iframe')) {
      try {
        const iframeDocument = iframe.contentDocument;
        if (iframeDocument === null) continue;
        const observer = new this.windowObject.MutationObserver(this.boundMutation);
        observer.observe(iframeDocument, { childList: true, subtree: true });
        this.iframeMutationObservers.push(observer);
      } catch { /* cross-origin iframe */ }
    }
  }

  detachIframeObservers() {
    for (const observer of this.iframeMutationObservers) observer.disconnect();
    this.iframeMutationObservers = [];
  }

  context() {
    return {
      videoInstance: this.videoInstance || undefined,
      sourceInstance: this.sourceInstance || undefined,
    };
  }

  reconcileVideo() {
    if (this.destroyed || !this.started) return;
    const nextVideo = selectVideo(this.documentObject);
    if (nextVideo === undefined) {
      if (this.video !== undefined && this.video.isConnected === false) {
        this.showOverlay();
      }
      this.updateStatus();
      return;
    }
    if (nextVideo !== this.video) {
      if (this.video !== undefined) {
        this.videoReplacements += 1;
        this.showOverlay();
      }
      this.bindVideo(nextVideo);
      return;
    }
    this.rebindSourceIfNeeded();
  }

  bindVideo(video) {
    const previousVideo = this.video;
    const previousSource = this.sourceKey;
    const previousStall = this.activeStall;
    const previousProtection = this.delayProtection;
    this.hideOverlay();
    this.recorder?.destroy();
    this.video = video;
    this.videoParent = video.parentElement || this.videoParent;
    this.videoInstance += 1;
    this.hasDecodedFrame = false;
    this.lastDecodedAtMilliseconds = undefined;
    this.lastDecodedMediaTime = undefined;
    this.recentError = UNKNOWN;
    this.sourceKey = currentSource(video);
    if (this.sourceKey !== '') this.sourceInstance += 1;
    if (previousVideo !== undefined && previousSource !== this.sourceKey) {
      this.sourceReplacements += 1;
      this.diagnostics?.log('live.source_replaced', {
        previousSource,
        source: this.sourceKey,
        status: previousStall === undefined && previousProtection === undefined ? 'observed' : 'protected',
      }, undefined, this.context());
      this.diagnostics?.log('video.source_replaced', {
        previousSource,
        source: this.sourceKey,
        reason: 'video_replaced',
      }, undefined, this.context());
    }
    if (previousVideo !== undefined) {
      this.diagnostics?.log('video.replaced', {
        reason: 'video_replaced',
      }, undefined, this.context());
    }
    if (previousStall !== undefined) {
      this.activeStall = {
        ...previousStall,
        video,
        videoInstance: this.videoInstance,
        sourceInstance: this.sourceInstance,
        lastDecodedMediaTime: undefined,
      };
      this.replacementNeedsCorrection = true;
    }
    if (previousProtection !== undefined) {
      this.delayProtection = {
        ...previousProtection,
        video,
        videoInstance: this.videoInstance,
        sourceInstance: this.sourceInstance,
      };
      this.replacementNeedsCorrection = true;
    }
    this.diagnostics?.markVideoAvailable();
    this.diagnostics?.log('video.attached', { source: this.sourceKey }, undefined, this.context());
    this.autoCatchupAttempted = false;
    this.delayUnavailableEmitted = false;
    this.clearDelayUnavailableTimer();
    this.recorder = new MediaEventRecorder({
      video,
      logger: this.diagnostics,
      runtimeObject: this.runtimeObject,
      context: () => this.context(),
      onEvent: (name, currentVideo) => this.onMediaEvent(name, currentVideo),
      onFrame: (currentVideo, metadata) => this.onDecodedFrame(currentVideo, metadata),
    });
    this.recorder.start();
    this.attachIframeObservers();
    if (previousStall !== undefined) this.showOverlay();
    this.applyReplacementCorrection();
    this.updateStatus();
  }

  rebindSourceIfNeeded() {
    const nextSource = currentSource(this.video);
    if (nextSource === this.sourceKey) return;
    const previousSource = this.sourceKey;
    this.sourceKey = nextSource;
    this.sourceInstance += 1;
    this.lastDecodedMediaTime = undefined;
    this.autoCatchupAttempted = false;
    this.delayUnavailableEmitted = false;
    this.clearDelayUnavailableTimer();
    if (previousSource !== '') this.sourceReplacements += 1;
    if (this.activeStall === undefined) this.hasDecodedFrame = false;
    if (this.activeStall !== undefined) this.showOverlay();
    if (this.activeStall !== undefined) {
      this.activeStall = {
        ...this.activeStall,
        sourceInstance: this.sourceInstance,
        lastDecodedMediaTime: undefined,
      };
    }
    if (this.delayProtection !== undefined) {
      this.delayProtection = { ...this.delayProtection, sourceInstance: this.sourceInstance };
    }
    this.replacementNeedsCorrection = this.activeStall !== undefined || this.delayProtection !== undefined;
    this.diagnostics?.log('live.source_replaced', {
      previousSource,
      source: nextSource,
      status: this.activeStall === undefined && this.delayProtection === undefined ? 'observed' : 'protected',
    }, undefined, this.context());
    this.diagnostics?.log('video.source_replaced', { previousSource, source: nextSource }, undefined, this.context());
    if (this.replacementNeedsCorrection) this.applyReplacementCorrection();
    this.updateStatus();
  }

  onMediaEvent(name, video) {
    if (video !== this.video || this.destroyed) return;
    this.rebindSourceIfNeeded();
    this.recentEvent = name;
    if (name === 'loadeddata' && !this.hasDecodedFrame &&
      typeof video.requestVideoFrameCallback !== 'function') this.onDecodedFrame(video);
    if (name === 'emptied' && this.activeStall !== undefined) this.showOverlay();
    if (name === 'waiting' || name === 'stalled') this.maybeArmStall(name);
    if (name === 'loadedmetadata' || name === 'canplay' || name === 'loadeddata' || name === 'playing') {
      this.applyReplacementCorrection();
    }
    if (name === 'error') {
      const serialized = serializeError(video.error || new Error('原生 video error'));
      this.recentError = serialized.code === 'BRIDGE_CALL_FAILED'
        ? serialized.message
        : `${serialized.code}: ${serialized.message}`;
    }
    this.updateStatus();
  }

  onDecodedFrame(video, metadata) {
    if (video !== this.video || video.isConnected === false || this.destroyed) return;
    const mediaTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : undefined;
    if (this.activeStall !== undefined && Number.isFinite(mediaTime) &&
      Number.isFinite(this.activeStall.lastDecodedMediaTime) &&
      mediaTime <= this.activeStall.lastDecodedMediaTime + FRAME_PROGRESS_EPSILON_SECONDS) return;
    if (this.lastCorrection !== undefined && this.lastCorrection.video === video &&
      this.lastCorrection.videoInstance === this.videoInstance &&
      this.lastCorrection.sourceInstance === this.sourceInstance) this.lastCorrection = undefined;
    const wasAwaiting = this.awaitingUserSeekFrame;
    const firstFrameForInstance = !this.hasDecodedFrame;
    this.hasDecodedFrame = true;
    this.lastDecodedAtMilliseconds = nowMilliseconds(this.runtimeObject);
    if (Number.isFinite(mediaTime)) this.lastDecodedMediaTime = mediaTime;
    if (firstFrameForInstance) this.scheduleDelayUnavailableCheck();
    this.captureFrame(video);
    this.hideOverlay();
    if (wasAwaiting) this.awaitingUserSeekFrame = false;
    const observedDelay = delayOrUnknown(video, this.diagnostics, 'decoded-seekable-read', this.context());
    if (this.activeStall !== undefined) {
      const stall = this.activeStall;
      this.updateStallTarget(stall);
      if (Number.isFinite(observedDelay)) stall.lastObservedDelay = observedDelay;
      const targetDelay = stall.targetDelay;
      this.activeStall = undefined;
      this.delayProtection = {
        video,
        videoInstance: this.videoInstance,
        sourceInstance: this.sourceInstance,
        protectedDelay: targetDelay,
        targetDelay,
        lastObservedDelay: Number.isFinite(observedDelay) ? observedDelay : UNKNOWN,
      };
      this.applyReplacementCorrection(true);
      const actualDelay = delayOrUnknown(
        video,
        this.diagnostics,
        'recovered-seekable-read',
        this.context(),
      );
      if (Number.isFinite(actualDelay)) this.observeProtectedDelay(video, actualDelay);
      this.diagnostics?.log('live.stall.recovered', {
        delayBeforeStall: stall.delayBeforeStall,
        stallDuration: Math.max(0, this.lastDecodedAtMilliseconds - stall.startedAt) / 1000,
        targetDelay,
        protectedDelay: Number.isFinite(actualDelay) ? actualDelay : targetDelay,
      }, undefined, this.context());
    } else {
      if (this.replacementNeedsCorrection) this.applyReplacementCorrection();
      this.observeProtectedDelay(video, observedDelay);
    }
    this.updateStatus();
  }

  noteUserInput(event) {
    if (this.destroyed || event?.isTrusted !== true) return;
    if (!isUserSeekIntent(event, this.video, this.documentObject)) {
      this.userSeekAuthorization = undefined;
      return;
    }
    if (this.video === undefined) return;
    if (event.type === 'input') {
      this.cancelProtection('user_seek');
      this.awaitingUserSeekFrame = true;
      this.hasDecodedFrame = false;
      this.frameCanvas = undefined;
      return;
    }
    this.userSeekAuthorization = {
      video: this.video,
      initialTime: Number.isFinite(this.video?.currentTime) ? this.video.currentTime : undefined,
      expiresAt: nowMilliseconds(this.runtimeObject) + this.config.userSeekAuthorizationMilliseconds,
    };
  }

  maybeArmStall(reason) {
    if (this.activeStall !== undefined || this.awaitingUserSeekFrame || this.video === undefined) return;
    if (this.video.paused !== false || !this.hasDecodedFrame) return;
    const delayBeforeStall = delayOrUnknown(
      this.video,
      this.diagnostics,
      'stall-seekable-read',
      this.context(),
    );
    const currentTime = this.video.currentTime;
    if (!Number.isFinite(delayBeforeStall) || !Number.isFinite(currentTime)) return;
    const startedAt = nowMilliseconds(this.runtimeObject);
    this.activeStall = {
      video: this.video,
      videoInstance: this.videoInstance,
      sourceInstance: this.sourceInstance,
      startedAt,
      delayBeforeStall,
      targetDelay: delayBeforeStall,
      protectedDelay: delayBeforeStall,
      lastObservedDelay: delayBeforeStall,
      lastDecodedMediaTime: this.lastDecodedMediaTime,
    };
    this.replacementNeedsCorrection = false;
    this.diagnostics?.log('live.stall.detected', {
      reason,
      delayBeforeStall,
      currentTime,
      protectedDelay: delayBeforeStall,
    }, undefined, this.context());
    this.attemptDisableAutoCatchup();
  }

  checkForNoFrameStall() {
    if (this.video === undefined || this.video.paused !== false || !this.hasDecodedFrame ||
      this.lastDecodedAtMilliseconds === undefined) return;
    if (typeof this.video.requestVideoFrameCallback !== 'function') return;
    const elapsed = nowMilliseconds(this.runtimeObject) - this.lastDecodedAtMilliseconds;
    if (elapsed >= this.config.noDecodedFrameStallMilliseconds) this.maybeArmStall('no_decoded_frame');
  }

  attemptDisableAutoCatchup() {
    if (this.autoCatchupAttempted) return;
    this.autoCatchupAttempted = true;
    const stall = this.activeStall;
    let capabilityPromise;
    try {
      capabilityPromise = this.liveCapabilities === undefined
        ? this.pageAdapter?.refreshLiveCapabilities?.()
        : Promise.resolve(this.liveCapabilities);
    } catch (error) {
      this.diagnostics?.log('bridge.error', { operation: 'getLiveCapabilitySnapshot', direction: 'response' }, error, this.context());
      this.diagnostics?.log('live.delay_protection.failed', {
        capability: 'disableAutoCatchup',
        status: 'failed',
      }, error, this.context());
      return;
    }
    if (capabilityPromise === undefined) {
      this.diagnostics?.log('live.delay_protection.unsupported', {
        reason: 'capability_not_available',
        status: 'unsupported',
      }, undefined, this.context());
      return;
    }
    this.liveCapabilitiesPromise = Promise.resolve(capabilityPromise)
      .then((capabilities) => {
        this.liveCapabilities = capabilities;
        const supported = capabilities.supportsDisableAutoCatchup();
        this.diagnostics?.log('live.delay_protection.capability', {
          capability: supported ? 'disableAutoCatchup' : 'none',
          status: supported ? 'supported' : 'unsupported',
        }, undefined, this.context());
        if (!supported || this.activeStall !== stall) {
          if (!supported) {
            this.diagnostics?.log('live.delay_protection.unsupported', {
              reason: 'capability_missing',
              status: 'unsupported',
            }, undefined, this.context());
          }
          return undefined;
        }
        return capabilities.disableAutoCatchup().then(() => {
          this.diagnostics?.log('live.delay_protection.applied', {
            capability: 'disableAutoCatchup',
            status: 'applied',
          }, undefined, this.context());
        });
      })
      .catch((error) => {
        this.diagnostics?.log('bridge.error', { operation: 'getLiveCapabilitySnapshot', direction: 'response' }, error, this.context());
        this.diagnostics?.log('live.delay_protection.failed', {
          capability: 'disableAutoCatchup',
          status: 'failed',
        }, error, this.context());
      });
  }

  applyReplacementCorrection(force = false) {
    if ((!this.replacementNeedsCorrection && !force) || this.video === undefined || this.sourceKey === '' ||
      this.video.paused !== false || this.userSeekAuthorization !== undefined) return;
    const protectedDelay = this.currentProtectedDelay();
    if (!Number.isFinite(protectedDelay)) return;
    let ranges;
    try {
      ranges = readSeekable(this.video);
    } catch (error) {
      this.diagnostics?.log('extension.observer_error', { reason: 'replacement-seekable-read' }, error, this.context());
      return;
    }
    const target = seekablePositionForDelay(ranges, protectedDelay);
    if (!Number.isFinite(target) || !Number.isFinite(this.video.currentTime)) return;
    const currentTime = this.video.currentTime;
    const currentDelay = delayOrUnknown(
      this.video,
      this.diagnostics,
      'replacement-seekable-read-current',
      this.context(),
    );
    if (Number.isFinite(currentDelay) && currentDelay >= protectedDelay) {
      this.observeProtectedDelay(this.video, currentDelay);
    }
    this.replacementNeedsCorrection = false;
    if (!Number.isFinite(currentDelay) || currentDelay >= protectedDelay) return;
    this.correcting = true;
    try {
      this.video.currentTime = target;
      this.lastCorrection = {
        video: this.video,
        videoInstance: this.videoInstance,
        sourceInstance: this.sourceInstance,
        target: this.video.currentTime,
        expiresAtMilliseconds: nowMilliseconds(this.runtimeObject) + CORRECTION_SETTLE_MILLISECONDS,
      };
      if (!Number.isFinite(this.video.currentTime) ||
        Math.abs(this.video.currentTime - target) > this.config.correctionToleranceSeconds) return;
      const actualDelay = delayOrUnknown(
        this.video,
        this.diagnostics,
        'replacement-seekable-read-after-correction',
        this.context(),
      );
      if (this.activeStall !== undefined) {
        if (Number.isFinite(actualDelay)) {
          this.activeStall.lastObservedDelay = actualDelay;
          this.activeStall.protectedDelay = actualDelay;
        }
      } else {
        this.observeProtectedDelay(this.video, actualDelay);
      }
      this.replacementNeedsCorrection = false;
      this.diagnostics?.log('live.delay.corrected', {
        reason: 'source_replaced',
        targetTime: target,
        currentTime,
        targetDelay: protectedDelay,
        protectedDelay: Number.isFinite(actualDelay) ? actualDelay : protectedDelay,
      }, undefined, this.context());
    } catch (error) {
      this.diagnostics?.log('live.delay_protection.failed', { reason: 'source_replaced', status: 'failed' }, error, this.context());
    } finally {
      this.correcting = false;
    }
  }

  captureFrame(video) {
    if (video.videoWidth <= 0 || video.videoHeight <= 0 || typeof this.documentObject.createElement !== 'function') return;
    let canvas;
    try {
      canvas = this.documentObject.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (context === null) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (typeof context.getImageData === 'function') {
        try {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let nonBlack = false;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 12 && pixels[index + 3] > 0) {
              nonBlack = true;
              break;
            }
          }
          if (!nonBlack) return;
        } catch (error) {
          if (error?.name !== 'SecurityError') throw error;
        }
      }
      this.frameCanvas = canvas;
    } catch (error) {
      this.diagnostics?.log('extension.observer_error', { reason: 'frame-capture' }, error, this.context());
    }
  }

  showOverlay() {
    if (this.activeStall === undefined || this.frameCanvas === undefined || this.overlayCanvas !== undefined) return;
    const parent = this.video?.parentElement || this.videoParent;
    if (parent === null || parent === undefined || typeof this.documentObject.createElement !== 'function') return;
    try {
      const canvas = this.documentObject.createElement('canvas');
      canvas.width = this.frameCanvas.width;
      canvas.height = this.frameCanvas.height;
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.setAttribute('aria-hidden', 'true');
      const context = canvas.getContext('2d');
      context?.drawImage(this.frameCanvas, 0, 0, canvas.width, canvas.height);
      parent.append(canvas);
      this.overlayCanvas = canvas;
    } catch (error) {
      this.diagnostics?.log('extension.observer_error', { reason: 'overlay' }, error, this.context());
    }
  }

  hideOverlay() {
    if (this.overlayCanvas === undefined) return;
    try {
      this.overlayCanvas.remove();
      this.overlayCanvas = undefined;
    } catch (error) {
      this.diagnostics?.log('extension.observer_error', { reason: 'overlay-remove' }, error, this.context());
    }
  }

  sample() {
    if (this.destroyed) return;
    if (this.userSeekAuthorization !== undefined &&
      nowMilliseconds(this.runtimeObject) > this.userSeekAuthorization.expiresAt) {
      this.userSeekAuthorization = undefined;
    }
    this.reconcileVideo();
    this.checkForNoFrameStall();
    if (this.replacementNeedsCorrection) this.applyReplacementCorrection();
    if (this.video !== undefined) {
      const estimatedDelay = delayOrUnknown(
        this.video,
        this.diagnostics,
        'sample-seekable-read',
        this.context(),
      );
      if (this.activeStall !== undefined) {
        if (Number.isFinite(estimatedDelay)) this.activeStall.lastObservedDelay = estimatedDelay;
        this.updateStallTarget(this.activeStall);
      } else {
        this.observeProtectedDelay(this.video, estimatedDelay);
      }
      if (this.activeStall !== undefined || this.delayProtection !== undefined) {
        const protectedDelay = this.currentProtectedDelay();
        this.diagnostics?.log('live.delay.observed', {
          estimatedDelay,
          currentTime: this.video.currentTime,
          protectedDelay,
          targetDelay: protectedDelay,
        }, undefined, this.context());
      }
    }
    this.updateStatus();
  }

  snapshot() {
    const video = this.video;
    let facts;
    if (video !== undefined) {
      try {
        facts = readMediaFacts(video);
      } catch (error) {
        this.diagnostics?.log('extension.observer_error', { reason: 'snapshot-media-facts' }, error, this.context());
      }
    }
    const status = this.diagnostics?.getStatus() || { sessionId: UNKNOWN, persistence: UNKNOWN };
    const resolution = Number.isFinite(facts?.resolution?.width) && Number.isFinite(facts?.resolution?.height)
      ? `${facts.resolution.width}×${facts.resolution.height}`
      : UNKNOWN;
    return {
      mode: '直播',
      paused: typeof video?.paused === 'boolean' ? (video.paused ? '是' : '否') : UNKNOWN,
      recentFrame: this.lastDecodedAtMilliseconds === undefined
        ? UNKNOWN
        : nowMilliseconds(this.runtimeObject) - this.lastDecodedAtMilliseconds <= 1000 ? '是' : '否',
      buffered: video === undefined ? UNKNOWN : (() => {
        try { return continuousBuffer(video); } catch (error) {
          this.diagnostics?.log('extension.observer_error', { reason: 'snapshot-buffered' }, error, this.context());
          return UNKNOWN;
        }
      })(),
      delay: video === undefined ? UNKNOWN : (() => {
        try { return delayFromSeekable(video); } catch (error) {
          this.diagnostics?.log('extension.observer_error', { reason: 'snapshot-seekable' }, error, this.context());
          return UNKNOWN;
        }
      })(),
      effective: video === undefined ? UNKNOWN : (() => {
        try {
          const delay = delayFromSeekable(video);
          if (!Number.isFinite(delay)) return '失活(seekable 不可读)';
          if (this.activeStall !== undefined || this.delayProtection !== undefined) {
            return `保护中(实测延迟${Math.round(delay)}s)`;
          }
          return `监测中(延迟${Math.round(delay)}s)`;
        } catch {
          return '失活(seekable 不可读)';
        }
      })(),
      resolution,
      quality: UNKNOWN,
      speed: Number.isFinite(video?.playbackRate) ? `${video.playbackRate}×` : UNKNOWN,
      videoReplacements: this.videoReplacements,
      sourceReplacements: this.sourceReplacements,
      recentEvent: this.recentEvent,
      error: this.recentError,
      sessionId: status.sessionId,
      persistence: status.persistence,
      videoInstance: this.videoInstance || UNKNOWN,
      sourceInstance: this.sourceInstance || UNKNOWN,
    };
  }

  updateStatus() {
    if (this.destroyed || !this.started) return;
    const snapshot = this.snapshot();
    this.panel.setModel(snapshot);
  }

  refreshStatus() {
    this.updateStatus();
  }

  cancelProtection(reason) {
    if (this.activeStall === undefined && this.delayProtection === undefined) return;
    this.diagnostics?.log('live.delay_protection.cancelled', {
      reason,
      status: 'cancelled',
      currentTime: this.video?.currentTime,
    }, undefined, this.context());
    this.activeStall = undefined;
    this.delayProtection = undefined;
    this.replacementNeedsCorrection = false;
    this.hideOverlay();
  }

  cancelUserSeek() {
    this.userSeekAuthorization = undefined;
    this.lastCorrection = undefined;
    this.cancelProtection('user_seek');
    this.awaitingUserSeekFrame = true;
    this.hasDecodedFrame = false;
    this.frameCanvas = undefined;
  }

  clearDelayUnavailableTimer() {
    if (this.delayUnavailableTimer !== undefined) {
      this.runtimeObject.clearTimeout(this.delayUnavailableTimer);
      this.delayUnavailableTimer = undefined;
    }
  }

  scheduleDelayUnavailableCheck() {
    if (this.delayUnavailableEmitted || this.delayUnavailableTimer !== undefined) return;
    this.delayUnavailableTimer = this.runtimeObject.setTimeout(() => {
      this.delayUnavailableTimer = undefined;
      if (this.destroyed || this.video === undefined) return;
      const delay = delayOrUnknown(this.video, this.diagnostics, 'delay-unavailable-check', this.context());
      if (Number.isFinite(delay)) return;
      this.delayUnavailableEmitted = true;
      this.diagnostics?.log('live.delay.unavailable', {
        reason: 'seekable_unreadable',
        waitedSeconds: this.config.delayUnavailableCheckMilliseconds / 1000,
        status: 'unavailable',
      }, undefined, this.context());
    }, this.config.delayUnavailableCheckMilliseconds);
  }

  destroy() {
    if (this.destroyed) return;
    this.diagnostics?.log('video.destroyed', { reason: 'live_observer_destroyed' }, undefined, this.context());
    this.destroyed = true;
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    this.detachIframeObservers();
    this.documentObject.removeEventListener('pointerdown', this.boundUserInput, true);
    this.documentObject.removeEventListener('keydown', this.boundUserInput, true);
    this.documentObject.removeEventListener('input', this.boundUserInput, true);
    this.recorder?.destroy();
    this.recorder = undefined;
    if (this.statusTimer !== undefined) this.runtimeObject.clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    this.clearDelayUnavailableTimer();
    this.hideOverlay();
    this.frameCanvas = undefined;
    this.videoParent = undefined;
    this.activeStall = undefined;
    this.delayProtection = undefined;
    this.lastCorrection = undefined;
    this.video = undefined;
  }
}
