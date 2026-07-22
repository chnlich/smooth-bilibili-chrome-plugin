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
    statusRefreshMilliseconds: 500,
    delayUnavailableCheckMilliseconds: 5e3,
    liveRetainSeconds: 30
  });

  // src/extension/bridge-contract.js
  var SHIM_OBSERVATION_EVENT = "bilibili-buffer:shim-observation-v1";
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callCoreSync",
    "getLiveCapabilitySnapshot",
    "disableLiveAutoCatchup"
  ]);
  var BRIDGE_LIVE_METHODS = Object.freeze([
    "setChasingFrameThreshold"
  ]);
  var BRIDGE_LIVE_DISABLE_ARGS = Object.freeze({
    setChasingFrameThreshold: 600
  });
  var BRIDGE_CORE_SYNC_METHODS = Object.freeze(["setStableBufferTime"]);

  // src/live/buffer-retention.js
  var RETAIN_PASS = null;
  function computeRetentionAction(currentTime, removeStart, removeEnd, retainSeconds) {
    if (!Number.isFinite(currentTime) || currentTime <= 0 || !Number.isFinite(removeStart) || !Number.isFinite(removeEnd) || removeEnd <= removeStart) {
      return RETAIN_PASS;
    }
    const floor = currentTime - retainSeconds;
    if (removeEnd <= floor) return RETAIN_PASS;
    if (removeStart >= floor) return { action: "skipped", adjustedEnd: void 0 };
    return { action: "truncated", adjustedEnd: floor };
  }

  // src/extension/source-buffer-shim.js
  var RETAIN_SECONDS = LIVE_CONFIG.liveRetainSeconds;
  var installed = false;
  var stats = {
    removeCalls: 0,
    intercepted: 0,
    lastReason: null,
    lastCurrentTime: null,
    lastRemoveStart: null,
    lastRemoveEnd: null,
    lastOriginalEnd: null
  };
  function findLiveVideoCurrentTime() {
    const videos = [...document.querySelectorAll("video")];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const iframeDocument = iframe.contentDocument;
        if (iframeDocument !== null) {
          videos.push(...iframeDocument.querySelectorAll("video"));
        }
      } catch {
      }
    }
    let latest = void 0;
    for (const video of videos) {
      if (video !== null && Number.isFinite(video.currentTime) && video.currentTime > 0) {
        if (latest === void 0 || video.currentTime > latest) latest = video.currentTime;
      }
    }
    return latest;
  }
  function dispatchObservation(detail) {
    try {
      document.dispatchEvent(new CustomEvent(SHIM_OBSERVATION_EVENT, { detail }));
    } catch {
    }
  }
  if (typeof SourceBuffer !== "undefined" && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === "function") {
    const originalRemove = SourceBuffer.prototype.remove;
    SourceBuffer.prototype.remove = function smoothRemove(start, end) {
      stats.removeCalls += 1;
      const currentTime = findLiveVideoCurrentTime();
      const action = computeRetentionAction(currentTime, start, end, RETAIN_SECONDS);
      if (action === null) {
        return originalRemove.call(this, start, end);
      }
      stats.intercepted += 1;
      stats.lastCurrentTime = currentTime;
      stats.lastRemoveStart = start;
      stats.lastOriginalEnd = end;
      if (action.action === "skipped") {
        stats.lastReason = "skipped";
        stats.lastRemoveEnd = end;
        dispatchObservation({ reason: "skipped", currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
        return;
      }
      stats.lastReason = "truncated";
      stats.lastRemoveEnd = action.adjustedEnd;
      dispatchObservation({ reason: "truncated", targetTime: action.adjustedEnd, currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
      return originalRemove.call(this, start, action.adjustedEnd);
    };
    installed = true;
  }
  window.__smoothBufferShim = { retainSeconds: RETAIN_SECONDS, installed, stats };
})();
//# sourceMappingURL=source-buffer-shim.js.map
