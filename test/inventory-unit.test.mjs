import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANK_CONFIG } from '../src/constants.js';
import { SegmentBank } from '../src/bank/main.js';
import { INVENTORY_HEARTBEAT_FLOOR_MS, deriveBankInventory } from '../src/bank/inventory.js';
import { sanitizeEventData } from '../src/diagnostics/privacy.js';

const MEDIA_URL = 'https://cdn-a.example/video/track.m4s?signature=secret';
const RESOURCE = '/video/track.m4s';

function bankFixture({ now = 0, configuredEnabled, config = { ...BANK_CONFIG, chunkBytes: 16 } } = {}) {
  let clock = now;
  let tick;
  const messages = [];
  const windowObject = {
    location: new URL('https://www.bilibili.com/video/BVinventory'),
    document: {
      documentElement: {
        getAttribute() {
          return configuredEnabled;
        },
      },
    },
    setInterval(callback) {
      tick = callback;
      return 1;
    },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    performance: { now: () => clock },
    postMessage(message) { messages.push(message); },
  };
  const bank = new SegmentBank({
    windowObject,
    nativeFetch: async () => { throw new Error('inventory test does not fetch'); },
    config,
    now: () => clock,
  });
  return {
    bank,
    messages,
    tick() {
      assert.notEqual(tick, undefined);
      tick();
    },
    setNow(value) { clock = value; },
    setLocation(value) { windowObject.location = new URL(value); },
  };
}

function inventoryMessages(fixture) {
  return fixture.messages.filter((message) => message.code === 'bank.inventory');
}

test('inventory derivation reports an empty bank and missing total size without inventing values', () => {
  const fixture = bankFixture();
  const empty = deriveBankInventory({
    chunks: new Map(),
    resourceState: new Map(),
    addressBook: new Map(),
    recentResourceKeys: [],
    maxBankBytes: 512,
    maxPrefetchConcurrency: 4,
    queueLength: 0,
    inflightCount: 0,
    disabled: false,
    routeActive: true,
    isPairedAddressAvailable: () => false,
    sessionGeneration: 0,
  });
  assert.equal(empty.storedBytes, 0);
  assert.equal(empty.storedChunks, 0);
  assert.deepEqual(empty.resources, []);

  const state = fixture.bank.stateFor(RESOURCE);
  state.latestUrl = MEDIA_URL;
  fixture.bank.touchResource(RESOURCE);
  fixture.bank.publishInventory(true);
  const resource = inventoryMessages(fixture).at(-1).data.resources[0];
  assert.equal(resource.totalSize, '未提供');
  assert.equal(resource.lastForegroundEnd, '未提供');
  assert.equal(resource.active, true);
  fixture.bank.destroy();
});

test('inventory reports absent paired address, disabled state, and route-left release', () => {
  const fixture = bankFixture({ configuredEnabled: 'false' });
  const state = fixture.bank.stateFor(RESOURCE);
  state.latestUrl = MEDIA_URL;
  fixture.bank.touchResource(RESOURCE);
  fixture.bank.addressBook.set(RESOURCE, {
    urls: [MEDIA_URL],
    observedAt: 0,
    representation: { mimeType: 'video/mp4', height: 720, codecs: 'avc1', bandwidth: 1000 },
    label: '720P',
  });

  fixture.tick();
  const disabled = inventoryMessages(fixture).at(-1).data;
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.pairedAddressAvailable, false);

  fixture.setLocation('https://www.bilibili.com/search');
  fixture.tick();
  const routeLeft = inventoryMessages(fixture).at(-1).data;
  assert.equal(routeLeft.routeActive, false);
  assert.equal(routeLeft.storedBytes, 0);
  assert.equal(routeLeft.resources.length, 0);
  assert.equal(routeLeft.sessionGeneration, 1);
  fixture.bank.destroy();
});

test('unchanged inventory is suppressed until the heartbeat floor republishes it', async () => {
  const fixture = bankFixture();
  await fixture.bank.prefetch();
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 1);

  fixture.setNow(INVENTORY_HEARTBEAT_FLOOR_MS - 1);
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 1);

  fixture.setNow(INVENTORY_HEARTBEAT_FLOOR_MS);
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 2);
  fixture.bank.destroy();
});

test('inventory resources are sanitized to pathnames and never retain query or hash', () => {
  const sanitized = sanitizeEventData('bank.inventory', {
    sessionGeneration: 1,
    storedBytes: 10,
    storedChunks: 1,
    maxBankBytes: 512,
    queued: 0,
    inflight: 0,
    prefetchConcurrency: 4,
    disabled: false,
    routeActive: true,
    pairedAddressAvailable: true,
    resources: [{
      pathname: '/video/track.m4s?deadline=secret#fragment',
      kind: 'video',
      label: '1080P 高清',
      height: 1080,
      codecs: 'avc1.640028',
      bandwidth: 5000000,
      storedBytes: 10,
      storedChunks: 1,
      totalSize: 100,
      lastForegroundEnd: 15,
      outstanding: 0,
      retrying: 0,
      active: true,
      secret: 'removed',
    }],
  });
  assert.equal(sanitized.resources[0].pathname, '/video/track.m4s');
  assert.doesNotMatch(JSON.stringify(sanitized), /deadline=secret|fragment|secret/);
  assert.equal(Object.hasOwn(sanitized.resources[0], 'secret'), false);
});
