const CDN_RESULT_VALUES = Object.freeze([
  'fetched',
  'lost_race',
  'stalled',
  'aborted',
  'superseded',
  'network_error',
  'http_error',
  'invalid_response',
  'gave_up',
]);

function chunkGroupKey(data) {
  return JSON.stringify([new URL(data.source).pathname, data.chunkIndex, data.start]);
}

function finiteValue(value) {
  if (!Number.isFinite(value)) throw new Error(`CDN 事件 bytes 无效: ${value}`);
  return value;
}

function percentile(values, probability) {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

function mirrorStatsFor(mirrors, mirror) {
  let stats = mirrors.get(mirror);
  if (stats === undefined) {
    stats = {
      mirror,
      racesEntered: 0,
      wins: 0,
      ttfbValues: [],
      stalled: 0,
      bytesDelivered: 0,
    };
    mirrors.set(mirror, stats);
  }
  return stats;
}

function isPairedRace(legs) {
  return new Set(legs.map((leg) => leg.slot)).size >= 2;
}

export function aggregateCdnEvents(events) {
  const chunks = new Map();
  const mirrors = new Map();
  const byResult = Object.fromEntries(CDN_RESULT_VALUES.map((result) => [result, 0]));
  let fetchedBytes = 0;
  let wastedBytes = 0;
  for (const event of events) {
    if (event.code !== 'bank.fetch.chunk') continue;
    const data = event.data;
    const stats = mirrorStatsFor(mirrors, data.mirror);
    const bytes = finiteValue(data.bytes);
    if (Object.hasOwn(byResult, data.result)) byResult[data.result] += 1;
    if (data.result === 'fetched') {
      stats.bytesDelivered += bytes;
      fetchedBytes += bytes;
    }
    if (data.result === 'lost_race') wastedBytes += bytes;
    if (data.result === 'stalled') stats.stalled += 1;
    if (Number.isFinite(data.ttfbMs)) stats.ttfbValues.push(data.ttfbMs);
    const key = chunkGroupKey(data);
    const legs = chunks.get(key) || [];
    legs.push(data);
    chunks.set(key, legs);
  }

  let pairedChunks = 0;
  for (const legs of chunks.values()) {
    if (!isPairedRace(legs)) continue;
    pairedChunks += 1;
    for (const leg of legs) {
      const stats = mirrorStatsFor(mirrors, leg.mirror);
      stats.racesEntered += 1;
      if (leg.result === 'fetched') stats.wins += 1;
    }
  }

  const rows = [...mirrors.values()]
    .sort((left, right) => String(left.mirror).localeCompare(String(right.mirror)))
    .map((stats) => ({
      mirror: stats.mirror,
      racesEntered: stats.racesEntered,
      wins: stats.wins,
      winRate: stats.racesEntered === 0 ? 0 : stats.wins / stats.racesEntered,
      ttfbP50: percentile(stats.ttfbValues, 0.5),
      ttfbP90: percentile(stats.ttfbValues, 0.9),
      stalled: stats.stalled,
      bytesDelivered: stats.bytesDelivered,
    }));
  const totalChunks = chunks.size;
  return {
    totalChunks,
    pairedChunks,
    pairCoverage: totalChunks === 0 ? 0 : pairedChunks / totalChunks,
    fetchedBytes,
    wastedBytes,
    wastedByteRatio: fetchedBytes === 0 ? 0 : wastedBytes / fetchedBytes,
    byResult,
    rows,
  };
}

export { CDN_RESULT_VALUES };
