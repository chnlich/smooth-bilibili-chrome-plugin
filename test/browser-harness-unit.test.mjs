import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BrowserConsoleCapture,
  classifyConsoleEvent,
  classifyStackSource,
  hasExtensionStackFrame,
} from '../scripts/console-capture.mjs';
import {
  DEFAULT_CHROME_EXECUTABLE_PATH,
  resolveChromeExecutablePath,
} from '../scripts/browser-runtime.mjs';
import { readProvenance } from '../scripts/provenance.mjs';

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

test('provenance keeps verification running when git is unavailable', async () => {
  const buildId = `src-${'a'.repeat(24)}`;
  const provenance = await readProvenance({
    rootDirectory: 'test-root',
    extensionDirectory: 'test-dist',
    executeGit: async () => {
      throw new Error('spawn git ENOENT');
    },
    readFile: async () => `const buildId = '${buildId}';`,
  });
  assert.equal(provenance.commitSha, null);
  assert.match(provenance.commitShaReason, /spawn git ENOENT/);
  assert.equal(provenance.buildId, buildId);
});

test('provenance still rejects bundles with different buildIds', async () => {
  const controllerBuildId = `src-${'a'.repeat(24)}`;
  const workerBuildId = `src-${'b'.repeat(24)}`;
  await assert.rejects(
    readProvenance({
      rootDirectory: 'test-root',
      extensionDirectory: 'test-dist',
      executeGit: async () => ({ stdout: `${'c'.repeat(40)}\n` }),
      readFile: async (filePath) => filePath.endsWith('controller.js')
        ? `const buildId = '${controllerBuildId}';`
        : `const buildId = '${workerBuildId}';`,
    }),
    /dist bundles do not contain exactly one shared buildId/,
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

class FakeFlatCdpTransport {
  constructor() {
    this.commands = [];
    this.messageHandler = undefined;
    this.closeHandler = undefined;
    this.open = true;
  }

  get isOpen() {
    return this.open;
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  onClose(handler) {
    this.closeHandler = handler;
  }

  emitMessage(message) {
    this.messageHandler(message);
  }

  async send(method, params, sessionId) {
    this.commands.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [] };
    return {};
  }

  async close() {
    this.open = false;
  }
}

test('browser-level CDP uses flatten routing for page and service worker Runtime events', async () => {
  const transport = new FakeFlatCdpTransport();
  const extensionId = 'extension-test-id';
  const capture = await new BrowserConsoleCapture(transport, extensionId).start();
  transport.emitMessage({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'page-session',
      targetInfo: { targetId: 'page-target', type: 'page', url: 'about:blank' },
    },
  });
  transport.emitMessage({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'worker-session',
      targetInfo: {
        targetId: 'worker-target',
        type: 'service_worker',
        url: `chrome-extension://${extensionId}/worker.js`,
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  transport.emitMessage({
    method: 'Target.targetInfoChanged',
    params: {
      targetInfo: { targetId: 'page-target', type: 'page', url: 'https://www.bilibili.com/video/BVtest' },
    },
  });
  transport.emitMessage({
    sessionId: 'page-session',
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'error',
      args: [{ value: 'page error' }],
      stackTrace: { callFrames: [{ url: 'https://www.bilibili.com/video/BVtest' }] },
    },
  });
  transport.emitMessage({
    sessionId: 'page-session',
    method: 'Runtime.exceptionThrown',
    params: {
      exceptionDetails: {
        uncaught: true,
        text: 'page uncaught error',
        stackTrace: { callFrames: [{ url: 'https://www.bilibili.com/video/BVtest' }] },
      },
    },
  });
  transport.emitMessage({
    sessionId: 'worker-session',
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'error',
      args: [{ value: 'worker error' }],
      stackTrace: { callFrames: [{ url: `chrome-extension://${extensionId}/worker.js` }] },
    },
  });
  transport.emitMessage({
    sessionId: 'worker-session',
    method: 'Runtime.exceptionThrown',
    params: {
      exceptionDetails: {
        uncaught: true,
        text: 'worker uncaught error',
        stackTrace: { callFrames: [{ url: `chrome-extension://${extensionId}/worker.js` }] },
      },
    },
  });
  assert.deepEqual(capture.events.map(({ targetType, targetUrl, kind, source }) => ({
    targetType,
    targetUrl,
    kind,
    source,
  })), [
    {
      targetType: 'page',
      targetUrl: 'https://www.bilibili.com/video/BVtest',
      kind: 'console',
      source: 'page',
    },
    {
      targetType: 'page',
      targetUrl: 'https://www.bilibili.com/video/BVtest',
      kind: 'exception',
      source: 'page',
    },
    {
      targetType: 'service_worker',
      targetUrl: `chrome-extension://${extensionId}/worker.js`,
      kind: 'console',
      source: 'extension',
    },
    {
      targetType: 'service_worker',
      targetUrl: `chrome-extension://${extensionId}/worker.js`,
      kind: 'exception',
      source: 'extension',
    },
  ]);
  assert.deepEqual(transport.commands[0], {
    method: 'Target.setDiscoverTargets',
    params: { discover: true },
    sessionId: undefined,
  });
  assert.deepEqual(transport.commands[1], {
    method: 'Target.setAutoAttach',
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId: undefined,
  });
  assert.deepEqual(
    transport.commands.filter(({ method }) => method === 'Runtime.enable').map(({ sessionId }) => sessionId),
    ['page-session', 'worker-session'],
  );
  assert.equal(capture instanceof BrowserConsoleCapture, true);
  await capture.close();
  assert.equal(transport.commands.at(-1).params.flatten, true);
  assert.equal(transport.open, false);
});
