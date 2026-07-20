import { EXTENSION_PREFERENCES } from '../constants.js';
import { DiagnosticsClient, createRouteIdentity } from '../diagnostics/client.js';
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

export function findLargestVideo(documentObject) {
  const videos = [...documentObject.querySelectorAll('video')].filter((video) => video.isConnected !== false);
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
  if (message.version !== STATUS_MESSAGE_VERSION || message.type !== 'status:get') {
    fail('POPUP_MESSAGE_INVALID', 'popup 消息版本或类型未允许');
  }
  if (Object.keys(message).some((field) => !['version', 'type'].includes(field))) {
    fail('POPUP_MESSAGE_INVALID', 'popup 消息包含未允许字段');
  }
  return message;
}

async function handlePopupMessage(message) {
  assertPopupMessage(message);
  const surface = getCurrentStatusSurface();
  if (surface === undefined) return createUnavailableStatusSnapshot(modeForLocation(window.location));
  return surface.getSnapshot();
}

export function installPopupMessageHandler(runtimeObject = chrome.runtime) {
  if (runtimeObject?.onMessage === undefined || typeof runtimeObject.onMessage.addListener !== 'function') {
    throw new Error('Chrome runtime message API 不可用');
  }
  runtimeObject.onMessage.addListener((message, _sender, sendResponse) => {
    void handlePopupMessage(message)
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
  }

  async start() {
    if (this.routeTimer !== undefined) throw new Error('扩展路由协调器已经启动');
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
      this.finishRoute(routeAbort);
      return;
    }
    const panel = createStatusPanel(this.documentObject, mode);
    this.active = { mode, href, panel, video: findLargestVideo(this.documentObject), controller: undefined };
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
        ? { paused: '未提供', recentFrame: '未提供', buffered: '未提供', delay: '未提供' }
        : { state: 'WAITING', buffered: '未提供', target: '120 秒', error: '等待原生 video、媒体 source 和播放器内核' }),
      sessionId: this.diagnostics?.getStatus?.().sessionId,
      persistence: this.diagnostics?.getStatus?.().persistence,
    });
    this.diagnostics?.log('preference.changed', { name: preferenceKeyForMode(mode), enabled: true });
    const routeStillCurrent = () =>
      generation === this.routeGeneration && !this.destroyed && !routeAbort.signal.aborted &&
      href === this.windowObject.location.href && mode === modeForLocation(this.windowObject.location);
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
      }
      if (!routeStillCurrent()) {
        await this.teardownActive();
      }
    } catch (error) {
      if (!routeStillCurrent()) return;
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

  async teardownActive() {
    if (this.active === undefined) return;
    const active = this.active;
    this.active = undefined;
    active.controller?.destroy();
    active.panel.destroy();
  }

  async destroy() {
    if (this.destroyed) return;
    this.routeGeneration += 1;
    this.routeAbort?.abort();
    if (this.routeTimer !== undefined) this.runtimeObject.clearInterval(this.routeTimer);
    this.routeTimer = undefined;
    await this.teardownActive();
    this.diagnostics?.log('extension.destroyed', { action: 'coordinator' });
    this.destroyed = true;
    this.diagnostics?.destroy();
    this.bridgeClient.destroy();
  }
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined' && typeof window !== 'undefined') {
  const diagnostics = new DiagnosticsClient();
  installPopupMessageHandler();
  const coordinator = new ExtensionCoordinator({ diagnostics });
  void coordinator.start().catch((error) => {
    console.error('[BilibiliBuffer] 扩展启动失败', error);
    diagnostics.log('extension.boot_error', { action: 'coordinator' }, error);
  });
}
