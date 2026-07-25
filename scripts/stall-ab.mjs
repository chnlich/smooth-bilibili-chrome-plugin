/*
 * One-command playback-stall A/B harness.
 *
 * Self-check:
 *   node scripts/stall-ab.mjs --self-check --profile "<persistent-signed-in-profile-dir>"
 * Login:
 *   node scripts/stall-ab.mjs --login --profile "<persistent-signed-in-profile-dir>"
 * Measurement:
 *   node scripts/stall-ab.mjs --bv BV1syga6fEL7 --seconds 180 --rate 2 \
 *     --arms extension-on,extension-off --profile "<persistent-signed-in-profile-dir>" \
 *     --out artifacts/stall-ab-20260724T000000Z
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { VOD_CONFIG } from '../src/constants.js';
import { readMaxEventId, readStoredEvents } from './extension-log-pull.mjs';
import { computeStallScore } from './stall-score.mjs';
import { STALL_PROBE_SOURCE } from './stall-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const extensionBuildFiles = Object.freeze([
  'manifest.json',
  'controller.js',
  'main-bridge.js',
  'source-buffer-shim.js',
  'worker.js',
  'logs.html',
  'logs.js',
]);
const knownChromeRelativePath = path.win32.join('Google', 'Chrome', 'Application', 'chrome.exe');
const knownProfileDirectoryPattern = /^(Default|Profile \d+)$/;
const forbiddenPayloadField = /cookie|token|account/i;
const selfCheckUrl = 'https://www.bilibili.com/video/BV1syga6fEL7';
const profileLockFileNames = Object.freeze(['lockfile', 'SingletonLock']);
// Two minutes leaves headroom for cold persistent-profile Chrome startup while bounding the
// multi-minute wait observed when another Chrome instance owns the profile.
export const PROFILE_LAUNCH_TIMEOUT_MILLISECONDS = 120_000;
const extensionInjectionWaitMilliseconds = 5000;

async function playwrightChromium() {
  return (await import('playwright')).chromium;
}

export const documentStartSilenceInit = () => {
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
  window.__stallAbAudioAudit = () => [...observed].map((element) => ({
    muted: element.muted,
    volume: element.volume,
  }));
};

export const DOCUMENT_START_SILENCE_SOURCE = `(${documentStartSilenceInit.toString()})()`;

class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
  }
}

function usageError(message) {
  throw new Error(`CLI_INVALID: ${message}`);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) usageError(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/.test(value)) usageError(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usageError(`${flag} must be a positive integer`);
  return parsed;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) usageError(`${flag} must be a positive number`);
  return parsed;
}

function parseArms(value) {
  const arms = value.split(',');
  if (arms.length !== 2 || new Set(arms).size !== 2
    || !arms.every((arm) => ['extension-on', 'extension-off'].includes(arm))) {
    usageError('--arms must contain extension-on,extension-off exactly once each');
  }
  return arms;
}

export function parseArguments(argv) {
  const options = { selfCheck: false, login: false };
  const assigned = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-check') {
      if (options.selfCheck) usageError('--self-check was repeated');
      options.selfCheck = true;
      continue;
    }
    if (argument === '--login') {
      if (options.login) usageError('--login was repeated');
      options.login = true;
      continue;
    }
    const values = {
      '--bv': 'bv',
      '--seconds': 'seconds',
      '--rate': 'rate',
      '--arms': 'arms',
      '--profile': 'profile',
      '--out': 'out',
    };
    const key = values[argument];
    if (key === undefined) usageError(`unknown argument ${argument}`);
    if (assigned.has(key)) usageError(`${argument} was repeated`);
    assigned.add(key);
    options[key] = requireValue(argv, index, argument);
    index += 1;
  }

  if (options.selfCheck && options.login) usageError('--self-check and --login cannot be combined');
  if (options.selfCheck) return options;
  if (options.login) {
    if (options.profile === undefined) usageError('--profile is required with --login');
    return options;
  }
  for (const field of ['bv', 'seconds', 'rate', 'arms', 'profile', 'out']) {
    if (options[field] === undefined) usageError(`--${field} is required`);
  }
  if (!/^BV[0-9A-Za-z]+$/.test(options.bv)) usageError('--bv must be a Bilibili BV identifier');
  options.seconds = parsePositiveInteger(options.seconds, '--seconds');
  options.rate = parsePositiveNumber(options.rate, '--rate');
  options.arms = parseArms(options.arms);
  return options;
}

function requireWindowsNode() {
  if (process.platform !== 'win32') {
    throw new Error(`ENV_WINDOWS_NODE_REQUIRED: detected ${process.platform}; run with Windows Node`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 20) {
    throw new Error(`ENV_NODE_VERSION_REQUIRED: detected Node ${process.versions.node}; require Node 20+`);
  }
}

export async function resolveChromeExecutable({
  platform = process.platform,
  environment = process.env,
  access = fs.access,
} = {}) {
  if (platform !== 'win32') {
    throw new Error(`ENV_WINDOWS_NODE_REQUIRED: Chrome probing requires Windows Node, detected ${platform}`);
  }
  const roots = [
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment['ProgramFiles(x86)'],
    environment.LOCALAPPDATA,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const candidates = [...new Set(roots.map((rootDirectory) =>
    path.win32.join(rootDirectory, knownChromeRelativePath)))];
  const probed = [];
  for (const candidate of candidates) {
    probed.push(candidate);
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && error?.code !== 'EACCES') throw error;
    }
  }
  throw new Error(`ENV_CHROME_NOT_FOUND: probed known locations ${probed.join(', ')}`);
}

async function assertExtensionBuild() {
  for (const file of extensionBuildFiles) {
    try {
      await fs.access(path.join(extensionDirectory, file));
    } catch (error) {
      throw new Error(`ENV_EXTENSION_BUILD_MISSING: dist/extension/${file}`);
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) {
    throw new Error('ENV_EXTENSION_BUILD_INVALID: dist/extension/manifest.json is not MV3');
  }
}

async function assertProfileDirectory(profileDirectory) {
  try {
    const stat = await fs.stat(profileDirectory);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.message === 'not a directory') {
      throw new Error('ENV_PROFILE_MISSING: --profile must point to an existing directory');
    }
    throw error;
  }
}

async function assertOutputDirectoryDoesNotExist(outputDirectory) {
  try {
    await fs.access(outputDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('CLI_OUTPUT_EXISTS: --out already exists; choose a new run directory');
}

async function clearProfileMediaCache(profileDirectory) {
  const entries = await fs.readdir(profileDirectory, { withFileTypes: true });
  const profileDirectories = entries
    .filter((entry) => entry.isDirectory() && knownProfileDirectoryPattern.test(entry.name))
    .map((entry) => path.join(profileDirectory, entry.name));
  const mediaCacheDirectories = [
    path.join(profileDirectory, 'Media Cache'),
    ...profileDirectories.map((directory) => path.join(directory, 'Media Cache')),
  ];
  for (const directory of mediaCacheDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function clearBrowserCache(context) {
  const page = await context.newPage();
  try {
    const client = await context.newCDPSession(page);
    await client.send('Network.clearBrowserCache');
  } finally {
    await page.close();
  }
}

export function launchArguments(arm) {
  const args = ['--mute-audio', '--no-first-run', '--no-default-browser-check'];
  if (arm === 'extension-off') return args;
  if (arm === 'extension-on') return args;
  throw new Error(`ARM_INVALID: ${arm}`);
}

export function launchOptionsForArm(arm) {
  const options = {
    headless: false,
    args: launchArguments(arm),
    timeout: PROFILE_LAUNCH_TIMEOUT_MILLISECONDS,
  };
  if (arm === 'extension-on') options.ignoreDefaultArgs = ['--disable-extensions'];
  return options;
}

export function extensionInjectionState() {
  const removeSource = typeof SourceBuffer === 'undefined'
    ? undefined
    : SourceBuffer.prototype?.remove?.toString();
  return {
    shimMarker: window.__smoothBufferShim,
    removeSource,
  };
}

function extensionSignals(state) {
  const shimMarkerIsObject = state.shimMarker !== null
    && typeof state.shimMarker === 'object'
    && Array.isArray(state.shimMarker) === false;
  const removeIsPatched = typeof state.removeSource === 'string'
    && state.removeSource.includes('[native code]') === false;
  return { shimMarkerIsObject, removeIsPatched };
}

export function assertExtensionInjection(arm, state) {
  if (arm !== 'extension-on' && arm !== 'extension-off') throw new Error(`ARM_INVALID: ${arm}`);
  const { shimMarkerIsObject, removeIsPatched } = extensionSignals(state);
  const extensionSignalsPresent = shimMarkerIsObject || removeIsPatched;
  const observed = `shim marker object=${shimMarkerIsObject}, `
    + `SourceBuffer.prototype.remove patched=${removeIsPatched}`;
  if (arm === 'extension-on' && (!shimMarkerIsObject || !removeIsPatched)) {
    throw new BlockedError(
      'EXTENSION_INJECTION_MISSING: extension-on requires the profile-installed unpacked extension '
      + 'installed through chrome://extensions developer mode; '
      + `the verified extension signals were not both observed (${observed})`,
    );
  }
  if (arm === 'extension-off' && extensionSignalsPresent) {
    throw new BlockedError(
      'EXTENSION_INJECTION_UNEXPECTED: extension-off requires the profile-installed unpacked extension '
      + `to be inactive, but an extension signal was observed (${observed})`,
    );
  }
  return state;
}

export function probeSourceForArm(arm) {
  if (arm !== 'extension-on' && arm !== 'extension-off') throw new Error(`ARM_INVALID: ${arm}`);
  return STALL_PROBE_SOURCE;
}

function profileInUseError(profileDirectory) {
  return new BlockedError(
    `PROFILE_IN_USE: a Chrome instance is holding profile ${path.resolve(profileDirectory)} `
    + 'and must be closed before running stall A/B',
  );
}

async function isProfileLockHeld(lockPath, open) {
  let handle;
  try {
    handle = await open(lockPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'EBUSY') return true;
    throw error;
  }
  await handle.close();
  return false;
}

async function profileLockIsHeld(profileDirectory, { lstat = fs.lstat, open = fs.open } = {}) {
  for (const lockFileName of profileLockFileNames) {
    const lockPath = path.join(profileDirectory, lockFileName);
    try {
      await lstat(lockPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (await isProfileLockHeld(lockPath, open)) return true;
  }
  return false;
}

export async function assertProfileNotInUse(profileDirectory, fileSystem = {}) {
  if (await profileLockIsHeld(profileDirectory, fileSystem)) {
    throw profileInUseError(profileDirectory);
  }
}

function isProfileInUseLaunchFailure(error) {
  const message = String(error?.message || error);
  return message.includes('Target page, context or browser has been closed')
    || /(?:profile|user data directory).*(?:in use|already running|locked)/i.test(message)
    || /(?:lockfile|Singleton(?:Lock|Cookie|Socket))/i.test(message);
}

export function translateProfileInUseError(error, profileDirectory, profileLockHeld = false) {
  return profileLockHeld || isProfileInUseLaunchFailure(error)
    ? profileInUseError(profileDirectory)
    : error;
}

function isLaunchTimeout(error) {
  const message = String(error?.message || error);
  return error?.name === 'TimeoutError'
    || error?.code === 'ETIMEDOUT'
    || /launchPersistentContext.*(?:timeout|timed out)/i.test(message);
}

export async function launchContext(chromeExecutable, profileDirectory, arm, {
  chromium,
  lstat = fs.lstat,
  open = fs.open,
} = {}) {
  const browserType = chromium ?? await playwrightChromium();
  try {
    return await browserType.launchPersistentContext(profileDirectory, {
      executablePath: chromeExecutable,
      ...launchOptionsForArm(arm),
    });
  } catch (error) {
    const translated = translateProfileInUseError(error, profileDirectory);
    if (translated !== error) throw translated;
    if (!isLaunchTimeout(error)) throw error;
    throw translateProfileInUseError(
      error,
      profileDirectory,
      await profileLockIsHeld(profileDirectory, { lstat, open }),
    );
  }
}

async function launchMeasurementContext(chromeExecutable, profileDirectory, arm) {
  const context = await launchContext(chromeExecutable, profileDirectory, arm);
  await context.addInitScript({ content: DOCUMENT_START_SILENCE_SOURCE });
  await context.addInitScript({ content: probeSourceForArm(arm) });
  await clearBrowserCache(context);
  return context;
}

async function launchLoginContext(chromeExecutable, profileDirectory) {
  const context = await launchContext(chromeExecutable, profileDirectory, 'extension-off');
  await context.addInitScript({ content: DOCUMENT_START_SILENCE_SOURCE });
  return context;
}

async function launchSelfCheckContext(chromeExecutable, profileDirectory) {
  const context = await launchContext(chromeExecutable, profileDirectory, 'extension-on');
  await context.addInitScript({ content: DOCUMENT_START_SILENCE_SOURCE });
  return context;
}

async function extensionIdFor(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
  if (match === null) throw new Error('EXTENSION_ID_INVALID: service worker URL is not an extension URL');
  return match[1];
}

async function readExtensionMaxEventId(context, extensionId) {
  const maxEventId = await readMaxEventId(context, extensionId);
  if (!Number.isInteger(maxEventId) || maxEventId < 0) throw new Error('EXTENSION_LOG_INVALID: maxEventId is invalid');
  return maxEventId;
}

function pageHasVideo() {
  const videos = [...document.querySelectorAll('video')];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      if (iframe.contentDocument !== null) videos.push(...iframe.contentDocument.querySelectorAll('video'));
    } catch (error) {
      console.error('[stall-ab] same-origin video scan failed', error);
    }
  }
  return videos.length > 0;
}

function extensionInjectionReady() {
  const shimMarkerIsObject = window.__smoothBufferShim !== null
    && typeof window.__smoothBufferShim === 'object'
    && Array.isArray(window.__smoothBufferShim) === false;
  const removeSource = typeof SourceBuffer === 'undefined'
    ? undefined
    : SourceBuffer.prototype?.remove?.toString();
  return shimMarkerIsObject
    && typeof removeSource === 'string'
    && removeSource.includes('[native code]') === false;
}

async function assertPageExtensionState(page, arm) {
  if (arm === 'extension-on') {
    try {
      await page.waitForFunction(extensionInjectionReady, undefined, {
        timeout: extensionInjectionWaitMilliseconds,
      });
    } catch (error) {
      const state = await page.evaluate(extensionInjectionState);
      assertExtensionInjection(arm, state);
      throw new BlockedError(
        `EXTENSION_INJECTION_MISSING: extension-on injection probe timed out (${error.message})`,
      );
    }
  }
  return assertExtensionInjection(arm, await page.evaluate(extensionInjectionState));
}

async function assertPageReachable(response) {
  if (response === null || response.status() >= 400) {
    throw new BlockedError(`BILIBILI_UNREACHABLE: page response status ${response?.status() ?? 'missing'}`);
  }
}

async function assertSignedInAndReachable(page, response) {
  await assertPageReachable(response);
  const state = await page.evaluate(() => {
    const currentUrl = location.href;
    const loginRedirect = /passport\.bilibili\.com|\/login(?:[/?#]|$)/i.test(currentUrl);
    const loginPrompt = [...document.querySelectorAll('a,button')].some((element) => {
      const text = element.textContent?.trim() || '';
      const href = element instanceof HTMLAnchorElement ? element.href : '';
      const visible = element.getClientRects().length > 0;
      return visible && text.includes('登录') && /login|passport/i.test(href || element.className || '');
    });
    return { loginRedirect, loginPrompt };
  });
  if (state.loginRedirect || state.loginPrompt) {
    throw new BlockedError('BILIBILI_SIGNED_OUT: the supplied profile is not signed in');
  }
}

async function loadPlaybackPage(page, bvid, arm) {
  const url = `https://www.bilibili.com/video/${bvid}`;
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    throw new BlockedError(`BILIBILI_UNREACHABLE: ${error.message}`);
  }
  await assertSignedInAndReachable(page, response);
  await assertPageExtensionState(page, arm);
  try {
    await page.waitForFunction(pageHasVideo, undefined, { timeout: 45000 });
  } catch (error) {
    throw new BlockedError(`BILIBILI_VIDEO_MISSING: no native video became available (${error.message})`);
  }
}

async function startPlayback(page, rate) {
  const state = await page.evaluate((playbackRate) => {
    const videos = [...document.querySelectorAll('video')];
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument !== null) videos.push(...iframe.contentDocument.querySelectorAll('video'));
      } catch (error) {
        console.error('[stall-ab] same-origin playback scan failed', error);
      }
    }
    const video = videos.sort((left, right) =>
      (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    video.muted = true;
    video.volume = 0;
    video.playbackRate = playbackRate;
    return video.play().then(() => ({ paused: video.paused, playbackRate: video.playbackRate }));
  }, rate).catch((error) => {
    throw new BlockedError(`BILIBILI_PLAY_FAILED: ${error.message}`);
  });
  if (state.paused !== false || state.playbackRate !== rate) {
    throw new BlockedError('BILIBILI_PLAY_NOT_RUNNING: native video did not enter the requested rate');
  }
  try {
    await page.waitForFunction((playbackRate) => {
      const videos = [...document.querySelectorAll('video')];
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          if (iframe.contentDocument !== null) videos.push(...iframe.contentDocument.querySelectorAll('video'));
        } catch (error) {
          console.error('[stall-ab] same-origin rate scan failed', error);
        }
      }
      return videos.some((video) => video.paused === false && video.playbackRate === playbackRate);
    }, rate, { timeout: 15000 });
  } catch (error) {
    throw new BlockedError(`BILIBILI_PLAY_NOT_RUNNING: ${error.message}`);
  }
}

async function collectProbeRecords(page) {
  const frames = await Promise.all(page.frames().map(async (frame) => frame.evaluate(() => ({
    info: window.__stallProbe?.info(),
    records: window.__stallProbe?.records() || [],
  }))));
  const candidates = frames
    .map((value, index) => ({ ...value, frame: page.frames()[index] }))
    .filter(({ info, records }) => info?.hasVideo === true && records.length > 0)
    .sort((left, right) => (right.info.area - left.info.area) || (right.records.length - left.records.length));
  if (candidates.length === 0) throw new BlockedError('STALL_PROBE_EMPTY: no instrumented native video records');
  return candidates[0].frame.evaluate(() => window.__stallProbe.stop());
}

async function resetStallProbes(page) {
  const reset = await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    if (window.__stallProbe?.info().hasVideo !== true) return false;
    window.__stallProbe.reset();
    return true;
  })));
  if (!reset.some(Boolean)) throw new BlockedError('STALL_PROBE_EMPTY: no instrumented native video to reset');
}

function assertSafePayload(payload, pathName = 'payload') {
  if (payload === null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((value, index) => assertSafePayload(value, `${pathName}[${index}]`));
    return;
  }
  for (const [field, value] of Object.entries(payload)) {
    if (forbiddenPayloadField.test(field)) {
      throw new Error(`REDACTION_ASSERTION_FAILED: forbidden field ${pathName}.${field}`);
    }
    assertSafePayload(value, `${pathName}.${field}`);
  }
}

export { assertSafePayload };

async function writeJsonLines(filePath, values) {
  assertSafePayload(values);
  const content = values.map((value) => `${JSON.stringify(value)}\n`).join('');
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath, value) {
  assertSafePayload(value);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runArm({ arm, options, chromeExecutable, outputDirectory }) {
  await assertProfileNotInUse(options.profile);
  await clearProfileMediaCache(options.profile);
  const context = await launchMeasurementContext(chromeExecutable, options.profile, arm);
  let page;
  try {
    let extensionId;
    let initialAfterEventId = 0;
    page = await context.newPage();
    await loadPlaybackPage(page, options.bv, arm);
    if (arm === 'extension-on') {
      extensionId = await extensionIdFor(context);
      initialAfterEventId = await readExtensionMaxEventId(context, extensionId);
    }
    await startPlayback(page, options.rate);
    await resetStallProbes(page);
    await page.waitForTimeout(options.seconds * 1000);
    const records = await collectProbeRecords(page);
    assertSafePayload(records);
    const metric = computeStallScore(records, VOD_CONFIG.stableBufferSeconds);
    const extensionEvents = arm === 'extension-on'
      ? (await readStoredEvents(context, extensionId, initialAfterEventId)).events
      : undefined;
    assertSafePayload(metric);
    if (extensionEvents !== undefined) assertSafePayload(extensionEvents);
    await writeJsonLines(path.join(outputDirectory, `${arm}.probe.jsonl`), records);
    await writeJson(path.join(outputDirectory, `${arm}.metric.json`), metric);
    if (extensionEvents !== undefined) {
      await writeJsonLines(
        path.join(outputDirectory, `${arm}.extlog.jsonl`),
        extensionEvents.map((event) => ({ recordType: 'event', ...event })),
      );
    }
    return metric;
  } finally {
    await page?.close();
    await context.close();
  }
}

function randomizeArms(arms) {
  const randomized = [...arms];
  if (crypto.randomInt(2) === 1) randomized.reverse();
  return randomized;
}

function gateFor(metrics) {
  const extensionOn = metrics['extension-on'];
  const extensionOff = metrics['extension-off'];
  return extensionOn.reproduced
    && extensionOn.stalledWallMs >= extensionOff.stalledWallMs * 2;
}

async function runMeasurement(options) {
  requireWindowsNode();
  const chromeExecutable = await resolveChromeExecutable();
  await assertExtensionBuild();
  await assertProfileDirectory(options.profile);
  await assertProfileNotInUse(options.profile);
  const outputDirectory = path.resolve(options.out);
  await assertOutputDirectoryDoesNotExist(outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: true });
  const metrics = {};
  const armOrder = randomizeArms(options.arms);
  for (const arm of armOrder) {
    metrics[arm] = await runArm({ arm, options, chromeExecutable, outputDirectory });
  }
  const comparison = {
    'extension-on': metrics['extension-on'],
    'extension-off': metrics['extension-off'],
    gate: gateFor(metrics),
  };
  await writeJson(path.join(outputDirectory, 'compare.json'), comparison);
  console.log(`stall A/B complete: gate=${comparison.gate}`);
}

async function runLogin(options) {
  requireWindowsNode();
  const chromeExecutable = await resolveChromeExecutable();
  await fs.mkdir(options.profile, { recursive: true });
  await assertProfileNotInUse(options.profile);
  const context = await launchLoginContext(chromeExecutable, options.profile);
  const page = await context.newPage();
  try {
    let response;
    try {
      response = await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      throw new BlockedError(`BILIBILI_UNREACHABLE: ${error.message}`);
    }
    await assertPageReachable(response);
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await readline.question('Sign in to Bilibili in the browser, then press Enter here.\n');
    } finally {
      readline.close();
    }
    await assertSignedInAndReachable(page, await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }));
    console.log('login profile ready');
  } finally {
    await page.close();
    await context.close();
  }
}

async function runSelfCheck(options) {
  requireWindowsNode();
  const chromeExecutable = await resolveChromeExecutable();
  await assertExtensionBuild();
  if (options.profile === undefined) {
    throw new Error('ENV_PROFILE_MISSING: --profile is required for self-check');
  }
  await assertProfileDirectory(options.profile);
  await assertProfileNotInUse(options.profile);
  const context = await launchSelfCheckContext(chromeExecutable, options.profile);
  let page;
  try {
    page = await context.newPage();
    let response;
    try {
      response = await page.goto(selfCheckUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      throw new BlockedError(`BILIBILI_UNREACHABLE: ${error.message}`);
    }
    await assertPageReachable(response);
    await assertPageExtensionState(page, 'extension-on');
  } finally {
    await page?.close();
    await context.close();
  }
  console.log(
    `self-check passed: Windows Node, Chrome ${path.win32.basename(chromeExecutable)}, `
    + 'profile directory, extension build, profile-installed extension injection',
  );
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.selfCheck) return runSelfCheck(options);
  if (options.login) return runLogin(options);
  return runMeasurement(options);
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.name === 'BlockedError' ? 'BLOCKED' : 'ERROR'}: ${error.message || error}`);
    process.exitCode = 1;
  });
}
