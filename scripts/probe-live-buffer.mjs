import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'probe-live-buffer-report.json');
const recordSeconds = 60;
const liveCandidates = [
  'https://live.bilibili.com/all',
];

async function findLiveRoomFromList(page) {
  await page.waitForTimeout(5000);
  const links = await page.evaluate(() => {
    const all = [...document.querySelectorAll('a[href]')];
    return all
      .filter((a) => /live\.bilibili\.com\/\d+/.test(a.href))
      .map((a) => a.href)
      .filter((href, index, arr) => arr.indexOf(href) === index)
      .slice(0, 10);
  });
  return links;
}

const probeInit = () => {
  const records = [];
  const start = performance.now();
  const log = (type, data) => records.push({
    t: Math.round((performance.now() - start) * 10) / 10,
    type,
    ...(data || {}),
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
      currentTime: Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) / 1000 : null,
      paused: v.paused,
      readyState: v.readyState,
      bufferedRangeCount: v.buffered.length,
      bufferedTotal: Math.round(buffered.reduce((s, r) => s + (r[1] - r[0]), 0) * 1000) / 1000,
      bufferedRanges: buffered.map((r) => [Math.round(r[0] * 1000) / 1000, Math.round(r[1] * 1000) / 1000]),
      seekableEnd: seekable.length ? Math.round(seekable[seekable.length - 1][1] * 1000) / 1000 : null,
      delay: seekable.length && Number.isFinite(v.currentTime)
        ? Math.round((seekable[seekable.length - 1][1] - v.currentTime) * 1000) / 1000
        : null,
    };
  };

  log('meta', {
    hasShim: !!window.__smoothBufferShim,
    shimInstalled: window.__smoothBufferShim?.installed,
    shimRetainSeconds: window.__smoothBufferShim?.retainSeconds,
    shimStats: window.__smoothBufferShim ? { ...window.__smoothBufferShim.stats } : null,
    hasSourceBuffer: typeof SourceBuffer !== 'undefined',
    removeIsNative: typeof SourceBuffer !== 'undefined'
      ? SourceBuffer.prototype.remove.toString().includes('[native code]')
      : null,
    hasManagedMediaSource: typeof ManagedMediaSource !== 'undefined',
  });

  let removeHooked = false;
  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.remove) {
    const orig = SourceBuffer.prototype.remove;
    SourceBuffer.prototype.remove = function (s, e) {
      const v = snapshotVideo();
      log('remove', { start: s, end: e, range: Math.round((e - s) * 1000) / 1000, ...v });
      return orig.call(this, s, e);
    };
    removeHooked = true;
  }
  let appendHooked = false;
  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.appendBuffer) {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (...args) {
      log('appendBuffer', { byteLength: args[0]?.byteLength || args[0]?.size || null });
      return origAppend.call(this, ...args);
    };
    appendHooked = true;
  }
  let msAddHooked = false;
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
    msAddHooked = true;
  }

  const ticker = setInterval(() => log('tick', snapshotVideo()), 2000);
  setTimeout(() => {
    clearInterval(ticker);
    const finalShim = window.__smoothBufferShim ? { ...window.__smoothBufferShim.stats } : null;
    log('final', { removeHooked, appendHooked, msAddHooked, shimStats: finalShim });
    window.__probeRecords = records;
  }, 60500);

  window.__probeReady = true;
};

const report = {
  generatedAt: new Date().toISOString(),
  recordSeconds,
  candidate: null,
  browserStarted: false,
  pageStarted: false,
  videoDetected: false,
  probeCompleted: false,
  records: [],
  error: null,
};

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-probe-live-'));
let context;
try {
  const chromeExe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: chromeExe,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--mute-audio',
      '--no-first-run',
    ],
  });
  await installUnpackedExtension(context.browser(), extensionDirectory);
  report.browserStarted = true;

  const browser = context;
  let livePage = null;
  let usedCandidate = null;
  const listPage = await browser.newPage();
  await listPage.goto('https://live.bilibili.com/all', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const roomLinks = await findLiveRoomFromList(listPage);
  await listPage.close();
  console.log(`probe: found ${roomLinks.length} live rooms`);
  for (const candidate of roomLinks.slice(0, 15)) {
    livePage = await browser.newPage();
    try {
      livePage.on('pageerror', (error) => console.error(`[probe pageerror] ${error.message}`));
      console.log(`probe: trying ${candidate}`);
      await livePage.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await livePage.waitForFunction(() => {
          const videos = [...document.querySelectorAll('video')];
          for (const iframe of document.querySelectorAll('iframe')) {
            try {
              const doc = iframe.contentDocument;
              if (doc) videos.push(...doc.querySelectorAll('video'));
            } catch {}
          }
          return videos.some((v) => v.readyState >= 2 && !v.paused);
        }, { timeout: 40000 });
        usedCandidate = candidate;
        report.candidate = candidate;
        report.pageStarted = true;
        break;
      } catch {
        console.log(`probe: no playing video at ${candidate}`);
        await livePage.close();
        livePage = null;
      }
    } catch (error) {
      await livePage?.close().catch(() => {});
      livePage = null;
    }
  }
  if (livePage === null) throw new Error('所有候选直播间均无可用 video 元素');

  const blancFrame = await livePage.waitForFunction(() => {
    const iframe = document.querySelector('iframe[src*="blanc"]');
    return iframe !== null && iframe.contentWindow !== null;
  }, { timeout: 10000 }).then(() => 
    livePage.frames().find((f) => f.url().includes('blanc'))
  ).catch(() => livePage.mainFrame());
  
  console.log('probe: using frame', blancFrame.url().slice(0, 60));
  const preCheck = await blancFrame.evaluate(() => ({
    hasShim: !!window.__smoothBufferShim,
    removeStr: SourceBuffer?.prototype?.remove?.toString()?.slice(0, 80),
    location: location.href.slice(0, 80),
    hasController: !!document.documentElement?.dataset?.bilibiliBufferExtensionRuntimeId,
  }));
  console.log('probe pre-check:', JSON.stringify(preCheck));
  await blancFrame.evaluate((initSource) => eval(initSource), `(${probeInit.toString()})()`);
  await blancFrame.waitForFunction(() => window.__probeReady === true, { timeout: 5000 });
  report.videoDetected = true;

  await livePage.waitForTimeout(63000);
  report.records = await blancFrame.evaluate(() => window.__probeRecords || []);
  report.probeCompleted = true;
  await livePage.close();
} catch (error) {
  report.error = String(error?.message || error);
} finally {
  await context?.close().catch(() => {});
  await fs.rm(profileDirectory, { recursive: true, force: true }).catch(() => {});
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`probe report written to ${reportPath}: ${report.records.length} records, candidate=${report.candidate}, video=${report.videoDetected}, error=${report.error}`);
