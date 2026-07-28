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
  return `${parsed.origin}${parsed.pathname}`;
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
  constructor(browser, extensionId) {
    this.browser = browser;
    this.extensionId = extensionId;
    this.events = [];
    this.targetSessions = new Map();
    this.pendingCommands = new Map();
    this.captureErrors = [];
    this.commandId = 0;
    this.positiveControlMarker = undefined;
    this.browserSession = undefined;
  }

  async start() {
    this.browserSession = await this.browser.newBrowserCDPSession();
    this.browserSession.on('Target.attachedToTarget', (event) => {
      void this.attachTarget(event).catch((error) => this.recordCaptureError(error));
    });
    this.browserSession.on('Target.detachedFromTarget', ({ sessionId }) => {
      this.targetSessions.delete(sessionId);
    });
    this.browserSession.on('Target.receivedMessageFromTarget', (event) => {
      this.receiveTargetMessage(event);
    });
    await this.browserSession.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
    return this;
  }

  async attachTarget({ sessionId, targetInfo }) {
    if (!CAPTURED_TARGET_TYPES.has(targetInfo?.type)) return;
    if (this.targetSessions.has(sessionId)) return;
    this.targetSessions.set(sessionId, targetRecord(targetInfo.targetId, targetInfo));
    await this.sendTargetCommand(sessionId, 'Runtime.enable');
    await this.sendTargetCommand(sessionId, 'Runtime.setAsyncCallStackDepth', { maxDepth: 32 });
  }

  async sendTargetCommand(sessionId, method, params = {}) {
    if (this.browserSession === undefined) throw new Error('browser CDP session is not started');
    const id = this.commandId + 1;
    this.commandId = id;
    const key = `${sessionId}:${id}`;
    const response = new Promise((resolve, reject) => {
      this.pendingCommands.set(key, { resolve, reject });
    });
    try {
      await this.browserSession.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      this.pendingCommands.delete(key);
      throw error;
    }
    return response;
  }

  receiveTargetMessage({ sessionId, message }) {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (error) {
      this.recordCaptureError(error);
      return;
    }
    if (payload.id !== undefined) {
      const key = `${sessionId}:${payload.id}`;
      const pending = this.pendingCommands.get(key);
      if (pending === undefined) return;
      this.pendingCommands.delete(key);
      if (payload.error !== undefined) {
        pending.reject(Object.assign(new Error(payload.error.message), { code: payload.error.code }));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }
    const target = this.targetSessions.get(sessionId);
    if (target === undefined) return;
    if (payload.method === 'Runtime.consoleAPICalled') {
      this.recordEvent({ ...target, ...classifyConsoleEvent(payload.params, this.extensionId) });
      return;
    }
    if (payload.method === 'Runtime.exceptionThrown') {
      this.recordEvent({ ...target, ...classifyExceptionEvent(payload.params.exceptionDetails, this.extensionId) });
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
    if (this.browserSession === undefined) return;
    await this.browserSession.send('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
    await this.browserSession.detach();
    this.browserSession = undefined;
  }
}

export async function startConsoleCapture(browser, extensionId) {
  return new BrowserConsoleCapture(browser, extensionId).start();
}

export async function triggerExtensionPositiveControl(context, extensionId, capture) {
  const marker = `E2E_EXTENSION_POSITIVE_CONTROL_${Date.now()}`;
  capture.setPositiveControlMarker(marker);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((controlMarker) => {
      setTimeout(() => {
        throw new Error(controlMarker);
      }, 0);
    }, marker);
    return await capture.waitForPositiveControl();
  } finally {
    await page.close();
  }
}
