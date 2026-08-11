'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`CLINE_PACK_DESTINATION_INVALID: ${target}`);
  }
}

function requireRuntimeFile(root, relativePath) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    throw new Error(`CLINE_PACK_SOURCE_INCOMPLETE: missing ${relativePath}`);
  }
}

/** electron-builder afterPack hook. */
exports.default = async function afterPackClineRuntime(context) {
  if (!context || !context.appOutDir) throw new Error('CLINE_PACK_CONTEXT_INVALID');
  if (context.electronPlatformName !== 'win32') return;

  const repositoryRoot = path.resolve(__dirname, '..');
  const source = path.join(repositoryRoot, 'build-runtime', 'cline-runtime');
  const appOutDir = path.resolve(context.appOutDir);
  const destination = path.resolve(appOutDir, 'resources', 'cline-runtime');
  assertInside(appOutDir, destination);

  requireRuntimeFile(source, 'runtime-manifest.json');
  requireRuntimeFile(source, path.join('node', 'node.exe'));
  requireRuntimeFile(source, path.join('sidecar', 'package.json'));
  requireRuntimeFile(source, path.join('sidecar', 'node_modules', '@cline', 'sdk', 'package.json'));

  await fs.promises.mkdir(destination, { recursive: true });
  const copied = spawnSync('robocopy', [
    source,
    destination,
    '/MIR',
    '/R:3',
    '/W:1',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP'
  ], { encoding: 'utf8', windowsHide: true });
  if (copied.error || copied.status === null || copied.status >= 8) {
    throw new Error(`CLINE_PACK_COPY_FAILED: ${copied.error ? copied.error.message : copied.stderr || `robocopy status ${copied.status}`}`);
  }

  requireRuntimeFile(destination, 'runtime-manifest.json');
  requireRuntimeFile(destination, path.join('node', 'node.exe'));
  requireRuntimeFile(destination, path.join('sidecar', 'package.json'));
  process.stdout.write(`ClineCore sidecar packed via afterPack: ${destination}\n`);
};
