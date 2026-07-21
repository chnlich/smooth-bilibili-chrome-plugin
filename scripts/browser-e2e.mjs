import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');

const silentAndAuditInit = () => {
  const media = new Set();
  const ownership = [];
  const fixtureCalls = [];
  let fixtureDepth = 0;
  let quietDepth = 0;
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    media.add(element);
    quietDepth += 1;
    try {
      element.muted = true;
      element.volume = 0;
    } finally {
      quietDepth -= 1;
    }
  };
  const scan = (rootNode) => {
    if (rootNode instanceof HTMLMediaElement) silence(rootNode);
    if (typeof rootNode.querySelectorAll !== 'function') return;
    for (const element of rootNode.querySelectorAll('video,audio')) silence(element);
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  });
  observer.observe(document, { childList: true, subtree: true });
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const record = (name) => {
    if (quietDepth === 0) ownership.push(`${fixtureDepth > 0 ? 'fixture' : 'extension'}:${name}`);
  };
  for (const [name, original] of [['play', originalPlay], ['pause', originalPause]]) {
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      writable: true,
      value(...args) {
        record(name);
        silence(this);
        return original.apply(this, args);
      },
    });
  }
  for (const name of ['currentTime', 'playbackRate', 'muted', 'volume', 'src']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
    if (descriptor?.set === undefined) continue;
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        record(`set:${name}`);
        return descriptor.set.call(this, value);
      },
    });
  }
  scan(document);
  window.__e2eAudit = {
    async fixtureCall(name, callback) {
      fixtureCalls.push(name);
      fixtureDepth += 1;
      try {
        return await callback();
      } finally {
        fixtureDepth -= 1;
      }
    },
    reset() { ownership.length = 0; },
    ownership() { return [...ownership]; },
    extensionOwnership() { return ownership.filter((entry) => entry.startsWith('extension:')); },
    fixtureOwnership() { return ownership.filter((entry) => entry.startsWith('fixture:')); },
    fixtureCalls() { return [...fixtureCalls]; },
    silence() {
      scan(document);
      return [...media].map((element) => ({ muted: element.muted, volume: element.volume }));
    },
  };
};

const autoOpenPopupLogs = () => {
  if (location.protocol !== 'chrome-extension:' || location.pathname !== '/popup.html' ||
    location.search !== '?e2e-open-logs') return;
  const clickWhenVideoStatusIsReady = () => {
    const mode = document.querySelector('[data-status-field="mode"]');
    const button = document.querySelector('[data-open-logs]');
    if (mode?.textContent === '视频' && button instanceof HTMLButtonElement) {
      window.__e2ePopupLogsClicked = true;
      button.click();
      return;
    }
    window.setTimeout(clickWhenVideoStatusIsReady, 20);
  };
  document.addEventListener('DOMContentLoaded', clickWhenVideoStatusIsReady, { once: true });
};

const videoFixture = `<!doctype html><html><body><div id="stage"></div><script>
  const stage = document.querySelector('#stage');
  const video = document.createElement('video');
  video.id = 'media';
  video.playsInline = true;
  video.muted = true;
  video.volume = 0;
  stage.append(video);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  context.fillStyle = '#18b66a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(30);
  let sourceKey = 'video-source-1';
  video.src = sourceKey;
  setInterval(() => {
    context.fillStyle = '#18b66a';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 50);
  video.srcObject = stream;
  let decodedFrames = 0;
  let decodedNonBlack = false;
  const probe = document.createElement('canvas');
  probe.width = 320;
  probe.height = 180;
  const probeContext = probe.getContext('2d');
  function onFrame() {
    decodedFrames += 1;
    probeContext.drawImage(video, 0, 0, probe.width, probe.height);
    const pixels = probeContext.getImageData(0, 0, 1, 1).data;
    decodedNonBlack = pixels[0] + pixels[1] + pixels[2] > 12 && pixels[3] > 0;
    video.requestVideoFrameCallback(onFrame);
  }
  video.requestVideoFrameCallback(onFrame);
  const calls = [];
  let core = { setStableBufferTime(seconds) { calls.push(seconds); } };
  window.player = { __core() { return core; } };
  window.__fixture = {
    calls,
    async start() { await window.__e2eAudit.fixtureCall('play', () => video.play()); },
    decodedFrames() { return decodedFrames; },
    decodedNonBlack() { return decodedNonBlack; },
    replace() {
      sourceKey = 'video-source-2';
      video.src = sourceKey;
      core = { setStableBufferTime(seconds) { calls.push(seconds); } };
      window.__e2eAudit.reset();
    },
  };
  window.__e2eAudit.reset();
</script></body></html>`;

const liveFixture = `<!doctype html><html><body><div id="stage"></div>
  <input id="timeline" data-seek type="range" min="0" max="240" step="0.01" value="0">
  <button id="quality" type="button">quality</button>
  <input id="volume" data-progress type="range" aria-label="volume" min="0" max="1" step="0.1" value="0">
  <script>
    const stage = document.querySelector('#stage');
    const timeline = document.querySelector('#timeline');
    const volume = document.querySelector('#volume');
    let video;
    let clipSources;
    let recordedClips;
    let initialStallSource;
    let activeStallSource;
    let activeStallPromise;
    let decodedFrames = 0;
    let decodedNonBlack = false;
    let initialDelay = 0;
    let recoveredDelay = 0;
    let stallDuration = 0;
    let stallStartedAt = 0;
    let frozenSeekableEnd = 0;
    let nextGenuineStallAction;
    let nextGenuineStallSeekTime;
    let initialClipIndex = 0;
    let timelineInputCount = 0;

    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    async function recordClip(milliseconds, color) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = () => reject(recorder.error || new Error('fixture MediaRecorder failed'));
      });
      recorder.start(100);
      const painter = setInterval(() => {
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      await sleep(milliseconds);
      clearInterval(painter);
      recorder.stop();
      await stopped;
      for (const track of stream.getTracks()) track.stop();
      return { chunks, mimeType, requestedDuration: milliseconds / 1000 };
    }

    function appendSourceData(sourceBuffer, chunks, mimeType) {
      if (chunks.length === 0) throw new Error('fixture MSE 没有可追加的视频数据');
      return new Promise((resolve, reject) => {
        const complete = () => {
          sourceBuffer.removeEventListener('updateend', complete);
          sourceBuffer.removeEventListener('error', failed);
          resolve();
        };
        const failed = () => {
          sourceBuffer.removeEventListener('updateend', complete);
          sourceBuffer.removeEventListener('error', failed);
          reject(new Error('fixture MSE append 失败'));
        };
        sourceBuffer.addEventListener('updateend', complete, { once: true });
        sourceBuffer.addEventListener('error', failed, { once: true });
        void new Blob(chunks, { type: mimeType }).arrayBuffer().then(
          (buffer) => {
            try {
              sourceBuffer.appendBuffer(buffer);
            } catch (error) {
              failed();
            }
          },
          failed,
        );
      });
    }

    function createMediaSourceUrl(recorded) {
      const mediaSource = new MediaSource();
      const url = URL.createObjectURL(mediaSource);
      mediaSource.addEventListener('sourceopen', () => {
        const sourceBuffer = mediaSource.addSourceBuffer(recorded.mimeType);
        sourceBuffer.addEventListener('updateend', () => {
          const bufferedEnd = sourceBuffer.buffered.length === 0
            ? recorded.requestedDuration
            : sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          mediaSource.duration = Math.max(recorded.requestedDuration, bufferedEnd);
        }, { once: true });
        void new Blob(recorded.chunks, { type: recorded.mimeType }).arrayBuffer()
          .then((buffer) => sourceBuffer.appendBuffer(buffer));
      }, { once: true });
      return { url, mediaSource };
    }

    function createStallingMediaSource(recorded) {
      if (recorded.chunks.length < 2) throw new Error('fixture MSE 没有足够的视频分段');
      const mediaSource = new MediaSource();
      const url = URL.createObjectURL(mediaSource);
      const initialChunkCount = Math.max(1, Math.min(16, recorded.chunks.length - 1));
      let sourceBuffer;
      let remainingAppended = false;
      let resolveInitial;
      let rejectInitial;
      const initialReady = new Promise((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer(recorded.mimeType);
          void appendSourceData(sourceBuffer, recorded.chunks.slice(0, initialChunkCount), recorded.mimeType).then(
            () => {
              mediaSource.duration = recorded.requestedDuration;
              resolveInitial();
            },
            rejectInitial,
          );
        } catch (error) {
          rejectInitial(error);
        }
      }, { once: true });
      return {
        url,
        mediaSource,
        initialReady,
        async appendRemaining() {
          await initialReady;
          await appendSourceData(
            sourceBuffer,
            recorded.chunks.slice(initialChunkCount),
            recorded.mimeType,
          );
          remainingAppended = true;
        },
        isStarving() { return remainingAppended === false; },
      };
    }

    function trackDecoded(nextVideo) {
      const probe = document.createElement('canvas');
      probe.width = 320;
      probe.height = 180;
      const context = probe.getContext('2d');
      const onFrame = () => {
        decodedFrames += 1;
        context.drawImage(nextVideo, 0, 0, 320, 180);
        const pixels = context.getImageData(0, 0, 1, 1).data;
        decodedNonBlack = pixels[0] + pixels[1] + pixels[2] > 12 && pixels[3] > 0;
        nextVideo.requestVideoFrameCallback(onFrame);
      };
      nextVideo.requestVideoFrameCallback(onFrame);
    }

    function removeVideoNow() {
      return window.__e2eAudit.fixtureCall('video-remove', () => video.remove());
    }

    function clearSourceNow() {
      return window.__e2eAudit.fixtureCall('clear:src', () => {
        video.src = '';
        video.load();
      });
    }

    function createReplacementVideoElement() {
      return window.__e2eAudit.fixtureCall('video-create', () => {
        const replacement = document.createElement('video');
        replacement.id = 'media';
        replacement.preload = 'auto';
        replacement.playsInline = true;
        replacement.muted = true;
        replacement.volume = 0;
        stage.append(replacement);
        trackDecoded(replacement);
        video = replacement;
      });
    }

    function scriptSeekNow(time) {
      const target = Math.max(0.1, Math.min(time, video.duration - 0.05));
      return window.__e2eAudit.fixtureCall('script-currentTime', () => { video.currentTime = target; });
    }

    function waitForMetadata(nextVideo) {
      return new Promise((resolve, reject) => {
        let timeout;
        const cleanup = () => {
          clearTimeout(timeout);
          nextVideo.removeEventListener('loadedmetadata', loaded);
          nextVideo.removeEventListener('error', failed);
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(nextVideo.error || new Error('fixture media metadata failed'));
        };
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error('fixture media metadata timed out'));
        }, 10000);
        nextVideo.addEventListener('loadedmetadata', loaded, { once: true });
        nextVideo.addEventListener('error', failed, { once: true });
      });
    }

    async function setSource(nextVideo, url, position, sourceReady) {
      const metadata = waitForMetadata(nextVideo);
      await window.__e2eAudit.fixtureCall('set:src', () => {
        nextVideo.src = url;
        nextVideo.load();
      });
      await metadata;
      if (sourceReady !== undefined) await sourceReady;
      const target = Math.max(0.1, Math.min(position, nextVideo.duration - 0.1));
      await window.__e2eAudit.fixtureCall('set:currentTime', () => { nextVideo.currentTime = target; });
      timeline.max = String(nextVideo.duration);
      return target;
    }

    function waitForGenuineStall(frameBaseline) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          nextGenuineStallAction = undefined;
          nextGenuineStallSeekTime = undefined;
          video.removeEventListener('waiting', onWaiting);
          reject(new Error('fixture 未出现首帧后的原生 waiting: currentTime=' + video.currentTime
            + ', duration=' + video.duration
            + ', readyState=' + video.readyState
            + ', paused=' + video.paused
            + ', decodedFrames=' + decodedFrames));
        }, 10000);
        const onWaiting = (event) => {
          if (event.target !== video) return;
          if (decodedFrames <= frameBaseline) return;
          if (activeStallSource?.isStarving() !== true) return;
          clearTimeout(timer);
          video.removeEventListener('waiting', onWaiting);
          const action = nextGenuineStallAction;
          const seekTime = nextGenuineStallSeekTime;
          nextGenuineStallAction = undefined;
          nextGenuineStallSeekTime = undefined;
          if (action === 'clear-source') void clearSourceNow();
          if (action === 'remove-video') void removeVideoNow();
          if (action === 'script-seek') void scriptSeekNow(seekTime);
          resolve({
            trusted: event.isTrusted,
            decodedFrames,
            currentTime: video.currentTime,
            stalledAt: performance.now(),
          });
        };
        video.addEventListener('waiting', onWaiting);
      });
    }

    async function waitForDecodedFrameAfter(frameCount) {
      const deadline = performance.now() + 10000;
      while (decodedFrames <= frameCount) {
        if (performance.now() >= deadline) throw new Error('fixture MSE 恢复后没有新解码帧');
        await sleep(20);
      }
    }

    async function startStallingSource(position, action, seekTime) {
      nextGenuineStallAction = action;
      nextGenuineStallSeekTime = seekTime;
      activeStallSource = createStallingMediaSource(recordedClips[0]);
      await setSource(video, activeStallSource.url, position, activeStallSource.initialReady);
      activeStallPromise = waitForGenuineStall(decodedFrames);
      try {
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      } catch (error) {
        if (action === undefined || error?.name !== 'AbortError') throw error;
      }
      return activeStallPromise;
    }

    async function boot() {
      recordedClips = await Promise.all([
        recordClip(4200, '#f05a28'),
        recordClip(4200, '#18b66a'),
        recordClip(6200, '#5b6ee1'),
      ]);
      clipSources = recordedClips.map(createMediaSourceUrl);
      initialClipIndex = location.pathname.includes('input-fixture') ? 2 : 0;
      if (initialClipIndex === 0) {
        initialStallSource = createStallingMediaSource(recordedClips[0]);
        activeStallSource = initialStallSource;
      }
      video = document.createElement('video');
      video.id = 'media';
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = true;
      video.volume = 0;
      stage.append(video);
      trackDecoded(video);
      await setSource(
        video,
        initialStallSource?.url || clipSources[initialClipIndex].url,
        0.6,
        initialStallSource?.initialReady,
      );
    }

    const ready = boot();
    timeline.addEventListener('input', () => {
      timelineInputCount += 1;
      const target = Math.max(0.1, Math.min(Number(timeline.value), video.duration - 0.05));
      void window.__e2eAudit.fixtureCall('timeline-currentTime', () => {
        video.currentTime = target;
      });
    });
    volume.addEventListener('input', () => video.dispatchEvent(new Event('volumechange')));
    window.__fixture = {
      async start() {
        await ready;
        window.__e2eAudit.reset();
        if (activeStallSource !== undefined) activeStallPromise = waitForGenuineStall(decodedFrames);
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      },
      decodedFrames() { return decodedFrames; },
      decodedNonBlack() { return decodedNonBlack; },
      async beginStall() {
        if (activeStallPromise === undefined) throw new Error('fixture 没有待验证的原生卡顿');
        const stall = await activeStallPromise;
        initialDelay = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        frozenSeekableEnd = video.seekable.end(video.seekable.length - 1);
        stallStartedAt = stall.stalledAt;
        return { ...stall, initialDelay, frozenSeekableEnd };
      },
      async beginProtectedSeek() {
        const stall = await startStallingSource(0.1);
        return { ...stall, currentTime: video.currentTime, paused: video.paused, readyState: video.readyState };
      },
      async beginProtectedSourceClear() {
        const stall = await startStallingSource(0.1, 'clear-source');
        return { ...stall };
      },
      async beginProtectedVideoRemoval() {
        const stall = await startStallingSource(0.1, 'remove-video');
        return { ...stall };
      },
      async beginProtectedScriptSeek(time) {
        const stall = await startStallingSource(0.1, 'script-seek', time);
        return { ...stall };
      },
      async recoverWithDelay() {
        await sleep(1200);
        const seekableEndBeforeRecovery = video.seekable.length === 0
          ? null
          : video.seekable.end(video.seekable.length - 1);
        if (seekableEndBeforeRecovery !== frozenSeekableEnd) {
          throw new Error('fixture MSE 卡顿期间 seekable 被推进');
        }
        const frameCount = decodedFrames;
        await activeStallSource.appendRemaining();
        await waitForDecodedFrameAfter(frameCount);
        stallDuration = (performance.now() - stallStartedAt) / 1000;
        recoveredDelay = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        return { seekableEndBeforeRecovery };
      },
      delays() {
        return {
          initialDelay,
          recoveredDelay,
          duration: video.duration,
          seekableEnd: video.seekable.length === 0 ? null : video.seekable.end(video.seekable.length - 1),
          currentTime: video.currentTime,
          stallDuration,
          targetDelay: initialDelay + stallDuration,
          frozenSeekableEnd,
        };
      },
      async setLogicalPosition() {
        const target = Math.max(0.1, video.duration - 0.6);
        await window.__e2eAudit.fixtureCall('set:currentTime', () => { video.currentTime = target; });
        await sleep(100);
      },
      async clearSource() {
        await clearSourceNow();
      },
      async scriptSeek(time) {
        await scriptSeekNow(time);
        await sleep(100);
      },
      async sourceReplace() {
        await setSource(video, clipSources[2].url, 0.1);
        await window.__e2eAudit.fixtureCall('set:currentTime', () => {
          video.currentTime = Math.max(0.1, video.duration - 0.2);
        });
      },
      async normalSourceReplace() {
        const replacementSource = createMediaSourceUrl(recordedClips[1]);
        await setSource(video, replacementSource.url, 0.1);
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      },
      async resumeCurrent() { await window.__e2eAudit.fixtureCall('play', () => video.play()); },
      async replaceVideo() {
        await removeVideoNow();
        await createReplacementVideoElement();
      },
      async createReplacementVideo() { await createReplacementVideoElement(); },
      async playReplacement() {
        const replacementSource = createMediaSourceUrl(recordedClips[1]);
        await setSource(video, replacementSource.url, 0.1);
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      },
      async triggerUniqueMediaEvent() { video.dispatchEvent(new Event('ended')); },
      assignments() { return video.currentTime; },
      timelineInputs() { return timelineInputCount; },
    };
    window.__e2eAudit.reset();
  </script></body></html>`;

async function waitFor(page, predicate, timeout = 15000) {
  await page.waitForFunction(predicate, undefined, { timeout });
}

function assertNoForbiddenExtensionMediaWrites(entries) {
  assert.deepEqual(
    entries.filter((entry) => [
      'extension:play',
      'extension:pause',
      'extension:set:playbackRate',
      'extension:set:muted',
      'extension:set:volume',
      'extension:set:src',
      'extension:set:currentSrc',
    ].includes(entry)),
    [],
  );
}

async function openFixture(context, url, html) {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[e2e pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[e2e console] ${message.text()}`);
  });
  await page.route('**/*', async (route) => {
    if (route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function extensionIdFor(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  assert.notEqual(match, null);
  return match[1];
}

async function extensionSend(page, message) {
  return page.evaluate((request) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError !== undefined) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  }), message);
}

async function readStoredEvents(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const send = (message) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
    const snapshot = await send({ version: 1, type: 'logs:max-event-id' });
    const events = [];
    let afterEventId = 0;
    for (;;) {
      const response = await send({
        version: 1,
        type: 'logs:events-page',
        limit: 250,
        afterEventId,
        maxEventId: snapshot.maxEventId,
      });
      events.push(...response.events);
      if (!response.hasMore) break;
      afterEventId = response.nextAfterEventId;
    }
    return { maxEventId: snapshot.maxEventId, events };
  });
  await page.close();
  return result;
}

async function waitForStoredEvents(context, extensionId, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await readStoredEvents(context, extensionId);
    if (predicate(result.events)) return result;
    if (Date.now() >= deadline) {
      throw new Error('等待 IndexedDB 日志条件超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createExportPage(context, extensionId, hash, options = {}) {
  const page = await context.newPage();
  await page.addInitScript(({ failAt, cancel }) => {
    const state = {
      lines: [],
      writes: 0,
      maxInFlight: 0,
      inFlight: 0,
      closed: false,
      aborted: false,
      release: false,
    };
    window.__exportState = state;
    window.showSaveFilePicker = async () => {
      if (cancel) throw new DOMException('user cancelled', 'AbortError');
      return {
        async createWritable() {
          return {
            async write(value) {
              state.writes += 1;
              state.inFlight += 1;
              state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
              try {
                while (state.release !== true && state.writes === 1) {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                }
                if (failAt !== undefined && state.writes >= failAt) throw new Error('synthetic writer failure');
                state.lines.push(value);
              } finally {
                state.inFlight -= 1;
              }
            },
            async close() { state.closed = true; },
            async abort() { state.aborted = true; },
          };
        },
      };
    };
  }, options);
  await page.goto(`chrome-extension://${extensionId}/logs.html${hash}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function createBackgroundExtensionPage(context, launcher, url) {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    launcher.evaluate((nextUrl) => new Promise((resolve, reject) => {
      chrome.tabs.create({ url: nextUrl, active: false }, (tab) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab.id);
      });
    }), url),
  ]);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function clickExport(page) {
  await page.locator('[data-export]').click();
}

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-e2e-profile-'));
const scenarios = [];
const markScenario = (name) => {
  scenarios.push(name);
  console.log('SCENARIO', name);
};
let context;
let extensionId;
let livePage;
try {
  const launch = (profile) => chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  await context.addInitScript({ content: `(${autoOpenPopupLogs.toString()})()` });
  extensionId = await extensionIdFor(context);

  const videoPage = await openFixture(context, 'https://www.bilibili.com/video/BVfixture', videoFixture);
  await videoPage.evaluate(() => window.__fixture.start());
  await waitFor(videoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await videoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  await waitFor(videoPage, () => window.__fixture.calls.length === 1);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120]);
  assertNoForbiddenExtensionMediaWrites(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  const videoEvents = await readStoredEvents(context, extensionId);
  const videoHint = videoEvents.events
    .filter((event) => event.code === 'video.buffer_hint.applied' && event.data?.targetSeconds === 120)
    .at(-1);
  assert.ok(videoHint);
  assert.equal(typeof videoHint.data.actualSeconds, 'number');
  assert.notEqual(videoHint.data.actualSeconds, videoHint.data.targetSeconds);
  markScenario('真实无音轨视频解码与 120 秒缓存');

  await videoPage.evaluate(() => window.__fixture.replace());
  await waitFor(videoPage, () => window.__fixture.calls.length === 2);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120, 120]);
  assertNoForbiddenExtensionMediaWrites(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  markScenario('视频 source/core generation replacement');
  await videoPage.close();

  const watchLaterPage = await openFixture(context, 'https://www.bilibili.com/list/watchlater/item-1', videoFixture);
  await watchLaterPage.evaluate(() => window.__fixture.start());
  await waitFor(watchLaterPage, () => window.__fixture.calls.length === 1 && window.__fixture.decodedFrames() > 0);
  await watchLaterPage.close();
  markScenario('Watch Later item route');

  const unrelatedPage = await openFixture(context, 'https://www.bilibili.com/search?keyword=fixture', videoFixture);
  await unrelatedPage.waitForTimeout(1000);
  assert.deepEqual(await unrelatedPage.evaluate(() => window.__fixture.calls), []);
  await unrelatedPage.close();
  markScenario('unrelated route remains untouched');

  livePage = await openFixture(context, 'https://live.bilibili.com/fixture', liveFixture);
  await livePage.evaluate(() => window.__fixture.start());
  await waitFor(livePage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  markScenario('真实无音轨直播帧解码');

  const recoveredCountBeforeNativeStall = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.recovered').length;
  const nativeStall = await livePage.evaluate(() => window.__fixture.beginStall());
  assert.equal(nativeStall.trusted, true);
  assert.ok(nativeStall.decodedFrames > 0);
  await livePage.waitForTimeout(150);
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  const frozenDuringStall = await livePage.evaluate(() => window.__fixture.delays());
  assert.equal(frozenDuringStall.seekableEnd, nativeStall.frozenSeekableEnd);
  const recovery = await livePage.evaluate(() => window.__fixture.recoverWithDelay());
  assert.equal(recovery.seekableEndBeforeRecovery, nativeStall.frozenSeekableEnd);
  await livePage.waitForFunction(
    (frameBaseline) => window.__fixture.decodedFrames() > frameBaseline,
    nativeStall.decodedFrames,
    { timeout: 15000 },
  );
  let stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.recovered').length > recoveredCountBeforeNativeStall,
  );
  const liveDelays = await livePage.evaluate(() => window.__fixture.delays());
  const recovered = stored.events
    .filter((event) => event.code === 'live.stall.recovered')
    .slice(recoveredCountBeforeNativeStall)
    .find((event) => Math.abs(event.data.targetDelay - liveDelays.targetDelay) <= 0.5);
  assert.ok(
    Math.abs(liveDelays.recoveredDelay - liveDelays.targetDelay) <= 0.5,
    '冻结 seekable 的真实 MSE 卡顿后恢复延迟不约等于 D+T: ' + JSON.stringify(liveDelays),
  );
  assert.ok(recovered, JSON.stringify({ liveDelays }));
  assert.ok(
    Math.abs(recovered.data.targetDelay - liveDelays.targetDelay) <= 0.5,
    JSON.stringify({ recovered: recovered.data, liveDelays }),
  );
  assert.ok(
    Math.abs(recovered.data.protectedDelay - liveDelays.recoveredDelay) <= 0.5,
    JSON.stringify({ recovered: recovered.data, liveDelays }),
  );
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'live.delay.observed' && event.eventId > recovered.eventId
      && Math.abs(event.data.estimatedDelay - liveDelays.recoveredDelay) <= 0.5),
  );
  const delayObservation = stored.events
    .find((event) => event.code === 'live.delay.observed' && event.eventId > recovered.eventId
      && Math.abs(event.data.estimatedDelay - liveDelays.recoveredDelay) <= 0.5);
  assert.ok(delayObservation);
  assert.ok(
    Math.abs(delayObservation.data.estimatedDelay - liveDelays.recoveredDelay) <= 0.5,
    JSON.stringify({ delayObservation: delayObservation.data, liveDelays }),
  );
  markScenario('直播 D+T 延迟观察、保护与真实恢复帧');

  const sourceClearErrorCutoff = (await readStoredEvents(context, extensionId)).maxEventId;
  const secondStallDetectedCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  const secondStall = await livePage.evaluate(() => window.__fixture.beginProtectedSourceClear());
  assert.equal(secondStall.trusted, true);
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > secondStallDetectedCount,
  );
  await livePage.waitForTimeout(500);
  const sourceClearOverlayCount = await livePage.locator('#stage canvas[aria-hidden="true"]').count();
  assert.ok(sourceClearOverlayCount >= 1, JSON.stringify({
    sourceClearOverlayCount,
    recentEvents: (await readStoredEvents(context, extensionId)).events
      .filter((event) => ['live.stall.detected', 'live.stall.recovered', 'live.delay_protection.cancelled', 'media.emptied'].includes(event.code))
      .slice(-8),
  }));
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'media.error'
      && event.eventId > sourceClearErrorCutoff && event.error?.code === '4'),
  );
  const numericMediaError = stored.events
    .filter((event) => event.code === 'media.error' && event.eventId > sourceClearErrorCutoff)
    .at(-1);
  assert.equal(numericMediaError.error?.code, '4', JSON.stringify(numericMediaError));
  markScenario('数字 MediaError code 进入持久化日志');
  const sourceOverlayPixel = await livePage.locator('#stage canvas[aria-hidden="true"]').first().evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { color: pixels[0] + pixels[1] + pixels[2], pointerEvents: canvas.style.pointerEvents };
  });
  assert.ok(sourceOverlayPixel.color > 12);
  assert.equal(sourceOverlayPixel.pointerEvents, 'none');
  await livePage.evaluate(() => window.__fixture.sourceReplace());
  await livePage.evaluate(() => window.__fixture.resumeCurrent());
  await waitFor(livePage, () => document.querySelector('#stage canvas[aria-hidden="true"]') === null);
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'live.delay.corrected' && event.data.reason === 'source_replaced'),
  );
  const replacementCorrection = stored.events
    .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'source_replaced')
    .at(-1);
  const replacementFacts = await livePage.evaluate(() => window.__fixture.delays());
  assert.ok(Math.abs(
    replacementFacts.seekableEnd - replacementCorrection.data.targetTime - replacementCorrection.data.protectedDelay,
  ) <= 0.5);
  markScenario('当前卡顿 source 清空/换源覆盖、恢复首帧撤下与目标延迟校正');

  assert.equal(await livePage.locator('#stage canvas[aria-hidden="true"]').count(), 0);
  const normalReplacementFrameBaseline = await livePage.evaluate(() => window.__fixture.decodedFrames());
  await livePage.evaluate(() => window.__fixture.normalSourceReplace());
  await livePage.waitForFunction(
    (frameBaseline) => window.__fixture.decodedFrames() > frameBaseline,
    normalReplacementFrameBaseline,
    { timeout: 15000 },
  );
  await waitFor(livePage, () => document.querySelector('#stage canvas[aria-hidden="true"]') === null);
  assert.equal(await livePage.locator('#stage canvas[aria-hidden="true"]').count(), 0);
  markScenario('恢复后的普通 source replacement 不复活旧画面');

  const replacementStallDetectedCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  const replacementStall = await livePage.evaluate(() => window.__fixture.beginProtectedVideoRemoval());
  assert.equal(replacementStall.trusted, true);
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > replacementStallDetectedCount,
  );
  await waitFor(livePage, () => document.querySelector('#stage canvas[aria-hidden="true"]') !== null);
  const replacementOverlay = livePage.locator('#stage canvas[aria-hidden="true"]');
  assert.ok(await replacementOverlay.count() >= 1);
  const replacementPixel = await replacementOverlay.first().evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { color: pixels[0] + pixels[1] + pixels[2], pointerEvents: canvas.style.pointerEvents };
  });
  assert.ok(replacementPixel.color > 12);
  assert.equal(replacementPixel.pointerEvents, 'none');
  await livePage.evaluate(() => window.__fixture.createReplacementVideo());
  await livePage.evaluate(() => window.__fixture.playReplacement());
  await waitFor(livePage, () => document.querySelector('#stage canvas[aria-hidden="true"]') === null);
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  markScenario('当前卡顿 video replacement 覆盖非黑且首帧撤下');

  await livePage.close();
  livePage = await openFixture(context, 'https://live.bilibili.com/input-fixture', liveFixture);
  const freshLoadedDataCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'media.loadeddata').length;
  await livePage.evaluate(() => window.__fixture.start());
  await waitFor(livePage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  markScenario('fresh live input fixture');

  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'media.loadeddata').length > freshLoadedDataCount,
  );
  await livePage.waitForTimeout(500);
  await livePage.evaluate(() => window.__e2eAudit.reset());
  const mouseStallDetectedCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  const mouseNativeStall = await livePage.evaluate(() => window.__fixture.beginProtectedSeek());
  assert.equal(mouseNativeStall.trusted, true);
  assert.ok(mouseNativeStall.decodedFrames > 0);
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > mouseStallDetectedCount,
  );
  await livePage.locator('#timeline').focus();
  const mouseCancellationCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.delay_protection.cancelled').length;
  const timelineInputBaseline = await livePage.evaluate(() => window.__fixture.timelineInputs());
  const timelineBox = await livePage.locator('#timeline').boundingBox();
  const timelineY = timelineBox.y + timelineBox.height / 2;
  await livePage.mouse.move(timelineBox.x + 1, timelineY);
  await livePage.mouse.down();
  await livePage.mouse.move(timelineBox.x + timelineBox.width * 0.5, timelineY, { steps: 8 });
  await livePage.mouse.up();
  await livePage.waitForFunction(
    (inputBaseline) => window.__fixture.timelineInputs() > inputBaseline,
    timelineInputBaseline,
    { timeout: 15000 },
  );
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.delay_protection.cancelled').length > mouseCancellationCount,
  );
  const mouseCancellation = stored.events
    .filter((event) => event.code === 'live.delay_protection.cancelled')
    .at(-1);
  assert.equal(mouseCancellation.data.reason, 'user_seek', JSON.stringify(mouseCancellation));
  assert.deepEqual(
    stored.events.filter((event) => event.code === 'live.delay.corrected'
      && event.data.reason === 'automatic_forward_seek' && event.eventId > mouseCancellation.eventId),
    [],
  );
  markScenario('真实鼠标 timeline seek cancels protection');

  await livePage.waitForTimeout(250);
  const qualityStallCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  const keyboardNativeStall = await livePage.evaluate(() => window.__fixture.beginProtectedSeek());
  assert.equal(keyboardNativeStall.trusted, true);
  assert.ok(keyboardNativeStall.decodedFrames > 0);
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > qualityStallCount,
  );
  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.locator('#timeline').focus();
  await livePage.keyboard.press('End');
  await waitFor(livePage, () => window.__fixture.assignments() > 0.2);
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  markScenario('真实键盘 seek key cancels protection');

  await livePage.evaluate(() => window.__e2eAudit.reset());
  const assertAutomaticScriptSeek = async () => {
    const correctionCount = (await readStoredEvents(context, extensionId)).events
      .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length;
    const stall = await livePage.evaluate(() => window.__fixture.beginProtectedScriptSeek(110));
    assert.equal(stall.trusted, true);
    stored = await waitForStoredEvents(
      context,
      extensionId,
      (events) => events.filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length
        > correctionCount,
    );
    const correction = stored.events
      .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek')
      .at(-1);
    assert.ok(correction.data.targetTime < correction.data.currentTime);
  };
  await livePage.locator('#quality').click();
  await assertAutomaticScriptSeek();
  await livePage.locator('#volume').click();
  await assertAutomaticScriptSeek();
  await livePage.locator('#media').click();
  await assertAutomaticScriptSeek();
  assertNoForbiddenExtensionMediaWrites(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  markScenario('quality/volume/video clicks do not authorize script seek');

  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.locator('#volume').focus();
  await livePage.keyboard.press('ArrowRight');
  await assertAutomaticScriptSeek();
  markScenario('unrelated keyboard input does not authorize script seek');

  stored = await readStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'live.delay.corrected'));
  assert.ok(stored.events.some((event) => event.code === 'media.volumechange' && event.data.eventType === 'volumechange'));
  const sessionId = stored.events.find((event) => event.code === 'live.stall.detected')?.sessionId;
  assert.equal(typeof sessionId, 'string');
  markScenario('IndexedDB live/media log facts');

  const popupVideoPage = await openFixture(context, 'https://www.bilibili.com/video/BVpopup-fixture', videoFixture);
  await popupVideoPage.evaluate(() => window.__fixture.start());
  await waitFor(popupVideoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await popupVideoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  const popupLauncher = await context.newPage();
  await popupLauncher.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  await popupVideoPage.bringToFront();
  const videoLogsPagePromise = context.waitForEvent('page', {
    predicate: (page) => page.url().includes('/logs.html'),
  });
  const popupPage = await createBackgroundExtensionPage(
    context,
    popupLauncher,
    `chrome-extension://${extensionId}/popup.html?e2e-open-logs`,
  );
  const videoLogsPage = await videoLogsPagePromise;
  await videoLogsPage.waitForLoadState('domcontentloaded');
  assert.equal(await popupPage.evaluate(() => window.__e2ePopupLogsClicked), true);
  assert.equal(await popupPage.locator('[data-open-logs]').count(), 1);
  assert.equal(await popupPage.locator('[data-mode-only="video"]:visible').count(), 1);
  assert.equal(await popupPage.locator('[data-mode-only="live"]:visible').count(), 0);
  assert.equal(await popupPage.locator('[data-live-only="true"]:visible').count(), 0);
  assert.deepEqual(
    await popupPage.locator('[data-status-field]:visible').evaluateAll((elements) =>
      elements.map((element) => element.dataset.statusField)),
    ['mode', 'state', 'buffered', 'target', 'error'],
  );
  const videoSessionId = (await readStoredEvents(context, extensionId)).events
    .find((event) => event.code === 'route.session_started' && event.data?.pathname === '/video/BVpopup-fixture')?.sessionId;
  assert.equal(typeof videoSessionId, 'string');
  assert.equal(
    videoLogsPage.url(),
    `chrome-extension://${extensionId}/logs.html#sessionId=${encodeURIComponent(videoSessionId)}`,
  );
  await videoLogsPage.close();
  await popupPage.close();

  await livePage.bringToFront();
  const livePopupPage = await createBackgroundExtensionPage(
    context,
    popupLauncher,
    `chrome-extension://${extensionId}/popup.html`,
  );
  await waitFor(livePopupPage, () => document.querySelector('[data-status-field="mode"]').textContent === '直播');
  assert.equal(await livePopupPage.locator('[data-mode-only="live"]:visible').count(), 1);
  assert.equal(await livePopupPage.locator('[data-mode-only="video"]:visible').count(), 0);
  assert.equal(await livePopupPage.locator('[data-video-only="true"]:visible').count(), 0);
  await livePopupPage.close();
  await popupLauncher.close();
  await popupVideoPage.close();
  markScenario('video/live popup mode boundaries and video session log URL');

  const currentExport = await createExportPage(context, extensionId, `#sessionId=${encodeURIComponent(videoSessionId)}`);
  await clickExport(currentExport);
  await currentExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(currentExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const currentExportState = await currentExport.evaluate(() => ({ ...window.__exportState }));
  assert.equal(currentExportState.closed, true);
  assert.equal(currentExportState.aborted, false);
  assert.equal(currentExportState.maxInFlight, 1);
  assert.ok(currentExportState.lines.every((line) => line.endsWith('\n')));
  assert.ok(currentExportState.lines.every((line) => JSON.parse(line).sessionId === videoSessionId));
  await currentExport.close();
  markScenario('日志 current snapshot export is paged and line-awaited');

  const snapshotExport = await createExportPage(context, extensionId, '');
  await clickExport(snapshotExport);
  await waitFor(snapshotExport, () => window.__exportState.writes >= 1);
  const endedCountBefore = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'media.ended').length;
  await livePage.evaluate(() => window.__fixture.triggerUniqueMediaEvent());
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'media.ended').length > endedCountBefore,
  );
  await snapshotExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(snapshotExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const snapshotLines = await snapshotExport.evaluate(() => window.__exportState.lines.map((line) => JSON.parse(line)));
  assert.equal(snapshotLines.some((record) => record.code === 'media.ended'), false);
  await snapshotExport.close();
  markScenario('日志 all export fixes eventId cutoff and excludes new events');

  const cancelledExport = await createExportPage(context, extensionId, '', { cancel: true });
  await clickExport(cancelledExport);
  await waitFor(cancelledExport, () => document.querySelector('[data-status]').textContent.includes('导出已取消'));
  await cancelledExport.close();
  markScenario('日志 export user cancellation');

  const failedExport = await createExportPage(context, extensionId, '', { failAt: 1 });
  await clickExport(failedExport);
  await failedExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(failedExport, () => document.querySelector('[data-status]').textContent.includes('导出失败'));
  assert.equal(await failedExport.evaluate(() => window.__exportState.aborted), true);
  await failedExport.close();
  markScenario('日志 writer failure aborts the file');

  await livePage.close();
  await context.close();
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  extensionId = await extensionIdFor(context);
  stored = await readStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'route.session_started'));
  assert.ok(stored.events.some((event) => event.code === 'live.stall.recovered'));
  markScenario('extension worker/browser restart reads persisted IndexedDB logs');

  console.log(`browser e2e passed: ${scenarios.length} deterministic scenes`);
  for (const scenario of scenarios) console.log(`- ${scenario}`);
} finally {
  await livePage?.close().catch(() => {});
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}
