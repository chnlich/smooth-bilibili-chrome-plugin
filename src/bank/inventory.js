import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';

// Five seconds is long enough to survive a delayed diagnostic batch and short enough to
// make a stopped download layer visible in the popup.
export const INVENTORY_HEARTBEAT_FLOOR_MS = 5000;

function nonnegativeIntegerOrUnknown(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : UNKNOWN_VALUE;
}

function stringOrUnknown(value) {
  return typeof value === 'string' && value.length > 0 ? value : UNKNOWN_VALUE;
}

function resourceKeyFromCacheKey(value) {
  const separator = value.lastIndexOf('#');
  if (separator <= 0) throw new Error(`库存 cacheKey 无效: ${value}`);
  return value.slice(0, separator);
}

function representationFor(addressBook, resourceKey) {
  const entry = addressBook.get(resourceKey);
  if (entry === undefined) return {};
  return entry.representation || {};
}

function labelFor(addressBook, resourceKey, representation) {
  const entry = addressBook.get(resourceKey);
  if (typeof entry?.label === 'string' && entry.label.length > 0) return entry.label;
  const parts = [];
  if (Number.isSafeInteger(representation.height) && representation.height > 0) {
    parts.push(`${representation.height}P`);
  }
  const frameRate = representation.frameRate ?? representation.frame_rate;
  if (frameRate !== undefined && frameRate !== null && String(frameRate).length > 0) {
    parts.push(`${frameRate}fps`);
  }
  if (typeof representation.codecs === 'string' && representation.codecs.length > 0) {
    parts.push(representation.codecs);
  }
  if (parts.length === 0 && Number.isSafeInteger(representation.bandwidth) && representation.bandwidth > 0) {
    parts.push(`${representation.bandwidth}bps`);
  }
  return parts.length === 0 ? UNKNOWN_VALUE : parts.join(' · ');
}

function resourceFrom({ resourceKey, stored, state, addressBook, recentResourceKeys }) {
  const representation = representationFor(addressBook, resourceKey);
  return {
    pathname: resourceKey,
    kind: typeof representation.mimeType === 'string' && representation.mimeType.startsWith('video/')
      ? 'video'
      : typeof representation.mimeType === 'string' && representation.mimeType.startsWith('audio/')
        ? 'audio'
        : UNKNOWN_VALUE,
    label: labelFor(addressBook, resourceKey, representation),
    height: nonnegativeIntegerOrUnknown(representation.height),
    codecs: stringOrUnknown(representation.codecs),
    bandwidth: nonnegativeIntegerOrUnknown(representation.bandwidth),
    storedBytes: stored.bytes,
    storedChunks: stored.chunks,
    totalSize: state === undefined ? UNKNOWN_VALUE : nonnegativeIntegerOrUnknown(state.totalSize),
    lastForegroundEnd: state === undefined
      ? UNKNOWN_VALUE
      : nonnegativeIntegerOrUnknown(state.lastForegroundEnd),
    outstanding: state?.outstanding === undefined ? 0 : state.outstanding.size,
    retrying: state?.chunkAttempts === undefined
      ? 0
      : [...state.chunkAttempts.values()].filter((attempts) => attempts > 0).length,
    active: recentResourceKeys.includes(resourceKey),
  };
}

function storedByResource(chunks) {
  const stored = new Map();
  for (const [cacheKey, record] of chunks) {
    if (!(record?.bytes instanceof ArrayBuffer)) {
      throw new Error(`库存分片缺少 ArrayBuffer: ${cacheKey}`);
    }
    const resourceKey = resourceKeyFromCacheKey(cacheKey);
    const current = stored.get(resourceKey) || { bytes: 0, chunks: 0 };
    current.bytes += record.bytes.byteLength;
    current.chunks += 1;
    stored.set(resourceKey, current);
  }
  return stored;
}

export function deriveBankInventory({
  chunks,
  resourceState,
  addressBook,
  recentResourceKeys,
  maxBankBytes,
  maxPrefetchConcurrency,
  queueLength,
  inflightCount,
  disabled,
  routeActive,
  isPairedAddressAvailable,
  sessionGeneration,
}) {
  const storedByKey = storedByResource(chunks);
  const resourceKeys = new Set([
    ...resourceState.keys(),
    ...storedByKey.keys(),
  ]);
  const sortedResourceKeys = [...resourceKeys].sort((left, right) => left.localeCompare(right));
  const resources = sortedResourceKeys.map((resourceKey) => resourceFrom({
    resourceKey,
    stored: storedByKey.get(resourceKey) || { bytes: 0, chunks: 0 },
    state: resourceState.get(resourceKey),
    addressBook,
    recentResourceKeys,
  }));
  const activeResourceKeys = recentResourceKeys.filter((resourceKey) => resourceKeys.has(resourceKey));
  const pairedAddressAvailable = activeResourceKeys.some((resourceKey) => {
    const state = resourceState.get(resourceKey);
    return state?.latestUrl !== undefined && isPairedAddressAvailable(state.latestUrl) === true;
  });
  return {
    sessionGeneration: nonnegativeIntegerOrUnknown(sessionGeneration),
    storedBytes: resources.reduce((total, resource) => total + resource.storedBytes, 0),
    storedChunks: resources.reduce((total, resource) => total + resource.storedChunks, 0),
    maxBankBytes: nonnegativeIntegerOrUnknown(maxBankBytes),
    queued: nonnegativeIntegerOrUnknown(queueLength),
    inflight: nonnegativeIntegerOrUnknown(inflightCount),
    prefetchConcurrency: nonnegativeIntegerOrUnknown(maxPrefetchConcurrency),
    disabled: disabled === true || disabled === false ? disabled : UNKNOWN_VALUE,
    routeActive: routeActive === true || routeActive === false ? routeActive : UNKNOWN_VALUE,
    pairedAddressAvailable,
    resources,
  };
}

export function sameInventoryPayload(left, right) {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
