import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { appendBatch, handleMessage, readLogs } from '../src/diagnostics/worker.js';
import { FakeIDBKeyRange, FakeIndexedDB } from './fake-idb.mjs';

const originalKeyRange = globalThis.IDBKeyRange;
globalThis.IDBKeyRange = FakeIDBKeyRange;
after(() => {
  globalThis.IDBKeyRange = originalKeyRange;
});

function session(sessionId, pathname = '/100') {
  return {
    schemaVersion: 1,
    sessionId,
    startedAt: '2026-07-20T00:00:00.000Z',
    extensionVersion: '1.0.0',
    buildId: 'src-test',
    routeKind: 'live',
    origin: 'https://live.bilibili.com',
    pathname,
  };
}

function event(sessionId, sequence, code = 'route.session_started', data) {
  return {
    sessionId,
    sequence,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: sequence,
    code,
    ...(data === undefined ? {} : { data }),
  };
}

function message(identity, events) {
  return { type: 'diagnostic:events', version: 1, session: identity, events };
}

function sender(tabId, pathname = '/100') {
  return { tab: { id: tabId }, url: `https://live.bilibili.com${pathname}` };
}

async function readAllEvents(indexedDb, maxEventId) {
  return readLogs({
    type: 'logs:events-page',
    version: 1,
    limit: 250,
    afterEventId: 0,
    maxEventId,
  }, indexedDb);
}

test('realistic IDB transaction semantics preserve append-only isolation and restart-readable data', async () => {
  const indexedDb = new FakeIndexedDB();
  const firstSession = session('session-idb-first');
  const firstEvent = event(firstSession.sessionId, 1);
  const firstMessage = message(firstSession, [firstEvent]);
  const persisted = await appendBatch(firstMessage, sender(1), indexedDb);
  assert.equal(persisted.status, 'PERSISTED');
  assert.deepEqual(persisted.statuses, [{ sequence: 1, status: 'PERSISTED' }]);

  const duplicate = await appendBatch(firstMessage, sender(1), indexedDb);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.deepEqual(duplicate.statuses, [{ sequence: 1, status: 'DUPLICATE' }]);

  const sameIdDifferentRoute = await handleMessage(
    message(session(firstSession.sessionId, '/different'), [event(firstSession.sessionId, 2)]),
    sender(1),
    indexedDb,
  );
  assert.equal(sameIdDifferentRoute.status, 'SESSION_CONFLICT');

  const conflictingBatch = message(firstSession, [
    event(firstSession.sessionId, 2, 'video.attached', { source: 'https://media.example/video' }),
    event(firstSession.sessionId, 4),
  ]);
  const conflict = await handleMessage(conflictingBatch, sender(1), indexedDb);
  assert.equal(conflict.status, 'SEQUENCE_CONFLICT');

  const maxEvent = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  const firstEvents = await readAllEvents(indexedDb, maxEvent.maxEventId);
  assert.deepEqual(firstEvents.events.map(({ sequence }) => sequence), [1]);

  indexedDb.database.failNextEventAdd = true;
  const degraded = await handleMessage(
    message(firstSession, [event(firstSession.sessionId, 2)]),
    sender(1),
    indexedDb,
  );
  assert.equal(degraded.status, 'DEGRADED');
  const afterFailure = await readAllEvents(indexedDb, maxEvent.maxEventId + 1);
  assert.deepEqual(afterFailure.events.map(({ sequence }) => sequence), [1]);

  const concurrentSessions = Array.from({ length: 101 }, (_, index) => {
    const identity = session(`session-idb-${index}`, `/${index}`);
    return appendBatch(
      message(identity, [event(identity.sessionId, 1)]),
      sender(index + 10, `/${index}`),
      indexedDb,
    );
  });
  const concurrentResults = await Promise.all(concurrentSessions);
  assert.ok(concurrentResults.every((result) => result.status === 'PERSISTED'));

  const latestMaxEvent = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  const sessionPage = await readLogs({
    type: 'logs:sessions-page',
    version: 1,
    limit: 250,
    maxEventId: latestMaxEvent.maxEventId,
  }, indexedDb);
  assert.equal(sessionPage.sessions.length, 102);
  assert.equal(sessionPage.hasMore, false);

  const restartedIndexedDb = indexedDb;
  const restartedEvents = await readAllEvents(restartedIndexedDb, latestMaxEvent.maxEventId);
  assert.equal(restartedEvents.events.length, 102);
  assert.equal(restartedEvents.events.some((stored) => stored.sessionId === firstSession.sessionId && stored.sequence === 2), false);
});
