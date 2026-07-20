import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const reportDirectory = path.join(root, 'reports');
const reportPath = path.join(reportDirectory, 'extension-e2e-report.json');
const execFileAsync = promisify(execFile);
const scenarioFilter = process.env.E2E_ONLY;

function makeMp4Box(type, payload = new Uint8Array()) {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength, false);
  bytes.set([...type].map((character) => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}

function makeMuxedInitSegment() {
  const handlerBox = (handler) => {
    const payload = new Uint8Array(12);
    payload.set([...handler].map((character) => character.charCodeAt(0)), 8);
    return makeMp4Box('hdlr', payload);
  };
  const videoTrack = makeMp4Box('trak', makeMp4Box('mdia', handlerBox('vide')));
  const audioTrack = makeMp4Box('trak', makeMp4Box('mdia', handlerBox('soun')));
  const moov = makeMp4Box('moov', new Uint8Array([...videoTrack, ...audioTrack]));
  return Buffer.from(new Uint8Array([...makeMp4Box('ftyp', new Uint8Array(4)), ...moov]));
}

const MUXED_INIT_SEGMENT = makeMuxedInitSegment();
const VIDEO_ONLY_INIT_SEGMENT = (() => {
  const payload = new Uint8Array(12);
  payload.set([...('vide')].map((character) => character.charCodeAt(0)), 8);
  const handler = makeMp4Box('hdlr', payload);
  const track = makeMp4Box('trak', makeMp4Box('mdia', handler));
  return Buffer.from(new Uint8Array([
    ...makeMp4Box('ftyp', new Uint8Array(4)),
    ...makeMp4Box('moov', track),
  ]));
})();

function audioGuard() {
  const selector = 'video, audio';
  const observedRoots = new WeakSet();
  const isNode = (value) => value instanceof Node;
  const mediaInRoot = (rootNode) => {
    const media = [];
    if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode.matches(selector)) {
      media.push(rootNode);
    }
    media.push(...rootNode.querySelectorAll(selector));
    return media;
  };
  const silence = (media) => {
    media.muted = true;
    media.volume = 0;
  };
  const scanRoot = (rootNode) => {
    if (rootNode.nodeType !== Node.ELEMENT_NODE
        && rootNode.nodeType !== Node.DOCUMENT_NODE
        && rootNode.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    for (const media of mediaInRoot(rootNode)) {
      silence(media);
    }
    for (const element of rootNode.querySelectorAll('*')) {
      if (element.shadowRoot !== null) {
        install(element.shadowRoot);
        scanRoot(element.shadowRoot);
      }
    }
  };
  const install = (rootNode) => {
    if (observedRoots.has(rootNode)) {
      return;
    }
    observedRoots.add(rootNode);
    scanRoot(rootNode);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
          }
          scanRoot(node);
        }
      }
    });
    observer.observe(rootNode, { childList: true, subtree: true });
  };
  const patchInsertion = (prototype, name, nodesFromArguments) => {
    const original = prototype[name];
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value(...args) {
        for (const node of nodesFromArguments(args, this)) {
          if (isNode(node)) {
            scanRoot(node);
          }
        }
        const result = original.apply(this, args);
        scanRoot(this);
        return result;
      },
    });
  };
  patchInsertion(Node.prototype, 'appendChild', ([node]) => [node]);
  patchInsertion(Node.prototype, 'insertBefore', ([node]) => [node]);
  patchInsertion(Node.prototype, 'replaceChild', ([node]) => [node]);
  patchInsertion(Element.prototype, 'append', (nodes) => nodes);
  patchInsertion(Element.prototype, 'prepend', (nodes) => nodes);
  patchInsertion(Element.prototype, 'replaceChildren', (nodes) => nodes);
  patchInsertion(DocumentFragment.prototype, 'append', (nodes) => nodes);
  patchInsertion(DocumentFragment.prototype, 'prepend', (nodes) => nodes);
  patchInsertion(DocumentFragment.prototype, 'replaceChildren', (nodes) => nodes);
  patchInsertion(Element.prototype, 'before', (nodes) => nodes);
  patchInsertion(Element.prototype, 'after', (nodes) => nodes);
  patchInsertion(Element.prototype, 'replaceWith', (nodes) => nodes);
  const patchInnerHtml = (prototype) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
    Object.defineProperty(prototype, 'innerHTML', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(this, value);
        scanRoot(this);
      },
    });
  };
  patchInnerHtml(Element.prototype);
  patchInnerHtml(ShadowRoot.prototype);
  const originalInsertAdjacentHtml = Element.prototype.insertAdjacentHTML;
  Object.defineProperty(Element.prototype, 'insertAdjacentHTML', {
    configurable: true,
    writable: true,
    value(position, value) {
      const result = originalInsertAdjacentHtml.call(this, position, value);
      scanRoot(this.parentNode || this);
      return result;
    },
  });
  patchInsertion(ShadowRoot.prototype, 'append', (nodes) => nodes);
  patchInsertion(ShadowRoot.prototype, 'prepend', (nodes) => nodes);
  patchInsertion(ShadowRoot.prototype, 'replaceChildren', (nodes) => nodes);
  const originalAttachShadow = Element.prototype.attachShadow;
  Object.defineProperty(Element.prototype, 'attachShadow', {
    configurable: true,
    writable: true,
    value(options) {
      const shadow = originalAttachShadow.call(this, options);
      if (options?.mode === 'open') {
        install(shadow);
      }
      return shadow;
    },
  });
  const sync = () => {
    scanRoot(document);
  };
  const snapshotRoot = (rootNode, values) => {
    for (const media of mediaInRoot(rootNode)) {
      values.push({ muted: media.muted, volume: media.volume });
    }
    for (const element of rootNode.querySelectorAll('*')) {
      if (element.shadowRoot !== null) {
        snapshotRoot(element.shadowRoot, values);
      }
    }
  };
  const snapshot = () => {
    sync();
    const values = [];
    snapshotRoot(document, values);
    return values;
  };
  install(document);
  window.__bilibiliAudioGuard = {
    ready: true,
    snapshot,
    assertSilentBeforePlay() {
      const values = snapshot();
      if (!values.every((media) => media.muted === true && media.volume === 0)) {
        throw new Error(`audio guard violation before play: ${JSON.stringify(values)}`);
      }
      return values;
    },
  };
}

function createVodHtml(kind = 'applied') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>VOD test</title></head><body>
<script>
window.__bridgeTraffic = [];
document.addEventListener('bilibili-buffer:bridge-request-v1', (event) => {
  window.__bridgeTraffic.push(JSON.parse(event.detail));
});
const state = {
  kind: ${JSON.stringify(kind)},
  source: 'data:video/mp4;base64,AA==',
  currentTime: 10,
  paused: true,
  stable: [],
  playCalls: 0,
  pauseCalls: 0,
  core: undefined,
};
const createCore = (label) => {
  const core = {
    label,
    setStableBufferTime(value) {
      if (state.kind === 'failed') {
        throw new Error('deterministic setter failure');
      }
      state.stable.push({ label, value });
    },
  };
  if (state.kind === 'unsupported') {
    delete core.setStableBufferTime;
  }
  return core;
};
state.core = createCore('core-1');
const video = document.createElement('video');
video.src = state.source;
video.muted = true;
video.volume = 0;
video.play = () => {
  window.__bilibiliAudioGuard.assertSilentBeforePlay();
  state.playCalls += 1;
  state.paused = false;
  video.dispatchEvent(new Event('play'));
  return Promise.resolve();
};
video.pause = () => {
  state.pauseCalls += 1;
  state.paused = true;
  video.dispatchEvent(new Event('pause'));
};
state.video = video;
state.replaceCore = () => {
  state.core = createCore('core-' + (state.stable.length + 2));
};
state.replaceSource = (source) => {
  state.source = source === 'user-selected-source' ? 'data:video/mp4;base64,AQ==' : source;
  video.src = state.source;
};
state.userPause = () => video.pause();
state.userPlay = () => video.play();
state.userSeek = (value) => { state.currentTime = Number(value); };
state.setRate = (value) => { video.playbackRate = value; };
state.setQuality = (value) => { state.quality = value; video.quality = value; };
state.setAudio = (muted, volume) => { video.muted = muted; video.volume = volume; };
window.__fakeVodState = state;
window.player = { __core: () => state.core };
document.body.append(video);
</script>
</body></html>`;
}


function createLiveHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Live test</title></head><body>
<script>
window.__bridgeTraffic = [];
document.addEventListener('bilibili-buffer:bridge-request-v1', (event) => {
  window.__bridgeTraffic.push(JSON.parse(event.detail));
});
window.__fakeLiveState = { appended: [], playerCalls: [], objectUrls: [], playing: false };
let fakeUrlNumber = 0;
class FakeSourceBuffer extends EventTarget {
  constructor(video) { super(); this.video = video; this.updating = false; this.mode = 'segments'; }
  appendBuffer(bytes) {
    const text = new TextDecoder().decode(bytes);
    window.__fakeLiveState.appended.push(text);
    if (/^seg-\\d+$/.test(text)) this.video.__bufferEnd += 2;
    this.updating = false;
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
  remove() { this.updating = false; queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
}
class FakeMediaSource extends EventTarget {
  static isTypeSupported() { return true; }
  constructor() { super(); this.readyState = 'open'; this.video = document.querySelector('video'); }
  addSourceBuffer() { return new FakeSourceBuffer(this.video); }
  endOfStream() { this.readyState = 'ended'; }
}
window.MediaSource = FakeMediaSource;
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (value) => {
  const result = 'blob:fake-live-' + (++fakeUrlNumber);
  window.__fakeLiveState.objectUrls.push(result);
  return result;
};
URL.revokeObjectURL = () => {};
window.__createLiveVideo = () => {
  const video = document.createElement('video');
  video.id = 'test-live-video';
  video.muted = true;
  video.volume = 0;
  video.playbackRate = 1;
  video.__bufferEnd = 0;
  Object.defineProperty(video, 'buffered', { get() { return { length: 1, start: () => 0, end: () => this.__bufferEnd }; } });
  let fakeCurrentTime = 0;
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => fakeCurrentTime, set: (value) => { fakeCurrentTime = value; } });
  let fakePaused = true;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => fakePaused });
  video.play = () => { window.__bilibiliAudioGuard.assertSilentBeforePlay(); fakePaused = false; window.__fakeLiveState.playing = true; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
  video.pause = () => { fakePaused = true; window.__fakeLiveState.playing = false; video.dispatchEvent(new Event('pause')); };
  window.player = {
    setAutoSyncProgressCfg(value) { window.__fakeLiveState.playerCalls.push(['sync', value]); },
    setAutoDiscardFrameCfg(value) { window.__fakeLiveState.playerCalls.push(['discard', value]); },
    pause() { window.__fakeLiveState.playerCalls.push(['pause']); video.pause(); },
  };
  document.body.append(video);
  setInterval(() => {
    if (!fakePaused) { fakeCurrentTime += 0.25; video.dispatchEvent(new Event('timeupdate')); }
  }, 250);
};
</script>
</body></html>`;
}

function playInfoPayload() {
  return {
    code: 0,
    message: 'OK',
    data: {
      room_id: 6363772,
      playurl_info: {
        playurl: {
          stream: [{
            protocol_name: 'http_hls',
            format: [{
              format_name: 'fmp4',
              codec: [{
                codec_name: 'avc',
                current_qn: 250,
                accept_qn: [250],
                base_url: '/live/index.m3u8?',
                url_info: [
                  { host: 'https://cdn-a.bilivideo.com', extra: 'expires=1&sign=a' },
                  { host: 'https://cdn-b.bilivideo.com', extra: 'expires=1&sign=b' },
                ],
                session: 'extension-test-session',
                video_codecs: { base: 'avc1.4d401f' },
                audio_codecs: { base: 'mp4a.40.2' },
                description: '高清 720P',
              }],
            }],
          }],
        },
      },
    },
  };
}

const mediaPlaylist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
seg-100.m4s
#EXTINF:2,
seg-101.m4s
#EXTINF:2,
seg-102.m4s
#EXTINF:2,
seg-103.m4s
#EXTINF:2,
seg-104.m4s
`;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const CLEANUP_TIMEOUT_MILLISECONDS = 10000;

async function withCleanupTimeout(label, operation, timeoutMilliseconds = CLEANUP_TIMEOUT_MILLISECONDS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMilliseconds}ms`)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanupFailure(label, error) {
  return {
    label,
    message: error?.message || String(error),
    stack: error?.stack,
  };
}

async function runCleanupStep(failures, label, operation) {
  try {
    await withCleanupTimeout(label, operation);
  } catch (error) {
    failures.push(cleanupFailure(label, error));
  }
}

function throwCleanupFailures(failures) {
  if (failures.length === 0) {
    return;
  }
  throw new AggregateError(
    failures.map((failure) => new Error(`${failure.label}: ${failure.message}`)),
    'fixture cleanup failed',
  );
}

function collectDiagnostics(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.stack || error.message || String(error));
  });
  return { consoleErrors, pageErrors };
}

function collectRequestTimeline(page) {
  const requests = [];
  page.on('request', (request) => {
    requests.push({ url: request.url(), method: request.method(), startedAt: Date.now(), status: undefined });
  });
  page.on('response', (response) => {
    const entry = [...requests].reverse().find((request) => request.url === response.url() && request.status === undefined);
    if (entry !== undefined) {
      entry.status = response.status();
    }
  });
  return requests;
}

function matchesExpectedConsoleError(entry, matcher) {
  return matcher instanceof RegExp ? matcher.test(entry.text) : matcher(entry);
}

function assertDiagnostics(diagnostics, expectedErrorMatchers = []) {
  const expectedErrors = [];
  const unexpectedConsoleErrors = [];
  for (const entry of diagnostics.consoleErrors) {
    if (expectedErrorMatchers.some((matcher) => matchesExpectedConsoleError(entry, matcher))) {
      expectedErrors.push(entry);
    } else {
      unexpectedConsoleErrors.push(entry);
    }
  }
  assert.deepEqual(diagnostics.pageErrors, [], `unexpected page errors: ${JSON.stringify(diagnostics.pageErrors)}`);
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
  );
  return {
    expectedErrors,
    unexpectedConsoleErrors,
    pageErrors: diagnostics.pageErrors,
  };
}

async function prepareLocalBrowserLibraries() {
  const executable = chromium.executablePath();
  const ldd = await execFileAsync('ldd', [executable]);
  const missing = ldd.stdout
    .split('\n')
    .filter((line) => line.includes('not found'))
    .map((line) => line.trim().split(' ')[0])
    .filter(Boolean);
  if (missing.length === 0) {
    return undefined;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'smooth-bilibili-extension-libs-'));
  try {
    await execFileAsync('apt-get', ['download', 'libnspr4', 'libnss3', 'libasound2t64'], { cwd: directory });
    const packages = (await fs.readdir(directory)).filter((name) => name.endsWith('.deb'));
    const extractionDirectory = path.join(directory, 'root');
    await fs.mkdir(extractionDirectory);
    for (const packageName of packages) {
      await execFileAsync('dpkg-deb', ['-x', path.join(directory, packageName), extractionDirectory]);
    }
    const libraryDirectory = path.join(extractionDirectory, 'usr', 'lib', 'x86_64-linux-gnu');
    process.env.LD_LIBRARY_PATH = [libraryDirectory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error(`Chromium 缺少 ${missing.join(', ')}，无法准备任务内运行库: ${error.message || error}`);
  }
}

async function openPopup(context, extensionId, targetPage) {
  const popup = await context.newPage();
  const diagnostics = collectDiagnostics(popup);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector('input[data-preference="liveEnabled"]');
  if (targetPage !== undefined) {
    statusPopups.set(targetPage, popup);
    await targetPage.bringToFront();
  }
  return { popup, diagnostics };
}

const statusPopups = new WeakMap();

async function popupState(page) {
  const popup = statusPopups.get(page);
  assert.ok(popup !== undefined && !popup.isClosed(), 'status popup is not open for this tab');
  return popup.evaluate(() => {
    const value = (field) => document.querySelector(`[data-status-field="${field}"]`)?.textContent;
    const actions = Object.fromEntries(
      [...document.querySelectorAll('[data-actions] [data-action]')]
        .map((button) => [button.dataset.action, button.textContent]),
    );
    return {
      state: value('state'),
      mode: value('mode'),
      inventory: value('inventory'),
      delay: value('delay'),
      quality: value('quality'),
      speed: value('speed'),
      multiplier: value('multiplier'),
      stage: value('stage'),
      message: value('message'),
      actions,
      toggleLabel: actions.toggle,
      skipVisible: actions['skip-gap'] === undefined ? 'hidden' : 'visible',
      returnVisible: actions['return-live'] === undefined ? 'hidden' : 'visible',
    };
  });
}

async function panelState(page) {
  return popupState(page);
}

async function assertNestedShadowAudioGuard(page) {
  const result = await page.evaluate(() => {
    const host = document.createElement('section');
    document.body.append(host);
    host.innerHTML = '<video data-audio-guard="html"></video>';
    host.insertAdjacentHTML('beforeend', '<audio data-audio-guard="adjacent"></audio>');
    const htmlVideo = host.querySelector('[data-audio-guard="html"]');
    const adjacentAudio = host.querySelector('[data-audio-guard="adjacent"]');
    const firstShadow = host.attachShadow({ mode: 'open' });
    const firstVideo = document.createElement('video');
    const nestedHost = document.createElement('div');
    firstShadow.append(firstVideo, nestedHost);
    const firstImmediate = { muted: firstVideo.muted, volume: firstVideo.volume };
    firstVideo.play = () => {
      if (!firstVideo.muted || firstVideo.volume !== 0) throw new Error('first nested video was not muted synchronously');
      return Promise.resolve();
    };
    const secondShadow = nestedHost.attachShadow({ mode: 'open' });
    const secondAudio = document.createElement('audio');
    const secondVideo = document.createElement('video');
    secondShadow.append(secondAudio, secondVideo);
    const fragment = document.createDocumentFragment();
    const fragmentVideo = document.createElement('video');
    fragment.append(fragmentVideo);
    host.appendChild(fragment);
    const fragmentImmediate = { muted: fragmentVideo.muted, volume: fragmentVideo.volume };
    const siblingMarker = document.createElement('div');
    const replacementMarker = document.createElement('div');
    document.body.append(siblingMarker, replacementMarker);
    const beforeVideo = document.createElement('video');
    const afterAudio = document.createElement('audio');
    const replacementVideo = document.createElement('video');
    const replacementChildrenVideo = document.createElement('video');
    siblingMarker.before(beforeVideo);
    siblingMarker.after(afterAudio);
    replacementMarker.replaceWith(replacementVideo);
    host.replaceChildren(replacementChildrenVideo);
    const siblingImmediate = {
      before: { muted: beforeVideo.muted, volume: beforeVideo.volume },
      after: { muted: afterAudio.muted, volume: afterAudio.volume },
      replacement: { muted: replacementVideo.muted, volume: replacementVideo.volume },
      replaceChildren: { muted: replacementChildrenVideo.muted, volume: replacementChildrenVideo.volume },
    };
    const secondImmediate = {
      audio: { muted: secondAudio.muted, volume: secondAudio.volume },
      video: { muted: secondVideo.muted, volume: secondVideo.volume },
    };
    secondVideo.play = () => {
      if (!secondVideo.muted || secondVideo.volume !== 0) throw new Error('second nested video was not muted synchronously');
      return Promise.resolve();
    };
    fragmentVideo.play = () => {
      if (!fragmentVideo.muted || fragmentVideo.volume !== 0) throw new Error('fragment video was not muted synchronously');
      return Promise.resolve();
    };
    for (const media of [beforeVideo, afterAudio, replacementVideo, replacementChildrenVideo]) {
      media.play = () => {
        if (!media.muted || media.volume !== 0) throw new Error('sibling media was not muted synchronously');
        return Promise.resolve();
      };
    }
    const playWithGuard = (media) => {
      window.__bilibiliAudioGuard.assertSilentBeforePlay();
      return media.play();
    };
    return Promise.all([
      playWithGuard(firstVideo),
      playWithGuard(secondVideo),
      playWithGuard(fragmentVideo),
      playWithGuard(beforeVideo),
      playWithGuard(afterAudio),
      playWithGuard(replacementVideo),
      playWithGuard(replacementChildrenVideo),
    ]).then(() => {
      const snapshot = window.__bilibiliAudioGuard.assertSilentBeforePlay();
      return {
        firstImmediate,
        secondImmediate,
        fragmentImmediate,
        siblingImmediate,
        firstVideo: { muted: firstVideo.muted, volume: firstVideo.volume },
        secondAudio: { muted: secondAudio.muted, volume: secondAudio.volume },
        secondVideo: { muted: secondVideo.muted, volume: secondVideo.volume },
        fragmentVideo: { muted: fragmentVideo.muted, volume: fragmentVideo.volume },
        htmlVideo: {
          muted: htmlVideo.muted,
          volume: htmlVideo.volume,
        },
        adjacentAudio: {
          muted: adjacentAudio.muted,
          volume: adjacentAudio.volume,
        },
        snapshot,
      };
    });
  });
  assert.deepEqual(result.firstImmediate, { muted: true, volume: 0 });
  assert.deepEqual(result.secondImmediate.audio, { muted: true, volume: 0 });
  assert.deepEqual(result.secondImmediate.video, { muted: true, volume: 0 });
  assert.deepEqual(result.fragmentImmediate, { muted: true, volume: 0 });
  assert.deepEqual(result.siblingImmediate, {
    before: { muted: true, volume: 0 },
    after: { muted: true, volume: 0 },
    replacement: { muted: true, volume: 0 },
    replaceChildren: { muted: true, volume: 0 },
  });
  assert.deepEqual(result.firstVideo, { muted: true, volume: 0 });
  assert.deepEqual(result.secondAudio, { muted: true, volume: 0 });
  assert.deepEqual(result.secondVideo, { muted: true, volume: 0 });
  assert.deepEqual(result.fragmentVideo, { muted: true, volume: 0 });
  assert.deepEqual(result.htmlVideo, { muted: true, volume: 0 });
  assert.deepEqual(result.adjacentAudio, { muted: true, volume: 0 });
  assert.ok(result.snapshot.every((media) => media.muted === true && media.volume === 0));
  return result;
}

async function runVodScenario(context, page) {
  const diagnostics = collectDiagnostics(page);
  const requestTimeline = collectRequestTimeline(page);
  const vodUrl = 'https://www.bilibili.com/video/BVextension';
  const watchLaterUrl = 'https://www.bilibili.com/list/watchlater?oid=1';
  const unrelatedUrl = 'https://www.bilibili.com/read/cv123';
  await page.route(vodUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createVodHtml('applied'),
  }));
  await page.route('https://www.bilibili.com/list/watchlater*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createVodHtml('applied'),
  }));
  await page.route(unrelatedUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>unrelated www page</body></html>',
  }));

  await page.goto(vodUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const extensionId = await page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const { popup, diagnostics: popupDiagnostics } = await openPopup(context, extensionId, page);
  try {
    await popup.waitForFunction(
      () => document.querySelector('[data-status-field="state"]').textContent === 'APPLIED',
      undefined,
      { timeout: 15000 },
    );
    const firstState = await panelState(page);
    const first = await page.evaluate(() => {
      const video = window.__fakeVodState.video;
      return {
        source: video.currentSrc,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        paused: video.paused,
        muted: video.muted,
        volume: video.volume,
        stable: window.__fakeVodState.stable,
        playCalls: window.__fakeVodState.playCalls,
        pauseCalls: window.__fakeVodState.pauseCalls,
        bridgeTraffic: window.__bridgeTraffic,
      };
    });
    assert.equal(firstState.mode, '点播');
    assert.equal(firstState.state, 'APPLIED');
    assert.equal(firstState.inventory, '0.0 秒');
    assert.equal(firstState.quality, '未提供');
    assert.equal(firstState.speed, '未提供');
    assert.equal(firstState.multiplier, '未提供');
    assert.equal(firstState.delay, '未提供');
    assert.equal(firstState.stage, '未提供');
    assert.equal(firstState.skipVisible, 'hidden');
    assert.equal(firstState.returnVisible, 'hidden');
    assert.equal(await popup.locator('[data-live-only="true"]').evaluateAll((rows) => rows.every((row) => row.hidden)), true);
    assert.equal(await page.locator('[data-bilibili-buffer-panel="true"]').count(), 0);
    assert.deepEqual(first.stable, [{ label: 'core-1', value: 120 }]);
    assert.equal(first.playCalls, 0);
    assert.equal(first.pauseCalls, 0);
    assert.equal(first.playbackRate, 1);
    assert.equal(first.paused, true);
    assert.equal(first.muted, true);
    assert.equal(first.volume, 0);
    assert.ok(first.bridgeTraffic.some((request) => request.operation === 'getCoreSnapshot'));
    assert.ok(first.bridgeTraffic.some((request) => request.operation === 'callCoreSync'));
    assert.equal(first.bridgeTraffic.some((request) => request.operation === 'callPlayer'), false);
    assert.equal(first.bridgeTraffic.some((request) => request.operation === 'callPlayerSync'), false);

    await page.evaluate(() => {
      const state = window.__fakeVodState;
      state.userPause();
      state.userPlay();
      state.userSeek(42);
      state.setRate(1.5);
      state.setQuality(64);
      state.setAudio(false, 0.6);
    });
    const userMediaState = await page.evaluate(() => {
      const state = window.__fakeVodState;
      const video = state.video;
      return {
        source: state.source,
        currentTime: state.currentTime,
        playbackRate: video.playbackRate,
        paused: state.paused,
        muted: video.muted,
        volume: video.volume,
        quality: state.quality,
        playCalls: state.playCalls,
        pauseCalls: state.pauseCalls,
      };
    });
    assert.equal(userMediaState.source, 'data:video/mp4;base64,AA==');
    assert.equal(userMediaState.currentTime, 42);
    assert.equal(userMediaState.playbackRate, 1.5);
    assert.equal(userMediaState.paused, false);
    assert.equal(userMediaState.muted, false);
    assert.equal(userMediaState.volume, 0.6);
    assert.equal(userMediaState.quality, 64);
    assert.equal(userMediaState.playCalls, 1);
    assert.equal(userMediaState.pauseCalls, 1);
    await wait(1200);
    assert.deepEqual(await page.evaluate(() => ({
      source: window.__fakeVodState.source,
      currentTime: window.__fakeVodState.currentTime,
      playbackRate: window.__fakeVodState.video.playbackRate,
      paused: window.__fakeVodState.paused,
      muted: window.__fakeVodState.video.muted,
      volume: window.__fakeVodState.video.volume,
      quality: window.__fakeVodState.quality,
      playCalls: window.__fakeVodState.playCalls,
      pauseCalls: window.__fakeVodState.pauseCalls,
    })), userMediaState);

    await page.evaluate(() => window.__fakeVodState.replaceSource('user-selected-source'));
    await page.waitForFunction(
      () => window.__fakeVodState.stable.length === 2,
      undefined,
      { timeout: 10000 },
    );
    await page.evaluate(() => window.__fakeVodState.replaceCore());
    await page.waitForFunction(
      () => window.__fakeVodState.stable.length === 3,
      undefined,
      { timeout: 10000 },
    );
    await wait(1200);
    const afterGenerationChanges = await page.evaluate(() => {
      return {
        source: window.__fakeVodState.source,
        stable: window.__fakeVodState.stable,
      };
    });
    assert.equal(afterGenerationChanges.source, 'data:video/mp4;base64,AQ==');
    assert.equal(afterGenerationChanges.stable.length, 3);

    await popup.locator('input[data-preference="vodEnabled"]').uncheck();
    await popup.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('下次刷新'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(1000);
    const disabled = await page.evaluate(() => ({
      marker: document.documentElement.dataset.bilibiliBufferExtensionRuntimeId,
      stable: window.__fakeVodState.stable,
    }));
    assert.ok(disabled.marker);
    assert.deepEqual(disabled.stable, []);
    assert.equal((await panelState(page)).state, '未提供');

    await popup.bringToFront();
    await popup.locator('input[data-preference="vodEnabled"]').check();
    await popup.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('下次刷新'));
    await page.bringToFront();
    await page.goto(watchLaterUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
    await popup.waitForFunction(
      () => document.querySelector('[data-status-field="state"]').textContent === 'APPLIED',
      undefined,
      { timeout: 15000 },
    );
    const watchLater = await page.evaluate(() => window.__fakeVodState.stable);
    assert.deepEqual(watchLater, [{ label: 'core-1', value: 120 }]);

    await page.goto(unrelatedUrl, { waitUntil: 'domcontentloaded' });
    await wait(700);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId), undefined);
    assert.equal((await panelState(page)).state, '未提供');
    const pageDiagnosticResult = assertDiagnostics(diagnostics);
    const popupDiagnosticResult = assertDiagnostics(popupDiagnostics);
    await closeFixturePage(popup, 'VOD popup');
    return {
      mode: 'VOD',
      extensionId,
      firstState,
      first,
      afterGenerationChanges,
      disabled,
      watchLater,
      diagnostics: { page: pageDiagnosticResult, popup: popupDiagnosticResult },
      requestTimeline,
    };
  } catch (error) {
    await closeFixturePage(popup, 'VOD popup after failure');
    throw error;
  }
}


function isolatedFakeMediaSourceInit() {
  let objectUrlNumber = 0;
  let fakeCurrentTime = 0;
  let fakePaused = true;

  class FakeSourceBuffer extends EventTarget {
    constructor() {
      super();
      this.updating = false;
      this.mode = 'segments';
    }

    appendBuffer(bytes) {
      const value = new TextDecoder().decode(bytes);
      const values = JSON.parse(document.documentElement.dataset.bilibiliBufferAppended || '[]');
    values.push(value.includes('vide') && value.includes('soun') ? 'init' : value);
      document.documentElement.dataset.bilibiliBufferAppended = JSON.stringify(values);
      if (/^seg-\d+$/.test(value)) {
        document.querySelector('video').__bufferEnd += 2;
      }
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }

    remove() {
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }
  }

  class FakeMediaSource extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      this.readyState = config.kind === 'mseTimeout' && root.dataset.bilibiliBufferLiveReleaseMseFault !== 'true'
        ? 'closed'
        : 'open';
    }

    addSourceBuffer() {
      return new FakeSourceBuffer();
    }

    endOfStream() {
      this.readyState = 'ended';
    }
  }

  globalThis.MediaSource = FakeMediaSource;
  const NativeURL = globalThis.URL;
  class FakeURL extends NativeURL {}
  FakeURL.createObjectURL = () => {
    const value = `blob:fake-isolated-live-${++objectUrlNumber}`;
    document.documentElement.dataset.bilibiliBufferObjectUrl = value;
    return value;
  };
  FakeURL.revokeObjectURL = () => {};
  globalThis.URL = FakeURL;

  const install = (video) => {
    video.__bufferEnd = 0;
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        return { length: 1, start: () => 0, end: () => this.__bufferEnd };
      },
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => Number(root.dataset.bilibiliBufferLiveCurrentTime || fakeCurrentTime),
      set: (value) => {
        fakeCurrentTime = value;
      },
    });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => fakePaused,
    });
    video.play = () => {
      globalThis.__bilibiliAudioGuard.assertSilentBeforePlay();
      fakePaused = false;
      video.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    video.pause = () => {
      fakePaused = true;
      video.dispatchEvent(new Event('pause'));
    };
  };
  const scan = () => {
    const video = document.querySelector('video');
    if (video !== null) {
      install(video);
    }
  };
  scan();
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  globalThis.setInterval(() => {
    if (!fakePaused) {
      fakeCurrentTime += 0.25;
      document.querySelector('video')?.dispatchEvent(new Event('timeupdate'));
    }
  }, 250);
}

async function runLiveScenario(context, page) {
  const requestStarts = [];
  const diagnostics = collectDiagnostics(page);
  const executionContexts = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', (event) => {
    executionContexts.push({ id: event.context.id, name: event.context.name, origin: event.context.origin });
  });
  await cdp.send('Runtime.enable');
  await page.route('https://live.bilibili.com/6363772', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createLiveHtml(),
  }));
  await page.route('https://api.live.bilibili.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(playInfoPayload()),
  }));
  await page.route('https://cdn-a.bilivideo.com/**', async (route) => {
    requestStarts.push({ url: route.request().url(), at: Date.now() });
    await wait(30);
    const url = route.request().url();
    if (url.endsWith('index.m3u8?expires=1&sign=a')) {
      await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: mediaPlaylist });
    } else {
      const name = new URL(url).pathname.split('/').pop().replace('.m4s', '');
      await route.fulfill({ status: 200, body: name === 'init.mp4' ? MUXED_INIT_SEGMENT : name });
    }
  });
  await page.route('https://cdn-b.bilivideo.com/**', async (route) => {
    requestStarts.push({ url: route.request().url(), at: Date.now() });
    const url = route.request().url();
    if (url.endsWith('index.m3u8?expires=1&sign=b')) {
      await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: mediaPlaylist });
    } else {
      const name = new URL(url).pathname.split('/').pop().replace('.m4s', '');
      await route.fulfill({ status: 200, body: name === 'init.mp4' ? MUXED_INIT_SEGMENT : name });
    }
  });
  await page.goto('https://live.bilibili.com/6363772', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  let isolatedContext;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    isolatedContext = executionContexts
      .filter((executionContext) => executionContext.origin.startsWith('chrome-extension://'))
      .at(-1);
    if (isolatedContext !== undefined) {
      break;
    }
    await wait(10);
  }
  if (isolatedContext === undefined) {
    throw new Error(`直播控制器隔离世界没有创建: ${JSON.stringify(executionContexts)}`);
  }
  const fakeInstall = await cdp.send('Runtime.evaluate', {
    contextId: isolatedContext.id,
    awaitPromise: true,
    returnByValue: true,
    expression: `(${isolatedFakeMediaSourceInit.toString()})(); ({ mediaSource: typeof globalThis.MediaSource, url: typeof globalThis.URL })`,
  });
  if (fakeInstall.exceptionDetails !== undefined || fakeInstall.result?.exceptionDetails !== undefined) {
    throw new Error(`直播隔离世界 fake MSE 注入失败: ${JSON.stringify(fakeInstall)}`);
  }
  await page.evaluate(() => window.__createLiveVideo());
  const extensionId = await page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const popupInfo = await openPopup(context, extensionId, page);
  try {
    await waitForPanelState(page, 'LIVE', 15000);
  } catch (error) {
    const isolatedValues = [];
    for (const executionContext of executionContexts) {
      if (!executionContext.origin.startsWith('chrome-extension://')) {
        continue;
      }
      try {
        const value = await cdp.send('Runtime.evaluate', {
          contextId: executionContext.id,
          returnByValue: true,
          expression: `({ init: globalThis.__bilibiliBufferFakeMediaSourceInit === true, mediaSource: typeof globalThis.MediaSource, supported: typeof globalThis.MediaSource?.isTypeSupported === 'function' ? globalThis.MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f, mp4a.40.2"') : null, videoFactory: typeof document.querySelector('video')?.__bilibiliBufferMediaSourceFactory })`,
        });
        isolatedValues.push({
          id: executionContext.id,
          raw: value.result,
        });
      } catch (evaluationError) {
        isolatedValues.push({ id: executionContext.id, error: evaluationError.message || String(evaluationError) });
      }
    }
    const state = await page.evaluate(({ contexts, values }) => ({
      pageUi: Boolean(document.querySelector('[data-bilibili-buffer-panel="true"]')),
      fake: window.__fakeLiveState,
      marker: document.documentElement.dataset.bilibiliBufferExtensionRuntimeId,
      executionContexts: contexts,
      isolatedValues: values,
    }), { contexts: executionContexts, values: isolatedValues });
    throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}; state=${JSON.stringify(state)}`);
  }
  const state = await panelState(page);
  const actual = await page.evaluate(() => ({
    videoSrc: document.querySelector('video').src,
    playbackRate: document.querySelector('video').playbackRate,
    currentTime: document.querySelector('video').currentTime,
    muted: document.querySelector('video').muted,
    volume: document.querySelector('video').volume,
    appended: JSON.parse(document.documentElement.dataset.bilibiliBufferAppended || '[]'),
    objectUrls: [document.documentElement.dataset.bilibiliBufferObjectUrl],
    playerCalls: window.__fakeLiveState.playerCalls,
    bridgeTraffic: window.__bridgeTraffic,
  }));
  assert.equal(actual.playbackRate, 1);
  assert.equal(actual.muted, true);
  assert.equal(actual.volume, 0);
  assert.ok(actual.objectUrls[0].startsWith('blob:fake-isolated-live-'));
  assert.ok(actual.videoSrc.startsWith('blob:'));
  assert.deepEqual(actual.appended.filter((item) => /^seg-\d+$/.test(item)), ['seg-104']);
  assert.ok(actual.playerCalls.some(([name]) => name === 'sync'));
  assert.ok(actual.bridgeTraffic.some((request) => request.operation === 'callPlayer'));
  assert.ok(requestStarts.length >= 2);
  const diagnosticResult = assertDiagnostics(diagnostics);
  await closeFixturePage(popupInfo.popup, 'live popup');
  return {
    mode: 'LIVE',
    state,
    actual: { ...actual, bridgeTrafficCount: actual.bridgeTraffic.length },
    requestStarts,
    concurrentStartDeltaMilliseconds: Math.abs(requestStarts[1].at - requestStarts[0].at),
    diagnostics: diagnosticResult,
  };
}

function createLiveFixtureHtml({ delayedPlayer = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Live extension timeline test</title></head><body>
<script>
window.__bridgeTraffic = [];
document.addEventListener('bilibili-buffer:bridge-request-v1', (event) => {
  window.__bridgeTraffic.push(JSON.parse(event.detail));
});
window.__liveFixture = { playerCalls: [], created: false, videoInsertedAt: undefined, playerInstalledAt: undefined };
window.__createLiveFixtureVideo = () => {
  if (window.__liveFixture.created) return;
  window.__liveFixture.created = true;
  const video = document.createElement('video');
  video.id = 'live-fixture-video';
  video.muted = true;
  video.volume = 0;
  video.playsInline = true;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => Number(document.documentElement.dataset.bilibiliBufferLiveCurrentTime || 0),
    set: (value) => {
      document.documentElement.dataset.bilibiliBufferLiveCurrentTime = String(Number(value));
    },
  });
  const danmaku = document.createElement('div');
  danmaku.className = 'danmaku-root';
  danmaku.textContent = 'danmaku';
  danmaku.style.display = 'block';
  const literalDanmaku = document.createElement('danmaku');
  literalDanmaku.textContent = 'literal danmaku';
  literalDanmaku.style.display = 'block';
  const chat = document.createElement('div');
  chat.className = 'chat-history-panel';
  chat.style.display = 'flex';
  const list = document.createElement('div');
  list.id = 'chat-history-list';
  const items = document.createElement('div');
  items.id = 'chat-items';
  list.append(items);
  chat.append(list);
  const installPlayer = () => { window.__liveFixture.playerInstalledAt = Date.now(); window.player = {
    setAutoSyncProgressCfg(value) { window.__liveFixture.playerCalls.push(['sync', value]); },
    setAutoDiscardFrameCfg(value) { window.__liveFixture.playerCalls.push(['discard', value]); },
    pause() { window.__liveFixture.playerCalls.push(['pause']); video.pause(); },
  }; };
  if (${JSON.stringify(delayedPlayer)}) {
    window.__liveFixture.videoInsertedAt = Date.now();
    document.body.append(video, danmaku, literalDanmaku, chat);
    setTimeout(installPlayer, 250);
    return;
  }
  installPlayer();
  window.__liveFixture.videoInsertedAt = Date.now();
  document.body.append(video, danmaku, literalDanmaku, chat);
};
</script>
</body></html>`;
}

function makeLivePlaylist(start, end, { mapUri = 'init.mp4', includeMap = true } = {}) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:1',
    `#EXT-X-MEDIA-SEQUENCE:${start}`,
  ];
  if (includeMap) {
    lines.push(`#EXT-X-MAP:URI="${mapUri}"`);
  }
  for (let sequence = start; sequence <= end; sequence += 1) {
    lines.push('#EXTINF:1,', `seg-${sequence}.m4s`);
  }
  return `${lines.join('\n')}\n`;
}

function makeMissingVariantManifest() {
  return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
hevc-only.m3u8
`;
}

function livePlayInfoPayload(apiCalls) {
  const renewed = apiCalls >= 2;
  const hostPrefix = renewed ? 'renewed-cdn' : 'cdn';
  return {
    code: 0,
    message: 'OK',
    data: {
      room_id: 6363772,
      playurl_info: {
        playurl: {
          stream: [{
            protocol_name: 'http_hls',
            format: [{
              format_name: 'fmp4',
              codec: [{
                codec_name: 'avc',
                current_qn: 250,
                accept_qn: [250],
                base_url: '/live/index.m3u8?',
                url_info: [
                  { host: `https://${hostPrefix}-a.bilivideo.com`, extra: renewed ? 'expires=new&sign=new-a' : 'expires=old&sign=old-a' },
                  { host: `https://${hostPrefix}-b.bilivideo.com`, extra: renewed ? 'expires=new&sign=new-b' : 'expires=old&sign=old-b' },
                ],
                session: 'extension-e2e-session',
                video_codecs: { base: 'avc1.4d401f' },
                audio_codecs: { base: 'mp4a.40.2' },
                description: '高清 720P',
              }],
            }],
          }],
        },
      },
    },
  };
}

async function fulfillTracked(route, entry, response, delayMilliseconds = 0) {
  if (delayMilliseconds > 0) {
    await wait(delayMilliseconds);
  }
  entry.status = response.status;
  try {
    await route.fulfill(response);
  } catch (error) {
    const message = error.message || String(error);
    if (!/aborted|closed|handled|intercepted/i.test(message)) {
      throw error;
    }
    entry.aborted = true;
  }
}

async function configureLiveRoutes(page, scenario) {
  const state = {
    apiCalls: 0,
    initialManifestLoaded: false,
    manifestSuccesses: 0,
    requests: [],
    outageStartedAt: undefined,
    temporaryManifestFailures: 0,
    temporaryManifestRequested: false,
    faultReleased: false,
  };
  const record = (route) => {
    const entry = { url: route.request().url(), startedAt: Date.now(), status: undefined, aborted: false };
    state.requests.push(entry);
    return entry;
  };
  const manifestBody = () => {
    if (!state.initialManifestLoaded) {
      return makeLivePlaylist(100, 119);
    }
    if (state.temporaryManifestRequested && state.temporaryManifestFailures < 2) {
      return undefined;
    }
    if (!state.faultReleased) {
      switch (scenario.kind) {
        case 'slide':
          return makeLivePlaylist(121, 139);
        case 'rollback':
          return makeLivePlaylist(0, 119);
        case 'variantMissing':
          return makeMissingVariantManifest();
        case 'mapMissing':
          return makeLivePlaylist(119, 139, { includeMap: false });
        case 'initMapChanged':
          return makeLivePlaylist(119, 139, { mapUri: 'init-v2.mp4' });
        default:
          return makeLivePlaylist(119, 199);
      }
    }
    return makeLivePlaylist(200, 259);
  };
  await page.route('https://live.bilibili.com/**', async (route) => {
    const entry = record(route);
    await fulfillTracked(route, entry, {
      status: 200,
      contentType: 'text/html',
      body: createLiveFixtureHtml({ delayedPlayer: scenario.kind === 'delayedPlayer' }),
    });
  });
  await page.route('https://api.live.bilibili.com/**', async (route) => {
    const entry = record(route);
    state.apiCalls += 1;
    await fulfillTracked(route, entry, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(livePlayInfoPayload(state.apiCalls)),
    });
  });
  await page.route('https://*.bilivideo.com/**', async (route) => {
    const entry = record(route);
    const url = new URL(entry.url);
    if (url.pathname.endsWith('/index.m3u8')) {
      if (state.temporaryManifestRequested && state.temporaryManifestFailures < 2) {
        state.temporaryManifestFailures += 1;
        await fulfillTracked(
          route,
          entry,
          scenario.kind === 'manifestTimeout'
            ? { status: 200, contentType: 'application/vnd.apple.mpegurl', body: makeLivePlaylist(119, 199) }
            : { status: 503, body: 'temporary manifest interruption' },
          scenario.kind === 'manifestTimeout' ? 5200 : 0,
        );
        return;
      }
      const firstRequest = !state.initialManifestLoaded;
      if (firstRequest && url.hostname.includes('-a.')) {
        await fulfillTracked(route, entry, { status: 503, body: 'temporary manifest interruption' }, 100);
        return;
      }
      const body = manifestBody();
      if (body === undefined) {
        throw new Error('temporary manifest state was not consumed by the CDN route');
      }
      state.initialManifestLoaded = true;
      state.manifestSuccesses += 1;
      await fulfillTracked(route, entry, { status: 200, contentType: 'application/vnd.apple.mpegurl', body });
      return;
    }
    if (url.pathname.endsWith('/init.mp4') || url.pathname.endsWith('/init-v2.mp4')) {
      const slow = url.hostname.includes('-a.');
      await fulfillTracked(
        route,
        entry,
        {
          status: slow ? 503 : 200,
          body: scenario.kind === 'audioInit' && !state.faultReleased
            ? VIDEO_ONLY_INIT_SEGMENT
            : MUXED_INIT_SEGMENT,
        },
        slow ? 100 : 0,
      );
      return;
    }
    const segmentMatch = url.pathname.match(/\/seg-(\d+)\.m4s$/);
    if (segmentMatch === null) {
      await fulfillTracked(route, entry, { status: 404, body: 'not found' });
      return;
    }
    const sequence = Number(segmentMatch[1]);
    if (scenario.kind === 'signature' && state.apiCalls === 1 && sequence === 119) {
      await fulfillTracked(route, entry, { status: 403, body: 'expired signature' });
      return;
    }
    if (scenario.kind === 'permanent' && !state.faultReleased && sequence === 120) {
      await fulfillTracked(route, entry, { status: 404, body: 'permanent gap' });
      return;
    }
    if (scenario.kind === 'recovery' && sequence === 120) {
      if (state.outageStartedAt === undefined || Date.now() - state.outageStartedAt < scenario.outageSeconds * 1000) {
        await fulfillTracked(route, entry, { status: 503, body: 'temporary interruption' });
        return;
      }
    }
    const slow = sequence === 119 && url.hostname.includes('-a.');
    await fulfillTracked(route, entry, { status: slow ? 503 : 200, body: `seg-${sequence}` }, slow ? 100 : 0);
  });
  return {
    state,
    startOutage() {
      if (state.outageStartedAt !== undefined) {
        throw new Error('recovery outage was already started');
      }
      state.outageStartedAt = Date.now();
    },
    activateTemporaryManifestFailure() {
      if (state.temporaryManifestRequested) {
        throw new Error('temporary manifest failure was already activated');
      }
      state.temporaryManifestRequested = true;
    },
    releaseFault() {
      state.faultReleased = true;
    },
  };
}

function isolatedLiveMseInit(config) {
  const root = document.documentElement;
  const NativeMediaSource = globalThis.MediaSource;
  let fakeCurrentTime = 0;
  let fakePaused = true;
  const readAppended = () => JSON.parse(root.dataset.bilibiliBufferLiveAppended || '[]');
  const writeAppended = (value) => {
    root.dataset.bilibiliBufferLiveAppended = JSON.stringify(value);
  };
  const assertMutedBeforePlay = () => {
    const values = [];
    const scan = (rootNode) => {
      if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode.matches('video, audio')) {
        values.push(rootNode);
      }
      values.push(...rootNode.querySelectorAll('video, audio'));
      for (const element of rootNode.querySelectorAll('*')) {
        if (element.shadowRoot !== null) {
          scan(element.shadowRoot);
        }
      }
    };
    scan(document);
    for (const media of values) {
      media.muted = true;
      media.volume = 0;
    }
    if (!values.every((media) => media.muted === true && media.volume === 0)) {
      throw new Error('fake live play encountered unmuted media');
    }
  };
  class FakeSourceBuffer extends EventTarget {
    constructor() {
      super();
      this.updating = false;
      this.mode = 'segments';
    }

    appendBuffer(bytes) {
      const value = new TextDecoder().decode(bytes);
      if (
        config.kind === 'appendFailure' &&
        root.dataset.bilibiliBufferLiveReleaseMseFault !== 'true' &&
        /^seg-/.test(value)
      ) {
        const error = new Error('deterministic append failure');
        error.name = 'InvalidStateError';
        throw error;
      }
      const appended = readAppended();
      appended.push(value.includes('vide') && value.includes('soun') ? 'init' : value);
      writeAppended(appended);
      if (/^seg-\d+$/.test(value)) {
        root.dataset.bilibiliBufferLiveBufferEnd = String(Number(root.dataset.bilibiliBufferLiveBufferEnd || 0) + 1);
      }
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }

    remove() {
      root.dataset.bilibiliBufferLiveRemoveCalls = String(
        Number(root.dataset.bilibiliBufferLiveRemoveCalls || 0) + 1,
      );
      if (config.kind === 'removeFailure' && root.dataset.bilibiliBufferLiveReleaseMseFault !== 'true') {
        const error = new Error('deterministic remove failure');
        error.name = 'InvalidStateError';
        throw error;
      }
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }
  }
  class FakeMediaSource extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      this.readyState = config.kind === 'mseTimeout' && root.dataset.bilibiliBufferLiveReleaseMseFault !== 'true'
        ? 'closed'
        : 'open';
    }

    addSourceBuffer() {
      return new FakeSourceBuffer();
    }

    endOfStream() {
      this.readyState = 'ended';
    }
  }
  globalThis.MediaSource = FakeMediaSource;
  const NativeURL = globalThis.URL;
  const nativeSources = new Map();
  class FakeURL extends NativeURL {}
  FakeURL.createObjectURL = () => {
    const source = new NativeMediaSource();
    const value = NativeURL.createObjectURL(source);
    nativeSources.set(value, source);
    root.dataset.bilibiliBufferLiveObjectUrl = value;
    root.dataset.bilibiliBufferLiveBufferEnd = '0';
    root.dataset.bilibiliBufferLiveCurrentTime = '0';
    return value;
  };
  FakeURL.revokeObjectURL = (value) => {
    const source = nativeSources.get(value);
    if (source?.readyState === 'open') {
      source.endOfStream();
    }
    nativeSources.delete(value);
    NativeURL.revokeObjectURL(value);
  };
  globalThis.URL = FakeURL;
  const installVideo = (video) => {
    if (video.dataset.bilibiliBufferLiveFixture === 'true') {
      return;
    }
    video.dataset.bilibiliBufferLiveFixture = 'true';
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get() {
        const end = Number(root.dataset.bilibiliBufferLiveBufferEnd || 0);
        return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
      },
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => Number(root.dataset.bilibiliBufferLiveCurrentTime || fakeCurrentTime),
      set: (value) => {
        fakeCurrentTime = Number(value);
        root.dataset.bilibiliBufferLiveCurrentTime = String(fakeCurrentTime);
      },
    });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => fakePaused });
    video.play = () => {
      assertMutedBeforePlay();
      fakePaused = false;
      root.dataset.bilibiliBufferLivePlayCalls = String(Number(root.dataset.bilibiliBufferLivePlayCalls || 0) + 1);
      video.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    video.pause = () => {
      fakePaused = true;
      video.dispatchEvent(new Event('pause'));
    };
  };
  const scan = () => {
    const video = document.querySelector('video');
    if (video !== null) {
      installVideo(video);
    }
  };
  scan();
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  globalThis.setInterval(() => {
    if (!fakePaused) {
      fakeCurrentTime += 0.25;
      root.dataset.bilibiliBufferLiveCurrentTime = String(fakeCurrentTime);
      document.querySelector('video')?.dispatchEvent(new Event('timeupdate'));
    }
  }, 250);
}

async function waitForIsolatedContext(cdp, contexts) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const isolated = contexts.filter((context) => context.origin.startsWith('chrome-extension://')).at(-1);
    if (isolated !== undefined) {
      return isolated;
    }
    await wait(10);
  }
  throw new Error(`extension isolated world was not created: ${JSON.stringify(contexts)}`);
}

async function waitForPanelState(page, expectedState, timeout = 15000) {
  const popup = statusPopups.get(page);
  assert.ok(popup !== undefined && !popup.isClosed(), 'status popup is not open for this tab');
  const expectedStates = Array.isArray(expectedState) ? expectedState : [expectedState];
  await popup.waitForFunction((state) => {
    return state.includes(document.querySelector('[data-status-field="state"]')?.textContent);
  }, expectedStates, { timeout });
}

async function clickPanelAction(page, action) {
  const popup = statusPopups.get(page);
  assert.ok(popup !== undefined && !popup.isClosed(), 'status popup is not open for this tab');
  await page.bringToFront();
  await popup.evaluate((actionName) => {
    const button = document.querySelector(`[data-actions] [data-action="${actionName}"]`);
    if (button === null) {
      throw new Error(`popup action is not visible: ${actionName}`);
    }
    button.click();
  }, action);
}

async function assertEventuallyVisible(locator, message) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    throw new Error(`${message}: ${error.message || error}`);
  }
}

async function waitForPopupAction(page, action, expectedLabel, timeout = 10000) {
  const popup = statusPopups.get(page);
  assert.ok(popup !== undefined && !popup.isClosed(), 'status popup is not open for this tab');
  await popup.waitForFunction(
    ({ actionName, label }) => document.querySelector(`[data-actions] [data-action="${actionName}"]`)?.textContent === label,
    { actionName: action, label: expectedLabel },
    { timeout },
  );
}

async function readLiveFixture(page) {
  const status = await panelState(page);
  const media = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      videoSrc: video?.src,
      currentTime: video?.currentTime,
      playbackRate: video?.playbackRate,
      appended: JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]'),
      objectUrl: document.documentElement.dataset.bilibiliBufferLiveObjectUrl,
      playCalls: Number(document.documentElement.dataset.bilibiliBufferLivePlayCalls || 0),
      playerCalls: window.__liveFixture.playerCalls,
      bridgeTraffic: window.__bridgeTraffic,
      danmakuDisplay: document.querySelector('.danmaku-root')?.style.display,
      literalDanmakuDisplay: document.querySelector('danmaku')?.style.display,
      chatDisplay: document.querySelector('.chat-history-panel')?.style.display,
    };
  });
  return { ...status, ...media };
}

async function openLiveFixture(context, scenario) {
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);
  const routes = await configureLiveRoutes(page, scenario);
  const contexts = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', (event) => {
    contexts.push({ id: event.context.id, origin: event.context.origin, name: event.context.name });
  });
  await cdp.send('Runtime.enable');
  await page.goto('https://live.bilibili.com/6363772', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const isolated = await waitForIsolatedContext(cdp, contexts);
  const installed = await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    awaitPromise: true,
    returnByValue: true,
    expression: `(${isolatedLiveMseInit.toString()})(${JSON.stringify(scenario)}); true`,
  });
  if (installed.exceptionDetails !== undefined) {
    throw new Error(`could not install live Fake MSE in the extension isolated world: ${JSON.stringify(installed)}`);
  }
  await page.evaluate(() => window.__createLiveFixtureVideo());
  const extensionId = await page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const popupInfo = await openPopup(context, extensionId, page);
  try {
    if (scenario.kind === 'appendFailure' || scenario.kind === 'audioInit' || scenario.kind === 'mseTimeout') {
      await waitForPanelState(page, 'GAP_UNRECOVERABLE');
    } else {
      await waitForPanelState(page, ['LIVE', 'DELAYED']);
    }
  } catch (error) {
    const popupDebug = await popupInfo.popup.evaluate(() => ({
      status: document.querySelector('[data-status]')?.textContent,
      fields: Object.fromEntries(
        [...document.querySelectorAll('[data-status-field]')].map((element) => [element.dataset.statusField, element.textContent]),
      ),
    }));
    const pageDebug = await page.evaluate(() => ({
      appended: document.documentElement.dataset.bilibiliBufferLiveAppended,
      objectUrl: document.documentElement.dataset.bilibiliBufferLiveObjectUrl,
      currentTime: document.documentElement.dataset.bilibiliBufferLiveCurrentTime,
    }));
    throw new Error(
      `${error.message}; popup=${JSON.stringify(popupDebug)}; page=${JSON.stringify(pageDebug)}; requests=${JSON.stringify(routes.state.requests)}`,
    );
  }
  return {
    page,
    popup: popupInfo.popup,
    popupDiagnostics: popupInfo.diagnostics,
    diagnostics,
    routes,
    cdp,
    isolatedContextId: isolated.id,
    extensionId,
  };
}

function assertConcurrentCandidateStarts(requests, pathname) {
  const starts = requests.filter((entry) => new URL(entry.url).pathname === pathname).slice(0, 2);
  assert.equal(starts.length, 2, `expected two same-quality CDN starts for ${pathname}`);
  const deltaMilliseconds = Math.abs(starts[0].startedAt - starts[1].startedAt);
  assert.ok(deltaMilliseconds < 100, `CDN race for ${pathname} started ${deltaMilliseconds}ms apart`);
  return { starts, deltaMilliseconds };
}

function appendedSegmentNumbers(appended) {
  return appended.filter((value) => /^seg-\d+$/.test(value)).map((value) => Number(value.slice(4)));
}

async function closeFixturePage(page, label) {
  const failures = [];
  await runCleanupStep(failures, `${label} page close`, () => page.close({ runBeforeUnload: false }));
  throwCleanupFailures(failures);
}

async function closeLiveFixture(fixture) {
  const failures = [];
  if (fixture.popup !== undefined && !fixture.popup.isClosed()) {
    await runCleanupStep(failures, 'live fixture popup close', () => fixture.popup.close({ runBeforeUnload: false }));
  }
  await runCleanupStep(failures, 'live fixture page close', () => fixture.page.close({ runBeforeUnload: false }));
  throwCleanupFailures(failures);
}

async function runLiveRecoveryScenario(context, outageSeconds) {
  let fixture;
  try {
    fixture = await runLiveRecoveryStep(
      'recovery fixture setup',
      () => openLiveFixture(context, { kind: 'recovery', outageSeconds }),
    );
    const { page, routes } = fixture;
    await runLiveRecoveryStep(
      'initial seg-119 append',
      () => page.waitForFunction(
        () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-119'),
        undefined,
        { timeout: 15000 },
      ),
    );
    const guard = await runLiveRecoveryStep('nested audio guard', () => assertNestedShadowAudioGuard(page));
    const seekGuard = await runLiveRecoveryStep('forward seek guard', () => page.evaluate(() => {
      const video = document.querySelector('video');
      const before = video.currentTime;
      video.currentTime = before + 1;
      video.dispatchEvent(new Event('seeking'));
      const rejectedOneSecond = video.currentTime === before;
      video.currentTime = before + 0.1;
      video.dispatchEvent(new Event('seeking'));
      const rejectedTenthSecond = video.currentTime === before;
      video.currentTime = before + 0.5;
      video.dispatchEvent(new Event('timeupdate'));
      return {
        rejectedOneSecond,
        rejectedTenthSecond,
        naturalProgressionAllowed: video.currentTime === before + 0.5,
        playbackRate: video.playbackRate,
        muted: video.muted,
        volume: video.volume,
      };
    }));
    assert.deepEqual(seekGuard, {
      rejectedOneSecond: true,
      rejectedTenthSecond: true,
      naturalProgressionAllowed: true,
      playbackRate: 1,
      muted: true,
      volume: 0,
    });
    const initial = await runLiveRecoveryStep('initial fixture snapshot', () => readLiveFixture(page));
    assert.equal(initial.speed, '1×');
    assert.ok(initial.videoSrc.startsWith('blob:'));
    assert.ok(initial.playerCalls.some(([name]) => name === 'sync'));
    assert.ok(initial.bridgeTraffic.some((request) => request.operation === 'callPlayer'));
    const manifestRace = assertConcurrentCandidateStarts(routes.state.requests, '/live/index.m3u8');
    const initRace = assertConcurrentCandidateStarts(routes.state.requests, '/live/init.mp4');
    const segmentRace = assertConcurrentCandidateStarts(routes.state.requests, '/live/seg-119.m4s');

    routes.startOutage();
    await runLiveRecoveryStep('start outage and dispatch waiting', () => page.evaluate(() => {
      window.__bilibiliAudioGuard.assertSilentBeforePlay();
      document.querySelector('video').dispatchEvent(new Event('waiting'));
    }));
    await runLiveRecoveryStep('RECOVERING state', () => waitForPanelState(page, 'RECOVERING'));
    await runLiveRecoveryStep('same-sequence delayed recovery', async () => {
      const timeout = outageSeconds * 1000 + 45000;
      await waitForPanelState(page, 'DELAYED', timeout);
      await page.waitForFunction(
        () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-134'),
        undefined,
        { timeout },
      );
    }, outageSeconds * 1000 + 50000);
    const delayed = await runLiveRecoveryStep('delayed recovery snapshot', () => readLiveFixture(page));
    const delayedSegments = appendedSegmentNumbers(delayed.appended);
    assert.deepEqual(delayedSegments.slice(0, 16), Array.from({ length: 16 }, (_value, index) => 119 + index));
    assert.equal(delayed.returnVisible, 'visible');
    assert.equal(delayed.skipVisible, 'hidden');
    assert.equal(delayed.danmakuDisplay, 'none');
    assert.equal(delayed.literalDanmakuDisplay, 'none');
    assert.equal(delayed.chatDisplay, 'none');
    assert.ok(routes.state.outageStartedAt !== undefined);
    assert.ok(Date.now() - routes.state.outageStartedAt >= outageSeconds * 1000);
    const recoveryRequests = routes.state.requests.filter((entry) => new URL(entry.url).pathname === '/live/seg-120.m4s');
    assert.ok(recoveryRequests.length >= 4, 'recovery must retry the same required sequence across CDN rounds');
    assert.ok(recoveryRequests.every((entry) => new URL(entry.url).pathname === '/live/seg-120.m4s'));

    await runLiveRecoveryStep('insert delayed dynamic chat', () => page.evaluate(() => {
      const dynamic = document.createElement('div');
      dynamic.className = 'chat-history-panel';
      dynamic.style.display = 'grid';
      const dynamicDanmaku = document.createElement('danmaku');
      dynamicDanmaku.style.display = 'grid';
      document.body.append(dynamic, dynamicDanmaku);
      window.__dynamicDelayedChat = dynamic;
      window.__dynamicDelayedDanmaku = dynamicDanmaku;
    }));
    await runLiveRecoveryStep(
      'dynamic delayed chat hidden',
      () => page.waitForFunction(() => window.__dynamicDelayedChat.style.display === 'none' &&
        window.__dynamicDelayedDanmaku.style.display === 'none'),
    );
    const delayedSource = delayed.videoSrc;
    await runLiveRecoveryStep('delayed return-to-live action', () => clickPanelAction(page, 'return-live'));
    await runLiveRecoveryStep('rebuilt RECOVERING after delayed return without the 15-second watermark', () =>
      Promise.all([
        waitForPanelState(page, 'RECOVERING'),
        page.waitForFunction(
          (previousSource) =>
            document.querySelector('video').src !== previousSource &&
            document.querySelector('.chat-history-panel').style.display === 'flex',
          delayedSource,
        ),
      ]));
    const afterDelayedReturn = await runLiveRecoveryStep(
      'post-delayed-return snapshot',
      () => readLiveFixture(page),
    );
    assert.notEqual(afterDelayedReturn.videoSrc, delayedSource);
    assert.equal(afterDelayedReturn.chatDisplay, 'flex');
    assert.equal(
      await runLiveRecoveryStep('dynamic chat restoration', () =>
        page.evaluate(() => window.__dynamicDelayedChat.style.display)),
      'grid',
    );
    assert.equal(
      await runLiveRecoveryStep('dynamic danmaku restoration', () =>
        page.evaluate(() => window.__dynamicDelayedDanmaku.style.display)),
      'grid',
    );

    await runLiveRecoveryStep('take media ownership', () => page.evaluate(() => {
      document.querySelector('video').src = 'https://page-took-the-media.example/live.m3u8';
    }));
    await runLiveRecoveryStep('ownership GAP state', () => waitForPanelState(page, 'GAP_UNRECOVERABLE'));
    const ownershipGap = await runLiveRecoveryStep('ownership GAP snapshot', () => readLiveFixture(page));
    assert.match(ownershipGap.message, /GAP_MEDIA_OWNERSHIP_LOST/);
    assert.equal(ownershipGap.returnVisible, 'visible');
    await runLiveRecoveryStep('ownership return-to-live action', () => clickPanelAction(page, 'return-live'));
    await runLiveRecoveryStep('rebuilt RECOVERING after ownership return without the 15-second watermark', () =>
      Promise.all([
        waitForPanelState(page, 'RECOVERING'),
        page.waitForFunction(() => document.querySelector('video').src.startsWith('blob:')),
      ]));

    await runLiveRecoveryStep('user play then pause', () => page.evaluate(() => {
      const video = document.querySelector('video');
      window.__bilibiliAudioGuard.assertSilentBeforePlay();
      video.dispatchEvent(new Event('play'));
      video.dispatchEvent(new Event('pause'));
    }));
    await runLiveRecoveryStep('USER_PAUSED state', () => waitForPanelState(page, 'USER_PAUSED'));
    const userPaused = await runLiveRecoveryStep('user-pause snapshot', () => readLiveFixture(page));
    assert.equal(userPaused.returnVisible, 'visible');
    await runLiveRecoveryStep('user-pause persistence delay', () => wait(1100), 5000);
    await runLiveRecoveryStep('USER_PAUSED persistence state', () => waitForPanelState(page, 'USER_PAUSED'));
    const userPauseSource = (await readLiveFixture(page)).videoSrc;
    await runLiveRecoveryStep('user-pause return-to-live action', () => clickPanelAction(page, 'return-live'));
    await runLiveRecoveryStep('rebuilt RECOVERING after user-pause return without the 15-second watermark', () =>
      Promise.all([
        waitForPanelState(page, 'RECOVERING'),
        page.waitForFunction(
          (previousSource) => document.querySelector('video').src !== previousSource,
          userPauseSource,
        ),
      ]));
    const diagnostics = assertDiagnostics(fixture.diagnostics, [
      /\[BilibiliBuffer\] 进入 GAP_UNRECOVERABLE/,
      (entry) => entry.location.url.includes('/live/seg-120.m4s?') &&
        entry.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      (entry) => entry.location.url === 'https://page-took-the-media.example/live.m3u8' &&
        entry.text.includes('net::ERR_NAME_NOT_RESOLVED'),
    ]);
    return {
      status: 'PASS',
      outageSeconds,
      guard,
      seekGuard,
      initial,
      delayed,
      ownershipGap,
      userPaused,
      races: { manifestRace, initRace, segmentRace },
      recoveryRequests,
      requestTimeline: routes.state.requests,
      diagnostics,
    };
  } finally {
    if (fixture !== undefined) {
      await runLiveRecoveryStep('recovery fixture cleanup', () => closeLiveFixture(fixture), 15000);
    }
  }
}

const liveGapExpectations = Object.freeze({
  permanent: 'SEGMENT_PERMANENT_404',
  slide: 'GAP_MANIFEST_SLID_PAST_EXPECTED',
  rollback: 'GAP_MANIFEST_SEQUENCE_ROLLBACK',
  variantMissing: 'MANIFEST_VARIANT_MISSING',
  mapMissing: 'MANIFEST_FMP4_MAP_MISSING',
  initMapChanged: 'GAP_MANIFEST_INITIALIZATION_CHANGED',
  audioInit: 'LIVE_AUDIO_TRACK_MISSING',
  mseTimeout: 'MSE_WAIT_TIMEOUT',
  appendFailure: 'MSE_APPEND_ERROR',
  removeFailure: 'MSE_REMOVE_ERROR',
});

async function runLiveGapScenario(context, kind) {
  const fixture = await openLiveFixture(context, { kind });
  try {
    const { page, routes } = fixture;
    if (kind === 'removeFailure') {
      await page.waitForFunction(
        () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-119'),
        undefined,
        { timeout: 15000 },
      );
      const setTime = await fixture.cdp.send('Runtime.evaluate', {
        contextId: fixture.isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
        expression: `(() => {
          const video = document.querySelector('video');
          video.currentTime = 31;
          return video.currentTime;
        })()`,
      });
      if (setTime.exceptionDetails !== undefined) {
        throw new Error(`could not set fake live currentTime in the extension isolated world: ${JSON.stringify(setTime)}`);
      }
      assert.equal(setTime.result.value, 31);
      await page.waitForFunction(
        () => Number(document.documentElement.dataset.bilibiliBufferLiveRemoveCalls || 0) >= 1,
        undefined,
        { timeout: 15000 },
      );
    }
    if (kind !== 'appendFailure') {
      await waitForPanelState(page, 'GAP_UNRECOVERABLE', 15000);
    }
    const gap = await readLiveFixture(page);
    assert.equal(gap.state, 'GAP_UNRECOVERABLE');
    assert.match(gap.message, new RegExp(liveGapExpectations[kind]));
    assert.equal(gap.skipVisible, 'visible');
    assert.equal(gap.returnVisible, 'visible');
    let manualRecovery;
    if (kind !== 'appendFailure') {
      routes.releaseFault();
      if (kind === 'removeFailure') {
        await page.evaluate(() => {
          document.documentElement.dataset.bilibiliBufferLiveReleaseMseFault = 'true';
        });
      }
      if (kind === 'mseTimeout') {
        await page.evaluate(() => {
          document.documentElement.dataset.bilibiliBufferLiveReleaseMseFault = 'true';
        });
      }
      await clickPanelAction(page, kind === 'permanent' ? 'skip-gap' : 'return-live');
      await Promise.all([
        waitForPanelState(page, 'RECOVERING'),
        page.waitForFunction(
          (previousSource) =>
            document.querySelector('video').src !== previousSource &&
            document.querySelector('video').src.startsWith('blob:'),
          gap.videoSrc,
        ),
      ]);
      manualRecovery = await readLiveFixture(page);
      assert.equal(manualRecovery.state, 'RECOVERING');
      assert.ok(manualRecovery.videoSrc.startsWith('blob:'));
    }
    const expectedErrorMatchers = [/\[BilibiliBuffer\] 进入 GAP_UNRECOVERABLE/];
    if (kind === 'permanent') {
      expectedErrorMatchers.push((entry) => entry.location.url.includes('/live/seg-120.m4s?') &&
        entry.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)');
    }
    const diagnostics = assertDiagnostics(fixture.diagnostics, expectedErrorMatchers);
    assert.ok(diagnostics.expectedErrors.length >= 1, 'induced GAP must be classified in the scenario report');
    return {
      status: 'PASS',
      kind,
      gap,
      manualRecovery,
      requestTimeline: routes.state.requests,
      diagnostics,
    };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runLiveSignatureScenario(context) {
  const fixture = await openLiveFixture(context, { kind: 'signature' });
  try {
    await fixture.page.waitForFunction(() =>
      JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-119'),
    );
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const renewed = fixture.routes.state.requests.some((entry) => entry.url.includes('renewed-cdn'));
      if (fixture.routes.state.apiCalls >= 2 && renewed) {
        break;
      }
      await wait(100);
    }
    const snapshot = await readLiveFixture(fixture.page);
    assert.ok(fixture.routes.state.apiCalls >= 2, '401/403 must renew play-info and signed candidates');
    assert.ok(snapshot.appended.includes('seg-119'));
    const renewedRequests = fixture.routes.state.requests.filter((entry) => entry.url.includes('renewed-cdn'));
    assert.ok(renewedRequests.length > 0);
    assert.ok(renewedRequests.every((entry) => new URL(entry.url).searchParams.get('sign')?.startsWith('new-')));
    const diagnostics = assertDiagnostics(fixture.diagnostics, [
      (entry) => entry.location.url.includes('/live/seg-119.m4s?') &&
          entry.location.url.includes('sign=old-') &&
          entry.text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)',
    ]);
    return {
      status: 'PASS',
      apiCalls: fixture.routes.state.apiCalls,
      snapshot,
      requestTimeline: fixture.routes.state.requests,
      diagnostics,
    };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runTemporaryManifestScenario(context, kind) {
  const fixture = await openLiveFixture(context, { kind });
  try {
    const { page, routes } = fixture;
    await page.waitForFunction(
      () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-119'),
      undefined,
      { timeout: 15000 },
    );
    routes.activateTemporaryManifestFailure();
    await page.waitForFunction(
      () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-120'),
      undefined,
      { timeout: kind === 'manifestTimeout' ? 20000 : 10000 },
    );
    assert.notEqual((await panelState(page)).state, 'GAP_UNRECOVERABLE');
    assert.equal(routes.state.temporaryManifestFailures, 2);
    const snapshot = await readLiveFixture(page);
    assert.notEqual(snapshot.state, 'GAP_UNRECOVERABLE');
    const diagnostics = assertDiagnostics(
      fixture.diagnostics,
      kind === 'manifest503'
        ? [
            (entry) => entry.location.url.includes('/live/index.m3u8?') &&
              entry.location.url.includes('sign=old-') &&
              entry.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
          ]
        : [],
    );
    return {
      status: 'PASS',
      kind,
      snapshot,
      requestTimeline: routes.state.requests,
      diagnostics,
    };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runLiveDelayedPlayerScenario(context) {
  const fixture = await openLiveFixture(context, { kind: 'delayedPlayer' });
  try {
    await fixture.page.waitForFunction(
      () => JSON.parse(document.documentElement.dataset.bilibiliBufferLiveAppended || '[]').includes('seg-119'),
      undefined,
      { timeout: 15000 },
    );
    await fixture.page.waitForFunction(() => window.__liveFixture.playerInstalledAt !== undefined, undefined, {
      timeout: 5000,
    });
    const result = await readLiveFixture(fixture.page);
    const delayedTiming = await fixture.page.evaluate(() => ({
      videoInsertedAt: window.__liveFixture.videoInsertedAt,
      playerInstalledAt: window.__liveFixture.playerInstalledAt,
    }));
    assert.ok(delayedTiming.playerInstalledAt - delayedTiming.videoInsertedAt >= 200);
    assert.equal(result.state, 'LIVE');
    assert.notEqual(result.state, 'ERROR');
    assert.notEqual(result.message, 'LIVE_START_FAILED: 直播初始媒体管线失败');
    const diagnostics = assertDiagnostics(fixture.diagnostics);
    return { status: 'PASS', result, delayedTiming, requestTimeline: fixture.routes.state.requests, diagnostics };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runLiveImmediateDisableScenario(context) {
  const fixture = await openLiveFixture(context, { kind: 'immediateDisable' });
  try {
    const { page } = fixture;
    await page.waitForFunction(() =>
      document.querySelector('.danmaku-root')?.style.display === 'none' &&
      document.querySelector('danmaku')?.style.display === 'none' &&
      document.querySelector('.chat-history-panel')?.style.display === 'none',
    undefined, { timeout: 15000 });
    const beforeDisable = await readLiveFixture(page);
    assert.equal(beforeDisable.playbackRate, 1);
    await clickPanelAction(page, 'toggle');
    await waitForPopupAction(page, 'toggle', '启用', 5000);
    const disabledInteraction = await page.evaluate(() => {
      const video = document.querySelector('video');
      const before = video.currentTime;
      video.playbackRate = 2;
      video.dispatchEvent(new Event('ratechange'));
      video.currentTime = before + 1;
      video.dispatchEvent(new Event('seeking'));
      return { before, afterSeek: video.currentTime, playbackRate: video.playbackRate };
    });
    await page.waitForFunction(() =>
      document.querySelector('.danmaku-root')?.style.display === 'block' &&
      document.querySelector('danmaku')?.style.display === 'block' &&
      document.querySelector('.chat-history-panel')?.style.display === 'flex',
    undefined, { timeout: 5000 });
    await wait(700);
    const disabled = await readLiveFixture(page);
    assert.equal(disabled.toggleLabel, '启用');
    assert.equal(disabledInteraction.playbackRate, 2, 'disabling must stop the live 1× rate guard immediately');
    assert.equal(disabledInteraction.afterSeek, disabledInteraction.before + 1, 'disabling must stop the forward-seek guard');
    assert.equal(disabled.playbackRate, 2);

    await clickPanelAction(page, 'toggle');
    await waitForPopupAction(page, 'toggle', '停用', 10000);
    const reenabledInteraction = await page.evaluate(() => {
      const video = document.querySelector('video');
      video.dispatchEvent(new Event('timeupdate'));
      const before = video.currentTime;
      video.playbackRate = 2;
      video.dispatchEvent(new Event('ratechange'));
      video.currentTime = before + 1;
      video.dispatchEvent(new Event('seeking'));
      return { before, afterSeek: video.currentTime, playbackRate: video.playbackRate };
    });
    await page.waitForFunction(() =>
      document.querySelector('.danmaku-root')?.style.display === 'none' &&
      document.querySelector('danmaku')?.style.display === 'none' &&
      document.querySelector('.chat-history-panel')?.style.display === 'none',
    undefined, { timeout: 10000 });
    const reenabled = await readLiveFixture(page);
    assert.equal(reenabled.toggleLabel, '停用');
    assert.equal(reenabledInteraction.playbackRate, 1, 're-enabling must restore the live 1× rate guard');
    assert.equal(reenabledInteraction.afterSeek, reenabledInteraction.before, 're-enabling must restore seek rejection');
    const diagnostics = assertDiagnostics(fixture.diagnostics);
    return {
      status: 'PASS',
      beforeDisable,
      disabledInteraction,
      disabled,
      reenabledInteraction,
      reenabled,
      requestTimeline: fixture.routes.state.requests,
      diagnostics,
    };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runLivePopupRefreshScenario(context) {
  const fixture = await openLiveFixture(context, { kind: 'popupLive' });
  try {
    const { page, popup, popupDiagnostics, extensionId } = fixture;
    assert.equal(await popup.locator('input[data-preference="liveEnabled"]').isChecked(), true);
    await page.bringToFront();
    await popup.locator('input[data-preference="liveEnabled"]').uncheck();
    await popup.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('下次刷新'));
    assert.equal(await page.locator('[data-bilibili-buffer-panel="true"]').count(), 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(1000);
    assert.equal(await page.locator('[data-bilibili-buffer-panel="true"]').count(), 0);
    assert.equal((await popupState(page)).state, '未提供');
    await popup.bringToFront();
    await popup.locator('input[data-preference="liveEnabled"]').check();
    await popup.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('下次刷新'));
    const diagnostics = {
      page: assertDiagnostics(fixture.diagnostics),
      popup: assertDiagnostics(popupDiagnostics),
    };
    return { status: 'PASS', extensionId, diagnostics };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runPopupStaleSpaActionScenario(context) {
  const fixture = await openLiveFixture(context, { kind: 'popupLive' });
  try {
    const { page, popup } = fixture;
    await page.bringToFront();
    const current = await popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const snapshot = await chrome.tabs.sendMessage(tab.id, { version: 1, type: 'status:get' });
      return { tabId: tab.id, surfaceId: snapshot.surfaceId };
    });
    assert.equal(typeof current.surfaceId, 'string');
    await page.evaluate(() => history.pushState({}, '', '/6363772?popup-stale-action=1'));
    const response = await popup.evaluate(async ({ tabId, surfaceId }) => {
      try {
        return await chrome.tabs.sendMessage(tabId, {
          version: 1,
          type: 'action:run',
          surfaceId,
          action: 'toggle',
        });
      } catch (error) {
        return { transportError: error.message || String(error) };
      }
    }, current);
    assert.equal(response.ok, false, `stale popup action unexpectedly ran: ${JSON.stringify(response)}`);
    assert.ok(
      ['UI_SURFACE_STALE', 'POPUP_SURFACE_UNAVAILABLE'].includes(response.error?.code),
      `unexpected stale action response: ${JSON.stringify(response)}`,
    );
    return { status: 'PASS', response, diagnostics: assertDiagnostics(fixture.diagnostics) };
  } finally {
    await closeLiveFixture(fixture);
  }
}

async function runVodCapabilityScenario(context, kind) {
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);
  const url = `https://www.bilibili.com/video/BVextension-${kind}`;
  await page.route(url, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: createVodHtml(kind),
  }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const extensionId = await page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId);
  const { popup, diagnostics: popupDiagnostics } = await openPopup(context, extensionId, page);
  try {
    const expectedState = kind === 'unsupported' ? 'UNSUPPORTED' : 'FAILED';
    await popup.waitForFunction(
      (state) => document.querySelector('[data-status-field="state"]').textContent === state,
      expectedState,
      { timeout: 15000 },
    );
    const actual = await page.evaluate(() => {
      const video = window.__fakeVodState.video;
      return {
        stable: window.__fakeVodState.stable,
        playCalls: window.__fakeVodState.playCalls,
        pauseCalls: window.__fakeVodState.pauseCalls,
        paused: window.__fakeVodState.paused,
        currentTime: window.__fakeVodState.currentTime,
        playbackRate: video.playbackRate,
        muted: video.muted,
        volume: video.volume,
        source: window.__fakeVodState.source,
      };
    });
    assert.equal(actual.playCalls, 0);
    assert.equal(actual.pauseCalls, 0);
    assert.equal(actual.paused, true);
    assert.equal(actual.currentTime, 10);
    assert.equal(actual.playbackRate, 1);
    assert.equal(actual.muted, true);
    assert.equal(actual.volume, 0);
    assert.equal(actual.source, 'data:video/mp4;base64,AA==');
    assert.equal(actual.stable.length, 0);
    const status = await panelState(page);
    assert.equal(status.quality, '未提供');
    assert.equal(status.speed, '未提供');
    assert.equal(status.multiplier, '未提供');
    assert.equal(status.skipVisible, 'hidden');
    assert.equal(status.returnVisible, 'hidden');
    const expectedErrors = kind === 'failed' ? [/原生缓存提示调用失败/] : [];
    const result = {
      status: expectedState,
      actual,
      panel: status,
      diagnostics: {
        page: assertDiagnostics(diagnostics, expectedErrors),
        popup: assertDiagnostics(popupDiagnostics),
      },
    };
    await closeFixturePage(popup, `VOD ${kind} popup`);
    await closeFixturePage(page, `VOD ${kind} page`);
    return result;
  } catch (error) {
    if (!popup.isClosed()) {
      await closeFixturePage(popup, `VOD ${kind} popup after failure`);
    }
    if (!page.isClosed()) {
      await closeFixturePage(page, `VOD ${kind} page after failure`);
    }
    throw error;
  }
}

const report = {
  status: 'FAIL',
  browser: 'Playwright Chromium persistent context; headless; --mute-audio; fresh task profile',
  extension: path.relative(root, extensionDirectory),
  loadedManifest: undefined,
  scenarios: {},
};

async function checkpointReport() {
  await fs.mkdir(reportDirectory, { recursive: true });
  const temporaryPath = `${reportPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, reportPath);
}

async function runLiveRecoveryStep(label, operation, timeoutMilliseconds = 60000) {
  const scenario = report.currentScenario;
  scenario.step = { label, status: 'RUNNING', startedAt: new Date().toISOString() };
  await checkpointReport();
  console.log(`E2E STEP ${label}`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`live recovery step ${label} exceeded ${timeoutMilliseconds}ms`)),
          timeoutMilliseconds,
        );
      }),
    ]);
    scenario.step = { label, status: 'PASS', completedAt: new Date().toISOString() };
    await checkpointReport();
    return result;
  } catch (error) {
    const failedStep = {
      label,
      status: 'FAIL',
      failedAt: new Date().toISOString(),
      error: error.stack || error.message || String(error),
    };
    scenario.step = failedStep;
    scenario.failedStep = failedStep;
    await checkpointReport();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(name, runner) {
  if (scenarioFilter !== undefined && scenarioFilter !== name) {
    console.log(`E2E SKIP ${name}`);
    return undefined;
  }
  report.currentScenario = { name, status: 'RUNNING', startedAt: new Date().toISOString() };
  await checkpointReport();
  console.log(`E2E START ${name}`);
  try {
    const result = await runner();
    report.scenarios[name] = result;
    report.currentScenario = { name, status: 'PASS', completedAt: new Date().toISOString() };
    await checkpointReport();
    console.log(`E2E PASS ${name}`);
    return result;
  } catch (error) {
    const step = report.currentScenario?.step;
    const failedStep = report.currentScenario?.failedStep;
    report.currentScenario = {
      name,
      status: 'FAIL',
      failedAt: new Date().toISOString(),
      error: error.stack || error.message || String(error),
      step,
      failedStep,
    };
    await checkpointReport();
    console.log(`E2E FAIL ${name}`);
    throw error;
  }
}

let context;
let profileDirectory;
let browserLibraryDirectory;
try {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
  report.loadedManifest = {
    manifestVersion: manifest.manifest_version,
    minimumChromeVersion: manifest.minimum_chrome_version,
    contentScripts: manifest.content_scripts,
  };
  profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'smooth-bilibili-extension-e2e-'));
  browserLibraryDirectory = await prepareLocalBrowserLibraries();
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    channel: 'chromium',
    args: [
      '--mute-audio',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  await context.addInitScript({ content: `(${audioGuard.toString()})();` });
  const page = context.pages()[0] || await context.newPage();
  const vodScenario = await runScenario('vodActualMediaAndPopup', () => runVodScenario(context, page));
  if (vodScenario !== undefined) {
    report.extensionRuntimeId = vodScenario.extensionId;
  }
  await runScenario('livePopupRefresh', () => runLivePopupRefreshScenario(context));
  await runScenario('popupStaleSpaAction', () => runPopupStaleSpaActionScenario(context));
  await runScenario('liveDelayedPlayer', () => runLiveDelayedPlayerScenario(context));
  await runScenario('liveImmediateDisable', () => runLiveImmediateDisableScenario(context));
  for (const outageSeconds of [2, 10, 30]) {
    await runScenario(
      `liveRecoverySameSequence${outageSeconds}s`,
      () => runLiveRecoveryScenario(context, outageSeconds),
    );
  }
  for (const kind of Object.keys(liveGapExpectations)) {
    await runScenario(`liveGap${kind}`, () => runLiveGapScenario(context, kind));
  }
  await runScenario('liveSignatureRenewal', () => runLiveSignatureScenario(context));
  await runScenario('liveTemporaryManifest503', () => runTemporaryManifestScenario(context, 'manifest503'));
  await runScenario('liveTemporaryManifestTimeout', () => runTemporaryManifestScenario(context, 'manifestTimeout'));
  for (const capabilityMode of ['unsupported', 'failed']) {
    await runScenario(`vodCapability${capabilityMode}`, () => runVodCapabilityScenario(context, capabilityMode));
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.stack || error.message || String(error);
  await checkpointReport();
  throw error;
} finally {
  const mainFailed = report.status === 'FAIL';
  const cleanupFailures = [];
  if (context !== undefined) {
    const failuresBeforeContextClose = cleanupFailures.length;
    await runCleanupStep(cleanupFailures, 'persistent browser context close', () => context.close());
    if (cleanupFailures.length > failuresBeforeContextClose) {
      let browser;
      await runCleanupStep(cleanupFailures, 'persistent browser fallback handle', () => {
        browser = context.browser();
      });
      if (browser !== undefined && browser !== null) {
        await runCleanupStep(cleanupFailures, 'persistent browser fallback close', () => browser.close());
      }
    }
  }
  if (profileDirectory !== undefined) {
    await runCleanupStep(cleanupFailures, 'temporary browser profile removal', () =>
      fs.rm(profileDirectory, { recursive: true, force: true }));
  }
  if (browserLibraryDirectory !== undefined) {
    await runCleanupStep(cleanupFailures, 'temporary browser library removal', () =>
      fs.rm(browserLibraryDirectory, { recursive: true, force: true }));
  }
  if (cleanupFailures.length > 0) {
    report.status = 'FAIL';
    report.cleanupFailures = cleanupFailures;
    if (report.error === undefined) {
      report.error = `cleanup failed: ${cleanupFailures.map((failure) => failure.label).join(', ')}`;
    }
  }
  await checkpointReport();
  console.log(JSON.stringify(report, null, 2));
  if (!mainFailed) {
    throwCleanupFailures(cleanupFailures);
  }
}
