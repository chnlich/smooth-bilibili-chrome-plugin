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
  var SHIM_OBSERVATION_ATTRIBUTE = "data-bilibili-buffer-shim-observation";
  var SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE = "data-bilibili-buffer-shim-seq";
  var SHIM_DIAGNOSTIC_ATTRIBUTE = "data-bilibili-buffer-shim-diagnostics";
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
  var observationSequence = 0;
  var stats = {
    removeCalls: 0,
    intercepted: 0,
    lastReason: null,
    lastCurrentTime: null,
    lastRemoveStart: null,
    lastRemoveEnd: null,
    lastOriginalEnd: null
  };
  var sourceBufferTracks = /* @__PURE__ */ new WeakMap();
  var appendErrors = /* @__PURE__ */ Object.create(null);
  var activeSource;
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
      observationSequence += 1;
      const seq = String(observationSequence);
      const payload = JSON.stringify(detail);
      const target = window !== window.top && window.parent !== window ? window.parent?.document?.documentElement ?? document.documentElement : document.documentElement;
      if (target !== null) {
        target.setAttribute(SHIM_OBSERVATION_SEQUENCE_ATTRIBUTE, seq);
        target.setAttribute(SHIM_OBSERVATION_ATTRIBUTE, payload);
      }
    } catch {
    }
  }
  function readSourceBufferRanges(sourceBuffer) {
    const ranges = [];
    try {
      for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
        ranges.push({ start: sourceBuffer.buffered.start(index), end: sourceBuffer.buffered.end(index) });
      }
    } catch (error) {
      console.error("[BilibiliBuffer] source buffer diagnostic read failed", error);
    }
    return ranges;
  }
  function dispatchDiagnostics() {
    try {
      const sourceBufferRanges = [];
      if (activeSource !== void 0) {
        for (let index = 0; index < activeSource.sourceBuffers.length; index += 1) {
          const sourceBuffer = activeSource.sourceBuffers[index];
          sourceBufferRanges.push({
            track: sourceBufferTracks.get(sourceBuffer) || "unknown",
            ranges: readSourceBufferRanges(sourceBuffer)
          });
        }
      }
      document.documentElement.setAttribute(SHIM_DIAGNOSTIC_ATTRIBUTE, JSON.stringify({
        sourceBufferRanges,
        mediaSourceState: activeSource?.readyState || null,
        appendErrors: { ...appendErrors },
        removeStats: {
          removeCalls: stats.removeCalls,
          intercepted: stats.intercepted
        }
      }));
    } catch (error) {
      console.error("[BilibiliBuffer] source buffer diagnostic dispatch failed", error);
    }
  }
  var mediaSourceConstructor = globalThis["MediaSource"];
  if (mediaSourceConstructor !== void 0 && typeof mediaSourceConstructor.prototype?.addSourceBuffer === "function") {
    const originalAddSourceBuffer = mediaSourceConstructor.prototype.addSourceBuffer;
    mediaSourceConstructor.prototype.addSourceBuffer = function smoothAddSourceBuffer(mimeType) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      activeSource = this;
      sourceBufferTracks.set(sourceBuffer, String(mimeType).split(";", 1)[0]);
      sourceBuffer.addEventListener("updateend", dispatchDiagnostics);
      for (const eventName of ["sourceopen", "sourceended", "sourceclose"]) {
        this.addEventListener(eventName, dispatchDiagnostics);
      }
      dispatchDiagnostics();
      return sourceBuffer;
    };
  }
  if (typeof SourceBuffer !== "undefined" && typeof SourceBuffer.prototype?.appendBuffer === "function") {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function smoothAppendBuffer(...args) {
      try {
        return originalAppendBuffer.call(this, ...args);
      } catch (error) {
        const name = typeof error?.name === "string" && error.name.length > 0 ? error.name : "UnknownError";
        appendErrors[name] = (appendErrors[name] || 0) + 1;
        dispatchDiagnostics();
        throw error;
      }
    };
  }
  if (typeof SourceBuffer !== "undefined" && SourceBuffer.prototype && typeof SourceBuffer.prototype.remove === "function") {
    const originalRemove = SourceBuffer.prototype.remove;
    SourceBuffer.prototype.remove = function smoothRemove(start, end) {
      stats.removeCalls += 1;
      dispatchDiagnostics();
      const currentTime = findLiveVideoCurrentTime();
      const action = computeRetentionAction(currentTime, start, end, RETAIN_SECONDS);
      if (action === null) {
        return originalRemove.call(this, start, end);
      }
      stats.intercepted += 1;
      stats.lastCurrentTime = currentTime;
      stats.lastRemoveStart = start;
      stats.lastOriginalEnd = end;
      dispatchDiagnostics();
      if (action.action === "skipped") {
        stats.lastReason = "skipped";
        stats.lastRemoveEnd = end;
        dispatchObservation({ reason: "skipped", currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
        const buffer = this;
        setTimeout(() => {
          try {
            buffer.dispatchEvent(new Event("updateend"));
          } catch {
          }
        }, 0);
        return;
      }
      stats.lastReason = "truncated";
      stats.lastRemoveEnd = action.adjustedEnd;
      dispatchDiagnostics();
      dispatchObservation({ reason: "truncated", targetTime: action.adjustedEnd, currentTime, retainSeconds: RETAIN_SECONDS, originalEnd: end });
      return originalRemove.call(this, start, action.adjustedEnd);
    };
    installed = true;
  }
  window.__smoothBufferShim = { retainSeconds: RETAIN_SECONDS, installed, stats };
  dispatchDiagnostics();
})();
//# sourceMappingURL=source-buffer-shim.js.map
