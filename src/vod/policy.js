import { VOD_CONFIG } from '../constants.js';
import { fail, requireValue } from '../errors.js';

export function coreSupports(core, method) {
  requireValue(core, 'VOD_CORE_MISSING', '点播内核为空');
  if (typeof core.supports === 'function') {
    return core.supports(method) === true;
  }
  if (core.capabilities?.core !== undefined && Object.prototype.hasOwnProperty.call(core.capabilities.core, method)) {
    return core.capabilities.core[method] === true;
  }
  return typeof core[method] === 'function';
}

function playerSupports(player, method) {
  if (player === undefined || player === null) {
    return false;
  }
  if (typeof player.supports === 'function') {
    return player.supports(method) === true;
  }
  if (player.capabilities !== undefined && Object.prototype.hasOwnProperty.call(player.capabilities, method)) {
    return player.capabilities[method] === true;
  }
  return typeof player[method] === 'function';
}

export class VodBufferPolicy {
  constructor(config = VOD_CONFIG) {
    this.config = config;
    this.applied = new WeakMap();
    this.targetSeconds = config.stableBufferSeconds;
    this.fallbackIndex = -1;
  }

  apply(core) {
    requireValue(core, 'VOD_CORE_MISSING', '点播内核为空');
    const previous = this.applied.get(core) || {};
    const result = {
      changed: false,
      targetSeconds: this.targetSeconds,
      stableBufferSupported: coreSupports(core, 'setStableBufferTime'),
      pausedSchedulingSupported: coreSupports(core, 'setScheduleWhilePaused'),
      warnings: [],
    };
    if (!result.stableBufferSupported) {
      result.warnings.push('当前内核不支持稳定缓冲设置，保持 Bilibili 默认值');
    } else if (previous.stableBufferTime !== this.targetSeconds) {
      try {
        core.setStableBufferTime(this.targetSeconds);
        previous.stableBufferTime = this.targetSeconds;
        result.changed = true;
      } catch (error) {
        if (!['BRIDGE_METHOD_UNAVAILABLE', 'VOD_STABLE_BUFFER_UNAVAILABLE'].includes(error?.code)) {
          throw error;
        }
        result.stableBufferSupported = false;
        result.warnings.push('当前内核不支持稳定缓冲设置，保持 Bilibili 默认值');
      }
    }
    if (!result.pausedSchedulingSupported) {
      result.warnings.push('当前内核不支持暂停时继续下载，低库存时保持播放');
    } else if (previous.scheduleWhilePaused !== true) {
      try {
        core.setScheduleWhilePaused(true);
        previous.scheduleWhilePaused = true;
        result.changed = true;
      } catch (error) {
        if (!['BRIDGE_METHOD_UNAVAILABLE', 'VOD_PAUSED_SCHEDULE_UNAVAILABLE'].includes(error?.code)) {
          throw error;
        }
        result.pausedSchedulingSupported = false;
        result.warnings.push('当前内核不支持暂停时继续下载，低库存时保持播放');
      }
    }
    this.applied.set(core, previous);
    return result;
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

export async function callQualityMethod(player, core, qualityNumber) {
  if (!Number.isInteger(qualityNumber) || qualityNumber <= 0) {
    fail('VOD_QUALITY_ARGUMENT_INVALID', `qn${qualityNumber} 不是正整数清晰度`);
  }
  let method;
  if (coreSupports(core, 'requestQuality')) {
    method = 'core.requestQuality';
  } else if (playerSupports(player, 'requestQuality')) {
    method = 'player.requestQuality';
  } else {
    fail('VOD_QUALITY_UNAVAILABLE', `当前播放器没有权限感知的 qn${qualityNumber} 请求接口`);
  }
  const result = method === 'core.requestQuality'
    ? await core.requestQuality(qualityNumber)
    : await player.requestQuality(qualityNumber);
  if (result === false) {
    fail('VOD_QUALITY_REJECTED', `服务端或播放器拒绝 qn${qualityNumber}`);
  }
  return { method, qualityNumber };
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
    if (coreSupports(core, name)) {
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
  if (coreSupports(core, 'getSupportedQualityList')) {
    collectQualityNumbers(core.getSupportedQualityList(), availableQns);
  }
  if (coreSupports(core, 'getQualityList')) {
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
    if (!coreSupports(core, getter)) {
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
