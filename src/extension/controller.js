import { EXTENSION_PREFERENCES } from '../constants.js';
import { DiagnosticsClient, createRouteIdentity } from '../diagnostics/client.js';
import { PassiveMediaObserver } from '../diagnostics/passive-media-observer.js';
import { LiveObserver } from '../live/observer.js';
import { VodBufferController } from '../vod/controller.js';
import { fail, toBufferScriptError } from '../errors.js';
import {
  STATUS_MESSAGE_VERSION,
  createStatusPanel,
  createUnavailableStatusSnapshot,
  getCurrentStatusSurface,
} from '../ui/panel.js';
import { BridgeClient, createPageWindowAdapter } from './bridge-client.js';
import { SHIM_OBSERVATION_EVENT } from './bridge-contract.js';

export function isLivePage(locationObject) {
  return locationObject.hostname === 'live.bilibili.com';
}

export function isVideoPage(locationObject) {
  return locationObject.hostname === 'www.bilibili.com' && (
    locationObject.pathname.startsWith('/video/') ||
    locationObject.pathname === '/list/watchlater' ||
    locationObject.pathname.startsWith('/list/watchlater/')
  );
}

export const isVodPage = isVideoPage;

export function modeForLocation(locationObject) {
  if (isLivePage(locationObject)) return 'live';
  if (isVideoPage(locationObject)) return 'video';
  return undefined;
}

function collectSameOriginVideos(documentObject) {
  const videos = [...documentObject.querySelectorAll('video')];
  for (const iframe of documentObject.querySelectorAll('iframe')) {
    try {
      const iframeDocument = iframe.contentDocument;
      if (iframeDocument !== null) videos.push(...iframeDocument.querySelectorAll('video'));
    } catch { /* cross-origin iframe */ }
  }
  return videos;
}

export function findLargestVideo(documentObject) {
  const videos = collectSameOriginVideos(documentObject).filter((video) => video.isConnected !== false);
  return videos.sort((left, right) => {
    const leftArea = (left.clientWidth || 0) * (left.clientHeight || 0);
    const rightArea = (right.clientWidth || 0) * (right.clientHeight || 0);
    return rightArea - leftArea;
  })[0];
}

function preferenceKeyForMode(mode) {
  return mode === 'live' ? EXTENSION_PREFERENCES.liveEnabled : EXTENSION_PREFERENCES.vodEnabled;
}

function logger() {
  return {
    warn(...args) {
      console.warn('[BilibiliBuffer]', ...args);
    },
    error(...args) {
      console.error('[BilibiliBuffer]', ...args);
    },
  };
}

function setBootError(panel, error, mode) {
  const normalized = toBufferScriptError(error, 'BOOT_FAILED', '扩展控制器启动失败');
  panel.setModel({
    mode: mode === 'live' ? '直播' : '视频',
    state: 'FAILED',
    error: `${normalized.code}: ${normalized.message}`,
    target: '120 秒',
  });
}

function readPreferences(storage) {
  return storage.get([EXTENSION_PREFERENCES.liveEnabled, EXTENSION_PREFERENCES.vodEnabled]);
}

function popupError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'POPUP_REQUEST_FAILED',
    message: error?.message || String(error),
    ...(typeof error?.stack === 'string' ? { stack: error.stack } : {}),
  };
}

function assertPopupMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    fail('POPUP_MESSAGE_INVALID', 'popup 消息必须是对象');
  }
  if (message.version !== STATUS_MESSAGE_VERSION || !['status:get', 'diagnostics:session-id:get'].includes(message.type)) {
    fail('POPUP_MESSAGE_INVALID', 'popup 消息版本或类型未允许');
  }
  if (Object.keys(message).some((field) => !['version', 'type'].includes(field))) {
    fail('POPUP_MESSAGE_INVALID', 'popup 消息包含未允许字段');
  }
  return message;
}

async function handlePopupMessage(message, getDiagnosticsSessionId) {
  assertPopupMessage(message);
  if (message.type === 'diagnostics:session-id:get') {
    return {
      version: STATUS_MESSAGE_VERSION,
      ok: true,
      sessionId: getDiagnosticsSessionId(),
    };
  }
  const surface = getCurrentStatusSurface();
  if (surface === undefined) return createUnavailableStatusSnapshot(modeForLocation(window.location));
  return surface.getSnapshot();
}

export function installPopupMessageHandler(runtimeObject = chrome.runtime, getDiagnosticsSessionId = () => '未提供') {
  if (runtimeObject?.onMessage === undefined || typeof runtimeObject.onMessage.addListener !== 'function') {
    throw new Error('Chrome runtime message API 不可用');
  }
  runtimeObject.onMessage.addListener((message, _sender, sendResponse) => {
    void handlePopupMessage(message, getDiagnosticsSessionId)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({
        version: STATUS_MESSAGE_VERSION,
        ok: false,
        error: popupError(error),
      }));
    return true;
  });
}

export class ExtensionCoordinator {
  constructor({
    documentObject = document,
    windowObject = window,
    storage = chrome.storage.local,
    runtimeObject = globalThis,
    bridgeClient = new BridgeClient(documentObject, runtimeObject),
    diagnostics,
    loggerObject = logger(),
  } = {}) {
    this.documentObject = documentObject;
    this.windowObject = windowObject;
    this.storage = storage;
    this.runtimeObject = runtimeObject;
    this.bridgeClient = bridgeClient;
    this.diagnostics = diagnostics;
    this.bridgeClient.diagnostics = diagnostics;
    this.logger = loggerObject;
    this.preferences = undefined;
    this.active = undefined;
    this.routeKey = '';
    this.routeGeneration = 0;
    this.syncPromise = undefined;
    this.pendingRouteHref = '';
    this.routeAbort = undefined;
    this.routeTimer = undefined;
    this.destroyed = false;
    this.shimListener = undefined;
  }

  async start() {
    if (this.routeTimer !== undefined) throw new Error('扩展路由协调器已经启动');
    this.shimListener = (event) => {
      if (event?.detail && typeof event.detail === 'object') {
        this.diagnostics?.log('live.buffer.retained', event.detail);
      }
    };
    this.documentObject.addEventListener(SHIM_OBSERVATION_EVENT, this.shimListener);
    this.diagnostics?.log('extension.started', { action: 'coordinator' });
    this.preferences = await readPreferences(this.storage);
    this.diagnostics?.log('preference.read', {
      name: EXTENSION_PREFERENCES.liveEnabled,
      enabled: this.preferences[EXTENSION_PREFERENCES.liveEnabled] !== false,
    });
    this.diagnostics?.log('preference.read', {
      name: EXTENSION_PREFERENCES.vodEnabled,
      enabled: this.preferences[EXTENSION_PREFERENCES.vodEnabled] !== false,
    });
    const runtimeId = this.runtimeObject.chrome?.runtime?.id || this.runtimeObject.runtime?.id;
    if (this.documentObject.documentElement !== null && runtimeId !== undefined) {
      this.documentObject.documentElement.dataset.bilibiliBufferExtensionRuntimeId = runtimeId;
    }
    this.routeTimer = this.runtimeObject.setInterval(() => {
      void this.syncRoute().catch((error) => {
        this.logger.error('扩展路由同步失败', error);
        this.diagnostics?.log('extension.observer_error', { reason: 'route-sync' }, error);
      });
    }, 250);
    await this.syncRoute();
  }

  enabledFor(mode) {
    return this.preferences[preferenceKeyForMode(mode)] !== false;
  }

  syncRoute() {
    if (this.syncPromise !== undefined) {
      if (this.pendingRouteHref !== this.windowObject.location.href) this.routeAbort?.abort();
      return this.syncPromise;
    }
    this.syncPromise = this.performSyncRoute().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  async performSyncRoute() {
    if (this.destroyed) return;
    const href = this.windowObject.location.href;
    const mode = modeForLocation(this.windowObject.location);
    if (href === this.routeKey) return;
    const generation = this.routeGeneration + 1;
    this.routeGeneration = generation;
    this.routeAbort?.abort();
    const routeAbort = new AbortController();
    this.routeAbort = routeAbort;
    this.pendingRouteHref = href;
    const changedRoute = this.routeKey !== '';
    await this.teardownActive();
    if (changedRoute) {
      this.diagnostics?.startSession(createRouteIdentity(this.windowObject.location));
      this.diagnostics?.log('route.changed', { reason: 'location_changed' });
    }
    if (generation !== this.routeGeneration || this.destroyed || routeAbort.signal.aborted) return;
    this.routeKey = href;
    if (mode === undefined) {
      this.diagnostics?.log('route.unsupported', { reason: 'no_video_enhancement_route' });
      this.finishRoute(routeAbort);
      return;
    }
    if (!this.enabledFor(mode)) {
      this.diagnostics?.log('preference.disabled', {
        name: preferenceKeyForMode(mode),
        enabled: false,
      });
      this.active = {
        mode,
        href,
        video: findLargestVideo(this.documentObject),
        controller: undefined,
        controllerStarted: false,
        passiveObserver: undefined,
      };
      try {
        this.startPassiveObserver();
      } catch (error) {
        this.active.passiveObserver?.destroy();
        this.active.passiveObserver = undefined;
        this.logger.error('被动媒体诊断启动失败', error);
        this.diagnostics?.log('extension.boot_error', { action: `${mode}_passive` }, error);
      }
      this.finishRoute(routeAbort);
      return;
    }
    const panel = createStatusPanel(this.documentObject, mode);
    this.active = {
      mode,
      href,
      panel,
      video: findLargestVideo(this.documentObject),
      controller: undefined,
      controllerStarted: false,
      passiveObserver: undefined,
    };
    panel.setFreshnessCheck(() =>
      generation === this.routeGeneration &&
      !this.destroyed &&
      !routeAbort.signal.aborted &&
      this.active?.panel === panel &&
      this.routeKey === href &&
      this.windowObject.location.href === href &&
      modeForLocation(this.windowObject.location) === mode);
    panel.setModel({
      mode: mode === 'live' ? '直播' : '视频',
      ...(mode === 'live'
        ? {
          paused: '未提供',
          recentFrame: '未提供',
          buffered: '未提供',
          delay: '未提供',
          sessionId: this.diagnostics?.getStatus?.().sessionId,
          persistence: this.diagnostics?.getStatus?.().persistence,
        }
        : {
          state: 'WAITING',
          buffered: '未提供',
          target: '120 秒',
          error: '等待原生 video、媒体 source 和播放器内核',
        }),
    });
    this.diagnostics?.log('preference.changed', { name: preferenceKeyForMode(mode), enabled: true });
    const routeStillCurrent = () =>
      generation === this.routeGeneration && !this.destroyed && !routeAbort.signal.aborted &&
      href === this.windowObject.location.href && mode === modeForLocation(this.windowObject.location) &&
      this.active?.panel === panel;
    try {
      const pageAdapter = createPageWindowAdapter(this.bridgeClient, this.windowObject);
      if (mode === 'live') {
        const controller = new LiveObserver({
          windowObject: this.windowObject,
          documentObject: this.documentObject,
          runtimeObject: this.runtimeObject,
          initialVideo: this.active.video,
          panel,
          pageAdapter,
          diagnostics: this.diagnostics,
          logger: this.logger,
        });
        this.active.controller = controller;
        panel.setSnapshotRefresh(() => controller.refreshStatus());
        controller.start();
        this.active.controllerStarted = true;
      } else {
        const controller = new VodBufferController({
          video: this.active.video,
          getVideo: () => findLargestVideo(this.documentObject),
          panel,
          runtimeObject: this.runtimeObject,
          logger: this.logger,
          diagnostics: this.diagnostics,
          refreshCore: () => pageAdapter.refreshCore(),
        });
        this.active.controller = controller;
        panel.setSnapshotRefresh(() => controller.refreshStatus());
        controller.start();
        this.active.controllerStarted = true;
      }
      if (!routeStillCurrent()) {
        await this.teardownActive();
      }
    } catch (error) {
      if (!routeStillCurrent()) return;
      const active = this.active;
      if (active?.controllerStarted !== true) {
        active?.controller?.destroy();
        if (this.active !== active || active === undefined) return;
        active.controller = undefined;
        panel.setSnapshotRefresh(() => {});
        try {
          this.startPassiveObserver();
        } catch (passiveError) {
          if (this.active === active) {
            active.passiveObserver?.destroy();
            active.passiveObserver = undefined;
          }
          this.logger.error('被动媒体诊断启动失败', passiveError);
          this.diagnostics?.log('extension.boot_error', { action: `${mode}_passive` }, passiveError);
        }
      }
      setBootError(panel, error, mode);
      this.diagnostics?.log('extension.boot_error', { action: mode }, error);
    } finally {
      this.finishRoute(routeAbort);
    }
  }

  finishRoute(routeAbort) {
    if (this.routeAbort === routeAbort) {
      this.routeAbort = undefined;
      this.pendingRouteHref = '';
    }
  }

  startPassiveObserver() {
    if (
      this.active === undefined
      || this.diagnostics === undefined
      || this.active.passiveObserver !== undefined
    ) return;
    const observer = new PassiveMediaObserver({
      documentObject: this.documentObject,
      windowObject: this.windowObject,
      runtimeObject: this.runtimeObject,
      diagnostics: this.diagnostics,
      getVideo: () => findLargestVideo(this.documentObject),
      initialVideo: this.active.video,
    });
    this.active.passiveObserver = observer;
    observer.start();
  }

  async teardownActive() {
    if (this.active === undefined) return;
    const active = this.active;
    this.active = undefined;
    active.controller?.destroy();
    active.passiveObserver?.destroy();
    active.panel?.destroy();
  }

  async destroy() {
    if (this.destroyed) return;
    this.routeGeneration += 1;
    this.routeAbort?.abort();
    if (this.routeTimer !== undefined) this.runtimeObject.clearInterval(this.routeTimer);
    this.routeTimer = undefined;
    if (this.shimListener !== undefined) {
      this.documentObject.removeEventListener(SHIM_OBSERVATION_EVENT, this.shimListener);
      this.shimListener = undefined;
    }
    await this.teardownActive();
    this.diagnostics?.log('extension.destroyed', { action: 'coordinator' });
    this.destroyed = true;
    this.diagnostics?.destroy();
    this.bridgeClient.destroy();
  }
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined' && typeof window !== 'undefined') {
  const diagnostics = new DiagnosticsClient();
  installPopupMessageHandler(chrome.runtime, () => diagnostics.getStatus().sessionId);
  const coordinator = new ExtensionCoordinator({ diagnostics });
  void coordinator.start().catch((error) => {
    console.error('[BilibiliBuffer] 扩展启动失败', error);
    diagnostics.log('extension.boot_error', { action: 'coordinator' }, error);
  });
}
