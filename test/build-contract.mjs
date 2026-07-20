import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXTENSION_MANIFEST, LIVE_CONFIG, VOD_CONFIG } from '../src/constants.js';
import { createManifest } from '../src/extension/manifest-source.js';
import { EVENT_CODES, MEDIA_EVENT_NAMES } from '../src/diagnostics/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

async function readTextFiles(directory, suffixes, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readTextFiles(entryPath, suffixes, relativePath));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push({
        relativePath: relativePath.replaceAll(path.sep, '/'),
        content: await fs.readFile(entryPath, 'utf8'),
      });
    }
  }
  return files;
}

async function snapshotExtensionOutput(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await snapshotExtensionOutput(entryPath, relativePath));
    } else {
      const content = await fs.readFile(entryPath);
      files.push({
        path: relativePath.replaceAll(path.sep, '/'),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function extractBuildId(bundles) {
  const buildIds = new Set(
    bundles
      .map((bundle) => bundle.match(/src-[a-f0-9]{24}/)?.[0])
      .filter((buildId) => buildId !== undefined),
  );
  assert.equal(buildIds.size, 1);
  const [buildId] = buildIds;
  assert.match(buildId, /^src-[a-f0-9]{24}$/);
  return buildId;
}

async function buildAndSnapshot() {
  await execFileAsync(npmExecutable, ['run', 'build'], { cwd: root });
  const files = await snapshotExtensionOutput(extensionDirectory);
  const bundles = await Promise.all(
    ['controller.js', 'worker.js'].map((bundle) => fs.readFile(path.join(extensionDirectory, bundle), 'utf8')),
  );
  return { files, buildId: extractBuildId(bundles) };
}

const firstBuild = await buildAndSnapshot();
const secondBuild = await buildAndSnapshot();
assert.deepEqual(secondBuild.files, firstBuild.files);
assert.equal(secondBuild.buildId, firstBuild.buildId);

const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
const source = await readTree(path.join(root, 'src'));
const sourceFiles = await readJavaScriptFiles(path.join(root, 'src'));
const sourceVisibleAssets = await readTextFiles(path.join(root, 'src'), ['.html', '.css', '.json']);
const extensionVisibleFiles = await readTextFiles(extensionDirectory, ['.js', '.html', '.css', '.json']);
const controller = await fs.readFile(path.join(extensionDirectory, 'controller.js'), 'utf8');
const bridge = await fs.readFile(path.join(extensionDirectory, 'main-bridge.js'), 'utf8');
const popup = await fs.readFile(path.join(extensionDirectory, 'popup.js'), 'utf8');
const worker = await fs.readFile(path.join(extensionDirectory, 'worker.js'), 'utf8');
const logs = await fs.readFile(path.join(extensionDirectory, 'logs.js'), 'utf8');
const vodSource = await fs.readFile(path.join(root, 'src/vod/controller.js'), 'utf8');
const liveSource = await fs.readFile(path.join(root, 'src/live/observer.js'), 'utf8');
const passiveMediaSource = await fs.readFile(path.join(root, 'src/diagnostics/passive-media-observer.js'), 'utf8');
const manifestSource = createManifest();
const goal = await fs.readFile(path.join(root, 'GOAL.md'), 'utf8');
const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');

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
const buildId = extractBuildId([controller, worker]);
assert.equal(buildId, secondBuild.buildId);

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
assert.doesNotMatch(passiveMediaSource, /\b(?:play|pause)\s*\(/);
assert.doesNotMatch(passiveMediaSource, /(?:\.currentTime|\.playbackRate|\.muted|\.volume|\.src|\.currentSrc)\s*=/);
assert.doesNotMatch(passiveMediaSource, /\b(?:fetch|MediaSource|SourceBuffer)\b/);
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
const userVisibleDocuments = [
  { path: 'GOAL.md', content: goal },
  { path: 'README.md', content: readme },
  ...sourceFiles.map(({ relativePath, content }) => ({ path: `src/${relativePath}`, content })),
  ...sourceVisibleAssets.map(({ relativePath, content }) => ({ path: `src/${relativePath}`, content })),
  ...extensionVisibleFiles
    .filter(({ relativePath }) => !relativePath.endsWith('.map'))
    .map(({ relativePath, content }) => ({ path: `dist/extension/${relativePath}`, content })),
];
for (const document of userVisibleDocuments) {
  assert.doesNotMatch(document.content, /点播|稍后再看/, `${document.path} 含有已拒绝的产品术语`);
}
assert.match(readme, /GOAL\.md/);
assert.match(readme, /\/list\/watchlater\*/);
assert.match(source, /\/list\/watchlater/);
assert.match(goal, /视频[\s\S]*120 秒/);
assert.match(goal, /直播[\s\S]*卡顿[\s\S]*延迟/);
assert.match(goal, /用户[\s\S]*控制/);
assert.match(goal, /完整结构化日志/);
assert.match(goal, /--mute-audio/);

console.log('extension build contract passed');
