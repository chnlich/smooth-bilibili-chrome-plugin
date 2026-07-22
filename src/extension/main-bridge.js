import {
  assertOperation,
  BRIDGE_CORE_SYNC_METHODS,
  BRIDGE_LIVE_DISABLE_ARGS,
  BRIDGE_LIVE_METHODS,
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_ATTRIBUTE,
  BRIDGE_RESPONSE_EVENT,
  BRIDGE_VERSION,
  decodeMessage,
  encodeMessage,
  serializeError,
} from './bridge-contract.js';

const coreRecords = new WeakMap();
const coreRecordsById = new Map();
let nextCoreId = 1;
let activeCoreRecord;

function pagePlayerObject() {
  const player = globalThis.player;
  if (player === undefined || player === null || (typeof player !== 'object' && typeof player !== 'function')) {
    throw Object.assign(new Error('window.player 尚未可用'), { code: 'PLAYER_UNAVAILABLE' });
  }
  return player;
}

function pagePlayer() {
  const player = pagePlayerObject();
  if (typeof player.__core !== 'function') {
    throw Object.assign(new Error('window.player.__core() 尚未可用'), { code: 'VOD_CORE_UNAVAILABLE' });
  }
  return player;
}

function currentCore() {
  const core = pagePlayer().__core();
  if (core === undefined || core === null || (typeof core !== 'object' && typeof core !== 'function')) {
    throw Object.assign(new Error('window.player.__core() 返回空内核'), { code: 'VOD_CORE_UNAVAILABLE' });
  }
  return core;
}

function recordFor(core) {
  if (activeCoreRecord?.core === core) {
    return activeCoreRecord;
  }
  let record = coreRecords.get(core);
  if (record === undefined) {
    record = { core, id: nextCoreId };
    nextCoreId += 1;
    coreRecords.set(core, record);
  }
  coreRecordsById.clear();
  coreRecordsById.set(record.id, record);
  activeCoreRecord = record;
  return record;
}

function findLargestVideo() {
  const videos = [...document.querySelectorAll('video')];
  if (videos.length === 0) {
    return undefined;
  }
  return videos.sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
}

function readCurrentVideoSource() {
  const video = findLargestVideo();
  return video === undefined ? '' : video.currentSrc || video.src || '';
}

function readCoreCapabilities(core) {
  return {
    setStableBufferTime: typeof core.setStableBufferTime === 'function',
  };
}

function getCoreSnapshot() {
  const core = currentCore();
  const record = recordFor(core);
  return {
    coreId: record.id,
    source: readCurrentVideoSource(),
    capabilities: {
      core: readCoreCapabilities(core),
    },
  };
}

function requireCurrentRecord(coreId, source) {
  const current = recordFor(currentCore());
  const record = coreRecordsById.get(coreId);
  if (record === undefined || record !== current || readCurrentVideoSource() !== source) {
    throw Object.assign(new Error(`页面播放器内核或媒体 source ${coreId} 已过期`), { code: 'BRIDGE_CORE_STALE' });
  }
  return record;
}

function requireArguments(args, count) {
  if (!Array.isArray(args) || args.length !== count) {
    throw Object.assign(new Error(`桥接操作参数数量错误，期望 ${count}`), { code: 'BRIDGE_ARGUMENTS_INVALID' });
  }
  return args;
}

function livePlayerCandidates() {
  return [
    globalThis.EmbedPlayer?.instance,
    globalThis.livePlayer,
    globalThis.__PLAYER_GLOBAL_INSTANCE__,
    globalThis.player,
  ].filter((candidate) => candidate !== undefined && candidate !== null);
}

function liveAutoCatchupCandidate() {
  return livePlayerCandidates().find((candidate) =>
    BRIDGE_LIVE_METHODS.some((method) => typeof candidate?.[method] === 'function'));
}

function getLiveCapabilitySnapshot() {
  const candidate = liveAutoCatchupCandidate();
  return {
    live: {
      disableAutoCatchup: candidate !== undefined,
    },
  };
}

async function disableLiveAutoCatchup() {
  const candidate = liveAutoCatchupCandidate();
  if (candidate === undefined) {
    throw Object.assign(new Error('页面播放器没有关闭自动追赶能力'), {
      code: 'LIVE_AUTO_CATCHUP_UNAVAILABLE',
    });
  }
  const applied = [];
  for (const method of BRIDGE_LIVE_METHODS) {
    if (typeof candidate[method] !== 'function') continue;
    const args = BRIDGE_LIVE_DISABLE_ARGS[method];
    try {
      await candidate[method](args);
      applied.push(method);
    } catch (error) {
      throw Object.assign(new Error(`关闭自动追赶方法 ${method} 调用失败: ${error?.message || error}`), {
        code: 'LIVE_AUTO_CATCHUP_FAILED',
        cause: error,
      });
    }
  }
  return { applied };
}

function callCoreSync(args) {
  const [coreId, method, methodArgs, source] = requireArguments(args, 4);
  if (!Number.isInteger(coreId) || typeof source !== 'string' || !BRIDGE_CORE_SYNC_METHODS.includes(method)) {
    throw Object.assign(new Error(`内核同步操作未允许: ${method}`), { code: 'BRIDGE_OPERATION_DENIED' });
  }
  const record = requireCurrentRecord(coreId, source);
  const values = methodArgs === undefined ? [] : methodArgs;
  if (!Array.isArray(values)) {
    throw Object.assign(new Error('内核操作参数必须是数组'), { code: 'BRIDGE_ARGUMENTS_INVALID' });
  }
  if (typeof record.core[method] !== 'function') {
    throw Object.assign(new Error(`当前内核没有 ${method}`), { code: 'BRIDGE_METHOD_UNAVAILABLE' });
  }
  if (method === 'setStableBufferTime' && (values.length !== 1 || !Number.isFinite(values[0]) || values[0] <= 0)) {
    throw Object.assign(new Error('稳定缓冲秒数必须是正数'), { code: 'BRIDGE_ARGUMENTS_INVALID' });
  }
  return record.core[method](...values);
}

function invoke(request) {
  assertOperation(request.operation);
  switch (request.operation) {
    case 'getCoreSnapshot':
      requireArguments(request.args, 0);
      return getCoreSnapshot();
    case 'callCoreSync':
      return callCoreSync(request.args);
    case 'getLiveCapabilitySnapshot':
      requireArguments(request.args, 0);
      return getLiveCapabilitySnapshot();
    case 'disableLiveAutoCatchup':
      requireArguments(request.args, 0);
      return disableLiveAutoCatchup();
    default:
      throw new Error(`未处理的桥接操作: ${request.operation}`);
  }
}

function sendResponse(request, response) {
  const serialized = encodeMessage({ ...response, operation: request.operation });
  if (request.mode === 'sync') {
    document.documentElement.setAttribute(BRIDGE_RESPONSE_ATTRIBUTE, serialized);
  } else {
    document.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: serialized }));
  }
}

function respond(request, operation) {
  try {
    const value = operation();
    if (value instanceof Promise) {
      void value
        .then((result) => {
          sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: true, value: result });
        })
        .catch((error) => {
          sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
        });
      return;
    }
    sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: true, value });
  } catch (error) {
    sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
  }
}

document.addEventListener(BRIDGE_REQUEST_EVENT, (event) => {
  try {
    const request = decodeMessage(event.detail);
    const requestFields = new Set(['version', 'id', 'operation', 'args', 'mode']);
    if (Object.keys(request).some((field) => !requestFields.has(field))) {
      throw new Error('bridge request contains fields that are not allowed');
    }
    if (request.mode !== 'sync' && request.mode !== 'async') {
      throw new Error('bridge request mode is invalid');
    }
    if (!Array.isArray(request.args)) {
      throw new Error('bridge request args must be an array');
    }
    assertOperation(request.operation);
    respond(request, () => invoke(request));
  } catch (error) {
    const raw = typeof event.detail === 'string' ? event.detail : '';
    let request;
    try {
      request = JSON.parse(raw);
    } catch (parseError) {
      console.error('[BilibiliBuffer] 无法解析桥接请求', serializeError(parseError));
      return;
    }
    console.warn('[BilibiliBuffer] 拒绝无效桥接请求', serializeError(error));
    if (Number.isInteger(request?.id) && (request.mode === 'sync' || request.mode === 'async')) {
      sendResponse(request, { version: BRIDGE_VERSION, id: request.id, ok: false, error: serializeError(error) });
    }
  }
});
