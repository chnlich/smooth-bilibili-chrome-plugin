import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'probe-bilibili-report.json');

const VIDEO_URL = process.env.PROBE_VIDEO_URL || 'https://www.bilibili.com/video/BV1ohQVBFEsh';
const LIVE_URL = process.env.PROBE_LIVE_URL || 'https://live.bilibili.com/6363772';
const BUFFER_SAMPLE_INTERVAL_MS = 1000;
const BUFFER_SAMPLE_COUNT = 30;
const LIVE_OBSERVE_SECONDS = 40;
const STALL_INTERRUPT_MS = 4000;
const STALL_RECOVERY_MS = 5000;
const PAGE_SETTLE_MS = 15000;

const CHROME_EXECUTABLE_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const USER_DATA_DIR = process.env.PROBE_USER_DATA_DIR || 'C:\\Users\\chnli\\.bilibili-probe\\profile';

function resolveChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return undefined;
}

const auditInit = () => {
  const media = new Set();
  const writes = [];
  const events = [];
  let quietDepth = 0;
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    media.add(element);
    quietDepth += 1;
    try { element.muted = true; element.volume = 0; } finally { quietDepth -= 1; }
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
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  for (const [name, original] of [['play', originalPlay], ['pause', originalPause]]) {
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true, writable: true,
      value(...args) {
        writes.push({ kind: 'call', name, t: Math.round(performance.now()) });
        silence(this);
        return original.apply(this, args);
      },
    });
  }
  for (const name of ['currentTime', 'playbackRate', 'muted', 'volume', 'src']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
    if (descriptor?.set === undefined) continue;
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true, enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        writes.push({ kind: 'set', name, value: typeof value === 'object' ? '<obj>' : String(value).slice(0, 64), t: Math.round(performance.now()) });
        return descriptor.set.call(this, value);
      },
    });
  }
  const recordEvent = (type, video) => {
    events.push({
      type,
      t: Math.round(performance.now()),
      currentTime: Number.isFinite(video?.currentTime) ? video.currentTime : null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      playbackRate: Number.isFinite(video?.playbackRate) ? video.playbackRate : null,
    });
  };
  for (const type of ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing','pause','waiting','stalled','progress','timeupdate','seeking','seeked','ratechange','volumechange','durationchange','resize','suspend','emptied','abort','error','ended']) {
      document.addEventListener(type, (event) => {
        const target = event.target;
        if (target instanceof HTMLVideoElement) recordEvent(type, target);
      }, true);
    }
  window.__probeAudit = {
    media: () => [...media].map((element) => ({ muted: element.muted, volume: element.volume, src: (element.currentSrc || element.src || '').slice(0, 96) })),
    writes: () => writes.slice(),
    events: () => events.slice(),
    silence: () => { scan(document); return [...media].map((element) => ({ muted: element.muted, volume: element.volume })); },
  };
};

function readRanges(ranges) {
  if (ranges === undefined || ranges === null) return null;
  try {
    const out = [];
    for (let i = 0; i < ranges.length; i += 1) out.push({ start: ranges.start(i), end: ranges.end(i) });
    return out;
  } catch { return '未提供'; }
}

function forwardBufferSeconds(video) {
  const t = video.currentTime;
  if (!Number.isFinite(t)) return '未提供';
  const buffered = readRanges(video.buffered);
  if (!Array.isArray(buffered)) return '未提供';
  const range = buffered.find((r) => r.start <= t && t <= r.end);
  return range === undefined ? 0 : Math.max(0, range.end - t);
}

// Self-contained mediaFacts for page.evaluate — inlines readRanges/forwardBuffer.
const mediaFactsSource = `((video) => {
  const readRanges = (ranges) => {
    if (ranges === undefined || ranges === null) return null;
    try {
      const out = [];
      for (let i = 0; i < ranges.length; i += 1) out.push({ start: ranges.start(i), end: ranges.end(i) });
      return out;
    } catch { return '未提供'; }
  };
  const forwardBufferSeconds = (v) => {
    const t = v.currentTime;
    if (!Number.isFinite(t)) return '未提供';
    const buffered = readRanges(v.buffered);
    if (!Array.isArray(buffered)) return '未提供';
    const range = buffered.find((r) => r.start <= t && t <= r.end);
    return range === undefined ? 0 : Math.max(0, range.end - t);
  };
  if (video === null) return { present: false };
  return {
    present: true,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : '未提供',
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState,
    networkState: video.networkState,
    duration: Number.isFinite(video.duration) ? video.duration : '未提供',
    playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : '未提供',
    resolution: [video.videoWidth, video.videoHeight],
    buffered: readRanges(video.buffered),
    seekable: readRanges(video.seekable),
    forwardBufferSeconds: forwardBufferSeconds(video),
    currentSrc: (() => {
      const s = video.currentSrc || video.src || '';
      if (!URL.canParse(s)) return '未提供';
      const u = new URL(s);
      return u.origin + u.pathname;
    })(),
  };
})`;

function blocked(kind, reason, extra = {}) {
  return { kind, status: 'BLOCKED', reason, ...extra };
}

function describeValue(value) {
  if (value === undefined) return { kind: 'undefined' };
  if (value === null) return { kind: 'null' };
  if (typeof value === 'function') return { kind: 'function', name: value.name || '<anon>' };
  if (typeof value !== 'object') return { kind: typeof value, value };
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  const proto = Object.getPrototypeOf(value);
  return {
    kind: 'object',
    ctor: proto?.constructor?.name || '<unknown>',
    keys: Object.keys(value).slice(0, 64),
  };
}

async function probeVideo(page) {
  const startedAt = Date.now();
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(PAGE_SETTLE_MS);
  const present = await page.evaluate(() => document.querySelector('video') !== null);
  if (!present) return blocked('video', '页面没有可读取的 video 元素', { url: VIDEO_URL, elapsedMs: Date.now() - startedAt });

  const playerShape = await page.evaluate(() => {
    const result = { exists: false };
    const player = globalThis.player;
    if (player === undefined || player === null) return result;
    result.exists = true;
    result.typeof = typeof player;
    result.ctor = player?.constructor?.name || '<unknown>';
    result.keys = Object.keys(player).slice(0, 128);
    const core = typeof player.__core === 'function' ? (() => { try { return player.__core(); } catch (e) { return { __error: String(e?.message || e) }; } })() : undefined;
    result.hasCoreFunction = typeof player.__core === 'function';
    if (core !== undefined) {
      result.coreTypeof = typeof core;
      if (core && typeof core === 'object' && !core.__error) {
        result.coreKeys = Object.keys(core).slice(0, 128);
        result.coreHasSetStableBufferTime = typeof core.setStableBufferTime === 'function';
        result.coreMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(core) || {}).concat(Object.keys(core)).filter((k) => typeof core[k] === 'function').slice(0, 128);
      } else if (core?.__error) {
        result.coreError = core.__error;
      }
    }
    return result;
  });

  if (!playerShape.exists) return blocked('video', 'window.player 不存在', { url: VIDEO_URL, elapsedMs: Date.now() - startedAt, playerShape });
  if (!playerShape.hasCoreFunction) return blocked('video', 'window.player.__core 不是函数', { url: VIDEO_URL, elapsedMs: Date.now() - startedAt, playerShape });

  const coreUsable = playerShape.coreHasSetStableBufferTime === true;
  if (!coreUsable) return blocked('video', 'core.setStableBufferTime 不存在或不是函数', { url: VIDEO_URL, elapsedMs: Date.now() - startedAt, playerShape });

  const callResult = await page.evaluate(() => {
    try {
      const core = globalThis.player.__core();
      core.setStableBufferTime(120);
      return { ok: true, returned: describeReturnValue(core.setStableBufferTime) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    function describeReturnValue(fn) {
      try { const r = fn.length; return { length: r }; } catch { return {}; }
    }
  });

  const samples = [];
  for (let i = 0; i < BUFFER_SAMPLE_COUNT; i += 1) {
    if (i > 0) await page.waitForTimeout(BUFFER_SAMPLE_INTERVAL_MS);
    const facts = await page.evaluate((factsSrc) => {
      const mediaFacts = eval(factsSrc);
      const video = document.querySelector('video');
      if (video === null) return null;
      return {
        t: performance.now(),
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        forward: (() => {
          const t = video.currentTime;
          if (!Number.isFinite(t)) return '未提供';
          const b = mediaFacts(video);
          return b.forwardBufferSeconds;
        })(),
        buffered: mediaFacts(video).buffered,
        readyState: video.readyState,
        paused: video.paused,
      };
    }, mediaFactsSource);
    samples.push(facts);
  }

  const facts = await page.evaluate((factsSrc) => {
    const mediaFacts = eval(factsSrc);
    return mediaFacts(document.querySelector('video'));
  }, mediaFactsSource);

  return {
    kind: 'video',
    status: 'PASS',
    url: VIDEO_URL,
    elapsedMs: Date.now() - startedAt,
    playerShape,
    setStableBufferTimeCall: callResult,
    bufferSamples: samples,
    finalMedia: facts,
    note: '主动调用 setStableBufferTime(120) 属探测行为；bufferSamples 证明调用后前向缓冲是否真涨',
  };
}

async function findVideoFrame(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const has = await frame.evaluate(() => document.querySelector('video') !== null);
        if (has) return frame;
      } catch { /* frame detached */ }
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

const liveEventRecorderSource = `(() => {
  const events = [];
  const types = ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing','pause','waiting','stalled','progress','timeupdate','seeking','seeked','ratechange','volumechange','durationchange','resize','suspend','emptied','abort','error','ended'];
  for (const type of types) {
    document.addEventListener(type, (event) => {
      const v = event.target;
      if (!(v instanceof HTMLVideoElement)) return;
      events.push({ type, t: Math.round(performance.now()), currentTime: Number.isFinite(v.currentTime) ? v.currentTime : null, paused: v.paused, readyState: v.readyState, playbackRate: Number.isFinite(v.playbackRate) ? v.playbackRate : null });
    }, true);
  }
  return {
    events: () => events.slice(),
    count: () => events.length,
    filter: (types) => events.filter((e) => types.includes(e.type)),
  };
})`;

async function probeLive(page) {
  const startedAt = Date.now();
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const frame = await findVideoFrame(page, 30000);
  if (frame === undefined) {
    const diag = await page.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      frames: page.frames?.().length,
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 5),
      title: document.title,
    })).catch(() => null);
    return blocked('live', '直播页面 30 秒内没有可读取的 video 元素（含 iframe）', { url: LIVE_URL, elapsedMs: Date.now() - startedAt, diag });
  }
  const frameUrl = frame.url();
  report.liveFrameUrl = frameUrl;

  await frame.evaluate((src) => { window.__liveRecorder = eval(src); }, liveEventRecorderSource);
  await frame.evaluate(() => { for (const v of document.querySelectorAll('video')) { v.muted = true; v.volume = 0; } }).catch(() => {});

  const firstFrame = await frame.evaluate(() => {
    const video = document.querySelector('video');
    if (video === null) return null;
    return {
      readyState: video.readyState,
      paused: video.paused,
      hasFrame: video.videoWidth > 0 && video.videoHeight > 0,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
    };
  });
  if (!firstFrame?.hasFrame) return blocked('live', '直播 video 首帧不可读', { url: LIVE_URL, frameUrl, elapsedMs: Date.now() - startedAt, firstFrame });

  const seekableSeries = [];
  for (let i = 0; i <= LIVE_OBSERVE_SECONDS; i += 5) {
    if (i > 0) await page.waitForTimeout(5000);
    seekableSeries.push(await frame.evaluate(() => {
      const video = document.querySelector('video');
      if (video === null) return null;
      const read = (r) => { if (r === undefined || r === null) return null; try { const o = []; for (let i = 0; i < r.length; i += 1) o.push({ start: r.start(i), end: r.end(i) }); return o; } catch { return '未提供'; } };
      const seekable = read(video.seekable);
      const buffered = read(video.buffered);
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
      let delay = '未提供';
      if (Array.isArray(seekable) && seekable.length > 0 && currentTime !== null) {
        const end = seekable[seekable.length - 1].end;
        if (Number.isFinite(end)) delay = end - currentTime;
      }
      return { t: performance.now(), currentTime, seekable, buffered, delay };
    }).catch((e) => ({ error: String(e?.message || e) })));
  }

  const candidates = await frame.evaluate(() => {
    const names = ['__PLAYER_GLOBAL_INSTANCE__', 'EmbedPlayer', 'livePlayer', 'player'];
    const result = {};
    for (const name of names) {
      const value = name === 'EmbedPlayer' ? globalThis.EmbedPlayer : globalThis[name];
      if (value === undefined || value === null) { result[name] = { exists: false }; continue; }
      const target = name === 'EmbedPlayer' ? value.instance : value;
      const entry = { exists: true, typeof: typeof target };
      if (target && typeof target === 'object') {
        entry.ctor = target?.constructor?.name || '<unknown>';
        const allKeys = new Set([...Object.keys(target), ...Object.getOwnPropertyNames(Object.getPrototypeOf(target) || {})]);
        entry.allMethods = [...allKeys].filter((k) => { try { return typeof target[k] === 'function'; } catch { return false; } }).slice(0, 256);
        entry.hasSetAutoSyncProgressCfg = typeof target.setAutoSyncProgressCfg === 'function';
        entry.hasSetAutoDiscardFrameCfg = typeof target.setAutoDiscardFrameCfg === 'function';
        entry.hasDiscardFrame = typeof target.discardFrame === 'function';
        entry.hasSetChasingFrameThreshold = typeof target.setChasingFrameThreshold === 'function';
        entry.hasGetChasingFrameThreshold = typeof target.getChasingFrameThreshold === 'function';
        entry.hasRemainBufferLength = typeof target.remainBufferLength === 'function';
        entry.catchupLikeMethods = [...allKeys].filter((k) => /catchup|sync|discard|speed|rate|progress|catch|up|fastforw|chas|thresh/i.test(k)).slice(0, 64);
        try { if (typeof target.setChasingFrameThreshold === 'function') entry.setChasingFrameThresholdLength = target.setChasingFrameThreshold.length; } catch { /* ignore */ }
        try { if (typeof target.discardFrame === 'function') entry.discardFrameLength = target.discardFrame.length; } catch { /* ignore */ }
      }
      result[name] = entry;
    }
    return result;
  }).catch((e) => ({ error: String(e?.message || e) }));

  const chasingThreshold = await frame.evaluate(() => {
    const targets = [globalThis.EmbedPlayer?.instance, globalThis.livePlayer].filter((t) => t && typeof t === 'object');
    for (const target of targets) {
      try {
        if (typeof target.getChasingFrameThreshold === 'function') {
          const value = target.getChasingFrameThreshold();
          return { ok: true, value: typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value, source: target.constructor?.name };
        }
      } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    }
    return { ok: false, error: 'no getChasingFrameThreshold on candidates' };
  }).catch((e) => ({ ok: false, error: String(e?.message || e) }));

  const before = await frame.evaluate((factsSrc) => eval(factsSrc)(document.querySelector('video')), mediaFactsSource).catch((e) => ({ error: String(e?.message || e) }));
  const context = page.context();
  let during = null;
  let offlineError;
  let duringEventsBefore = 0;
  try {
    duringEventsBefore = await frame.evaluate(() => window.__liveRecorder.count()).catch(() => 0);
    await context.setOffline(true);
    await page.waitForTimeout(STALL_INTERRUPT_MS);
    during = await frame.evaluate((factsSrc) => eval(factsSrc)(document.querySelector('video')), mediaFactsSource).catch((e) => ({ error: String(e?.message || e) }));
  } catch (e) {
    offlineError = String(e?.message || e);
  } finally {
    try { await context.setOffline(false); } catch (e) { offlineError = (offlineError ? `${offlineError}; restore: ` : 'restore: ') + String(e?.message || e); }
  }

  if (offlineError !== undefined) {
    return blocked('live', `离线中断出错：${offlineError}`, { url: LIVE_URL, frameUrl, elapsedMs: Date.now() - startedAt, before, firstFrame, seekableSeries, candidates, chasingThreshold });
  }

  await page.waitForTimeout(STALL_RECOVERY_MS);
  const after = await frame.evaluate((factsSrc) => eval(factsSrc)(document.querySelector('video')), mediaFactsSource).catch((e) => ({ error: String(e?.message || e) }));
  const duringEvents = await frame.evaluate((b) => window.__liveRecorder.events().slice(b), duringEventsBefore).catch(() => []);
  const afterEventsBefore = duringEvents.length + duringEventsBefore;
  await page.waitForTimeout(2000);
  const recoveryEvents = await frame.evaluate((b) => window.__liveRecorder.events().slice(b), afterEventsBefore).catch(() => []);

  const stallObserved = duringEvents.some((e) => ['waiting', 'stalled'].includes(e.type))
    || (typeof before?.currentTime === 'number' && typeof during?.currentTime === 'number' && during.currentTime <= before.currentTime + 0.1);
  const naturalCatchupEvents = await frame.evaluate(() => window.__liveRecorder.filter(['seeking', 'seeked', 'ratechange'])).catch(() => null);
  return {
    kind: 'live',
    status: stallObserved ? 'PASS' : 'BLOCKED',
    url: LIVE_URL,
    frameUrl,
    elapsedMs: Date.now() - startedAt,
    firstFrame,
    seekableSeries,
    candidates,
    chasingThreshold,
    before,
    during,
    after,
    stallObserved,
    duringEvents,
    recoveryEvents,
    naturalCatchupEvents,
    note: 'seekableSeries 展示直播 seekable 形态；candidates 展示候选对象与方法；duringEvents/recoveryEvents 展示真实卡顿与恢复事件序列；naturalCatchupEvents 展示自然播放中的 seeking/ratechange',
  };
}

const browserArgs = [
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--no-pings',
];

const executablePath = resolveChromeExecutable();
const report = {
  generatedAt: new Date().toISOString(),
  videoUrl: VIDEO_URL,
  liveUrl: LIVE_URL,
  browser: { executablePath, userDataDir: USER_DATA_DIR, headless: false, muteAudio: true },
  results: [],
};

if (executablePath === undefined) {
  report.results.push({ kind: 'video', status: 'BLOCKED', reason: '未找到 Chrome 可执行文件' });
  report.results.push({ kind: 'live', status: 'BLOCKED', reason: '未找到 Chrome 可执行文件' });
} else {
  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      executablePath,
      headless: false,
      args: browserArgs,
    });
    await context.addInitScript({ content: `(${auditInit.toString()})()` });
    const skipVideo = process.env.PROBE_SKIP_VIDEO === '1';
    if (!skipVideo) {
      const videoPage = await context.newPage();
      const videoResult = await probeVideo(videoPage).catch((e) => blocked('video', `探测异常：${String(e?.message || e)}`));
      report.results.push(videoResult);
      await videoPage.close().catch(() => {});
    } else {
      report.results.push({ kind: 'video', status: 'SKIPPED', reason: 'PROBE_SKIP_VIDEO=1' });
    }
    const livePage = await context.newPage();
    const liveResult = await probeLive(livePage).catch((e) => blocked('live', `探测异常：${String(e?.message || e)}`));
    report.results.push(liveResult);
    const audit = await livePage.evaluate(() => ({
      media: window.__probeAudit?.media?.() || [],
      writes: window.__probeAudit?.writes?.() || [],
    })).catch(() => null);
    if (audit) report.ownershipAudit = audit;
    await livePage.close().catch(() => {});
  } finally {
    await context?.close().catch(() => {});
  }
}

await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
