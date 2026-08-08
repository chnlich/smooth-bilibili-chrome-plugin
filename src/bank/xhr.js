import { BankFallbackError, BankNetworkError } from './errors.js';
import { scrubUrl } from '../diagnostics/privacy.js';
import { classifyRequest } from './logic.js';

const EVENT_NAMES = Object.freeze([
  'readystatechange',
  'progress',
  'loadstart',
  'load',
  'error',
  'abort',
  'timeout',
  'loadend',
]);

function eventFor(windowObject, type, init = {}) {
  const EventConstructor = windowObject.Event || globalThis.Event;
  const event = new EventConstructor(type);
  for (const [field, value] of Object.entries(init)) {
    Object.defineProperty(event, field, { configurable: true, value });
  }
  return event;
}

function decodeText(bytes) {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function responseValue(windowObject, responseType, bytes) {
  if (responseType === '' || responseType === 'text') return decodeText(bytes);
  if (responseType === 'arraybuffer') return bytes;
  if (responseType === 'blob') {
    const BlobConstructor = windowObject.Blob || globalThis.Blob;
    return new BlobConstructor([bytes]);
  }
  if (responseType === 'json') return JSON.parse(decodeText(bytes));
  return bytes;
}

function responseHeadersText(headers) {
  const rows = [];
  for (const [name, value] of headers.entries()) rows.push(`${name}: ${value}`);
  return rows.length === 0 ? '' : `${rows.join('\r\n')}\r\n`;
}

function bankEnabled(bank) {
  return typeof bank.isEnabled === 'function' ? bank.isEnabled() : bank.enabled === true;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function mirrorForUrl(url) {
  return new URL(url).hostname;
}

export function createBankXMLHttpRequestClass({ windowObject, nativeConstructor, bank }) {
  return class SegmentBankXMLHttpRequest {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;

    constructor() {
      this._native = new nativeConstructor();
      this._listeners = new Map();
      this._openArgs = undefined;
      this._headers = {};
      this._range = undefined;
      this._body = undefined;
      this._intercepted = false;
      this._state = 0;
      this._responseType = '';
      this._status = 0;
      this._statusText = '';
      this._responseURL = '';
      this._responseHeaders = undefined;
      this._response = null;
      this._abortController = undefined;
      this._timer = undefined;
      this._done = false;
      this._aborted = false;
      this._timedOut = false;
      this._suppressNativeLoadstart = false;
      this._generation = 0;
      this._playurlObservationGeneration = undefined;
      this._playurlObservationUrl = undefined;
      for (const eventName of EVENT_NAMES) {
        this._native.addEventListener(eventName, (event) => {
          if (!this._intercepted) {
            if (event.type === 'load'
              && this._playurlObservationGeneration === this._generation
              && this._playurlObservationUrl !== undefined) {
              try {
                bank.observePlayurlText(this._native.responseText);
              } catch (error) {
                console.error('[BilibiliBuffer] playurl 地址簿读取失败', error);
              }
            }
            if (event.type === 'loadstart' && this._suppressNativeLoadstart) {
              this._suppressNativeLoadstart = false;
              return;
            }
            this.dispatchEvent(event);
          }
        });
      }
    }

    get readyState() { return this._intercepted ? this._state : this._native.readyState; }

    get response() { return this._intercepted ? this._response : this._native.response; }

    get responseText() {
      if (this._intercepted) {
        if (this.responseType !== '' && this.responseType !== 'text') {
          throw new DOMException('responseText is unavailable for this responseType', 'InvalidStateError');
        }
        return this._response || '';
      }
      return this._native.responseText;
    }

    get responseType() { return this._intercepted ? this._responseType : this._native.responseType; }

    set responseType(value) {
      this._responseType = value;
      this._native.responseType = value;
    }

    get responseURL() { return this._intercepted ? this._responseURL : this._native.responseURL; }

    get status() { return this._intercepted ? this._status : this._native.status; }

    get statusText() { return this._intercepted ? this._statusText : this._native.statusText; }

    get timeout() { return this._native.timeout; }

    set timeout(value) { this._native.timeout = value; }

    get withCredentials() { return this._native.withCredentials; }

    set withCredentials(value) { this._native.withCredentials = value; }

    open(...args) {
      this._abortController?.abort();
      this.clearTimer();
      this._generation += 1;
      this._playurlObservationGeneration = undefined;
      this._playurlObservationUrl = undefined;
      this._openArgs = args;
      this._headers = {};
      this._range = undefined;
      this._body = undefined;
      this._intercepted = false;
      this._done = false;
      this._aborted = false;
      this._timedOut = false;
      this._suppressNativeLoadstart = false;
      this._status = 0;
      this._statusText = '';
      this._responseURL = '';
      this._responseHeaders = undefined;
      this._response = null;
      const result = this._native.open(...args);
      this._responseType = this._native.responseType;
      return result;
    }

    setRequestHeader(name, value) {
      const existing = this._headers[name];
      this._headers[name] = existing === undefined ? String(value) : `${existing}, ${value}`;
      return this._native.setRequestHeader(name, value);
    }

    getResponseHeader(name) {
      if (!this._intercepted) return this._native.getResponseHeader(name);
      return this._responseHeaders?.get(name) || null;
    }

    getAllResponseHeaders() {
      if (!this._intercepted) return this._native.getAllResponseHeaders();
      if (this._responseHeaders === undefined) return '';
      return responseHeadersText(this._responseHeaders);
    }

    overrideMimeType(...args) { return this._native.overrideMimeType(...args); }

    addEventListener(type, listener, options) {
      const listeners = this._listeners.get(type) || new Set();
      listeners.add(listener);
      this._listeners.set(type, listeners);
      return undefined;
    }

    removeEventListener(type, listener, options) {
      this._listeners.get(type)?.delete(listener);
      return undefined;
    }

    dispatchEvent(event) {
      const type = event.type;
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      for (const listener of this._listeners.get(type) || []) listener.call(this, event);
      return true;
    }

    send(body) {
      this._body = body;
      if (typeof bank.syncRouteLifecycle === 'function' && !bank.syncRouteLifecycle()) {
        return this._native.send(body);
      }
      const url = new URL(this._openArgs?.[1], windowObject.location.href).href;
      const asyncFlag = this._openArgs?.[2] !== false;
      const generation = this._generation;
      this._playurlObservationGeneration = generation;
      this._playurlObservationUrl = typeof bank.isPlayurlUrl === 'function' && bank.isPlayurlUrl(url)
        ? url
        : undefined;
      const enabled = bankEnabled(bank);
      const classification = classifyRequest({
        url,
        headers: this._headers,
        enabled,
        locationObject: windowObject.location,
      });
      this._range = classification.range;
      if (!asyncFlag) {
        if (enabled) {
          bank.emitDiagnostic('bank.serve', {
            source: scrubUrl(url),
            mirror: mirrorForUrl(url),
            result: 'pass',
            reason: 'sync_xhr',
          });
        }
        return this._native.send(body);
      }
      if (!classification.intercepted) {
        if (enabled) {
          bank.emitDiagnostic('bank.serve', {
            source: scrubUrl(url),
            mirror: mirrorForUrl(url),
            result: 'pass',
            reason: classification.reason,
          });
        }
        return this._native.send(body);
      }
      this._intercepted = true;
      this._state = 1;
      this._abortController = new AbortController();
      this._status = 0;
      this._statusText = '';
      this._responseURL = '';
      this._responseHeaders = undefined;
      this._response = null;
      this.dispatchEvent(eventFor(windowObject, 'loadstart'));
      if (this.timeout > 0) {
        this._timer = windowObject.setTimeout(() => {
          if (this._done || generation !== this._generation) return;
          this._timedOut = true;
          this._abortController.abort();
          this._done = true;
          this._state = 4;
          this.dispatchEvent(eventFor(windowObject, 'readystatechange'));
          this.dispatchEvent(eventFor(windowObject, 'timeout'));
          this.dispatchEvent(eventFor(windowObject, 'loadend'));
        }, this.timeout);
      }
      void Promise.resolve()
        .then(() => bank.serveRequest({
          url,
          headers: this._headers,
          credentials: this.withCredentials ? 'include' : 'same-origin',
          signal: this._abortController.signal,
        }))
        .then((served) => {
          if (this._done || generation !== this._generation) {
            served.release?.();
            return;
          }
          if (!served.intercepted) throw new Error('媒体分片请求未被下载层拦截');
          void this.serve(served, url, body, generation);
        })
        .catch((error) => this.handleServeError(error, url, body, generation));
    }

    handleServeError(error, url, body, generation) {
      if (this._done || generation !== this._generation) return;
      if (error instanceof BankFallbackError) {
        bank.emitDiagnostic('bank.serve', {
          source: scrubUrl(url),
          mirror: mirrorForUrl(url),
          ...this._range,
          result: 'pass',
          reason: 'internal_fallback',
        });
        this.clearTimer();
        this._suppressNativeLoadstart = true;
        this._intercepted = false;
        this._native.send(body);
        return;
      }
      if (error instanceof BankNetworkError) {
        if (!this._aborted && !this._timedOut) {
          console.error('[BilibiliBuffer] 媒体分片前台取数失败', error);
          this.finishError(error, generation);
        }
        return;
      }
      if (isAbortError(error)) {
        if (!this._aborted && !this._timedOut) this.finishError(error, generation);
        return;
      }
      console.error('[BilibiliBuffer] 媒体分片供数失败', error);
      bank.emitDiagnostic('bank.serve', {
        source: scrubUrl(url),
        mirror: mirrorForUrl(url),
        ...this._range,
        result: 'pass',
        reason: 'internal_error',
      });
      this.clearTimer();
      this._suppressNativeLoadstart = true;
      this._intercepted = false;
      this._native.send(body);
    }

    async serve(result, url, body, generation) {
      try {
        await Promise.resolve();
        if (this._done || generation !== this._generation) {
          result.release?.();
          return;
        }
        await this.finishResponse(result.response, result.bytes, url, generation);
        result.release?.();
      } catch (error) {
        result.release?.();
        if (this._done || generation !== this._generation) return;
        this.handleServeError(error, url, body, generation);
      }
    }

    async finishResponse(response, knownBytes, requestUrl, generation) {
      const bytes = knownBytes;
      if (this._done || generation !== this._generation) return;
      this._status = response.status;
      this._statusText = response.statusText;
      this._responseURL = response.url || requestUrl;
      this._responseHeaders = response.headers;
      this._response = responseValue(windowObject, this._responseType, bytes);
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength === null ? 0 : Number(contentLength);
      const lengthComputable = Number.isFinite(total) && total >= 0;
      this._state = 2;
      this.dispatchEvent(eventFor(windowObject, 'readystatechange'));
      this._state = 3;
      this.dispatchEvent(eventFor(windowObject, 'readystatechange'));
      this.dispatchEvent(eventFor(windowObject, 'progress', {
        loaded: bytes.byteLength,
        total: lengthComputable ? total : 0,
        lengthComputable,
      }));
      this._state = 4;
      this._done = true;
      this.dispatchEvent(eventFor(windowObject, 'readystatechange'));
      this.dispatchEvent(eventFor(windowObject, 'load'));
      this.dispatchEvent(eventFor(windowObject, 'loadend'));
      this.clearTimer();
    }

    finishError(error, generation) {
      if (this._done || generation !== this._generation) return;
      this._state = 4;
      this._done = true;
      this.dispatchEvent(eventFor(windowObject, 'readystatechange'));
      this.dispatchEvent(eventFor(windowObject, 'error', { error }));
      this.dispatchEvent(eventFor(windowObject, 'loadend'));
      this.clearTimer();
    }

    abort() {
      if (!this._intercepted) {
        this._native.abort();
        return;
      }
      if (this._done) return;
      this._aborted = true;
      this._abortController.abort();
      this._done = true;
      this._state = 0;
      this.dispatchEvent(eventFor(windowObject, 'abort'));
      this.dispatchEvent(eventFor(windowObject, 'loadend'));
      this.clearTimer();
    }

    clearTimer() {
      if (this._timer !== undefined) {
        windowObject.clearTimeout(this._timer);
        this._timer = undefined;
      }
    }
  };
}
