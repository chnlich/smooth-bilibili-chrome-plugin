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
  <input id="timeline" data-seek type="range" min="0" max="240" step="1" value="0">
  <button id="quality" type="button">quality</button>
  <input id="volume" type="range" aria-label="volume" min="0" max="1" step="0.1" value="0">
  <script>
    const stage = document.querySelector('#stage');
    const timeline = document.querySelector('#timeline');
    const volume = document.querySelector('#volume');
    let video;
    let clipUrls;
    let mediaSources;
    let decodedFrames = 0;
    let decodedNonBlack = false;
    let initialDelay = 0;
    let recoveredDelay = 0;
    let initialClipIndex = 0;

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

    async function setSource(nextVideo, url, position) {
      const metadata = new Promise((resolve, reject) => {
        nextVideo.addEventListener('loadedmetadata', resolve, { once: true });
        nextVideo.addEventListener('error', () => reject(nextVideo.error || new Error('fixture media metadata failed')), { once: true });
      });
      await window.__e2eAudit.fixtureCall('set:src', () => {
        nextVideo.src = url;
        nextVideo.load();
      });
      await metadata;
      const target = Math.max(0.1, Math.min(position, nextVideo.duration - 0.1));
      await window.__e2eAudit.fixtureCall('set:currentTime', () => { nextVideo.currentTime = target; });
      timeline.max = String(nextVideo.duration);
      return target;
    }

    async function boot() {
      const recordedClips = await Promise.all([
        recordClip(2200, '#f05a28'),
        recordClip(4200, '#18b66a'),
        recordClip(6200, '#5b6ee1'),
      ]);
      const sourceRecords = recordedClips.map(createMediaSourceUrl);
      clipUrls = sourceRecords.map(({ url }) => url);
      mediaSources = sourceRecords.map(({ mediaSource }) => mediaSource);
      initialClipIndex = location.pathname.includes('input-fixture') ? 2 : 0;
      video = document.createElement('video');
      video.id = 'media';
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = true;
      video.volume = 0;
      stage.append(video);
      trackDecoded(video);
      await setSource(video, clipUrls[initialClipIndex], 0.6);
    }

    const ready = boot();
    timeline.addEventListener('input', () => {
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
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      },
      decodedFrames() { return decodedFrames; },
      decodedNonBlack() { return decodedNonBlack; },
      async beginStall() {
        initialDelay = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        video.dispatchEvent(new Event('waiting'));
        await window.__e2eAudit.fixtureCall('pause', () => video.pause());
      },
      async beginProtectedSeek() {
        const target = Math.max(0.1, video.duration - 1.2);
        await window.__e2eAudit.fixtureCall('set:currentTime', () => { video.currentTime = target; });
        await window.__e2eAudit.fixtureCall('play', () => video.play());
        video.dispatchEvent(new Event('waiting'));
        await sleep(50);
        return { target, currentTime: video.currentTime, paused: video.paused, readyState: video.readyState };
      },
      async recoverWithDelay() {
        const currentEnd = video.seekable.end(video.seekable.length - 1);
        mediaSources[initialClipIndex].duration = currentEnd + 2;
        await sleep(200);
        await window.__e2eAudit.fixtureCall('play', () => video.play());
        await sleep(200);
        recoveredDelay = video.seekable.end(video.seekable.length - 1) - video.currentTime;
      },
      delays() {
        return {
          initialDelay,
          recoveredDelay,
          duration: video.duration,
          seekableEnd: video.seekable.length === 0 ? null : video.seekable.end(video.seekable.length - 1),
          currentTime: video.currentTime,
        };
      },
      async setLogicalPosition() {
        const target = Math.max(0.1, video.duration - 0.6);
        await window.__e2eAudit.fixtureCall('set:currentTime', () => { video.currentTime = target; });
        await sleep(100);
      },
      async clearSource() {
        await window.__e2eAudit.fixtureCall('clear:src', () => {
          video.src = '';
          video.load();
        });
      },
      async scriptSeek(time) {
        const target = Math.max(0.1, Math.min(time, video.duration - 0.05));
        await window.__e2eAudit.fixtureCall('script-currentTime', () => { video.currentTime = target; });
        await sleep(100);
      },
      async sourceReplace() {
        await setSource(video, clipUrls[2], 0.1);
        await window.__e2eAudit.fixtureCall('set:currentTime', () => {
          video.currentTime = Math.max(0.1, video.duration - 0.2);
        });
      },
      async resumeCurrent() { await window.__e2eAudit.fixtureCall('play', () => video.play()); },
      async replaceVideo() {
        await window.__e2eAudit.fixtureCall('video-remove', () => video.remove());
        const replacement = document.createElement('video');
        replacement.id = 'media';
        replacement.preload = 'auto';
        replacement.playsInline = true;
        replacement.muted = true;
        replacement.volume = 0;
        stage.append(replacement);
        trackDecoded(replacement);
        video = replacement;
      },
      async playReplacement() {
        await setSource(video, clipUrls[1], 0.1);
        await window.__e2eAudit.fixtureCall('play', () => video.play());
      },
      async triggerUniqueMediaEvent() { video.dispatchEvent(new Event('ended')); },
      assignments() { return video.currentTime; },
    };
    window.__e2eAudit.reset();
  </script></body></html>`;

async function waitFor(page, predicate, timeout = 15000) {
  await page.waitForFunction(predicate, undefined, { timeout });
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

async function clickExport(page) {
  await page.locator('[data-export]').click();
}

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-e2e-profile-'));
const scenarios = [];
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
  extensionId = await extensionIdFor(context);

  const videoPage = await openFixture(context, 'https://www.bilibili.com/video/BVfixture', videoFixture);
  await videoPage.evaluate(() => window.__fixture.start());
  await waitFor(videoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await videoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  await waitFor(videoPage, () => window.__fixture.calls.length === 1);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120]);
  assert.deepEqual(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  scenarios.push('真实无音轨视频解码与 120 秒缓存');

  await videoPage.evaluate(() => window.__fixture.replace());
  await waitFor(videoPage, () => window.__fixture.calls.length === 2);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120, 120]);
  assert.deepEqual(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  scenarios.push('视频 source/core generation replacement');
  await videoPage.close();

  const watchLaterPage = await openFixture(context, 'https://www.bilibili.com/list/watchlater/item-1', videoFixture);
  await watchLaterPage.evaluate(() => window.__fixture.start());
  await waitFor(watchLaterPage, () => window.__fixture.calls.length === 1 && window.__fixture.decodedFrames() > 0);
  await watchLaterPage.close();
  scenarios.push('Watch Later item route');

  const unrelatedPage = await openFixture(context, 'https://www.bilibili.com/search?keyword=fixture', videoFixture);
  await unrelatedPage.waitForTimeout(1000);
  assert.deepEqual(await unrelatedPage.evaluate(() => window.__fixture.calls), []);
  await unrelatedPage.close();
  scenarios.push('unrelated route remains untouched');

  livePage = await openFixture(context, 'https://live.bilibili.com/fixture', liveFixture);
  await livePage.evaluate(() => window.__fixture.start());
  await waitFor(livePage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  scenarios.push('真实无音轨直播帧解码');

  await livePage.evaluate(() => window.__fixture.beginStall());
  await livePage.waitForTimeout(150);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  await livePage.evaluate(() => window.__fixture.recoverWithDelay());
  await waitFor(livePage, () => window.__fixture.decodedFrames() > 2);
  let stored = await readStoredEvents(context, extensionId);
  const recovered = stored.events.find((event) => event.code === 'live.stall.recovered');
  assert.ok(recovered);
  const liveDelays = await livePage.evaluate(() => window.__fixture.delays());
  assert.ok(liveDelays.recoveredDelay > liveDelays.initialDelay + 1);
  assert.ok(recovered.data.protectedDelay >= liveDelays.initialDelay - 0.5);
  const delayObservation = stored.events
    .filter((event) => event.code === 'live.delay.observed')
    .at(-1);
  assert.ok(delayObservation);
  assert.ok(Math.abs(delayObservation.data.protectedDelay - liveDelays.recoveredDelay) <= 0.5);
  scenarios.push('直播 D+T 延迟观察、保护与真实恢复帧');

  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.evaluate(() => window.__fixture.clearSource());
  await livePage.waitForTimeout(500);
  assert.ok(await livePage.locator('#stage canvas[aria-hidden="true"]').count() >= 1);
  const sourceOverlayPixel = await livePage.locator('#stage canvas[aria-hidden="true"]').first().evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { color: pixels[0] + pixels[1] + pixels[2], pointerEvents: canvas.style.pointerEvents };
  });
  assert.ok(sourceOverlayPixel.color > 12);
  assert.equal(sourceOverlayPixel.pointerEvents, 'none');
  await livePage.evaluate(() => window.__fixture.sourceReplace());
  await livePage.evaluate(() => window.__fixture.resumeCurrent());
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'live.delay.corrected' && event.data.reason === 'source_replaced'),
  );
  scenarios.push('active-stall source clear/replacement overlay and target delay');

  await livePage.evaluate(() => window.__fixture.replaceVideo());
  await livePage.waitForTimeout(700);
  const replacementOverlay = livePage.locator('#stage canvas[aria-hidden="true"]');
  assert.ok(await replacementOverlay.count() >= 1);
  const replacementPixel = await replacementOverlay.first().evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { color: pixels[0] + pixels[1] + pixels[2], pointerEvents: canvas.style.pointerEvents };
  });
  assert.ok(replacementPixel.color > 12);
  assert.equal(replacementPixel.pointerEvents, 'none');
  await livePage.evaluate(() => window.__fixture.playReplacement());
  await waitFor(livePage, () => document.querySelector('#stage canvas[aria-hidden="true"]') === null);
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  scenarios.push('active-stall video replacement overlay is non-black and retracts on first frame');

  await livePage.close();
  livePage = await openFixture(context, 'https://live.bilibili.com/input-fixture', liveFixture);
  const freshLoadedDataCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'media.loadeddata').length;
  await livePage.evaluate(() => window.__fixture.start());
  await waitFor(livePage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await livePage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  scenarios.push('fresh live input fixture');

  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'media.loadeddata').length > freshLoadedDataCount,
  );
  await livePage.waitForTimeout(500);
  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.evaluate(() => window.__fixture.beginProtectedSeek());
  await livePage.locator('#timeline').focus();
  const mouseCorrectionCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length;
  const timelineBox = await livePage.locator('#timeline').boundingBox();
  await livePage.mouse.click(timelineBox.x + timelineBox.width * 0.45, timelineBox.y + timelineBox.height / 2);
  await waitFor(livePage, () => window.__fixture.assignments() > 0.2);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  await livePage.waitForTimeout(500);
  assert.equal(
    (await readStoredEvents(context, extensionId)).events
      .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length,
    mouseCorrectionCount,
  );
  scenarios.push('真实鼠标 timeline seek cancels protection');

  await livePage.waitForTimeout(250);
  const qualityStallCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  await livePage.evaluate(() => window.__fixture.beginProtectedSeek());
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > qualityStallCount,
  );
  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.locator('#timeline').focus();
  await livePage.keyboard.press('End');
  await waitFor(livePage, () => window.__fixture.assignments() > 0.2);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.extensionOwnership()), []);
  scenarios.push('真实键盘 seek key cancels protection');

  await livePage.waitForTimeout(250);
  const negativeStallCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.stall.detected').length;
  await livePage.evaluate(() => window.__fixture.beginProtectedSeek());
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.stall.detected').length > negativeStallCount,
  );
  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.locator('#quality').click();
  await livePage.locator('#volume').click();
  await livePage.locator('#media').click();
  const qualityCorrectionCount = (await readStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length;
  await livePage.evaluate(() => window.__fixture.scriptSeek(110));
  stored = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length
      > qualityCorrectionCount,
  );
  const automaticCorrection = stored.events
    .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek')
    .at(-1);
  assert.ok(automaticCorrection.data.targetTime < automaticCorrection.data.currentTime);
  scenarios.push('quality/volume/video clicks do not authorize script seek');

  await livePage.evaluate(() => window.__e2eAudit.reset());
  await livePage.locator('#volume').focus();
  await livePage.keyboard.press('ArrowRight');
  const keyCorrectionCount = stored.events
    .filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length;
  await livePage.evaluate(() => window.__fixture.scriptSeek(110));
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'live.delay.corrected' && event.data.reason === 'automatic_forward_seek').length
      > keyCorrectionCount,
  );
  scenarios.push('unrelated keyboard input does not authorize script seek');

  stored = await readStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'live.delay.corrected'));
  assert.ok(stored.events.some((event) => event.code === 'media.volumechange' && event.data.eventType === 'volumechange'));
  const sessionId = stored.events.find((event) => event.code === 'live.stall.detected')?.sessionId;
  assert.equal(typeof sessionId, 'string');
  scenarios.push('IndexedDB live/media log facts');

  const popupVideoPage = await openFixture(context, 'https://www.bilibili.com/video/BVpopup-fixture', videoFixture);
  await popupVideoPage.evaluate(() => window.__fixture.start());
  await waitFor(popupVideoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await popupVideoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popupVideoPage.bringToFront();
  await waitFor(popupPage, () => document.querySelector('[data-open-logs]') !== null);
  await waitFor(popupPage, () => document.querySelector('[data-status-field="mode"]').textContent === '视频');
  assert.equal(await popupPage.locator('[data-open-logs]').count(), 1);
  assert.equal(await popupPage.locator('[data-live-only="true"]:visible').count(), 0);
  assert.deepEqual(
    await popupPage.locator('[data-status-field]:visible').evaluateAll((elements) =>
      elements.map((element) => element.dataset.statusField)),
    ['mode', 'state', 'buffered', 'target', 'error'],
  );
  await popupPage.close();
  await popupVideoPage.close();
  scenarios.push('video popup exposes only approved fields and keeps log entry');

  const currentExport = await createExportPage(context, extensionId, `#sessionId=${encodeURIComponent(sessionId)}`);
  await clickExport(currentExport);
  await currentExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(currentExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const currentExportState = await currentExport.evaluate(() => ({ ...window.__exportState }));
  assert.equal(currentExportState.closed, true);
  assert.equal(currentExportState.aborted, false);
  assert.equal(currentExportState.maxInFlight, 1);
  assert.ok(currentExportState.lines.every((line) => line.endsWith('\n')));
  assert.ok(currentExportState.lines.every((line) => JSON.parse(line).sessionId === sessionId));
  await currentExport.close();
  scenarios.push('日志 current snapshot export is paged and line-awaited');

  const snapshotExport = await createExportPage(context, extensionId, '');
  await clickExport(snapshotExport);
  await waitFor(snapshotExport, () => window.__exportState.writes >= 1);
  await livePage.evaluate(() => window.__fixture.triggerUniqueMediaEvent());
  await snapshotExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(snapshotExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const snapshotLines = await snapshotExport.evaluate(() => window.__exportState.lines.map((line) => JSON.parse(line)));
  assert.equal(snapshotLines.some((record) => record.code === 'media.ended'), false);
  await snapshotExport.close();
  scenarios.push('日志 all export fixes eventId cutoff and excludes new events');

  const cancelledExport = await createExportPage(context, extensionId, '', { cancel: true });
  await clickExport(cancelledExport);
  await waitFor(cancelledExport, () => document.querySelector('[data-status]').textContent.includes('导出已取消'));
  await cancelledExport.close();
  scenarios.push('日志 export user cancellation');

  const failedExport = await createExportPage(context, extensionId, '', { failAt: 1 });
  await clickExport(failedExport);
  await failedExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(failedExport, () => document.querySelector('[data-status]').textContent.includes('导出失败'));
  assert.equal(await failedExport.evaluate(() => window.__exportState.aborted), true);
  await failedExport.close();
  scenarios.push('日志 writer failure aborts the file');

  await livePage.close();
  await context.close();
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  extensionId = await extensionIdFor(context);
  stored = await readStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'route.session_started'));
  assert.ok(stored.events.some((event) => event.code === 'live.stall.recovered'));
  scenarios.push('extension worker/browser restart reads persisted IndexedDB logs');

  console.log(`browser e2e passed: ${scenarios.length} deterministic scenes`);
  for (const scenario of scenarios) console.log(`- ${scenario}`);
} finally {
  await livePage?.close().catch(() => {});
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}
