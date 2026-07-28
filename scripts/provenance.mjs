import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const execFileAsync = promisify(execFile);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function readProvenance({
  rootDirectory = root,
  extensionDirectory: extensionDirectoryOverride = extensionDirectory,
  executeGit = execFileAsync,
  readFile = fs.readFile,
} = {}) {
  let commitSha = null;
  let commitShaReason;
  try {
    const { stdout } = await executeGit('git', ['rev-parse', 'HEAD'], { cwd: rootDirectory });
    const candidate = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(candidate)) {
      commitSha = candidate;
    } else {
      commitShaReason = `git rev-parse HEAD returned invalid output: ${JSON.stringify(candidate)}`;
    }
  } catch (error) {
    commitShaReason = `git rev-parse HEAD failed: ${errorMessage(error)}`;
  }

  const bundles = await Promise.all([
    readFile(path.join(extensionDirectoryOverride, 'controller.js'), 'utf8'),
    readFile(path.join(extensionDirectoryOverride, 'worker.js'), 'utf8'),
  ]);
  const buildIds = new Set(bundles.flatMap((bundle) => bundle.match(/src-[a-f0-9]{24}/g) || []));
  if (buildIds.size !== 1) throw new Error('dist bundles do not contain exactly one shared buildId');
  return { commitSha, commitShaReason, buildId: [...buildIds][0] };
}
