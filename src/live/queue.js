import { fail, requireValue } from '../errors.js';

function timelineIsContinuous(previous, next) {
  if (previous.discontinuity || next.discontinuity) {
    return false;
  }
  if (previous.programDateTime !== undefined && next.programDateTime !== undefined) {
    const expectedMilliseconds = previous.programDateTime + previous.duration * 1000;
    return Math.abs(expectedMilliseconds - next.programDateTime) <= 1500;
  }
  return true;
}

export class OrderedSegmentQueue {
  constructor() {
    this.expectedSn = undefined;
    this.segments = new Map();
    this.downloaded = new Map();
    this.frozenError = undefined;
    this.lastMediaSequence;
    this.lastDelivered;
  }

  initialize(manifest, startAtEdge = true) {
    if (this.expectedSn !== undefined) {
      fail('QUEUE_ALREADY_INITIALIZED', '直播片段队列只能初始化一次');
    }
    requireValue(manifest, 'QUEUE_MANIFEST_MISSING', '初始化队列缺少媒体清单');
    const first = requireValue(manifest.segments[0], 'QUEUE_MANIFEST_EMPTY', '初始化队列的清单没有片段');
    const edge = manifest.segments[manifest.segments.length - 1];
    this.expectedSn = (startAtEdge ? edge : first).sn;
    this.updateManifest(manifest);
  }

  updateManifest(manifest) {
    this.assertWritable();
    requireValue(manifest, 'QUEUE_MANIFEST_MISSING', '更新队列缺少媒体清单');
    const firstSn = manifest.segments[0].sn;
    const mediaSequence = requireValue(
      manifest.mediaSequence,
      'QUEUE_MEDIA_SEQUENCE_MISSING',
      '更新队列缺少 HLS mediaSequence',
    );
    if (this.lastMediaSequence !== undefined && mediaSequence < this.lastMediaSequence) {
      this.freeze(
        'GAP_MANIFEST_SEQUENCE_ROLLBACK',
        `HLS mediaSequence 从 ${this.lastMediaSequence} 回退到 ${mediaSequence}`,
      );
    }
    if (this.expectedSn !== undefined && firstSn > this.expectedSn) {
      this.freeze('GAP_MANIFEST_SLID_PAST_EXPECTED', `清单已滑过必需片段 ${this.expectedSn}，当前首序号为 ${firstSn}`);
    }
    this.lastMediaSequence = mediaSequence;
    for (const segment of manifest.segments) {
      const existing = this.segments.get(segment.sn);
      if (existing !== undefined) {
        if (
          existing.duration !== segment.duration ||
          existing.programDateTime !== segment.programDateTime ||
          existing.discontinuity !== segment.discontinuity
        ) {
          this.freeze('GAP_TIMELINE_CHANGED', `媒体序号 ${segment.sn} 的时间轴发生变化`);
        }
        continue;
      }
      this.segments.set(segment.sn, segment);
    }
  }

  getSegment(sn) {
    return this.segments.get(sn);
  }

  getNextSegment() {
    this.assertWritable();
    return requireValue(
      this.segments.get(this.expectedSn),
      'GAP_NOT_IN_MANIFEST',
      `清单尚未提供必需片段 ${this.expectedSn}`,
    );
  }

  markDownloaded(sn, bytes) {
    this.assertWritable();
    const segment = requireValue(this.segments.get(sn), 'QUEUE_UNKNOWN_SEQUENCE', `下载了清单未知的片段 ${sn}`);
    if (sn < this.expectedSn) {
      fail('QUEUE_LATE_SEQUENCE', `片段 ${sn} 已经晚于当前交付位置 ${this.expectedSn}`);
    }
    if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]') {
      fail('QUEUE_INVALID_BYTES', `片段 ${sn} 的下载结果不是 ArrayBuffer`);
    }
    this.downloaded.set(sn, { segment, bytes });
  }

  peekReady() {
    this.assertWritable();
    return this.downloaded.get(this.expectedSn);
  }

  hasDownloaded(sn) {
    return this.downloaded.has(sn);
  }

  acknowledgeDelivery(sn) {
    this.assertWritable();
    if (sn !== this.expectedSn) {
      fail('QUEUE_OUT_OF_ORDER_DELIVERY', `尝试交付 ${sn}，但预期序号为 ${this.expectedSn}`);
    }
    const item = requireValue(this.downloaded.get(sn), 'QUEUE_UNDOWNLOADED', `片段 ${sn} 尚未下载完成`);
    if (this.lastDelivered !== undefined && !timelineIsContinuous(this.lastDelivered, item.segment)) {
      this.freeze('GAP_TIMELINE_DISCONTINUOUS', `片段 ${sn} 与前一片段的时间轴不连续`);
    }
    this.downloaded.delete(sn);
    this.lastDelivered = item.segment;
    this.expectedSn += 1;
    for (const sequence of this.segments.keys()) {
      if (sequence < this.expectedSn) {
        this.segments.delete(sequence);
      }
    }
    return item;
  }

  contiguousDownloadedSeconds(limitSeconds = Number.POSITIVE_INFINITY) {
    this.assertWritable();
    let sequence = this.expectedSn;
    let seconds = 0;
    while (seconds < limitSeconds) {
      const item = this.downloaded.get(sequence);
      if (item === undefined) {
        break;
      }
      seconds += item.segment.duration;
      sequence += 1;
    }
    return seconds;
  }

  markPermanentFailure(sn, reason) {
    if (sn !== this.expectedSn) {
      fail('GAP_NON_EXPECTED_FAILURE', `非预期片段 ${sn} 失败: ${reason}`);
    }
    this.freeze('GAP_UNRECOVERABLE', `必需片段 ${sn} 无法恢复: ${reason}`);
  }

  freeze(code, message) {
    if (this.frozenError === undefined) {
      this.frozenError = { code, message };
    }
    fail(this.frozenError.code, this.frozenError.message);
  }

  isFrozen() {
    return this.frozenError !== undefined;
  }

  assertWritable() {
    if (this.frozenError !== undefined) {
      fail(this.frozenError.code, this.frozenError.message);
    }
  }

  resetForManualJump(manifest) {
    requireValue(manifest, 'QUEUE_MANIFEST_MISSING', '手动跳转缺少媒体清单');
    this.expectedSn = undefined;
    this.segments.clear();
    this.downloaded.clear();
    this.frozenError = undefined;
    this.lastMediaSequence = undefined;
    this.lastDelivered = undefined;
    this.initialize(manifest, true);
  }
}
