import { fail } from '../errors.js';

export const STATUS_MESSAGE_VERSION = 2;

const MODE_LABELS = Object.freeze({ live: '直播', video: '视频' });
const VIDEO_FIELDS = Object.freeze([
  'mode',
  'state',
  'buffered',
  'target',
  'error',
  'sessionId',
  'persistence',
]);
const LIVE_FIELDS = Object.freeze([
  'mode',
  'paused',
  'recentFrame',
  'buffered',
  'delay',
  'resolution',
  'quality',
  'speed',
  'videoReplacements',
  'sourceReplacements',
  'recentEvent',
  'error',
  'sessionId',
  'persistence',
]);

const VIDEO_STATE_LABELS = Object.freeze({
  WAITING: '等待',
  APPLIED: '已应用',
  UNSUPPORTED: '不支持',
  FAILED: '失败',
});

let currentSurface;

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

function fieldsForMode(mode) {
  if (mode === 'video') return VIDEO_FIELDS;
  if (mode === 'live') return LIVE_FIELDS;
  fail('UI_MODE_INVALID', `状态 surface 模式未允许: ${mode}`);
}

function createSurfaceId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('UI_SURFACE_ID_UNAVAILABLE', '当前环境不能生成唯一状态 surface id');
  }
  return `surface-${globalThis.crypto.randomUUID()}`;
}

export class StatusPanel {
  constructor(_documentObject, mode) {
    fieldsForMode(mode);
    this.surfaceId = createSurfaceId();
    this.mode = mode;
    this.model = Object.fromEntries(fieldsForMode(mode).map((field) => [field, '未提供']));
    this.destroyed = false;
    this.boundTabId = undefined;
    this.freshnessCheck = () => true;
    this.snapshotRefresh = () => {};
    currentSurface = this;
  }

  setModel(model) {
    if (this.destroyed) fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    for (const field of fieldsForMode(this.mode)) {
      if (Object.prototype.hasOwnProperty.call(model, field)) this.model[field] = displayValue(model[field]);
    }
  }

  setMessage(message) {
    this.setModel({ error: message });
  }

  setFreshnessCheck(callback) {
    if (this.destroyed) fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    if (typeof callback !== 'function') fail('UI_SURFACE_FRESHNESS_INVALID', '状态 surface 缺少新鲜度检查');
    this.freshnessCheck = callback;
  }

  setSnapshotRefresh(callback) {
    if (this.destroyed) fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    if (typeof callback !== 'function') fail('UI_SNAPSHOT_REFRESH_INVALID', '状态 surface 缺少刷新回调');
    this.snapshotRefresh = callback;
  }

  assertFresh() {
    if (this.freshnessCheck() !== true) fail('UI_SURFACE_STALE', '状态 surface 已不属于当前页面');
  }

  bindTab(tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) fail('UI_TAB_INVALID', '状态 surface 的 tab id 无效');
    if (this.boundTabId !== undefined && this.boundTabId !== tabId) fail('UI_TAB_MISMATCH', '状态 surface 不属于请求 tab');
    this.boundTabId = tabId;
  }

  getSnapshot() {
    if (this.destroyed) fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    this.assertFresh();
    this.snapshotRefresh();
    this.assertFresh();
    const model = Object.fromEntries(fieldsForMode(this.mode).map((field) => [
      field,
      field === 'state' && this.mode === 'video'
        ? VIDEO_STATE_LABELS[this.model[field]] || displayValue(this.model[field])
        : displayValue(this.model[field]),
    ]));
    return {
      version: STATUS_MESSAGE_VERSION,
      surfaceId: this.surfaceId,
      ...model,
      mode: MODE_LABELS[this.mode],
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (currentSurface === this) currentSurface = undefined;
  }
}

export function createStatusPanel(documentObject, mode) {
  return new StatusPanel(documentObject, mode);
}

export function getCurrentStatusSurface() {
  return currentSurface;
}

export function createUnavailableStatusSnapshot(routeMode) {
  const mode = routeMode === 'live' ? 'live' : routeMode === 'video' || routeMode === 'vod' ? 'video' : undefined;
  const fields = mode === undefined ? ['mode'] : fieldsForMode(mode);
  return {
    version: STATUS_MESSAGE_VERSION,
    surfaceId: 'surface-unavailable',
    ...Object.fromEntries(fields.map((field) => [field, '未提供'])),
    ...(mode === undefined ? {} : { mode: MODE_LABELS[mode] }),
  };
}

export { LIVE_FIELDS, VIDEO_FIELDS };
