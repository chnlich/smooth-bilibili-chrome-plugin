(() => {
  // src/extension/bridge-contract.js
  var SHIM_DIAGNOSTIC_ATTRIBUTE = "data-bilibili-buffer-shim-diagnostics";
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callCoreSync"
  ]);
  var BRIDGE_CORE_SYNC_METHODS = Object.freeze(["setStableBufferTime"]);

  // src/extension/source-buffer-shim.js
  var installed = false;
  var stats = {
    removeCalls: 0
  };
  var sourceBufferTracks = /* @__PURE__ */ new WeakMap();
  var appendErrors = /* @__PURE__ */ Object.create(null);
  var activeSource;
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
  function publishDiagnostics() {
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
          removeCalls: stats.removeCalls
        }
      }));
    } catch (error) {
      console.error("[BilibiliBuffer] source buffer diagnostic dispatch failed", error);
    }
  }
  var DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS = 1e3;
  var lastDiagnosticDispatchAt = Number.NEGATIVE_INFINITY;
  var diagnosticTimer;
  function dispatchDiagnostics() {
    if (diagnosticTimer !== void 0) {
      window.clearTimeout(diagnosticTimer);
      diagnosticTimer = void 0;
    }
    lastDiagnosticDispatchAt = window.performance.now();
    publishDiagnostics();
  }
  function dispatchUpdateEndDiagnostics() {
    const now = window.performance.now();
    const elapsed = now - lastDiagnosticDispatchAt;
    if (elapsed >= DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS) {
      dispatchDiagnostics();
      return;
    }
    if (diagnosticTimer === void 0) {
      diagnosticTimer = window.setTimeout(() => {
        diagnosticTimer = void 0;
        lastDiagnosticDispatchAt = window.performance.now();
        publishDiagnostics();
      }, DIAGNOSTIC_SAMPLE_INTERVAL_MILLISECONDS - elapsed);
    }
  }
  if (typeof MediaSource !== "undefined" && typeof MediaSource.prototype?.addSourceBuffer === "function") {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function smoothAddSourceBuffer(mimeType) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      activeSource = this;
      sourceBufferTracks.set(sourceBuffer, String(mimeType).split(";", 1)[0]);
      sourceBuffer.addEventListener("updateend", dispatchUpdateEndDiagnostics);
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
      return originalRemove.call(this, start, end);
    };
    installed = true;
  }
  window.__smoothBufferShim = { installed, stats };
  dispatchDiagnostics();
})();
//# sourceMappingURL=source-buffer-shim.js.map
