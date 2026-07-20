import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'external-smoke-report.json');
const interruptionMilliseconds = 4000;
const recoveryMilliseconds = 5000;

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
  return {
    present: true,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : '未提供',
    paused: video.paused,
    readyState: video.readyState,
    buffered: read(video.buffered),
    seekable: read(video.seekable),
    resolution: [video.videoWidth, video.videoHeight],
    playbackRate: video.playbackRate,
    currentSrc: currentSourcePathname(),
  };
}

const mediaEventInit = () => {
  const observedEvents = [];
  const eventTypes = ['loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'seeked', 'error'];
  for (const type of eventTypes) {
    document.addEventListener(type, (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      observedEvents.push({
        type,
        elapsedMilliseconds: Math.round(performance.now()),
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : '未提供',
        paused: video.paused,
        readyState: video.readyState,
      });
    }, true);
  }
  window.__externalMediaEvents = () => observedEvents.slice();
};

function reportError(error) {
  const message = String(error?.message || error);
  return message.replace(/https?:\/\/[^\s'"`\])}]+/g, (value) => {
    if (!URL.canParse(value)) return '已移除 URL';
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  });
}

function hasReadablePlayingVideo(media) {
  return media.present === true
    && typeof media.currentTime === 'number'
    && Number.isFinite(media.currentTime)
    && media.readyState >= 2
    && media.paused === false;
}

function playbackAdvanced(before, after) {
  return hasReadablePlayingVideo(before)
    && hasReadablePlayingVideo(after)
    && after.currentTime > before.currentTime + 0.25;
}

function observedStall(before, during, events) {
  return events.some(({ type }) => type === 'waiting' || type === 'stalled')
    || !playbackAdvanced(before, during);
}

function observedRecovery(during, after, events) {
  return playbackAdvanced(during, after)
    || events.some(({ type }) => type === 'loadeddata' || type === 'canplay' || type === 'playing');
}

async function readMediaEvents(page) {
  return page.evaluate(() => window.__externalMediaEvents?.() || []);
}

function blockedInterruption(kind, reason, before, details = {}) {
  return { kind, status: 'BLOCKED', reason, before, ...details };
}

async function runLiveMediaInterruption(page) {
  const before = await page.evaluate(mediaFacts);
  if (!hasReadablePlayingVideo(before)) {
    return blockedInterruption(
      'live-media-stall',
      '未取得正在原生播放且可读取的直播 video，无法安全仅阻断媒体请求',
      before,
    );
  }

  const initialEvents = await readMediaEvents(page);
  let interruptedMediaRequests = 0;
  let routeFailure;
  const mediaOnlyRoute = async (route) => {
    if (route.request().resourceType() !== 'media') {
      await route.continue();
      return;
    }
    interruptedMediaRequests += 1;
    try {
      await route.abort('failed');
    } catch (error) {
      routeFailure = reportError(error);
      await route.continue();
    }
  };

  let interruptionError;
  let during = '未提供';
  let duringEvents = [];
  try {
    await page.route('**/*', mediaOnlyRoute);
    await page.waitForTimeout(interruptionMilliseconds);
    during = await page.evaluate(mediaFacts);
    duringEvents = (await readMediaEvents(page)).slice(initialEvents.length);
  } catch (error) {
    interruptionError = reportError(error);
  } finally {
    try {
      await page.unroute('**/*', mediaOnlyRoute);
    } catch (error) {
      interruptionError ||= reportError(error);
    }
  }

  if (interruptionError !== undefined || routeFailure !== undefined) {
    return blockedInterruption(
      'live-media-stall',
      interruptionError || `媒体路由中断失败：${routeFailure}`,
      before,
      { during, interruptedMediaRequests, duringEvents, routeFailure },
    );
  }

  let after = '未提供';
  let recoveryEvents = [];
  try {
    const eventCountAtRelease = (await readMediaEvents(page)).length;
    await page.waitForTimeout(recoveryMilliseconds);
    after = await page.evaluate(mediaFacts);
    recoveryEvents = (await readMediaEvents(page)).slice(eventCountAtRelease);
  } catch (error) {
    return blockedInterruption(
      'live-media-stall',
      `解除媒体中断后无法读取恢复状态：${reportError(error)}`,
      before,
      { during, interruptedMediaRequests, duringEvents, routeFailure },
    );
  }

  const details = { during, after, interruptedMediaRequests, duringEvents, recoveryEvents };
  if (interruptedMediaRequests === 0) {
    return blockedInterruption(
      'live-media-stall',
      '已实际安装 resourceType=media 的窄路由，但中断窗口内没有可安全识别的媒体请求',
      before,
      details,
    );
  }
  if (!observedStall(before, during, duringEvents)) {
    return blockedInterruption(
      'live-media-stall',
      '已阻断媒体请求，但未观察到 native video 的 waiting/stalled 或停止推进证据',
      before,
      details,
    );
  }
  if (!observedRecovery(during, after, recoveryEvents)) {
    return blockedInterruption(
      'live-media-stall',
      '已解除媒体中断，但未观察到原生 video 的恢复证据',
      before,
      details,
    );
  }
  return { kind: 'live-media-stall', status: 'PASS', reason: '已仅中断媒体请求并观察到原生恢复', before, ...details };
}

async function runLiveOfflineInterruption(context, page) {
  const before = await page.evaluate(mediaFacts);
  if (!hasReadablePlayingVideo(before)) {
    return blockedInterruption(
      'live-offline',
      '未取得正在原生播放且可读取的直播 video，无法执行完整离线恢复验证',
      before,
    );
  }

  const initialEvents = await readMediaEvents(page);
  let offlineError;
  let during = '未提供';
  let duringEvents = [];
  try {
    await context.setOffline(true);
    await page.waitForTimeout(interruptionMilliseconds);
    during = await page.evaluate(mediaFacts);
    duringEvents = (await readMediaEvents(page)).slice(initialEvents.length);
  } catch (error) {
    offlineError = reportError(error);
  } finally {
    try {
      await context.setOffline(false);
    } catch (error) {
      offlineError ||= `恢复在线状态失败：${reportError(error)}`;
    }
  }

  if (offlineError !== undefined) {
    return blockedInterruption('live-offline', offlineError, before, { during, duringEvents });
  }

  let after = '未提供';
  let recoveryEvents = [];
  try {
    const eventCountAtRestore = (await readMediaEvents(page)).length;
    await page.waitForTimeout(recoveryMilliseconds);
    after = await page.evaluate(mediaFacts);
    recoveryEvents = (await readMediaEvents(page)).slice(eventCountAtRestore);
  } catch (error) {
    return blockedInterruption(
      'live-offline',
      `恢复在线后无法读取原生 video：${reportError(error)}`,
      before,
      { during, duringEvents },
    );
  }

  const details = { during, after, duringEvents, recoveryEvents };
  if (!observedStall(before, during, duringEvents)) {
    return blockedInterruption(
      'live-offline',
      '已实际切换完整离线，但未观察到 native video 的 waiting/stalled 或停止推进证据',
      before,
      details,
    );
  }
  if (!observedRecovery(during, after, recoveryEvents)) {
    return blockedInterruption(
      'live-offline',
      '已恢复在线，但未观察到原生 video 的恢复证据',
      before,
      details,
    );
  }
  return { kind: 'live-offline', status: 'PASS', reason: '已完整离线并观察到原生恢复', before, ...details };
}

async function runPage(context, kind, url, { keepPage = false } = {}) {
  const page = await context.newPage();
  let retained = false;
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
  await page.addInitScript({ content: `(${mediaEventInit.toString()})()` });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(15000);
    const media = await page.evaluate(mediaFacts);
    const silent = await page.evaluate(() => window.__externalAudioAudit?.() || []);
    if (!media.present) {
      return {
        result: { kind, status: 'BLOCKED', reason: '匿名公共页面没有可读取的 video', media, bridgeRequests, silent },
      };
    }
    const forbiddenOperations = bridgeRequests.filter((request) =>
      !['getCoreSnapshot', 'callCoreSync', 'getLiveCapabilitySnapshot', 'disableLiveAutoCatchup'].includes(request.operation));
    if (forbiddenOperations.length > 0 || silent.some(({ muted, volume }) => muted !== true || volume !== 0)) {
      return {
        result: { kind, status: 'FAIL', reason: '静音或桥接所有权审计失败', media, bridgeRequests, silent },
      };
    }
    const result = {
      kind,
      status: 'PASS',
      reason: kind === 'video'
        ? '读取到原生 video；实际 120 秒提示结果以页面内核和日志为准'
        : '读取到原生 video；未观察到扩展播放所有权操作',
      media,
      bridgeRequests,
      silent,
    };
    if (keepPage) {
      retained = true;
      return { result, page };
    }
    return { result };
  } catch (error) {
    return { result: { kind, status: 'BLOCKED', reason: reportError(error) } };
  } finally {
    if (!retained) await page.close();
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
  const video = await runPage(context, 'video', 'https://www.bilibili.com/video/BV1ohQVBFEsh');
  report.results.push(video.result);
  const live = await runPage(context, 'live', 'https://live.bilibili.com/6363772', { keepPage: true });
  report.results.push(live.result);
  if (live.page === undefined) {
    report.results.push({
      kind: 'live-media-stall',
      status: 'BLOCKED',
      reason: '直播页面未通过可读原生 video 与所有权审计，未执行媒体专属中断',
    });
    report.results.push({
      kind: 'live-offline',
      status: 'BLOCKED',
      reason: '直播页面未通过可读原生 video 与所有权审计，未执行完整离线中断',
    });
  } else {
    try {
      report.results.push(await runLiveMediaInterruption(live.page));
      report.results.push(await runLiveOfflineInterruption(context, live.page));
    } finally {
      await live.page.close();
    }
  }
} catch (error) {
  if (!String(error?.message || error).includes('libnspr4.so')) throw error;
  report.results.push({
    kind: 'browser-environment',
    status: 'BLOCKED',
    reason: `Chromium runtime is unavailable in this host: ${reportError(error)}`,
  });
} finally {
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
