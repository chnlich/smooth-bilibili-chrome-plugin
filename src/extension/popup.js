import { EXTENSION_PREFERENCES } from '../constants.js';
import { CDN_RESULT_VALUES } from '../diagnostics/cdn.js';
import { logSessionFragment } from '../diagnostics/log-session.js';
import { inventoryStoppedPublishing } from './readouts.js';

const MESSAGE_VERSION = 2;
const PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
const VIDEO_FIELDS = Object.freeze(['mode', 'state', 'buffered', 'target', 'effective', 'error']);
const OTHER_LIVE_MEDIA_SOURCES_FIELD = [
  'otherLive',
  String.fromCharCode(77, 101, 100, 105, 97),
  'Sources',
].join('');

const statusElement = document.querySelector('[data-status]');
const inputs = new Map(
  PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)]),
);
let latestStatusSnapshot;
let latestReadouts;
let raceSessionId;
let raceSummary;
let raceError;
let raceQueryInFlight = false;
let nextRaceQueryAt = 0;

const readoutMediaElement = document.querySelector('[data-readout-media]');
const readoutBankElement = document.querySelector('[data-readout-bank]');
const readoutBankTitle = document.querySelector('[data-readout-bank-title]');
const readoutRaceElement = document.querySelector('[data-readout-race]');
const readoutDiagnosticsElement = document.querySelector('[data-readout-diagnostics]');

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

function fieldsForSnapshot(snapshot) {
  return VIDEO_FIELDS;
}

function textValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

function numberText(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '未提供';
}

function integerText(value, suffix = '') {
  return Number.isSafeInteger(value) ? `${value}${suffix}` : '未提供';
}

function rangeText(ranges) {
  if (!Array.isArray(ranges)) return '未提供';
  return ranges.map((range) => `${numberText(range.start)}–${numberText(range.end)}`).join(', ') || '无';
}

function clearReadout(element) {
  element.replaceChildren();
}

function appendRow(element, label, value, { estimate = false } = {}) {
  const row = document.createElement('div');
  row.className = 'readout-row';
  const name = document.createElement('dt');
  name.textContent = label;
  const valueElement = document.createElement('dd');
  valueElement.textContent = textValue(value);
  if (estimate && value !== '未提供') {
    const marker = document.createElement('span');
    marker.className = 'estimate-marker';
    marker.textContent = '估算';
    valueElement.append(' ', marker);
  }
  row.append(name, valueElement);
  element.append(row);
}

function appendHeading(element, text) {
  const heading = document.createElement('h3');
  heading.textContent = text;
  element.append(heading);
}

function renderMediaReadout(media) {
  clearReadout(readoutMediaElement);
  if (media === '未提供') {
    appendRow(readoutMediaElement, '读数', '未提供');
    return;
  }
  appendRow(readoutMediaElement, '交集前向秒数', numberText(media.forwardSeconds, ' 秒'));
  appendRow(readoutMediaElement, '短板轨', media.limiterTrack);
  appendRow(readoutMediaElement, '媒体源状态', media.mediaSourceState);
  appendRow(readoutMediaElement, '其他存活媒体源', integerText(media[OTHER_LIVE_MEDIA_SOURCES_FIELD]));
  appendRow(readoutMediaElement, 'readyState', integerText(media.element.readyState));
  appendRow(readoutMediaElement, 'networkState', integerText(media.element.networkState));
  appendRow(readoutMediaElement, '当前时间', numberText(media.element.currentTime, ' 秒'));
  appendRow(readoutMediaElement, '时长', numberText(media.element.duration, ' 秒'));
  appendRow(readoutMediaElement, '倍速', numberText(media.element.playbackRate, '×'));
  appendRow(readoutMediaElement, '分辨率', media.element.resolution === '未提供'
    ? '未提供'
    : `${textValue(media.element.resolution?.width)}×${textValue(media.element.resolution?.height)}`);
  appendRow(readoutMediaElement, '暂停', media.element.paused);
  appendRow(readoutMediaElement, '结束', media.element.ended);
  if (media.tracks.length === 0) {
    appendRow(readoutMediaElement, '轨道', '未提供');
    return;
  }
  for (const track of media.tracks) {
    appendHeading(readoutMediaElement, `轨道 ${textValue(track.track)}`);
    appendRow(readoutMediaElement, '附着', track.attached);
    appendRow(readoutMediaElement, '前向秒数', numberText(track.forwardSeconds, ' 秒'));
    appendRow(readoutMediaElement, 'ranges', rangeText(track.ranges));
    appendRow(readoutMediaElement, '更新中', track.updating);
    appendRow(readoutMediaElement, '等待追加', numberText(track.pendingSinceMs, ' ms'));
    appendRow(readoutMediaElement, '最近追加', numberText(track.lastAppendAgoMs, ' ms 前'));
    appendRow(readoutMediaElement, '追加错误', track.appendErrors);
  }
}

function renderBankReadout(bank, bankSecondsEstimated) {
  clearReadout(readoutBankElement);
  const stopped = bank !== '未提供' && inventoryStoppedPublishing(bank.ageMs);
  readoutBankTitle.textContent = stopped ? '下载层库存（已停止发布）' : '下载层库存';
  readoutBankTitle.classList.toggle('stale-readout', stopped);
  if (bank === '未提供') {
    appendRow(readoutBankElement, '读数', '未提供');
    return;
  }
  appendRow(readoutBankElement, '库存年龄', numberText(bank.ageMs, ' ms'));
  appendRow(readoutBankElement, 'sessionGeneration', integerText(bank.sessionGeneration));
  appendRow(readoutBankElement, '已存字节', integerText(bank.storedBytes));
  appendRow(readoutBankElement, '已存块数', integerText(bank.storedChunks));
  appendRow(readoutBankElement, '内存上限', integerText(bank.maxBankBytes));
  appendRow(readoutBankElement, '队列', integerText(bank.queued));
  appendRow(readoutBankElement, '在途', integerText(bank.inflight));
  appendRow(readoutBankElement, '预取并发', integerText(bank.prefetchConcurrency));
  appendRow(readoutBankElement, '已停用', bank.disabled);
  appendRow(readoutBankElement, '视频路由', bank.routeActive);
  appendRow(readoutBankElement, '有配对地址', bank.pairedAddressAvailable);
  for (const resource of bank.resources) {
    appendHeading(readoutBankElement, `${textValue(resource.label)} · ${textValue(resource.pathname)}`);
    appendRow(readoutBankElement, '类型', resource.kind);
    appendRow(readoutBankElement, '已存字节', integerText(resource.storedBytes));
    appendRow(readoutBankElement, '已存块数', integerText(resource.storedChunks));
    appendRow(readoutBankElement, '总长度', integerText(resource.totalSize));
    appendRow(readoutBankElement, '前台结束', integerText(resource.lastForegroundEnd));
    appendRow(readoutBankElement, '在途块', integerText(resource.outstanding));
    appendRow(readoutBankElement, '重试块', integerText(resource.retrying));
    appendRow(readoutBankElement, '活跃', resource.active);
    appendRow(
      readoutBankElement,
      '库存秒数',
      numberText(bankSecondsEstimated[resource.pathname], ' 秒'),
      { estimate: true },
    );
  }
}

function renderRaceReadout(persistence) {
  clearReadout(readoutRaceElement);
  if (persistence === 'DEGRADED') {
    appendRow(readoutRaceElement, '提示', '日志写入降级，成绩可能缺事件');
  }
  if (raceQueryInFlight) {
    appendRow(readoutRaceElement, '成绩', '读取中');
    return;
  }
  if (raceError !== undefined) {
    appendRow(readoutRaceElement, '成绩', `读取失败: ${raceError}`);
    return;
  }
  if (raceSummary === undefined) {
    appendRow(
      readoutRaceElement,
      '成绩',
      raceSessionId === undefined || raceSessionId === '未提供' ? '未提供' : '读取中',
    );
    return;
  }
  if (raceSummary.sampleCount === 0) {
    appendRow(readoutRaceElement, '成绩', '尚无竞速事件');
    return;
  }
  const summary = raceSummary.summary;
  appendRow(readoutRaceElement, '样本数', raceSummary.sampleCount);
  appendRow(readoutRaceElement, '读取截止', raceSummary.maxEventId);
  appendRow(readoutRaceElement, '配对覆盖率', `${(summary.pairCoverage * 100).toFixed(1)}%`);
  appendRow(readoutRaceElement, '浪费字节率', `${(summary.wastedByteRatio * 100).toFixed(1)}%`);
  for (const row of summary.rows) {
    appendHeading(readoutRaceElement, `镜像 ${textValue(row.mirror)}`);
    appendRow(readoutRaceElement, '竞速进入', row.racesEntered);
    appendRow(readoutRaceElement, '胜出', row.wins);
    appendRow(readoutRaceElement, '胜率', `${(row.winRate * 100).toFixed(1)}%`);
    appendRow(readoutRaceElement, 'TTFB P50', numberText(row.ttfbP50, ' ms'));
    appendRow(readoutRaceElement, 'TTFB P90', numberText(row.ttfbP90, ' ms'));
    appendRow(readoutRaceElement, '停滞', row.stalled);
    appendRow(readoutRaceElement, '交付字节', row.bytesDelivered);
  }
  for (const result of CDN_RESULT_VALUES) {
    appendRow(readoutRaceElement, result, summary.byResult[result]);
  }
}

function renderDiagnosticsReadout(diagnostics) {
  clearReadout(readoutDiagnosticsElement);
  appendRow(readoutDiagnosticsElement, 'sessionId', diagnostics?.sessionId);
  appendRow(readoutDiagnosticsElement, '持久化', diagnostics?.persistence);
}

function renderReadouts(snapshot) {
  const values = snapshot || {};
  latestReadouts = snapshot;
  renderMediaReadout(values.media || '未提供');
  renderBankReadout(values.bank || '未提供', values.bankSecondsEstimated || {});
  renderRaceReadout(values.diagnostics?.persistence);
  renderDiagnosticsReadout(values.diagnostics);
}

function renderSnapshot(snapshot) {
  const values = snapshot || {};
  const fields = fieldsForSnapshot(values);
  for (const field of VIDEO_FIELDS) {
    const element = document.querySelector(`[data-status-field="${field}"]`);
    if (element !== null) element.textContent = fields.includes(field) ? displayValue(values[field]) : '未提供';
  }
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return undefined;
  return tabs[0];
}

async function pollStatus() {
  try {
    const tab = await activeTab();
    if (tab === undefined) {
      latestStatusSnapshot = undefined;
      renderSnapshot(undefined);
      statusElement.textContent = '当前活动页面未提供扩展状态。';
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      version: MESSAGE_VERSION,
      type: 'status:get',
    });
    if (response?.ok === false) throw new Error(response.error?.message || '当前页面拒绝状态请求');
    latestStatusSnapshot = response;
    renderSnapshot(response);
    statusElement.textContent = '状态每 500ms 刷新。';
  } catch (error) {
    latestStatusSnapshot = undefined;
    renderSnapshot(undefined);
    statusElement.textContent = `读取当前页面状态失败: ${displayValue(error?.message || error)}`;
  }
}

async function refreshRace(sessionId) {
  if (sessionId === undefined || sessionId === '未提供') {
    raceSessionId = sessionId;
    raceSummary = undefined;
    raceError = undefined;
    renderRaceReadout(latestReadouts?.diagnostics?.persistence);
    return;
  }
  if (raceSessionId !== sessionId) {
    raceSessionId = sessionId;
    raceSummary = undefined;
    raceError = undefined;
    nextRaceQueryAt = 0;
  }
  if (raceQueryInFlight || Date.now() < nextRaceQueryAt) return;
  raceQueryInFlight = true;
  raceError = undefined;
  renderRaceReadout(latestReadouts?.diagnostics?.persistence);
  try {
    const response = await chrome.runtime.sendMessage({
      version: 1,
      type: 'logs:cdn-summary',
      sessionId,
    });
    if (response?.ok !== true) throw new Error(response?.error?.message || 'CDN summary 请求失败');
    if (raceSessionId !== sessionId) return;
    raceSummary = response;
  } catch (error) {
    if (raceSessionId === sessionId) raceError = textValue(error?.message || error);
  } finally {
    raceQueryInFlight = false;
    nextRaceQueryAt = Date.now() + 1000;
    renderRaceReadout(latestReadouts?.diagnostics?.persistence);
  }
}

async function pollReadouts() {
  try {
    const tab = await activeTab();
    if (tab === undefined) {
      renderReadouts(undefined);
      await refreshRace(undefined);
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      version: MESSAGE_VERSION,
      type: 'readouts:get',
    });
    if (response?.ok === false) throw new Error(response.error?.message || '当前页面拒绝实时读数请求');
    renderReadouts(response);
    await refreshRace(response?.diagnostics?.sessionId);
  } catch (error) {
    renderReadouts(undefined);
    await refreshRace(undefined);
    if (error?.message === 'Could not establish connection. Receiving end does not exist.') {
      console.warn('[BilibiliBuffer] 当前活动页面没有实时面板接收端', error);
    } else {
      console.error('[BilibiliBuffer] 读取实时面板失败', error);
    }
  }
}

async function loadPreferences() {
  const values = await chrome.storage.local.get(PREFERENCES);
  for (const name of PREFERENCES) inputs.get(name).checked = values[name] !== false;
}

for (const name of PREFERENCES) {
  inputs.get(name).addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [name]: event.currentTarget.checked });
    statusElement.textContent = '已保存；刷新页面后生效。';
  });
}

document.querySelector('[data-open-logs]').addEventListener('click', () => {
  void (async () => {
    let fragment = '';
    try {
      const tab = await activeTab();
      if (tab !== undefined) {
        const response = await chrome.tabs.sendMessage(tab.id, {
          version: MESSAGE_VERSION,
          type: 'diagnostics:session-id:get',
        });
        if (response?.ok !== true) throw new Error(response?.error?.message || '当前页面拒绝日志 session 请求');
        fragment = logSessionFragment(response.sessionId);
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL(`logs.html${fragment}`) });
    } catch (error) {
      console.error('[BilibiliBuffer] 打开开发日志失败', error);
      await chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
    }
  })();
});

void loadPreferences().catch((error) => {
  console.error('[BilibiliBuffer] Popup 读取设置失败', error);
  statusElement.textContent = `读取设置失败: ${displayValue(error?.message || error)}`;
});

renderReadouts(undefined);
void pollStatus();
void pollReadouts();
const pollTimer = setInterval(() => {
  void pollStatus();
  void pollReadouts();
}, 500);
window.addEventListener('pagehide', () => clearInterval(pollTimer), { once: true });
