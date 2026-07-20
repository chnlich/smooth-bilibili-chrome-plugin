import { sessionIdFromHash } from './log-session.js';

const MESSAGE_VERSION = 1;
const PAGE_SIZE = 250;

const sessionSelect = document.querySelector('[data-session-filter]');
const exportButton = document.querySelector('[data-export]');
const statusElement = document.querySelector('[data-status]');
const sessionDetails = document.querySelector('[data-session-details]');

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

function appendSessionOption(session) {
  const option = document.createElement('option');
  option.value = session.sessionId;
  option.textContent = `${session.routeKind} · ${session.sessionId} · ${session.pathname}`;
  option.dataset.routeKind = session.routeKind;
  sessionSelect.append(option);
}

async function loadSessions() {
  let afterSessionId;
  for (;;) {
    const response = await send({
      type: 'logs:sessions-page',
      limit: PAGE_SIZE,
      ...(afterSessionId === undefined ? {} : { afterSessionId }),
    });
    for (const session of response.sessions) appendSessionOption(session);
    if (!response.hasMore) break;
    const nextAfterSessionId = response.nextAfterSessionId ?? response.sessions.at(-1)?.sessionId;
    if (
      typeof nextAfterSessionId !== 'string'
      || nextAfterSessionId.length === 0
      || nextAfterSessionId === afterSessionId
    ) {
      throw new Error('日志 session 分页没有向前推进');
    }
    afterSessionId = nextAfterSessionId;
  }
  if (currentSessionId !== undefined) {
    const option = [...sessionSelect.options].find((candidate) => candidate.value === currentSessionId);
    if (option !== undefined) option.textContent = `当前 · ${option.textContent}`;
  }
  renderDetails();
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

async function writeEvents(writer, sessionId, maxEventId) {
  let afterEventId = 0;
  for (;;) {
    const response = await send({
      type: 'logs:events-page',
      limit: PAGE_SIZE,
      afterEventId,
      maxEventId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    for (const event of response.events) await writeLine(writer, { recordType: 'event', ...event });
    if (!response.hasMore) break;
    const nextAfterEventId = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
    if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
      throw new Error('日志分页没有向前推进');
    }
    afterEventId = nextAfterEventId;
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

void loadSessions().catch((error) => {
  statusElement.textContent = `读取日志 session 失败: ${display(error?.message || error)}`;
  console.error('[BilibiliBuffer] 日志页启动失败', error);
});
