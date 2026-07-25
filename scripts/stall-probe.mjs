export const stallProbeInit = () => {
  const probeEventTypes = new Set([
    'playing',
    'waiting',
    'stalled',
    'ratechange',
    'seeked',
    'error',
    'timeupdate',
    'progress',
  ]);
  if (window.__stallProbe !== undefined) return;

  const records = [];
  const listeners = [];
  let selectedVideo;
  let mutationObserver;
  let sampleTimer;
  let stopped = false;
  let lastTimeupdateElapsed = -Infinity;
  let lastProgressElapsed = -Infinity;

  const reportReadFailure = (operation, error) => {
    console.error(`[stall-probe] ${operation} failed`, error);
  };

  const findVideo = () => [...document.querySelectorAll('video')]
    .sort((left, right) =>
      (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];

  const readRanges = (timeRanges) => {
    const ranges = [];
    try {
      for (let index = 0; index < timeRanges.length; index += 1) {
        const start = timeRanges.start(index);
        const end = timeRanges.end(index);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          throw new Error(`invalid buffered range ${index}`);
        }
        ranges.push({ start, end });
      }
    } catch (error) {
      reportReadFailure('buffered ranges', error);
    }
    return ranges;
  };

  const readVideoQuality = (video) => {
    if (typeof video.getVideoPlaybackQuality !== 'function') return null;
    try {
      const quality = video.getVideoPlaybackQuality();
      const values = {
        total: quality.totalVideoFrames,
        dropped: quality.droppedVideoFrames,
        corrupted: quality.corruptedVideoFrames,
      };
      if (!Object.values(values).every((value) => Number.isFinite(value))) {
        throw new Error('video playback quality contains a non-finite value');
      }
      return values;
    } catch (error) {
      reportReadFailure('video playback quality', error);
      return null;
    }
  };

  const record = (type, video, timestamp = performance.now()) => {
    if (stopped || !probeEventTypes.has(type)) return;
    if (video === undefined || video.isConnected === false) return;
    const currentTime = video.currentTime;
    const readyState = video.readyState;
    const paused = video.paused;
    const playbackRate = video.playbackRate;
    if (!Number.isFinite(currentTime) || !Number.isInteger(readyState)
      || typeof paused !== 'boolean' || !Number.isFinite(playbackRate)) {
      reportReadFailure('media snapshot', new Error('media snapshot violates the probe contract'));
      return;
    }
    records.push({
      type,
      elapsedMs: Math.round(timestamp),
      currentTime,
      readyState,
      paused,
      playbackRate,
      bufferedRanges: readRanges(video.buffered),
      videoQuality: readVideoQuality(video),
    });
  };

  const detachVideo = () => {
    for (const [type, listener] of listeners.splice(0)) selectedVideo.removeEventListener(type, listener);
  };

  const bindVideo = (video) => {
    if (video === selectedVideo) return;
    if (selectedVideo !== undefined) detachVideo();
    selectedVideo = video;
    if (selectedVideo === undefined) return;
    for (const type of probeEventTypes) {
      const listener = () => {
        if (type === 'timeupdate') {
          const elapsed = performance.now();
          if (elapsed - lastTimeupdateElapsed < 1000) return;
          lastTimeupdateElapsed = elapsed;
          record(type, selectedVideo, elapsed);
          return;
        }
        if (type === 'progress') {
          const elapsed = performance.now();
          if (elapsed - lastProgressElapsed < 1000) return;
          lastProgressElapsed = elapsed;
          record(type, selectedVideo, elapsed);
          return;
        }
        record(type, selectedVideo);
      };
      selectedVideo.addEventListener(type, listener);
      listeners.push([type, listener]);
    }
    record('timeupdate', selectedVideo);
    lastTimeupdateElapsed = performance.now();
  };

  const reconcileVideo = () => bindVideo(findVideo());

  const copyRecords = () => records.map((item) => ({
    ...item,
    bufferedRanges: item.bufferedRanges.map((range) => ({ ...range })),
    videoQuality: item.videoQuality === null ? null : { ...item.videoQuality },
  }));

  const reset = () => {
    if (stopped) return copyRecords();
    records.length = 0;
    lastTimeupdateElapsed = -Infinity;
    lastProgressElapsed = -Infinity;
    if (selectedVideo !== undefined && selectedVideo.isConnected !== false) {
      const elapsed = performance.now();
      record('timeupdate', selectedVideo, elapsed);
      lastTimeupdateElapsed = elapsed;
    }
    return copyRecords();
  };

  mutationObserver = new MutationObserver(reconcileVideo);
  mutationObserver.observe(document, { childList: true, subtree: true });
  sampleTimer = setInterval(() => {
    reconcileVideo();
    if (selectedVideo === undefined) return;
    const elapsed = performance.now();
    if (elapsed - lastTimeupdateElapsed < 1000) return;
    lastTimeupdateElapsed = elapsed;
    record('timeupdate', selectedVideo, elapsed);
  }, 1000);
  reconcileVideo();

  window.__stallProbe = {
    records: copyRecords,
    info: () => ({
      hasVideo: selectedVideo !== undefined && selectedVideo.isConnected !== false,
      area: selectedVideo === undefined ? 0 : selectedVideo.clientWidth * selectedVideo.clientHeight,
      recordCount: records.length,
    }),
    reset,
    stop: () => {
      if (stopped) return copyRecords();
      stopped = true;
      clearInterval(sampleTimer);
      mutationObserver.disconnect();
      if (selectedVideo !== undefined) detachVideo();
      return copyRecords();
    },
  };
};

export const STALL_PROBE_SOURCE = `(${stallProbeInit.toString()})()`;

export function probeSourceForArm() {
  return STALL_PROBE_SOURCE;
}
