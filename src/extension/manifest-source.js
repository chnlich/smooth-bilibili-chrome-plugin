import { EXTENSION_MANIFEST, VERSION } from '../constants.js';

export function createManifest() {
  return {
    manifest_version: EXTENSION_MANIFEST.manifestVersion,
    name: 'Bilibili 桌面网页抗卡',
    version: VERSION,
    description: '直播原生播放延迟连续性与视频原生 120 秒缓存提示增强',
    minimum_chrome_version: EXTENSION_MANIFEST.minimumChromeVersion,
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [...EXTENSION_MANIFEST.hostPermissions],
    action: {
      default_title: 'Bilibili 抗卡设置',
      default_popup: 'popup.html',
    },
    background: {
      service_worker: 'worker.js',
    },
    content_scripts: [
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['main-bridge.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'MAIN',
      },
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['controller.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'ISOLATED',
      },
    ],
  };
}
