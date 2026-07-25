import { computeForwardInventory } from '../src/vod/buffer.js';

const EVENT_TYPES = new Set([
  'playing',
  'waiting',
  'stalled',
  'ratechange',
  'seeked',
  'error',
  'timeupdate',
  'progress',
]);

function assertRecord(record, index) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`stall probe record ${index} must be an object`);
  }
  if (!EVENT_TYPES.has(record.type)) throw new Error(`stall probe record ${index} has an invalid type`);
  if (!Number.isInteger(record.elapsedMs) || record.elapsedMs < 0) {
    throw new Error(`stall probe record ${index} has an invalid elapsedMs`);
  }
  if (!Number.isFinite(record.currentTime) || !Number.isInteger(record.readyState)
    || typeof record.paused !== 'boolean' || !Number.isFinite(record.playbackRate)
    || record.playbackRate <= 0 || !Array.isArray(record.bufferedRanges)) {
    throw new Error(`stall probe record ${index} violates the metric contract`);
  }
}

function nextPlayingElapsed(records, waitingIndex) {
  for (let index = waitingIndex + 1; index < records.length; index += 1) {
    if (records[index].type === 'playing') return records[index].elapsedMs;
  }
  return records.at(-1).elapsedMs;
}

function playbackDenominatorSeconds(records) {
  let denominator = 0;
  for (let index = 1; index < records.length; index += 1) {
    const elapsedSeconds = (records[index].elapsedMs - records[index - 1].elapsedMs) / 1000;
    denominator += elapsedSeconds * records[index - 1].playbackRate;
  }
  return denominator;
}

function mediaSecondsAdvanced(records) {
  let advanced = 0;
  for (let index = 1; index < records.length; index += 1) {
    advanced += Math.max(0, records[index].currentTime - records[index - 1].currentTime);
  }
  return advanced;
}

function forwardBufferSeconds(record) {
  return computeForwardInventory(record.currentTime, [record.bufferedRanges]);
}

export function computeStallScore(records, targetSeconds) {
  if (!Array.isArray(records) || records.length < 2) {
    throw new Error('stall score requires at least two probe records');
  }
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) {
    throw new Error('stall score targetSeconds must be non-negative');
  }
  records.forEach(assertRecord);
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].elapsedMs < records[index - 1].elapsedMs) {
      throw new Error('stall probe records must be ordered by elapsedMs');
    }
  }

  const waitingRecords = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.type === 'waiting');
  const stalledWallMs = waitingRecords.reduce(
    (sum, { record, index }) => sum + nextPlayingElapsed(records, index) - record.elapsedMs,
    0,
  );
  const samples = records.filter((record) => record.type === 'timeupdate');
  const heldSamples = samples.filter((record) => forwardBufferSeconds(record) >= targetSeconds).length;
  const denominatorSeconds = playbackDenominatorSeconds(records);
  if (denominatorSeconds <= 0) throw new Error('stall score wall-time denominator must be positive');

  return {
    waitingCount: waitingRecords.length,
    stalledWallMs,
    playbackEfficiency: mediaSecondsAdvanced(records) / denominatorSeconds,
    bufferTargetHeldPct: samples.length === 0 ? 0 : heldSamples / samples.length,
    reproduced: waitingRecords.length > 0,
  };
}

export function computePositionMetrics(records, mediaDuration, finalCurrentTime) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('position metrics require at least one probe record');
  }
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) {
    throw new Error('position metrics mediaDuration must be positive and finite');
  }
  records.forEach((record, index) => {
    if (record === null || typeof record !== 'object' || !Number.isFinite(record.currentTime)) {
      throw new Error(`stall probe record ${index} has an invalid currentTime`);
    }
  });

  const endCurrentTime = finalCurrentTime === undefined ? records.at(-1).currentTime : finalCurrentTime;
  if (!Number.isFinite(endCurrentTime)) {
    throw new Error('position metrics final currentTime must be finite');
  }
  const hasBackwardPosition = records.slice(1).some((record, index) =>
    record.currentTime < records[index].currentTime);
  const reachesDuration = endCurrentTime >= mediaDuration
    || records.some((record) => record.currentTime >= mediaDuration);
  const reachedEndOfMedia = hasBackwardPosition || reachesDuration;
  return {
    startCurrentTime: records[0].currentTime,
    endCurrentTime,
    mediaDuration,
    reachedEndOfMedia,
    valid: !reachedEndOfMedia,
  };
}

export function computeArmMetric(records, targetSeconds, mediaDuration, finalCurrentTime) {
  return {
    ...computeStallScore(records, targetSeconds),
    ...computePositionMetrics(records, mediaDuration, finalCurrentTime),
  };
}
