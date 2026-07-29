import { DIAGNOSTIC_MESSAGE_VERSION, isSafePersistErrorCode } from './catalog.js';
import { normalizeEventForStorage } from './privacy.js';
import { createSessionIdentity } from './session.js';
import { serializeError } from '../extension/bridge-contract.js';

const PERSIST_RETRY_BASE_DELAY_MS = 100;
const PERSIST_RETRY_MAX_DELAY_MS = 5000;
const PERSIST_RETRY_MAX_ATTEMPTS = 5;

function persistenceErrorCode(value) {
  const code = typeof value === 'string' ? value : value?.code;
  return isSafePersistErrorCode(code) ? code : 'LOG_PERSIST_FAILED';
}

function runtimeSendMessage(runtimeObject, message) {
  if (runtimeObject === undefined || typeof runtimeObject.sendMessage !== 'function') {
    throw new Error('日志 runtime.sendMessage 不可用');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      const result = runtimeObject.sendMessage(message, (response) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError !== undefined) {
          finish(reject, new Error(lastError.message));
          return;
        }
        finish(resolve, response);
      });
      if (result !== undefined && typeof result.then === 'function') {
        result.then((response) => finish(resolve, response), (error) => finish(reject, error));
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

function eventNow() {
  return new Date();
}

function routeIdentity(locationObject) {
  const pathname = locationObject.pathname || '/';
  const part = new URLSearchParams(locationObject.search || '').get('p') || undefined;
  if (locationObject.hostname === 'www.bilibili.com' && pathname.startsWith('/video/')) {
    return { routeKind: 'video', bvid: pathname.split('/')[2] || undefined, part };
  }
  if (locationObject.hostname === 'www.bilibili.com' && pathname.startsWith('/list/watchlater')) {
    return { routeKind: 'video', watchLaterItem: pathname.split('/')[3] || undefined, part };
  }
  return { routeKind: 'other', part };
}

function contextFields(context) {
  const result = {};
  for (const field of ['videoInstance', 'sourceInstance', 'coreInstance']) {
    if (context?.[field] !== undefined) result[field] = context[field];
  }
  return result;
}

export class DiagnosticsClient {
  constructor({
    documentObject = document,
    windowObject = window,
    runtimeObject = chrome.runtime,
    locationObject = windowObject.location,
    loggerObject = console,
    now = eventNow,
  } = {}) {
    this.documentObject = documentObject;
    this.windowObject = windowObject;
    this.runtimeObject = runtimeObject;
    this.locationObject = locationObject;
    this.logger = loggerObject;
    this.now = now;
    this.session = undefined;
    this.startedAtMilliseconds = 0;
    this.sequence = 0;
    this.pending = [];
    this.outbox = [];
    this.flushScheduled = false;
    this.flushPromise = undefined;
    this.retryTimer = undefined;
    this.retryItem = undefined;
    this.destroyed = false;
    this.tearingDown = false;
    this.persistence = '未提供';
    this.pendingPersistResult = undefined;
    this.noVideoTimer = undefined;
    this.startSession(routeIdentity(locationObject));
    this.documentObject?.defaultView?.addEventListener?.('pagehide', () => {
      this.beginTeardown();
      void this.flushForTeardown().catch((error) => {
        this.logger.error?.('[BilibiliBuffer] diagnostic teardown flush failed', serializeError(error));
      }).finally(() => this.destroy());
    }, { once: true });
  }

  startSession(route) {
    if (this.destroyed) throw new Error('诊断客户端已经销毁');
    this.enqueuePendingBatch();
    void this.flush();
    this.session = createSessionIdentity({
      locationObject: this.locationObject,
      routeKind: route.routeKind,
      runtimeObject: this.windowObject,
      bvid: route.bvid,
      part: route.part,
      watchLaterItem: route.watchLaterItem,
      now: this.now(),
    });
    this.startedAtMilliseconds = Date.parse(this.session.startedAt);
    this.sequence = 0;
    this.persistence = '未提供';
    this.log('route.session_started', {
      routeKind: this.session.routeKind,
      origin: this.session.origin,
      pathname: this.session.pathname,
      bvid: this.session.bvid,
      part: this.session.part,
      watchLaterItem: this.session.watchLaterItem,
    });
    void this.flush();
    this.scheduleNoVideoNotice();
    return this.session;
  }

  scheduleNoVideoNotice() {
    if (this.noVideoTimer !== undefined) {
      this.windowObject.clearTimeout(this.noVideoTimer);
    }
    this.noVideoTimer = this.windowObject.setTimeout(() => {
      this.noVideoTimer = undefined;
      this.log('route.no_video', { reason: '30秒内没有 video' });
    }, 30000);
  }

  markVideoAvailable() {
    if (this.noVideoTimer !== undefined) {
      this.windowObject.clearTimeout(this.noVideoTimer);
      this.noVideoTimer = undefined;
    }
  }

  log(code, data = {}, error, context = {}) {
    if (this.destroyed || this.tearingDown) return;
    try {
      if (this.pendingPersistResult !== undefined && !code.startsWith('log.persist.')) {
        const result = this.pendingPersistResult;
        this.pendingPersistResult = undefined;
        if (result.status === 'DEGRADED') {
          this.append('log.persist.degraded', result, undefined, {});
        }
      }
      this.append(code, data, error, context);
      if (!code.startsWith('log.persist.')) this.scheduleFlush();
    } catch (logError) {
      try {
        this.logger.error?.('[BilibiliBuffer] diagnostic event rejected', serializeError(logError));
      } catch (mirrorError) {
        console.error('[BilibiliBuffer] diagnostic event rejection mirror failed', mirrorError);
      }
    }
  }

  append(code, data, error, context) {
    const now = this.now();
    const event = {
      sessionId: this.session.sessionId,
      sequence: this.sequence + 1,
      wallTime: now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - this.startedAtMilliseconds),
      code,
      ...contextFields(context),
    };
    event.data = data;
    if (error !== undefined) event.error = serializeError(error);
    const normalized = normalizeEventForStorage(event);
    this.sequence = normalized.sequence;
    this.pending.push(normalized);
    try {
      this.logger.log('[BilibiliBuffer][diagnostic]', normalized);
    } catch (consoleError) {
      this.logger.warn?.('[BilibiliBuffer] diagnostic console mirror failed', serializeError(consoleError));
    }
  }

  scheduleFlush() {
    if (this.flushScheduled || this.destroyed || this.tearingDown) return;
    this.flushScheduled = true;
    this.windowObject.setTimeout(() => {
      this.flushScheduled = false;
      void this.flush();
    }, 0);
  }

  async flush() {
    this.enqueuePendingBatch();
    return this.flushOutbox();
  }

  async flushForTeardown() {
    this.enqueuePendingBatch();
    for (;;) {
      const result = await (this.flushPromise || this.flushOutbox());
      if (result === undefined || result.status === 'DEGRADED' || this.outbox.length === 0) return;
    }
  }

  enqueuePendingBatch() {
    if (this.pending.length === 0 || this.session === undefined) return;
    this.outbox.push({
      session: this.session,
      batch: this.pending.splice(0, this.pending.length),
      failed: false,
      retryCount: 0,
      retryScheduled: false,
    });
  }

  flushOutbox() {
    if (this.flushPromise !== undefined) return this.flushPromise;
    if (this.outbox.length === 0) return undefined;
    const item = this.outbox.shift();
    this.cancelScheduledRetry(item);
    item.failed = false;
    const { batch, session } = item;
    this.flushPromise = runtimeSendMessage(this.runtimeObject, {
      version: DIAGNOSTIC_MESSAGE_VERSION,
      type: 'diagnostic:events',
      session,
      events: batch,
    }).then((response) => {
      if (response?.ok !== true || !['PERSISTED', 'DUPLICATE'].includes(response.status)) {
        throw Object.assign(new Error(response?.error?.message || '日志事务没有提交'), {
          code: persistenceErrorCode(response?.error),
        });
      }
      this.persistence = response.status;
      this.pendingPersistResult = {
        status: response.status,
        batchSize: batch.length,
        eventCount: response.eventCount,
      };
      return response;
    }).catch((error) => {
      this.persistence = 'DEGRADED';
      item.failed = true;
      item.retryCount += 1;
      this.outbox.unshift(item);
      this.pendingPersistResult = {
        status: 'DEGRADED',
        batchSize: batch.length,
        message: error.message || String(error),
        code: persistenceErrorCode(error),
      };
      try {
        this.logger.error?.('[BilibiliBuffer] diagnostic persistence degraded', serializeError(error));
      } catch (consoleError) {
        this.logger.warn?.('[BilibiliBuffer] diagnostic degraded mirror failed', serializeError(consoleError));
      }
      this.scheduleHeadRetry(item);
      return { status: 'DEGRADED', error: serializeError(error) };
    }).finally(() => {
      this.flushPromise = undefined;
      if (!this.destroyed && !this.tearingDown && this.outbox.length > 0 && this.outbox[0].failed !== true) {
        void this.flushOutbox();
      }
    });
    return this.flushPromise;
  }

  cancelScheduledRetry(item) {
    if (this.retryItem !== item) return;
    this.windowObject.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryItem = undefined;
    item.retryScheduled = false;
  }

  scheduleHeadRetry(item) {
    if (this.destroyed || this.tearingDown || this.outbox[0] !== item
      || item.retryCount > PERSIST_RETRY_MAX_ATTEMPTS || item.retryScheduled === true) return;
    const delay = Math.min(
      PERSIST_RETRY_BASE_DELAY_MS * (2 ** (item.retryCount - 1)),
      PERSIST_RETRY_MAX_DELAY_MS,
    );
    item.retryScheduled = true;
    this.retryItem = item;
    this.retryTimer = this.windowObject.setTimeout(() => {
      this.retryTimer = undefined;
      this.retryItem = undefined;
      item.retryScheduled = false;
      if (!this.destroyed && !this.tearingDown && this.outbox[0] === item) void this.flushOutbox();
    }, delay);
  }

  getStatus() {
    return {
      sessionId: this.session?.sessionId || '未提供',
      persistence: this.persistence,
    };
  }

  beginTeardown() {
    if (this.tearingDown) return;
    this.tearingDown = true;
    if (this.retryItem !== undefined) this.cancelScheduledRetry(this.retryItem);
    if (this.noVideoTimer !== undefined) this.windowObject.clearTimeout(this.noVideoTimer);
  }

  destroy() {
    if (this.destroyed) return;
    this.beginTeardown();
    this.destroyed = true;
  }
}

export function createRouteIdentity(locationObject) {
  return routeIdentity(locationObject);
}
