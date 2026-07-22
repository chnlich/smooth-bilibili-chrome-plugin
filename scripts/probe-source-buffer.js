/* Bilibili SourceBuffer 真实行为探测
 * 用法: 在真实直播页面的 DevTools Console 粘贴整段脚本回车
 * 60 秒后自动下载 source-buffer-probe-report.json
 * 把文件存到 C:\Users\chnli\ 下，告诉 opencode 文件名
 */
(() => {
  const RECORD_SECONDS = 60;
  const records = [];
  const start = performance.now();
  const shim = window.__smoothBufferShim;
  const log = (type, data) => records.push({ t: Math.round((performance.now() - start) * 10) / 10, type, ...data });

  log('meta', {
    hasShim: !!shim,
    shimInstalled: shim?.installed,
    shimRetainSeconds: shim?.retainSeconds,
    hasSourceBuffer: typeof SourceBuffer !== 'undefined',
    removeIsNative: typeof SourceBuffer !== 'undefined'
      ? SourceBuffer.prototype.remove.toString().includes('[native code]')
      : null,
    hasManagedMediaSource: typeof ManagedMediaSource !== 'undefined',
  });

  const findVideo = () => {
    const videos = [...document.querySelectorAll('video')];
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const d = iframe.contentDocument;
        if (d) videos.push(...d.querySelectorAll('video'));
      } catch {}
    }
    return videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  };

  const snapshotVideo = () => {
    const v = findVideo();
    if (!v) return { hasVideo: false };
    const buffered = [];
    try { for (let i = 0; i < v.buffered.length; i++) buffered.push([v.buffered.start(i), v.buffered.end(i)]); } catch {}
    const seekable = [];
    try { for (let i = 0; i < v.seekable.length; i++) seekable.push([v.seekable.start(i), v.seekable.end(i)]); } catch {}
    return {
      hasVideo: true,
      currentTime: Math.round(v.currentTime * 1000) / 1000,
      paused: v.paused,
      readyState: v.readyState,
      bufferedRangeCount: v.buffered.length,
      bufferedTotal: buffered.reduce((s, r) => s + (r[1] - r[0]), 0),
      bufferedRanges: buffered,
      seekableEnd: seekable.length ? seekable[seekable.length - 1][1] : null,
      delay: seekable.length ? Math.round((seekable[seekable.length - 1][1] - v.currentTime) * 1000) / 1000 : null,
      src: v.src ? v.src.slice(0, 60) : null,
    };
  };

  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.remove) {
    const orig = SourceBuffer.prototype.remove;
    SourceBuffer.prototype.remove = function (s, e) {
      const v = snapshotVideo();
      log('remove', { start: s, end: e, range: Math.round((e - s) * 1000) / 1000, ...v, shimIntercepted: shim ? shim.stats.intercepted : null });
      return orig.call(this, s, e);
    };
  }
  if (typeof MediaSource !== 'undefined') {
    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      log('addSourceBuffer', { mime });
      return origAdd.call(this, mime);
    };
    const origEos = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function (reason) {
      log('endOfStream', { reason });
      return origEos.call(this, reason);
    };
  }
  const origAppend = SourceBuffer?.prototype?.appendBuffer;
  if (origAppend) {
    SourceBuffer.prototype.appendBuffer = function (...args) {
      log('appendBuffer', { byteLength: args[0]?.byteLength || args[0]?.size || null });
      return origAppend.call(this, ...args);
    };
  }
  setInterval(() => log('tick', snapshotVideo()), 2000);

  setTimeout(() => {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'source-buffer-probe-report.json';
    a.click();
    console.log(`probe done: ${records.length} records, downloading report`);
  }, RECORD_SECONDS * 1000);

  console.log(`probe started, recording ${RECORD_SECONDS}s...`);
})();
