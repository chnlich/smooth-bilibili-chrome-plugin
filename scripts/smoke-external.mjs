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
const delayToleranceSeconds = 1;
const bridgeAuditOperations = new Set([
  'getCoreSnapshot',
  'callCoreSync',
  'getLiveCapabilitySnapshot',
  'disableLiveAutoCatchup',
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
    seekable,
    estimatedDelay: estimatedDelay(),
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

function bridgeAuditRecord(request) {
  const operation = bridgeAuditOperations.has(request?.operation) ? request.operation : 'invalid';
  const mode = request?.mode === 'sync' || request?.mode === 'async' ? request.mode : 'invalid';
  if (!Number.isSafeInteger(request?.id) || request.id <= 0) return { operation, mode };
  return { operation, mode, id: request.id };
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

function hasEstimatedDelay(media) {
  return media !== null
    && typeof media === 'object'
    && typeof media.estimatedDelay === 'number'
    && Number.isFinite(media.estimatedDelay)
    && media.estimatedDelay >= 0;
}

function delayPreservation(before, during, after) {
  const beforeDelay = before?.estimatedDelay ?? '未提供';
  const duringDelay = during?.estimatedDelay ?? '未提供';
  const afterDelay = after?.estimatedDelay ?? '未提供';
  const protectedDelays = [before, during].filter(hasEstimatedDelay).map(({ estimatedDelay }) => estimatedDelay);
  if (protectedDelays.length === 0) {
    return {
      verifiable: false,
      reason: '中断前和中断期间均没有可读 seekable 延迟',
      beforeDelay,
      duringDelay,
      afterDelay,
    };
  }
  if (!hasEstimatedDelay(after)) {
    return {
      verifiable: false,
      reason: '恢复后没有可读 seekable 延迟',
      beforeDelay,
      duringDelay,
      afterDelay,
    };
  }
  const protectedBaseline = Math.max(...protectedDelays);
  const minimumAfterDelay = Math.max(0, protectedBaseline - delayToleranceSeconds);
  return {
    verifiable: true,
    preserved: after.estimatedDelay >= minimumAfterDelay,
    protectedBaseline,
    minimumAfterDelay,
    beforeDelay,
    duringDelay,
    afterDelay,
  };
}

async function readMediaEvents(page) {
  return page.evaluate(() => window.__externalMediaEvents?.() || []);
}

function blockedInterruption(kind, reason, before, details = {}) {
  return { kind, status: 'BLOCKED', reason, browserStarted: true, pageStarted: true, before, ...details };
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

  const delayCheck = delayPreservation(before, during, after);
  const details = { during, after, interruptedMediaRequests, duringEvents, recoveryEvents, delayCheck };
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
  if (!delayCheck.verifiable) {
    return blockedInterruption(
      'live-media-stall',
      `已观察到恢复，但无法验证延迟保留：${delayCheck.reason}`,
      before,
      details,
    );
  }
  if (!delayCheck.preserved) {
    return blockedInterruption(
      'live-media-stall',
      '已观察到恢复，但恢复后估算延迟低于受保护基准（含 1 秒测试容差）',
      before,
      details,
    );
  }
  return {
    kind: 'live-media-stall',
    status: 'PASS',
    reason: '已仅中断媒体请求并观察到原生恢复',
    browserStarted: true,
    pageStarted: true,
    before,
    ...details,
  };
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

  const delayCheck = delayPreservation(before, during, after);
  const details = { during, after, duringEvents, recoveryEvents, delayCheck };
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
  if (!delayCheck.verifiable) {
    return blockedInterruption(
      'live-offline',
      `已观察到恢复，但无法验证延迟保留：${delayCheck.reason}`,
      before,
      details,
    );
  }
  if (!delayCheck.preserved) {
    return blockedInterruption(
      'live-offline',
      '已观察到恢复，但恢复后估算延迟低于受保护基准（含 1 秒测试容差）',
      before,
      details,
    );
  }
  return {
    kind: 'live-offline',
    status: 'PASS',
    reason: '已完整离线并观察到原生恢复',
    browserStarted: true,
    pageStarted: true,
    before,
    ...details,
  };
}

async function runPage(context, kind, url, { keepPage = false } = {}) {
  const page = await context.newPage();
  let retained = false;
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
  await page.addInitScript({ content: `(${mediaEventInit.toString()})()` });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(15000);
    const media = await page.evaluate(mediaFacts);
    const silent = await page.evaluate(() => window.__externalAudioAudit?.() || []);
    if (!media.present) {
      return {
        result: {
          kind,
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
    const forbiddenOperations = bridgeRequests.filter((request) => !bridgeAuditOperations.has(request.operation));
    if (forbiddenOperations.length > 0 || silent.some(({ muted, volume }) => muted !== true || volume !== 0)) {
      return {
        result: {
          kind,
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
      kind,
      status: 'PASS',
      browserStarted: true,
      pageStarted: true,
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
    return {
      result: {
        kind,
        status: 'BLOCKED',
        reason: reportError(error),
        browserStarted: true,
        pageStarted: true,
      },
    };
  } finally {
    if (!retained) await page.close();
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
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  report.browser.browserStarted = true;
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
      browserStarted: true,
      pageStarted: true,
    });
    report.results.push({
      kind: 'live-offline',
      status: 'BLOCKED',
      reason: '直播页面未通过可读原生 video 与所有权审计，未执行完整离线中断',
      browserStarted: true,
      pageStarted: true,
    });
  } else {
    try {
      report.results.push(await runLiveMediaInterruption(live.page));
      report.results.push(await runLiveOfflineInterruption(context, live.page));
    } finally {
      await live.page.close();
    }
  }
} finally {
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
