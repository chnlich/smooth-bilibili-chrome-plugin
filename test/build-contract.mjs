import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_MANIFEST, LIVE_CONFIG, VOD_CONFIG } from '../src/constants.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { EVENT_CODES, MEDIA_EVENT_NAMES } from '../src/diagnostics/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));

async function readTree(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let content = '';
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) content += await readTree(entryPath);
    else if (entry.name.endsWith('.js')) content += await fs.readFile(entryPath, 'utf8');
  }
  return content;
}

async function readJavaScriptFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readJavaScriptFiles(entryPath, relativePath));
    } else if (entry.name.endsWith('.js')) {
      files.push({
        relativePath: relativePath.replaceAll(path.sep, '/'),
        content: await fs.readFile(entryPath, 'utf8'),
      });
    }
  }
  return files;
}

const source = await readTree(path.join(root, 'src'));
const sourceFiles = await readJavaScriptFiles(path.join(root, 'src'));
const controller = await fs.readFile(path.join(extensionDirectory, 'controller.js'), 'utf8');
const bridge = await fs.readFile(path.join(extensionDirectory, 'main-bridge.js'), 'utf8');
const popup = await fs.readFile(path.join(extensionDirectory, 'popup.js'), 'utf8');
const worker = await fs.readFile(path.join(extensionDirectory, 'worker.js'), 'utf8');
const logs = await fs.readFile(path.join(extensionDirectory, 'logs.js'), 'utf8');
const vodSource = await fs.readFile(path.join(root, 'src/vod/controller.js'), 'utf8');
const liveSource = await fs.readFile(path.join(root, 'src/live/observer.js'), 'utf8');
const manifestSource = createManifest();

assert.deepEqual(manifest, manifestSource);
assert.equal(packageMetadata.version, manifest.version);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '120');
assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage']);
assert.deepEqual(manifest.host_permissions, [...EXTENSION_MANIFEST.hostPermissions]);
assert.deepEqual(manifest.background, { service_worker: 'worker.js' });
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
assert.equal(manifest.permissions.includes('tabs'), false);
assert.equal(manifest.permissions.includes('downloads'), false);
assert.equal(manifest.action.default_popup, 'popup.html');
const buildIds = new Set(
  [controller, worker]
    .map((bundle) => bundle.match(/src-[a-f0-9]{24}/)?.[0])
    .filter((buildId) => buildId !== undefined),
);
assert.equal(buildIds.size, 1);
const [buildId] = buildIds;
assert.match(buildId, /^src-[a-f0-9]{24}$/);

const expectedFiles = [
  'controller.js',
  'controller.js.map',
  'logs.css',
  'logs.html',
  'logs.js',
  'logs.js.map',
  'main-bridge.js',
  'main-bridge.js.map',
  'manifest.json',
  'popup.css',
  'popup.html',
  'popup.js',
  'popup.js.map',
  'worker.js',
  'worker.js.map',
];
assert.deepEqual((await fs.readdir(extensionDirectory)).sort(), expectedFiles);
for (const bundle of ['controller.js', 'main-bridge.js', 'popup.js', 'worker.js', 'logs.js']) {
  assert.match(await fs.readFile(path.join(extensionDirectory, `${bundle}.map`), 'utf8'), /"sources"/);
  assert.match(await fs.readFile(path.join(extensionDirectory, bundle), 'utf8'), /sourceMappingURL/);
}

assert.equal(Object.hasOwn(packageMetadata.dependencies || {}, 'hls.js'), false);
assert.doesNotMatch(source, /hls\.js|HLS_DEPENDENCY|LIVE_STATE|LiveStateMachine/);
assert.doesNotMatch(`${source}\n${controller}\n${bridge}\n${worker}\n${logs}`, /hls\.js|LIVE_STATE|LiveStateMachine/);
for (const oldModule of ['api', 'controller', 'danmaku', 'fetcher', 'guard', 'hls', 'manifest', 'mse', 'queue', 'state']) {
  await assert.rejects(fs.access(path.join(root, 'src/live', `${oldModule}.js`)));
}
assert.doesNotMatch(bridge, /chrome\./);
assert.doesNotMatch(bridge, /\b(?:fetch|MediaSource|SourceBuffer)\b/);
const indexedDbReference = /\bindexedDB\b|['"]indexedDB['"]/;
const indexedDbSourceAllowlist = new Set([
  'diagnostics/idb.js',
  'diagnostics/worker.js',
  'diagnostics/logs.js',
]);
for (const { relativePath, content } of sourceFiles) {
  if (!indexedDbSourceAllowlist.has(relativePath)) {
    assert.doesNotMatch(content, indexedDbReference, `${relativePath} 不得直接使用 IndexedDB`);
  }
}
assert.match(await fs.readFile(path.join(root, 'src/diagnostics/idb.js'), 'utf8'), indexedDbReference);
assert.match(worker, indexedDbReference);
for (const [bundleName, bundle] of Object.entries({
  'main bridge': bridge,
  controller,
  popup,
})) {
  assert.doesNotMatch(bundle, indexedDbReference, `${bundleName} bundle 不得使用 IndexedDB`);
}
assert.doesNotMatch(liveSource, /\b(?:play|pause)\s*\(/);
assert.doesNotMatch(liveSource, /playbackRate\s*=/);
assert.doesNotMatch(liveSource, /(?:\.src|\.currentSrc|\.muted|\.volume)\s*=/);
assert.doesNotMatch(vodSource, /\b(?:play|pause)\s*\(/);
assert.doesNotMatch(vodSource, /(?:\.currentTime|\.playbackRate|\.muted|\.volume|\.src|\.currentSrc)\s*=/);
assert.doesNotMatch(`${source}\n${controller}\n${bridge}\n${worker}\n${logs}`, /document\.cookie|localStorage|sessionStorage|sendBeacon/);
assert.doesNotMatch(`${source}\n${controller}\n${bridge}\n${worker}\n${logs}`, /fetch\s*\(|XMLHttpRequest|MediaSource|SourceBuffer/);
assert.doesNotMatch(source, /window\.onerror|window\.onunhandledrejection/);
const diagnosticStorageSource = `${await fs.readFile(path.join(root, 'src/diagnostics/idb.js'), 'utf8')}\n${await fs.readFile(path.join(root, 'src/diagnostics/worker.js'), 'utf8')}`;
assert.doesNotMatch(diagnosticStorageSource, /\.put\s*\(|\.delete\s*\(|\.clear\s*\(/);
assert.match(vodSource, /setStableBufferTime/);
assert.equal((vodSource.match(/\.setStableBufferTime\(/g) || []).length, 1);
assert.equal(VOD_CONFIG.stableBufferSeconds, 120);
assert.equal(LIVE_CONFIG.noDecodedFrameStallMilliseconds, 2000);
assert.equal(EVENT_CODES.includes('log.persist.result'), true);
assert.equal(EVENT_CODES.includes('live.delay_protection.applied'), true);
for (const mediaEvent of MEDIA_EVENT_NAMES) assert.ok(EVENT_CODES.includes(`media.${mediaEvent}`));
assert.match(controller, /unlimitedStorage|diagnostic/);
assert.match(logs, /showSaveFilePicker|createWritable|recordType/);
assert.doesNotMatch(`${source}\n${controller}\n${logs}`, /点播/);
assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /GOAL\.md/);
assert.doesNotMatch(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /点播/);
assert.match(await fs.readFile(path.join(root, 'GOAL.md'), 'utf8'), /视频和直播同等重要/);

console.log('extension build contract passed');
