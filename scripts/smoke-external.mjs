import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'external-smoke-report.json');

const mutedInit = () => {
  const observed = new Set();
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    observed.add(element);
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
  scan(document);
  window.__externalAudioAudit = () => {
    scan(document);
    return [...observed].map((element) => ({ muted: element.muted, volume: element.volume }));
  };
};

function mediaFacts() {
  const video = document.querySelector('video');
  if (video === null) return { present: false };
  const read = (ranges) => {
    try {
      return [...Array(ranges.length)].map((_, index) => ({ start: ranges.start(index), end: ranges.end(index) }));
    } catch (error) {
      return '未提供';
    }
  };
  return {
    present: true,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : '未提供',
    paused: video.paused,
    readyState: video.readyState,
    buffered: read(video.buffered),
    seekable: read(video.seekable),
    resolution: [video.videoWidth, video.videoHeight],
    playbackRate: video.playbackRate,
    currentSrc: typeof video.currentSrc === 'string' ? new URL(video.currentSrc).pathname : '未提供',
  };
}

async function runPage(context, kind, url) {
  const page = await context.newPage();
  const bridgeRequests = [];
  await page.exposeFunction('__recordExternalBridge', (request) => bridgeRequests.push(request));
  await page.addInitScript(() => {
    document.addEventListener('bilibili-buffer:bridge-request-v1', (event) => {
      try {
        void window.__recordExternalBridge(JSON.parse(event.detail));
      } catch (error) {
        console.error('[external smoke] bridge audit failed', error);
      }
    });
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(15000);
    const media = await page.evaluate(mediaFacts);
    const silent = await page.evaluate(() => window.__externalAudioAudit?.() || []);
    if (!media.present) {
      return { kind, status: 'BLOCKED', reason: '匿名公共页面没有可读取的 video', media, bridgeRequests, silent };
    }
    const forbiddenOperations = bridgeRequests.filter((request) =>
      !['getCoreSnapshot', 'callCoreSync', 'getLiveCapabilitySnapshot', 'disableLiveAutoCatchup'].includes(request.operation));
    if (forbiddenOperations.length > 0 || silent.some(({ muted, volume }) => muted !== true || volume !== 0)) {
      return { kind, status: 'FAIL', reason: '静音或桥接所有权审计失败', media, bridgeRequests, silent };
    }
    return {
      kind,
      status: 'PASS',
      reason: kind === 'video'
        ? '读取到原生 video；实际 120 秒提示结果以页面内核和日志为准'
        : '读取到原生 video；未观察到扩展播放所有权操作',
      media,
      bridgeRequests,
      silent,
    };
  } catch (error) {
    return { kind, status: 'BLOCKED', reason: error.message || String(error) };
  } finally {
    await page.close();
  }
}

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-external-smoke-'));
let context;
const report = {
  generatedAt: new Date().toISOString(),
  browser: { headless: true, muteAudio: true, freshProfile: true },
  results: [],
};
try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  await context.addInitScript({ content: `(${mutedInit.toString()})()` });
  report.results.push(await runPage(context, 'video', 'https://www.bilibili.com/video/BV1ohQVBFEsh'));
  report.results.push(await runPage(context, 'live', 'https://live.bilibili.com/6363772'));
  report.results.push({
    kind: 'live-media-stall',
    status: 'BLOCKED',
    reason: '本 smoke 不注入非确定性的公共 CDN 中断；需外部网络故障或受控代理才能证明恢复延迟保留',
  });
  report.results.push({
    kind: 'live-offline',
    status: 'BLOCKED',
    reason: '本 smoke 不改变浏览器全局网络状态；需受控断网环境才能证明完全断网恢复',
  });
} catch (error) {
  if (!String(error?.message || error).includes('libnspr4.so')) throw error;
  report.results.push({
    kind: 'browser-environment',
    status: 'BLOCKED',
    reason: `Chromium runtime is unavailable in this host: ${error.message}`,
  });
} finally {
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
