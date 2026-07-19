import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_MANIFEST, HLS_DEPENDENCY, LIVE_CONFIG, VOD_CONFIG } from '../src/constants.js';
import { createManifest } from '../src/extension/manifest-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
const bridge = await fs.readFile(path.join(extensionDirectory, 'main-bridge.js'), 'utf8');
const controller = await fs.readFile(path.join(extensionDirectory, 'controller.js'), 'utf8');
const popup = await fs.readFile(path.join(extensionDirectory, 'popup.js'), 'utf8');
const productSource = await readTree(path.join(root, 'src'));
const productOutput = `${bridge}\n${controller}\n${popup}`;

async function readTree(directory) {
  const names = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  let content = '';
  for (const entry of names) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      content += await readTree(entryPath);
    } else if (entry.name.endsWith('.js')) {
      content += await fs.readFile(entryPath, 'utf8');
    }
  }
  return content;
}

assert.deepEqual(manifest, createManifest());
assert.equal(packageMetadata.version, manifest.version);
assert.equal(packageMetadata.dependencies['hls.js'], HLS_DEPENDENCY.version);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '120');
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions, [...EXTENSION_MANIFEST.hostPermissions]);
assert.deepEqual(manifest.content_scripts, [
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
]);
assert.equal(manifest.background, undefined);
assert.equal(manifest.options_page, undefined);
assert.equal(manifest.action.default_popup, 'popup.html');
assert.deepEqual(
  (await fs.readdir(extensionDirectory)).sort(),
  ['controller.js', 'main-bridge.js', 'manifest.json', 'popup.css', 'popup.html', 'popup.js'],
);
assert.match(await fs.readFile(path.join(extensionDirectory, 'popup.html'), 'utf8'), /popup\.js/);
assert.match(await fs.readFile(path.join(extensionDirectory, 'popup.html'), 'utf8'), /popup\.css/);

const exactVersion = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'hls.js', 'package.json'), 'utf8')).version;
assert.equal(exactVersion, HLS_DEPENDENCY.version);
assert.match(controller, new RegExp(`hls\.js version .*${HLS_DEPENDENCY.version}`));
assert.match(controller, /getPinnedHls|isSupported/);

const forbidden = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bunsafeWindow\b/,
  /\bGM_getResourceText\b/,
  /\bGM_(?:setValue|getValue|deleteValue|listValues)\b/,
  /window\.Hls\b/,
  /document\.cookie\b/,
  /\b(?:localStorage|sessionStorage|indexedDB|caches|sendBeacon)\b/,
  /\b(?:requestQuality|setQuality|setQn|setVideoQuality)\b/,
  /(?:fetch|XMLHttpRequest|MediaSource|SourceBuffer)\.prototype/,
  /\*:\/\/\*\/\*/,
  /https?:\/\/[^\s"']+\.js(?:[?#]|$)/,
];
for (const pattern of forbidden) {
  assert.doesNotMatch(productSource, pattern, `source contains forbidden pattern ${pattern}`);
  assert.doesNotMatch(productOutput, pattern, `dist contains forbidden pattern ${pattern}`);
}
assert.match(controller, /credentials:\s*"omit"/);
assert.match(controller, /realQ/);
assert.match(controller, /GAP_MANIFEST_SEQUENCE_ROLLBACK/);
assert.match(controller, /quotaFallbackSeconds/);
assert.doesNotMatch(bridge, /chrome\./);
assert.doesNotMatch(bridge, /window\.Hls\b/);
assert.doesNotMatch(productSource, /data-bilibili-buffer-panel|attachShadow|shadowRoot/);
assert.doesNotMatch(controller, /data-bilibili-buffer-panel|attachShadow|shadowRoot/);
assert.doesNotMatch(productSource, /\.(?:muted|volume)\s*=/);
assert.doesNotMatch(controller, /\.(?:muted|volume)\s*=/);
assert.equal(LIVE_CONFIG.recoveryWatermarkSeconds, 15);
assert.equal(LIVE_CONFIG.aggressiveBufferSeconds, 60);
assert.equal(LIVE_CONFIG.hideDanmakuAfterSeconds, 3);
assert.equal(VOD_CONFIG.playbackRate, 2);
assert.equal(VOD_CONFIG.stableBufferSeconds, 180);
assert.equal(VOD_CONFIG.startupBufferSeconds, 120);
assert.equal(VOD_CONFIG.lowBufferSeconds, 30);
assert.deepEqual(VOD_CONFIG.quotaFallbackSeconds, [120, 90]);
assert.match(HLS_DEPENDENCY.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
console.log('extension build contract passed');
