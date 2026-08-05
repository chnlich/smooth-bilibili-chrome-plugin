import { sessionIdFromHash } from './log-session.js';
import { aggregateCdnEvents } from './cdn.js';

export { aggregateCdnEvents };

const MESSAGE_VERSION = 1;
const PAGE_SIZE = 250;

const sessionSelect = document.querySelector('[data-session-filter]');
const exportButton = document.querySelector('[data-export]');
const statusElement = document.querySelector('[data-status]');
const sessionDetails = document.querySelector('[data-session-details]');
const cdnButton = document.querySelector('[data-cdn-refresh]');
const cdnStatusElement = document.querySelector('[data-cdn-status]');
const cdnSummaryElement = document.querySelector('[data-cdn-summary]');
const cdnRowsElement = document.querySelector('[data-cdn-rows]');

const currentSessionId = sessionIdFromHash(window.location.hash);

function display(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage({ version: MESSAGE_VERSION, ...message });
  if (response?.ok !== true) {
    throw Object.assign(new Error(response?.error?.message || '日志服务拒绝请求'), {
      code: response?.error?.code || 'LOG_MESSAGE_FAILED',
    });
  }
  return response;
}

function selectedSessionId() {
  if (sessionSelect.value === 'current') {
    if (currentSessionId === undefined) throw new Error('当前活动页面没有可用日志 session');
    return currentSessionId;
  }
  return sessionSelect.value || undefined;
}

function renderDetails() {
  const value = sessionSelect.value === 'current' ? currentSessionId : sessionSelect.value;
  sessionDetails.textContent = value === undefined || value === '' ? '导出全部 session' : `筛选 session: ${value}`;
}

async function writeLine(writer, value) {
  await writer.write(`${JSON.stringify(value)}\n`);
}

async function writeSessions(writer, sessionId, maxEventId) {
  let afterSessionId;
  for (;;) {
    const response = await send({
      type: 'logs:sessions-page',
      limit: PAGE_SIZE,
      ...(afterSessionId === undefined ? {} : { afterSessionId }),
      maxEventId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    for (const session of response.sessions) await writeLine(writer, { recordType: 'session', ...session });
    if (sessionId !== undefined || !response.hasMore) break;
    const nextAfterSessionId = response.nextAfterSessionId;
    if (
      typeof nextAfterSessionId !== 'string'
      || nextAfterSessionId.length === 0
      || nextAfterSessionId === afterSessionId
    ) {
      throw new Error('日志 session 分页没有向前推进');
    }
    afterSessionId = nextAfterSessionId;
  }
}

async function forEachEventPage(sessionId, maxEventId, callback) {
  let afterEventId = 0;
  for (;;) {
    const response = await send({
      type: 'logs:events-page',
      limit: PAGE_SIZE,
      afterEventId,
      maxEventId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    await callback(response.events);
    if (!response.hasMore) break;
    const nextAfterEventId = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
    if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
      throw new Error('日志分页没有向前推进');
    }
    afterEventId = nextAfterEventId;
  }
}

async function writeEvents(writer, sessionId, maxEventId) {
  await forEachEventPage(sessionId, maxEventId, async (events) => {
    for (const event of events) await writeLine(writer, { recordType: 'event', ...event });
  });
}

function ratioText(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricText(value, suffix = '') {
  return value === undefined ? '未提供' : `${value.toFixed(1)}${suffix}`;
}

function integerText(value) {
  return String(value);
}

export function renderCdnPanel(summary, summaryElement = cdnSummaryElement, rowsElement = cdnRowsElement) {
  summaryElement.textContent = [
    `配对覆盖率 ${summary.pairedChunks}/${summary.totalChunks} (${ratioText(summary.pairCoverage)})`,
    `浪费字节率 ${ratioText(summary.wastedByteRatio)}`,
  ].join('；');
  rowsElement.replaceChildren();
  for (const row of summary.rows) {
    const cells = [
      row.mirror,
      integerText(row.racesEntered),
      integerText(row.wins),
      ratioText(row.winRate),
      metricText(row.ttfbP50, ' ms'),
      metricText(row.ttfbP90, ' ms'),
      integerText(row.stalled),
      integerText(row.bytesDelivered),
    ];
    const tableRow = rowsElement.ownerDocument.createElement('tr');
    for (const value of cells) {
      const cell = rowsElement.ownerDocument.createElement('td');
      cell.textContent = String(value);
      tableRow.append(cell);
    }
    rowsElement.append(tableRow);
  }
}

async function exportLogs() {
  if (typeof window.showSaveFilePicker !== 'function') {
    throw new Error('当前 Chrome 不支持 File System Access，无法安全导出日志');
  }
  const sessionId = selectedSessionId();
  const handle = await window.showSaveFilePicker({
    suggestedName: `bilibili-development-logs-${Date.now()}.jsonl`,
    types: [{ description: 'JSON Lines', accept: { 'application/jsonl': ['.jsonl'] } }],
  });
  const writer = await handle.createWritable();
  try {
    const snapshot = await send({
      type: 'logs:max-event-id',
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    await writeSessions(writer, sessionId, snapshot.maxEventId);
    await writeEvents(writer, sessionId, snapshot.maxEventId);
    await writer.close();
    statusElement.textContent = `导出完成，截止 eventId ${snapshot.maxEventId}。新事件仍继续保存。`;
  } catch (error) {
    try {
      await writer.abort();
    } catch (abortError) {
      console.error('[BilibiliBuffer] 日志导出 abort 失败', abortError);
    }
    throw error;
  }
}

sessionSelect.addEventListener('change', renderDetails);
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  statusElement.textContent = '正在固定 eventId 并流式导出…';
  try {
    await exportLogs();
  } catch (error) {
    if (error?.name === 'AbortError') {
      statusElement.textContent = '导出已取消，文件没有完成写入。';
    } else {
      statusElement.textContent = `导出失败: ${display(error?.message || error)}`;
    }
    console.error('[BilibiliBuffer] 日志导出失败', error);
  } finally {
    exportButton.disabled = false;
  }
});

cdnButton.addEventListener('click', async () => {
  cdnButton.disabled = true;
  cdnStatusElement.textContent = '正在读取 bank.fetch.chunk 事件…';
  try {
    const sessionId = selectedSessionId();
    if (sessionId === undefined) throw new Error('读取 CDN racing 前请先选择一个 session');
    const response = await send({ type: 'logs:cdn-summary', sessionId });
    renderCdnPanel(response.summary);
    cdnStatusElement.textContent = `读取完成，覆盖 ${response.sampleCount} 条事件，截止 eventId ${response.maxEventId}。`;
  } catch (error) {
    cdnStatusElement.textContent = `读取失败: ${display(error?.message || error)}`;
    console.error('[BilibiliBuffer] CDN 面板读取失败', error);
  } finally {
    cdnButton.disabled = false;
  }
});

if (currentSessionId === undefined) {
  sessionSelect.querySelector('option[value="current"]').disabled = true;
} else {
  sessionSelect.value = 'current';
}
renderDetails();
