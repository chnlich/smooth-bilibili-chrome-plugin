import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findAvailablePort, resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { readProvenance } from './provenance.mjs';

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

const INVENTORY_VIDEO_URL = 'https://e2e-video.bilivideo.com/e2e/video-active.m4s?signature=video';
const INVENTORY_ADDRESS_BOOK_ONLY_URL = 'https://e2e-video.bilivideo.com/e2e/video-address-book-only.m4s?signature=unused';
const INVENTORY_AUDIO_URL = 'https://e2e-audio.bilivideo.com/e2e/audio-active.m4s?signature=audio';
const INVENTORY_TOTAL_SIZE = 1024 ** 2;
const INVENTORY_VIDEO_PATH = new URL(INVENTORY_VIDEO_URL).pathname;
const INVENTORY_ADDRESS_BOOK_ONLY_PATH = new URL(INVENTORY_ADDRESS_BOOK_ONLY_URL).pathname;
const INVENTORY_AUDIO_PATH = new URL(INVENTORY_AUDIO_URL).pathname;
const INVENTORY_PLAYURL_BODY = {
  code: 0,
  data: {
    dash: {
      video: [
        {
          id: 64,
          baseUrl: INVENTORY_VIDEO_URL,
          backupUrl: [],
          mimeType: 'video/mp4',
          codecs: 'avc1.640028',
          height: 720,
          bandwidth: 1000000,
        },
        {
          id: 32,
          baseUrl: INVENTORY_ADDRESS_BOOK_ONLY_URL,
          backupUrl: [],
          mimeType: 'video/mp4',
          codecs: 'avc1.4d401f',
          height: 480,
          bandwidth: 500000,
        },
      ],
      audio: [{
        id: 30280,
        baseUrl: INVENTORY_AUDIO_URL,
        backupUrl: [],
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
        bandwidth: 128000,
      }],
    },
  },
};
const INVENTORY_ADVERTISED_REPRESENTATION_COUNT = 3;

const videoFixture = `<!doctype html><html><body><div id="stage"></div><script>
  const stage = document.querySelector('#stage');
  const video = document.createElement('video');
  video.id = 'media';
  video.width = 320;
  video.height = 180;
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
  const readoutMediaSource = new MediaSource();
  const readoutMediaSourceUrl = URL.createObjectURL(readoutMediaSource);
  const readoutVideo = document.createElement('video');
  readoutVideo.id = 'readout-media';
  readoutVideo.width = 1;
  readoutVideo.height = 1;
  readoutVideo.muted = true;
  readoutVideo.volume = 0;
  stage.append(readoutVideo);
  let readoutSourceBuffer;
  readoutMediaSource.addEventListener('sourceopen', () => {
    const mimeType = 'audio/mp4; codecs="mp4a.40.2"';
    if (MediaSource.isTypeSupported(mimeType)) readoutSourceBuffer = readoutMediaSource.addSourceBuffer(mimeType);
  });
  readoutVideo.src = readoutMediaSourceUrl;
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
    activateReadoutVideo() {
      readoutVideo.width = 321;
      readoutVideo.height = 181;
      readoutSourceBuffer.dispatchEvent(new Event('updateend'));
    },
    triggerUniqueMediaEvent() {
      const selected = readoutVideo.width * readoutVideo.height > video.width * video.height
        ? readoutVideo
        : video;
      selected.dispatchEvent(new Event('ended'));
    },
    async populateBankInventory() {
      const playurlResponse = await fetch('https://api.bilibili.com/x/player/playurl?e2e=inventory');
      if (!playurlResponse.ok) throw new Error('inventory playurl fixture request failed');
      const playurl = await playurlResponse.json();
      const advertised = [
        ...playurl.data.dash.video,
        ...playurl.data.dash.audio,
      ].map((representation) => new URL(representation.baseUrl).pathname);
      for (const url of [
        playurl.data.dash.video[0].baseUrl,
        playurl.data.dash.audio[0].baseUrl,
      ]) {
        const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        if (!response.ok) throw new Error('inventory segment fixture request failed');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== 16) throw new Error('inventory segment fixture length mismatch');
      }
      return {
        advertised,
        requested: [
          new URL(playurl.data.dash.video[0].baseUrl).pathname,
          new URL(playurl.data.dash.audio[0].baseUrl).pathname,
        ],
      };
    },
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

async function openFixture(context, url, html, requestHandler) {
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    if (route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (requestHandler !== undefined) {
      await requestHandler(route);
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

const inventoryCorsHeaders = {
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
};

async function inventoryRequestHandler(route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: inventoryCorsHeaders, body: '' });
    return;
  }
  if (requestUrl.hostname === 'api.bilibili.com' && requestUrl.pathname.endsWith('/playurl')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: inventoryCorsHeaders,
      body: JSON.stringify(INVENTORY_PLAYURL_BODY),
    });
    return;
  }
  if (requestUrl.hostname.endsWith('.bilivideo.com')
    && [INVENTORY_VIDEO_PATH, INVENTORY_ADDRESS_BOOK_ONLY_PATH, INVENTORY_AUDIO_PATH]
      .includes(requestUrl.pathname)) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range || '');
    assert.ok(match, `inventory segment request has no closed range: ${request.url()}`);
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    if (start >= INVENTORY_TOTAL_SIZE) {
      await route.fulfill({ status: 416, headers: inventoryCorsHeaders, body: '' });
      return;
    }
    const end = Math.min(requestedEnd, INVENTORY_TOTAL_SIZE - 1);
    const body = Buffer.alloc(end - start + 1, 0x2a);
    await route.fulfill({
      status: 206,
      headers: {
        ...inventoryCorsHeaders,
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${end}/${INVENTORY_TOTAL_SIZE}`,
        'Content-Type': 'video/mp4',
      },
      body,
    });
    return;
  }
  await route.fulfill({ status: 204, body: '' });
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

async function extensionTabSend(page, message) {
  return page.evaluate((request) => new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError !== undefined) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) {
        reject(new Error('active video tab is unavailable'));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, request, (response) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }), message);
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

const chromeExecutablePath = await resolveChromeExecutablePath();
const cdpPort = await findAvailablePort();
const provenance = await readProvenance({ rootDirectory: root, extensionDirectory });
const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-e2e-profile-'));
const scenarios = [];
const markScenario = (name) => {
  scenarios.push(name);
  console.log('SCENARIO', name);
};
let context;
let extensionId;
let consoleCapture;
try {
  const launch = (profile) => chromium.launchPersistentContext(profile, {
    executablePath: chromeExecutablePath,
    cdpPort,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--mute-audio',
      '--enable-unsafe-extension-debugging',
    ],
  });
  context = await launch(profileDirectory);
  const browserVersion = context.browser().version();
  console.log(`browser e2e provenance: ${JSON.stringify({
    commitSha: process.env.BILIBILI_E2E_COMMIT_SHA ?? provenance.commitSha,
    buildId: provenance.buildId,
    profileDirectory,
    browserVersion,
  })}`);
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(cdpPort, extensionId);
  await triggerExtensionPositiveControl(context, extensionId, consoleCapture);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  await context.addInitScript({ content: `(${autoOpenPopupLogs.toString()})()` });

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

  const popupVideoPage = await openFixture(
    context,
    'https://www.bilibili.com/video/BVpopup-fixture',
    videoFixture,
    inventoryRequestHandler,
  );
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
  assert.equal(await popupPage.locator('[data-preference="vodEnabled"]:visible').count(), 1);
  assert.deepEqual(
    await popupPage.locator('[data-status-field]:visible').evaluateAll((elements) =>
      elements.map((element) => element.dataset.statusField)),
    ['mode', 'state', 'buffered', 'target', 'effective', 'error'],
  );
  const videoSessionId = (await readStoredEvents(context, extensionId)).events
    .find((event) => event.code === 'route.session_started' && event.data?.pathname === '/video/BVpopup-fixture')?.sessionId;
  assert.equal(typeof videoSessionId, 'string');
  const inventoryFixture = await popupVideoPage.evaluate(() => window.__fixture.populateBankInventory());
  assert.equal(inventoryFixture.advertised.length, INVENTORY_ADVERTISED_REPRESENTATION_COUNT);
  assert.deepEqual(inventoryFixture.requested.sort(), [INVENTORY_AUDIO_PATH, INVENTORY_VIDEO_PATH].sort());
  const inventoryEvents = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'bank.inventory'
      && event.sessionId === videoSessionId
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH
        && resource.kind === 'video'
        && resource.active === true)
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH
        && resource.kind === 'audio'
        && resource.active === true)
      && !event.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH)),
  );
  const inventoryEvent = inventoryEvents.events.find(
    (event) => event.code === 'bank.inventory'
      && event.sessionId === videoSessionId
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH
        && resource.kind === 'video'
        && resource.active === true)
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH
        && resource.kind === 'audio'
        && resource.active === true)
      && !event.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH),
  );
  assert.equal(typeof inventoryEvent.data.sessionGeneration, 'number');
  assert.equal(Array.isArray(inventoryEvent.data.resources), true);
  assert.equal(inventoryEvent.data.resources.length, 2);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH), true);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH), true);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH), false);
  const cdnSummary = await extensionSend(popupLauncher, {
    version: 1,
    type: 'logs:cdn-summary',
    sessionId: videoSessionId,
  });
  assert.equal(cdnSummary.ok, true);
  assert.equal(cdnSummary.sampleCount > 0, true);
  assert.equal(cdnSummary.maxEventId >= inventoryEvent.eventId, true);
  assert.deepEqual(Object.keys(cdnSummary.summary.byResult).sort(), [
    'aborted',
    'fetched',
    'gave_up',
    'http_error',
    'invalid_response',
    'lost_race',
    'network_error',
    'stalled',
    'superseded',
  ]);
  await popupVideoPage.evaluate(() => window.__fixture.activateReadoutVideo());
  await waitFor(popupVideoPage, () => {
    const raw = document.documentElement.getAttribute('data-bilibili-buffer-shim-diagnostics');
    return raw !== null && JSON.parse(raw).sourceBufferRanges.some((track) => track.attached === true);
  });
  await popupVideoPage.bringToFront();
  const readouts = await extensionTabSend(popupLauncher, {
    version: 2,
    type: 'readouts:get',
  });
  assert.equal(readouts.version, 2);
  assert.equal(readouts.diagnostics.sessionId, videoSessionId);
  assert.equal(Array.isArray(readouts.media.tracks), true);
  assert.equal(readouts.media.tracks.length > 0, true);
  assert.equal(readouts.media.tracks.every((track) => track.attached === true), true);
  assert.doesNotMatch(JSON.stringify(readouts), /blob:|[?#]/);
  assert.equal(
    videoLogsPage.url(),
    `chrome-extension://${extensionId}/logs.html#sessionId=${encodeURIComponent(videoSessionId)}`,
  );
  await videoLogsPage.close();
  await popupPage.close();
  await popupLauncher.close();
  markScenario('video popup and video session log URL');

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
  await popupVideoPage.evaluate(() => window.__fixture.triggerUniqueMediaEvent());
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

  const exportedEvents = (await readStoredEvents(context, extensionId)).events;
  const eventCounts = Object.fromEntries(
    [...new Set(exportedEvents.map((event) => event.code))]
      .sort()
      .map((code) => [code, exportedEvents.filter((event) => event.code === code).length]),
  );
  const reportDirectory = path.join(root, 'reports');
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(
    path.join(reportDirectory, 'browser-e2e-events.jsonl'),
    `${exportedEvents.map((event) => JSON.stringify({ recordType: 'event', ...event })).join('\n')}\n`,
    'utf8',
  );
  console.log(`browser e2e event counts: ${JSON.stringify(eventCounts)}`);
  const measuredInventoryEvents = exportedEvents.filter((event) =>
    event.code === 'bank.inventory' && event.sessionId === videoSessionId);
  assert.ok(measuredInventoryEvents.length > 0);
  const averageInventoryLineBytes = measuredInventoryEvents.reduce((total, event) => total
    + Buffer.byteLength(`${JSON.stringify({ recordType: 'event', ...event })}\n`, 'utf8'), 0)
    / measuredInventoryEvents.length;
  const measuredInventoryEvent = measuredInventoryEvents.find((event) =>
    event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH)
    && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH));
  assert.ok(measuredInventoryEvent);
  console.log(`bank.inventory volume: run=browser-e2e popupVideoPage session=${videoSessionId}`
    + ` averageUtf8JsonlBytes=${averageInventoryLineBytes}`
    + ` advertisedRepresentations=${INVENTORY_ADVERTISED_REPRESENTATION_COUNT}`
    + ` admittedResources=${measuredInventoryEvent.data.resources.length}`);

  await popupVideoPage.close();
  const consoleVerdict = consoleCapture.verdict();
  const extensionConsoleErrors = consoleCapture.events.filter((event) =>
    event.kind === 'console'
    && event.level === 'error'
    && event.source === 'extension'
    && event.positiveControl !== true);
  const expectedConsoleErrors = extensionConsoleErrors.filter((event) =>
    event.text.includes('AbortError: user cancelled')
    || event.text.includes('synthetic writer failure'));
  const unexpectedConsoleErrors = extensionConsoleErrors.filter(
    (event) => !expectedConsoleErrors.includes(event),
  );
  assert.equal(consoleVerdict.positiveControlCaptured, true, JSON.stringify(consoleVerdict));
  assert.deepEqual(unexpectedConsoleErrors, [], JSON.stringify({ consoleVerdict, unexpectedConsoleErrors }));
  console.log(`browser e2e console classification: ${JSON.stringify({
    consoleVerdict,
    expectedConsoleErrors: expectedConsoleErrors.map(({ text, targetUrl }) => ({ text, targetUrl })),
    unexpectedConsoleErrors,
  })}`);
  await consoleCapture.close();
  consoleCapture = undefined;
  await context.close();
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  const stored = await readStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'route.session_started'));
  markScenario('extension worker/browser restart reads persisted IndexedDB logs');

  console.log(`browser e2e passed: ${scenarios.length} deterministic scenes`);
  for (const scenario of scenarios) console.log(`- ${scenario}`);
} finally {
  await consoleCapture?.close();
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}
