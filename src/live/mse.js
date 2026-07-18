import { fail, requireValue, toBufferScriptError } from '../errors.js';

function waitForEvent(target, eventName, errorName) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener(errorName, onError);
      resolve();
    };
    const onError = (event) => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener(errorName, onError);
      reject(new Error(`MSE 事件 ${errorName}: ${event?.message || '未知错误'}`));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener(errorName, onError, { once: true });
  });
}

export class MseAppendPipeline {
  constructor(video, mediaSourceFactory = globalThis.MediaSource, urlApi = globalThis.URL) {
    this.video = requireValue(video, 'MSE_VIDEO_MISSING', 'MSE 管线缺少 video 元素');
    this.mediaSourceFactory = mediaSourceFactory;
    this.urlApi = urlApi;
    this.mediaSource;
    this.sourceBuffer;
    this.objectUrl;
    this.mime;
  }

  async open(mime) {
    if (this.mediaSourceFactory === undefined || typeof this.mediaSourceFactory.isTypeSupported !== 'function') {
      fail('MSE_UNSUPPORTED', '当前浏览器不支持 MediaSource');
    }
    if (!this.mediaSourceFactory.isTypeSupported(mime)) {
      fail('MSE_CODEC_UNSUPPORTED', `浏览器不支持直播 codec: ${mime}`);
    }
    this.mime = mime;
    this.mediaSource = new this.mediaSourceFactory();
    this.objectUrl = this.urlApi.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    if (this.mediaSource.readyState !== 'open') {
      await waitForEvent(this.mediaSource, 'sourceopen', 'error');
    }
    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.mode = 'segments';
    } catch (error) {
      fail('MSE_SOURCEBUFFER_ERROR', `无法创建直播 SourceBuffer: ${mime}`, error);
    }
  }

  async append(bytes) {
    requireValue(this.sourceBuffer, 'MSE_NOT_OPEN', 'MSE 管线尚未打开');
    if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]') {
      fail('MSE_INVALID_BYTES', 'MSE 追加数据不是 ArrayBuffer');
    }
    if (this.sourceBuffer.updating) {
      await waitForEvent(this.sourceBuffer, 'updateend', 'error');
    }
    try {
      this.sourceBuffer.appendBuffer(bytes);
    } catch (error) {
      const code = error?.name === 'QuotaExceededError' ? 'MSE_QUOTA_EXCEEDED' : 'MSE_APPEND_ERROR';
      throw toBufferScriptError(error, code, `MSE 追加片段失败: ${code}`);
    }
    if (this.sourceBuffer.updating) {
      try {
        await waitForEvent(this.sourceBuffer, 'updateend', 'error');
      } catch (error) {
        throw toBufferScriptError(error, 'MSE_APPEND_ERROR', 'MSE 追加异步失败');
      }
    }
  }

  assertOwnsVideoSource() {
    requireValue(this.objectUrl, 'MSE_NOT_OPEN', 'MSE 管线尚未打开');
    if (this.video.src !== this.objectUrl && this.video.currentSrc !== this.objectUrl) {
      fail('GAP_MEDIA_OWNERSHIP_LOST', '页面播放器夺回了 video 媒体 source');
    }
  }

  async removeBefore(seconds) {
    requireValue(this.sourceBuffer, 'MSE_NOT_OPEN', 'MSE 管线尚未打开');
    if (this.sourceBuffer.updating) {
      await waitForEvent(this.sourceBuffer, 'updateend', 'error');
    }
    if (seconds <= 0) {
      return;
    }
    try {
      this.sourceBuffer.remove(0, seconds);
    } catch (error) {
      throw toBufferScriptError(error, 'MSE_REMOVE_ERROR', 'MSE 清理旧缓冲失败');
    }
    if (this.sourceBuffer.updating) {
      await waitForEvent(this.sourceBuffer, 'updateend', 'error');
    }
  }

  close() {
    if (this.mediaSource?.readyState === 'open') {
      this.mediaSource.endOfStream();
    }
    if (this.objectUrl !== undefined) {
      this.urlApi.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = undefined;
    this.sourceBuffer = undefined;
    this.mediaSource = undefined;
  }
}
