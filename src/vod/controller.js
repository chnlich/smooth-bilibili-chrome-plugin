import { VOD_CONFIG } from '../constants.js';
import { fail, toBufferScriptError } from '../errors.js';
import { readForwardInventory } from './buffer.js';
import { calculateDownloadMultiplier } from './metrics.js';
import { VodBufferPolicy, coreSupports, readMediaBitrate, readQualitySnapshot } from './policy.js';

function createLogger() {
  return {
    warn(...args) {
      console.warn('[BilibiliBuffer]', ...args);
    },
    error(...args) {
      console.error('[BilibiliBuffer]', ...args);
    },
  };
}

function getCore(windowObject) {
  const player = windowObject.player;
  if (player === undefined || typeof player.__core !== 'function') {
    fail('VOD_CORE_UNAVAILABLE', 'window.player.__core() 尚未可用');
  }
  const core = player.__core();
  if (core === undefined || core === null) {
    fail('VOD_CORE_UNAVAILABLE', 'window.player.__core() 返回空内核');
  }
  return core;
}

function isQuotaError(error) {
  const name = error?.name || error?.code || error?.type || '';
  const message = error?.message || String(error);
  return name === 'QuotaExceededError' || /quota|buffer.?full|mse/i.test(`${name} ${message}`);
}

function isStaleCoreError(error) {
  return error?.code === 'BRIDGE_CORE_STALE' || /播放器内核 .*已过期|桥接内核 .*已过期/.test(error?.message || '');
}

function currentMediaSource(video) {
  return video.currentSrc || video.src || '';
}

function logicalVideoSession(locationObject) {
  const href = locationObject?.href || '';
  if (href.length === 0) {
    return '';
  }
  const url = new URL(href);
  const pathMatch = url.pathname.match(/\/video\/([^/]+)/);
  if (pathMatch === null) {
    return url.pathname;
  }
  return `${pathMatch[1]}#p=${url.searchParams.get('p') || '1'}`;
}

function errorFromCoreEvent(event) {
  return event?.error ?? event?.detail?.error ?? event?.detail ?? event;
}

function activeSessionPerformance(performanceObject, startedAtMilliseconds) {
  return {
    getEntriesByType(type) {
      const entries = performanceObject.getEntriesByType(type);
      if (type !== 'resource') {
        return entries;
      }
      return entries.filter((entry) => (entry.responseEnd || entry.startTime) >= startedAtMilliseconds);
    },
  };
}

const BANDWIDTH_INSUFFICIENT_MESSAGE = '下载不足以覆盖当前 2× 消耗，有限缓冲最终会耗尽';

function qualitySourceLabel(source) {
  if (source === '页面播放器') {
    return '页面播放器';
  }
  if (source === 'core') {
    return 'core';
  }
  return '未知';
}

function formatQualityEvidence(evidence) {
  const actual = evidence.actualQn === undefined ? '当前画质未知' : `qn${evidence.actualQn}`;
  const dimensions = evidence.width === undefined || evidence.height === undefined
    ? 'videoWidth/videoHeight 未提供'
    : `video ${evidence.width}×${evidence.height}`;
  const playerCapabilities = evidence.capabilities.player;
  const coreCapabilities = evidence.capabilities.core;
  const capability = [
    `页面 getQuality=${playerCapabilities.getQuality ? '可用' : '不可用'}`,
    `页面 getSupportedQualityList=${playerCapabilities.getSupportedQualityList ? '可用' : '不可用'}`,
    `core getQuality=${coreCapabilities.getQuality ? '可用' : '不可用'}`,
    `core getSupportedQualityList=${coreCapabilities.getSupportedQualityList ? '可用' : '不可用'}`,
  ].join('/');
  const supported = evidence.availableQns.length === 0
    ? '可用画质列表未提供'
    : `可用 qn ${evidence.availableQns.join(',')}`;
  return `${actual}；来源 ${qualitySourceLabel(evidence.source)}；${dimensions}；能力 ${capability}；${supported}`;
}

export class VodController {
  constructor({
    windowObject,
    documentObject,
    video,
    panel,
    runtimeObject = globalThis,
    logger = createLogger(),
    fetchImpl = globalThis.fetch,
    beforeReconcile = () => {},
    config = VOD_CONFIG,
  }) {
    this.windowObject = windowObject;
    this.documentObject = documentObject;
    this.video = video;
    this.panel = panel;
    this.runtimeObject = runtimeObject;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.beforeReconcile = beforeReconcile;
    this.config = config;
    this.bufferPolicy = new VodBufferPolicy(config);
    this.currentCore;
    this.currentSrc = '';
    this.currentLocation = '';
    this.currentSessionKey;
    this.pollTimer;
    this.statusTimer;
    this.enabled = true;
    this.userPaused = false;
    this.scriptPaused = false;
    this.scriptPauseEvent = false;
    this.pendingScriptPause;
    this.userPauseGuard = false;
    this.pendingPlayGuards = [];
    this.retiredPlayGuards = [];
    this.startupComplete = false;
    this.stableBufferSupported = true;
    this.pausedSchedulingSupported = true;
    this.coreEventsSupported = true;
    this.ended = false;
    this.internalRateChange = false;
    this.qualityStatus = '读取当前画质';
    this.message = '';
    this.policyMessage = '';
    this.mediaMetricsStartMilliseconds = 0;
    this.mediaMetricsBoundaryPending = true;
    this.started = false;
    this.destroyed = false;
    this.boundEvents = [];
    this.removeCoreErrorListener;
    this.seekEpoch = 0;
    this.seekActive = false;
    this.seekClassification = 'none';
    this.seekWarmupActive = false;
    this.seekWarmupComplete = false;
    this.seekRefillDisabled = false;
    this.seekPlaybackOwner = 'none';
    this.seekResumePending = false;
    this.seekTargetTime;
    this.playbackAttemptToken = 0;
    this.lastKnownPlaying = this.video.paused !== true;
  }

  start() {
    if (this.destroyed) {
      fail('VOD_DESTROYED', '点播控制器已经销毁');
    }
    if (this.started) {
      fail('VOD_ALREADY_STARTED', '点播控制器已经启动');
    }
    this.installVideoGuards();
    this.started = true;
    this.pollTimer = this.runtimeObject.setInterval(() => {
      void this.reconcile();
    }, 500);
    this.statusTimer = this.runtimeObject.setInterval(() => {
      this.updateStatus();
    }, 1000);
    void this.reconcile();
  }

  installVideoGuards() {
    const onRateChange = () => {
      if (!this.enabled || this.internalRateChange || this.video.playbackRate === this.config.playbackRate) {
        return;
      }
      this.logger.warn(`点播速度被页面改为 ${this.video.playbackRate}，恢复 ${this.config.playbackRate}×`);
      this.setPlaybackRate();
    };
    const onPause = () => {
      if (this.pendingScriptPause !== undefined) {
        this.pendingScriptPause = undefined;
        this.scriptPauseEvent = false;
        this.lastKnownPlaying = false;
        return;
      }
      if (this.userPauseGuard) {
        this.userPauseGuard = false;
        this.lastKnownPlaying = false;
        return;
      }
      this.lastKnownPlaying = false;
      this.scriptPaused = false;
      this.userPaused = true;
      this.seekResumePending = false;
      this.playbackAttemptToken += 1;
      this.invalidatePendingPlayGuards();
    };
    const onPlay = () => {
      this.lastKnownPlaying = true;
      if (!this.enabled) {
        this.pendingScriptPause = undefined;
        this.scriptPauseEvent = false;
        this.scriptPaused = false;
        this.userPaused = false;
        return;
      }
      const guard = this.currentPlayGuard();
      if (guard !== undefined) {
        guard.playEventSeen = true;
        this.finalizePlayGuard(guard);
        return;
      }
      const retiredGuard = this.consumeRetiredPlayGuard();
      if (retiredGuard !== undefined) {
        if (this.userPaused) {
          this.enforceUserPause();
        }
        return;
      }
      this.invalidatePendingPlayGuards();
      this.playbackAttemptToken += 1;
      this.seekResumePending = false;
      this.userPaused = false;
      this.scriptPaused = false;
      this.pendingScriptPause = undefined;
      this.scriptPauseEvent = false;
    };
    const onSeeking = () => this.handleSeeking();
    const onSeeked = () => this.handleSeeked();
    const onEnded = () => {
      this.ended = true;
      this.seekEpoch += 1;
      this.playbackAttemptToken += 1;
      this.invalidatePendingPlayGuards();
      this.retiredPlayGuards = [];
      this.pendingScriptPause = undefined;
      this.scriptPauseEvent = false;
      this.scriptPaused = false;
      this.seekActive = false;
      this.seekClassification = 'none';
      this.seekWarmupActive = false;
      this.seekWarmupComplete = false;
      this.seekRefillDisabled = false;
      this.seekPlaybackOwner = 'none';
      this.seekResumePending = false;
      this.seekTargetTime = undefined;
      this.lastKnownPlaying = false;
      this.updateStatus();
    };
    const onError = () => {
      if (!this.enabled) {
        return;
      }
      const error = this.video.error;
      if (error !== null && isQuotaError(error)) {
        this.handleQuotaError(error);
      }
    };
    this.addVideoListener('ratechange', onRateChange);
    this.addVideoListener('pause', onPause);
    this.addVideoListener('play', onPlay);
    this.addVideoListener('seeking', onSeeking);
    this.addVideoListener('seeked', onSeeked);
    this.addVideoListener('ended', onEnded);
    this.addVideoListener('error', onError);
  }

  addVideoListener(name, callback) {
    this.video.addEventListener(name, callback);
    this.boundEvents.push([name, callback]);
  }

  remainingDuration() {
    return Number.isFinite(this.video.duration)
      ? Math.max(0, this.video.duration - this.video.currentTime)
      : Number.POSITIVE_INFINITY;
  }

  readInventory(core) {
    try {
      return readForwardInventory(this.video, core);
    } catch (error) {
      if (isStaleCoreError(error)) {
        this.logger.warn('忽略已过期点播库存回调', error);
        return 0;
      }
      this.logger.error('读取点播库存失败', error);
      this.message = `库存不可用: ${error.message || error}`;
      return 0;
    }
  }

  enforceUserPause() {
    if (!this.userPaused || this.video.paused || this.userPauseGuard) {
      return;
    }
    this.userPauseGuard = true;
    this.video.pause();
  }

  pauseForRefill() {
    if (
      !this.enabled ||
      this.destroyed ||
      this.userPaused ||
      this.ended ||
      this.video.paused ||
      !this.pausedSchedulingSupported ||
      this.seekWarmupActive ||
      this.seekRefillDisabled
    ) {
      return;
    }
    this.scriptPaused = true;
    this.pendingScriptPause = { epoch: this.seekEpoch };
    this.scriptPauseEvent = true;
    this.lastKnownPlaying = false;
    this.video.pause();
  }

  replaceCoreErrorListener(core) {
    if (this.removeCoreErrorListener !== undefined) {
      this.removeCoreErrorListener();
      this.removeCoreErrorListener = undefined;
    }
    const onCoreError = (event) => {
      if (!this.enabled || core !== this.currentCore || this.destroyed) {
        return;
      }
      const error = errorFromCoreEvent(event);
      if (isQuotaError(error)) {
        this.handleQuotaError(error);
      }
    };
    const snapshotSupportsEvents = typeof core.supports === 'function'
      ? core.supports('events') === true
      : core.capabilities?.core !== undefined && Object.prototype.hasOwnProperty.call(core.capabilities.core, 'events')
        ? core.capabilities.core.events === true
        : true;
    this.coreEventsSupported = snapshotSupportsEvents;
    if (!snapshotSupportsEvents) {
      this.policyMessage = '当前内核没有错误事件能力，quota 仅依赖 video error';
      return;
    }
    if (typeof core.addEventListener === 'function') {
      core.addEventListener('error', onCoreError);
      this.removeCoreErrorListener = () => core.removeEventListener('error', onCoreError);
      return;
    }
    if (typeof core.on === 'function') {
      core.on('error', onCoreError);
      if (typeof core.off === 'function') {
        this.removeCoreErrorListener = () => core.off('error', onCoreError);
      } else if (typeof core.removeListener === 'function') {
        this.removeCoreErrorListener = () => core.removeListener('error', onCoreError);
      }
      return;
    }
    if (typeof core.addListener === 'function') {
      core.addListener('error', onCoreError);
      if (typeof core.removeListener === 'function') {
        this.removeCoreErrorListener = () => core.removeListener('error', onCoreError);
      } else if (typeof core.off === 'function') {
        this.removeCoreErrorListener = () => core.off('error', onCoreError);
      }
      return;
    }
    this.coreEventsSupported = false;
  }

  updateSeekWarmup(inventory) {
    if (!this.seekActive || this.seekClassification !== 'long' || this.seekWarmupComplete) {
      return;
    }
    if (inventory < this.config.startupBufferSeconds) {
      return;
    }
    this.seekWarmupComplete = true;
    this.seekWarmupActive = false;
    this.startupComplete = true;
  }

  handleSeeking() {
    const previousUserPaused = this.userPaused;
    const previousScriptPaused = this.scriptPaused && !previousUserPaused;
    const previousPlaying = this.lastKnownPlaying || !this.video.paused;
    const previousOwner = previousUserPaused
      ? 'user-paused'
      : previousScriptPaused
        ? 'script-paused'
        : previousPlaying
          ? 'playing'
          : 'paused';
    this.seekEpoch += 1;
    this.playbackAttemptToken += 1;
    this.invalidatePendingPlayGuards();
    this.userPauseGuard = false;
    this.seekActive = true;
    this.seekTargetTime = this.video.currentTime;
    this.seekClassification = this.remainingDuration() <= this.config.startupBufferSeconds ? 'short' : 'long';
    this.seekRefillDisabled = this.seekClassification === 'short';
    this.seekWarmupComplete = this.seekClassification === 'short';
    this.seekWarmupActive = this.seekClassification === 'long';
    this.seekPlaybackOwner = previousOwner;
    this.seekResumePending = previousOwner === 'playing' || previousOwner === 'script-paused';
    this.userPaused = previousOwner === 'user-paused';
    this.scriptPaused = previousOwner === 'script-paused';
    this.startupComplete = this.seekClassification === 'short';
    this.ended = false;
    this.mediaMetricsBoundaryPending = true;
    if (this.message === BANDWIDTH_INSUFFICIENT_MESSAGE) {
      this.message = '';
    }
    if (this.enabled) {
      this.setPlaybackRate();
    }
    this.updateStatus();
  }

  handleSeeked() {
    if (this.destroyed || !this.enabled || !this.seekActive || this.video.seeking === true) {
      return;
    }
    if (
      this.currentCore === undefined ||
      this.currentCore.stale === true ||
      currentMediaSource(this.video) !== this.currentSrc
    ) {
      if (this.started) {
        void this.reconcile();
      }
      return;
    }
    const epoch = this.seekEpoch;
    const inventory = this.readInventory(this.currentCore);
    if (epoch !== this.seekEpoch || this.destroyed || !this.enabled) {
      return;
    }
    this.updateSeekWarmup(inventory);
    this.setPlaybackRate();
    if (!this.userPaused && this.seekResumePending) {
      if (this.video.paused) {
        this.attemptPlay(epoch);
      } else {
        this.seekResumePending = false;
      }
    }
    if (this.currentCore !== undefined) {
      this.enforceStartupAndRefill(this.currentCore, epoch);
    }
    this.updateStatus();
    if (this.started) {
      void this.reconcile();
    }
  }

  invalidateSeekCallbacksForRebuild() {
    this.seekEpoch += 1;
    this.playbackAttemptToken += 1;
    this.invalidatePendingPlayGuards();
    this.userPauseGuard = false;
  }

  clearSeekState() {
    this.seekActive = false;
    this.seekClassification = 'none';
    this.seekWarmupActive = false;
    this.seekWarmupComplete = false;
    this.seekRefillDisabled = false;
    this.seekPlaybackOwner = 'none';
    this.seekResumePending = false;
    this.seekTargetTime = undefined;
  }

  async reconcile() {
    if (this.destroyed || !this.enabled) {
      return;
    }
    let reconcileEpoch = this.seekEpoch;
    try {
      if (currentMediaSource(this.video) === '') {
        return;
      }
      const preparation = this.beforeReconcile();
      if (preparation instanceof Promise) {
        await preparation;
      }
      if (this.destroyed || !this.enabled || reconcileEpoch !== this.seekEpoch) {
        return;
      }
      const core = getCore(this.windowObject);
      const source = currentMediaSource(this.video);
      if (source === '') {
        return;
      }
      const location = this.windowObject.location?.href || '';
      const sessionKey = logicalVideoSession(this.windowObject.location);
      const coreChanged = core !== this.currentCore;
      const sourceChanged = source !== this.currentSrc;
      const sessionChanged = coreChanged || sourceChanged || location !== this.currentLocation;
      const logicalSessionChanged =
        this.currentSessionKey === undefined || sessionKey !== this.currentSessionKey;
      const rebuilt = sessionChanged;
      if (rebuilt) {
        this.invalidateSeekCallbacksForRebuild();
        reconcileEpoch = this.seekEpoch;
        this.currentCore = core;
        this.currentSrc = source;
        this.currentLocation = location;
        this.currentSessionKey = sessionKey;
        if (logicalSessionChanged) {
          this.bufferPolicy.resetForNewSession();
          this.startupComplete = false;
          this.clearSeekState();
          if (!this.userPaused) {
            this.scriptPaused = false;
          }
        }
        this.ended = false;
        if (coreChanged || sourceChanged) {
          this.replaceCoreErrorListener(core);
        }
        this.mediaMetricsBoundaryPending = true;
      } else {
        this.currentSessionKey = sessionKey;
      }
      this.setPlaybackRate();
      this.ensurePlayback(reconcileEpoch);
      const evidence = readQualitySnapshot(this.windowObject.player, core, {
        logger: this.logger,
        video: this.video,
      });
      this.qualityStatus = formatQualityEvidence(evidence);
      const policyResult = this.bufferPolicy.apply(core);
      this.stableBufferSupported = policyResult.stableBufferSupported;
      this.pausedSchedulingSupported = policyResult.pausedSchedulingSupported;
      const policyWarnings = [...policyResult.warnings];
      if (!this.coreEventsSupported) {
        policyWarnings.push('当前内核没有错误事件能力，quota 仅依赖 video error');
      }
      this.policyMessage = policyWarnings.join('；');
      if (this.destroyed || !this.enabled || reconcileEpoch !== this.seekEpoch) {
        return;
      }
      if (rebuilt && logicalSessionChanged && this.message.length > 0) {
        this.message = '';
      }
      this.detectExternalBufferDowngrade(core);
      this.enforceStartupAndRefill(core, reconcileEpoch);
    } catch (error) {
      if (this.destroyed || !this.enabled || reconcileEpoch !== this.seekEpoch) {
        return;
      }
      const normalized = toBufferScriptError(error, 'VOD_RECONCILE_FAILED', '点播策略施加失败');
      this.logger.error('点播策略施加失败', normalized);
      this.message = `${normalized.code}: ${normalized.message}`;
    }
    this.updateStatus();
  }

  enforceStartupAndRefill(core, epoch = this.seekEpoch) {
    if (this.destroyed || !this.enabled || epoch !== this.seekEpoch) {
      return;
    }
    const inventory = this.readInventory(core);
    const remaining = this.remainingDuration();
    const initialFillTarget = Math.min(this.config.startupBufferSeconds, remaining);
    const refillResumeTarget = Math.min(this.config.startupBufferSeconds, Math.max(0, remaining - 1));
    if (this.userPaused) {
      return;
    }
    if (this.seekActive) {
      this.updateSeekWarmup(inventory);
      if (this.seekWarmupActive || this.seekRefillDisabled) {
        return;
      }
    }
    if (remaining <= 30) {
      if (this.scriptPaused) {
        this.attemptPlay(epoch);
      }
      return;
    }
    if (!this.startupComplete) {
      if (inventory >= initialFillTarget) {
        this.startupComplete = true;
      }
      return;
    }
    if (this.scriptPaused) {
      if (inventory >= refillResumeTarget) {
        this.attemptPlay(epoch);
      }
      return;
    }
    if (inventory < this.config.lowBufferSeconds && !this.video.paused && this.pausedSchedulingSupported) {
      this.pauseForRefill();
    } else if (inventory < this.config.lowBufferSeconds && !this.pausedSchedulingSupported) {
      this.policyMessage = '库存低于 30 秒，但内核不支持暂停时继续下载，保持播放';
    }
  }

  setPlaybackRate() {
    if (!this.enabled || this.destroyed) {
      return;
    }
    this.internalRateChange = true;
    try {
      this.video.playbackRate = this.config.playbackRate;
    } finally {
      this.internalRateChange = false;
    }
  }

  ensurePlayback(epoch = this.seekEpoch) {
    if (
      !this.enabled ||
      this.destroyed ||
      this.userPaused ||
      this.scriptPaused ||
      this.ended ||
      epoch !== this.seekEpoch ||
      !this.video.paused
    ) {
      return;
    }
    this.attemptPlay(epoch);
  }

  removePendingPlayGuard(guard) {
    const index = this.pendingPlayGuards.indexOf(guard);
    if (index >= 0) {
      this.pendingPlayGuards.splice(index, 1);
    }
  }

  invalidatePendingPlayGuards() {
    for (const guard of this.pendingPlayGuards) {
      guard.invalidated = true;
      this.retirePlayGuard(guard);
    }
    this.pendingPlayGuards = [];
  }

  currentPlayGuard(epoch = this.seekEpoch) {
    return this.pendingPlayGuards.find(
      (guard) => !guard.invalidated && guard.epoch === epoch && guard.token === this.playbackAttemptToken,
    );
  }

  retirePlayGuard(guard) {
    if (guard.playEventSeen || guard.retired) {
      return;
    }
    guard.retired = true;
    this.retiredPlayGuards.push(guard);
  }

  removeRetiredPlayGuard(guard) {
    const index = this.retiredPlayGuards.indexOf(guard);
    if (index >= 0) {
      this.retiredPlayGuards.splice(index, 1);
    }
  }

  consumeRetiredPlayGuard() {
    const guard = this.retiredPlayGuards.find((candidate) => !candidate.playEventSeen);
    if (guard === undefined) {
      return undefined;
    }
    guard.playEventSeen = true;
    this.removeRetiredPlayGuard(guard);
    return guard;
  }

  finalizePlayGuard(guard) {
    if (guard.promiseSettled && guard.playEventSeen) {
      this.removePendingPlayGuard(guard);
      this.removeRetiredPlayGuard(guard);
    }
  }

  attemptPlay(epoch = this.seekEpoch) {
    if (
      !this.enabled ||
      this.destroyed ||
      this.userPaused ||
      this.ended ||
      epoch !== this.seekEpoch ||
      !this.video.paused
    ) {
      return;
    }
    if (this.currentPlayGuard(epoch) !== undefined) {
      return;
    }
    const token = this.playbackAttemptToken + 1;
    this.playbackAttemptToken = token;
    const guard = {
      epoch,
      token,
      releasesScriptPause: this.scriptPaused,
      promiseSettled: false,
      playEventSeen: false,
      invalidated: false,
      retired: false,
    };
    this.pendingPlayGuards.push(guard);
    let playPromise;
    try {
      playPromise = this.video.play();
    } catch (error) {
      playPromise = Promise.reject(error);
    }
    Promise.resolve(playPromise)
      .then(() => {
        guard.promiseSettled = true;
        if (
          this.destroyed ||
          !this.enabled ||
          this.userPaused ||
          this.ended ||
          guard.invalidated ||
          epoch !== this.seekEpoch ||
          token !== this.playbackAttemptToken
        ) {
          this.retirePlayGuard(guard);
          if (this.userPaused) {
            this.enforceUserPause();
          }
          this.finalizePlayGuard(guard);
          return;
        }
        if (guard.releasesScriptPause) {
          this.scriptPaused = false;
        }
        this.seekResumePending = false;
        this.setPlaybackRate();
        this.finalizePlayGuard(guard);
      })
      .catch((error) => {
        this.removePendingPlayGuard(guard);
        this.removeRetiredPlayGuard(guard);
        if (
          this.destroyed ||
          !this.enabled ||
          this.userPaused ||
          this.ended ||
          guard.invalidated ||
          epoch !== this.seekEpoch ||
          token !== this.playbackAttemptToken
        ) {
          return;
        }
        if (guard.releasesScriptPause) {
          this.scriptPaused = true;
        }
        this.logger.error('点播自动播放被拒绝', error);
        this.message = `浏览器未允许自动播放: ${error.message || error}`;
      });
  }

  detectExternalBufferDowngrade(core) {
    if (!this.enabled || this.destroyed) {
      return;
    }
    for (const getter of ['getStableBufferTime', 'getStableBufferSeconds']) {
      if (!coreSupports(core, getter)) {
        continue;
      }
      try {
        const target = Number(core[getter]());
        if (Number.isFinite(target) && target < this.bufferPolicy.targetSeconds) {
          this.bufferPolicy.targetSeconds = target;
          this.message = `内核主动将稳定缓冲降为 ${target} 秒，脚本不循环强设更大缓冲`;
          this.logger.warn(this.message);
        }
      } catch (error) {
        this.logger.warn(`读取点播 ${getter} 失败`, error);
      }
    }
  }

  handleQuotaError(error) {
    if (!this.enabled || this.destroyed) {
      return;
    }
    if (this.currentCore === undefined) {
      this.logger.error('收到 MSE quota 错误，但当前没有点播内核', error);
      this.message = `MSE quota 错误: ${error.message || error}`;
      return;
    }
    try {
      const result = this.bufferPolicy.handleQuota(this.currentCore);
      this.message = `MSE 配额降级为 ${result.quotaFallback} 秒；不再强设更大缓冲`;
      this.logger.warn(this.message, error);
    } catch (quotaError) {
      this.logger.error('点播 MSE 配额降级耗尽', quotaError);
      this.message = `${quotaError.code}: ${quotaError.message}`;
    }
  }

  refreshQualityStatus() {
    if (this.destroyed || !this.enabled || this.currentCore === undefined) {
      return;
    }
    try {
      const evidence = readQualitySnapshot(this.windowObject.player, this.currentCore, {
        logger: this.logger,
        video: this.video,
      });
      this.qualityStatus = formatQualityEvidence(evidence);
      this.panel.setModel({ quality: this.qualityStatus });
    } catch (error) {
      this.logger.error('刷新点播画质诊断失败', error);
      this.message = `画质诊断不可用: ${error.message || error}`;
    }
  }

  updateStatus() {
    if (this.destroyed || !this.started) {
      return;
    }
    if (!this.enabled) {
      this.panel.setAction('toggle', '启用', () => this.toggleEnabled());
      this.panel.setAction('skip-gap', '', () => {}, false);
      this.panel.setAction('return-live', '', () => {}, false);
      return;
    }
    this.refreshQualityStatus();
    let inventory = 0;
    let metrics = {};
    if (this.currentCore !== undefined) {
      try {
        const nowMilliseconds = this.windowObject.performance.now();
        if (this.mediaMetricsBoundaryPending) {
          this.mediaMetricsStartMilliseconds = nowMilliseconds;
          this.mediaMetricsBoundaryPending = false;
        }
        inventory = readForwardInventory(this.video, this.currentCore);
        const bitrate = readMediaBitrate(this.currentCore);
        metrics = calculateDownloadMultiplier(
          activeSessionPerformance(this.windowObject.performance, this.mediaMetricsStartMilliseconds),
          nowMilliseconds,
          bitrate,
          this.config.playbackRate,
        );
      } catch (error) {
        if (isStaleCoreError(error)) {
          this.logger.warn('忽略已过期点播缓冲指标回调', error);
        } else {
          this.logger.error('读取点播缓冲或下载指标失败', error);
          this.message = `指标不可用: ${error.message || error}`;
        }
      }
    }
    const thirty = metrics[30]?.multiplier;
    const sixty = metrics[60]?.multiplier;
    const multiplier =
      thirty === undefined || sixty === undefined
        ? '30/60 秒：码率不可用'
        : `30 秒 ${thirty.toFixed(2)}× / 60 秒 ${sixty.toFixed(2)}×`;
    if (thirty !== undefined && sixty !== undefined && Math.min(thirty, sixty) < 1) {
      this.message = BANDWIDTH_INSUFFICIENT_MESSAGE;
    } else if (thirty !== undefined && sixty !== undefined && this.message === BANDWIDTH_INSUFFICIENT_MESSAGE) {
      this.message = '';
    }
    const state = this.ended ? 'ENDED' : this.userPaused ? 'USER_PAUSED' : this.scriptPaused ? 'REFILLING' : 'VOD_READY';
    const displayMessage = [this.message, this.policyMessage].filter(Boolean).join('；');
    this.panel.setModel({
      mode: '点播',
      state,
      inventory: `${inventory.toFixed(1)} 秒`,
      delay: '不适用',
      quality: this.qualityStatus,
      speed: `${this.config.playbackRate}×`,
      multiplier,
      message: displayMessage,
    });
    this.panel.setAction('toggle', '停用', () => this.toggleEnabled());
    this.panel.setAction('skip-gap', '', () => {}, false);
    this.panel.setAction('return-live', '', () => {}, false);
  }

  toggleEnabled() {
    this.enabled = !this.enabled;
    this.invalidateSeekCallbacksForRebuild();
    if (!this.enabled) {
      this.scriptPaused = false;
      this.seekResumePending = false;
    } else {
      void this.reconcile();
    }
    this.updateStatus();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.enabled = false;
    this.invalidateSeekCallbacksForRebuild();
    this.clearSeekState();
    this.started = false;
    if (this.pollTimer !== undefined) {
      this.runtimeObject.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.statusTimer !== undefined) {
      this.runtimeObject.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    for (const [name, callback] of this.boundEvents) {
      this.video.removeEventListener(name, callback);
    }
    if (this.removeCoreErrorListener !== undefined) {
      this.removeCoreErrorListener();
      this.removeCoreErrorListener = undefined;
    }
  }
}

export { getCore };
