import { fail } from '../errors.js';

export const STATUS_MESSAGE_VERSION = 1;

const ACTION_NAMES = Object.freeze(['toggle', 'skip-gap', 'return-live']);
const DISPLAY_FIELDS = Object.freeze([
  'mode',
  'state',
  'inventory',
  'delay',
  'quality',
  'speed',
  'multiplier',
  'message',
  'stage',
]);
const VOD_DISPLAY_FIELDS = Object.freeze(['mode', 'state', 'inventory', 'message']);

let currentSurface;

function createSurfaceId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('UI_SURFACE_ID_UNAVAILABLE', '当前环境不能生成唯一状态 surface id');
  }
  return `surface-${globalThis.crypto.randomUUID()}`;
}

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

function emptyModel(mode) {
  return {
    mode,
    state: '未提供',
    inventory: '未提供',
    delay: '未提供',
    quality: '未提供',
    speed: '未提供',
    multiplier: '未提供',
    message: '未提供',
    stage: '未提供',
  };
}

export class StatusPanel {
  constructor(_documentObject, mode, actions = {}) {
    if (typeof mode !== 'string' || mode.length === 0) {
      fail('UI_MODE_INVALID', '状态 surface 缺少模式');
    }
    this.surfaceId = createSurfaceId();
    this.mode = mode;
    this.model = emptyModel(mode);
    this.actions = new Map();
    this.destroyed = false;
    this.boundTabId = undefined;
    this.freshnessCheck = () => true;
    this.snapshotRefresh = () => {};
    for (const [name, action] of Object.entries(actions)) {
      this.setAction(name, action.label, action.callback, action.visible !== false);
    }
    currentSurface = this;
  }

  setAction(name, label, callback, visible = true) {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    if (!ACTION_NAMES.includes(name)) {
      fail('UI_ACTION_UNKNOWN', `状态动作未允许: ${name}`);
    }
    if (typeof callback !== 'function') {
      fail('UI_ACTION_CALLBACK_INVALID', `状态动作 ${name} 缺少 callback`);
    }
    this.actions.set(name, { label: displayValue(label), callback, visible: visible === true });
  }

  setModel(model) {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    for (const field of DISPLAY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(model, field)) {
        this.model[field] = displayValue(model[field]);
      }
    }
  }

  setMessage(message) {
    this.setModel({ message });
  }

  setFreshnessCheck(callback) {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    if (typeof callback !== 'function') {
      fail('UI_SURFACE_FRESHNESS_INVALID', '状态 surface 缺少有效新鲜度检查');
    }
    this.freshnessCheck = callback;
  }

  setSnapshotRefresh(callback) {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    if (typeof callback !== 'function') {
      fail('UI_SNAPSHOT_REFRESH_INVALID', '状态 surface 缺少有效刷新回调');
    }
    this.snapshotRefresh = callback;
  }

  assertFresh() {
    if (this.freshnessCheck() !== true) {
      fail('UI_SURFACE_STALE', '状态 surface 已不属于当前页面');
    }
  }

  bindTab(tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) {
      fail('UI_TAB_INVALID', '状态 surface 的 tab id 无效');
    }
    if (this.boundTabId !== undefined && this.boundTabId !== tabId) {
      fail('UI_TAB_MISMATCH', '状态 surface 不属于请求 tab');
    }
    this.boundTabId = tabId;
  }

  getSnapshot() {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    this.assertFresh();
    this.snapshotRefresh();
    this.assertFresh();
    const actions = {};
    for (const [name, action] of this.actions) {
      if (action.visible) {
        actions[name] = action.label;
      }
    }
    return {
      version: STATUS_MESSAGE_VERSION,
      surfaceId: this.surfaceId,
      ...Object.fromEntries(
        (this.mode === '点播' ? VOD_DISPLAY_FIELDS : DISPLAY_FIELDS)
          .map((field) => [field, displayValue(this.model[field])]),
      ),
      actions,
    };
  }

  runAction(name) {
    if (this.destroyed) {
      fail('UI_SURFACE_DESTROYED', '状态 surface 已销毁');
    }
    this.assertFresh();
    if (!ACTION_NAMES.includes(name)) {
      fail('UI_ACTION_UNKNOWN', `状态动作未允许: ${name}`);
    }
    const action = this.actions.get(name);
    if (action === undefined || !action.visible) {
      fail('UI_ACTION_NOT_VISIBLE', `状态动作当前不可见: ${name}`);
    }
    return action.callback();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.actions.clear();
    if (currentSurface === this) {
      currentSurface = undefined;
    }
  }
}

export function createStatusPanel(documentObject, mode, actions) {
  return new StatusPanel(documentObject, mode, actions);
}

export function getCurrentStatusSurface() {
  return currentSurface;
}

export function createUnavailableStatusSnapshot() {
  return {
    version: STATUS_MESSAGE_VERSION,
    surfaceId: 'surface-unavailable',
    ...Object.fromEntries(DISPLAY_FIELDS.map((field) => [field, '未提供'])),
    actions: {},
  };
}

export function isVisibleActionName(name) {
  return ACTION_NAMES.includes(name);
}
