import { EXTENSION_PREFERENCES, VERSION } from '../constants.js';
import { toBufferScriptError } from '../errors.js';
import { LiveController, roomIdFromLocation, waitForVideo } from '../live/controller.js';
import { getPinnedHls } from '../live/hls.js';
import { VodController } from '../vod/controller.js';
import { createStatusPanel } from '../ui/panel.js';
import { BridgeClient, createPageWindowAdapter } from './bridge-client.js';

function isLivePage(locationObject) {
  return locationObject.hostname === 'live.bilibili.com';
}

function isVodPage(locationObject) {
  return locationObject.hostname === 'www.bilibili.com' && locationObject.pathname.startsWith('/video/');
}

function modeForLocation(locationObject) {
  if (isLivePage(locationObject)) {
    return 'live';
  }
  if (isVodPage(locationObject)) {
    return 'vod';
  }
  return undefined;
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
  logger().error(normalized);
  panel.setModel({
    mode: mode === 'live' ? '直播' : '点播',
    state: 'ERROR',
    inventory: '未提供',
    delay: '未提供',
    quality: '未提供',
    speed: '未提供',
    multiplier: '未提供',
    message: `${normalized.code}: ${normalized.message}`,
  });
}

function readPreferences(storage) {
  return storage.get([EXTENSION_PREFERENCES.liveEnabled, EXTENSION_PREFERENCES.vodEnabled]);
}

export class ExtensionCoordinator {
  constructor({
    documentObject = document,
    windowObject = window,
    storage = chrome.storage.local,
    runtimeObject = globalThis,
    bridgeClient = new BridgeClient(documentObject, runtimeObject),
    loggerObject = logger(),
  } = {}) {
    this.documentObject = documentObject;
    this.windowObject = windowObject;
    this.storage = storage;
    this.runtimeObject = runtimeObject;
    this.bridgeClient = bridgeClient;
    this.logger = loggerObject;
    this.preferences = undefined;
    this.active = undefined;
    this.routeKey = '';
    this.routeGeneration = 0;
    this.syncPromise = undefined;
    this.pendingRouteHref = '';
    this.routeAbort;
    this.routeTimer = undefined;
    this.destroyed = false;
  }

  async start() {
    if (this.routeTimer !== undefined) {
      throw new Error('扩展路由协调器已经启动');
    }
    this.preferences = await readPreferences(this.storage);
    this.documentObject.documentElement.dataset.bilibiliBufferExtensionRuntimeId = chrome.runtime.id;
    this.routeTimer = this.runtimeObject.setInterval(() => {
      void this.syncRoute().catch((error) => this.logger.error('扩展路由同步失败', error));
    }, 250);
    await this.syncRoute();
  }

  enabledFor(mode) {
    const value = this.preferences[preferenceKeyForMode(mode)];
    return value !== false;
  }

  syncRoute() {
    if (this.syncPromise !== undefined) {
      if (this.pendingRouteHref !== this.windowObject.location.href) {
        this.routeAbort?.abort();
      }
      return this.syncPromise;
    }
    this.syncPromise = this.performSyncRoute().finally(() => {
      this.syncPromise = undefined;
    });
    return this.syncPromise;
  }

  async performSyncRoute() {
    if (this.destroyed) {
      return;
    }
    const href = this.windowObject.location.href;
    const mode = modeForLocation(this.windowObject.location);
    const videoMissing = this.active?.video !== undefined && !this.active.video.isConnected;
    if (href === this.routeKey && !videoMissing) {
      return;
    }
    const generation = this.routeGeneration + 1;
    this.routeGeneration = generation;
    this.routeAbort?.abort();
    const routeAbort = new AbortController();
    this.routeAbort = routeAbort;
    this.pendingRouteHref = href;
    await this.teardownActive();
    if (generation !== this.routeGeneration || this.destroyed || routeAbort.signal.aborted) {
      return;
    }
    this.routeKey = href;
    if (mode === undefined || !this.enabledFor(mode)) {
      return;
    }
    const panel = createStatusPanel(this.documentObject, mode === 'live' ? '直播' : '点播');
    this.active = { mode, href, panel, video: undefined, controller: undefined };
    panel.setModel({
      mode: mode === 'live' ? '直播' : '点播',
      state: 'STARTING',
      message: `版本 ${VERSION} 正在启动`,
    });
    const routeStillCurrent = () =>
      generation === this.routeGeneration &&
      !this.destroyed &&
      !routeAbort.signal.aborted &&
      href === this.windowObject.location.href &&
      mode === modeForLocation(this.windowObject.location);
    const destroyActiveControllerForRouteAbort = () => {
      if (this.active?.href === href) {
        this.active.controller?.destroy();
      }
    };
    routeAbort.signal.addEventListener('abort', destroyActiveControllerForRouteAbort, { once: true });
    try {
      const video = await waitForVideo(this.documentObject, 30000, routeAbort.signal);
      if (!routeStillCurrent()) {
        if (generation === this.routeGeneration && this.active?.href === href) {
          await this.teardownActive();
        }
        return;
      }
      this.active.video = video;
      const pageAdapter = createPageWindowAdapter(this.bridgeClient, this.windowObject);
      if (mode === 'live') {
        const controller = new LiveController({
          windowObject: pageAdapter.pageWindow,
          documentObject: this.documentObject,
          video,
          panel,
          hls: getPinnedHls(),
          roomId: roomIdFromLocation(this.windowObject.location),
          fetchImpl: this.runtimeObject.fetch.bind(this.runtimeObject),
          runtimeObject: this.runtimeObject,
          mediaSourceFactory: pageAdapter.pageWindow.MediaSource,
          urlApi: pageAdapter.pageWindow.URL,
          logger: this.logger,
        });
        this.active.controller = controller;
        await controller.start();
        if (!routeStillCurrent()) {
          controller.destroy();
          if (generation === this.routeGeneration && this.active?.href === href) {
            await this.teardownActive();
          }
          return;
        }
      } else {
        const controller = new VodController({
          windowObject: pageAdapter.pageWindow,
          documentObject: this.documentObject,
          video,
          panel,
          runtimeObject: this.runtimeObject,
          logger: this.logger,
          fetchImpl: this.runtimeObject.fetch.bind(this.runtimeObject),
          beforeReconcile: () => pageAdapter.refreshCore(),
        });
        this.active.controller = controller;
        controller.start();
        if (!routeStillCurrent()) {
          controller.destroy();
          if (generation === this.routeGeneration && this.active?.href === href) {
            await this.teardownActive();
          }
        }
      }
    } catch (error) {
      if (!routeStillCurrent()) {
        if (generation === this.routeGeneration && this.active?.href === href) {
          await this.teardownActive();
        }
        return;
      }
      if (generation === this.routeGeneration && !this.destroyed) {
        setBootError(panel, error, mode);
      }
    } finally {
      routeAbort.signal.removeEventListener('abort', destroyActiveControllerForRouteAbort);
      if (this.routeAbort === routeAbort) {
        this.routeAbort = undefined;
        this.pendingRouteHref = '';
      }
    }
  }

  async teardownActive() {
    if (this.active === undefined) {
      return;
    }
    const active = this.active;
    this.active = undefined;
    active.controller?.destroy();
    active.panel.destroy();
  }

  async destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.routeGeneration += 1;
    this.routeAbort?.abort();
    if (this.routeTimer !== undefined) {
      this.runtimeObject.clearInterval(this.routeTimer);
      this.routeTimer = undefined;
    }
    await this.teardownActive();
    this.bridgeClient.destroy();
  }
}

const coordinator = new ExtensionCoordinator();
void coordinator.start().catch((error) => console.error('[BilibiliBuffer] 扩展启动失败', error));
