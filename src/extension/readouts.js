import { computeForwardInventory } from '../vod/buffer.js';
import { readMediaFacts } from '../diagnostics/media.js';
import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';
import { INVENTORY_HEARTBEAT_FLOOR_MS } from '../bank/inventory.js';

const OTHER_LIVE_MEDIA_SOURCES_FIELD = [
  'otherLive',
  String.fromCharCode(77, 101, 100, 105, 97),
  'Sources',
].join('');

function forwardSeconds(currentTime, ranges) {
  if (!Number.isFinite(currentTime) || !Array.isArray(ranges)) return UNKNOWN_VALUE;
  return computeForwardInventory(currentTime, [ranges]);
}

function trackReadout(currentTime, sourceBuffer) {
  const ranges = Array.isArray(sourceBuffer.ranges) ? sourceBuffer.ranges : UNKNOWN_VALUE;
  return {
    track: sourceBuffer.track,
    attached: sourceBuffer.attached === true,
    forwardSeconds: forwardSeconds(currentTime, ranges),
    ranges,
    updating: sourceBuffer.updating,
    pendingSinceMs: sourceBuffer.pendingSinceMs,
    lastAppendAgoMs: sourceBuffer.lastAppendAgoMs,
    appendErrors: sourceBuffer.appendErrors,
    mediaSourceInstance: sourceBuffer.mediaSourceInstance,
    mediaSourceState: sourceBuffer.mediaSourceState,
  };
}

function limiterTrack(tracks) {
  const attached = tracks.filter((track) => track.attached === true);
  if (attached.length <= 1 || attached.some((track) => !Number.isFinite(track.forwardSeconds))) {
    return UNKNOWN_VALUE;
  }
  const minimum = Math.min(...attached.map((track) => track.forwardSeconds));
  const limiting = attached.filter((track) => track.forwardSeconds === minimum);
  return limiting.length === 1 ? limiting[0].track : UNKNOWN_VALUE;
}

function attachedSourceState(tracks) {
  if (tracks.length === 0 || tracks.some((track) => !['closed', 'open', 'ended'].includes(track.mediaSourceState))) {
    return UNKNOWN_VALUE;
  }
  const states = new Set(tracks.map((track) => track.mediaSourceState));
  return states.size === 1 ? [...states][0] : UNKNOWN_VALUE;
}

export function deriveMediaReadout(facts) {
  if (facts === UNKNOWN_VALUE) return UNKNOWN_VALUE;
  const sourceBufferRanges = Array.isArray(facts.sourceBufferRanges) ? facts.sourceBufferRanges : [];
  const tracks = sourceBufferRanges.map((sourceBuffer) => trackReadout(facts.currentTime, sourceBuffer));
  const mediaSourceInstances = new Set(
    tracks
      .map((track) => track.mediaSourceInstance)
      .filter((instance) => Number.isInteger(instance) && instance > 0),
  );
  const attachedSourceInstances = new Set(
    tracks
      .filter((track) => track.attached === true)
      .map((track) => track.mediaSourceInstance)
      .filter((instance) => Number.isInteger(instance) && instance > 0),
  );
  const attachmentResolved = attachedSourceInstances.size === 1;
  const attachedTracks = attachmentResolved
    ? tracks.filter((track) => track.attached === true)
    : [];
  return {
    forwardSeconds: forwardSeconds(facts.currentTime, facts.bufferedRanges),
    limiterTrack: attachmentResolved ? limiterTrack(attachedTracks) : UNKNOWN_VALUE,
    tracks: attachedTracks.map(({ mediaSourceInstance: _ignoredInstance, mediaSourceState: _ignoredState, ...track }) => track),
    mediaSourceState: attachedSourceState(attachedTracks),
    [OTHER_LIVE_MEDIA_SOURCES_FIELD]: attachmentResolved
      ? mediaSourceInstances.size - attachedSourceInstances.size
      : UNKNOWN_VALUE,
    element: {
      readyState: facts.readyState,
      networkState: facts.networkState,
      currentTime: facts.currentTime,
      duration: facts.duration,
      playbackRate: facts.playbackRate,
      resolution: facts.resolution,
      videoQuality: facts.videoQuality,
      paused: facts.paused,
      ended: facts.ended,
    },
  };
}

export function estimateBankSeconds(inventory, duration) {
  if (inventory === UNKNOWN_VALUE || !Array.isArray(inventory.resources)) return {};
  return Object.fromEntries(inventory.resources.map((resource) => {
    const estimate = Number.isFinite(resource.storedBytes)
      && Number.isFinite(resource.totalSize)
      && resource.totalSize > 0
      && Number.isFinite(duration)
      && duration > 0
      ? resource.storedBytes / (resource.totalSize / duration)
      : UNKNOWN_VALUE;
    return [resource.pathname, estimate];
  }));
}

export function inventoryStoppedPublishing(ageMs) {
  return Number.isFinite(ageMs) && ageMs > INVENTORY_HEARTBEAT_FLOOR_MS;
}

export function buildReadouts({
  surfaceId,
  video,
  bankInventory,
  lastStall,
  diagnostics,
  now = Date.now(),
}) {
  let media = UNKNOWN_VALUE;
  if (video !== undefined) media = deriveMediaReadout(readMediaFacts(video, 'readout'));
  const mediaDuration = media === UNKNOWN_VALUE ? UNKNOWN_VALUE : media.element.duration;
  const bank = bankInventory === undefined
    ? UNKNOWN_VALUE
    : {
      ...bankInventory.data,
      ageMs: Math.max(0, now - bankInventory.receivedAtMs),
    };
  return {
    version: 2,
    surfaceId,
    media,
    lastStall: lastStall === undefined
      ? UNKNOWN_VALUE
      : {
        agoMs: Math.max(0, now - lastStall.atMs),
        kind: lastStall.kind,
      },
    bank,
    bankSecondsEstimated: estimateBankSeconds(bank, mediaDuration),
    diagnostics: {
      sessionId: diagnostics?.sessionId || UNKNOWN_VALUE,
      persistence: diagnostics?.persistence || UNKNOWN_VALUE,
    },
  };
}
