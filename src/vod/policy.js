import { VOD_CONFIG } from '../constants.js';
import { fail, requireValue } from '../errors.js';

export class VodBufferPolicy {
  constructor(config = VOD_CONFIG) {
    this.config = config;
    this.applied = new WeakMap();
    this.targetSeconds = config.stableBufferSeconds;
    this.fallbackIndex = -1;
  }

  apply(core) {
    requireValue(core, 'VOD_CORE_MISSING', '点播内核为空');
    const previous = this.applied.get(core);
    if (previous === this.targetSeconds) {
      return { changed: false, targetSeconds: this.targetSeconds };
    }
    if (typeof core.setStableBufferTime !== 'function') {
      fail('VOD_STABLE_BUFFER_UNAVAILABLE', '点播内核没有 setStableBufferTime');
    }
    if (typeof core.setScheduleWhilePaused !== 'function') {
      fail('VOD_PAUSED_SCHEDULE_UNAVAILABLE', '点播内核没有 setScheduleWhilePaused');
    }
    core.setStableBufferTime(this.targetSeconds);
    core.setScheduleWhilePaused(true);
    this.applied.set(core, this.targetSeconds);
    return { changed: true, targetSeconds: this.targetSeconds };
  }

  handleQuota(core) {
    const nextIndex = this.fallbackIndex + 1;
    if (nextIndex >= this.config.quotaFallbackSeconds.length) {
      fail('VOD_QUOTA_EXHAUSTED', '点播 MSE 配额在 180→120→90 秒策略下仍不足');
    }
    this.fallbackIndex = nextIndex;
    this.targetSeconds = this.config.quotaFallbackSeconds[nextIndex];
    const result = this.apply(core);
    return { ...result, quotaFallback: this.targetSeconds };
  }

  resetForNewSession() {
    this.targetSeconds = this.config.stableBufferSeconds;
    this.fallbackIndex = -1;
    this.applied = new WeakMap();
  }
}

export async function callQualityMethod(_player, core, qualityNumber) {
  if (typeof core.requestQuality !== 'function') {
    fail('VOD_QUALITY_UNAVAILABLE', `当前播放器内核没有权限感知的 qn${qualityNumber} 请求接口`);
  }
  const result = await core.requestQuality(qualityNumber);
  if (result === false) {
    fail('VOD_QUALITY_REJECTED', `服务端或播放器拒绝 qn${qualityNumber}`);
  }
  return { method: 'requestQuality', qualityNumber };
}

function qualityNumberFromValue(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  for (const field of ['qn', 'qualityNumber', 'quality', 'nowQ', 'realQ', 'id', 'value']) {
    const candidate = qualityNumberFromValue(value[field]);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function actualQualityNumberFromValue(value) {
  if (value !== null && typeof value === 'object') {
    const realQuality = qualityNumberFromValue(value.realQ);
    if (realQuality !== undefined) {
      return realQuality;
    }
  }
  return qualityNumberFromValue(value);
}

function collectQualityNumbers(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const number = qualityNumberFromValue(item);
      if (number !== undefined) {
        target.add(number);
      }
    }
    return;
  }
  const number = qualityNumberFromValue(value);
  if (number !== undefined) {
    target.add(number);
  }
}

export function readQualitySnapshot(core) {
  let value;
  let getter;
  for (const name of ['getQuality', 'getCurrentQuality', 'getCurrentQn']) {
    if (typeof core[name] === 'function') {
      getter = name;
      value = core[name]();
      break;
    }
  }
  const availableQns = new Set();
  if (value !== undefined && value !== null && typeof value === 'object') {
    for (const field of [
      'oldA',
      'nowA',
      'newA',
      'acceptQuality',
      'accept_quality',
      'acceptQn',
      'accept_qn',
      'availableQuality',
      'availableQualities',
      'qualities',
      'oldQ',
      'newQ',
      'oldRQ',
    ]) {
      if (Array.isArray(value[field])) {
        collectQualityNumbers(value[field], availableQns);
      }
    }
  }
  if (typeof core.getSupportedQualityList === 'function') {
    collectQualityNumbers(core.getSupportedQualityList(), availableQns);
  }
  if (typeof core.getQualityList === 'function') {
    collectQualityNumbers(core.getQualityList('video'), availableQns);
  }
  return {
    getter,
    raw: value,
    qn: actualQualityNumberFromValue(value),
    availableQns: [...availableQns],
  };
}

export function readMediaBitrate(core) {
  const getters = ['getMediaInfo', 'getCurrentMediaInfo', 'getQualityInfo'];
  for (const getter of getters) {
    if (typeof core[getter] !== 'function') {
      continue;
    }
    const info = core[getter]();
    const bitrate = Number(info?.bitrate || info?.bandwidth || info?.video?.bitrate || info?.audio?.bitrate);
    if (Number.isFinite(bitrate) && bitrate > 0) {
      return bitrate;
    }
  }
  return undefined;
}
