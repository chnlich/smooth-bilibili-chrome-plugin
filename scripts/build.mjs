import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { HLS_DEPENDENCY, VERSION } from '../src/constants.js';
import { createManifest } from '../src/extension/manifest-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (packageMetadata.version !== VERSION) {
  throw new Error(`package.json version ${packageMetadata.version} does not match source version ${VERSION}`);
}
if (packageMetadata.dependencies?.['hls.js'] !== HLS_DEPENDENCY.version) {
  throw new Error(`package.json hls.js dependency does not match source version ${HLS_DEPENDENCY.version}`);
}

const entries = [
  ['src/extension/main-bridge.js', 'main-bridge.js'],
  ['src/extension/controller.js', 'controller.js'],
  ['src/extension/popup.js', 'popup.js'],
];

await fs.rm(extensionDirectory, { recursive: true, force: true });
await fs.mkdir(extensionDirectory, { recursive: true });

for (const [entryPoint, outputName] of entries) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
    charset: 'utf8',
    write: false,
  });
  const output = result.outputFiles[0].text;
  await fs.writeFile(path.join(extensionDirectory, outputName), output.endsWith('\n') ? output : `${output}\n`, 'utf8');
}

for (const asset of ['popup.html', 'popup.css']) {
  await fs.copyFile(path.join(root, 'src', 'extension', asset), path.join(extensionDirectory, asset));
}

await fs.writeFile(
  path.join(extensionDirectory, 'manifest.json'),
  `${JSON.stringify(createManifest(), null, 2)}\n`,
  'utf8',
);

console.log(`built ${path.relative(root, extensionDirectory)}`);
