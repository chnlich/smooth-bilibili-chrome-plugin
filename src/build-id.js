const BUILT_BUILD_ID = typeof __BILIBILI_BUILD_ID_LITERAL__ === 'string'
  ? __BILIBILI_BUILD_ID_LITERAL__
  : 'source-build';

export function readBuildId() {
  return BUILT_BUILD_ID;
}

export { BUILT_BUILD_ID };
