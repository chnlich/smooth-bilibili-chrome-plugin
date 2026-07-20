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
const reportPath = path.join(reportDirectory, 'external-smoke-report.json');
const execFileAsync = promisify(execFile);
const targetRoomId = 6363772;
const approvedVodUrl = 'https://www.bilibili.com/video/BV1ohQVBFEsh';
const fallbackVodUrl = 'https://www.bilibili.com/video/BV1xx411c7mD';

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
    assertSilentBeforePlay() {
      const values = snapshot();
      if (!values.every((media) => media.muted === true && media.volume === 0)) {
        throw new Error(`audio guard violation before play: ${JSON.stringify(values)}`);
      }
      return values;
    },
  };
}

function ownershipAudit() {
  const calls = [];
  const record = (name) => calls.push({ name, at: performance.now() });
  for (const name of ['play', 'pause']) {
    const original = HTMLMediaElement.prototype[name];
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      writable: true,
      value(...args) {
        record(name);
        return original.apply(this, args);
      },
    });
  }
  window.__bilibiliOwnershipAudit = {
    reset() {
      calls.length = 0;
    },
    read() {
      return [...calls];
    },
  };
}

function playInfoUrl(roomId) {
  const url = new URL('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo');
  url.searchParams.set('room_id', String(roomId));
  url.searchParams.set('protocol', '0,1');
  url.searchParams.set('format', '0,1,2');
  url.searchParams.set('codec', '0,1');
  url.searchParams.set('qn', '10000');
  url.searchParams.set('platform', 'web');
  url.searchParams.set('ptype', '8');
  return url.href;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`official API returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`official API returned code ${payload.code}: ${payload.message || 'unknown'}`);
  }
  return payload;
}

async function selectLiveRoom() {
  const target = await fetchJson(playInfoUrl(targetRoomId));
  if (target.data?.live_status === 1) {
    return { roomId: targetRoomId, source: 'approved room 6363772 is live' };
  }
  const recommendations = await fetchJson(
    'https://api.live.bilibili.com/xlive/web-interface/v1/webMain/getList?platform=web&page=1&page_size=30',
  );
  const rooms = recommendations.data?.recommend_room_list;
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new Error('official recommendations returned no rooms');
  }
  for (const room of rooms.slice(0, 5)) {
    const roomId = Number(room.roomid ?? room.room_id);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      continue;
    }
    const payload = await fetchJson(playInfoUrl(roomId));
    if (payload.data?.live_status === 1) {
      return { roomId, source: `approved room is offline; selected official live room ${roomId}` };
    }
  }
  throw new Error('official recommendations contained no live room');
}

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
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMilliseconds}ms`)),
          timeoutMilliseconds,
        );
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
    'external smoke cleanup failed',
  );
}

const environmentPatterns = [
  'anti.?bot',
  'captcha',
  'forbidden',
  'blocked',
  'VIDEO_NOT_FOUND',
  'VOD_CORE_UNAVAILABLE',
  'LIVE_HLS_UNSUPPORTED',
  'MSE_CODEC_UNSUPPORTED',
  'MSE_UNSUPPORTED',
  'LIVE_HLS_MISSING',
  'PLAY_INFO_',
  'official API',
  'official recommendations',
  'net::ERR_',
  'ERR_(?:CONNECTION|NAME|INTERNET|NETWORK|TIMED_OUT)',
  'ECONN(?:RESET|REFUSED|ABORTED)',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'Timeout',
];

function environmentBlocked(message) {
  return new RegExp(environmentPatterns.join('|'), 'i').test(message);
}

function extensionDiagnostics(consoleErrors, pageErrors) {
  return {
    consoleErrors: consoleErrors.filter(
      (entry) => entry.text.includes('[BilibiliBuffer]') || entry.location.url.startsWith('chrome-extension://'),
    ),
    pageErrors: pageErrors.filter((entry) => entry.includes('chrome-extension://')),
  };
}

function nonProductDiagnosticsAreBlocked(consoleErrors, pageErrors) {
  const text = [...consoleErrors.map((entry) => entry.text), ...pageErrors].join('\n');
  return {
    status: 'BLOCKED',
    reason: environmentBlocked(text)
      ? 'anonymous page environment emitted a classified blocking diagnostic'
      : 'anonymous page emitted a non-extension diagnostic that cannot establish a product result',
  };
}

function hasViableTerminalState(mode, state) {
  return mode === '点播' ? state === 'APPLIED' : state === 'LIVE' || state === 'DELAYED';
}

function evaluateSnapshot(snapshot, mode) {
  if (snapshot.status === undefined) {
    return {
      status: 'BLOCKED',
      reason: 'anonymous page exposed video, but the toolbar popup did not expose a current-tab status snapshot',
    };
  }
  const status = snapshot.status;
  if (status.state === 'ERROR') {
    const reason = status.message || 'controller entered ERROR';
    return { status: environmentBlocked(reason) ? 'BLOCKED' : 'FAIL', reason };
  }
  if (status.state === 'GAP_UNRECOVERABLE') {
    return {
      status: 'FAIL',
      reason: status.message || 'controller entered GAP_UNRECOVERABLE on the real page',
    };
  }
  if (status.mode !== mode) {
    return {
      status: 'FAIL',
      reason: `controller reported mode ${status.mode || 'missing'} instead of ${mode}`,
    };
  }
  if (snapshot.media === undefined || snapshot.media.currentSrc.length === 0 || snapshot.media.readyState < 2) {
    return {
      status: 'BLOCKED',
      reason: 'anonymous page did not converge to a usable media resource',
    };
  }
  if (mode === '直播' && status.speed !== '1×') {
    return {
      status: 'FAIL',
      reason: `controller reported live speed ${status.speed || 'missing'} instead of 1×`,
    };
  }
  if (snapshot.media.muted !== true || snapshot.media.volume !== 0) {
    return {
      status: 'FAIL',
      reason: 'media was not synchronously muted with zero volume',
    };
  }
  if (mode === '点播' && status.state !== 'APPLIED') {
    return {
      status: status.state === 'WAITING' ? 'BLOCKED' : 'FAIL',
      reason: `VOD native buffer hint state was ${status.state || 'missing'}: ${status.message || 'no message'}`,
    };
  }
  if (mode === '直播') {
    const inventory = Number.parseFloat(status.inventory || '');
    if (!(inventory > 0)) {
      return {
        status: 'BLOCKED',
        reason: `anonymous live page did not form nonzero continuous inventory: ${status.inventory || 'missing'}`,
      };
    }
  }
  if (!hasViableTerminalState(mode, status.state)) {
    return {
      status: 'BLOCKED',
      reason: `controller did not reach a viable terminal state: ${status.state || 'missing'}`,
    };
  }
  return undefined;
}

async function closeExternalPage(page, popup) {
  const failures = [];
  if (popup !== undefined) {
    await runCleanupStep(failures, 'external smoke popup close', () => popup.close({ runBeforeUnload: false }));
  }
  await runCleanupStep(failures, 'external smoke page close', () => page.close({ runBeforeUnload: false }));
  throwCleanupFailures(failures);
}

async function openExternalPopup(context, extensionId, targetPage, consoleErrors, pageErrors, timeoutMilliseconds = 10000) {
  const popup = await context.newPage();
  popup.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  popup.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: timeoutMilliseconds });
  await popup.waitForSelector('input[data-preference="liveEnabled"]', { timeout: timeoutMilliseconds });
  await targetPage.bringToFront();
  return { popup };
}

async function runExternalPage(context, url, mode) {
  let page;
  let popup;
  let beforePlay;
  let lastSnapshot;
  let phase = 'page navigation';
  const liveDeadlineMilliseconds = mode === '直播' ? Date.now() + 30000 : undefined;
  const timeoutBeforeLiveDeadline = (fallbackMilliseconds) => {
    if (liveDeadlineMilliseconds === undefined) {
      return fallbackMilliseconds;
    }
    return Math.max(1, Math.min(fallbackMilliseconds, liveDeadlineMilliseconds - Date.now()));
  };
  const withinLiveDeadline = async (operation) => {
    if (liveDeadlineMilliseconds === undefined) {
      return operation();
    }
    const remainingMilliseconds = liveDeadlineMilliseconds - Date.now();
    if (remainingMilliseconds <= 0) {
      throw Object.assign(new Error('anonymous live smoke reached its absolute 30-second deadline'), {
        code: 'LIVE_SMOKE_DEADLINE',
      });
    }
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('anonymous live smoke reached its absolute 30-second deadline'), {
                  code: 'LIVE_SMOKE_DEADLINE',
                }),
              ),
            remainingMilliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const withLastLiveStage = (result) =>
    mode === '直播'
      ? { ...result, lastStage: result.lastStage || lastSnapshot?.status?.stage || '未提供' }
      : result;
  const consoleErrors = [];
  const pageErrors = [];
  const readMedia = () => page.evaluate(() => {
    const video = document.querySelector('video');
    const forwardBuffer = (media) => {
      if (media === null) {
        return undefined;
      }
      for (let index = 0; index < media.buffered.length; index += 1) {
        const start = media.buffered.start(index);
        const end = media.buffered.end(index);
        if (start <= media.currentTime && media.currentTime <= end) {
          return Math.max(0, end - media.currentTime);
        }
      }
      return 0;
    };
    return {
      media: video === null
        ? undefined
        : {
            currentSrc: video.currentSrc,
            readyState: video.readyState,
            currentTime: video.currentTime,
            playbackRate: video.playbackRate,
            muted: video.muted,
            volume: video.volume,
            paused: video.paused,
            forwardBuffer: forwardBuffer(video),
          },
    };
  });
  const readSnapshot = async () => ({
    status: popup === undefined
      ? undefined
      : await popup.evaluate(() => {
        const value = (field) => document.querySelector(`[data-status-field="${field}"]`)?.textContent;
        const state = value('state');
        if (state === undefined || state === '未提供') {
          return undefined;
        }
        return {
          mode: value('mode'),
          state,
          inventory: value('inventory'),
          delay: value('delay'),
          quality: value('quality'),
          speed: value('speed'),
          multiplier: value('multiplier'),
          stage: value('stage'),
          message: value('message'),
          actions: Object.fromEntries(
            [...document.querySelectorAll('[data-actions] [data-action]')]
              .map((button) => [button.dataset.action, button.textContent]),
          ),
        };
      }),
    ...(await readMedia()),
  });
  try {
    page = await withinLiveDeadline(() => context.newPage());
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push({ text: message.text(), location: message.location() });
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await withinLiveDeadline(() =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutBeforeLiveDeadline(30000) }),
    );
    phase = 'extension runtime marker';
    await withinLiveDeadline(() =>
      page.waitForFunction(
        () => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId,
        undefined,
        { timeout: timeoutBeforeLiveDeadline(10000) },
      ),
    );
    const extensionId = await withinLiveDeadline(() =>
      page.evaluate(() => document.documentElement.dataset.bilibiliBufferExtensionRuntimeId),
    );
    phase = 'toolbar popup';
    ({ popup } = await withinLiveDeadline(() =>
      openExternalPopup(
        context,
        extensionId,
        page,
        consoleErrors,
        pageErrors,
        timeoutBeforeLiveDeadline(10000),
      ),
    ));
    if (mode === '直播') {
      phase = 'live observation';
      let first;
      while (Date.now() < liveDeadlineMilliseconds) {
        const snapshot = await withinLiveDeadline(readSnapshot);
        lastSnapshot = snapshot;
        if (Date.now() >= liveDeadlineMilliseconds) {
          break;
        }
        if (snapshot.media !== undefined && beforePlay === undefined) {
          beforePlay = await withinLiveDeadline(() =>
            page.evaluate(() => window.__bilibiliAudioGuard.assertSilentBeforePlay()),
          );
          assert.ok(beforePlay.every((media) => media.muted === true && media.volume === 0));
          if (Date.now() >= liveDeadlineMilliseconds) {
            break;
          }
        }
        const extensionErrors = extensionDiagnostics(consoleErrors, pageErrors);
        if (extensionErrors.consoleErrors.length > 0 || extensionErrors.pageErrors.length > 0) {
          return withLastLiveStage({
            status: 'FAIL',
            url,
            reason: 'extension/product error was logged on the real page',
            first,
            last: snapshot,
            beforePlay,
            consoleErrors,
            pageErrors,
            extensionErrors,
          });
        }
        if (consoleErrors.length > 0 || pageErrors.length > 0) {
          return withLastLiveStage({
            ...nonProductDiagnosticsAreBlocked(consoleErrors, pageErrors),
            url,
            first,
            last: snapshot,
            beforePlay,
            consoleErrors,
            pageErrors,
            extensionErrors,
          });
        }
        const result = evaluateSnapshot(snapshot, mode);
        if (result?.status === 'FAIL' || snapshot.status?.state === 'ERROR') {
          return withLastLiveStage({
            ...result,
            url,
            first,
            last: snapshot,
            beforePlay,
            consoleErrors,
            pageErrors,
            extensionErrors,
          });
        }
        if (result === undefined) {
          if (
            first !== undefined &&
            snapshot.media.currentTime > first.media.currentTime &&
            Date.now() < liveDeadlineMilliseconds
          ) {
            return withLastLiveStage({
              status: 'PASS',
              url,
              first,
              second: snapshot,
              beforePlay,
              consoleErrors,
              pageErrors,
              extensionErrors,
            });
          }
          first = snapshot;
        }
        const remainingMilliseconds = liveDeadlineMilliseconds - Date.now();
        if (remainingMilliseconds > 0) {
          await wait(Math.min(500, remainingMilliseconds));
        }
      }
      const extensionErrors = extensionDiagnostics(consoleErrors, pageErrors);
      return withLastLiveStage({
        status: extensionErrors.consoleErrors.length > 0 || extensionErrors.pageErrors.length > 0 ? 'FAIL' : 'BLOCKED',
        url,
        reason: 'anonymous live page did not form nonzero inventory and advancing media time within 30 seconds',
        last: lastSnapshot,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors,
      });
    }
    phase = 'VOD media discovery';
    await page.waitForFunction(() => document.querySelector('video') !== null, undefined, { timeout: 20000 });
    beforePlay = await page.evaluate(() => window.__bilibiliAudioGuard.assertSilentBeforePlay());
    assert.ok(beforePlay.every((media) => media.muted === true && media.volume === 0));
    await popup.waitForFunction(
      () => document.querySelector('[data-status-field="state"]')?.textContent !== '未提供',
      undefined,
      { timeout: 20000 },
    );
    await wait(15000);
    const first = await readSnapshot();
    lastSnapshot = first;
    const extensionErrors = extensionDiagnostics(consoleErrors, pageErrors);
    if (extensionErrors.consoleErrors.length > 0 || extensionErrors.pageErrors.length > 0) {
      return {
        status: 'FAIL',
        url,
        reason: 'extension/product error was logged on the real page',
        first,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors,
      };
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      return {
        ...nonProductDiagnosticsAreBlocked(consoleErrors, pageErrors),
        url,
        first,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors,
      };
    }
    const firstResult = evaluateSnapshot(first, mode);
    if (firstResult !== undefined) {
      return {
        ...firstResult,
        url,
        first,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors,
      };
    }
    if (mode === '点播') {
      await page.evaluate(() => window.__bilibiliOwnershipAudit.reset());
    }
    await wait(5000);
    const second = await readSnapshot();
    lastSnapshot = second;
    const secondExtensionErrors = extensionDiagnostics(consoleErrors, pageErrors);
    if (secondExtensionErrors.consoleErrors.length > 0 || secondExtensionErrors.pageErrors.length > 0) {
      return {
        status: 'FAIL',
        url,
        reason: 'extension/product error was logged during bounded media progress observation',
        first,
        second,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      return {
        ...nonProductDiagnosticsAreBlocked(consoleErrors, pageErrors),
        url,
        first,
        second,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    const secondResult = evaluateSnapshot(second, mode);
    if (secondResult !== undefined) {
      return {
        ...secondResult,
        url,
        first,
        second,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    const ownershipCalls = mode === '点播'
      ? await page.evaluate(() => window.__bilibiliOwnershipAudit.read())
      : [];
    if (mode === '点播' && ownershipCalls.length > 0) {
      return {
        status: 'FAIL',
        url,
        reason: `VOD playback ownership methods were called after the native hint settled: ${JSON.stringify(ownershipCalls)}`,
        first,
        second,
        beforePlay,
        ownershipCalls,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    if (mode === '点播' && second.media.playbackRate !== first.media.playbackRate) {
      return {
        status: 'FAIL',
        url,
        reason: `VOD playbackRate changed during the observation: ${first.media.playbackRate} -> ${second.media.playbackRate}`,
        first,
        second,
        beforePlay,
        ownershipCalls,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    if (mode === '点播' && second.media.currentSrc !== first.media.currentSrc) {
      return {
        status: 'FAIL',
        url,
        reason: `VOD media source changed during the observation: ${first.media.currentSrc} -> ${second.media.currentSrc}`,
        first,
        second,
        beforePlay,
        ownershipCalls,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    if (second.media.currentTime <= first.media.currentTime) {
      return {
        status: 'BLOCKED',
        url,
        reason: 'anonymous media did not advance during the bounded 5-second observation',
        first,
        second,
        beforePlay,
        consoleErrors,
        pageErrors,
        extensionErrors: secondExtensionErrors,
      };
    }
    return {
      status: 'PASS',
      url,
      first,
      second,
      beforePlay,
      ownershipCalls,
      consoleErrors,
      pageErrors,
      extensionErrors: secondExtensionErrors,
    };
  } catch (error) {
    const reason = error.stack || error.message || String(error);
    const errors = extensionDiagnostics(consoleErrors, pageErrors);
    const productAssertion = error?.name === 'AssertionError';
    const extensionSetupFailure = phase === 'extension runtime marker' || phase === 'toolbar popup';
    return withLastLiveStage({
      status:
        error?.code === 'LIVE_SMOKE_DEADLINE'
          ? errors.consoleErrors.length > 0 || errors.pageErrors.length > 0
            ? 'FAIL'
            : 'BLOCKED'
          : errors.consoleErrors.length > 0 ||
              errors.pageErrors.length > 0 ||
              productAssertion ||
              extensionSetupFailure ||
              !environmentBlocked(reason)
        ? 'FAIL'
        : 'BLOCKED',
      url,
      reason,
      last: lastSnapshot,
      beforePlay,
      consoleErrors,
      pageErrors,
      extensionErrors: errors,
    });
  } finally {
    if (page !== undefined) {
      await closeExternalPage(page, popup);
    }
  }
}

async function runVodSmoke(context) {
  const approved = await runExternalPage(context, approvedVodUrl, '点播');
  if (approved.status !== 'BLOCKED') {
    return {
      status: approved.status,
      selectedUrl: approvedVodUrl,
      attempts: [approved],
    };
  }
  const fallback = await runExternalPage(context, fallbackVodUrl, '点播');
  return {
    status: fallback.status,
    selectedUrl: fallbackVodUrl,
    approvedUnavailable: approved,
    attempts: [approved, fallback],
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'smooth-bilibili-external-libs-'));
  try {
    await execFileAsync('apt-get', ['download', 'libnspr4', 'libnss3', 'libasound2t64'], { cwd: directory });
    const packages = (await fs.readdir(directory)).filter((name) => name.endsWith('.deb'));
    const extractionDirectory = path.join(directory, 'root');
    await fs.mkdir(extractionDirectory);
    for (const packageName of packages) {
      await execFileAsync('dpkg-deb', ['-x', path.join(directory, packageName), extractionDirectory]);
    }
    process.env.LD_LIBRARY_PATH = [
      path.join(extractionDirectory, 'usr', 'lib', 'x86_64-linux-gnu'),
      process.env.LD_LIBRARY_PATH,
    ].filter(Boolean).join(':');
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error(`Chromium missing ${missing.join(', ')}: ${error.message || error}`);
  }
}

const report = {
  status: 'FAIL',
  browser: 'Playwright Chromium persistent context; headless; --mute-audio; fresh task profile',
  extension: path.relative(root, extensionDirectory),
  selectedRoom: undefined,
  live: undefined,
  vod: undefined,
};

async function writeReport() {
  await fs.mkdir(reportDirectory, { recursive: true });
  const temporaryPath = `${reportPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, reportPath);
}

let context;
let profileDirectory;
let browserLibraryDirectory;
try {
  report.selectedRoom = await selectLiveRoom();
  profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'smooth-bilibili-external-'));
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
  await context.addInitScript({ content: `(${ownershipAudit.toString()})();` });
  report.vod = await runVodSmoke(context);
  report.live = await runExternalPage(
    context,
    `https://live.bilibili.com/${report.selectedRoom.roomId}`,
    '直播',
  );
  const results = [report.vod, report.live];
  report.status = results.some((result) => result.status === 'FAIL')
    ? 'FAIL'
    : results.some((result) => result.status === 'BLOCKED')
      ? 'BLOCKED'
      : 'PASS';
} catch (error) {
  const reason = error.stack || error.message || String(error);
  report.status = environmentBlocked(reason) ? 'BLOCKED' : 'FAIL';
  report.error = reason;
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
  await writeReport();
  console.log(JSON.stringify(report, null, 2));
  if (!mainFailed) {
    throwCleanupFailures(cleanupFailures);
  }
}

if (report.status !== 'PASS') {
  process.exitCode = 1;
}
