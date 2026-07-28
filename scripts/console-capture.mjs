const BILIBILI_BUFFER_PREFIX = '[BilibiliBuffer]';
const CAPTURED_TARGET_TYPES = new Set(['page', 'service_worker', 'shared_worker', 'worker', 'background_page']);

function extensionFramePrefix(extensionId) {
  return `chrome-extension://${extensionId}`;
}

function appendStackFrames(stackTrace, frames) {
  if (stackTrace === undefined || stackTrace === null) return;
  for (const frame of stackTrace.callFrames || []) frames.push(frame);
  appendStackFrames(stackTrace.parentStackTrace, frames);
  appendStackFrames(stackTrace.asyncStackTrace, frames);
}

export function stackFrames(stackTrace) {
  const frames = [];
  appendStackFrames(stackTrace, frames);
  return frames;
}

export function hasExtensionStackFrame(stackTrace, extensionId) {
  const prefix = extensionFramePrefix(extensionId);
  return stackFrames(stackTrace).some((frame) => typeof frame.url === 'string' && frame.url.startsWith(prefix));
}

export function classifyStackSource(stackTrace, extensionId) {
  const frames = stackFrames(stackTrace);
  if (frames.some((frame) => typeof frame.url === 'string' && frame.url.startsWith(extensionFramePrefix(extensionId)))) {
    return 'extension';
  }
  if (frames.some((frame) => typeof frame.url === 'string' && frame.url.length > 0)) return 'page';
  return 'unknown';
}

function scrubUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!URL.canParse(value)) return value;
  const parsed = new URL(value);
  const origin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  return `${origin}${parsed.pathname}`;
}

function scrubText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => scrubUrl(url));
}

function remoteObjectText(remoteObject) {
  if (remoteObject === null || remoteObject === undefined) return '';
  if (remoteObject.value !== undefined) return String(remoteObject.value);
  if (typeof remoteObject.unserializableValue === 'string') return remoteObject.unserializableValue;
  if (typeof remoteObject.description === 'string') return remoteObject.description;
  return typeof remoteObject.type === 'string' ? remoteObject.type : '';
}

function consoleText(event) {
  return scrubText((event.args || []).map(remoteObjectText).join(' '));
}

function exceptionText(exceptionDetails) {
  const exception = exceptionDetails.exception;
  if (typeof exception?.description === 'string') return scrubText(exception.description);
  if (typeof exceptionDetails.text === 'string') return scrubText(exceptionDetails.text);
  return '';
}

function serializableStack(stackTrace) {
  return stackFrames(stackTrace).map((frame) => ({
    functionName: typeof frame.functionName === 'string' ? frame.functionName : '',
    url: scrubUrl(frame.url),
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
  }));
}

function targetRecord(targetId, targetInfo) {
  return {
    targetId,
    targetType: targetInfo?.type || 'unknown',
    targetUrl: scrubUrl(targetInfo?.url),
  };
}

class ChromeCdpTransport {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.messageHandler = undefined;
    this.closeHandler = undefined;
    this.closed = false;
    this.closing = false;
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => this.fail(new Error('Chrome CDP WebSocket failed')));
    socket.addEventListener('close', () => this.fail(new Error('Chrome CDP WebSocket closed')));
  }

  get isOpen() {
    return this.socket.readyState === 1;
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  async send(method, params = {}, sessionId = undefined) {
    if (this.closed || !this.isOpen) throw new Error('Chrome CDP WebSocket is not open');
    const id = this.nextId + 1;
    this.nextId = id;
    const message = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  receive(data) {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (payload === null || typeof payload !== 'object') {
      this.fail(new Error('Chrome CDP message is not an object'));
      return;
    }
    if (payload.id !== undefined) {
      const pending = this.pending.get(payload.id);
      if (pending === undefined) {
        this.fail(new Error(`Chrome CDP response id ${payload.id} is not pending`));
        return;
      }
      this.pending.delete(payload.id);
      if (payload.error !== undefined) {
        pending.reject(Object.assign(new Error(payload.error.message), { code: payload.error.code }));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }
    this.messageHandler?.(payload);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.closing) this.closeHandler?.(error);
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await new Promise((resolve) => {
      this.socket.addEventListener('close', resolve, { once: true });
      this.socket.close();
    });
    this.closed = true;
  }
}

async function connectToChrome(remoteDebuggingPort) {
  if (!Number.isInteger(remoteDebuggingPort) || remoteDebuggingPort <= 0) {
    throw new Error('remote debugging port is invalid');
  }
  if (typeof WebSocket !== 'function') throw new Error('Node WebSocket API is unavailable');
  const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/version`);
  if (!response.ok) throw new Error(`Chrome CDP version endpoint returned HTTP ${response.status}`);
  const version = await response.json();
  if (typeof version.webSocketDebuggerUrl !== 'string' || version.webSocketDebuggerUrl.length === 0) {
    throw new Error('Chrome CDP version endpoint did not provide a WebSocket debugger URL');
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Chrome CDP WebSocket could not be opened')),
      { once: true },
    );
    socket.addEventListener(
      'close',
      () => reject(new Error('Chrome CDP WebSocket closed before opening')),
      { once: true },
    );
  });
  return new ChromeCdpTransport(socket);
}

export function classifyConsoleEvent(event, extensionId) {
  const text = consoleText(event);
  return {
    kind: 'console',
    level: event.type,
    source: classifyStackSource(event.stackTrace, extensionId),
    extensionFrame: hasExtensionStackFrame(event.stackTrace, extensionId),
    bilibiliBufferPrefix: text.startsWith(BILIBILI_BUFFER_PREFIX),
    text,
    stack: serializableStack(event.stackTrace),
  };
}

export function classifyExceptionEvent(exceptionDetails, extensionId) {
  return {
    kind: 'exception',
    uncaught: exceptionDetails.uncaught === true,
    source: classifyStackSource(exceptionDetails.stackTrace, extensionId),
    extensionFrame: hasExtensionStackFrame(exceptionDetails.stackTrace, extensionId),
    text: exceptionText(exceptionDetails),
    stack: serializableStack(exceptionDetails.stackTrace),
  };
}

function positiveControlRecord(record, marker) {
  return marker.length > 0 && record.text.includes(marker);
}

export class BrowserConsoleCapture {
  constructor(transport, extensionId) {
    this.transport = transport;
    this.extensionId = extensionId;
    this.events = [];
    this.targetSessions = new Map();
    this.targetSessionsByTargetId = new Map();
    this.captureErrors = [];
    this.positiveControlMarker = undefined;
    this.started = false;
  }

  async start() {
    this.transport.onMessage((message) => {
      this.receiveMessage(message);
    });
    this.transport.onClose((error) => this.recordCaptureError(error));
    this.started = true;
    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: true });
      await this.transport.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      await this.attachExistingTargets();
    } catch (error) {
      this.started = false;
      throw error;
    }
    return this;
  }

  async attachTarget({ sessionId, targetInfo }) {
    if (!CAPTURED_TARGET_TYPES.has(targetInfo?.type)) return;
    if (this.targetSessions.has(sessionId)) return;
    const target = targetRecord(targetInfo.targetId, targetInfo);
    this.targetSessions.set(sessionId, target);
    this.targetSessionsByTargetId.set(target.targetId, sessionId);
    await this.sendTargetCommand(sessionId, 'Runtime.enable');
    await this.sendTargetCommand(sessionId, 'Runtime.setAsyncCallStackDepth', { maxDepth: 32 });
  }

  async attachExistingTargets() {
    const { targetInfos } = await this.transport.send('Target.getTargets');
    for (const targetInfo of targetInfos) {
      if (!CAPTURED_TARGET_TYPES.has(targetInfo.type)) continue;
      if (this.targetSessionsByTargetId.has(targetInfo.targetId)) continue;
      const { sessionId } = await this.transport.send('Target.attachToTarget', {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      if (this.targetSessions.has(sessionId)) continue;
      await this.attachTarget({ sessionId, targetInfo });
    }
  }

  async sendTargetCommand(sessionId, method, params = {}) {
    if (!this.started) throw new Error('browser CDP console capture is not started');
    return this.transport.send(method, params, sessionId);
  }

  receiveMessage(message) {
    if (message.method === 'Target.attachedToTarget') {
      void this.attachTarget(message.params).catch((error) => this.recordCaptureError(error));
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const target = this.targetSessions.get(message.params.sessionId);
      this.targetSessions.delete(message.params.sessionId);
      if (target !== undefined) this.targetSessionsByTargetId.delete(target.targetId);
      return;
    }
    if (message.method === 'Target.targetInfoChanged') {
      const sessionId = this.targetSessionsByTargetId.get(message.params.targetInfo.targetId);
      const target = this.targetSessions.get(sessionId);
      if (target !== undefined) target.targetUrl = scrubUrl(message.params.targetInfo.url);
      return;
    }
    const target = this.targetSessions.get(message.sessionId);
    if (target === undefined) return;
    if (message.method === 'Runtime.consoleAPICalled') {
      this.recordEvent({ ...target, ...classifyConsoleEvent(message.params, this.extensionId) });
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      this.recordEvent({ ...target, ...classifyExceptionEvent(message.params.exceptionDetails, this.extensionId) });
    }
  }

  recordEvent(event) {
    const record = {
      ...event,
      positiveControl: positiveControlRecord(event, this.positiveControlMarker || ''),
    };
    this.events.push(record);
  }

  recordCaptureError(error) {
    this.captureErrors.push({ name: error?.name, message: error?.message || String(error) });
  }

  setPositiveControlMarker(marker) {
    if (typeof marker !== 'string' || marker.length === 0) throw new Error('positive control marker is invalid');
    this.positiveControlMarker = marker;
  }

  async waitForPositiveControl(timeout = 5000) {
    if (this.positiveControlMarker === undefined) throw new Error('positive control marker is not set');
    const deadline = Date.now() + timeout;
    for (;;) {
      this.throwIfCaptureFailed();
      const event = this.events.find((candidate) => candidate.positiveControl === true
        && candidate.source === 'extension'
        && ((candidate.kind === 'exception' && candidate.uncaught === true)
          || (candidate.kind === 'console' && candidate.level === 'error')));
      if (event !== undefined) return event;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('extension console positive control was not captured'), {
          code: 'CONSOLE_POSITIVE_CONTROL_MISSED',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async waitForPositiveControlTarget(targetType, timeout = 5000) {
    if (this.positiveControlMarker === undefined) throw new Error('positive control marker is not set');
    const deadline = Date.now() + timeout;
    for (;;) {
      this.throwIfCaptureFailed();
      const event = this.events.find((candidate) => candidate.positiveControl === true
        && candidate.targetType === targetType
        && typeof candidate.targetUrl === 'string'
        && candidate.targetUrl.startsWith(extensionFramePrefix(this.extensionId))
        && candidate.kind === 'console'
        && candidate.level === 'error');
      if (event !== undefined) return event;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`extension console positive control was not captured on ${targetType}`), {
          code: 'CONSOLE_POSITIVE_CONTROL_MISSED',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throwIfCaptureFailed() {
    if (this.captureErrors.length > 0) {
      throw Object.assign(new Error('browser CDP console capture failed'), {
        code: 'CONSOLE_CAPTURE_FAILED',
        cause: this.captureErrors,
      });
    }
  }

  verdict() {
    const positiveControlCaptured = this.events.some((event) => event.positiveControl === true
      && event.source === 'extension'
      && ((event.kind === 'exception' && event.uncaught === true)
        || (event.kind === 'console' && event.level === 'error')));
    const extensionConsoleErrors = this.events.filter((event) => event.kind === 'console'
      && event.level === 'error'
      && event.source === 'extension'
      && event.positiveControl !== true);
    const extensionUncaughtExceptions = this.events.filter((event) => event.kind === 'exception'
      && event.uncaught === true
      && event.source === 'extension'
      && event.positiveControl !== true);
    const failures = [];
    let status = 'pass';
    if (this.captureErrors.length > 0) {
      status = 'INCONCLUSIVE';
      failures.push('browser CDP console capture failed');
    } else if (!positiveControlCaptured) {
      status = 'INCONCLUSIVE';
      failures.push('extension console positive control was not captured');
    } else {
      if (extensionConsoleErrors.length > 0) failures.push('extension-sourced error console output was captured');
      if (extensionUncaughtExceptions.length > 0) failures.push('extension-sourced uncaught exception was captured');
      if (failures.length > 0) status = 'fail';
    }
    return {
      status,
      failures,
      positiveControlCaptured,
      extensionConsoleErrorCount: extensionConsoleErrors.length,
      extensionUncaughtExceptionCount: extensionUncaughtExceptions.length,
      bilibiliBufferPrefixCount: this.events.filter((event) => event.bilibiliBufferPrefix === true).length,
      eventCount: this.events.length,
      captureErrors: [...this.captureErrors],
    };
  }

  async close() {
    if (!this.started) {
      await this.transport.close();
      return;
    }
    let closeError;
    if (this.transport.isOpen) {
      try {
        await this.transport.send('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (error) {
        closeError = error;
        this.recordCaptureError(error);
      }
    }
    try {
      await this.transport.close();
    } finally {
      this.started = false;
    }
    if (closeError !== undefined) throw closeError;
  }
}

export async function startConsoleCapture(remoteDebuggingPort, extensionId) {
  const transport = await connectToChrome(remoteDebuggingPort);
  const capture = new BrowserConsoleCapture(transport, extensionId);
  try {
    return await capture.start();
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export async function triggerExtensionPositiveControl(context, extensionId, capture) {
  const marker = `E2E_EXTENSION_POSITIVE_CONTROL_${Date.now()}`;
  capture.setPositiveControlMarker(marker);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((controlMarker) => {
      window.showSaveFilePicker = async () => { throw new Error(controlMarker); };
      document.querySelector('[data-export]').click();
    }, marker);
    const pageControl = await capture.waitForPositiveControl();
    const serviceWorkerSessionId = [...capture.targetSessions.entries()]
      .find(([, target]) => target.targetType === 'service_worker'
        && typeof target.targetUrl === 'string'
        && target.targetUrl.startsWith(extensionFramePrefix(extensionId)))?.[0];
    if (serviceWorkerSessionId === undefined) {
      throw Object.assign(new Error('service worker target was not attached for console positive control'), {
        code: 'CONSOLE_POSITIVE_CONTROL_MISSED',
      });
    }
    await capture.sendTargetCommand(serviceWorkerSessionId, 'Runtime.evaluate', {
      expression: `console.error(${JSON.stringify(marker)})`,
    });
    await capture.waitForPositiveControlTarget('service_worker');
    return pageControl;
  } finally {
    await page.close();
  }
}
