import Hls from 'hls.js';
import { HLS_DEPENDENCY } from '../constants.js';
import { fail, requireValue } from '../errors.js';

export function getPinnedHls() {
  const hls = requireValue(Hls, 'HLS_LOAD_FAILED', '构建包没有导出 hls.js');
  if (hls.version !== HLS_DEPENDENCY.version) {
    fail('HLS_VERSION_MISMATCH', `hls.js 资源版本为 ${hls.version}`);
  }
  return hls;
}
