import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';

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
    triggerUniqueMediaEvent() { video.dispatchEvent(new Event('ended')); },
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
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--mute-audio',
      '--enable-unsafe-extension-debugging',
    ],
  });
  context = await launch(profileDirectory);
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(context.browser(), extensionId);
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
  assert.equal(await popupPage.locator('[data-preference="vodEnabled"]:visible').count(), 1);
  assert.deepEqual(
    await popupPage.locator('[data-status-field]:visible').evaluateAll((elements) =>
      elements.map((element) => element.dataset.statusField)),
    ['mode', 'state', 'buffered', 'target', 'effective', 'error'],
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

  await popupVideoPage.close();
  const consoleVerdict = consoleCapture.verdict();
  assert.equal(consoleVerdict.status, 'pass', JSON.stringify(consoleVerdict));
  console.log(`browser e2e console verdict: ${JSON.stringify(consoleVerdict)}`);
  await consoleCapture.close();
  consoleCapture = undefined;
  await context.close();
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
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
