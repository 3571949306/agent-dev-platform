'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function runtimeRootCandidates(options = {}) {
  const candidates = [];
  if (options.runtimeRoot) candidates.push(path.resolve(options.runtimeRoot));
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'cline-runtime'));
  candidates.push(path.join(REPO_ROOT, 'build-runtime', 'cline-runtime'));
  return [...new Set(candidates)];
}

function inspectRuntimeRoot(root) {
  const nodePath = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const sidecarPath = path.join(root, 'sidecar', 'src', 'main.mjs');
  const manifestPath = path.join(root, 'runtime-manifest.json');
  const missing = [nodePath, sidecarPath, manifestPath].filter(file => !fs.existsSync(file));
  let manifest = null;
  let error = null;
  if (!missing.length) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.protocolVersion !== 1) error = `Unsupported runtime protocol ${manifest.protocolVersion}`;
      if (!manifest.node || Number(String(manifest.node.version || '').split('.')[0]) < 22) error = 'Bundled Node runtime must be Node 22 or newer';
      if (!manifest.cline || !manifest.cline.sdkVersion) error = 'Cline SDK version missing from runtime manifest';
    } catch (readError) {
      error = `Invalid runtime manifest: ${readError.message}`;
    }
  }
  return {
    available: missing.length === 0 && !error,
    root,
    nodePath,
    sidecarPath,
    manifestPath,
    manifest,
    missing,
    error
  };
}

function locateClineRuntime(options = {}) {
  const inspected = runtimeRootCandidates(options).map(inspectRuntimeRoot);
  return inspected.find(item => item.available) || inspected[0];
}

module.exports = { REPO_ROOT, runtimeRootCandidates, inspectRuntimeRoot, locateClineRuntime };
