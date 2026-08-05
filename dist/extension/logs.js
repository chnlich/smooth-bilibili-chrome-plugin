(() => {
  // src/diagnostics/log-session.js
  var UNKNOWN_SESSION_ID = "未提供";
  function sessionIdFromHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith("#")) return void 0;
    const sessionId = new URLSearchParams(hash.slice(1)).get("sessionId");
    return typeof sessionId === "string" && sessionId.length > 0 && sessionId !== UNKNOWN_SESSION_ID ? sessionId : void 0;
  }

  // src/diagnostics/cdn.js
  var CDN_RESULT_VALUES = Object.freeze([
    "fetched",
    "lost_race",
    "stalled",
    "aborted",
    "superseded",
    "network_error",
    "http_error",
    "invalid_response",
    "gave_up"
  ]);
  function chunkGroupKey(data) {
    return JSON.stringify([new URL(data.source).pathname, data.chunkIndex, data.start]);
  }
  function finiteValue(value) {
    if (!Number.isFinite(value)) throw new Error(`CDN 事件 bytes 无效: ${value}`);
    return value;
  }
  function percentile(values, probability) {
    if (values.length === 0) return void 0;
    const ordered = [...values].sort((left, right) => left - right);
    const index = (ordered.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return ordered[lower];
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
  }
  function mirrorStatsFor(mirrors, mirror) {
    let stats = mirrors.get(mirror);
    if (stats === void 0) {
      stats = {
        mirror,
        racesEntered: 0,
        wins: 0,
        ttfbValues: [],
        stalled: 0,
        bytesDelivered: 0
      };
      mirrors.set(mirror, stats);
    }
    return stats;
  }
  function isPairedRace(legs) {
    return new Set(legs.map((leg) => leg.slot)).size >= 2;
  }
  function aggregateCdnEvents(events) {
    const chunks = /* @__PURE__ */ new Map();
    const mirrors = /* @__PURE__ */ new Map();
    const byResult = Object.fromEntries(CDN_RESULT_VALUES.map((result) => [result, 0]));
    let fetchedBytes = 0;
    let wastedBytes = 0;
    for (const event of events) {
      if (event.code !== "bank.fetch.chunk") continue;
      const data = event.data;
      const stats = mirrorStatsFor(mirrors, data.mirror);
      const bytes = finiteValue(data.bytes);
      if (Object.hasOwn(byResult, data.result)) byResult[data.result] += 1;
      if (data.result === "fetched") {
        stats.bytesDelivered += bytes;
        fetchedBytes += bytes;
      }
      if (data.result === "lost_race") wastedBytes += bytes;
      if (data.result === "stalled") stats.stalled += 1;
      if (Number.isFinite(data.ttfbMs)) stats.ttfbValues.push(data.ttfbMs);
      const key = chunkGroupKey(data);
      const legs = chunks.get(key) || [];
      legs.push(data);
      chunks.set(key, legs);
    }
    let pairedChunks = 0;
    for (const legs of chunks.values()) {
      if (!isPairedRace(legs)) continue;
      pairedChunks += 1;
      for (const leg of legs) {
        const stats = mirrorStatsFor(mirrors, leg.mirror);
        stats.racesEntered += 1;
        if (leg.result === "fetched") stats.wins += 1;
      }
    }
    const rows = [...mirrors.values()].sort((left, right) => String(left.mirror).localeCompare(String(right.mirror))).map((stats) => ({
      mirror: stats.mirror,
      racesEntered: stats.racesEntered,
      wins: stats.wins,
      winRate: stats.racesEntered === 0 ? 0 : stats.wins / stats.racesEntered,
      ttfbP50: percentile(stats.ttfbValues, 0.5),
      ttfbP90: percentile(stats.ttfbValues, 0.9),
      stalled: stats.stalled,
      bytesDelivered: stats.bytesDelivered
    }));
    const totalChunks = chunks.size;
    return {
      totalChunks,
      pairedChunks,
      pairCoverage: totalChunks === 0 ? 0 : pairedChunks / totalChunks,
      fetchedBytes,
      wastedBytes,
      wastedByteRatio: fetchedBytes === 0 ? 0 : wastedBytes / fetchedBytes,
      byResult,
      rows
    };
  }

  // src/diagnostics/logs.js
  var MESSAGE_VERSION = 1;
  var PAGE_SIZE = 250;
  var sessionSelect = document.querySelector("[data-session-filter]");
  var exportButton = document.querySelector("[data-export]");
  var statusElement = document.querySelector("[data-status]");
  var sessionDetails = document.querySelector("[data-session-details]");
  var cdnButton = document.querySelector("[data-cdn-refresh]");
  var cdnStatusElement = document.querySelector("[data-cdn-status]");
  var cdnSummaryElement = document.querySelector("[data-cdn-summary]");
  var cdnRowsElement = document.querySelector("[data-cdn-rows]");
  var currentSessionId = sessionIdFromHash(window.location.hash);
  function display(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  async function send(message) {
    const response = await chrome.runtime.sendMessage({ version: MESSAGE_VERSION, ...message });
    if (response?.ok !== true) {
      throw Object.assign(new Error(response?.error?.message || "日志服务拒绝请求"), {
        code: response?.error?.code || "LOG_MESSAGE_FAILED"
      });
    }
    return response;
  }
  function selectedSessionId() {
    if (sessionSelect.value === "current") {
      if (currentSessionId === void 0) throw new Error("当前活动页面没有可用日志 session");
      return currentSessionId;
    }
    return sessionSelect.value || void 0;
  }
  function renderDetails() {
    const value = sessionSelect.value === "current" ? currentSessionId : sessionSelect.value;
    sessionDetails.textContent = value === void 0 || value === "" ? "导出全部 session" : `筛选 session: ${value}`;
  }
  async function writeLine(writer, value) {
    await writer.write(`${JSON.stringify(value)}
`);
  }
  async function writeSessions(writer, sessionId, maxEventId) {
    let afterSessionId;
    for (; ; ) {
      const response = await send({
        type: "logs:sessions-page",
        limit: PAGE_SIZE,
        ...afterSessionId === void 0 ? {} : { afterSessionId },
        maxEventId,
        ...sessionId === void 0 ? {} : { sessionId }
      });
      for (const session of response.sessions) await writeLine(writer, { recordType: "session", ...session });
      if (sessionId !== void 0 || !response.hasMore) break;
      const nextAfterSessionId = response.nextAfterSessionId;
      if (typeof nextAfterSessionId !== "string" || nextAfterSessionId.length === 0 || nextAfterSessionId === afterSessionId) {
        throw new Error("日志 session 分页没有向前推进");
      }
      afterSessionId = nextAfterSessionId;
    }
  }
  async function forEachEventPage(sessionId, maxEventId, callback) {
    let afterEventId = 0;
    for (; ; ) {
      const response = await send({
        type: "logs:events-page",
        limit: PAGE_SIZE,
        afterEventId,
        maxEventId,
        ...sessionId === void 0 ? {} : { sessionId }
      });
      await callback(response.events);
      if (!response.hasMore) break;
      const nextAfterEventId = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
      if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
        throw new Error("日志分页没有向前推进");
      }
      afterEventId = nextAfterEventId;
    }
  }
  async function writeEvents(writer, sessionId, maxEventId) {
    await forEachEventPage(sessionId, maxEventId, async (events) => {
      for (const event of events) await writeLine(writer, { recordType: "event", ...event });
    });
  }
  function ratioText(value) {
    return `${(value * 100).toFixed(1)}%`;
  }
  function metricText(value, suffix = "") {
    return value === void 0 ? "未提供" : `${value.toFixed(1)}${suffix}`;
  }
  function integerText(value) {
    return String(value);
  }
  function renderCdnPanel(summary, summaryElement = cdnSummaryElement, rowsElement = cdnRowsElement) {
    summaryElement.textContent = [
      `配对覆盖率 ${summary.pairedChunks}/${summary.totalChunks} (${ratioText(summary.pairCoverage)})`,
      `浪费字节率 ${ratioText(summary.wastedByteRatio)}`
    ].join("；");
    rowsElement.replaceChildren();
    for (const row of summary.rows) {
      const cells = [
        row.mirror,
        integerText(row.racesEntered),
        integerText(row.wins),
        ratioText(row.winRate),
        metricText(row.ttfbP50, " ms"),
        metricText(row.ttfbP90, " ms"),
        integerText(row.stalled),
        integerText(row.bytesDelivered)
      ];
      const tableRow = rowsElement.ownerDocument.createElement("tr");
      for (const value of cells) {
        const cell = rowsElement.ownerDocument.createElement("td");
        cell.textContent = String(value);
        tableRow.append(cell);
      }
      rowsElement.append(tableRow);
    }
  }
  async function exportLogs() {
    if (typeof window.showSaveFilePicker !== "function") {
      throw new Error("当前 Chrome 不支持 File System Access，无法安全导出日志");
    }
    const sessionId = selectedSessionId();
    const handle = await window.showSaveFilePicker({
      suggestedName: `bilibili-development-logs-${Date.now()}.jsonl`,
      types: [{ description: "JSON Lines", accept: { "application/jsonl": [".jsonl"] } }]
    });
    const writer = await handle.createWritable();
    try {
      const snapshot = await send({
        type: "logs:max-event-id",
        ...sessionId === void 0 ? {} : { sessionId }
      });
      await writeSessions(writer, sessionId, snapshot.maxEventId);
      await writeEvents(writer, sessionId, snapshot.maxEventId);
      await writer.close();
      statusElement.textContent = `导出完成，截止 eventId ${snapshot.maxEventId}。新事件仍继续保存。`;
    } catch (error) {
      try {
        await writer.abort();
      } catch (abortError) {
        console.error("[BilibiliBuffer] 日志导出 abort 失败", abortError);
      }
      throw error;
    }
  }
  sessionSelect.addEventListener("change", renderDetails);
  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    statusElement.textContent = "正在固定 eventId 并流式导出…";
    try {
      await exportLogs();
    } catch (error) {
      if (error?.name === "AbortError") {
        statusElement.textContent = "导出已取消，文件没有完成写入。";
      } else {
        statusElement.textContent = `导出失败: ${display(error?.message || error)}`;
      }
      console.error("[BilibiliBuffer] 日志导出失败", error);
    } finally {
      exportButton.disabled = false;
    }
  });
  cdnButton.addEventListener("click", async () => {
    cdnButton.disabled = true;
    cdnStatusElement.textContent = "正在读取 bank.fetch.chunk 事件…";
    try {
      const sessionId = selectedSessionId();
      if (sessionId === void 0) throw new Error("读取 CDN racing 前请先选择一个 session");
      const response = await send({ type: "logs:cdn-summary", sessionId });
      renderCdnPanel(response.summary);
      cdnStatusElement.textContent = `读取完成，覆盖 ${response.sampleCount} 条事件，截止 eventId ${response.maxEventId}。`;
    } catch (error) {
      cdnStatusElement.textContent = `读取失败: ${display(error?.message || error)}`;
      console.error("[BilibiliBuffer] CDN 面板读取失败", error);
    } finally {
      cdnButton.disabled = false;
    }
  });
  if (currentSessionId === void 0) {
    sessionSelect.querySelector('option[value="current"]').disabled = true;
  } else {
    sessionSelect.value = "current";
  }
  renderDetails();
})();
//# sourceMappingURL=logs.js.map
