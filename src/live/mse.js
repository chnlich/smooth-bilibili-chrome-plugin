import { BufferScriptError, fail, requireValue, toBufferScriptError } from '../errors.js';

function waitForEvent(target, eventName, errorName, runtimeObject, timeoutMilliseconds) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener(errorName, onError);
      if (timer !== undefined) {
        runtimeObject.clearTimeout(timer);
      }
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (event) => {
      cleanup();
      reject(new BufferScriptError('MSE_EVENT_ERROR', `MSE 事件 ${errorName}: ${event?.message || '未知错误'}`));
    };
    const onTimeout = () => {
      cleanup();
      reject(new BufferScriptError('MSE_WAIT_TIMEOUT', `等待 MSE ${eventName} 事件超时`));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener(errorName, onError, { once: true });
    timer = runtimeObject.setTimeout(onTimeout, timeoutMilliseconds);
  });
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function visitBoxes(bytes, start, end, tracks, path = []) {
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) {
      fail('LIVE_INIT_INVALID', 'fMP4 初始化片段包含截断 box');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredSize = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let boxSize = declaredSize;
    if (declaredSize === 1) {
      if (offset + 16 > end) {
        fail('LIVE_INIT_INVALID', 'fMP4 初始化片段缺少扩展 box 大小');
      }
      const largeSize = view.getBigUint64(offset + 8, false);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail('LIVE_INIT_INVALID', 'fMP4 初始化片段 box 大小超出安全范围');
      }
      boxSize = Number(largeSize);
      headerSize = 16;
    } else if (declaredSize === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize || offset + boxSize > end) {
      fail('LIVE_INIT_INVALID', `fMP4 初始化片段 box ${type} 大小无效`);
    }
    const payloadStart = offset + headerSize;
    const boxEnd = offset + boxSize;
    if (
      type === 'hdlr' &&
      path.length === 3 &&
      path[0] === 'moov' &&
      path[1] === 'trak' &&
      path[2] === 'mdia' &&
      payloadStart + 12 <= boxEnd
    ) {
      const handler = ascii(bytes, payloadStart + 8, 4);
      if (handler === 'vide' || handler === 'soun') {
        tracks.add(handler);
      }
    }
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf'].includes(type)) {
      visitBoxes(bytes, payloadStart, boxEnd, tracks, [...path, type]);
    }
    offset = boxEnd;
  }
}

export function validateInitSegmentTracks(bytes) {
  if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]') {
    fail('LIVE_INIT_INVALID', 'fMP4 初始化片段不是 ArrayBuffer');
  }
  const view = new Uint8Array(bytes);
  const tracks = new Set();
  visitBoxes(view, 0, view.byteLength, tracks);
  if (!tracks.has('vide')) {
    fail('LIVE_VIDEO_TRACK_MISSING', 'fMP4 初始化片段没有 video track 声明');
  }
  if (!tracks.has('soun')) {
    fail('LIVE_AUDIO_TRACK_MISSING', 'fMP4 初始化片段没有 audio track 声明');
  }
  return { video: true, audio: true };
}

export class MseAppendPipeline {
  constructor(
    video,
    mediaSourceFactory = globalThis.MediaSource,
    urlApi = globalThis.URL,
    runtimeObject = globalThis,
    waitTimeoutMilliseconds = 5000,
  ) {
    this.video = requireValue(video, 'MSE_VIDEO_MISSING', 'MSE 管线缺少 video 元素');
    this.mediaSourceFactory = mediaSourceFactory;
    this.urlApi = urlApi;
    this.runtimeObject = runtimeObject;
    this.waitTimeoutMilliseconds = waitTimeoutMilliseconds;
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
      await waitForEvent(
        this.mediaSource,
        'sourceopen',
        'error',
        this.runtimeObject,
        this.waitTimeoutMilliseconds,
      );
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
      await waitForEvent(this.sourceBuffer, 'updateend', 'error', this.runtimeObject, this.waitTimeoutMilliseconds);
    }
    try {
      this.sourceBuffer.appendBuffer(bytes);
    } catch (error) {
      const code = error?.name === 'QuotaExceededError' ? 'MSE_QUOTA_EXCEEDED' : 'MSE_APPEND_ERROR';
      throw toBufferScriptError(error, code, `MSE 追加片段失败: ${code}`);
    }
    if (this.sourceBuffer.updating) {
      try {
        await waitForEvent(this.sourceBuffer, 'updateend', 'error', this.runtimeObject, this.waitTimeoutMilliseconds);
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
      await waitForEvent(this.sourceBuffer, 'updateend', 'error', this.runtimeObject, this.waitTimeoutMilliseconds);
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
      await waitForEvent(this.sourceBuffer, 'updateend', 'error', this.runtimeObject, this.waitTimeoutMilliseconds);
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
