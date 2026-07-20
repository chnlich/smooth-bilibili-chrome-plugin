import { EXTENSION_PREFERENCES } from '../constants.js';

const MESSAGE_VERSION = 1;
const PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
const ACTION_LABELS = Object.freeze({
  toggle: '启用/停用',
  'skip-gap': '跨过缺口',
  'return-live': '回到直播',
});
const FIELDS = Object.freeze(['mode', 'state', 'inventory', 'delay', 'quality', 'speed', 'multiplier', 'stage', 'message']);

const statusElement = document.querySelector('[data-status]');
const actionElement = document.querySelector('[data-actions]');
const inputs = new Map(
  PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)]),
);
let latestSnapshot;
let latestTabId;
let pollTimer;

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

function unavailableSnapshot() {
  return Object.fromEntries(FIELDS.map((field) => [field, '未提供']));
}

function renderSnapshot(snapshot, tabId) {
  const values = snapshot === undefined ? unavailableSnapshot() : snapshot;
  const mode = values.mode;
  for (const row of document.querySelectorAll('[data-live-only="true"]')) {
    row.hidden = mode === '点播';
  }
  for (const field of FIELDS) {
    const element = document.querySelector(`[data-status-field="${field}"]`);
    element.textContent = displayValue(values[field]);
  }
  actionElement.replaceChildren();
  const actions = values.actions || {};
  for (const [name, label] of Object.entries(actions)) {
    if (!(name in ACTION_LABELS)) {
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = name;
    button.textContent = displayValue(label);
    button.addEventListener('click', () => {
      void runAction(name, snapshot.surfaceId);
    });
    actionElement.append(button);
  }
  latestSnapshot = snapshot;
  latestTabId = tabId;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) {
    return undefined;
  }
  return tabs[0];
}

async function getSnapshot() {
  const tab = await activeTab();
  if (tab === undefined) {
    return undefined;
  }
  const response = await chrome.tabs.sendMessage(tab.id, {
    version: MESSAGE_VERSION,
    type: 'status:get',
  });
  if (response?.ok === false) {
    throw new Error(response.error?.message || '当前页面拒绝状态请求');
  }
  return { tabId: tab.id, snapshot: response };
}

async function pollStatus() {
  try {
    const result = await getSnapshot();
    renderSnapshot(result?.snapshot, result?.tabId);
    statusElement.textContent = result === undefined ? '当前活动页面未提供扩展状态。' : '状态每 500ms 刷新。';
  } catch (error) {
    renderSnapshot(undefined, undefined);
    statusElement.textContent = `读取当前页面状态失败: ${error.message || error}`;
  }
}

async function runAction(action, surfaceId) {
  if (latestSnapshot === undefined || latestSnapshot.surfaceId !== surfaceId) {
    statusElement.textContent = '动作属于过期页面状态，已拒绝。';
    await pollStatus();
    return;
  }
  try {
    const tab = await activeTab();
    if (tab === undefined) {
      throw new Error('没有可用活动 tab');
    }
    if (latestTabId !== tab.id) {
      statusElement.textContent = '活动 tab 已变化，已拒绝使用旧页面状态执行动作。';
      await pollStatus();
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      version: MESSAGE_VERSION,
      type: 'action:run',
      surfaceId,
      action,
    });
    if (response?.ok !== true) {
      throw new Error(response?.error?.message || '当前页面拒绝动作');
    }
    renderSnapshot(response.snapshot, tab.id);
    statusElement.textContent = '动作已提交。';
  } catch (error) {
    statusElement.textContent = `动作失败: ${error.message || error}`;
    await pollStatus();
  }
}

async function loadPreferences() {
  const values = await chrome.storage.local.get(PREFERENCES);
  for (const name of PREFERENCES) {
    inputs.get(name).checked = values[name] !== false;
  }
}

for (const name of PREFERENCES) {
  inputs.get(name).addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [name]: event.currentTarget.checked });
    statusElement.textContent = '已保存，下次刷新页面后生效。';
  });
}

void loadPreferences().catch((error) => {
  console.error('[BilibiliBuffer] Popup 读取设置失败', error);
  statusElement.textContent = `读取设置失败: ${error.message || error}`;
});

void pollStatus();
pollTimer = setInterval(() => void pollStatus(), 500);
window.addEventListener('pagehide', () => {
  clearInterval(pollTimer);
  pollTimer = undefined;
});
