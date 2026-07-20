import { VOD_CONFIG } from '../constants.js';
import { fail, toBufferScriptError } from '../errors.js';
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
  return video.currentSrc || video.src || '';
}

function readNativeForwardBuffer(video) {
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
    config = VOD_CONFIG,
  }) {
    if (typeof refreshCore !== 'function') {
      fail('VOD_CORE_REFRESH_INVALID', '点播控制器缺少播放器内核刷新函数');
    }
    this.video = video;
    this.panel = panel;
    this.runtimeObject = runtimeObject;
    this.logger = logger;
    this.refreshCore = refreshCore;
    this.config = config;
    this.currentCore = undefined;
    this.currentSource = '';
    this.generation = 0;
    this.hintState = 'WAITING';
    this.message = WAITING_MESSAGE;
    this.reconcileTimer;
    this.statusTimer;
    this.started = false;
    this.destroyed = false;
  }

  start() {
    if (this.destroyed) {
      fail('VOD_DESTROYED', '点播控制器已经销毁');
    }
    if (this.started) {
      fail('VOD_ALREADY_STARTED', '点播控制器已经启动');
    }
    this.started = true;
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
    const source = currentVideoSource(this.video);
    if (source === '') {
      this.currentCore = undefined;
      this.currentSource = '';
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
      const currentSource = currentVideoSource(this.video);
      if (currentSource === '') {
        this.currentCore = undefined;
        this.currentSource = '';
        this.hintState = 'WAITING';
        this.message = WAITING_MESSAGE;
        this.updateStatus();
        return;
      }
      const generationChanged = core !== this.currentCore || currentSource !== this.currentSource;
      if (generationChanged) {
        this.currentCore = core;
        this.currentSource = currentSource;
        this.generation += 1;
        this.hintState = 'WAITING';
        this.message = '';
        this.applyHintForGeneration(core);
      }
    } catch (error) {
      if (this.destroyed || !this.started) {
        return;
      }
      if (isWaitingForBridge(error)) {
        this.hintState = 'WAITING';
        this.message = WAITING_MESSAGE;
      } else {
        const normalized = toBufferScriptError(error, 'VOD_RECONCILE_FAILED', '点播播放器内核刷新失败');
        this.logger.error('点播播放器内核刷新失败', normalized);
        this.hintState = 'FAILED';
        this.message = `${normalized.code}: ${normalized.message}`;
      }
    }
    this.updateStatus();
  }

  applyHintForGeneration(core) {
    if (core.supports('setStableBufferTime') !== true) {
      this.hintState = 'UNSUPPORTED';
      this.message = `当前内核不支持 ${this.config.stableBufferSeconds} 秒原生缓存提示`;
      return;
    }
    try {
      core.setStableBufferTime(this.config.stableBufferSeconds);
      this.hintState = 'APPLIED';
      this.message = '';
    } catch (error) {
      const normalized = toBufferScriptError(error, 'VOD_STABLE_BUFFER_FAILED', '原生缓存提示调用失败');
      this.logger.error('原生缓存提示调用失败', normalized);
      this.hintState = 'FAILED';
      this.message = `${normalized.code}: ${normalized.message}`;
    }
  }

  readForwardBuffer() {
    return readNativeForwardBuffer(this.video);
  }

  updateStatus() {
    if (this.destroyed || !this.started) {
      return;
    }
    const inventory = this.readForwardBuffer();
    this.panel.setModel({
      mode: '点播',
      state: this.hintState,
      inventory: `${inventory.toFixed(1)} 秒`,
      message: this.message,
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
    if (this.reconcileTimer !== undefined) {
      this.runtimeObject.clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.statusTimer !== undefined) {
      this.runtimeObject.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
  }
}
