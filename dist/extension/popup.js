(() => {
  // src/constants.js
  var HLS_DEPENDENCY = Object.freeze({
    version: "1.5.17",
    integrity: "sha512-iFmKfXPRVIW5PBZ3gzXSLz/IYtC6BMsIqmY/K42iuykOoUZTChDwR6KYhPcwj5HuE4hNJhZxNPD+ZdHLJvRv8A=="
  });
  var EXTENSION_MANIFEST = Object.freeze({
    manifestVersion: 3,
    minimumChromeVersion: "120",
    matches: Object.freeze([
      "https://live.bilibili.com/*",
      "https://www.bilibili.com/video/*"
    ]),
    hostPermissions: Object.freeze([
      "https://api.live.bilibili.com/*",
      "https://*.bilivideo.com/*"
    ])
  });
  var EXTENSION_PREFERENCES = Object.freeze({
    liveEnabled: "liveEnabled",
    vodEnabled: "vodEnabled"
  });
  var LIVE_STATE = Object.freeze({
    LIVE: "LIVE",
    STALL: "STALL",
    RECOVERING: "RECOVERING",
    DELAYED: "DELAYED",
    USER_PAUSED: "USER_PAUSED",
    GAP_UNRECOVERABLE: "GAP_UNRECOVERABLE"
  });
  var LIVE_CONFIG = Object.freeze({
    recoveryWatermarkSeconds: 15,
    aggressiveBufferSeconds: 60,
    hideDanmakuAfterSeconds: 3,
    playbackRate: 1,
    segmentConcurrency: 3,
    requestTimeoutMilliseconds: 5e3,
    retryBackoffMilliseconds: Object.freeze([1e3, 2e3, 4e3, 8e3, 15e3, 3e4]),
    manifestRefreshMilliseconds: 1e3,
    statusRefreshMilliseconds: 500
  });
  var VOD_CONFIG = Object.freeze({
    qualityNumber: 64,
    playbackRate: 2,
    stableBufferSeconds: 180,
    startupBufferSeconds: 120,
    lowBufferSeconds: 30,
    quotaFallbackSeconds: Object.freeze([120, 90]),
    metricsWindowsSeconds: Object.freeze([30, 60]),
    qualityConfirmTimeoutMilliseconds: 5e3,
    qualityConfirmPollMilliseconds: 100
  });

  // src/extension/popup.js
  var PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
  var statusElement = document.querySelector("[data-status]");
  var inputs = new Map(
    PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)])
  );
  async function loadPreferences() {
    const values = await chrome.storage.local.get(PREFERENCES);
    for (const name of PREFERENCES) {
      inputs.get(name).checked = values[name] !== false;
    }
  }
  for (const name of PREFERENCES) {
    inputs.get(name).addEventListener("change", async (event) => {
      await chrome.storage.local.set({ [name]: event.currentTarget.checked });
      statusElement.textContent = "已保存，下次刷新页面后生效。";
    });
  }
  void loadPreferences().catch((error) => {
    console.error("[BilibiliBuffer] Popup 读取设置失败", error);
    statusElement.textContent = `读取设置失败: ${error.message || error}`;
  });
})();
