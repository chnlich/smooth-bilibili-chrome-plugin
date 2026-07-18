import { fail, requireValue } from '../errors.js';

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail('MANIFEST_INVALID_NUMBER', `清单字段 ${name} 不是有限数字: ${value}`);
  }
  return number;
}

export function parseAttributeList(input) {
  const result = {};
  let token = '';
  let quote = false;
  const tokens = [];
  for (const character of input) {
    if (character === '"') {
      quote = !quote;
      token += character;
    } else if (character === ',' && !quote) {
      tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (quote) {
    fail('MANIFEST_INVALID_ATTRIBUTES', '清单属性包含未闭合的引号');
  }
  tokens.push(token);
  for (const item of tokens) {
    const separator = item.indexOf('=');
    if (separator < 1) {
      fail('MANIFEST_INVALID_ATTRIBUTES', `清单属性缺少名称或等号: ${item}`);
    }
    const key = item.slice(0, separator).trim();
    const rawValue = item.slice(separator + 1).trim();
    result[key] =
      rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1).replaceAll('\\"', '"') : rawValue;
  }
  return result;
}

function parseByteRange(value) {
  const [lengthValue, offsetValue] = value.split('@');
  const length = parseNumber(lengthValue, 'BYTERANGE.length');
  const offset = offsetValue === undefined ? undefined : parseNumber(offsetValue, 'BYTERANGE.offset');
  return { length, offset };
}

export function sameInitializationMap(previous, next) {
  return (
    previous.uri === next.uri &&
    previous.byteRange?.length === next.byteRange?.length &&
    previous.byteRange?.offset === next.byteRange?.offset
  );
}

function resolveSignedUri(uri, baseUrl) {
  let resolved;
  try {
    resolved = new URL(uri, baseUrl);
    const signedBase = new URL(baseUrl);
    for (const [key, value] of signedBase.searchParams.entries()) {
      if (!resolved.searchParams.has(key)) {
        resolved.searchParams.append(key, value);
      }
    }
  } catch (error) {
    fail('MANIFEST_INVALID_URI', `无法解析清单 URI: ${uri}`, error);
  }
  return resolved.href;
}

function parseProgramDateTime(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail('MANIFEST_INVALID_TIME', `清单时间戳无效: ${value}`);
  }
  return milliseconds;
}

function parseMaster(lines, manifestUrl) {
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) {
      continue;
    }
    const attributes = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
    let uriIndex = index + 1;
    while (uriIndex < lines.length && lines[uriIndex].startsWith('#')) {
      uriIndex += 1;
    }
    if (uriIndex >= lines.length || lines[uriIndex].length === 0) {
      fail('MANIFEST_INVALID_MASTER', '主清单变体缺少 URI');
    }
    variants.push({
      attributes,
      url: resolveSignedUri(lines[uriIndex], manifestUrl),
    });
    index = uriIndex;
  }
  if (variants.length === 0) {
    fail('MANIFEST_VARIANT_MISSING', '主清单没有可用变体');
  }
  return { type: 'master', url: manifestUrl, variants };
}

function parseMedia(lines, manifestUrl) {
  let mediaSequence = 0;
  let targetDuration;
  let map;
  let endList = false;
  let pendingDuration;
  let pendingProgramDateTime;
  let pendingByteRange;
  let discontinuity = false;
  let hasMediaSequence = false;
  const segments = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseNumber(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 'MEDIA-SEQUENCE');
      if (!Number.isInteger(mediaSequence) || mediaSequence < 0) {
        fail('MANIFEST_INVALID_SEQUENCE', `媒体序号无效: ${mediaSequence}`);
      }
      hasMediaSequence = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseNumber(line.slice('#EXT-X-TARGETDURATION:'.length), 'TARGETDURATION');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      const uri = requireValue(attributes.URI, 'MANIFEST_MAP_URI_MISSING', 'fMP4 清单的 EXT-X-MAP 缺少 URI');
      const nextMap = {
        uri,
        url: resolveSignedUri(uri, manifestUrl),
        byteRange: attributes.BYTERANGE === undefined ? undefined : parseByteRange(attributes.BYTERANGE),
      };
      if (map !== undefined && !sameInitializationMap(map, nextMap)) {
        fail('GAP_MANIFEST_INITIALIZATION_CHANGED', 'fMP4 清单内初始化片段或字节范围发生变化');
      }
      map = nextMap;
    } else if (line.startsWith('#EXTINF:')) {
      const durationText = line.slice('#EXTINF:'.length).split(',')[0];
      pendingDuration = parseNumber(durationText, 'EXTINF');
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingProgramDateTime = parseProgramDateTime(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      if (pendingDuration === undefined) {
        fail('MANIFEST_SEGMENT_WITHOUT_DURATION', `媒体片段缺少 EXTINF: ${line}`);
      }
      const sn = mediaSequence + segments.length;
      segments.push({
        sn,
        duration: pendingDuration,
        url: resolveSignedUri(line, manifestUrl),
        programDateTime: pendingProgramDateTime,
        byteRange: pendingByteRange,
        discontinuity,
      });
      pendingDuration = undefined;
      pendingProgramDateTime = undefined;
      pendingByteRange = undefined;
      discontinuity = false;
    }
  }

  if (pendingDuration !== undefined) {
    fail('MANIFEST_MISSING_SEGMENT_URI', 'EXTINF 后没有媒体片段 URI');
  }
  if (segments.length === 0) {
    fail('MANIFEST_EMPTY', '媒体清单没有片段');
  }
  if (map === undefined) {
    fail('MANIFEST_FMP4_MAP_MISSING', 'fMP4 媒体清单缺少 EXT-X-MAP');
  }
  return {
    type: 'media',
    url: manifestUrl,
    mediaSequence,
    hasMediaSequence,
    targetDuration,
    map,
    endList,
    segments,
  };
}

export function parseHlsPlaylist(text, manifestUrl) {
  if (typeof text !== 'string' || !text.startsWith('#EXTM3U')) {
    fail('MANIFEST_HEADER_MISSING', '响应不是 HLS 清单');
  }
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines[0] !== '#EXTM3U') {
    fail('MANIFEST_HEADER_MISSING', 'HLS 清单头无效');
  }
  const hasMasterTag = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  const hasMediaTag = lines.some(
    (line) =>
      line.startsWith('#EXT-X-MEDIA-SEQUENCE:') ||
      line.startsWith('#EXT-X-TARGETDURATION:') ||
      line.startsWith('#EXT-X-MAP:') ||
      line.startsWith('#EXTINF:') ||
      line.startsWith('#EXT-X-PROGRAM-DATE-TIME:') ||
      line.startsWith('#EXT-X-BYTERANGE:') ||
      line === '#EXT-X-DISCONTINUITY' ||
      line === '#EXT-X-ENDLIST',
  );
  if (hasMasterTag || !hasMediaTag) {
    return parseMaster(lines, manifestUrl);
  }
  return parseMedia(lines, manifestUrl);
}

function applyAuthoritativeQuery(target, query) {
  const parameters = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  for (const [key, value] of parameters.entries()) {
    target.searchParams.set(key, value);
  }
}

export function buildCdnCandidates(track) {
  const baseUrl = requireValue(track.baseUrl, 'PLAYBACK_BASE_URL_MISSING', '播放轨道缺少 base_url');
  const urlInfo = requireValue(track.urlInfo, 'PLAYBACK_CDN_MISSING', '播放轨道缺少 url_info');
  if (!Array.isArray(urlInfo) || urlInfo.length === 0) {
    fail('PLAYBACK_CDN_MISSING', '播放轨道没有备用 CDN');
  }
  const candidates = [];
  for (const info of urlInfo) {
    const host = requireValue(info.host, 'PLAYBACK_CDN_HOST_MISSING', 'CDN 候选缺少 host');
    const baseOnHost = new URL(baseUrl, host);
    const candidate = new URL(`${baseOnHost.pathname}${baseOnHost.search}`, host);
    if (info.extra !== undefined) {
      applyAuthoritativeQuery(candidate, info.extra);
    }
    const href = candidate.href;
    if (!candidates.includes(href)) {
      candidates.push(href);
    }
  }
  if (candidates.length === 0) {
    fail('PLAYBACK_CDN_MISSING', '没有构造出 CDN URL');
  }
  return candidates;
}

export function buildSegmentCandidates(segmentUrl, manifestCandidates) {
  if (!Array.isArray(manifestCandidates) || manifestCandidates.length === 0) {
    fail('PLAYBACK_CDN_MISSING', '没有可用于构造片段 URL 的清单候选');
  }
  const segment = new URL(segmentUrl);
  return manifestCandidates.map((manifestUrl) => {
    const candidate = new URL(`${segment.pathname}${segment.search}`, manifestUrl);
    const signedManifest = new URL(manifestUrl);
    for (const [key, value] of signedManifest.searchParams.entries()) {
      candidate.searchParams.set(key, value);
    }
    return candidate.href;
  });
}

export function normalizeCodecList(codecString) {
  if (typeof codecString !== 'string') {
    return [];
  }
  return codecString
    .split(',')
    .map((codec) => codec.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

export function codecListsMatch(left, right) {
  const leftCodecs = normalizeCodecList(left);
  const rightCodecs = normalizeCodecList(right);
  return (
    leftCodecs.length > 0 &&
    leftCodecs.length === rightCodecs.length &&
    leftCodecs.every((codec, index) => codec === rightCodecs[index])
  );
}

export function selectMediaVariant(master, codecString) {
  const matching = master.variants.filter((variant) => {
    const codecs = variant.attributes.CODECS || '';
    return codecListsMatch(codecs, codecString);
  });
  if (matching.length === 0) {
    fail('MANIFEST_VARIANT_MISSING', `主清单没有匹配 codec 的变体: ${codecString}`);
  }
  return matching.sort((left, right) => {
    const leftBandwidth = Number(left.attributes.BANDWIDTH || 0);
    const rightBandwidth = Number(right.attributes.BANDWIDTH || 0);
    return rightBandwidth - leftBandwidth;
  })[0];
}
