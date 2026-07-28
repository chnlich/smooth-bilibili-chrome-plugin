import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { readMaxEventId, readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';

// Real Chrome playback verification: npm run verify:browser -- --bv BV... --profile <signed-in-profile>

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const MEDIA_HOST = /(?:\.bilivideo\.com|\.akamaized\.net)$/;
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    bv: 'BV1syga6fEL7',
    seconds: 150,
    startSeconds: 0,
    profile: undefined,
    outputDirectory: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--bv') options.bv = argv[++index];
    else if (key === '--seconds') options.seconds = Number(argv[++index]);
    else if (key === '--start-seconds') options.startSeconds = Number(argv[++index]);
    else if (key === '--profile') options.profile = argv[++index];
    else if (key === '--output-dir') options.outputDirectory = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (typeof options.bv !== 'string' || options.bv.length === 0) throw new Error('--bv must be non-empty');
  if (!Number.isFinite(options.seconds) || options.seconds <= 0) throw new Error('--seconds must be positive');
  if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0) {
    throw new Error('--start-seconds must be non-negative');
  }
  if (options.profile !== undefined && (typeof options.profile !== 'string' || options.profile.length === 0)) {
    throw new Error('--profile must be a non-empty directory');
  }
  if (options.outputDirectory !== undefined
    && (typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0)) {
    throw new Error('--output-dir must be a non-empty directory');
  }
  return options;
}

function reportError(error) {
  const message = String(error?.message || error);
  return message.replace(/https?:\/\/[^\s'"`\])}]+/g, (value) => {
    if (!URL.canParse(value)) return 'invalid-url';
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  });
}

function overlapReport(requests) {
  const byPath = new Map();
  for (const record of requests) {
    if (record.rangeStart === undefined) continue;
    if (!byPath.has(record.pathname)) byPath.set(record.pathname, []);
    byPath.get(record.pathname).push([record.rangeStart, record.rangeEnd]);
  }
  const report = [];
  for (const [pathname, intervals] of byPath) {
    intervals.sort((left, right) => left[0] - right[0]);
    let requestedBytes = 0;
    let unionBytes = 0;
    let unionStart = intervals[0][0];
    let unionEnd = intervals[0][1];
    for (const [start, end] of intervals) {
      requestedBytes += end - start + 1;
      if (start > unionEnd + 1) {
        unionBytes += unionEnd - unionStart + 1;
        unionStart = start;
        unionEnd = end;
      } else if (end > unionEnd) {
        unionEnd = end;
      }
    }
    unionBytes += unionEnd - unionStart + 1;
    report.push({
      pathname,
      requestCount: intervals.length,
      requestedBytes,
      unionBytes,
      duplicateBytes: requestedBytes - unionBytes,
    });
  }
  return report.sort((left, right) => right.requestedBytes - left.requestedBytes);
}

function resolutionKey(event) {
  const resolution = event.data?.resolution;
  if (!Number.isFinite(resolution?.width) || !Number.isFinite(resolution?.height)) return undefined;
  return `${resolution.width}x${resolution.height}`;
}

function latestSessionId(events, pathname) {
  return events
    .filter((event) => event.code === 'route.session_started' && event.data?.pathname === pathname)
    .at(-1)?.sessionId;
}

async function waitForMediaSample(context, extensionId, startAfterEventId, pathname, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const stored = await readStoredEvents(context, extensionId, startAfterEventId);
    const sessionId = latestSessionId(stored.events, pathname);
    const samples = stored.events.filter((event) => event.code === 'media.sample' && event.sessionId === sessionId);
    const sample = samples.find((candidate) => predicate(candidate));
    if (sample !== undefined) return { sample, sessionId, stored };
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`media.sample condition was not observed for ${pathname}`), {
        code: 'MEDIA_SAMPLE_TIMEOUT',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const silenceInit = () => {
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    element.muted = true;
    element.volume = 0;
  };
  const scan = (node) => {
    if (node instanceof HTMLMediaElement) silence(node);
    if (typeof node.querySelectorAll === 'function') {
      for (const element of node.querySelectorAll('video,audio')) silence(element);
    }
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  }).observe(document, { childList: true, subtree: true });
  scan(document);
};

async function readMedia(page) {
  return page.evaluate(() => {
    const video = [...document.querySelectorAll('video')]
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    if (video === undefined) throw new Error('video element is unavailable');
    const quality = typeof video.getVideoPlaybackQuality === 'function'
      ? video.getVideoPlaybackQuality()
      : undefined;
    const buffered = [];
    for (let index = 0; index < video.buffered.length; index += 1) {
      buffered.push([video.buffered.start(index), video.buffered.end(index)]);
    }
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      paused: video.paused,
      readyState: video.readyState,
      networkState: video.networkState,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      buffered,
      resolution: [video.videoWidth, video.videoHeight],
      videoQuality: quality === undefined ? null : {
        total: Number.isFinite(quality.totalVideoFrames) ? quality.totalVideoFrames : null,
        dropped: Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : null,
        corrupted: Number.isFinite(quality.corruptedVideoFrames) ? quality.corruptedVideoFrames : null,
      },
      muted: video.muted,
      volume: video.volume,
    };
  });
}

async function switchQuality(context, extensionId, page, startAfterEventId, pathname) {
  const beforeResult = await waitForMediaSample(
    context,
    extensionId,
    startAfterEventId,
    pathname,
    (event) => resolutionKey(event) !== undefined,
  );
  const before = beforeResult.sample;
  const qualityButton = page.locator('.bpx-player-ctrl-quality').first();
  try {
    await qualityButton.waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    throw Object.assign(new Error('quality control .bpx-player-ctrl-quality was not found or visible'), {
      code: 'QUALITY_CONTROL_NOT_FOUND',
      cause: error,
    });
  }
  await qualityButton.click();
  const menu = page.locator('.bpx-player-ctrl-quality-menu').first();
  try {
    await menu.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    throw Object.assign(new Error('quality menu .bpx-player-ctrl-quality-menu did not open'), {
      code: 'QUALITY_MENU_NOT_FOUND',
      cause: error,
    });
  }
  const items = menu.locator('.bpx-player-ctrl-quality-menu-item');
  const metadata = await items.evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent?.trim() || '',
    active: element.classList.contains('bpx-player-ctrl-quality-menu-item-active')
      || element.getAttribute('aria-selected') === 'true'
      || element.dataset.selected === 'true',
  })));
  if (metadata.length < 2) {
    throw Object.assign(new Error('quality menu has fewer than two selectable levels'), {
      code: 'QUALITY_LEVEL_NOT_FOUND',
    });
  }
  const activeIndex = metadata.findIndex((item) => item.active);
  const targetIndex = metadata.findIndex((item, index) => index !== activeIndex);
  if (targetIndex < 0) {
    throw Object.assign(new Error('quality menu has no level different from the current level'), {
      code: 'QUALITY_LEVEL_NOT_FOUND',
    });
  }
  await items.nth(targetIndex).click();
  const afterResult = await waitForMediaSample(
    context,
    extensionId,
    startAfterEventId,
    pathname,
    (event) => resolutionKey(event) !== undefined && resolutionKey(event) !== resolutionKey(before),
    30000,
  );
  return {
    beforeResolution: before.data.resolution,
    afterResolution: afterResult.sample.data.resolution,
    beforeVideoQuality: before.data.videoQuality,
    afterVideoQuality: afterResult.sample.data.videoQuality,
    selectedLevel: metadata[targetIndex].text,
  };
}

async function readProvenance() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commitSha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('git rev-parse HEAD did not return a commit sha');
  const bundles = await Promise.all([
    fs.readFile(path.join(extensionDirectory, 'controller.js'), 'utf8'),
    fs.readFile(path.join(extensionDirectory, 'worker.js'), 'utf8'),
  ]);
  const buildIds = new Set(bundles.flatMap((bundle) => bundle.match(/src-[a-f0-9]{24}/g) || []));
  if (buildIds.size !== 1) throw new Error('dist bundles do not contain exactly one shared buildId');
  return { commitSha, buildId: [...buildIds][0] };
}

function assertPlayback(samples) {
  const times = samples.map((sample) => sample.currentTime).filter((time) => Number.isFinite(time));
  if (times.length < 2 || times.at(-1) <= times[0]) {
    throw Object.assign(new Error('video playback did not advance during the verification window'), {
      code: 'PLAYBACK_DID_NOT_ADVANCE',
    });
  }
  return { sampleCount: samples.length, firstCurrentTime: times[0], lastCurrentTime: times.at(-1) };
}

const options = parseArgs(process.argv.slice(2));
const chromeExecutablePath = await resolveChromeExecutablePath();
const provenance = await readProvenance();
const outputDirectory = options.outputDirectory === undefined
  ? path.join(root, 'reports', `verify-${Date.now()}`)
  : path.resolve(options.outputDirectory);
await fs.mkdir(outputDirectory, { recursive: true });

const ownsProfile = options.profile === undefined;
const profileDirectory = ownsProfile
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-verify-profile-'))
  : path.resolve(options.profile);
let context;
let page;
let consoleCapture;
let extensionId;
let events = [];
let mediaRequests = [];
const networkParseFailures = [];
const summary = {
  status: 'INCONCLUSIVE',
  failures: [],
  commitSha: provenance.commitSha,
  buildId: provenance.buildId,
  options: {
    bv: options.bv,
    seconds: options.seconds,
    startSeconds: options.startSeconds,
    persistentProfile: options.profile !== undefined,
  },
  browser: {
    headless: false,
    muteAudio: true,
    browserStarted: false,
  },
};

try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: chromeExecutablePath,
    headless: false,
    args: [
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
    timeout: 120000,
  });
  summary.browser.browserStarted = true;
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(context.browser(), extensionId);
  await triggerExtensionPositiveControl(context, extensionId, consoleCapture);
  summary.positiveControl = { captured: true };
  await context.addInitScript({ content: `(${silenceInit.toString()})()` });

  const startAfterEventId = await readMaxEventId(context, extensionId);
  page = await context.newPage();
  const networkClient = await context.newCDPSession(page);
  await networkClient.send('Network.enable');
  await networkClient.send('Network.clearBrowserCache');
  const requestsById = new Map();
  mediaRequests = [];
  networkClient.on('Network.requestWillBeSent', (event) => {
    let parsed;
    try {
      parsed = new URL(event.request.url);
    } catch (error) {
      networkParseFailures.push({ message: reportError(error) });
      return;
    }
    if (!MEDIA_HOST.test(parsed.hostname)) return;
    const headers = event.request.headers || {};
    const rangeHeader = headers.Range ?? headers.range;
    const match = typeof rangeHeader === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(rangeHeader) : null;
    const record = {
      requestId: event.requestId,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      rangeHeader: rangeHeader ?? null,
      rangeStart: match ? Number(match[1]) : undefined,
      rangeEnd: match ? Number(match[2]) : undefined,
      status: undefined,
      encodedDataLength: 0,
      totalSize: undefined,
    };
    requestsById.set(event.requestId, record);
    mediaRequests.push(record);
  });
  networkClient.on('Network.responseReceived', (event) => {
    const record = requestsById.get(event.requestId);
    if (record === undefined) return;
    record.status = event.response.status;
    const headers = event.response.headers || {};
    const contentRange = headers['content-range'] ?? headers['Content-Range'];
    const match = typeof contentRange === 'string' ? /\/(\d+)$/.exec(contentRange) : null;
    if (match !== null) record.totalSize = Number(match[1]);
  });
  networkClient.on('Network.loadingFinished', (event) => {
    const record = requestsById.get(event.requestId);
    if (record !== undefined) record.encodedDataLength = event.encodedDataLength;
  });
  networkClient.on('Network.loadingFailed', (event) => {
    const record = requestsById.get(event.requestId);
    if (record !== undefined) record.failed = event.errorText;
  });

  const startFragment = options.startSeconds > 0 ? `?t=${options.startSeconds}` : '';
  const url = `https://www.bilibili.com/video/${options.bv}${startFragment}`;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (response === null || response.status() >= 400) {
    throw Object.assign(new Error(`page was unreachable: status ${response?.status() ?? 'missing'}`), {
      code: 'BLOCKED_PAGE_UNREACHABLE',
    });
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('video')].some((video) => Number.isFinite(video.duration) && video.duration > 0),
    undefined,
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    const video = [...document.querySelectorAll('video')]
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    if (video === undefined) throw new Error('video element disappeared before playback');
    video.muted = true;
    video.volume = 0;
    if (video.paused) void video.play();
  });

  const pathname = new URL(page.url()).pathname;
  summary.qualitySwitch = await switchQuality(context, extensionId, page, startAfterEventId, pathname);
  const sampled = [];
  const sampleCount = Math.max(2, Math.round(options.seconds / 5));
  for (let index = 0; index < sampleCount; index += 1) {
    await page.waitForTimeout(5000);
    sampled.push(await readMedia(page));
  }
  summary.playback = assertPlayback(sampled);
  summary.samples = sampled;

  const stored = await readStoredEvents(context, extensionId, startAfterEventId);
  events = stored.events;
  summary.eventTotal = events.length;
  summary.mediaErrors = events.filter((event) => event.code === 'media.error' || event.code === 'media.stalled').length;
  summary.extensionErrors = events.filter((event) => event.code === 'extension.observer_error'
    || event.code === 'extension.boot_error').length;
  summary.mediaRequests = mediaRequests.length;
  summary.mediaBytes = mediaRequests.reduce((total, record) => total + (record.encodedDataLength || 0), 0);
  summary.failedRequests = mediaRequests.filter((record) => record.failed !== undefined).length;
  summary.nonPartialResponses = mediaRequests.filter((record) => record.status !== undefined
    && record.status !== 206 && record.status !== 200).length;
  summary.overlap = overlapReport(mediaRequests);
  summary.networkParseFailures = networkParseFailures;
  summary.console = consoleCapture.verdict();
  if (summary.console.status !== 'pass') {
    throw Object.assign(new Error(summary.console.failures.join('; ')), { code: 'CONSOLE_VERDICT_FAILED' });
  }
  summary.status = 'pass';
} catch (error) {
  summary.status = ['CONSOLE_POSITIVE_CONTROL_MISSED', 'CONSOLE_CAPTURE_FAILED'].includes(error?.code)
    ? 'INCONCLUSIVE'
    : 'fail';
  summary.failures.push({ code: error?.code || 'VERIFY_FAILED', message: reportError(error) });
  if (consoleCapture !== undefined) summary.console = consoleCapture.verdict();
  summary.networkParseFailures = networkParseFailures;
} finally {
  await page?.close();
  await consoleCapture?.close();
  await context?.close();
  if (ownsProfile) await fs.rm(profileDirectory, { recursive: true, force: true });
  await fs.writeFile(path.join(outputDirectory, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(outputDirectory, 'console.json'),
    `${JSON.stringify(consoleCapture?.events || [], null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(outputDirectory, 'network.json'), `${JSON.stringify(mediaRequests, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  outputDirectory,
  status: summary.status,
  commitSha: summary.commitSha,
  buildId: summary.buildId,
  failures: summary.failures,
  console: summary.console,
  qualitySwitch: summary.qualitySwitch,
  playback: summary.playback,
  eventTotal: summary.eventTotal,
  mediaRequests: summary.mediaRequests,
}, null, 2));
if (summary.status !== 'pass') process.exitCode = 1;
