import { VOD_CONFIG } from '../constants.js';
import { BufferScriptError, fail, toBufferScriptError } from '../errors.js';
import { readForwardInventory } from './buffer.js';
import { calculateDownloadMultiplier } from './metrics.js';
import { VodBufferPolicy, callQualityMethod, coreSupports, readMediaBitrate, readQualitySnapshot } from './policy.js';

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

function currentQualityNumber(core) {
  return readQualitySnapshot(core).qn;
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

function delay(milliseconds, runtimeObject) {
  return new Promise((resolve) => runtimeObject.setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, runtimeObject, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = runtimeObject.setTimeout(
          () => reject(new BufferScriptError('VOD_QUALITY_CONFIRM_TIMEOUT', message)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      runtimeObject.clearTimeout(timer);
    }
  }
}

function errorFromCoreEvent(event) {
  return event?.error ?? event?.detail?.error ?? event?.detail ?? event;
}

const BANDWIDTH_INSUFFICIENT_MESSAGE = '下载不足以覆盖当前 2× 消耗，有限缓冲最终会耗尽';

function qualityRequestKey({ requestToken, observationToken }) {
  return `${requestToken}:${observationToken}`;
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
    this.currentQuality = '';
    this.currentSessionKey;
    this.qualityRequestPromises = new Map();
    this.qualitySettledCore;
    this.qualitySettledSource = '';
    this.qualitySettledSession = '';
    this.qualitySessionToken = 0;
    this.qualityObservationToken = 0;
    this.qualityObserved = false;
    this.qualityObservedQn;
    this.qualityAttemptedForObservation = false;
    this.qualityConfirmed = false;
    this.pollTimer;
    this.statusTimer;
    this.enabled = true;
    this.userPaused = false;
    this.scriptPaused = false;
    this.scriptPauseEvent = false;
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
      if (this.scriptPauseEvent) {
        this.scriptPauseEvent = false;
        return;
      }
      this.scriptPaused = false;
      this.userPaused = true;
    };
    const onPlay = () => {
      if (!this.enabled) {
        this.scriptPauseEvent = false;
        this.scriptPaused = false;
        this.userPaused = false;
        return;
      }
      this.userPaused = false;
      if (this.scriptPaused && this.startupComplete && this.currentCore !== undefined) {
        const inventory = readForwardInventory(this.video, this.currentCore);
        const remaining = Number.isFinite(this.video.duration)
          ? Math.max(0, this.video.duration - this.video.currentTime)
          : Number.POSITIVE_INFINITY;
        const target = Math.min(this.config.startupBufferSeconds, remaining);
        if (remaining > 30 && this.pausedSchedulingSupported && inventory < target) {
          this.pauseForRefill();
        }
      }
    };
    const onEnded = () => {
      this.ended = true;
      this.scriptPaused = false;
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
    this.addVideoListener('ended', onEnded);
    this.addVideoListener('error', onError);
  }

  addVideoListener(name, callback) {
    this.video.addEventListener(name, callback);
    this.boundEvents.push([name, callback]);
  }

  pauseForRefill() {
    if (this.video.paused) {
      return;
    }
    this.scriptPauseEvent = true;
    this.scriptPaused = true;
    this.video.pause();
  }

  replaceCoreErrorListener(core) {
    if (this.removeCoreErrorListener !== undefined) {
      this.removeCoreErrorListener();
      this.removeCoreErrorListener = undefined;
    }
    const onCoreError = (event) => {
      if (!this.enabled || core !== this.currentCore) {
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

  createQualityRequestIdentity(
    core,
    requestToken = this.qualitySessionToken,
    observationToken = this.qualityObservationToken,
  ) {
    return {
      core,
      source: currentMediaSource(this.video),
      session: logicalVideoSession(this.windowObject.location),
      requestToken,
      observationToken,
      verifyCore: typeof this.windowObject.player?.__core === 'function',
    };
  }

  isQualityRequestCurrent({ core, source, session, requestToken, verifyCore }) {
    if (
      this.destroyed ||
      !this.enabled ||
      core?.stale === true ||
      requestToken !== this.qualitySessionToken ||
      source !== currentMediaSource(this.video) ||
      session !== logicalVideoSession(this.windowObject.location)
    ) {
      return false;
    }
    const readCore = this.windowObject.player?.__core;
    return !verifyCore || (typeof readCore === 'function' && readCore() === core);
  }

  isQualityObservationCurrent(requestIdentity) {
    return (
      this.isQualityRequestCurrent(requestIdentity) &&
      requestIdentity.observationToken === this.qualityObservationToken
    );
  }

  observeQuality(qualityNumber) {
    const changed = !this.qualityObserved || this.qualityObservedQn !== qualityNumber;
    this.qualityObserved = true;
    this.qualityObservedQn = qualityNumber;
    if (changed) {
      this.qualityObservationToken += 1;
      this.qualityAttemptedForObservation = false;
    }
    return changed;
  }

  async reconcile() {
    if (this.destroyed || !this.enabled) {
      return;
    }
    try {
      if (currentMediaSource(this.video) === '') {
        return;
      }
      const preparation = this.beforeReconcile();
      if (preparation instanceof Promise) {
        await preparation;
      }
      if (this.destroyed || !this.enabled) {
        return;
      }
      const core = getCore(this.windowObject);
      const source = currentMediaSource(this.video);
      if (source === '') {
        return;
      }
      this.setPlaybackRate();
      const location = this.windowObject.location?.href || '';
      const sessionKey = logicalVideoSession(this.windowObject.location);
      const qualityNumber = currentQualityNumber(core);
      const quality = qualityNumber === undefined ? '页面当前画质' : String(qualityNumber);
      const coreChanged = core !== this.currentCore;
      const sourceChanged = source !== this.currentSrc;
      const sessionChanged =
        coreChanged || sourceChanged || location !== this.currentLocation;
      const logicalSessionChanged =
        this.currentSessionKey === undefined || sessionKey !== this.currentSessionKey;
      const rebuilt = sessionChanged;
      this.currentQuality = quality;
      this.currentSessionKey = sessionKey;
      if (rebuilt) {
        this.currentCore = core;
        this.currentSrc = source;
        this.currentLocation = location;
        if (logicalSessionChanged) {
          this.bufferPolicy.resetForNewSession();
          this.startupComplete = false;
        }
        this.ended = false;
        if (coreChanged || sourceChanged) {
          this.replaceCoreErrorListener(core);
        }
        this.mediaMetricsBoundaryPending = true;
        this.qualitySessionToken += 1;
        this.qualityRequestPromises.clear();
        this.qualityObserved = false;
        this.qualityObservedQn = undefined;
        this.qualityAttemptedForObservation = false;
        this.qualityConfirmed = false;
        this.qualitySettledCore = undefined;
        this.qualitySettledSource = '';
        this.qualitySettledSession = '';
      }
      const policyResult = this.bufferPolicy.apply(core);
      this.stableBufferSupported = policyResult.stableBufferSupported;
      this.pausedSchedulingSupported = policyResult.pausedSchedulingSupported;
      const policyWarnings = [...policyResult.warnings];
      if (!this.coreEventsSupported) {
        policyWarnings.push('当前内核没有错误事件能力，quota 仅依赖 video error');
      }
      this.policyMessage = policyWarnings.join('；');
      const requestIdentity = this.createQualityRequestIdentity(core);
      await this.reconcileQuality(core, qualityNumber, requestIdentity);
      if (!this.isQualityObservationCurrent(requestIdentity)) {
        return;
      }
      if (rebuilt) {
        this.message = '';
      }
      this.detectExternalBufferDowngrade(core);
      this.enforceStartupAndRefill(core);
    } catch (error) {
      if (this.destroyed || !this.enabled) {
        return;
      }
      const normalized = toBufferScriptError(error, 'VOD_RECONCILE_FAILED', '点播策略施加失败');
      this.logger.error('点播策略施加失败', normalized);
      this.message = `${normalized.code}: ${normalized.message}`;
    }
    this.updateStatus();
  }

  async reconcileQuality(core, qualityNumber, requestIdentity = this.createQualityRequestIdentity(core)) {
    if (!this.isQualityRequestCurrent(requestIdentity)) {
      return;
    }
    const observationChanged = this.observeQuality(qualityNumber);
    requestIdentity.observationToken = this.qualityObservationToken;
    if (qualityNumber === this.config.qualityNumber) {
      this.qualityConfirmed = true;
      this.qualityAttemptedForObservation = false;
      this.qualityStatus = `720P/qn${this.config.qualityNumber} 已生效`;
      return;
    }
    this.qualityConfirmed = false;
    if (!observationChanged && this.qualityAttemptedForObservation) {
      return;
    }
    this.qualityAttemptedForObservation = true;
    const actual = qualityNumber === undefined ? '未知' : `qn${qualityNumber}`;
    this.qualityStatus = `正在请求 720P/qn${this.config.qualityNumber}（检测到实际画质 ${actual}）`;
    await this.requestQuality(core, { force: true, requestIdentity });
    if (!this.isQualityObservationCurrent(requestIdentity)) {
      return;
    }
    const after = currentQualityNumber(core);
    this.observeQuality(after);
    requestIdentity.observationToken = this.qualityObservationToken;
    if (after === this.config.qualityNumber) {
      this.qualityConfirmed = true;
      this.qualityAttemptedForObservation = false;
      this.qualityStatus = `720P/qn${this.config.qualityNumber} 已生效`;
    } else {
      this.qualityConfirmed = false;
    }
  }

  async requestQuality(core, { force = false, requestIdentity = this.createQualityRequestIdentity(core) } = {}) {
    if (!this.isQualityObservationCurrent(requestIdentity)) {
      return;
    }
    const { session, source } = requestIdentity;
    if (
      !force &&
      this.isQualityRequestCurrent(requestIdentity) &&
      this.qualitySettledCore === core &&
      this.qualitySettledSource === source &&
      this.qualitySettledSession === session
    ) {
      return;
    }
    const requestKey = qualityRequestKey(requestIdentity);
    const pending = this.qualityRequestPromises.get(requestKey);
    if (pending !== undefined) {
      return pending;
    }
    let requestPromise;
    requestPromise = this.performQualityRequest(core, requestIdentity).finally(() => {
      if (this.isQualityObservationCurrent(requestIdentity)) {
        this.qualitySettledCore = core;
        this.qualitySettledSource = source;
        this.qualitySettledSession = session;
      }
      if (this.qualityRequestPromises.get(requestKey) === requestPromise) {
        this.qualityRequestPromises.delete(requestKey);
      }
    });
    this.qualityRequestPromises.set(requestKey, requestPromise);
    return requestPromise;
  }

  async performQualityRequest(core, requestIdentity = this.createQualityRequestIdentity(core)) {
    if (!this.isQualityObservationCurrent(requestIdentity)) {
      return;
    }
    const before = readQualitySnapshot(core);
    try {
      if (before.qn === this.config.qualityNumber) {
        if (this.isQualityObservationCurrent(requestIdentity)) {
          this.qualityStatus = `720P/qn${this.config.qualityNumber} 已生效`;
        }
        return;
      }
      if (before.availableQns.length > 0 && !before.availableQns.includes(this.config.qualityNumber)) {
        fail(
          'VOD_QUALITY_UNAVAILABLE',
          `当前播放器可用清晰度不包含 qn${this.config.qualityNumber}`,
        );
      }
      const request = callQualityMethod(this.windowObject.player, core, this.config.qualityNumber);
      await withTimeout(
        request,
        this.config.qualityConfirmTimeoutMilliseconds,
        this.runtimeObject,
        `qn${this.config.qualityNumber} 请求未在限定时间内完成`,
      );
      if (!this.isQualityObservationCurrent(requestIdentity)) {
        return;
      }
      const confirmed = await this.waitForQualityConfirmation(core, this.config.qualityNumber, requestIdentity);
      if (!confirmed || !this.isQualityObservationCurrent(requestIdentity)) {
        return;
      }
      this.qualityStatus = `720P/qn${this.config.qualityNumber} 已生效`;
    } catch (error) {
      const normalized = toBufferScriptError(error, 'VOD_QUALITY_UNAVAILABLE', '720P 不可用');
      if (!this.isQualityObservationCurrent(requestIdentity)) {
        this.logger.warn('忽略过期的点播 qn64 请求结果', normalized);
        return;
      }
      const after = readQualitySnapshot(core);
      if (before.qn === undefined) {
        const actual = after.qn === undefined ? '未知' : `qn${after.qn}`;
        this.qualityStatus =
          `720P/qn${this.config.qualityNumber} 未生效，当前实际画质 ${actual}（${normalized.message}）。请在 Bilibili 播放器手动选择 720P`;
      } else if (after.qn === before.qn) {
        this.qualityStatus =
          `720P/qn${this.config.qualityNumber} 未生效，保持原画质 qn${before.qn}（${normalized.message}）。请在 Bilibili 播放器手动选择 720P`;
      } else {
        const restored = await this.restoreQuality(core, before.qn, requestIdentity);
        if (!this.isQualityObservationCurrent(requestIdentity)) {
          return;
        }
        const current = readQualitySnapshot(core).qn;
        if (restored) {
          this.qualityStatus =
            `720P/qn${this.config.qualityNumber} 未生效，已恢复原画质 qn${before.qn}（${normalized.message}）`;
        } else {
          const actual = current === undefined ? '未知' : `qn${current}`;
          this.qualityStatus =
            `720P/qn${this.config.qualityNumber} 未生效，恢复原画质失败，当前实际画质 ${actual}（${normalized.message}）。请在 Bilibili 播放器手动选择 720P`;
        }
      }
      this.logger.warn('点播 qn64 未确认', normalized);
    }
  }

  async waitForQualityConfirmation(core, qualityNumber, requestIdentity = this.createQualityRequestIdentity(core)) {
    const deadline = Date.now() + this.config.qualityConfirmTimeoutMilliseconds;
    while (Date.now() <= deadline) {
      if (!this.isQualityObservationCurrent(requestIdentity)) {
        return false;
      }
      if (readQualitySnapshot(core).qn === qualityNumber) {
        return true;
      }
      await delay(this.config.qualityConfirmPollMilliseconds, this.runtimeObject);
    }
    fail('VOD_QUALITY_CONFIRM_TIMEOUT', `qn${qualityNumber} 请求完成但真实画质未确认`);
  }

  async restoreQuality(core, qualityNumber, requestIdentity = this.createQualityRequestIdentity(core)) {
    if (!this.isQualityObservationCurrent(requestIdentity)) {
      return false;
    }
    try {
      const request = callQualityMethod(this.windowObject.player, core, qualityNumber);
      await withTimeout(
        request,
        this.config.qualityConfirmTimeoutMilliseconds,
        this.runtimeObject,
        `原画质 qn${qualityNumber} 恢复超时`,
      );
      if (!this.isQualityObservationCurrent(requestIdentity)) {
        return false;
      }
      return this.waitForQualityConfirmation(core, qualityNumber, requestIdentity);
    } catch (error) {
      this.logger.error(`原画质 qn${qualityNumber} 恢复失败`, error);
      return false;
    }
  }

  setPlaybackRate() {
    if (!this.enabled) {
      return;
    }
    this.internalRateChange = true;
    this.video.playbackRate = this.config.playbackRate;
    this.internalRateChange = false;
  }

  enforceStartupAndRefill(core) {
    if (!this.enabled) {
      return;
    }
    const inventory = readForwardInventory(this.video, core);
    const remaining = Number.isFinite(this.video.duration)
      ? Math.max(0, this.video.duration - this.video.currentTime)
      : Number.POSITIVE_INFINITY;
    const refillTarget = Math.min(this.config.startupBufferSeconds, remaining);
    if (this.userPaused) {
      return;
    }
    if (remaining <= 30) {
      return;
    }
    if (!this.startupComplete) {
      if (inventory >= refillTarget) {
        this.startupComplete = true;
      }
      return;
    }
    if (this.scriptPaused) {
      if (inventory >= refillTarget) {
        this.attemptPlay();
      }
      return;
    }
    if (inventory < this.config.lowBufferSeconds && !this.video.paused && this.pausedSchedulingSupported) {
      this.pauseForRefill();
    } else if (inventory < this.config.lowBufferSeconds && !this.pausedSchedulingSupported) {
      this.policyMessage = '库存低于 30 秒，但内核不支持暂停时继续下载，保持播放';
    }
  }

  attemptPlay() {
    if (!this.enabled || this.userPaused || !this.video.paused) {
      return;
    }
    Promise.resolve(this.video.play())
      .then(() => {
        if (this.enabled && !this.userPaused) {
          this.scriptPaused = false;
        }
      })
      .catch((error) => {
        if (!this.enabled) {
          return;
        }
        this.scriptPaused = true;
        this.logger.error('点播补水完成后自动播放被拒绝', error);
        this.message = `浏览器未允许自动播放: ${error.message || error}`;
      });
  }

  detectExternalBufferDowngrade(core) {
    if (!this.enabled) {
      return;
    }
    for (const getter of ['getStableBufferTime', 'getStableBufferSeconds']) {
      if (!coreSupports(core, getter)) {
        continue;
      }
      const target = Number(core[getter]());
      if (Number.isFinite(target) && target < this.bufferPolicy.targetSeconds) {
        this.bufferPolicy.targetSeconds = target;
        this.message = `内核主动将稳定缓冲降为 ${target} 秒，脚本不循环强设 180 秒`;
        this.logger.warn(this.message);
      }
    }
  }

  handleQuotaError(error) {
    if (!this.enabled) {
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
        this.logger.error('读取点播缓冲或下载指标失败', error);
        this.message = `指标不可用: ${error.message || error}`;
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
    if (!this.enabled) {
      this.qualitySessionToken += 1;
      this.qualityObservationToken += 1;
      this.qualityRequestPromises.clear();
      this.qualityObserved = false;
      this.qualityObservedQn = undefined;
      this.qualityAttemptedForObservation = false;
      this.qualityConfirmed = false;
      this.qualitySettledCore = undefined;
      this.qualitySettledSource = '';
      this.qualitySettledSession = '';
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
    this.qualitySessionToken += 1;
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
