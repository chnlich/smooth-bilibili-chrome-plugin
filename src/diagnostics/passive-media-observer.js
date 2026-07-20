import { MediaEventRecorder } from './media.js';

function currentSource(video) {
  return video?.currentSrc || video?.src || '';
}

export class PassiveMediaObserver {
  constructor({
    documentObject = document,
    windowObject = window,
    runtimeObject = windowObject,
    diagnostics,
    getVideo,
    initialVideo,
  }) {
    if (typeof getVideo !== 'function') throw new Error('被动媒体诊断缺少 video 选择器');
    this.documentObject = documentObject;
    this.windowObject = windowObject;
    this.runtimeObject = runtimeObject;
    this.diagnostics = diagnostics;
    this.getVideo = getVideo;
    this.video = initialVideo;
    this.videoInstance = 0;
    this.sourceInstance = 0;
    this.sourceKey = '';
    this.recorder = undefined;
    this.mutationObserver = undefined;
    this.reconcileTimer = undefined;
    this.started = false;
    this.destroyed = false;
    this.boundMutation = () => this.reconcile();
  }

  context() {
    return {
      videoInstance: this.videoInstance || undefined,
      sourceInstance: this.sourceInstance || undefined,
    };
  }

  start() {
    if (this.destroyed) throw new Error('被动媒体诊断已经销毁');
    if (this.started) throw new Error('被动媒体诊断已经启动');
    this.started = true;
    if (typeof this.windowObject.MutationObserver === 'function') {
      this.mutationObserver = new this.windowObject.MutationObserver(this.boundMutation);
      this.mutationObserver.observe(this.documentObject, { childList: true, subtree: true });
    }
    this.reconcileTimer = this.runtimeObject.setInterval(() => this.reconcile(), 500);
    const initialVideo = this.video;
    this.video = undefined;
    this.bindVideo(this.getVideo() || initialVideo);
  }

  reconcile() {
    if (this.destroyed || !this.started) return;
    const nextVideo = this.getVideo();
    if (nextVideo === undefined) return;
    if (nextVideo !== this.video) {
      this.bindVideo(nextVideo);
      return;
    }
    this.rebindSourceIfNeeded();
  }

  bindVideo(video) {
    if (video === undefined) return;
    const previousVideo = this.video;
    const previousSource = this.sourceKey;
    this.recorder?.destroy();
    this.video = video;
    this.videoInstance += 1;
    this.sourceKey = currentSource(video);
    if (this.sourceKey !== '') this.sourceInstance += 1;
    if (previousVideo !== undefined) {
      this.diagnostics?.log('video.replaced', { reason: 'passive_video_replaced' }, undefined, this.context());
      if (previousSource !== this.sourceKey) {
        this.diagnostics?.log('video.source_replaced', {
          previousSource,
          source: this.sourceKey,
          reason: 'video_replaced',
        }, undefined, this.context());
      }
    }
    this.diagnostics?.markVideoAvailable();
    this.diagnostics?.log('video.attached', {
      source: this.sourceKey,
      reason: 'passive_video_bound',
    }, undefined, this.context());
    this.recorder = new MediaEventRecorder({
      video,
      logger: this.diagnostics,
      runtimeObject: this.runtimeObject,
      context: () => this.context(),
    });
    this.recorder.start();
  }

  rebindSourceIfNeeded() {
    const nextSource = currentSource(this.video);
    if (nextSource === this.sourceKey) return;
    const previousSource = this.sourceKey;
    this.sourceKey = nextSource;
    this.sourceInstance += 1;
    this.diagnostics?.log('video.source_replaced', {
      previousSource,
      source: nextSource,
      reason: 'passive_source_replaced',
    }, undefined, this.context());
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.started = false;
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    if (this.reconcileTimer !== undefined) {
      this.runtimeObject.clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.recorder?.destroy();
    this.recorder = undefined;
    this.diagnostics?.log('video.destroyed', { reason: 'passive_observer_destroyed' }, undefined, this.context());
  }
}
