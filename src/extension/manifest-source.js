import { EXTENSION_MANIFEST, VERSION } from '../constants.js';

export function createManifest() {
  return {
    manifest_version: EXTENSION_MANIFEST.manifestVersion,
    name: 'Bilibili 桌面网页抗卡',
    version: VERSION,
    description: '直播连续缓冲与视频原生缓存提示增强',
    minimum_chrome_version: EXTENSION_MANIFEST.minimumChromeVersion,
    permissions: ['storage'],
    host_permissions: [...EXTENSION_MANIFEST.hostPermissions],
    action: {
      default_title: 'Bilibili 抗卡设置',
      default_popup: 'popup.html',
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
