import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  BrowserConsoleCapture,
  classifyConsoleEvent,
  classifyStackSource,
  hasExtensionStackFrame,
  startConsoleCapture,
} from '../scripts/console-capture.mjs';
import {
  DEFAULT_CHROME_EXECUTABLE_PATH,
  resolveChromeExecutablePath,
} from '../scripts/browser-runtime.mjs';

test('Chrome executable resolution uses the override and never falls back after a missing path', async () => {
  const override = await resolveChromeExecutablePath({
    environment: { BILIBILI_E2E_CHROME: 'C:/Chrome/chrome.exe' },
    stat: async () => ({ isFile: () => true }),
  });
  assert.equal(override, 'C:/Chrome/chrome.exe');
  await assert.rejects(
    resolveChromeExecutablePath({
      environment: {},
      stat: async () => { throw new Error('missing'); },
    }),
    (error) => error.message.includes(DEFAULT_CHROME_EXECUTABLE_PATH)
      && error.message.includes('Playwright bundled Chromium is not used'),
  );
});

test('console source attribution requires an extension stack frame and ignores a forged text prefix', () => {
  const extensionId = 'bcimndlcfejphjdkhlfopcglfenaehmc';
  const extensionStack = {
    callFrames: [{ url: `chrome-extension://${extensionId}/worker.js`, lineNumber: 1, columnNumber: 1 }],
  };
  const pageStack = {
    callFrames: [{ url: 'https://www.bilibili.com/video/BVtest', lineNumber: 1, columnNumber: 1 }],
  };
  assert.equal(hasExtensionStackFrame(extensionStack, extensionId), true);
  assert.equal(classifyStackSource(extensionStack, extensionId), 'extension');
  assert.equal(classifyStackSource(pageStack, extensionId), 'page');
  const forged = classifyConsoleEvent({
    type: 'error',
    args: [{ value: '[BilibiliBuffer] page-forged' }],
    stackTrace: pageStack,
  }, extensionId);
  assert.equal(forged.source, 'page');
  assert.equal(forged.extensionFrame, false);
  assert.equal(forged.bilibiliBufferPrefix, true);
});

class FakeBrowserCDPSession extends EventEmitter {
  async send(method, params) {
    if (method === 'Target.sendMessageToTarget') {
      const message = JSON.parse(params.message);
      queueMicrotask(() => this.emit('Target.receivedMessageFromTarget', {
        sessionId: params.sessionId,
        message: JSON.stringify({ id: message.id, result: {} }),
      }));
    }
    return {};
  }

  async detach() {}
}

test('browser-level CDP attaches page and service worker targets through one Runtime path', async () => {
  const session = new FakeBrowserCDPSession();
  const browser = { newBrowserCDPSession: async () => session };
  const extensionId = 'extension-test-id';
  const capture = await startConsoleCapture(browser, extensionId);
  session.emit('Target.attachedToTarget', {
    sessionId: 'page-session',
    targetInfo: { type: 'page', url: 'https://www.bilibili.com/video/BVtest' },
  });
  session.emit('Target.attachedToTarget', {
    sessionId: 'worker-session',
    targetInfo: { type: 'service_worker', url: `chrome-extension://${extensionId}/worker.js` },
  });
  await new Promise((resolve) => setImmediate(resolve));
  session.emit('Target.receivedMessageFromTarget', {
    sessionId: 'page-session',
    message: JSON.stringify({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'error',
        args: [{ value: 'page error' }],
        stackTrace: { callFrames: [{ url: 'https://www.bilibili.com/video/BVtest' }] },
      },
    }),
  });
  session.emit('Target.receivedMessageFromTarget', {
    sessionId: 'worker-session',
    message: JSON.stringify({
      method: 'Runtime.exceptionThrown',
      params: {
        exceptionDetails: {
          uncaught: true,
          text: 'worker error',
          stackTrace: { callFrames: [{ url: `chrome-extension://${extensionId}/worker.js` }] },
        },
      },
    }),
  });
  assert.deepEqual(capture.events.map(({ targetType, kind, source }) => ({ targetType, kind, source })), [
    { targetType: 'page', kind: 'console', source: 'page' },
    { targetType: 'service_worker', kind: 'exception', source: 'extension' },
  ]);
  assert.equal(capture instanceof BrowserConsoleCapture, true);
  await capture.close();
});
