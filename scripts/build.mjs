import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { VERSION } from '../src/constants.js';
import { createManifest } from '../src/extension/manifest-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'src');
const extensionDirectory = path.join(root, 'dist', 'extension');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

if (packageMetadata.version !== VERSION) {
  throw new Error(`package.json version ${packageMetadata.version} does not match source version ${VERSION}`);
}

async function sourceEntries(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await sourceEntries(absolute, relative));
    } else {
      result.push({ relative, content: await fs.readFile(absolute) });
    }
  }
  return result;
}

function calculateBuildId(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.relative.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return `src-${hash.digest('hex').slice(0, 24)}`;
}

const buildId = calculateBuildId(await sourceEntries(sourceDirectory));
const entries = [
  ['src/extension/main-bridge.js', 'main-bridge.js'],
  ['src/extension/controller.js', 'controller.js'],
  ['src/extension/popup.js', 'popup.js'],
  ['src/diagnostics/worker.js', 'worker.js'],
  ['src/diagnostics/logs.js', 'logs.js'],
];

await fs.rm(extensionDirectory, { recursive: true, force: true });
await fs.mkdir(extensionDirectory, { recursive: true });

for (const [entryPoint, outputName] of entries) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile: path.join(extensionDirectory, outputName),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    minify: false,
    sourcemap: 'external',
    charset: 'utf8',
    define: {
      __BILIBILI_BUILD_ID_LITERAL__: JSON.stringify(buildId),
    },
    write: true,
  });
  const bundlePath = path.join(extensionDirectory, outputName);
  const bundle = await fs.readFile(bundlePath, 'utf8');
  const sourceMapComment = `//# sourceMappingURL=${outputName}.map`;
  if (!bundle.includes(sourceMapComment)) {
    await fs.writeFile(bundlePath, `${bundle.replace(/\n*$/, '')}\n${sourceMapComment}\n`, 'utf8');
  }
}

for (const asset of ['popup.html', 'popup.css', 'logs.html', 'logs.css']) {
  await fs.copyFile(path.join(sourceDirectory, 'extension', asset), path.join(extensionDirectory, asset));
}

await fs.writeFile(
  path.join(extensionDirectory, 'manifest.json'),
  `${JSON.stringify(createManifest(), null, 2)}\n`,
  'utf8',
);

console.log(`built ${path.relative(root, extensionDirectory)} buildId=${buildId}`);
