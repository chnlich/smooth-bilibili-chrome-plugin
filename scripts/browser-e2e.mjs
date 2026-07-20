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
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    media.add(element);
    element.muted = true;
    element.volume = 0;
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
  for (const [name, original] of [['play', originalPlay], ['pause', originalPause]]) {
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      writable: true,
      value(...args) {
        ownership.push(name);
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
        ownership.push(`set:${name}`);
        return descriptor.set.call(this, value);
      },
    });
  }
  scan(document);
  window.__e2eAudit = {
    reset() { ownership.length = 0; },
    ownership() { return [...ownership]; },
    silence() { scan(document); return [...media].map((element) => ({ muted: element.muted, volume: element.volume })); },
  };
};

const videoFixture = `<!doctype html><html><body><video id="media"></video><script>
  const video = document.querySelector('#media');
  const source = 'https://media.example/video-1.m4s';
  video.src = source;
  const calls = [];
  let core = { setStableBufferTime(seconds) { calls.push(seconds); } };
  window.player = { __core() { return core; } };
  window.__fixture = {
    calls,
    replace() {
      video.src = 'https://media.example/video-2.m4s';
      core = { setStableBufferTime(seconds) { calls.push(seconds); } };
      window.__e2eAudit.reset();
    },
  };
  window.__e2eAudit.reset();
</script></body></html>`;

const liveFixture = `<!doctype html><html><body><video id="media"></video><input id="seek" type="range" min="0" max="120" step="1" value="10"><script>
  const video = document.querySelector('#media');
  const seek = document.querySelector('#seek');
  let currentTimeValue = 10;
  const currentTimeAssignments = [];
  video.src = 'https://media.example/live-1.m4s';
  Object.defineProperties(video, {
    currentSrc: { configurable: true, value: 'https://media.example/live-1.m4s' },
    currentTime: {
      configurable: true,
      get() { return currentTimeValue; },
      set(value) { currentTimeAssignments.push(value); currentTimeValue = value; },
    },
    paused: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 80 } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 120 } },
    readyState: { configurable: true, value: 4 },
    duration: { configurable: true, value: Infinity },
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 },
  });
  video.play = () => { throw new Error('extension must not call play'); };
  video.pause = () => { throw new Error('extension must not call pause'); };
  seek.addEventListener('input', () => {
    video.currentTime = Number(seek.value);
    video.dispatchEvent(new Event('seeking'));
  });
  window.__fixture = {
    beforeFrameStall() { video.dispatchEvent(new Event('waiting')); },
    firstFrame() { video.dispatchEvent(new Event('loadeddata')); },
    stall() { video.dispatchEvent(new Event('waiting')); },
    currentTimeAssignments() { return [...currentTimeAssignments]; },
    resetAssignments() { currentTimeAssignments.length = 0; },
  };
  window.__e2eAudit.reset();
</script></body></html>`;

async function waitFor(page, predicate, timeout = 10000) {
  await page.waitForFunction(predicate, undefined, { timeout });
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

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-e2e-profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });

  const videoPage = await openFixture(context, 'https://www.bilibili.com/video/BVfixture', videoFixture);
  await waitFor(videoPage, () => window.__fixture?.calls?.length === 1);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120]);
  await videoPage.waitForTimeout(800);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120]);
  assert.deepEqual(await videoPage.evaluate(() => window.__e2eAudit.ownership()), []);
  assert.ok((await videoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  await videoPage.evaluate(() => window.__fixture.replace());
  await waitFor(videoPage, () => window.__fixture?.calls?.length === 2);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120, 120]);
  assert.deepEqual(await videoPage.evaluate(() => window.__e2eAudit.ownership()), []);
  await videoPage.close();

  const watchLaterPage = await openFixture(context, 'https://www.bilibili.com/list/watchlater/item-1', videoFixture);
  await waitFor(watchLaterPage, () => window.__fixture?.calls?.length === 1);
  assert.deepEqual(await watchLaterPage.evaluate(() => window.__fixture.calls), [120]);
  await watchLaterPage.close();

  const unrelatedPage = await openFixture(context, 'https://www.bilibili.com/search?keyword=fixture', videoFixture);
  await unrelatedPage.waitForTimeout(700);
  assert.deepEqual(await unrelatedPage.evaluate(() => window.__fixture.calls), []);
  await unrelatedPage.close();

  const livePage = await openFixture(context, 'https://live.bilibili.com/fixture', liveFixture);
  await livePage.waitForTimeout(700);
  await livePage.evaluate(() => window.__fixture.beforeFrameStall());
  await livePage.waitForTimeout(200);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.ownership()), []);
  await livePage.evaluate(() => window.__fixture.firstFrame());
  await livePage.evaluate(() => window.__fixture.stall());
  await livePage.waitForTimeout(200);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.ownership()), []);
  await livePage.evaluate(() => window.__fixture.resetAssignments());
  const seek = livePage.locator('#seek');
  const seekBox = await seek.boundingBox();
  await livePage.mouse.click(seekBox.x + seekBox.width * 0.75, seekBox.y + seekBox.height / 2);
  await seek.focus();
  await livePage.keyboard.press('ArrowRight');
  await livePage.evaluate(() => window.__fixture.firstFrame());
  assert.equal((await livePage.evaluate(() => window.__fixture.currentTimeAssignments())).length, 2);
  assert.deepEqual(await livePage.evaluate(() => window.__e2eAudit.ownership()), []);
  await livePage.close();

  console.log('browser e2e passed: 5 deterministic scenes (video routes and generation, unrelated route, native live ownership, user seek, muted guard)');
} finally {
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}
