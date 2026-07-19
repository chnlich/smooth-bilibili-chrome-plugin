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

export function readQualitySnapshot(player, core, options = {}) {
  if (arguments.length === 1) {
    core = player;
    player = undefined;
  }
  const logger = options.logger || { warn() {} };
  const video = options.video;
  const playerObservation = readQualitySource(player, '页面播放器', logger);
  const coreObservation = readQualitySource(core, 'core', logger);
  const selected = playerObservation.qn === undefined ? coreObservation : playerObservation;
  const selectedSource = selected.qn === undefined ? '未知' : selected.source;
  const availableQns = [...new Set([...playerObservation.availableQns, ...coreObservation.availableQns])];
  return {
    source: selectedSource,
    getter: selected.getter,
    raw: selected.raw,
    qn: selected.qn,
    actualQn: selected.qn,
    availableQns,
    width: qualityDimension(video?.videoWidth, selected.raw?.width ?? selected.raw?.videoWidth),
    height: qualityDimension(video?.videoHeight, selected.raw?.height ?? selected.raw?.videoHeight),
    capabilities: {
      player: playerObservation.capabilities,
      core: coreObservation.capabilities,
    },
  };
}

function qualityDimension(videoValue, qualityValue) {
  const value = Number(videoValue ?? qualityValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function supportsQualityMethod(source, method, logger, sourceName) {
  if (source === undefined || source === null) {
    return false;
  }
  try {
    if (typeof source.supports === 'function') {
      return source.supports(method) === true;
    }
    if (source.capabilities !== undefined && Object.prototype.hasOwnProperty.call(source.capabilities, method)) {
      return source.capabilities[method] === true;
    }
    return typeof source[method] === 'function';
  } catch (error) {
    logger.warn(`读取${sourceName}画质能力失败`, error);
    return false;
  }
}

function readQualityGetter(source, method, logger, sourceName) {
  if (!supportsQualityMethod(source, method, logger, sourceName)) {
    return { available: false, value: undefined };
  }
  try {
    return { available: true, value: source[method]() };
  } catch (error) {
    logger.warn(`读取${sourceName}画质 getter ${method} 失败`, error);
    return { available: true, value: undefined };
  }
}

function readQualitySource(source, sourceName, logger) {
  const quality = readQualityGetter(source, 'getQuality', logger, sourceName);
  const supported = readQualityGetter(source, 'getSupportedQualityList', logger, sourceName);
  const availableQns = new Set();
  const value = quality.value;
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
  collectQualityNumbers(supported.value, availableQns);
  const currentQn = actualQualityNumberFromValue(value);
  return {
    source: sourceName,
    getter: quality.available ? 'getQuality' : undefined,
    raw: value,
    qn: currentQn,
    availableQns: [...availableQns],
    capabilities: {
      getQuality: quality.available,
      getSupportedQualityList: supported.available,
    },
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
