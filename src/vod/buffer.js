import { fail } from '../errors.js';

export function copyTimeRanges(timeRanges) {
  if (timeRanges === undefined || timeRanges === null) {
    fail('VOD_BUFFER_RANGES_MISSING', '播放器没有提供 buffered ranges');
  }
  const ranges = [];
  for (let index = 0; index < timeRanges.length; index += 1) {
    const start = timeRanges.start(index);
    const end = timeRanges.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      fail('VOD_BUFFER_RANGES_INVALID', `buffered range ${index} 无效`);
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function rangeContainingCurrentTime(ranges, currentTime) {
  const match = ranges.find((range) => range.start <= currentTime && currentTime <= range.end);
  return match === undefined ? 0 : Math.max(0, match.end - currentTime);
}

export function computeForwardInventory(currentTime, tracks) {
  if (!Number.isFinite(currentTime)) {
    fail('VOD_CURRENT_TIME_INVALID', `currentTime 无效: ${currentTime}`);
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    fail('VOD_TRACKS_MISSING', '没有可用于计算库存的音视频轨道');
  }
  const inventories = tracks.map((track) => rangeContainingCurrentTime(track, currentTime));
  return Math.min(...inventories);
}
