import { LIVE_CONFIG } from '../constants.js';
import { BufferScriptError, fail, requireValue } from '../errors.js';
import { buildCdnCandidates, codecListsMatch } from './manifest.js';

export function buildRoomPlayInfoUrl(roomId, qualityNumber = 10000) {
  const url = new URL('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo');
  url.searchParams.set('room_id', String(roomId));
  url.searchParams.set('protocol', '0,1');
  url.searchParams.set('format', '0,1,2');
  url.searchParams.set('codec', '0,1');
  url.searchParams.set('qn', String(qualityNumber));
  url.searchParams.set('platform', 'web');
  url.searchParams.set('ptype', '8');
  return url.href;
}

function abortError() {
  return new BufferScriptError('REQUEST_ABORTED', '播放 API 请求被取消');
}

function sleep(milliseconds, signal) {
  if (signal?.aborted === true) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestPlayInfo(url, fetchImpl, signal, timeoutMilliseconds) {
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let timedOut = false;
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
    timeoutReject(new BufferScriptError('REQUEST_TIMEOUT', `播放 API 请求超时: ${new URL(url).host}`));
  }, timeoutMilliseconds);
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: requestController.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new BufferScriptError('PLAY_INFO_TEMPORARY_HTTP_ERROR', `播放 API 返回 HTTP ${response.status}`);
      }
      fail('PLAY_INFO_HTTP_ERROR', `播放 API 返回 HTTP ${response.status}`);
    }
    return await Promise.race([response.json(), timeoutPromise]);
  } catch (error) {
    if (signal?.aborted === true) {
      throw abortError();
    }
    if (timedOut) {
      throw new BufferScriptError('PLAY_INFO_TEMPORARY_ERROR', `播放 API 请求超时: ${new URL(url).host}`, error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function fetchRoomPlayInfo(
  roomId,
  qualityNumber,
  fetchImpl = globalThis.fetch.bind(globalThis),
  options = {},
) {
  const timeoutMilliseconds = options.requestTimeoutMilliseconds ?? LIVE_CONFIG.requestTimeoutMilliseconds;
  const backoffMilliseconds = options.retryBackoffMilliseconds ?? LIVE_CONFIG.retryBackoffMilliseconds;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    fail('REQUEST_TIMEOUT_INVALID', '播放 API 请求超时必须为正数');
  }
  if (!Array.isArray(backoffMilliseconds) || backoffMilliseconds.length === 0) {
    fail('RETRY_BACKOFF_MISSING', '播放 API 重试没有配置退避间隔');
  }
  let attempt = 0;
  while (true) {
    try {
      const payload = await requestPlayInfo(
        buildRoomPlayInfoUrl(roomId, qualityNumber),
        fetchImpl,
        options.signal,
        timeoutMilliseconds,
      );
      if (payload.code !== 0) {
        fail('PLAY_INFO_REJECTED', `播放 API 拒绝请求: ${payload.message || payload.code}`);
      }
      return payload;
    } catch (error) {
      if (
        error?.code !== undefined &&
        !['PLAY_INFO_TEMPORARY_HTTP_ERROR', 'PLAY_INFO_TEMPORARY_ERROR', 'REQUEST_TIMEOUT'].includes(error.code)
      ) {
        throw error;
      }
      options.onRetry?.({
        kind: 'play-info',
        attempt: attempt + 1,
        hosts: ['api.live.bilibili.com'],
      });
      await sleep(backoffMilliseconds[Math.min(attempt, backoffMilliseconds.length - 1)], options.signal);
      attempt += 1;
    }
  }
}

function protocolIsHls(stream) {
  return stream.protocol_name === 'http_hls';
}

export function extractLiveTrack(payload, requestedQualityNumber = 10000, preferredCodec = 'avc') {
  const data = requireValue(payload.data, 'PLAY_INFO_DATA_MISSING', '播放 API 缺少 data');
  const roomId = Number(data.room_id);
  if (!Number.isInteger(roomId)) {
    fail('PLAY_INFO_ROOM_MISSING', '播放 API 缺少有效 room_id');
  }
  const playurl = requireValue(data.playurl_info?.playurl, 'PLAY_INFO_STREAM_MISSING', '播放 API 缺少 playurl');
  const streams = requireValue(playurl.stream, 'PLAY_INFO_STREAM_MISSING', '播放 API 缺少 stream');
  const hlsStreams = streams.filter(protocolIsHls);
  if (hlsStreams.length === 0) {
    fail('LIVE_HLS_MISSING', '播放 API 没有 HLS 流');
  }
  const formats = hlsStreams.flatMap((stream) => stream.format || []).filter((format) => format.format_name === 'fmp4');
  if (formats.length === 0) {
    fail('LIVE_FMP4_MISSING', '播放 API 没有 fMP4 流');
  }
  const codecs = formats.flatMap((format) => format.codec || []);
  const hasTrackCodecs = (codec) =>
    typeof codec.video_codecs?.base === 'string' &&
    codec.video_codecs.base.trim().length > 0 &&
    typeof codec.audio_codecs?.base === 'string' &&
    codec.audio_codecs.base.trim().length > 0;
  const preferred = codecs.find((codec) => codec.codec_name === preferredCodec && hasTrackCodecs(codec));
  const codec = preferred || codecs.find((candidate) => candidate.codec_name === 'avc' && hasTrackCodecs(candidate));
  if (codec === undefined) {
    const preferredWithoutAudio = codecs.find((candidate) => candidate.codec_name === preferredCodec);
    if (
      preferredWithoutAudio !== undefined &&
      (typeof preferredWithoutAudio.audio_codecs?.base !== 'string' || preferredWithoutAudio.audio_codecs.base.trim() === '')
    ) {
      fail('LIVE_AUDIO_CODEC_MISSING', '播放 API 没有返回直播音频 codec');
    }
    const preferredWithoutVideo = codecs.find((candidate) => candidate.codec_name === preferredCodec);
    if (
      preferredWithoutVideo !== undefined &&
      (typeof preferredWithoutVideo.video_codecs?.base !== 'string' || preferredWithoutVideo.video_codecs.base.trim() === '')
    ) {
      fail('LIVE_VIDEO_CODEC_MISSING', '播放 API 没有返回直播视频 codec');
    }
    fail('LIVE_CODEC_MISSING', `播放 API 没有可用 codec: ${preferredCodec}`);
  }
  const qualityNumber = Number(codec.current_qn);
  if (!Number.isInteger(qualityNumber)) {
    fail('LIVE_QUALITY_MISSING', '播放 API 缺少当前清晰度编号');
  }
  const baseUrl = requireValue(codec.base_url, 'PLAYBACK_BASE_URL_MISSING', '播放轨道缺少 base_url');
  const urlInfo = requireValue(codec.url_info, 'PLAYBACK_CDN_MISSING', '播放轨道缺少 url_info');
  const candidates = buildCdnCandidates({ baseUrl, urlInfo });
  const qualityDescription = [
    codec.description,
    codec.desc,
    codec.display_name,
    codec.quality_name,
    codec.qn_desc,
    codec.name,
    ...((playurl.g_qn_desc || [])
      .filter((description) => Number(description?.qn) === qualityNumber)
      .flatMap((description) => [description.desc, description.description, description.name])),
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  return {
    roomId,
    requestedQualityNumber,
    qualityNumber,
    qualityDescription,
    formatName: 'fmp4',
    codecName: codec.codec_name,
    videoCodecString: codec.video_codecs.base,
    audioCodecString: codec.audio_codecs.base,
    codecString: `${codec.video_codecs.base}, ${codec.audio_codecs.base}`,
    session: requireValue(codec.session, 'LIVE_SESSION_MISSING', '播放轨道缺少 stream session'),
    baseUrl,
    urlInfo,
    candidates,
    acceptQualityNumbers: codec.accept_qn || [],
  };
}

export function assertSameLiveSession(previous, next) {
  if (previous.roomId !== next.roomId) {
    fail('LIVE_SESSION_ROOM_CHANGED', '签名续期改变了直播间');
  }
  if (previous.qualityNumber !== next.qualityNumber) {
    fail('LIVE_SESSION_QUALITY_CHANGED', '签名续期改变了当前清晰度');
  }
  if (
    previous.formatName !== next.formatName ||
    previous.codecName !== next.codecName ||
    !codecListsMatch(previous.codecString, next.codecString)
  ) {
    fail('LIVE_SESSION_FORMAT_CHANGED', '签名续期改变了 fMP4 或 codec');
  }
  if (previous.session !== next.session) {
    fail('LIVE_SESSION_CHANGED', '签名续期改变了 stream session');
  }
  return true;
}

export async function renewLiveTrack(previous, fetchImpl = globalThis.fetch.bind(globalThis), options = {}) {
  const payload = await fetchRoomPlayInfo(previous.roomId, previous.qualityNumber, fetchImpl, options);
  const next = extractLiveTrack(payload, previous.qualityNumber, previous.codecName);
  assertSameLiveSession(previous, next);
  return next;
}
