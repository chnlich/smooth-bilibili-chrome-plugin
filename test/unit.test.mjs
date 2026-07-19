import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { HLS_DEPENDENCY, LIVE_CONFIG, LIVE_STATE, VOD_CONFIG } from '../src/constants.js';
import { BufferScriptError } from '../src/errors.js';
import { fetchBytesFromCandidates } from '../src/live/fetcher.js';
import {
  buildCdnCandidates,
  buildSegmentCandidates,
  parseHlsPlaylist,
  parseAttributeList,
  selectMediaVariant,
} from '../src/live/manifest.js';
import { assertSameLiveSession, renewLiveTrack, extractLiveTrack } from '../src/live/api.js';
import { LiveController, waitForVideo } from '../src/live/controller.js';
import { DanmakuVisibilityController } from '../src/live/danmaku.js';
import { installLivePlaybackGuard } from '../src/live/guard.js';
import { MseAppendPipeline, validateInitSegmentTracks } from '../src/live/mse.js';
import { OrderedSegmentQueue } from '../src/live/queue.js';
import { LiveStateMachine } from '../src/live/state.js';
import { computeForwardInventory } from '../src/vod/buffer.js';
import { VodBufferPolicy, callQualityMethod, readQualitySnapshot } from '../src/vod/policy.js';
import { VodController } from '../src/vod/controller.js';

const MEDIA_URL = 'https://cdn-a.example/live/index.m3u8?expires=123&sign=abc';
const MEDIA_TEXT = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
seg-100.m4s
#EXTINF:2.0,
seg-101.m4s
#EXTINF:2.0,
seg-102.m4s
`;

function response(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

function makeBox(type, payload = new Uint8Array()) {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength, false);
  bytes.set([...type].map((character) => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}

function makeMuxedInitSegment() {
  const handlerBox = (handler) => {
    const payload = new Uint8Array(12);
    payload.set([...handler].map((character) => character.charCodeAt(0)), 8);
    return makeBox('hdlr', payload);
  };
  const videoTrack = makeBox('trak', makeBox('mdia', handlerBox('vide')));
  const audioTrack = makeBox('trak', makeBox('mdia', handlerBox('soun')));
  const moov = makeBox('moov', new Uint8Array([...videoTrack, ...audioTrack]));
  return new Uint8Array([...makeBox('ftyp', new Uint8Array(4)), ...moov]).buffer;
}

const VALID_INIT_SEGMENT = makeMuxedInitSegment();

function createTrack(session = 'session-1') {
  return {
    roomId: 6363772,
    requestedQualityNumber: 10000,
    qualityNumber: 250,
    qualityDescription: '高清 720P',
    formatName: 'fmp4',
    codecName: 'avc',
    videoCodecString: 'avc1.4d401f',
    audioCodecString: 'mp4a.40.2',
    codecString: 'avc1.4d401f, mp4a.40.2',
    session,
    baseUrl: '/live/index.m3u8?',
    urlInfo: [
      { host: 'https://cdn-a.example', extra: 'expires=1&sign=a' },
      { host: 'https://cdn-b.example', extra: 'expires=1&sign=b' },
    ],
    candidates: [
      'https://cdn-a.example/live/index.m3u8?expires=1&sign=a',
      'https://cdn-b.example/live/index.m3u8?expires=1&sign=b',
    ],
    acceptQualityNumbers: [250],
  };
}

function createPayload(session = 'session-1') {
  return {
    code: 0,
    message: 'OK',
    data: {
      room_id: 6363772,
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_hls',
              format: [
                {
                  format_name: 'fmp4',
                  codec: [
                    {
                      codec_name: 'avc',
                      current_qn: 250,
                      accept_qn: [250],
                      base_url: '/live/index.m3u8?',
                      url_info: [
                        { host: 'https://cdn-a.example', extra: 'expires=1&sign=a' },
                        { host: 'https://cdn-b.example', extra: 'expires=1&sign=b' },
                      ],
                      session,
                      description: '高清 720P',
                      video_codecs: { base: 'avc1.4d401f' },
                      audio_codecs: { base: 'mp4a.40.2' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

function createLiveVideo({ forwardInventory = 0, asyncPause = false } = {}) {
  const listeners = new Map();
  const emit = (name) => {
    for (const listener of listeners.get(name) || []) {
      listener();
    }
  };
  return {
    currentTime: 0,
    playbackRate: 1,
    paused: false,
    pauseCalls: 0,
    playCalls: 0,
    buffered: { length: 1, start: () => 0, end: () => forwardInventory },
    addEventListener(name, listener) {
      const callbacks = listeners.get(name) || new Set();
      callbacks.add(listener);
      listeners.set(name, callbacks);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    dispatchEvent(event) {
      emit(typeof event === 'string' ? event : event.type);
      return true;
    },
    pause() {
      this.pauseCalls += 1;
      if (this.paused) {
        return;
      }
      this.paused = true;
      if (asyncPause) {
        setTimeout(() => emit('pause'), 0);
      } else {
        emit('pause');
      }
    },
    play() {
      this.playCalls += 1;
      this.paused = false;
      emit('play');
      return Promise.resolve();
    },
  };
}

function createLiveController({ video = createLiveVideo(), fetchImpl, runtimeObject: suppliedRuntime } = {}) {
  const runtimeObject = suppliedRuntime || {
    MediaSource: globalThis.MediaSource,
    URL: globalThis.URL,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
    },
  };
  const controller = new LiveController({
    windowObject: { setInterval: () => 1, clearInterval() {} },
    documentObject: { querySelectorAll: () => [] },
    video,
    panel: { setModel() {}, setAction() {}, setMessage() {} },
    hls: {},
    roomId: 6363772,
    fetchImpl: fetchImpl || (async () => {
      throw new Error('unexpected fetch');
    }),
    runtimeObject,
    logger: { warn() {}, error() {} },
  });
  controller.pipeline.assertOwnsVideoSource = () => {};
  return { controller, video };
}

function createStartupRuntime(appendState) {
  class FakeSourceBuffer {
    constructor() {
      this.updating = false;
      this.mode = 'segments';
    }

    appendBuffer() {
      if (appendState.failAppend) {
        throw new Error('deterministic initial append failure');
      }
    }

    remove() {}
  }

  class FakeMediaSource {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      this.readyState = 'open';
    }

    addSourceBuffer() {
      return new FakeSourceBuffer();
    }

    endOfStream() {
      this.readyState = 'ended';
    }
  }

  let objectUrlNumber = 0;
  return {
    MediaSource: FakeMediaSource,
    URL: {
      createObjectURL() {
        objectUrlNumber += 1;
        return `blob:startup-${objectUrlNumber}`;
      },
      revokeObjectURL() {},
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
    },
  };
}

function createStartupController(fetchImpl, appendState = { failAppend: false }) {
  const actions = new Map();
  const stages = [];
  const controller = new LiveController({
    windowObject: {
      player: {
        setAutoSyncProgressCfg() {},
        setAutoDiscardFrameCfg() {},
        pause() {},
      },
    },
    documentObject: { documentElement: null, querySelectorAll: () => [] },
    video: createLiveVideo(),
    panel: {
      setModel(model) {
        if (model.stage !== undefined) {
          stages.push(model.stage);
        }
      },
      setMessage() {},
      setAction(name, _label, _callback, visible) {
        actions.set(name, visible);
      },
    },
    hls: { isSupported: () => true },
    roomId: 6363772,
    fetchImpl,
    runtimeObject: createStartupRuntime(appendState),
    logger: { warn() {}, error() {} },
    config: { ...LIVE_CONFIG, requestTimeoutMilliseconds: 100, retryBackoffMilliseconds: [0] },
  });
  controller.scheduleDownloads = () => {};
  return { controller, actions, appendState, stages };
}

test('manifest parser retains media sequence, init map, and signed query parameters', () => {
  const parsed = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  assert.equal(parsed.type, 'media');
  assert.equal(parsed.mediaSequence, 100);
  assert.equal(parsed.segments[0].sn, 100);
  assert.equal(parsed.segments[0].url, 'https://cdn-a.example/live/seg-100.m4s?expires=123&sign=abc');
  assert.equal(parsed.map.url, 'https://cdn-a.example/live/init.mp4?expires=123&sign=abc');
  assert.deepEqual(parseAttributeList('BANDWIDTH=1000,CODECS="avc1.4d401f,mp4a.40.2"'), {
    BANDWIDTH: '1000',
    CODECS: 'avc1.4d401f,mp4a.40.2',
  });
});

test('empty master is a missing variant while empty fMP4 media remains retryable', () => {
  assert.throws(
    () => parseHlsPlaylist('#EXTM3U\n#EXT-X-VERSION:7\n', MEDIA_URL),
    (error) => error instanceof BufferScriptError && error.code === 'MANIFEST_VARIANT_MISSING',
  );
  assert.throws(
    () =>
      parseHlsPlaylist(
        `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
`,
        MEDIA_URL,
      ),
    (error) => error instanceof BufferScriptError && error.code === 'MANIFEST_EMPTY',
  );
});

test('master variant selection requires the exact fMP4 codec list', () => {
  const profileDrift = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.640028,mp4a.40.2"
profile-drift.m3u8
`,
    MEDIA_URL,
  );
  assert.throws(
    () => selectMediaVariant(profileDrift, 'avc1.4d401f, mp4a.40.2'),
    (error) => error instanceof BufferScriptError && error.code === 'MANIFEST_VARIANT_MISSING',
  );

  const exact = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="MP4A.40.2, AVC1.4D401F"
exact.m3u8
`,
    MEDIA_URL,
  );
  assert.match(selectMediaVariant(exact, 'avc1.4d401f, mp4a.40.2').url, /\/exact\.m3u8/);
});

test('CDN candidates apply fresh signed values over stale base and segment query values', () => {
  const track = {
    ...createTrack(),
    baseUrl: '/live/index.m3u8?expires=base&sign=base',
  };
  const candidates = buildCdnCandidates(track);
  assert.equal(candidates.length, 2);
  assert.equal(new URL(candidates[0]).searchParams.get('expires'), '1');
  assert.equal(new URL(candidates[0]).searchParams.get('sign'), 'a');
  assert.equal(new URL(candidates[1]).searchParams.get('expires'), '1');
  assert.equal(new URL(candidates[1]).searchParams.get('sign'), 'b');
  const segmentCandidates = buildSegmentCandidates(
    'https://cdn-a.example/live/seg-100.m4s?part=1&expires=old&sign=old',
    candidates,
  );
  assert.equal(segmentCandidates[0], 'https://cdn-a.example/live/seg-100.m4s?part=1&expires=1&sign=a');
  assert.equal(segmentCandidates[1], 'https://cdn-b.example/live/seg-100.m4s?part=1&expires=1&sign=b');
});

test('ordered queue accepts out-of-order downloads but only delivers the expected sequence', () => {
  const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  const queue = new OrderedSegmentQueue();
  queue.initialize(manifest, false);
  queue.markDownloaded(102, new ArrayBuffer(1));
  assert.equal(queue.peekReady(), undefined);
  queue.markDownloaded(100, new ArrayBuffer(1));
  queue.markDownloaded(101, new ArrayBuffer(1));
  assert.equal(queue.acknowledgeDelivery(100).segment.sn, 100);
  assert.equal(queue.acknowledgeDelivery(101).segment.sn, 101);
  assert.equal(queue.acknowledgeDelivery(102).segment.sn, 102);
  assert.equal(queue.expectedSn, 103);
});

test('manifest sliding past expected freezes even when the old descriptor remains cached', () => {
  const queue = new OrderedSegmentQueue();
  const initial = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  queue.initialize(initial, false);
  assert.equal(queue.getSegment(100).sn, 100);
  const slidPast = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:101
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
seg-101.m4s
#EXTINF:2,
seg-102.m4s
#EXTINF:2,
seg-103.m4s
`,
    MEDIA_URL,
  );
  assert.throws(
    () => queue.updateManifest(slidPast),
    (error) => error.code === 'GAP_MANIFEST_SLID_PAST_EXPECTED',
  );
  assert.equal(queue.isFrozen(), true);
});

test('manifest media sequence rollback freezes the queue and manual reset installs a new baseline', () => {
  const queue = new OrderedSegmentQueue();
  const initial = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
seg-100.m4s
#EXTINF:1,
seg-101.m4s
`,
    MEDIA_URL,
  );
  queue.initialize(initial, false);
  const rollback = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
seg-0.m4s
#EXTINF:1,
seg-1.m4s
`,
    MEDIA_URL,
  );
  assert.throws(
    () => queue.updateManifest(rollback),
    (error) => error.code === 'GAP_MANIFEST_SEQUENCE_ROLLBACK',
  );
  assert.equal(queue.isFrozen(), true);
  const manual = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:200
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
seg-200.m4s
#EXTINF:1,
seg-201.m4s
`,
    MEDIA_URL,
  );
  queue.resetForManualJump(manual);
  assert.equal(queue.isFrozen(), false);
  assert.equal(queue.lastMediaSequence, 200);
  assert.equal(queue.expectedSn, 201);
});

test('same media sequence with no newly produced segment remains a waiting queue, not a gap', () => {
  const queue = new OrderedSegmentQueue();
  const initial = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
seg-100.m4s
`,
    MEDIA_URL,
  );
  queue.initialize(initial, false);
  queue.markDownloaded(100, new ArrayBuffer(1));
  queue.acknowledgeDelivery(100);
  const unchanged = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
seg-100.m4s
`,
    MEDIA_URL,
  );
  assert.doesNotThrow(() => queue.updateManifest(unchanged));
  assert.equal(queue.isFrozen(), false);
  assert.throws(() => queue.getNextSegment(), (error) => error.code === 'GAP_NOT_IN_MANIFEST');
});

test('same-quality CDN candidates race concurrently and return the first success', async () => {
  const calls = [];
  const startedAt = new Map();
  const started = Date.now();
  const result = await fetchBytesFromCandidates(['https://cdn-a.example/seg', 'https://cdn-b.example/seg'], {
    requestTimeoutMilliseconds: 100,
    retryBackoffMilliseconds: [0],
    fetchImpl: async (url) => {
      calls.push(url);
      startedAt.set(url, Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, url.includes('cdn-a') ? 250 : 10));
      return url.includes('cdn-a') ? response(503, 'temporary') : response(200, new Uint8Array([1, 2, 3]));
    },
  });
  assert.deepEqual(new Set(calls), new Set(['https://cdn-a.example/seg', 'https://cdn-b.example/seg']));
  assert.ok(Math.abs(startedAt.get('https://cdn-a.example/seg') - startedAt.get('https://cdn-b.example/seg')) < 50);
  assert.ok(Date.now() - started < 150);
  assert.equal(result.url, 'https://cdn-b.example/seg');
  assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array([1, 2, 3]));
});

test('permanent 404 freezes a required segment instead of skipping it', async () => {
  await assert.rejects(
    () =>
      fetchBytesFromCandidates(['https://cdn-a.example/seg', 'https://cdn-b.example/seg'], {
        retryCount: 0,
        fetchImpl: async () => response(404, 'missing'),
      }),
    (error) => error instanceof BufferScriptError && error.code === 'SEGMENT_PERMANENT_404',
  );
});

test('any expired signature response triggers renewal before mixed CDN failures can retry forever', async () => {
  await assert.rejects(
    () =>
      fetchBytesFromCandidates(['https://cdn-a.example/seg', 'https://cdn-b.example/seg'], {
        retryBackoffMilliseconds: [0],
        fetchImpl: async (url) => response(url.includes('cdn-a') ? 403 : 404, 'failure'),
      }),
    (error) => error instanceof BufferScriptError && error.code === 'SIGNATURE_EXPIRED',
  );
});

test('signature renewal preserves room, quality, format, codec, and stream session', async () => {
  assert.equal(
    assertSameLiveSession(createTrack(), { ...createTrack(), codecString: 'MP4A.40.2, AVC1.4D401F' }),
    true,
  );
  for (const codecString of ['avc1.640028, mp4a.40.2', 'avc1.4d401f, mp4a.40.5']) {
    assert.throws(
      () => assertSameLiveSession(createTrack(), { ...createTrack(), codecString }),
      (error) => error instanceof BufferScriptError && error.code === 'LIVE_SESSION_FORMAT_CHANGED',
    );
  }
  const renewed = await renewLiveTrack(createTrack(), async (url) => {
    assert.match(url, /room_id=6363772/);
    assert.match(url, /qn=250/);
    return response(200, JSON.stringify(createPayload()));
  });
  assert.equal(renewed.session, 'session-1');
  await assert.rejects(
    () => renewLiveTrack(createTrack(), async () => response(200, JSON.stringify(createPayload('session-2')))),
    (error) => error.code === 'LIVE_SESSION_CHANGED',
  );
  const profileDrift = createPayload();
  profileDrift.data.playurl_info.playurl.stream[0].format[0].codec[0].video_codecs.base = 'avc1.640028';
  await assert.rejects(
    () => renewLiveTrack(createTrack(), async () => response(200, JSON.stringify(profileDrift))),
    (error) => error.code === 'LIVE_SESSION_FORMAT_CHANGED',
  );
});

test('live track retains the API quality description when codec metadata omits it', () => {
  const payload = createPayload();
  const playurl = payload.data.playurl_info.playurl;
  const codec = playurl.stream[0].format[0].codec[0];
  delete codec.description;
  playurl.g_qn_desc = [{ qn: 250, desc: '超清' }];

  assert.equal(extractLiveTrack(payload, 10000, 'avc').qualityDescription, '超清');
});

test('automatic signature renewal refreshes manifest candidates before retrying cached sequences', async () => {
  const initialManifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  const freshManifestUrl = 'https://cdn-renewed.example/live/index.m3u8?expires=fresh&sign=fresh';
  const freshManifest = parseHlsPlaylist(MEDIA_TEXT, freshManifestUrl);
  const payload = createPayload();
  payload.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info = [
    { host: 'https://cdn-renewed.example', extra: 'expires=fresh&sign=fresh' },
  ];
  const { controller } = createLiveController({
    fetchImpl: async (url) => {
      assert.match(url, /room_id=6363772/);
      return response(200, JSON.stringify(payload));
    },
  });
  controller.track = createTrack();
  controller.manifest = initialManifest;
  controller.manifestCandidates = [...controller.track.candidates];
  controller.liveEdge = initialManifest.segments[initialManifest.segments.length - 1];
  controller.queue.initialize(initialManifest, true);
  controller.loadMediaManifest = async (track) => {
    assert.deepEqual(track.candidates, [freshManifestUrl]);
    return { manifest: freshManifest, candidates: [freshManifestUrl] };
  };

  await controller.renewTrack();

  assert.deepEqual(controller.manifestCandidates, [freshManifestUrl]);
  assert.equal(controller.liveEdge.sn, freshManifest.segments[freshManifest.segments.length - 1].sn);
  const cachedSegment = initialManifest.segments[0].url;
  const renewedCandidate = buildSegmentCandidates(cachedSegment, controller.manifestCandidates)[0];
  assert.equal(new URL(renewedCandidate).searchParams.get('expires'), 'fresh');
  assert.equal(new URL(renewedCandidate).searchParams.get('sign'), 'fresh');
});

test('LiveController.start renews an expired initial manifest before opening the product pipeline', async () => {
  const requests = [];
  let playInfoCalls = 0;
  const initialPayload = createPayload();
  initialPayload.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info = [
    { host: 'https://cdn-old-a.example', extra: 'sign=old-a' },
    { host: 'https://cdn-old-b.example', extra: 'sign=old-b' },
  ];
  const renewedPayload = createPayload();
  renewedPayload.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info = [
    { host: 'https://cdn-fresh-a.example', extra: 'sign=fresh-a' },
    { host: 'https://cdn-fresh-b.example', extra: 'sign=fresh-b' },
  ];
  const { controller } = createStartupController(async (url) => {
    requests.push(url);
    if (url.includes('getRoomPlayInfo')) {
      playInfoCalls += 1;
      return response(200, JSON.stringify(playInfoCalls === 1 ? initialPayload : renewedPayload));
    }
    const parsed = new URL(url);
    if (parsed.hostname.startsWith('cdn-old-') && parsed.pathname.endsWith('.m3u8')) {
      return response(403, 'expired');
    }
    if (parsed.pathname.endsWith('.m3u8')) {
      return response(200, MEDIA_TEXT);
    }
    return response(200, parsed.pathname.endsWith('init.mp4') ? VALID_INIT_SEGMENT : 'segment');
  });

  await controller.start();

  assert.equal(playInfoCalls, 2);
  assert.equal(controller.started, true);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.ok(controller.manifestCandidates.every((url) => url.includes('cdn-fresh-')));
  assert.ok(requests.some((url) => url.includes('cdn-fresh-a.example/live/index.m3u8')));
  controller.destroy();
});

test('LiveController starts without errors while synthetic page-player bridge calls are unavailable', async () => {
  const warnings = [];
  const errors = [];
  const { controller } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(createPayload()));
    }
    if (new URL(url).pathname.endsWith('init.mp4')) {
      return response(200, VALID_INIT_SEGMENT);
    }
    return response(200, url.endsWith('.m3u8?expires=1&sign=a') ? MEDIA_TEXT : 'segment');
  });
  for (const name of ['setAutoSyncProgressCfg', 'setAutoDiscardFrameCfg', 'pause']) {
    controller.windowObject.player[name] = async () => {
      throw new BufferScriptError('PLAYER_UNAVAILABLE', 'window.player 尚未可用');
    };
  }
  controller.logger = { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) };

  await controller.start();

  assert.equal(controller.started, true);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some(([message]) => message.includes('setAutoSyncProgressCfg')));
  assert.ok(warnings.some(([message]) => message.includes('setAutoDiscardFrameCfg')));
  assert.ok(warnings.some(([message]) => message.includes('pause')));
  controller.destroy();
});

test('live startup reports each bounded controller stage through the status surface', async () => {
  const { controller, stages } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(createPayload()));
    }
    if (new URL(url).pathname.endsWith('init.mp4')) {
      return response(200, VALID_INIT_SEGMENT);
    }
    return response(200, MEDIA_TEXT);
  });

  await controller.start();

  for (const stage of ['配置播放器', '播放信息', 'manifest', 'MSE', 'init', '库存形成']) {
    assert.ok(stages.includes(stage), `missing live startup stage ${stage}`);
  }
  controller.destroy();
});

test('initial all-CDN manifest 404 enters GAP with actions and manual return reports recovery stages', async () => {
  let manifestAvailable = false;
  const { controller, actions, stages } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(createPayload()));
    }
    if (url.endsWith('.m3u8?expires=1&sign=a') || url.endsWith('.m3u8?expires=1&sign=b')) {
      return manifestAvailable ? response(200, MEDIA_TEXT) : response(404, 'missing');
    }
    return response(200, new URL(url).pathname.endsWith('init.mp4') ? VALID_INIT_SEGMENT : 'segment');
  });

  await controller.start();

  assert.equal(controller.started, true);
  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.equal(actions.get('skip-gap'), true);
  assert.equal(actions.get('return-live'), true);
  assert.equal(controller.track.qualityNumber, 250);
  manifestAvailable = true;
  await controller.manualReturnLive();
  assert.equal(controller.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(controller.stage, '库存形成');
  for (const stage of ['播放信息', 'manifest', 'MSE', 'init', '库存形成']) {
    assert.ok(stages.includes(stage), `missing live recovery stage ${stage}`);
  }
  assert.match(controller.pipeline.objectUrl, /^blob:startup-/);
  controller.destroy();
});

test('initial init append failure enters GAP with actions and manual return can rebuild', async () => {
  const appendState = { failAppend: true };
  const { controller, actions } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(createPayload()));
    }
    if (url.endsWith('.m3u8?expires=1&sign=a') || url.endsWith('.m3u8?expires=1&sign=b')) {
      return response(200, MEDIA_TEXT);
    }
    return response(200, new URL(url).pathname.endsWith('init.mp4') ? VALID_INIT_SEGMENT : 'segment');
  }, appendState);

  await controller.start();

  assert.equal(controller.started, true);
  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.equal(actions.get('skip-gap'), true);
  assert.equal(actions.get('return-live'), true);
  assert.equal(controller.track.qualityNumber, 250);
  appendState.failAppend = false;
  await controller.manualReturnLive();
  assert.equal(controller.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(controller.stage, '库存形成');
  assert.match(controller.pipeline.objectUrl, /^blob:startup-/);
  controller.destroy();
});

test('an unsupported combined live audio/video MIME enters an explicit GAP', async () => {
  const { controller, actions } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(createPayload()));
    }
    if (new URL(url).pathname.endsWith('init.mp4')) {
      return response(200, VALID_INIT_SEGMENT);
    }
    return response(200, MEDIA_TEXT);
  });
  controller.pipeline.mediaSourceFactory = { isTypeSupported: () => false };

  await controller.start();

  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.match(controller.failureMessage, /^MSE_CODEC_UNSUPPORTED:/);
  assert.equal(actions.get('skip-gap'), true);
  assert.equal(actions.get('return-live'), true);
  controller.destroy();
});

test('a live API response without an audio codec enters an explicit GAP before MSE setup', async () => {
  const missingAudioPayload = createPayload();
  delete missingAudioPayload.data.playurl_info.playurl.stream[0].format[0].codec[0].audio_codecs;
  let payload = missingAudioPayload;
  const { controller, actions } = createStartupController(async (url) => {
    if (url.includes('getRoomPlayInfo')) {
      return response(200, JSON.stringify(payload));
    }
    if (new URL(url).pathname.endsWith('init.mp4')) {
      return response(200, VALID_INIT_SEGMENT);
    }
    return response(200, MEDIA_TEXT);
  });

  await controller.start();

  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.match(controller.failureMessage, /^LIVE_AUDIO_CODEC_MISSING:/);
  assert.equal(actions.get('skip-gap'), true);
  assert.equal(actions.get('return-live'), true);
  assert.equal(controller.track, undefined);
  payload = createPayload();
  await controller.manualReturnLive();
  assert.equal(controller.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(controller.track.qualityNumber, 250);
  assert.equal(controller.stage, '库存形成');
  controller.destroy();
});

test('user pause is distinct and no gap action is triggered without an explicit click', () => {
  const state = new LiveStateMachine();
  state.onUserPause();
  assert.equal(state.state, LIVE_STATE.USER_PAUSED);
  state.onStall();
  assert.equal(state.state, LIVE_STATE.USER_PAUSED);
  assert.throws(
    () => state.manualSkipGap(),
    (error) => error.code === 'STATE_MANUAL_ACTION_INVALID',
  );
  state.onGap('permanent 404');
  assert.equal(state.state, LIVE_STATE.GAP_UNRECOVERABLE);
  state.manualSkipGap();
  assert.equal(state.state, LIVE_STATE.RECOVERING);
  const second = new LiveStateMachine();
  second.onGap('permanent 404');
  second.manualReturnLive();
  assert.equal(second.state, LIVE_STATE.RECOVERING);
});

test('return-live is visible for delayed and user-paused states but skip-gap is not', () => {
  const delayed = new LiveStateMachine();
  delayed.onDelayChanged(4);
  delayed.manualReturnLive();
  assert.equal(delayed.state, LIVE_STATE.RECOVERING);

  const paused = new LiveStateMachine();
  paused.onUserPause();
  paused.manualReturnLive();
  assert.equal(paused.state, LIVE_STATE.RECOVERING);
  assert.throws(() => paused.manualSkipGap(), (error) => error.code === 'STATE_MANUAL_ACTION_INVALID');
});

test('repeated waiting or stalled events keep the live state in recovery', () => {
  const state = new LiveStateMachine();
  state.onStall();
  state.onRecovering();
  state.onStall();
  state.onRecovering();
  assert.equal(state.state, LIVE_STATE.RECOVERING);
});

test('live playback guard immediately restores 1x when installed on an accelerated video', () => {
  const video = createLiveVideo();
  video.playbackRate = 2;

  const guard = installLivePlaybackGuard(video, { logger: { warn() {} } });

  assert.equal(video.playbackRate, 1);
  guard.destroy();
});

test('waitForVideo aborts and tears down its pending document observer', async () => {
  const originalMutationObserver = globalThis.MutationObserver;
  let observer;
  globalThis.MutationObserver = class {
    constructor() {
      observer = this;
      this.disconnected = false;
    }

    observe() {}

    disconnect() {
      this.disconnected = true;
    }
  };
  try {
    const abort = new AbortController();
    const waiting = waitForVideo(
      {
        documentElement: {},
        querySelectorAll() {
          return [];
        },
      },
      10000,
      abort.signal,
    );
    abort.abort();
    await assert.rejects(waiting, (error) => error.code === 'VIDEO_WAIT_ABORTED');
    assert.equal(observer.disconnected, true);
  } finally {
    globalThis.MutationObserver = originalMutationObserver;
  }
});

test('DanmakuVisibilityController hides and restores initial and dynamic literal danmaku nodes', () => {
  let observer;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }

    observe() {}

    disconnect() {}
  }
  const supportsLiteralDanmaku = (selector) => selector.split(',').map((part) => part.trim()).includes('danmaku');
  const literalDanmaku = (display) => ({
    nodeType: 1,
    style: { display },
    matches(selector) {
      return supportsLiteralDanmaku(selector);
    },
    querySelectorAll() {
      return [];
    },
  });
  const initial = literalDanmaku('inline');
  const documentObject = {
    documentElement: {},
    defaultView: { MutationObserver: FakeMutationObserver },
    querySelectorAll(selector) {
      return supportsLiteralDanmaku(selector) ? [initial] : [];
    },
  };
  const controller = new DanmakuVisibilityController(documentObject);

  controller.setHidden(true);
  assert.equal(initial.style.display, 'none');
  const dynamic = literalDanmaku('block');
  observer.callback([{ addedNodes: [dynamic] }]);
  assert.equal(dynamic.style.display, 'none');

  controller.setHidden(false);
  assert.equal(initial.style.display, 'inline');
  assert.equal(dynamic.style.display, 'block');
  controller.destroy();
});

test('live controller retains script pause ownership until an asynchronous pause event', async () => {
  const waitingVideo = createLiveVideo({ asyncPause: true });
  const { controller: waitingController } = createLiveController({ video: waitingVideo });
  waitingController.installVideoGuards();
  waitingController.started = true;
  waitingController.onWaiting('waiting');
  assert.equal(waitingController.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(waitingVideo.pauseCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(waitingController.internalPause, false);
  assert.equal(waitingController.userPaused, false);

  const gapVideo = createLiveVideo({ asyncPause: true });
  const { controller: gapController } = createLiveController({ video: gapVideo });
  gapController.installVideoGuards();
  gapController.enterGap(new Error('forced gap'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gapController.internalPause, false);
  assert.equal(gapController.userPaused, false);
  assert.equal(gapController.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);

  const rebuildingVideo = createLiveVideo({ asyncPause: true });
  const { controller: rebuildingController } = createLiveController({ video: rebuildingVideo });
  rebuildingController.installVideoGuards();
  rebuildingController.rebuildingSource = true;
  rebuildingController.pauseForRecovery();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rebuildingController.internalPause, false);
  assert.equal(rebuildingController.userPaused, false);
});

test('live controller ignores waiting while its MSE source is starting or rebuilding', () => {
  const video = createLiveVideo();
  const { controller } = createLiveController({ video });
  controller.installVideoGuards();

  controller.onWaiting('waiting');
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(video.pauseCalls, 0);

  controller.started = true;
  controller.starting = true;
  controller.onWaiting('waiting');
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(video.pauseCalls, 0);

  controller.starting = false;
  controller.rebuildingSource = true;
  controller.onWaiting('stalled');
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(video.pauseCalls, 0);
});

test('live playback guard rejects a one-second forward seeking event but accepts clock and backward movement', () => {
  const video = createLiveVideo();
  const guard = installLivePlaybackGuard(video, { logger: { warn() {} } });
  video.currentTime = 1;
  video.dispatchEvent(new Event('seeking'));
  assert.equal(video.currentTime, 0);
  video.currentTime = 0.5;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(guard.approvedTime, 0.5);
  video.currentTime = 0.25;
  video.dispatchEvent(new Event('seeking'));
  assert.equal(guard.approvedTime, 0.25);
  guard.destroy();
});

test('a manifest GAP error enters GAP_UNRECOVERABLE instead of only warning', async () => {
  const initialManifest = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
10.m4s
`,
    MEDIA_URL,
  );
  const slidManifest = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:12
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
12.m4s
`,
    MEDIA_URL,
  );
  const { controller } = createLiveController();
  controller.started = true;
  controller.track = createTrack();
  controller.manifest = initialManifest;
  controller.manifestCandidates = controller.track.candidates;
  controller.liveEdge = initialManifest.segments[0];
  controller.queue.initialize(initialManifest, false);
  controller.queue.markDownloaded(10, new ArrayBuffer(1));
  controller.queue.acknowledgeDelivery(10);
  controller.loadMediaManifest = async () => ({ manifest: slidManifest, candidates: controller.track.candidates });

  await controller.refreshManifest();

  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.match(controller.failureMessage, /^GAP_MANIFEST_SLID_PAST_EXPECTED:/);
});

test('manifest media sequence rollback enters GAP with a frozen queue and both manual actions', async () => {
  const initialManifest = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
100.m4s
#EXTINF:1,
101.m4s
`,
    MEDIA_URL,
  );
  const rollbackManifest = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
0.m4s
#EXTINF:1,
1.m4s
`,
    MEDIA_URL,
  );
  const { controller } = createLiveController();
  const actions = new Map();
  controller.panel.setAction = (name, _label, _callback, visible) => actions.set(name, visible);
  controller.started = true;
  controller.track = createTrack();
  controller.manifest = initialManifest;
  controller.manifestCandidates = controller.track.candidates;
  controller.liveEdge = initialManifest.segments.at(-1);
  controller.queue.initialize(initialManifest, false);
  controller.queue.markDownloaded(100, new ArrayBuffer(1));
  controller.queue.acknowledgeDelivery(100);
  controller.loadMediaManifest = async () => ({ manifest: rollbackManifest, candidates: controller.track.candidates });

  await controller.refreshManifest();

  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.equal(controller.queue.isFrozen(), true);
  assert.match(controller.failureMessage, /^GAP_MANIFEST_SEQUENCE_ROLLBACK:/);
  assert.equal(actions.get('skip-gap'), true);
  assert.equal(actions.get('return-live'), true);
});

test('manifest variant loss enters GAP while a temporary refresh error keeps LIVE continuity', async () => {
  const variantActions = new Map();
  const variantController = createLiveController({
    fetchImpl: async () => response(200, '#EXTM3U\n#EXT-X-VERSION:7\n'),
  }).controller;
  variantController.panel.setAction = (name, _label, _callback, visible) => variantActions.set(name, visible);
  variantController.started = true;
  variantController.track = createTrack();
  variantController.liveEdge = { sn: 100, duration: 1 };

  await variantController.refreshManifest();

  assert.equal(variantController.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.match(variantController.failureMessage, /^MANIFEST_VARIANT_MISSING:/);
  assert.equal(variantActions.get('skip-gap'), true);
  assert.equal(variantActions.get('return-live'), true);

  const mapActions = new Map();
  const mapController = createLiveController().controller;
  mapController.panel.setAction = (name, _label, _callback, visible) => mapActions.set(name, visible);
  mapController.started = true;
  mapController.track = createTrack();
  mapController.liveEdge = { sn: 100, duration: 1 };
  mapController.loadMediaManifest = async () => {
    throw new BufferScriptError('MANIFEST_MAP_URI_MISSING', '刷新 fMP4 清单的 EXT-X-MAP 缺少 URI');
  };

  await mapController.refreshManifest();

  assert.equal(mapController.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.match(mapController.failureMessage, /^MANIFEST_MAP_URI_MISSING:/);
  assert.equal(mapActions.get('skip-gap'), true);
  assert.equal(mapActions.get('return-live'), true);

  let temporaryMessage = '';
  const temporaryController = createLiveController().controller;
  temporaryController.panel.setMessage = (message) => {
    temporaryMessage = message;
  };
  temporaryController.started = true;
  temporaryController.track = createTrack();
  temporaryController.liveEdge = { sn: 100, duration: 1 };
  temporaryController.loadMediaManifest = async () => {
    throw new BufferScriptError('MANIFEST_REFRESH_TEMPORARY', '清单服务器暂时不可用');
  };

  await temporaryController.refreshManifest();

  assert.equal(temporaryController.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(temporaryController.failureMessage, undefined);
  assert.match(temporaryMessage, /清单暂时不可用/);
});

test('automatic master recovery pins its logical variant and rejects replacement or direct fallback', async () => {
  const masterWithPinnedVariant = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4d401f, mp4a.40.2"
variant-a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000,CODECS="avc1.4d401f, mp4a.40.2"
variant-b.m3u8
`;
  const masterWithReplacement = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4d401f, mp4a.40.2"
variant-a.m3u8
`;
  let master = masterWithPinnedVariant;
  const { controller } = createLiveController({
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('index.m3u8')) {
        return response(200, master);
      }
      return response(200, MEDIA_TEXT);
    },
  });
  controller.track = createTrack();

  const initial = await controller.loadMediaManifest();
  controller.variantIdentity = initial.variantIdentity;
  assert.equal(initial.variantIdentity, '/live/variant-b.m3u8');

  master = masterWithReplacement;
  await assert.rejects(
    () => controller.loadMediaManifest(),
    (error) => error.code === 'GAP_MANIFEST_VARIANT_CHANGED',
  );
  master = MEDIA_TEXT;
  await assert.rejects(
    () => controller.loadMediaManifest(),
    (error) => error.code === 'GAP_MANIFEST_VARIANT_CHANGED',
  );
});

test('a stale master manifest load cannot fetch its variant through a replacement generation', async () => {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4d401f, mp4a.40.2"
variant.m3u8
`;
  let resolveMaster;
  const requests = [];
  const { controller } = createLiveController({
    fetchImpl(url) {
      requests.push(url);
      if (url.includes('index.m3u8')) {
        return new Promise((resolve) => {
          resolveMaster = resolve;
        });
      }
      throw new Error('a stale loader must not fetch the selected variant');
    },
  });
  controller.track = { ...createTrack(), candidates: [MEDIA_URL] };
  controller.segmentAbort = new AbortController();

  const loading = controller.loadMediaManifest();
  assert.equal(typeof resolveMaster, 'function');
  controller.generation += 1;
  controller.segmentAbort = new AbortController();
  resolveMaster(response(200, master));

  await assert.rejects(loading, (error) => error.code === 'LIVE_GENERATION_STALE');
  assert.equal(requests.length, 1);
});

test('all-CDN manifest refresh timeouts retain continuity until a later retry succeeds', async () => {
  const initialManifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  let requests = 0;
  const { controller } = createLiveController({
    fetchImpl: async () => {
      requests += 1;
      if (requests <= 2) {
        return new Promise(() => {});
      }
      return response(200, MEDIA_TEXT);
    },
  });
  controller.config = { ...LIVE_CONFIG, requestTimeoutMilliseconds: 10, retryBackoffMilliseconds: [0] };
  controller.started = true;
  controller.track = createTrack();
  controller.manifest = initialManifest;
  controller.manifestCandidates = controller.track.candidates;
  controller.liveEdge = initialManifest.segments.at(-1);
  controller.queue.initialize(initialManifest, false);
  controller.scheduleDownloads = () => {};
  controller.pumpDelivery = async () => {};

  await controller.refreshManifest();

  assert.ok(requests >= 4);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(controller.failureMessage, undefined);
  assert.equal(controller.queue.isFrozen(), false);
  assert.equal(controller.queue.lastMediaSequence, 100);
});

test('manifest refresh preserves signed init maps but freezes raw map or range changes', async () => {
  const initialManifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  const refreshedUrl = 'https://cdn-a.example/live/index.m3u8?expires=fresh&sign=fresh';
  const signedRefresh = parseHlsPlaylist(MEDIA_TEXT, refreshedUrl);
  const { controller: signedController } = createLiveController();
  signedController.manifest = initialManifest;
  signedController.queue.initialize(initialManifest, false);

  assert.notEqual(initialManifest.map.url, signedRefresh.map.url);
  assert.equal(initialManifest.map.uri, signedRefresh.map.uri);
  assert.doesNotThrow(() => {
    signedController.applyRefreshedManifest({ manifest: signedRefresh, candidates: createTrack().candidates });
  });

  const changedManifests = [
    parseHlsPlaylist(MEDIA_TEXT.replace('URI="init.mp4"', 'URI="replacement-init.mp4"'), refreshedUrl),
    parseHlsPlaylist(MEDIA_TEXT.replace('URI="init.mp4"', 'URI="init.mp4",BYTERANGE="100@0"'), refreshedUrl),
  ];
  for (const manifest of changedManifests) {
    const actions = new Map();
    const { controller } = createLiveController();
    controller.panel.setAction = (name, _label, _callback, visible) => actions.set(name, visible);
    controller.started = true;
    controller.track = createTrack();
    controller.manifest = initialManifest;
    controller.manifestCandidates = controller.track.candidates;
    controller.liveEdge = initialManifest.segments.at(-1);
    controller.queue.initialize(initialManifest, false);
    controller.scheduleDownloads = () => {};
    controller.pumpDelivery = async () => {};
    controller.loadMediaManifest = async () => ({ manifest, candidates: controller.track.candidates });

    await controller.refreshManifest();

    assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
    assert.match(controller.failureMessage, /^GAP_MANIFEST_INITIALIZATION_CHANGED:/);
    assert.equal(actions.get('skip-gap'), true);
    assert.equal(actions.get('return-live'), true);
  }

  const repeatedMap = MEDIA_TEXT.replace(
    '#EXTINF:2.0,\nseg-100.m4s',
    '#EXTINF:2.0,\nseg-100.m4s\n#EXT-X-MAP:URI="init.mp4"',
  );
  assert.equal(parseHlsPlaylist(repeatedMap, MEDIA_URL).map.uri, 'init.mp4');
  const changedMap = MEDIA_TEXT.replace(
    '#EXTINF:2.0,\nseg-100.m4s',
    '#EXTINF:2.0,\nseg-100.m4s\n#EXT-X-MAP:URI="replacement-init.mp4"',
  );
  assert.throws(
    () => parseHlsPlaylist(changedMap, MEDIA_URL),
    (error) => error instanceof BufferScriptError && error.code === 'GAP_MANIFEST_INITIALIZATION_CHANGED',
  );
});

test('manual return accepts a fresh same-room track after its stream session changes', async () => {
  const payload = createPayload('new-session');
  const requests = [];
  const { controller } = createLiveController({
    fetchImpl: async (url) => {
      requests.push(url);
      return response(200, JSON.stringify(payload));
    },
  });
  controller.track = createTrack('old-session');
  controller.stateMachine.onGap('stream session changed');
  controller.segmentAbort = new AbortController();
  controller.inFlight.set(120, controller.generation);
  const previousGeneration = controller.generation;
  const previousAbortSignal = controller.segmentAbort.signal;
  let restartedTrack;
  controller.restartAtCurrentEdge = async (track) => {
    restartedTrack = track;
  };

  await controller.manualReturnLive();

  assert.equal(controller.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(restartedTrack.session, 'new-session');
  assert.equal(controller.generation, previousGeneration + 1);
  assert.equal(previousAbortSignal.aborted, true);
  assert.equal(controller.inFlight.size, 0);
  assert.match(requests[0], /room_id=6363772/);
  assert.match(requests[0], /qn=250/);
});

test('live download scheduling stops at the existing 60-second MSE inventory cap', () => {
  const video = createLiveVideo({ forwardInventory: LIVE_CONFIG.aggressiveBufferSeconds });
  const { controller } = createLiveController({ video });
  const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  controller.started = true;
  controller.queue.initialize(manifest, false);
  let downloadCalls = 0;
  controller.downloadSegment = async () => {
    downloadCalls += 1;
  };

  controller.scheduleDownloads();

  assert.equal(downloadCalls, 0);
});

test('stale live delivery cannot acknowledge an old queue item after a manual generation change', async () => {
  const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  const { controller } = createLiveController();
  controller.started = true;
  controller.track = createTrack();
  controller.manifest = manifest;
  controller.manifestCandidates = controller.track.candidates;
  controller.queue.initialize(manifest, false);
  controller.queue.markDownloaded(100, new ArrayBuffer(1));
  controller.scheduleDownloads = () => {};
  let resolveOldAppend;
  controller.pipeline = {
    assertOwnsVideoSource() {},
    append() {
      return new Promise((resolve) => {
        resolveOldAppend = resolve;
      });
    },
    removeBefore() {},
    close() {},
  };

  const oldPump = controller.pumpDelivery();
  assert.equal(typeof resolveOldAppend, 'function');
  controller.generation += 1;
  controller.queue.resetForManualJump(manifest);
  controller.pipeline = {
    assertOwnsVideoSource() {},
    append() {
      throw new Error('new generation must not append an old item');
    },
    removeBefore() {},
    close() {},
  };
  resolveOldAppend();
  await oldPump;

  assert.equal(controller.queue.expectedSn, 102);
  assert.equal(controller.queue.hasDownloaded(102), false);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  controller.destroy();
});

test('disabling during a live MSE rebuild clears the rebuild flag before a later re-enable', async () => {
  const { controller } = createLiveController();
  controller.started = false;
  controller.segmentAbort = new AbortController();
  controller.rebuildingSource = true;
  controller.rebuildingGeneration = controller.generation;

  await controller.toggle();
  assert.equal(controller.rebuildingSource, false);
  assert.equal(controller.rebuildingGeneration, undefined);
  await controller.toggle();
  assert.equal(controller.rebuildingSource, false);
  controller.destroy();
});

test('live panel disable leaves rate, seeks, recovery, and danmaku under user control until re-enable', async () => {
  const actions = new Map();
  const models = [];
  const danmakuChanges = [];
  const { controller, video } = createLiveController();
  controller.started = true;
  controller.track = createTrack();
  controller.liveEdge = { sn: 100, duration: 2 };
  controller.scheduleDownloads = () => {};
  controller.refreshManifest = async () => {};
  controller.danmaku = {
    setHidden(value) {
      danmakuChanges.push(value);
    },
    destroy() {},
  };
  controller.panel = {
    setModel(model) {
      models.push(model);
    },
    setAction(name, label, callback, visible) {
      actions.set(name, { label, callback, visible });
    },
    setMessage() {},
  };
  controller.installVideoGuards();
  controller.updateStatus();
  controller.danmaku.setHidden(true);

  actions.get('toggle').callback();
  assert.equal(controller.enabled, false);
  assert.equal(actions.get('toggle').label, '启用');
  assert.equal(danmakuChanges.at(-1), false);
  const modelsWhileDisabled = models.length;
  const pausesBeforeWaiting = video.pauseCalls;
  video.playbackRate = 2;
  video.dispatchEvent(new Event('ratechange'));
  video.currentTime = 10;
  video.dispatchEvent(new Event('seeking'));
  video.dispatchEvent(new Event('waiting'));
  assert.equal(video.playbackRate, 2);
  assert.equal(video.currentTime, 10);
  assert.equal(video.pauseCalls, pausesBeforeWaiting);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  assert.equal(models.length, modelsWhileDisabled);

  video.pause();
  assert.equal(controller.userPaused, true);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);
  actions.get('toggle').callback();
  assert.equal(controller.enabled, true);
  assert.equal(video.playbackRate, 1);
  assert.equal(controller.userPaused, true);
  assert.equal(controller.stateMachine.state, LIVE_STATE.USER_PAUSED);
  controller.destroy();
});

test('restartAtCurrentEdge closes its replacement pipeline when the generation becomes stale', async () => {
  let replacementMediaSource;
  let reportReplacementMediaSource;
  const replacementCreated = new Promise((resolve) => {
    reportReplacementMediaSource = resolve;
  });
  class PendingMediaSource extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      this.readyState = 'closed';
      replacementMediaSource = this;
    }

    addSourceBuffer() {
      return { mode: 'segments' };
    }

    endOfStream() {
      this.readyState = 'ended';
    }
  }
  const revokedUrls = [];
  const { controller } = createLiveController();
  const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  controller.track = createTrack();
  controller.loadMediaManifest = async () => ({ manifest, candidates: controller.track.candidates });
  controller.mediaSourceFactory = PendingMediaSource;
  controller.urlApi = {
    createObjectURL(mediaSource) {
      reportReplacementMediaSource(mediaSource);
      return 'blob:stale-replacement';
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };

  const restarting = controller.restartAtCurrentEdge(controller.track, controller.generation);
  await replacementCreated;
  controller.generation += 1;
  replacementMediaSource.readyState = 'open';
  replacementMediaSource.dispatchEvent(new Event('sourceopen'));

  await assert.rejects(restarting, (error) => error.code === 'LIVE_GENERATION_STALE');
  assert.deepEqual(revokedUrls, ['blob:stale-replacement']);
  controller.destroy();
});

test('buffer inventory uses the range containing currentTime and the smaller available track', () => {
  const video = [
    { start: 0, end: 4 },
    { start: 20, end: 120 },
  ];
  const audio = [
    { start: 0, end: 3 },
    { start: 20, end: 100 },
  ];
  assert.equal(computeForwardInventory(1, [video, audio]), 2);
  assert.equal(computeForwardInventory(21, [video, audio]), 79);
});

test('MSE pipeline accepts a cross-realm ArrayBuffer and detects source ownership loss', async () => {
  class FakeSourceBuffer extends EventTarget {
    constructor() {
      super();
      this.updating = false;
      this.mode = 'segments';
      this.values = [];
    }

    appendBuffer(bytes) {
      this.values.push(bytes.byteLength);
    }

    remove() {}
  }
  class FakeMediaSource extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      this.readyState = 'open';
    }

    addSourceBuffer() {
      this.sourceBuffer = new FakeSourceBuffer();
      return this.sourceBuffer;
    }

    endOfStream() {
      this.readyState = 'ended';
    }
  }
  let objectUrl = '';
  const urlApi = {
    createObjectURL() {
      objectUrl = 'blob:test';
      return objectUrl;
    },
    revokeObjectURL() {},
  };
  const video = { src: '', currentSrc: '' };
  Object.defineProperty(video, 'src', {
    configurable: true,
    get: () => video._src || '',
    set: (value) => {
      video._src = value;
      video.currentSrc = value;
    },
  });
  const pipeline = new MseAppendPipeline(video, FakeMediaSource, urlApi);
  await pipeline.open('video/mp4; codecs="avc1.4d401f"');
  await pipeline.append(vm.runInNewContext('new ArrayBuffer(3)'));
  assert.equal(video.src, objectUrl);
  video.src = 'https://page-took-the-source.example/live.m3u8';
  assert.throws(() => pipeline.assertOwnsVideoSource(), (error) => error.code === 'GAP_MEDIA_OWNERSHIP_LOST');
  pipeline.close();
});

test('live fMP4 init validation requires both video and audio track declarations', () => {
  assert.deepEqual(validateInitSegmentTracks(VALID_INIT_SEGMENT), { video: true, audio: true });
  const handlerBox = (handler) => {
    const payload = new Uint8Array(12);
    payload.set([...handler].map((character) => character.charCodeAt(0)), 8);
    return makeBox('hdlr', payload);
  };
  const videoOnly = new Uint8Array([
    ...makeBox('ftyp', new Uint8Array(4)),
    ...makeBox('moov', makeBox('trak', makeBox('mdia', handlerBox('vide')))),
  ]).buffer;
  const audioOnly = new Uint8Array([
    ...makeBox('ftyp', new Uint8Array(4)),
    ...makeBox('moov', makeBox('trak', makeBox('mdia', handlerBox('soun')))),
  ]).buffer;
  assert.throws(
    () => validateInitSegmentTracks(videoOnly),
    (error) => error.code === 'LIVE_AUDIO_TRACK_MISSING',
  );
  assert.throws(
    () => validateInitSegmentTracks(audioOnly),
    (error) => error.code === 'LIVE_VIDEO_TRACK_MISSING',
  );
  const orphanHandlers = new Uint8Array([
    ...makeBox('ftyp', new Uint8Array(4)),
    ...makeBox('moov', new Uint8Array([...handlerBox('vide'), ...handlerBox('soun')])),
  ]).buffer;
  assert.throws(
    () => validateInitSegmentTracks(orphanHandlers),
    (error) => error.code === 'LIVE_VIDEO_TRACK_MISSING',
  );
});

test('MSE sourceopen waits are bounded and report a product timeout', async () => {
  class ClosedMediaSource extends EventTarget {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      super();
      this.readyState = 'closed';
    }
  }
  const video = { src: '', currentSrc: '' };
  const pipeline = new MseAppendPipeline(
    video,
    ClosedMediaSource,
    { createObjectURL: () => 'blob:timeout', revokeObjectURL() {} },
    { setTimeout, clearTimeout },
    5,
  );
  await assert.rejects(
    pipeline.open('video/mp4; codecs="avc1.4d401f, mp4a.40.2"'),
    (error) => error.code === 'MSE_WAIT_TIMEOUT',
  );
  pipeline.close();
});

test('live zero-inventory watchdog is one absolute 45-second timer and cancels on inventory or generation change', () => {
  let nextTimer = 1;
  const timers = new Map();
  const cleared = [];
  const runtime = {
    MediaSource: globalThis.MediaSource,
    URL: globalThis.URL,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
  };
  const { controller } = createLiveController({ runtimeObject: runtime });
  controller.starting = true;
  controller.track = createTrack();
  controller.stage = 'init';
  controller.readInventory = () => 0;
  controller.startZeroInventoryWatchdog(0);
  assert.equal(timers.size, 1);
  const first = [...timers.entries()][0];
  assert.equal(first[1].milliseconds, LIVE_CONFIG.zeroInventoryWatchdogMilliseconds);
  controller.readInventory = () => 1;
  controller.refreshZeroInventoryWatchdog();
  assert.deepEqual(cleared, [first[0]]);
  assert.equal(controller.stateMachine.state, LIVE_STATE.LIVE);

  controller.starting = true;
  controller.readInventory = () => 0;
  controller.startZeroInventoryWatchdog(controller.generation);
  const stale = [...timers.entries()][0][1].callback;
  controller.beginNewGeneration();
  stale();
  assert.notEqual(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  assert.equal(timers.size, 0);
  controller.starting = false;
  controller.initialInventoryFormed = false;
  controller.stateMachine.onGap('terminal startup failure');
  controller.refreshZeroInventoryWatchdog();
  assert.equal(timers.size, 0);
  controller.destroy();
});

test('re-enabling an initial zero-inventory live generation installs a fresh watchdog', async () => {
  let nextTimer = 1;
  const timers = new Map();
  const runtime = {
    MediaSource: globalThis.MediaSource,
    URL: globalThis.URL,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const { controller } = createLiveController({ runtimeObject: runtime });
  controller.started = true;
  controller.track = createTrack();
  controller.segmentAbort = new AbortController();
  controller.readInventory = () => 0;
  controller.scheduleDownloads = () => {};
  controller.refreshManifest = async () => {};
  controller.startZeroInventoryWatchdog(controller.generation);
  const [initialTimerId] = timers.keys();

  await controller.toggle();
  assert.equal(timers.has(initialTimerId), false);
  assert.equal(controller.generation, 1);

  await controller.toggle();
  assert.equal(timers.size, 1);
  const [freshTimer] = timers.values();
  assert.equal(freshTimer.milliseconds, LIVE_CONFIG.zeroInventoryWatchdogMilliseconds);
  freshTimer.callback();
  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  controller.destroy();
});

test('re-enabling live clears a stale generation retry message', async () => {
  const models = [];
  const { controller } = createLiveController();
  controller.started = true;
  controller.track = createTrack();
  controller.readInventory = () => 1;
  controller.scheduleDownloads = () => {};
  controller.refreshManifest = async () => {};
  controller.panel.setModel = (model) => models.push(model);
  controller.retryMessage = '临时 segment 失败，重试第 1 轮：cdn-a.example';
  const staleGeneration = controller.generation;

  await controller.toggle();
  await controller.toggle();
  controller.reportRetry(staleGeneration, { kind: 'segment', attempt: 2, hosts: ['cdn-a.example'] });

  assert.equal(controller.retryMessage, '');
  assert.equal(models.at(-1).message, '');
  controller.destroy();
});

test('manual return starts a new zero-inventory watchdog before retrying play info', async () => {
  let nextTimer = 1;
  const timers = new Map();
  const runtime = {
    MediaSource: globalThis.MediaSource,
    URL: globalThis.URL,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const { controller } = createLiveController({ runtimeObject: runtime });
  controller.track = createTrack();
  controller.stateMachine.onGap('initial startup failed');
  controller.loadManualReturnTrack = async () => new Promise(() => {});

  void controller.manualReturnLive();
  await Promise.resolve();

  const [watchdog] = timers.values();
  assert.equal(watchdog.milliseconds, LIVE_CONFIG.zeroInventoryWatchdogMilliseconds);
  watchdog.callback();
  assert.equal(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  controller.destroy();
});

test('a stale manual return abort cannot freeze a newer live generation', async () => {
  const pendingReturns = [];
  const { controller } = createLiveController();
  controller.stateMachine.onGap('manual recovery fixture');
  controller.loadManualReturnTrack = async (generation) =>
    new Promise((resolve, reject) => {
      pendingReturns.push({ generation, resolve, reject });
    });

  controller.runAction(() => controller.manualReturnLive());
  controller.runAction(() => controller.manualReturnLive());
  assert.equal(pendingReturns.length, 2);
  assert.equal(controller.generation, 2);
  pendingReturns[0].reject(new BufferScriptError('REQUEST_ABORTED', 'first manual action was superseded'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.stateMachine.state, LIVE_STATE.RECOVERING);
  assert.equal(controller.failureMessage, undefined);
  controller.destroy();
});

test('a t=30 required response uses only the remaining time of one 45-second watchdog', async () => {
  const originalDateNow = Date.now;
  let nowMilliseconds = 0;
  let controller;
  Date.now = () => nowMilliseconds;
  try {
    let nextTimer = 1;
    const timers = new Map();
    let resolveSegment;
    let resolveAppend;
    let signalAppendStarted;
    const appendStarted = new Promise((resolve) => {
      signalAppendStarted = resolve;
    });
    const runtime = {
      MediaSource: globalThis.MediaSource,
      URL: globalThis.URL,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout(callback, milliseconds) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, { callback, milliseconds, dueAtMilliseconds: nowMilliseconds + milliseconds });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    };
    ({ controller } = createLiveController({
      runtimeObject: runtime,
      fetchImpl: async (url) => {
        if (new URL(url).pathname.endsWith('seg-102.m4s')) {
          return new Promise((resolve) => {
            resolveSegment = resolve;
          });
        }
        throw new Error(`unexpected request ${url}`);
      },
    }));
    const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
    let inventory = 0;
    controller.started = true;
    controller.starting = true;
    controller.track = createTrack();
    controller.manifestCandidates = controller.track.candidates;
    controller.segmentAbort = new AbortController();
    controller.queue.initialize(manifest, true);
    controller.readInventory = () => inventory;
    controller.scheduleDownloads = () => {};
    controller.pipeline.append = () =>
      new Promise((resolve) => {
        resolveAppend = () => {
          inventory = 2;
          resolve();
        };
        signalAppendStarted();
      });
    controller.startZeroInventoryWatchdog(controller.generation);
    const [watchdogId, watchdog] = timers.entries().next().value;
    assert.equal(watchdog.milliseconds, LIVE_CONFIG.zeroInventoryWatchdogMilliseconds);
    assert.equal(watchdog.dueAtMilliseconds, 45000);

    const downloading = controller.downloadSegment(controller.queue.getNextSegment(), controller.generation);
    await Promise.resolve();
    assert.equal(typeof resolveSegment, 'function');
    nowMilliseconds = 30000;
    resolveSegment(response(200, new Uint8Array([1, 2, 3])));
    await downloading;
    await appendStarted;
    assert.equal(timers.size, 1);
    assert.equal(timers.get(watchdogId).dueAtMilliseconds, 45000);

    nowMilliseconds = 44999;
    resolveAppend();
    for (let tick = 0; tick < 10 && timers.has(watchdogId); tick += 1) {
      await Promise.resolve();
    }
    assert.equal(inventory, 2);
    assert.equal(timers.has(watchdogId), false);
    nowMilliseconds = 45000;
    watchdog.callback();
    assert.notEqual(controller.stateMachine.state, LIVE_STATE.GAP_UNRECOVERABLE);
  } finally {
    controller?.destroy();
    Date.now = originalDateNow;
  }
});

test('zero inventory after init is displayed as STARTING until decodable inventory exists', () => {
  const models = [];
  const { controller } = createLiveController();
  controller.started = true;
  controller.track = createTrack();
  controller.panel.setModel = (model) => models.push(model);
  controller.readInventory = () => 0;

  controller.updateStatus();
  assert.equal(models.at(-1).state, 'STARTING');

  controller.readInventory = () => 1;
  controller.updateStatus();
  assert.equal(models.at(-1).state, LIVE_STATE.LIVE);

  controller.readInventory = () => 0;
  controller.updateStatus();
  assert.equal(models.at(-1).state, LIVE_STATE.RECOVERING);
  controller.destroy();
});

test('live delay remains unknown without an anchor and uses program-date-time when present', () => {
  const { controller, video } = createLiveController();
  controller.liveEdge = { sn: 100, duration: 2, programDateTime: 6000 };
  video.currentTime = 1;
  controller.timelineOriginMilliseconds = undefined;
  controller.readInventory = () => 0;
  assert.equal(controller.estimateDelay(), undefined);
  controller.timelineOriginMilliseconds = 1000;
  assert.equal(controller.estimateDelay(), 6);
  controller.destroy();
});

test('live metrics use completed request windows and show inventory-full instead of a fake realtime value', () => {
  const now = Date.now();
  const { controller } = createLiveController();
  controller.requestMetrics = [
    { kind: 'manifest', byteLength: 100000, mediaDuration: 999, completedAtMilliseconds: now - 100 },
    { kind: 'segment', byteLength: 1000, mediaDuration: 10, completedAtMilliseconds: now - 500 },
    { kind: 'segment', byteLength: 500, mediaDuration: 20, completedAtMilliseconds: now - 31000 },
  ];
  assert.equal(controller.liveMultiplier(60), '库存已满');
  assert.equal(controller.liveMultiplier(20), '30 秒 0.33× / 60 秒 0.50×');
  controller.destroy();
});

test('stale live retry callbacks cannot overwrite a new generation status message', () => {
  const messages = [];
  const { controller } = createLiveController();
  controller.panel.setMessage = (message) => messages.push(message);
  const staleGeneration = controller.generation;
  controller.reportRetry(staleGeneration, { kind: 'segment', attempt: 1, hosts: ['cdn-a.example'] });
  controller.beginNewGeneration();
  controller.reportRetry(staleGeneration, { kind: 'segment', attempt: 2, hosts: ['cdn-b.example'] });

  assert.deepEqual(messages, ['临时segment失败，重试第 1 轮：cdn-a.example']);
  controller.destroy();
});

test('ordered queue accepts a cross-realm ArrayBuffer from the sandbox fetch realm', () => {
  const queue = new OrderedSegmentQueue();
  const manifest = parseHlsPlaylist(MEDIA_TEXT, MEDIA_URL);
  queue.initialize(manifest, false);
  queue.markDownloaded(100, vm.runInNewContext('new ArrayBuffer(2)'));
  assert.equal(queue.acknowledgeDelivery(100).segment.sn, 100);
});

test('VOD policy applies each core once and degrades quota exactly 180 to 120 to 90', () => {
  const calls = [];
  const core = {
    setStableBufferTime(value) {
      calls.push(['stable', value]);
    },
    setScheduleWhilePaused(value) {
      calls.push(['paused', value]);
    },
  };
  const policy = new VodBufferPolicy(VOD_CONFIG);
  policy.apply(core);
  policy.apply(core);
  assert.deepEqual(calls, [
    ['stable', 180],
    ['paused', true],
  ]);
  assert.equal(policy.handleQuota(core).quotaFallback, 120);
  assert.equal(policy.handleQuota(core).quotaFallback, 90);
  assert.throws(
    () => policy.handleQuota(core),
    (error) => error.code === 'VOD_QUOTA_EXHAUSTED',
  );
  assert.deepEqual(calls, [
    ['stable', 180],
    ['paused', true],
    ['stable', 120],
    ['stable', 90],
  ]);
});

test('VOD quality chooses capability flags over proxy method existence and prefers core', async () => {
  const calls = [];
  const player = {
    requestQuality() {
      calls.push('player');
    },
    supports: () => true,
  };
  const core = {
    requestQuality() {
      calls.push('core');
      return Promise.resolve(true);
    },
    supports: (method) => method === 'requestQuality',
  };
  await callQualityMethod(player, core, 64);
  assert.deepEqual(calls, ['core']);

  const coreWithoutRequest = {
    requestQuality() {
      calls.push('hidden-core');
    },
    supports: () => false,
  };
  await callQualityMethod(player, coreWithoutRequest, 64);
  assert.deepEqual(calls, ['core', 'player']);
  await assert.rejects(
    callQualityMethod({ requestQuality() {}, supports: () => false }, coreWithoutRequest, 64),
    (error) => error.code === 'VOD_QUALITY_UNAVAILABLE',
  );
  await assert.rejects(
    callQualityMethod(player, core, 0),
    (error) => error.code === 'VOD_QUALITY_ARGUMENT_INVALID',
  );
});

test('VOD waits for a nonempty currentSrc or src before binding policy and requesting qn64', async () => {
  const calls = [];
  let qn = 32;
  let coreReads = 0;
  const core = {
    setStableBufferTime(value) {
      calls.push(['stable', value]);
    },
    setScheduleWhilePaused(value) {
      calls.push(['schedule', value]);
    },
    getQuality() {
      return { realQ: qn, accept_quality: [64, 32] };
    },
    async requestQuality(value) {
      calls.push(['quality', value]);
      qn = value;
    },
  };
  const video = {
    currentSrc: '',
    src: '',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new VodController({
    windowObject: {
      player: {
        __core() {
          coreReads += 1;
          return core;
        },
      },
      location: { href: 'https://www.bilibili.com/video/BVsource?p=1' },
      performance: { now: () => 0, getEntriesByType: () => [] },
    },
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  await controller.reconcile();
  assert.equal(coreReads, 0);
  assert.deepEqual(calls, []);
  assert.equal(controller.currentCore, undefined);

  video.src = 'blob:vod-source';
  await controller.reconcile();
  await controller.reconcile();
  assert.ok(coreReads > 0);
  assert.deepEqual(calls, [
    ['stable', 180],
    ['schedule', true],
    ['quality', 64],
  ]);
  assert.equal(controller.currentSrc, 'blob:vod-source');
});

test('VOD panel disable stops rate and quota policy and invalidates an in-flight qn64 observation', async () => {
  const actions = new Map();
  const videoListeners = new Map();
  const coreListeners = new Map();
  const calls = [];
  const models = [];
  let qn = 32;
  let resolveQuality;
  const core = {
    setStableBufferTime(value) {
      calls.push(['stable', value]);
    },
    setScheduleWhilePaused(value) {
      calls.push(['schedule', value]);
    },
    getQuality() {
      return { realQ: qn, accept_quality: [64, 32] };
    },
    requestQuality(value) {
      calls.push(['quality', value]);
      return new Promise((resolve) => {
        resolveQuality = () => {
          qn = value;
          resolve(true);
        };
      });
    },
    on(name, callback) {
      coreListeners.set(name, callback);
    },
    off(name, callback) {
      if (coreListeners.get(name) === callback) {
        coreListeners.delete(name);
      }
    },
  };
  const video = {
    currentSrc: 'blob:active-source',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    error: null,
    addEventListener(name, callback) {
      videoListeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (videoListeners.get(name) === callback) {
        videoListeners.delete(name);
      }
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
  };
  const controller = new VodController({
    windowObject: {
      player: { __core: () => core },
      location: { href: 'https://www.bilibili.com/video/BVdisable?p=1' },
      performance: { now: () => 0, getEntriesByType: () => [] },
    },
    documentObject: {},
    video,
    panel: {
      setModel(model) {
        models.push(model);
      },
      setAction(name, label, callback) {
        actions.set(name, { label, callback });
      },
    },
    logger: { warn() {}, error() {} },
  });
  controller.started = true;
  controller.installVideoGuards();
  controller.updateStatus();
  const reconciling = controller.reconcile();
  assert.equal(typeof resolveQuality, 'function');

  actions.get('toggle').callback();
  assert.equal(controller.enabled, false);
  assert.equal(actions.get('toggle').label, '启用');
  const modelsBeforeCompletion = models.length;
  video.playbackRate = 1;
  videoListeners.get('ratechange')();
  video.error = { name: 'QuotaExceededError', message: 'quota' };
  videoListeners.get('error')();
  coreListeners.get('error')({ name: 'QuotaExceededError', message: 'quota' });
  assert.deepEqual(calls, [
    ['stable', 180],
    ['schedule', true],
    ['quality', 64],
  ]);
  assert.equal(video.playbackRate, 1);

  resolveQuality();
  await reconciling;
  assert.equal(controller.qualityConfirmed, false);
  assert.equal(models.length, modelsBeforeCompletion);

  actions.get('toggle').callback();
  await controller.reconcile();
  assert.equal(controller.enabled, true);
  assert.equal(video.playbackRate, 2);
  assert.equal(controller.qualityStatus, '720P/qn64 已生效');
  controller.destroy();
});

test('VOD panel disable records a manual play as active intent without enforcing refill', () => {
  const actions = new Map();
  const listeners = new Map();
  const video = {
    currentTime: 0,
    duration: 600,
    paused: false,
    pauseCalls: 0,
    buffered: { length: 1, start: () => 0, end: () => 20 },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) {
        listeners.delete(name);
      }
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
      listeners.get('pause')();
    },
    play() {
      this.paused = false;
      listeners.get('play')();
      return Promise.resolve();
    },
  };
  const controller = new VodController({
    windowObject: {},
    documentObject: {},
    video,
    panel: {
      setModel() {},
      setAction(name, label, callback) {
        actions.set(name, { label, callback });
      },
    },
  });
  controller.started = true;
  controller.installVideoGuards();
  controller.updateStatus();

  actions.get('toggle').callback();
  assert.equal(controller.enabled, false);
  video.pause();
  assert.equal(controller.userPaused, true);
  video.play();
  assert.equal(controller.userPaused, false);
  assert.equal(controller.scriptPaused, false);
  assert.equal(controller.scriptPauseEvent, false);
  assert.equal(video.pauseCalls, 1);

  actions.get('toggle').callback();
  controller.enforceStartupAndRefill({});
  assert.equal(controller.enabled, true);
  assert.equal(video.pauseCalls, 1);
  assert.equal(controller.userPaused, false);
  controller.destroy();
});

test('VOD initial 0, 5, and 20 second inventories remain playing at 2x', () => {
  for (const inventory of [0, 5, 20]) {
    const listeners = new Map();
    const video = {
      currentTime: 0,
      duration: 600,
      paused: false,
      playbackRate: 1,
      pauseCalls: 0,
      buffered: { length: inventory > 0 ? 1 : 0, start: () => 0, end: () => inventory },
      addEventListener(name, callback) {
        listeners.set(name, callback);
      },
      removeEventListener() {},
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
        listeners.get('pause')?.();
      },
      play() {
        this.paused = false;
        listeners.get('play')?.();
        return Promise.resolve();
      },
    };
    const controller = new VodController({
      windowObject: {},
      documentObject: {},
      video,
      panel: { setModel() {}, setAction() {} },
    });
    controller.installVideoGuards();
    controller.setPlaybackRate();
    controller.enforceStartupAndRefill({});
    assert.equal(video.playbackRate, 2);
    assert.equal(video.pauseCalls, 0);
    assert.equal(video.paused, false);
    controller.destroy();
  }
});

test('VOD does not pause at 119 seconds after startup buffering completes', () => {
  const listeners = new Map();
  let bufferEnd = 120;
  let pauseCount = 0;
  const video = {
    currentTime: 0,
    duration: 600,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => bufferEnd },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener() {},
    pause() {
      pauseCount += 1;
      this.paused = true;
      listeners.get('pause')?.();
    },
  };
  const controller = new VodController({
    windowObject: {},
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
  });
  controller.installVideoGuards();
  controller.enforceStartupAndRefill({});
  assert.equal(controller.startupComplete, true);
  bufferEnd = 119;
  controller.enforceStartupAndRefill({});
  assert.equal(pauseCount, 0);
  assert.equal(video.paused, false);
});

test('VOD initial background fill never creates a script pause', async () => {
  const listeners = new Map();
  const video = {
    currentTime: 0,
    duration: 600,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 20 },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener() {},
    pause() {
      this.paused = true;
      queueMicrotask(() => listeners.get('pause')?.());
    },
  };
  const controller = new VodController({
    windowObject: {},
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
  });
  controller.installVideoGuards();
  controller.enforceStartupAndRefill({});
  await Promise.resolve();
  assert.equal(controller.scriptPauseEvent, false);
  assert.equal(controller.scriptPaused, false);
  assert.equal(controller.userPaused, false);
  assert.equal(video.paused, false);
});

test('VOD split-track tails within one second never script-pause and still reach ended', () => {
  const listeners = new Map();
  const models = [];
  const video = {
    currentTime: 99.5,
    duration: 100,
    paused: false,
    playbackRate: 2,
    pauseCalls: 0,
    buffered: { length: 1, start: () => 99.5, end: () => 100 },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener() {},
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.(event);
      return true;
    },
  };
  const core = {
    getBufferedRanges() {
      return {
        video: { length: 1, start: () => 99.5, end: () => 100 },
        audio: { length: 1, start: () => 99.5, end: () => 99.75 },
      };
    },
  };
  const controller = new VodController({
    windowObject: { performance: { now: () => 0, getEntriesByType: () => [] } },
    documentObject: {},
    video,
    panel: { setModel: (model) => models.push(model), setAction() {} },
  });
  controller.started = true;
  controller.startupComplete = true;
  controller.currentCore = core;
  controller.installVideoGuards();
  controller.enforceStartupAndRefill(core);
  assert.equal(video.pauseCalls, 0);
  video.dispatchEvent(new Event('ended'));
  assert.equal(models.at(-1).state, 'ENDED');
  controller.destroy();
});

test('VOD resumes a pre-tail script refill when the audio tail is up to one second shorter', async () => {
  for (const audioTailDifference of [0.05, 0.5, 1]) {
    const listeners = new Map();
    let videoEnd = 597.9;
    let audioEnd = 597.9;
    const video = {
      currentTime: 568.9,
      duration: 600,
      paused: false,
      playbackRate: 2,
      pauseCalls: 0,
      playCalls: 0,
      buffered: { length: 1, start: () => 568.9, end: () => videoEnd },
      addEventListener(name, callback) {
        listeners.set(name, callback);
      },
      removeEventListener() {},
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
        listeners.get('pause')?.();
      },
      play() {
        this.playCalls += 1;
        this.paused = false;
        listeners.get('play')?.();
        return Promise.resolve();
      },
      dispatchEvent(event) {
        listeners.get(event.type)?.(event);
        return true;
      },
    };
    const core = {
      getBufferedRanges() {
        return {
          video: { length: 1, start: () => 568.9, end: () => videoEnd },
          audio: { length: 1, start: () => 568.9, end: () => audioEnd },
        };
      },
    };
    const controller = new VodController({
      windowObject: { performance: { now: () => 0, getEntriesByType: () => [] } },
      documentObject: {},
      video,
      panel: { setModel() {}, setAction() {} },
    });
    controller.started = true;
    controller.startupComplete = true;
    controller.currentCore = core;
    controller.installVideoGuards();

    controller.enforceStartupAndRefill(core);
    assert.equal(video.pauseCalls, 1, `split ${audioTailDifference} must enter the only permitted mid-video refill`);
    assert.equal(controller.scriptPaused, true);

    videoEnd = 600;
    audioEnd = 600 - audioTailDifference;
    controller.enforceStartupAndRefill(core);
    await Promise.resolve();
    assert.equal(video.playCalls, 1, `split ${audioTailDifference} must satisfy the bounded refill target`);
    assert.equal(controller.scriptPaused, false);

    controller.scriptPaused = true;
    video.currentTime = 570.1;
    video.paused = true;
    controller.enforceStartupAndRefill(core);
    await Promise.resolve();
    assert.equal(video.pauseCalls, 1, 'the final 30 seconds must never add another script pause');
    assert.equal(video.paused, false, 'a script pause crossing the tail must resume naturally');
    video.dispatchEvent(new Event('ended'));
    assert.equal(controller.ended, true);
    controller.destroy();
  }
});

test('VOD does not re-pause an early user play while initial inventory is low', () => {
  const listeners = new Map();
  const video = {
    currentTime: 0,
    duration: 600,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 20 },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener() {},
    pause() {
      this.paused = true;
      listeners.get('pause')?.();
    },
    play() {
      this.paused = false;
      listeners.get('play')?.();
      return Promise.resolve();
    },
  };
  const controller = new VodController({
    windowObject: {},
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
  });
  controller.installVideoGuards();
  controller.enforceStartupAndRefill({});
  assert.equal(controller.scriptPaused, false);
  controller.currentCore = {};
  video.play();
  assert.equal(video.paused, false);
  assert.equal(controller.scriptPaused, false);
  assert.equal(controller.userPaused, false);
});

test('VOD reports known non-64 quality when the official request is rejected', async () => {
  const warnings = [];
  const core = { getCurrentQn: () => 80 };
  core.requestQuality = async () => false;
  const controller = new VodController({
    windowObject: { player: {} },
    documentObject: {},
    video: { addEventListener() {} },
    panel: { setModel() {}, setAction() {} },
    logger: {
      warn(...args) {
        warnings.push(args);
      },
      error() {},
    },
  });
  await controller.requestQuality(core);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，保持原画质 qn80/);
  assert.equal(warnings.length, 1);
});

test('VOD reports a failed original-quality restore with the actual current qn', async () => {
  let qn = 32;
  const calls = [];
  const core = {
    getQuality: () => ({ nowQ: qn, accept_quality: [64, 32, 16] }),
    async requestQuality(requested) {
      calls.push(requested);
      if (requested === 64) {
        qn = 16;
      }
      return false;
    },
  };
  const controller = new VodController({
    windowObject: { player: {} },
    documentObject: {},
    video: { addEventListener() {} },
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  await controller.requestQuality(core);

  assert.deepEqual(calls, [64, 32]);
  assert.equal(qn, 16);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，恢复原画质失败，当前实际画质 qn16/);
});

test('VOD parses object-shaped getQuality and confirms qn64 through requestQuality once', async () => {
  let qn = 32;
  let calls = 0;
  const core = {
    getQuality: () => ({ nowQ: qn, realQ: qn, accept_qn: [64, 32] }),
    requestQuality: async (requested) => {
      calls += 1;
      qn = requested;
    },
  };
  assert.deepEqual(readQualitySnapshot(core), {
    getter: 'getQuality',
    raw: { nowQ: 32, realQ: 32, accept_qn: [64, 32] },
    qn: 32,
    availableQns: [64, 32],
  });
  const controller = new VodController({
    windowObject: { player: {} },
    documentObject: {},
    video: { addEventListener() {} },
    panel: { setModel() {}, setAction() {} },
  });
  await controller.requestQuality(core);
  await controller.requestQuality(core);
  assert.equal(calls, 1);
  assert.equal(controller.qualityStatus, '720P/qn64 已生效');
});

test('VOD uses the public supported-quality list with the current scalar getQuality shape', async () => {
  let qn = 80;
  const calls = [];
  const core = {
    getQuality() {
      return {
        oldA: 30280,
        nowA: 30280,
        newA: 30280,
        oldQ: 80,
        nowQ: qn,
        newQ: qn,
        realQ: qn,
        oldRQ: 80,
      };
    },
    getSupportedQualityList() {
      return [80, 64, 32, 16];
    },
    requestQuality(requested) {
      calls.push(requested);
      qn = requested;
    },
  };
  const snapshot = readQualitySnapshot(core);
  assert.equal(snapshot.qn, 80);
  assert.deepEqual(snapshot.availableQns, [80, 64, 32, 16]);
  const controller = new VodController({
    windowObject: { player: {}, location: { href: 'https://www.bilibili.com/video/BVtest' } },
    documentObject: {},
    video: { currentSrc: 'source-1', addEventListener() {} },
    panel: { setModel() {}, setAction() {} },
  });

  await controller.requestQuality(core);

  assert.deepEqual(calls, [64]);
  assert.equal(qn, 64);
  assert.equal(controller.qualityStatus, '720P/qn64 已生效');
});

test('VOD re-requests qn64 after same-session drift, reports failed drift truthfully, and preserves quota 90', async () => {
  let qn = 32;
  let rejectRequests = false;
  const calls = [];
  const core = {
    setStableBufferTime() {},
    setScheduleWhilePaused() {},
    getQuality() {
      return { nowQ: qn, realQ: qn, accept_qn: [64, 32] };
    },
    requestQuality(requested) {
      calls.push(requested);
      if (rejectRequests) {
        return false;
      }
      qn = requested;
      return undefined;
    },
  };
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVdrift?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  await controller.reconcile();
  assert.deepEqual(calls, [64]);
  assert.equal(qn, 64);
  controller.bufferPolicy.handleQuota(core);
  controller.bufferPolicy.handleQuota(core);
  assert.equal(controller.bufferPolicy.targetSeconds, 90);

  qn = 32;
  await controller.reconcile();
  assert.deepEqual(calls, [64, 64]);
  assert.equal(qn, 64);
  assert.equal(controller.qualityStatus, '720P/qn64 已生效');
  assert.equal(controller.bufferPolicy.targetSeconds, 90);

  qn = 32;
  rejectRequests = true;
  await controller.reconcile();
  assert.deepEqual(calls, [64, 64, 64]);
  assert.equal(qn, 32);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，保持原画质 qn32/);
  await controller.reconcile();
  await controller.reconcile();
  assert.deepEqual(calls, [64, 64, 64]);
  assert.equal(controller.bufferPolicy.targetSeconds, 90);
});

test('VOD recognizes official getQuality availability fields', () => {
  const snapshot = readQualitySnapshot({
    getQuality: () => ({ oldA: [32], nowA: [64, 32], newA: [80], oldQ: 32, nowQ: 32, newQ: 64, realQ: 32 }),
  });
  assert.equal(snapshot.qn, 32);
  assert.deepEqual(snapshot.availableQns, [32, 64, 80]);
});

test('VOD re-requests from actual realQ drift even when nowQ remains 64', async () => {
  let realQ = 64;
  let rejectRequests = false;
  const calls = [];
  const core = {
    setStableBufferTime() {},
    setScheduleWhilePaused() {},
    getQuality() {
      return { nowQ: 64, realQ, accept_qn: [64, 32] };
    },
    requestQuality(requested) {
      calls.push(requested);
      return rejectRequests ? false : undefined;
    },
  };
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVrealq?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  await controller.reconcile();
  assert.equal(controller.qualityStatus, '720P/qn64 已生效');
  assert.deepEqual(calls, []);

  realQ = 32;
  rejectRequests = true;
  assert.equal(readQualitySnapshot(core).qn, 32);
  await controller.reconcile();
  assert.deepEqual(calls, [64]);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，保持原画质 qn32/);
  await controller.reconcile();
  assert.deepEqual(calls, [64]);
});

test('VOD retries a newer same-session drift after an older qn64 request rejects', async () => {
  let qn = 32;
  let resolveFirstRequest;
  const calls = [];
  const core = {
    setStableBufferTime() {},
    setScheduleWhilePaused() {},
    getQuality() {
      return { nowQ: qn, realQ: qn, accept_qn: [64, 32, 16] };
    },
    requestQuality(requested) {
      calls.push([qn, requested]);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          resolveFirstRequest = () => resolve(false);
        });
      }
      return false;
    },
  };
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVpendingdrift?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  const firstReconcile = controller.reconcile();
  assert.equal(typeof resolveFirstRequest, 'function');
  qn = 16;
  const secondReconcile = controller.reconcile();
  resolveFirstRequest();
  await Promise.all([firstReconcile, secondReconcile]);

  assert.deepEqual(calls, [
    [32, 64],
    [16, 64],
  ]);
  assert.equal(qn, 16);
  assert.equal(controller.qualityConfirmed, false);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，保持原画质 qn16/);
  await controller.reconcile();
  await controller.reconcile();
  assert.deepEqual(calls, [
    [32, 64],
    [16, 64],
  ]);
});

test('VOD quality timeout keeps the original quality and never reports request-sent success', async () => {
  let calls = 0;
  let qn = 32;
  const core = {
    getQuality: () => ({ nowQ: qn, accept_quality: [64, 32] }),
    requestQuality: async () => {
      calls += 1;
    },
  };
  const controller = new VodController({
    windowObject: { player: {} },
    documentObject: {},
    video: { addEventListener() {} },
    panel: { setModel() {}, setAction() {} },
    config: { ...VOD_CONFIG, qualityConfirmTimeoutMilliseconds: 25, qualityConfirmPollMilliseconds: 5 },
    logger: { warn() {}, error() {} },
  });
  await controller.requestQuality(core);
  assert.equal(calls, 1);
  assert.equal(qn, 32);
  assert.match(controller.qualityStatus, /^720P\/qn64 未生效，保持原画质 qn32/);
  assert.doesNotMatch(controller.qualityStatus, /请求已发送/);
});

test('VOD handles quota emitted by the current core without reapplying 180 seconds', async () => {
  const calls = [];
  const listeners = new Map();
  const core = {
    setStableBufferTime(value) {
      calls.push(['stable', value]);
    },
    setScheduleWhilePaused(value) {
      calls.push(['paused', value]);
    },
    getCurrentQn() {
      return 64;
    },
    requestQuality() {},
    on(name, callback) {
      listeners.set(name, callback);
    },
    off(name, callback) {
      if (listeners.get(name) === callback) {
        listeners.delete(name);
      }
    },
  };
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new VodController({
    windowObject: {
      player: { __core: () => core },
      location: { href: 'https://www.bilibili.com/video/BVtest' },
    },
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });
  await controller.reconcile();
  const emitQuota = () => listeners.get('error')({ name: 'QuotaExceededError', message: 'quota' });
  emitQuota();
  emitQuota();
  emitQuota();
  assert.deepEqual(
    calls.filter(([name]) => name === 'stable'),
    [
      ['stable', 180],
      ['stable', 120],
      ['stable', 90],
    ],
  );
  assert.equal(controller.bufferPolicy.targetSeconds, 90);
  assert.match(controller.message, /VOD_QUOTA_EXHAUSTED/);
  controller.destroy();
  assert.equal(listeners.has('error'), false);
});

test('VOD retains a quota fallback when only quality changes on the same core and source', async () => {
  const stableCalls = [];
  let currentQuality = 64;
  let coreErrorListener;
  const core = {
    setStableBufferTime(value) {
      stableCalls.push(value);
    },
    setScheduleWhilePaused() {},
    getCurrentQn() {
      return currentQuality;
    },
    requestQuality() {
      currentQuality = 64;
    },
    on(name, callback) {
      assert.equal(name, 'error');
      coreErrorListener = callback;
    },
    off() {},
  };
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new VodController({
    windowObject: {
      player: { __core: () => core },
      location: { href: 'https://www.bilibili.com/video/BVtest' },
    },
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  await controller.reconcile();
  coreErrorListener({ name: 'QuotaExceededError', message: 'quota' });
  assert.equal(controller.bufferPolicy.targetSeconds, 120);
  assert.equal(controller.startupComplete, true);

  currentQuality = 80;
  await controller.reconcile();

  assert.deepEqual(stableCalls, [180, 120]);
  assert.equal(controller.bufferPolicy.targetSeconds, 120);
  assert.equal(controller.startupComplete, true);
  controller.destroy();
});

test('VOD bandwidth feedback excludes old-session resources and clears only its own recovered warning', () => {
  let entries = [
    { name: 'https://cdn.example/old.m4s', initiatorType: 'video', responseEnd: 119999, transferSize: 100000 },
    { name: 'https://cdn.example/current.m4s', initiatorType: 'video', responseEnd: 120000, transferSize: 1 },
  ];
  const models = [];
  const video = {
    currentTime: 0,
    buffered: { length: 1, start: () => 0, end: () => 120 },
  };
  const controller = new VodController({
    windowObject: {
      location: { href: 'https://www.bilibili.com/video/BVmetrics' },
      performance: {
        now: () => 120000,
        getEntriesByType: () => entries,
      },
    },
    documentObject: {},
    video,
    panel: { setModel: (model) => models.push(model), setAction() {} },
    logger: { warn() {}, error() {} },
  });
  controller.started = true;
  controller.currentCore = { getMediaInfo: () => ({ bitrate: 1000 }) };
  controller.mediaMetricsStartMilliseconds = 120000;
  controller.mediaMetricsBoundaryPending = false;

  controller.updateStatus();

  assert.equal(models.at(-1).message, '下载不足以覆盖当前 2× 消耗，有限缓冲最终会耗尽');
  entries = [
    entries[0],
    { name: 'https://cdn.example/current.m4s', initiatorType: 'video', responseEnd: 120000, transferSize: 15000 },
  ];
  controller.updateStatus();
  assert.equal(models.at(-1).message, '');
  controller.message = '保留的产品消息';
  controller.updateStatus();
  assert.equal(models.at(-1).message, '保留的产品消息');
});

test('VOD quota fallback survives same-BVID core/source rebuild and resets only on a new part', async () => {
  const stableCalls = [];
  const listeners = new Map();
  const makeCore = (name) => ({
    setStableBufferTime(value) {
      stableCalls.push([name, value]);
    },
    setScheduleWhilePaused() {},
    getCurrentQn() {
      return 64;
    },
    requestQuality() {},
    on(event, callback) {
      listeners.set(name, { event, callback });
    },
    off() {},
  });
  let core = makeCore('one');
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVsame?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });
  await controller.reconcile();
  listeners.get('one').callback({ name: 'QuotaExceededError', message: 'quota' });
  core = makeCore('two');
  video.currentSrc = 'source-2';
  await controller.reconcile();
  assert.equal(controller.bufferPolicy.targetSeconds, 120);
  assert.deepEqual(stableCalls, [['one', 180], ['one', 120], ['two', 120]]);

  core = makeCore('three');
  video.currentSrc = 'source-3';
  windowObject.location.href = 'https://www.bilibili.com/video/BVsame?p=2';
  await controller.reconcile();
  assert.equal(controller.bufferPolicy.targetSeconds, 180);
  assert.deepEqual(stableCalls, [['one', 180], ['one', 120], ['two', 120], ['three', 180]]);
  controller.destroy();
});

test('VOD controller reapplies policy and quality request after core and source rebuild', async () => {
  const listeners = new Map();
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    error: null,
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener() {},
    pause() {
      this.paused = true;
      listeners.get('pause')?.();
    },
    play() {
      this.paused = false;
      listeners.get('play')?.();
      return Promise.resolve();
    },
  };
  const calls = [];
  const makeCore = (name) => {
    let quality = 32;
    return {
      name,
      setStableBufferTime(value) {
        calls.push([name, 'stable', value]);
      },
      setScheduleWhilePaused(value) {
        calls.push([name, 'paused', value]);
      },
      getQuality() {
        return { nowQ: quality, accept_qn: [64, 32] };
      },
      requestQuality(requestedQuality) {
        quality = requestedQuality;
        calls.push([name, 'quality', requestedQuality]);
      },
      getMediaInfo() {
        return { bitrate: 1000 };
      },
    };
  };
  let core = makeCore('one');
  const windowObject = {
    player: {
      __core: () => core,
    },
    location: { href: 'https://www.bilibili.com/video/BVtest' },
    setInterval: () => 1,
    clearInterval() {},
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const panel = { setModel() {}, setAction() {} };
  const controller = new VodController({ windowObject, documentObject: {}, video, panel });
  await controller.reconcile();
  await controller.reconcile();
  core = makeCore('two');
  video.currentSrc = 'source-2';
  await controller.reconcile();
  assert.deepEqual(
    calls.filter((call) => call[1] === 'stable'),
    [
      ['one', 'stable', 180],
      ['two', 'stable', 180],
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[1] === 'quality'),
    [
      ['one', 'quality', 64],
      ['two', 'quality', 64],
    ],
  );
});

test('VOD sends a distinct qn64 request after an in-flight core and source rebuild', async () => {
  let resolveFirstRequest;
  const calls = [];
  const makeCore = (name, pending = false) => {
    let qn = 32;
    return {
      setStableBufferTime() {},
      setScheduleWhilePaused() {},
      getQuality() {
        return { nowQ: qn, accept_qn: [64, 32] };
      },
      requestQuality(requested) {
        calls.push([name, requested]);
        if (pending) {
          return new Promise((resolve) => {
            resolveFirstRequest = () => {
              qn = requested;
              resolve();
            };
          });
        }
        qn = requested;
        return undefined;
      },
    };
  };
  const firstCore = makeCore('first', true);
  const secondCore = makeCore('second');
  let core = firstCore;
  const video = {
    currentSrc: 'source-1',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVfirst?p=1' },
    performance: { now: () => 0, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  const firstReconcile = controller.reconcile();
  assert.equal(typeof resolveFirstRequest, 'function');
  core = secondCore;
  video.currentSrc = 'source-2';
  windowObject.location.href = 'https://www.bilibili.com/video/BVfirst?p=1';
  const secondReconcile = controller.reconcile();
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['first', 64],
    ['second', 64],
  ]);
  resolveFirstRequest();
  await Promise.all([firstReconcile, secondReconcile]);

  assert.deepEqual(calls, [
    ['first', 64],
    ['second', 64],
  ]);
  assert.equal(secondCore.getQuality().nowQ, 64);
  assert.equal(controller.qualitySettledCore, secondCore);
});

test('VOD ignores an old quality request after a new BVID session begins', async () => {
  let resolveOldRequest;
  let oldQualityReads = 0;
  let oldStableReads = 0;
  const calls = [];
  const makeCore = (name, { pending = false, stableBufferSeconds = 180 } = {}) => {
    let qn = 32;
    return {
      setStableBufferTime(value) {
        calls.push([name, 'stable', value]);
      },
      setScheduleWhilePaused(value) {
        calls.push([name, 'paused', value]);
      },
      getStableBufferTime() {
        if (name === 'old') {
          oldStableReads += 1;
        }
        return stableBufferSeconds;
      },
      getQuality() {
        if (name === 'old') {
          oldQualityReads += 1;
        }
        return { nowQ: qn, realQ: qn, accept_qn: [64, 32] };
      },
      requestQuality(requested) {
        calls.push([name, 'quality', requested]);
        if (pending) {
          return new Promise((resolve) => {
            resolveOldRequest = () => {
              qn = requested;
              resolve();
            };
          });
        }
        qn = requested;
        return undefined;
      },
    };
  };
  const oldCore = makeCore('old', { pending: true, stableBufferSeconds: 90 });
  const newCore = makeCore('new');
  let core = oldCore;
  const video = {
    currentSrc: 'source-old',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVold?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  const oldReconcile = controller.reconcile();
  assert.equal(typeof resolveOldRequest, 'function');
  core = newCore;
  video.currentSrc = 'source-new';
  windowObject.location.href = 'https://www.bilibili.com/video/BVnew?p=1';
  const newReconcile = controller.reconcile();
  resolveOldRequest();
  await Promise.all([oldReconcile, newReconcile]);

  assert.equal(controller.currentCore, newCore);
  assert.equal(controller.bufferPolicy.targetSeconds, 180);
  assert.equal(oldQualityReads, 2);
  assert.equal(oldStableReads, 0);
  assert.deepEqual(
    calls.filter(([name, kind]) => name === 'new' && kind === 'stable'),
    [['new', 'stable', 180]],
  );
});

test('VOD does not restore an old quality request into a changed source', async () => {
  let resolveOldRequest;
  let qn = 32;
  const calls = [];
  const video = {
    currentSrc: 'source-a',
    currentTime: 0,
    duration: 600,
    playbackRate: 1,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 200 },
    addEventListener() {},
    removeEventListener() {},
  };
  const core = {
    setStableBufferTime() {},
    setScheduleWhilePaused() {},
    getQuality() {
      return { nowQ: qn, realQ: qn, accept_qn: [64, 32] };
    },
    requestQuality(requested) {
      calls.push([video.currentSrc, requested]);
      if (requested === 64) {
        return new Promise((resolve) => {
          resolveOldRequest = () => {
            qn = 64;
            resolve(false);
          };
        });
      }
      qn = requested;
      return undefined;
    },
  };
  const windowObject = {
    player: { __core: () => core },
    location: { href: 'https://www.bilibili.com/video/BVsame?p=1' },
    performance: { now: () => 1000, getEntriesByType: () => [] },
  };
  const controller = new VodController({
    windowObject,
    documentObject: {},
    video,
    panel: { setModel() {}, setAction() {} },
    logger: { warn() {}, error() {} },
  });

  const reconcile = controller.reconcile();
  assert.equal(typeof resolveOldRequest, 'function');
  video.currentSrc = 'source-b';
  resolveOldRequest();
  await reconcile;

  assert.deepEqual(calls, [['source-a', 64]]);
  assert.equal(qn, 64);
});

test('pinned dependency contract stays exact', () => {
  assert.equal(HLS_DEPENDENCY.version, '1.5.17');
  assert.match(HLS_DEPENDENCY.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
});
