import { VOD_CONFIG } from '../constants.js';
import { fail, toBufferScriptError } from '../errors.js';
import { MediaEventRecorder } from '../diagnostics/media.js';
import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';
import { computeForwardInventory, copyTimeRanges } from './buffer.js';

const WAITING_MESSAGE = '等待原生 video、媒体 source 和播放器内核';

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

function currentVideoSource(video) {
  return video?.currentSrc || video?.src || '';
}

function readNativeForwardBuffer(video) {
  if (video === undefined) return 0;
  return computeForwardInventory(video.currentTime, [copyTimeRanges(video.buffered)]);
}

function isWaitingForBridge(error) {
  return ['PLAYER_UNAVAILABLE', 'VOD_CORE_UNAVAILABLE', 'BRIDGE_CORE_STALE'].includes(error?.code);
}

export class VodBufferController {
  constructor({
    video,
    panel,
    runtimeObject = globalThis,
    logger = createLogger(),
    refreshCore,
    getVideo = () => video,
    onGeneration = () => {},
    diagnostics,
    config = VOD_CONFIG,
  }) {
    if (typeof refreshCore !== 'function') {
      fail('VOD_CORE_REFRESH_INVALID', '视频增强缺少播放器内核刷新函数');
    }
    this.video = video;
    this.getVideo = getVideo;
    this.onGeneration = onGeneration;
    this.diagnostics = diagnostics;
    this.panel = panel;
    this.runtimeObject = runtimeObject;
    this.logger = logger;
    this.refreshCore = refreshCore;
    this.config = config;
    this.currentCore = undefined;
    this.currentSource = '';
    this.generation = 0;
    this.generationResult = undefined;
    this.videoInstance = 0;
    this.sourceInstance = 0;
    this.coreInstance = 0;
    this.mediaRecorder = undefined;
    this.hintState = 'WAITING';
    this.message = WAITING_MESSAGE;
    this.reconcileTimer;
    this.statusTimer;
    this.started = false;
    this.destroyed = false;
  }

  start() {
    if (this.destroyed) {
      fail('VOD_DESTROYED', '视频增强已经销毁');
    }
    if (this.started) {
      fail('VOD_ALREADY_STARTED', '视频增强已经启动');
    }
    this.started = true;
    this.ensureMediaRecorder();
    this.reconcileTimer = this.runtimeObject.setInterval(() => {
      void this.reconcile();
    }, 500);
    this.statusTimer = this.runtimeObject.setInterval(() => {
      this.updateStatus();
    }, 500);
    this.updateStatus();
    void this.reconcile();
  }

  async reconcile() {
    if (this.destroyed || !this.started) {
      return;
    }
    const selectedVideo = this.getVideo();
    if (selectedVideo !== undefined && selectedVideo !== this.video) {
      this.mediaRecorder?.destroy();
      this.mediaRecorder = undefined;
      this.video = selectedVideo;
      this.currentCore = undefined;
      this.currentSource = '';
      this.generationResult = undefined;
      this.videoInstance += 1;
      this.onGeneration(this.generationContext('video_replaced'));
      this.diagnostics?.log('video.replaced', { reason: 'video_replaced' }, undefined, this.generationContext('video_replaced'));
      this.ensureMediaRecorder();
    }
    const source = currentVideoSource(this.video);
    if (source === '') {
      this.hintState = 'WAITING';
      this.message = WAITING_MESSAGE;
      this.updateStatus();
      return;
    }
    try {
      const core = await this.refreshCore();
      if (this.destroyed || !this.started) {
        return;
      }
      if (core === undefined || core === null) {
        fail('VOD_CORE_UNAVAILABLE', '播放器内核刷新没有返回当前内核');
      }
      if (selectedVideo !== this.video || selectedVideo !== this.getVideo()) {
        return;
      }
      const currentSource = currentVideoSource(this.video);
      if (currentSource === '' || currentSource !== core.snapshot.source) {
        this.hintState = 'WAITING';
        this.message = WAITING_MESSAGE;
        this.updateStatus();
        return;
      }
      const generationChanged = core !== this.currentCore || currentSource !== this.currentSource;
      if (generationChanged) {
        const coreChanged = core !== this.currentCore;
        const sourceChanged = currentSource !== this.currentSource;
        this.currentCore = core;
        this.currentSource = currentSource;
        if (this.videoInstance === 0) this.videoInstance = 1;
        if (this.sourceInstance === 0 || sourceChanged) this.sourceInstance += 1;
        if (this.coreInstance === 0 || coreChanged) this.coreInstance += 1;
        this.generation += 1;
        this.generationResult = undefined;
        this.hintState = 'WAITING';
        this.message = '';
        this.onGeneration(this.generationContext(sourceChanged ? 'source_replaced' : 'core_replaced'));
        if (sourceChanged) {
          this.diagnostics?.log('video.source_replaced', {
            source: currentSource,
            reason: 'source_replaced',
          }, undefined, this.generationContext('source_replaced'));
        }
        if (coreChanged) {
          this.diagnostics?.log('video.core_replaced', {
            source: currentSource,
            reason: 'core_replaced',
          }, undefined, this.generationContext('core_replaced'));
        }
        this.applyHintForGeneration(core);
      } else if (this.hintState === 'WAITING' && this.generationResult !== undefined) {
        this.hintState = this.generationResult.state;
        this.message = this.generationResult.message;
      }
    } catch (error) {
      if (this.destroyed || !this.started) {
        return;
      }
      if (isWaitingForBridge(error)) {
        this.hintState = 'WAITING';
        this.message = WAITING_MESSAGE;
      } else {
        const normalized = toBufferScriptError(error, 'VOD_RECONCILE_FAILED', '视频播放器内核刷新失败');
        this.logger.error('视频播放器内核刷新失败', normalized);
        this.hintState = 'WAITING';
        this.message = `${normalized.code}: ${normalized.message}`;
      }
    }
    this.updateStatus();
  }

  applyHintForGeneration(core) {
    try {
      if (core.supports('setStableBufferTime') !== true) {
        this.hintState = 'UNSUPPORTED';
        this.message = `当前内核不支持 ${this.config.stableBufferSeconds} 秒原生缓存提示`;
        this.generationResult = { state: this.hintState, message: this.message };
        this.diagnostics?.log('video.buffer_hint.unsupported', {
          targetSeconds: this.config.stableBufferSeconds,
          reason: 'capability_missing',
        }, undefined, this.generationContext('buffer_hint'));
        return;
      }
      this.diagnostics?.log('video.buffer_hint.attempt', {
        targetSeconds: this.config.stableBufferSeconds,
      }, undefined, this.generationContext('buffer_hint'));
      core.setStableBufferTime(this.config.stableBufferSeconds);
      let actualSeconds = UNKNOWN_VALUE;
      try {
        const measured = this.readForwardBuffer();
        if (Number.isFinite(measured)) actualSeconds = measured;
      } catch (error) {
        this.diagnostics?.log('extension.observer_error', {
          reason: 'buffer-hint-actual-read',
        }, error, this.generationContext('buffer_hint'));
      }
      this.hintState = 'APPLIED';
      this.message = '';
      this.diagnostics?.log('video.buffer_hint.applied', {
        targetSeconds: this.config.stableBufferSeconds,
        actualSeconds,
      }, undefined, this.generationContext('buffer_hint'));
    } catch (error) {
      if (error?.code === 'BRIDGE_CORE_STALE') {
        this.currentCore = undefined;
        this.currentSource = '';
        this.hintState = 'WAITING';
        this.message = WAITING_MESSAGE;
        return;
      }
      const normalized = toBufferScriptError(error, 'VOD_STABLE_BUFFER_FAILED', '原生缓存提示调用失败');
      this.logger.error('原生缓存提示调用失败', normalized);
      this.hintState = 'FAILED';
      this.message = `${normalized.code}: ${normalized.message}`;
      this.diagnostics?.log('video.buffer_hint.failed', {
        targetSeconds: this.config.stableBufferSeconds,
        reason: normalized.code,
      }, normalized, this.generationContext('buffer_hint'));
    }
    this.generationResult = { state: this.hintState, message: this.message };
  }

  readForwardBuffer() {
    return readNativeForwardBuffer(this.video);
  }

  generationContext(reason) {
    return {
      videoInstance: this.videoInstance || undefined,
      sourceInstance: this.sourceInstance || undefined,
      coreInstance: this.coreInstance || undefined,
      source: this.currentSource,
      reason,
    };
  }

  ensureMediaRecorder() {
    if (this.diagnostics === undefined || this.video === undefined || this.mediaRecorder !== undefined) return;
    if (this.videoInstance === 0) this.videoInstance = 1;
    this.diagnostics.markVideoAvailable();
    this.diagnostics.log('video.attached', {
      source: currentVideoSource(this.video),
      reason: 'video_bound',
    }, undefined, this.generationContext('video_attached'));
    this.mediaRecorder = new MediaEventRecorder({
      video: this.video,
      logger: this.diagnostics,
      runtimeObject: this.runtimeObject,
      context: () => this.generationContext('media'),
    });
    this.mediaRecorder.start();
  }

  updateStatus() {
    if (this.destroyed || !this.started) {
      return;
    }
    let inventory = '未提供';
    if (this.video !== undefined) {
      inventory = `${this.readForwardBuffer().toFixed(1)} 秒`;
    }
    this.panel.setModel({
      mode: '视频',
      state: this.hintState,
      buffered: inventory,
      target: `${this.config.stableBufferSeconds} 秒`,
      error: this.message,
    });
  }

  refreshStatus() {
    this.updateStatus();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.started = false;
    this.diagnostics?.log('video.destroyed', { reason: 'controller_destroyed' }, undefined, this.generationContext('destroyed'));
    if (this.reconcileTimer !== undefined) {
      this.runtimeObject.clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.statusTimer !== undefined) {
      this.runtimeObject.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.mediaRecorder?.destroy();
    this.mediaRecorder = undefined;
  }
}
