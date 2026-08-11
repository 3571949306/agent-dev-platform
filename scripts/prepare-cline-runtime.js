'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'sidecars', 'cline-runtime');
const MANIFEST_PATH = path.join(SOURCE, 'runtime-manifest.json');
const CACHE = path.join(ROOT, '.cache', 'cline-runtime');
const BUILD = path.join(ROOT, 'build-runtime');
const TARGET = path.join(BUILD, 'cline-runtime');
const STAGING = path.join(BUILD, '.cline-runtime-staging');
const offline = process.argv.includes('--offline') || process.env.ADP_OFFLINE === '1' || process.env.npm_config_offline === 'true';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('CLINE_PREPARE_PATH_INVALID', `Refusing to modify path outside ${parent}`);
}

function removeExact(candidate) {
  assertInside(ROOT, candidate);
  fs.rmSync(candidate, { recursive: true, force: true });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function validateOfficialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'nodejs.org' || !url.pathname.startsWith('/dist/')) {
    fail('CLINE_NODE_DOWNLOAD_URL_INVALID', `Refusing non-official Node.js URL: ${url.origin}${url.pathname}`);
  }
  return url;
}

function download(urlValue, destination, redirects = 0) {
  const url = validateOfficialUrl(urlValue);
  if (redirects > 4) fail('CLINE_NODE_DOWNLOAD_FAILED', 'Too many Node.js download redirects');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Agent-Dev-Platform-Cline-Runtime/2.7.3' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url);
        if (redirected.hostname !== 'nodejs.org') return reject(Object.assign(new Error('Node.js download redirected to an untrusted host'), { code: 'CLINE_NODE_DOWNLOAD_URL_INVALID' }));
        return download(redirected.toString(), destination, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(Object.assign(new Error(`Node.js download returned HTTP ${response.statusCode}`), { code: 'CLINE_NODE_DOWNLOAD_FAILED' }));
      }
      const temporary = `${destination}.partial`;
      const output = fs.createWriteStream(temporary, { flags: 'w' });
      response.pipe(output);
      output.once('error', reject);
      output.once('finish', () => {
        output.close(() => {
          fs.renameSync(temporary, destination);
          resolve();
        });
      });
    });
    request.once('error', reject);
  });
}

function downloadText(urlValue) {
  const destination = path.join(CACHE, 'SHASUMS256.txt');
  return download(urlValue, destination).then(() => fs.readFileSync(destination, 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, windowsHide: true, ...options });
  if (result.error) fail('CLINE_PREPARE_COMMAND_FAILED', `${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail('CLINE_PREPARE_COMMAND_FAILED', `${command} exited with code ${result.status}`);
}

async function ensureNodeArchive(manifest) {
  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, manifest.node.filename);
  if (fs.existsSync(archive) && sha256(archive) !== manifest.node.sha256) fs.unlinkSync(archive);
  if (!fs.existsSync(archive)) {
    if (offline) fail('CLINE_NODE_RUNTIME_MISSING', `Offline mode: cached ${manifest.node.filename} is missing`);
    process.stdout.write(`Downloading official Node.js ${manifest.node.version} runtime...\n`);
    await download(manifest.node.downloadUrl, archive);
  }
  const actual = sha256(archive);
  if (actual !== manifest.node.sha256) fail('CLINE_NODE_CHECKSUM_MISMATCH', `Node.js archive SHA-256 mismatch: expected ${manifest.node.sha256}, got ${actual}`);
  if (!offline) {
    const shasums = await downloadText(manifest.node.shasumsUrl);
    const match = shasums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${manifest.node.filename}`));
    if (!match || match.trim().split(/\s+/)[0] !== manifest.node.sha256) {
      fail('CLINE_NODE_CHECKSUM_MISMATCH', 'Pinned checksum does not match the official Node.js SHASUMS256.txt');
    }
  }
  return archive;
}

function extractNode(archive, version) {
  const extraction = path.join(CACHE, `node-v${version}-win-x64`);
  const nodeExe = path.join(extraction, 'node.exe');
  if (fs.existsSync(nodeExe)) return extraction;
  const temporary = path.join(CACHE, `.extract-node-${version}`);
  removeExact(temporary);
  fs.mkdirSync(temporary, { recursive: true });
  // Windows ships bsdtar; argv stays separated and never passes through a shell.
  run('tar.exe', ['-xf', archive, '-C', temporary]);
  const expanded = path.join(temporary, `node-v${version}-win-x64`);
  if (!fs.existsSync(path.join(expanded, 'node.exe'))) fail('CLINE_NODE_ARCHIVE_INVALID', 'Official Node.js archive did not contain node.exe');
  fs.renameSync(expanded, extraction);
  removeExact(temporary);
  return extraction;
}

function stageRuntime(manifest, nodeDirectory) {
  fs.mkdirSync(BUILD, { recursive: true });
  removeExact(STAGING);
  fs.mkdirSync(path.join(STAGING, 'node'), { recursive: true });
  fs.mkdirSync(path.join(STAGING, 'sidecar'), { recursive: true });
  fs.copyFileSync(path.join(nodeDirectory, 'node.exe'), path.join(STAGING, 'node', 'node.exe'));
  fs.copyFileSync(path.join(nodeDirectory, 'LICENSE'), path.join(STAGING, 'node', 'LICENSE'));
  fs.copyFileSync(MANIFEST_PATH, path.join(STAGING, 'runtime-manifest.json'));
  for (const name of ['package.json', 'package-lock.json', 'README.md']) {
    fs.copyFileSync(path.join(SOURCE, name), path.join(STAGING, 'sidecar', name));
  }
  fs.cpSync(path.join(SOURCE, 'src'), path.join(STAGING, 'sidecar', 'src'), { recursive: true });
  const npmCli = path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) fail('CLINE_NODE_ARCHIVE_INVALID', 'Official Node.js archive did not contain npm-cli.js');
  const npmArgs = [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(CACHE, 'npm')];
  if (offline) npmArgs.push('--offline');
  run(path.join(nodeDirectory, 'node.exe'), npmArgs, { cwd: path.join(STAGING, 'sidecar') });
  const version = spawnSync(path.join(STAGING, 'node', 'node.exe'), ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (version.status !== 0 || version.stdout.trim() !== `v${manifest.node.version}`) {
    fail('CLINE_NODE_VERSION_MISMATCH', `Staged Node.js version is ${version.stdout.trim() || 'unknown'}, expected v${manifest.node.version}`);
  }
  removeExact(TARGET);
  fs.renameSync(STAGING, TARGET);
}

function stagedRuntimeIsCurrent(manifest) {
  try {
    const stagedManifest = JSON.parse(fs.readFileSync(path.join(TARGET, 'runtime-manifest.json'), 'utf8'));
    if (JSON.stringify(stagedManifest) !== JSON.stringify(manifest)) return false;
    const sourceLock = sha256(path.join(SOURCE, 'package-lock.json'));
    const stagedLock = sha256(path.join(TARGET, 'sidecar', 'package-lock.json'));
    if (sourceLock !== stagedLock) return false;
    const sdkPackage = JSON.parse(fs.readFileSync(path.join(TARGET, 'sidecar', 'node_modules', '@cline', 'sdk', 'package.json'), 'utf8'));
    if (sdkPackage.version !== manifest.cline.sdkVersion) return false;
    const version = spawnSync(path.join(TARGET, 'node', 'node.exe'), ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
    return version.status === 0 && version.stdout.trim() === `v${manifest.node.version}`;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('CLINE_PLATFORM_UNSUPPORTED', 'Cline bundled runtime preparation currently supports Windows x64 only');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.node.platform !== 'win32' || manifest.node.arch !== 'x64') fail('CLINE_RUNTIME_MANIFEST_INVALID', 'Runtime manifest target is not Windows x64');
  validateOfficialUrl(manifest.node.downloadUrl);
  validateOfficialUrl(manifest.node.shasumsUrl);
  if (stagedRuntimeIsCurrent(manifest)) {
    process.stdout.write(`ClineCore sidecar already prepared: Node ${manifest.node.version}, @cline/sdk ${manifest.cline.sdkVersion}\n`);
    return;
  }
  const archive = await ensureNodeArchive(manifest);
  const nodeDirectory = extractNode(archive, manifest.node.version);
  stageRuntime(manifest, nodeDirectory);
  process.stdout.write(`Prepared ClineCore sidecar: Node ${manifest.node.version}, @cline/sdk ${manifest.cline.sdkVersion}\n`);
}

main().catch(error => {
  process.stderr.write(`[${error.code || 'CLINE_PREPARE_FAILED'}] ${error.message}\n`);
  process.exitCode = 1;
});
