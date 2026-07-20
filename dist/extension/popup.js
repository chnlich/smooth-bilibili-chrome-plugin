(() => {
  // src/constants.js
  var EXTENSION_MANIFEST = Object.freeze({
    manifestVersion: 3,
    minimumChromeVersion: "120",
    matches: Object.freeze([
      "https://live.bilibili.com/*",
      "https://www.bilibili.com/*"
    ]),
    hostPermissions: Object.freeze([])
  });
  var EXTENSION_PREFERENCES = Object.freeze({
    liveEnabled: "liveEnabled",
    vodEnabled: "vodEnabled"
  });
  var VOD_CONFIG = Object.freeze({
    stableBufferSeconds: 120
  });
  var LIVE_CONFIG = Object.freeze({
    noDecodedFrameStallMilliseconds: 2e3,
    userSeekAuthorizationMilliseconds: 1e3,
    correctionToleranceSeconds: 2.5,
    statusRefreshMilliseconds: 500
  });

  // src/diagnostics/log-session.js
  var UNKNOWN_SESSION_ID = "未提供";
  function logSessionFragment(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId === UNKNOWN_SESSION_ID) return "";
    return `#sessionId=${encodeURIComponent(sessionId)}`;
  }

  // src/extension/popup.js
  var MESSAGE_VERSION = 2;
  var PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
  var VIDEO_FIELDS = Object.freeze(["mode", "state", "buffered", "target", "error", "sessionId", "persistence"]);
  var LIVE_FIELDS = Object.freeze([
    "mode",
    "paused",
    "recentFrame",
    "buffered",
    "delay",
    "resolution",
    "quality",
    "speed",
    "videoReplacements",
    "sourceReplacements",
    "recentEvent",
    "error",
    "sessionId",
    "persistence"
  ]);
  var statusElement = document.querySelector("[data-status]");
  var inputs = new Map(
    PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)])
  );
  var latestStatusSnapshot;
  function displayValue(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  function fieldsForSnapshot(snapshot) {
    return snapshot?.mode === "直播" ? LIVE_FIELDS : VIDEO_FIELDS;
  }
  function renderSnapshot(snapshot) {
    const values = snapshot || {};
    const fields = fieldsForSnapshot(values);
    const live = values.mode === "直播";
    for (const row of document.querySelectorAll('[data-live-only="true"]')) row.hidden = !live;
    for (const row of document.querySelectorAll('[data-video-only="true"]')) row.hidden = live;
    for (const field of /* @__PURE__ */ new Set([...VIDEO_FIELDS, ...LIVE_FIELDS])) {
      const element = document.querySelector(`[data-status-field="${field}"]`);
      if (element !== null) element.textContent = fields.includes(field) ? displayValue(values[field]) : "未提供";
    }
  }
  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return void 0;
    return tabs[0];
  }
  async function pollStatus() {
    try {
      const tab = await activeTab();
      if (tab === void 0) {
        latestStatusSnapshot = void 0;
        renderSnapshot(void 0);
        statusElement.textContent = "当前活动页面未提供扩展状态。";
        return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        version: MESSAGE_VERSION,
        type: "status:get"
      });
      if (response?.ok === false) throw new Error(response.error?.message || "当前页面拒绝状态请求");
      latestStatusSnapshot = response;
      renderSnapshot(response);
      statusElement.textContent = "状态每 500ms 刷新。";
    } catch (error) {
      latestStatusSnapshot = void 0;
      renderSnapshot(void 0);
      statusElement.textContent = `读取当前页面状态失败: ${displayValue(error?.message || error)}`;
    }
  }
  async function loadPreferences() {
    const values = await chrome.storage.local.get(PREFERENCES);
    for (const name of PREFERENCES) inputs.get(name).checked = values[name] !== false;
  }
  for (const name of PREFERENCES) {
    inputs.get(name).addEventListener("change", async (event) => {
      await chrome.storage.local.set({ [name]: event.currentTarget.checked });
      statusElement.textContent = "已保存；刷新页面后生效。";
    });
  }
  document.querySelector("[data-open-logs]").addEventListener("click", () => {
    const fragment = logSessionFragment(latestStatusSnapshot?.sessionId);
    void chrome.tabs.create({ url: chrome.runtime.getURL(`logs.html${fragment}`) }).catch((error) => {
      console.error("[BilibiliBuffer] 打开开发日志失败", error);
    });
  });
  void loadPreferences().catch((error) => {
    console.error("[BilibiliBuffer] Popup 读取设置失败", error);
    statusElement.textContent = `读取设置失败: ${displayValue(error?.message || error)}`;
  });
  void pollStatus();
  var pollTimer = setInterval(() => void pollStatus(), 500);
  window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
})();
//# sourceMappingURL=popup.js.map
