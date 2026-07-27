import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { readMaxEventId, readStoredEvents } from './extension-log-pull.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'external-smoke-report.json');
const bridgeAuditOperations = new Set([
  'getCoreSnapshot',
  'callCoreSync',
]);

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
  const currentSourcePathname = () => {
    if (typeof video.currentSrc !== 'string') return '未提供';
    if (!URL.canParse(video.currentSrc)) return '未提供';
    const currentSource = new URL(video.currentSrc);
    if (!['http:', 'https:'].includes(currentSource.protocol)) return '未提供';
    return currentSource.pathname;
  };
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : '未提供';
  const seekable = read(video.seekable);
  const contiguousBufferSeconds = () => {
    if (typeof currentTime !== 'number' || !Array.isArray(read(video.buffered))) return '未提供';
    const buffered = read(video.buffered);
    const range = buffered.find(({ start, end }) => start <= currentTime && currentTime <= end);
    return range === undefined ? 0 : Math.max(0, range.end - currentTime);
  };
  const estimatedDelay = () => {
    if (typeof currentTime !== 'number' || !Array.isArray(seekable) || seekable.length === 0) return '未提供';
    const seekableEnd = seekable[seekable.length - 1].end;
    return Number.isFinite(seekableEnd) ? seekableEnd - currentTime : '未提供';
  };
  return {
    present: true,
    currentTime,
    paused: video.paused,
    readyState: video.readyState,
    buffered: read(video.buffered),
    contiguousBufferSeconds: contiguousBufferSeconds(),
    seekable,
    estimatedDelay: estimatedDelay(),
    resolution: [video.videoWidth, video.videoHeight],
    playbackRate: video.playbackRate,
    currentSrc: currentSourcePathname(),
  };
}

function reportError(error) {
  const message = String(error?.message || error);
  return message.replace(/https?:\/\/[^\s'"`\])}]+/g, (value) => {
    if (!URL.canParse(value)) return '已移除 URL';
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  });
}

function bridgeAuditRecord(request) {
  const operation = bridgeAuditOperations.has(request?.operation) ? request.operation : 'invalid';
  const mode = request?.mode === 'sync' || request?.mode === 'async' ? request.mode : 'invalid';
  if (!Number.isSafeInteger(request?.id) || request.id <= 0) return { operation, mode };
  return { operation, mode, id: request.id };
}

async function waitForVideoHint(context, extensionId, pathname, startAfterEventId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const stored = await readStoredEvents(context, extensionId, startAfterEventId);
    const sessionIds = new Set(stored.events
      .filter((event) => event.code === 'route.session_started' && event.data?.pathname === pathname)
      .map((event) => event.sessionId));
    const hint = stored.events
      .filter((event) => sessionIds.has(event.sessionId) && [
        'video.buffer_hint.applied',
        'video.buffer_hint.unsupported',
        'video.buffer_hint.failed',
      ].includes(event.code))
      .at(-1);
    if (hint !== undefined) return { hint, stored };
    if (Date.now() >= deadline) return { hint: undefined, stored };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runPage(context, extensionId, url) {
  const page = await context.newPage();
  const bridgeRequests = [];
  await page.exposeFunction('__recordExternalBridge', (request) => bridgeRequests.push(bridgeAuditRecord(request)));
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
    const startAfterEventId = await readMaxEventId(context, extensionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(15000);
    const media = await page.evaluate(mediaFacts);
    const silent = await page.evaluate(() => window.__externalAudioAudit?.() || []);
    if (!media.present) {
      return {
        result: {
          kind: 'video',
          status: 'BLOCKED',
          reason: '匿名公共页面没有可读取的 video',
          browserStarted: true,
          pageStarted: true,
          media,
          bridgeRequests,
          silent,
        },
      };
    }
    const videoHint = (await waitForVideoHint(
      context,
      extensionId,
      new URL(url).pathname,
      startAfterEventId,
    )).hint;
    if (videoHint === undefined) {
      return {
        result: {
          kind: 'video',
          status: 'BLOCKED',
          reason: '公共页面有可读取 video，但没有持久化的 buffer hint attempt 结果',
          browserStarted: true,
          pageStarted: true,
          media,
          bridgeRequests,
          silent,
        },
      };
    }
    if (videoHint.data?.targetSeconds !== 120) {
      return {
        result: {
          kind: 'video',
          status: 'FAIL',
          reason: '公共页面 buffer hint 结果没有记录批准的 120 秒请求目标',
          browserStarted: true,
          pageStarted: true,
          media,
          bridgeRequests,
          silent,
          videoHint,
        },
      };
    }
    if (typeof media.contiguousBufferSeconds !== 'number') {
      return {
        result: {
          kind: 'video',
          status: 'BLOCKED',
          reason: '公共页面 video 存在，但无法读取当前真实连续缓存秒数',
          browserStarted: true,
          pageStarted: true,
          media,
          bridgeRequests,
          silent,
          videoHint,
        },
      };
    }
    const forbiddenOperations = bridgeRequests.filter((request) => !bridgeAuditOperations.has(request.operation));
    if (forbiddenOperations.length > 0 || silent.some(({ muted, volume }) => muted !== true || volume !== 0)) {
      return {
        result: {
          kind: 'video',
          status: 'FAIL',
          reason: '静音或桥接所有权审计失败',
          browserStarted: true,
          pageStarted: true,
          media,
          bridgeRequests,
          silent,
        },
      };
    }
    const result = {
      kind: 'video',
      status: 'PASS',
      browserStarted: true,
      pageStarted: true,
      reason: '读取到原生 video，并取得持久化 buffer hint 结果与真实连续缓存',
      media,
      bridgeRequests,
      silent,
      videoHint,
    };
    return { result };
  } catch (error) {
    return {
      result: {
        kind: 'video',
        status: 'BLOCKED',
        reason: reportError(error),
        browserStarted: true,
        pageStarted: true,
      },
    };
  } finally {
    await page.close();
  }
}

const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-external-smoke-'));
let context;
const report = {
  generatedAt: new Date().toISOString(),
  browser: {
    headless: false,
    muteAudio: true,
    freshProfile: true,
    browserStarted: false,
  },
  results: [],
};
try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--mute-audio',
      '--enable-unsafe-extension-debugging',
    ],
  });
  report.browser.browserStarted = true;
  const extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  await context.addInitScript({ content: `(${mutedInit.toString()})()` });
  const video = await runPage(context, extensionId, 'https://www.bilibili.com/video/BV1ohQVBFEsh');
  report.results.push(video.result);
} finally {
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
