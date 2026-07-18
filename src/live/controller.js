import { LIVE_CONFIG, LIVE_STATE } from '../constants.js';
import { BufferScriptError, fail, toBufferScriptError } from '../errors.js';
import { fetchRoomPlayInfo, extractLiveTrack, renewLiveTrack } from './api.js';
import {
  buildSegmentCandidates,
  codecListsMatch,
  parseHlsPlaylist,
  sameInitializationMap,
  selectMediaVariant,
} from './manifest.js';
import { fetchBytesFromCandidates, fetchTextFromCandidates } from './fetcher.js';
import { OrderedSegmentQueue } from './queue.js';
import { LiveStateMachine } from './state.js';
import { MseAppendPipeline } from './mse.js';
import { DanmakuVisibilityController } from './danmaku.js';
import { installLivePlaybackGuard } from './guard.js';
import { copyTimeRanges, computeForwardInventory } from '../vod/buffer.js';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

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

function findLargestVideo(documentObject) {
  const videos = [...documentObject.querySelectorAll('video')];
  if (videos.length === 0) {
    return undefined;
  }
  return videos.sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
}

export function waitForVideo(documentObject, timeoutMilliseconds = 30000, signal) {
  if (signal?.aborted) {
    return Promise.reject(new BufferScriptError('VIDEO_WAIT_ABORTED', '等待 Bilibili video 元素已取消'));
  }
  const existing = findLargestVideo(documentObject);
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      observer.disconnect();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const observer = new MutationObserver(() => {
      const video = findLargestVideo(documentObject);
      if (video !== undefined) {
        cleanup();
        resolve(video);
      }
    });
    const onAbort = () => {
      cleanup();
      reject(new BufferScriptError('VIDEO_WAIT_ABORTED', '等待 Bilibili video 元素已取消'));
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new BufferScriptError('VIDEO_NOT_FOUND', '30 秒内没有找到 Bilibili video 元素'));
    }, timeoutMilliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    observer.observe(documentObject.documentElement, { childList: true, subtree: true });
  });
}

async function configureOuterPlayer(windowObject, video, logger) {
  const player = windowObject.player;
  if (player === undefined) {
    logger.warn('未找到 window.player，无法关闭页面播放器追赶配置');
  } else {
    for (const [name, config] of [
      ['setAutoSyncProgressCfg', { enable: false }],
      ['setAutoDiscardFrameCfg', { enable: false }],
    ]) {
      if (typeof player[name] !== 'function') {
        logger.warn(`页面播放器没有 ${name}`);
        continue;
      }
      try {
        await player[name](config);
      } catch (error) {
        if (error?.code === 'PLAYER_UNAVAILABLE') {
          logger.warn(`页面播放器尚未就绪，跳过 ${name}`, error);
        } else {
          logger.error(`调用 ${name} 失败`, error);
        }
      }
    }
    if (typeof player.pause === 'function') {
      try {
        await player.pause();
      } catch (error) {
        logger.warn('调用页面播放器 pause 失败，继续接管 video', error);
      }
    }
  }
  if (!video.paused) {
    video.pause();
  }
}

function getVideoForwardInventory(video) {
  return computeForwardInventory(video.currentTime, [copyTimeRanges(video.buffered)]);
}

function buildMime(track) {
  if (track.codecString.length === 0) {
    fail('LIVE_CODEC_MISSING', '播放 API 没有返回可用于 MSE 的 codec 字符串');
  }
  return `video/mp4; codecs="${track.codecString}"`;
}

function requiresManifestContinuityGap(error) {
  return [
    'MANIFEST_VARIANT_MISSING',
    'MANIFEST_MEDIA_MISSING',
    'MANIFEST_FMP4_MAP_MISSING',
    'MANIFEST_MAP_URI_MISSING',
  ].includes(error?.code);
}

function requiresUnrecoverableGap(error) {
  return (
    requiresManifestContinuityGap(error) ||
    ['MANIFEST_PERMANENT_404', 'MSE_APPEND_ERROR', 'MSE_REMOVE_ERROR', 'MSE_QUOTA_EXCEEDED'].includes(error?.code) ||
    error?.code?.startsWith('GAP_') ||
    error?.code?.startsWith('LIVE_SESSION_')
  );
}

function requiresStartupGap(error) {
  return requiresUnrecoverableGap(error) || error?.code === 'SEGMENT_PERMANENT_404';
}

function logicalVariantIdentity(variant) {
  return new URL(variant.url).pathname;
}

function selectPinnedMediaVariant(master, track, pinnedIdentity) {
  if (pinnedIdentity === undefined) {
    return selectMediaVariant(master, track.codecString);
  }
  const exact = master.variants.find(
    (variant) =>
      logicalVariantIdentity(variant) === pinnedIdentity &&
      codecListsMatch(variant.attributes.CODECS || '', track.codecString),
  );
  if (exact === undefined) {
    fail('GAP_MANIFEST_VARIANT_CHANGED', '自动恢复时原有 HLS 主清单变体消失或被替换');
  }
  return exact;
}

export class LiveController {
  constructor({
    windowObject,
    documentObject,
    video,
    panel,
    hls,
    roomId,
    fetchImpl,
    runtimeObject = globalThis,
    mediaSourceFactory = runtimeObject.MediaSource,
    urlApi = runtimeObject.URL,
    logger = createLogger(),
    config = LIVE_CONFIG,
  }) {
    this.windowObject = windowObject;
    this.documentObject = documentObject;
    this.video = video;
    this.panel = panel;
    this.hls = hls;
    this.roomId = roomId;
    this.fetchImpl = fetchImpl;
    this.runtimeObject = runtimeObject;
    this.mediaSourceFactory = mediaSourceFactory;
    this.urlApi = urlApi;
    this.logger = logger;
    this.config = config;
    this.stateMachine = new LiveStateMachine();
    this.queue = new OrderedSegmentQueue();
    this.danmaku = new DanmakuVisibilityController(documentObject);
    this.pipeline = new MseAppendPipeline(video, this.mediaSourceFactory, this.urlApi);
    this.track;
    this.manifest;
    this.manifestCandidates;
    this.variantIdentity;
    this.liveEdge;
    this.generation = 0;
    this.segmentAbort;
    this.inFlight = new Map();
    this.deliveryBusy = false;
    this.refreshTimer;
    this.statusTimer;
    this.refreshBusy = false;
    this.renewPromise;
    this.renewGeneration;
    this.timelineOriginMilliseconds;
    this.userPaused = false;
    this.internalPause = false;
    this.internalPlay = false;
    this.videoGuard;
    this.enabled = true;
    this.started = false;
    this.starting = false;
    this.destroyed = false;
    this.rebuildingSource = false;
    this.rebuildingGeneration;
    this.failureMessage;
    this.boundEvents = [];
  }

  isGenerationCurrent(generation) {
    return !this.destroyed && this.enabled && generation === this.generation;
  }

  ensureGenerationCurrent(generation) {
    if (!this.isGenerationCurrent(generation)) {
      fail('LIVE_GENERATION_STALE', '直播控制器的旧异步操作已经失效');
    }
  }

  beginNewGeneration() {
    this.generation += 1;
    this.segmentAbort?.abort();
    this.segmentAbort = new AbortController();
    this.inFlight.clear();
    this.rebuildingSource = false;
    this.rebuildingGeneration = undefined;
    return this.generation;
  }

  async start() {
    if (this.destroyed) {
      fail('LIVE_DESTROYED', '直播控制器已经销毁');
    }
    if (this.started) {
      fail('LIVE_ALREADY_STARTED', '直播控制器已经启动');
    }
    if (this.hls === undefined || typeof this.hls.isSupported !== 'function' || !this.hls.isSupported()) {
      fail('LIVE_HLS_UNSUPPORTED', '当前浏览器不支持固定版本 hls.js 所需的 MSE 能力');
    }
    const generation = this.generation;
    const pipeline = this.pipeline;
    this.starting = true;
    try {
      await configureOuterPlayer(this.windowObject, this.video, this.logger);
      this.ensureGenerationCurrent(generation);
      this.installVideoGuards();
      this.segmentAbort = new AbortController();
      const payload = await fetchRoomPlayInfo(this.roomId, 10000, this.fetchImpl, {
        requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
        retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
        signal: this.segmentAbort?.signal,
      });
      this.ensureGenerationCurrent(generation);
      this.track = extractLiveTrack(payload, 10000, 'avc');
      if (this.track.roomId !== this.roomId) {
        fail('LIVE_ROOM_CHANGED', '播放 API 返回了不同直播间');
      }
      const loaded = await this.loadInitialMediaManifest(generation);
      this.ensureGenerationCurrent(generation);
      this.manifest = loaded.manifest;
      this.manifestCandidates = loaded.candidates;
      this.variantIdentity = loaded.variantIdentity;
      this.liveEdge = this.manifest.segments[this.manifest.segments.length - 1];
      this.queue.initialize(this.manifest, true);
      await pipeline.open(buildMime(this.track));
      this.ensureGenerationCurrent(generation);
      await this.appendInitSegment(generation, pipeline);
      this.ensureGenerationCurrent(generation);
      pipeline.assertOwnsVideoSource();
      this.started = true;
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) {
        pipeline.close();
        this.logger.warn('直播控制器的旧启动操作已取消', error);
        return;
      }
      const normalized = toBufferScriptError(error, 'LIVE_START_FAILED', '直播初始媒体管线失败');
      if (this.track !== undefined && requiresStartupGap(normalized)) {
        this.started = true;
        this.enterGap(normalized);
      } else {
        throw normalized;
      }
    } finally {
      this.starting = false;
    }
    if (!this.isGenerationCurrent(generation)) {
      pipeline.close();
      return;
    }
    this.refreshTimer = this.runtimeObject.setInterval(() => {
      void this.refreshManifest();
    }, this.config.manifestRefreshMilliseconds);
    this.statusTimer = this.runtimeObject.setInterval(() => {
      this.updateStatus();
    }, this.config.statusRefreshMilliseconds);
    this.scheduleDownloads();
    void this.pumpDelivery();
    this.updateStatus();
  }

  async loadInitialMediaManifest(generation = this.generation) {
    const signal = this.segmentAbort?.signal;
    while (true) {
      this.ensureGenerationCurrent(generation);
      try {
        return await this.loadMediaManifest(this.track, { generation, signal });
      } catch (error) {
        if (error?.code !== 'SIGNATURE_EXPIRED') {
          throw error;
        }
        this.ensureGenerationCurrent(generation);
        const track = await renewLiveTrack(this.track, this.fetchImpl, {
          requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
          retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
          signal,
        });
        this.ensureGenerationCurrent(generation);
        this.track = track;
      }
    }
  }

  async loadMediaManifest(
    track = this.track,
    { enforceVariant = true, generation = this.generation, signal = this.segmentAbort?.signal } = {},
  ) {
    this.ensureGenerationCurrent(generation);
    const loaded = await fetchTextFromCandidates(track.candidates, {
      fetchImpl: this.fetchImpl,
      requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
      retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
      signal,
      onWarning: (message, error) => this.logger.warn(message, error),
    });
    this.ensureGenerationCurrent(generation);
    let parsed = parseHlsPlaylist(loaded.text, loaded.url);
    let candidates = track.candidates;
    let variantIdentity;
    if (parsed.type === 'master') {
      const variant = selectPinnedMediaVariant(
        parsed,
        track,
        enforceVariant ? this.variantIdentity : undefined,
      );
      variantIdentity = logicalVariantIdentity(variant);
      candidates = buildSegmentCandidates(variant.url, track.candidates);
      const variantLoaded = await fetchTextFromCandidates(candidates, {
        fetchImpl: this.fetchImpl,
        requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
        retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
        signal,
        onWarning: (message, error) => this.logger.warn(message, error),
      });
      this.ensureGenerationCurrent(generation);
      parsed = parseHlsPlaylist(variantLoaded.text, variantLoaded.url);
    }
    if (parsed.type !== 'media') {
      fail('MANIFEST_MEDIA_MISSING', 'HLS 主清单没有解析出媒体清单');
    }
    if (enforceVariant && this.variantIdentity !== undefined && variantIdentity !== this.variantIdentity) {
      fail('GAP_MANIFEST_VARIANT_CHANGED', '自动恢复时 HLS 主清单不再提供原有变体');
    }
    return { manifest: parsed, candidates, variantIdentity };
  }

  applyRefreshedManifest(loaded) {
    if (this.manifest !== undefined && !sameInitializationMap(this.manifest.map, loaded.manifest.map)) {
      fail('GAP_MANIFEST_INITIALIZATION_CHANGED', '刷新清单改变了 fMP4 初始化片段或字节范围');
    }
    this.queue.updateManifest(loaded.manifest);
    this.manifest = loaded.manifest;
    this.manifestCandidates = loaded.candidates;
    if (loaded.variantIdentity !== undefined) {
      this.variantIdentity = loaded.variantIdentity;
    }
    this.liveEdge = this.manifest.segments[this.manifest.segments.length - 1];
  }

  async appendInitSegment(generation = this.generation, pipeline = this.pipeline) {
    const signal = this.segmentAbort?.signal;
    while (true) {
      this.ensureGenerationCurrent(generation);
      const candidates = buildSegmentCandidates(this.manifest.map.url, this.manifestCandidates);
      try {
        const loaded = await fetchBytesFromCandidates(candidates, {
          fetchImpl: this.fetchImpl,
          requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
          retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
          signal,
          onWarning: (message, error) => this.logger.warn(message, error),
        });
        this.ensureGenerationCurrent(generation);
        if (pipeline !== this.pipeline) {
          fail('LIVE_GENERATION_STALE', '直播初始化片段对应的 MSE 管线已被替换');
        }
        await pipeline.append(loaded.bytes);
        this.ensureGenerationCurrent(generation);
        return;
      } catch (error) {
        if (error?.code !== 'SIGNATURE_EXPIRED') {
          throw error;
        }
        await this.renewTrack(generation, signal);
      }
    }
  }

  installVideoGuards() {
    this.videoGuard = installLivePlaybackGuard(this.video, {
      playbackRate: this.config.playbackRate,
      logger: this.logger,
      isEnabled: () => this.enabled,
    });
    this.addVideoListener('waiting', () => this.onWaiting('waiting'));
    this.addVideoListener('stalled', () => this.onWaiting('stalled'));
    this.addVideoListener('pause', () => {
      if (!this.enabled) {
        this.userPaused = this.video.paused;
        return;
      }
      if (this.internalPause) {
        this.internalPause = false;
        return;
      }
      if (this.starting || this.rebuildingSource) {
        return;
      }
      this.userPaused = true;
      this.stateMachine.onUserPause();
      this.updateStatus();
    });
    this.addVideoListener('play', () => {
      if (!this.enabled) {
        this.userPaused = this.video.paused;
        return;
      }
      if (this.internalPlay) {
        return;
      }
      this.handleUserPlay();
      this.updateStatus();
    });
  }

  addVideoListener(name, callback) {
    this.video.addEventListener(name, callback);
    this.boundEvents.push([name, callback]);
  }

  onWaiting(reason) {
    if (
      !this.enabled ||
      !this.started ||
      this.starting ||
      this.rebuildingSource ||
      this.userPaused ||
      this.stateMachine.state === LIVE_STATE.GAP_UNRECOVERABLE
    ) {
      return;
    }
    this.logger.warn(`直播媒体事件: ${reason}`);
    this.stateMachine.onStall();
    this.stateMachine.onRecovering();
    this.pauseForRecovery();
    this.updateStatus();
  }

  pauseForRecovery() {
    if (!this.enabled || this.video.paused) {
      return;
    }
    this.internalPause = true;
    this.video.pause();
  }

  scheduleDownloads() {
    if (!this.started || !this.enabled || this.stateMachine.state === LIVE_STATE.GAP_UNRECOVERABLE) {
      return;
    }
    let seconds = this.readInventory();
    seconds += this.queue.contiguousDownloadedSeconds(
      Math.max(0, this.config.aggressiveBufferSeconds - seconds),
    );
    let sequence = this.queue.expectedSn;
    while (this.inFlight.size < this.config.segmentConcurrency && seconds < this.config.aggressiveBufferSeconds) {
      const segment = this.queue.getSegment(sequence);
      if (segment === undefined) {
        break;
      }
      if (this.queue.hasDownloaded(segment.sn)) {
        seconds += segment.duration;
        sequence += 1;
        continue;
      }
      if (!this.inFlight.has(segment.sn)) {
        this.inFlight.set(segment.sn, this.generation);
        void this.downloadSegment(segment, this.generation);
      }
      seconds += segment.duration;
      sequence += 1;
    }
  }

  async downloadSegment(segment, generation) {
    try {
      while (generation === this.generation && this.enabled) {
        try {
          const currentSegment = this.queue.getSegment(segment.sn) || segment;
          const candidates = buildSegmentCandidates(currentSegment.url, this.manifestCandidates);
          const loaded = await fetchBytesFromCandidates(candidates, {
            fetchImpl: this.fetchImpl,
            requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
            retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
            signal: this.segmentAbort.signal,
            onWarning: (message, error) => this.logger.warn(message, error),
          });
          if (generation !== this.generation) {
            this.logger.warn(`丢弃已取消的片段下载 ${segment.sn}`);
            return;
          }
          this.queue.markDownloaded(segment.sn, loaded.bytes);
          void this.pumpDelivery();
          return;
        } catch (error) {
          if (generation !== this.generation || error?.code === 'REQUEST_ABORTED') {
            this.logger.warn(`片段 ${segment.sn} 因手动停用取消`, error);
            return;
          }
          const normalized = toBufferScriptError(error, 'SEGMENT_DOWNLOAD_FAILED', `片段 ${segment.sn} 下载失败`);
          if (normalized.code === 'SIGNATURE_EXPIRED') {
            await this.renewTrack(generation);
            continue;
          }
          if (normalized.code === 'SEGMENT_PERMANENT_404') {
            this.enterGap(normalized);
            return;
          }
          throw normalized;
        }
      }
    } catch (error) {
      if (generation === this.generation && error?.code !== 'REQUEST_ABORTED') {
        this.enterGap(error);
      }
    } finally {
      if (this.inFlight.get(segment.sn) === generation) {
        this.inFlight.delete(segment.sn);
      }
      if (generation === this.generation) {
        this.scheduleDownloads();
      }
    }
  }

  async pumpDelivery() {
    if (
      this.destroyed ||
      !this.enabled ||
      this.deliveryBusy ||
      !this.started ||
      this.stateMachine.state === LIVE_STATE.GAP_UNRECOVERABLE
    ) {
      return;
    }
    const generation = this.generation;
    const pipeline = this.pipeline;
    this.deliveryBusy = true;
    let appendedAny = false;
    try {
      this.ensureGenerationCurrent(generation);
      if (pipeline !== this.pipeline) {
        return;
      }
      pipeline.assertOwnsVideoSource();
      while (this.queue.peekReady() !== undefined) {
        this.ensureGenerationCurrent(generation);
        if (pipeline !== this.pipeline) {
          return;
        }
        const item = this.queue.peekReady();
        pipeline.assertOwnsVideoSource();
        await pipeline.append(item.bytes);
        if (!this.isGenerationCurrent(generation) || pipeline !== this.pipeline) {
          return;
        }
        this.queue.acknowledgeDelivery(item.segment.sn);
        appendedAny = true;
        if (this.timelineOriginMilliseconds === undefined && item.segment.programDateTime !== undefined) {
          this.timelineOriginMilliseconds = item.segment.programDateTime - this.video.currentTime * 1000;
        }
        if (this.stateMachine.state === LIVE_STATE.STALL || this.stateMachine.state === LIVE_STATE.RECOVERING) {
          this.stateMachine.onRecovering();
        }
      }
      if (this.video.currentTime > 30) {
        await pipeline.removeBefore(this.video.currentTime - 30);
        this.ensureGenerationCurrent(generation);
        if (pipeline !== this.pipeline) {
          return;
        }
      }
    } catch (error) {
      if (this.isGenerationCurrent(generation) && pipeline === this.pipeline) {
        this.enterGap(error);
      } else {
        this.logger.warn('丢弃已替换直播 MSE 管线的旧投递结果', error);
      }
      return;
    } finally {
      this.deliveryBusy = false;
      if (this.isGenerationCurrent(generation) && pipeline === this.pipeline) {
        this.scheduleDownloads();
        if (appendedAny && this.stateMachine.state === LIVE_STATE.LIVE && !this.userPaused) {
          this.attemptPlay();
        }
        this.updateStatus();
      } else if (!this.destroyed && this.enabled && this.started) {
        this.scheduleDownloads();
        void this.pumpDelivery();
      }
    }
  }

  async refreshManifest() {
    if (
      this.destroyed ||
      !this.started ||
      !this.enabled ||
      this.refreshBusy ||
      this.stateMachine.state === LIVE_STATE.GAP_UNRECOVERABLE
    ) {
      return;
    }
    const generation = this.generation;
    this.refreshBusy = true;
    try {
      const loaded = await this.loadMediaManifest(this.track, { generation });
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      this.applyRefreshedManifest(loaded);
      this.scheduleDownloads();
      void this.pumpDelivery();
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      const normalized = toBufferScriptError(error, 'MANIFEST_REFRESH_FAILED', '直播清单更新失败');
      if (normalized.code === 'SIGNATURE_EXPIRED') {
        try {
          await this.renewTrack(generation);
        } catch (renewError) {
          if (this.isGenerationCurrent(generation)) {
            this.enterGap(renewError);
          }
        }
      } else if (requiresUnrecoverableGap(normalized)) {
        this.enterGap(normalized);
      } else {
        this.logger.warn('直播清单更新失败，保留当前连续性', normalized);
        this.panel.setMessage(`清单暂时不可用: ${errorMessage(normalized)}`);
      }
    } finally {
      this.refreshBusy = false;
    }
  }

  async renewTrack(generation = this.generation, signal = this.segmentAbort?.signal) {
    if (this.renewPromise !== undefined && this.renewGeneration === generation) {
      return this.renewPromise;
    }
    let renewPromise;
    renewPromise = (async () => {
      this.ensureGenerationCurrent(generation);
      const next = await renewLiveTrack(this.track, this.fetchImpl, {
        requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
        retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
        signal,
      });
      this.ensureGenerationCurrent(generation);
      const loaded = await this.loadMediaManifest(next, { generation, signal });
      this.ensureGenerationCurrent(generation);
      this.applyRefreshedManifest(loaded);
      this.track = next;
      return next;
    })()
      .finally(() => {
        if (this.renewPromise === renewPromise) {
          this.renewPromise = undefined;
          this.renewGeneration = undefined;
        }
      });
    this.renewPromise = renewPromise;
    this.renewGeneration = generation;
    return this.renewPromise;
  }

  readInventory() {
    return getVideoForwardInventory(this.video);
  }

  estimateDelay() {
    if (this.liveEdge === undefined) {
      return 0;
    }
    if (this.timelineOriginMilliseconds !== undefined && this.liveEdge.programDateTime !== undefined) {
      const liveEdgeMilliseconds = this.liveEdge.programDateTime + this.liveEdge.duration * 1000;
      const playbackMilliseconds = this.timelineOriginMilliseconds + this.video.currentTime * 1000;
      return Math.max(0, (liveEdgeMilliseconds - playbackMilliseconds) / 1000);
    }
    let delay = 0;
    for (let sequence = this.queue.expectedSn; sequence <= this.liveEdge.sn; sequence += 1) {
      const segment = this.queue.getSegment(sequence);
      if (segment !== undefined) {
        delay += segment.duration;
      }
    }
    return delay;
  }

  updateStatus() {
    if (this.destroyed || !this.started) {
      return;
    }
    if (!this.enabled) {
      this.danmaku.setHidden(false);
      this.panel.setAction('toggle', '启用', () => this.runAction(() => this.toggle()));
      this.panel.setAction('skip-gap', '', () => {}, false);
      this.panel.setAction('return-live', '', () => {}, false);
      return;
    }
    if (this.stateMachine.state !== LIVE_STATE.GAP_UNRECOVERABLE) {
      try {
        this.pipeline.assertOwnsVideoSource();
      } catch (error) {
        this.enterGap(error);
        return;
      }
    }
    const inventory = this.readInventory();
    const delay = this.estimateDelay();
    this.stateMachine.onDelayChanged(delay);
    this.danmaku.setHidden(delay > this.config.hideDanmakuAfterSeconds);
    if (
      this.stateMachine.state === LIVE_STATE.RECOVERING &&
      !this.userPaused &&
      inventory >= this.config.recoveryWatermarkSeconds
    ) {
      this.stateMachine.onRecoveryReady(delay);
      this.attemptPlay();
    }
    const quality =
      this.track === undefined
        ? '未提供'
        : `${this.track.qualityNumber} / ${this.track.codecName}${delay > 3 ? '（积压锁定）' : ''}`;
    this.panel.setModel({
      state: this.stateMachine.state,
      mode: '直播',
      inventory: `${inventory.toFixed(1)} 秒`,
      delay: `${delay.toFixed(1)} 秒`,
      quality,
      speed: `${this.config.playbackRate}×`,
      multiplier: '直播实时',
      message: this.failureMessage || '',
    });
    this.panel.setAction('toggle', this.enabled ? '停用' : '启用', () => this.runAction(() => this.toggle()));
    const gapVisible = this.stateMachine.state === LIVE_STATE.GAP_UNRECOVERABLE;
    const backlogReturnVisible =
      this.stateMachine.state === LIVE_STATE.STALL ||
      this.stateMachine.state === LIVE_STATE.RECOVERING
        ? delay > 0
        : false;
    const returnVisible =
      gapVisible ||
      this.stateMachine.state === LIVE_STATE.DELAYED ||
      this.stateMachine.state === LIVE_STATE.USER_PAUSED ||
      backlogReturnVisible;
    this.panel.setAction('skip-gap', '跨过缺口', () => this.runAction(() => this.manualSkipGap()), gapVisible);
    this.panel.setAction('return-live', '回到直播', () => this.runAction(() => this.manualReturnLive()), returnVisible);
  }

  attemptPlay() {
    if (!this.enabled || this.userPaused || this.video.paused === false) {
      return;
    }
    this.internalPlay = true;
    Promise.resolve(this.video.play())
      .catch((error) => {
        if (!this.enabled) {
          return;
        }
        this.logger.error('直播恢复播放被浏览器拒绝', error);
        this.panel.setMessage(`浏览器未允许自动播放: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.internalPlay = false;
      });
  }

  enterGap(error) {
    if (this.destroyed || !this.enabled) {
      return;
    }
    const normalized = toBufferScriptError(error, 'GAP_UNRECOVERABLE', '直播连续性无法恢复');
    this.logger.error('进入 GAP_UNRECOVERABLE', normalized);
    this.failureMessage = `${normalized.code}: ${normalized.message}`;
    this.stateMachine.onGap(normalized.message);
    this.pauseForRecovery();
    this.updateStatus();
  }

  async toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.failureMessage = undefined;
      this.videoGuard?.synchronize();
      if (this.video.paused) {
        this.userPaused = true;
        this.stateMachine.onUserPause();
      } else {
        this.handleUserPlay();
      }
      this.videoGuard?.enforce();
      this.segmentAbort = new AbortController();
      this.scheduleDownloads();
      void this.refreshManifest();
    } else {
      this.generation += 1;
      this.segmentAbort?.abort();
      this.inFlight.clear();
      this.rebuildingSource = false;
      this.rebuildingGeneration = undefined;
      this.internalPause = false;
      this.internalPlay = false;
      this.danmaku.setHidden(false);
      this.logger.warn('用户停用了直播补水与清单轮询');
    }
    this.updateStatus();
  }

  handleUserPlay() {
    this.userPaused = false;
    const inventory = this.readInventory();
    const state = this.stateMachine.onUserPlay(
      this.estimateDelay(),
      inventory >= this.config.recoveryWatermarkSeconds,
    );
    if (state === LIVE_STATE.RECOVERING && inventory < this.config.recoveryWatermarkSeconds) {
      this.pauseForRecovery();
    }
  }

  async manualSkipGap() {
    this.stateMachine.manualSkipGap();
    this.userPaused = false;
    await this.restartAtCurrentEdge();
  }

  async manualReturnLive() {
    this.stateMachine.manualReturnLive();
    this.userPaused = false;
    const generation = this.beginNewGeneration();
    const track = await this.loadManualReturnTrack(generation);
    if (!this.isGenerationCurrent(generation)) {
      return;
    }
    await this.restartAtCurrentEdge(track, generation);
  }

  async loadManualReturnTrack(generation = this.generation, signal = this.segmentAbort?.signal) {
    const previous = this.track;
    this.ensureGenerationCurrent(generation);
    const payload = await fetchRoomPlayInfo(this.roomId, previous.qualityNumber, this.fetchImpl, {
      requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
      retryBackoffMilliseconds: this.config.retryBackoffMilliseconds,
      signal,
    });
    this.ensureGenerationCurrent(generation);
    const track = extractLiveTrack(payload, previous.qualityNumber, previous.codecName);
    if (track.roomId !== this.roomId) {
      fail('LIVE_ROOM_CHANGED', '播放 API 返回了不同直播间');
    }
    if (track.qualityNumber !== previous.qualityNumber) {
      fail('LIVE_QUALITY_CHANGED', '回到直播返回了不同清晰度，不能建立当前边缘');
    }
    return track;
  }

  async restartAtCurrentEdge(track = this.track, generation) {
    const activeGeneration = generation === undefined ? this.beginNewGeneration() : generation;
    this.ensureGenerationCurrent(activeGeneration);
    const loaded = await this.loadMediaManifest(track, { enforceVariant: false, generation: activeGeneration });
    this.ensureGenerationCurrent(activeGeneration);
    this.track = track;
    this.manifest = loaded.manifest;
    this.manifestCandidates = loaded.candidates;
    this.variantIdentity = loaded.variantIdentity;
    this.liveEdge = this.manifest.segments[this.manifest.segments.length - 1];
    this.queue.resetForManualJump(this.manifest);
    this.timelineOriginMilliseconds = undefined;
    this.rebuildingSource = true;
    this.rebuildingGeneration = activeGeneration;
    let replacementPipeline;
    try {
      const previousPipeline = this.pipeline;
      previousPipeline.close();
      const pipeline = new MseAppendPipeline(
        this.video,
        this.mediaSourceFactory,
        this.urlApi,
      );
      replacementPipeline = pipeline;
      this.pipeline = pipeline;
      await pipeline.open(buildMime(this.track));
      this.ensureGenerationCurrent(activeGeneration);
      await this.appendInitSegment(activeGeneration, pipeline);
      this.ensureGenerationCurrent(activeGeneration);
      pipeline.assertOwnsVideoSource();
    } finally {
      if (!this.isGenerationCurrent(activeGeneration)) {
        replacementPipeline?.close();
      }
      if (this.rebuildingGeneration === activeGeneration) {
        this.rebuildingSource = false;
        this.rebuildingGeneration = undefined;
      }
    }
    this.ensureGenerationCurrent(activeGeneration);
    this.failureMessage = undefined;
    this.stateMachine.onRecoveryReady(0);
    this.scheduleDownloads();
    void this.pumpDelivery();
    this.updateStatus();
  }

  runAction(action) {
    Promise.resolve(action()).catch((error) => {
      if (this.destroyed || error?.code === 'LIVE_GENERATION_STALE') {
        this.logger.warn('忽略已取消的直播人工操作', error);
        return;
      }
      this.enterGap(error);
    });
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.enabled = false;
    this.generation += 1;
    this.rebuildingSource = false;
    this.rebuildingGeneration = undefined;
    if (this.refreshTimer !== undefined) {
      this.runtimeObject.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.statusTimer !== undefined) {
      this.runtimeObject.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.segmentAbort?.abort();
    for (const [name, callback] of this.boundEvents) {
      this.video.removeEventListener(name, callback);
    }
    this.videoGuard?.destroy();
    this.pipeline.close();
    this.danmaku.destroy();
  }
}

export function roomIdFromLocation(locationObject) {
  const match = locationObject.pathname.match(/^\/([0-9]+)(?:\/|$)/);
  if (match === null) {
    fail('LIVE_ROOM_ID_MISSING', `无法从路径读取直播间号: ${locationObject.pathname}`);
  }
  return Number(match[1]);
}
