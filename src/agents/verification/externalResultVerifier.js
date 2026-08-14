'use strict';

/**
 * ExternalResultVerifier — independent effect evidence for external coding
 * runs.  Adapter prose and changedFiles claims are inputs, never proof.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pathSecurity = require('../../security/pathSecurity');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_FALLBACK_FILES = 20000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist-electron', 'build-runtime', '.cache']);
const gitSupervisor = createCliProcessSupervisor();

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parsePorcelain(raw) {
  const entries = new Map();
  const parts = String(raw || '').split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    let file = rec.slice(3);
    if ((status.includes('R') || status.includes('C')) && parts[i + 1]) file = parts[++i];
    entries.set(file.replace(/\\/g, '/'), status);
  }
  return entries;
}

async function gitSnapshot(projectRoot) {
  try {
    const detection = await gitSupervisor.detect('git');
    if (!detection.available) return null;
    const run = async (args) => {
      const handle = await gitSupervisor.spawnProcess({
        command: detection.path,
        args,
        cwd: projectRoot,
        env: buildEnvAllowlist(),
        outputCapBytes: MAX_GIT_OUTPUT,
        timeoutMs: 10000
      });
      const result = await handle.done;
      if (result.code !== 0 || !result.quiesced) throw new Error('git snapshot failed');
      return handle.stdout || '';
    };
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const diff = await run(['diff', '--binary', 'HEAD', '--']);
    const entries = parsePorcelain(status);
    return {
      kind: 'git',
      entries,
      fingerprint: digest(`${status}\n${diff}`),
      files: [...entries.keys()].sort()
    };
  } catch {
    return null;
  }
}

function fallbackSnapshot(projectRoot) {
  const entries = new Map();
  const stack = [projectRoot];
  while (stack.length && entries.size < MAX_FALLBACK_FILES) {
    const dir = stack.pop();
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) { stack.push(absolute); continue; }
      if (!item.isFile()) continue;
      try {
        const st = fs.statSync(absolute);
        const rel = path.relative(projectRoot, absolute).replace(/\\/g, '/');
        const content = st.size <= 5 * 1024 * 1024 ? fs.readFileSync(absolute) : `${st.size}:${st.mtimeMs}`;
        entries.set(rel, digest(content));
      } catch { /* a racing delete is simply absent from this snapshot */ }
      if (entries.size >= MAX_FALLBACK_FILES) break;
    }
  }
  const serial = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return { kind: 'filesystem', entries, fingerprint: digest(JSON.stringify(serial)), files: [...entries.keys()].sort() };
}

async function captureProjectState(projectRoot) {
  const canonicalRoot = pathSecurity.canonicalizeRoot(projectRoot);
  return (await gitSnapshot(canonicalRoot)) || fallbackSnapshot(canonicalRoot);
}

function changedBetween(before, after) {
  const changed = new Set();
  const keys = new Set([...(before?.entries?.keys?.() || []), ...(after?.entries?.keys?.() || [])]);
  for (const key of keys) {
    if (before.entries.get(key) !== after.entries.get(key)) changed.add(key);
  }
  // A previously dirty tracked file can keep the same porcelain status while
  // its diff changes.  In that case the after-status set is the conservative
  // independently observed set.
  if (!changed.size && before.fingerprint !== after.fingerprint) {
    for (const key of after.entries.keys()) changed.add(key);
  }
  return [...changed].sort();
}

function normalizeReported(result) {
  const files = result && (result.reportedChangedFiles || result.changedFiles);
  return Array.isArray(files)
    ? [...new Set(files.filter(v => typeof v === 'string').map(v => v.replace(/\\/g, '/')))].sort()
    : [];
}

async function verifyExternalResult({ projectRoot, before, result, expectedFile = null, expectedContent = null, readOnly = false } = {}) {
  const reportedChangedFiles = normalizeReported(result);
  if (readOnly) {
    return {
      reportedChangedFiles,
      observedChangedFiles: [],
      effectObserved: false,
      verificationStatus: 'NOT_APPLICABLE'
    };
  }
  const after = await captureProjectState(projectRoot);
  const observedChangedFiles = changedBetween(before, after);
  let expectedEffect = true;
  let scopeViolation = false;
  if (expectedFile) {
    const canonicalRoot = pathSecurity.canonicalizeRoot(projectRoot);
    const target = pathSecurity.assertPathInside(canonicalRoot, path.join(canonicalRoot, expectedFile));
    const targetPath = target && target.canonicalTarget || path.join(canonicalRoot, expectedFile);
    let actual = null;
    try { actual = fs.readFileSync(targetPath, 'utf8'); } catch { actual = null; }
    expectedEffect = actual === String(expectedContent == null ? '' : expectedContent);
    scopeViolation = observedChangedFiles.some(f => f !== String(expectedFile).replace(/\\/g, '/'));
  }
  const effectObserved = observedChangedFiles.length > 0 && expectedEffect && !scopeViolation;
  return {
    reportedChangedFiles,
    observedChangedFiles,
    effectObserved,
    verificationStatus: scopeViolation
      ? 'REAL_TASK_SCOPE_VIOLATION'
      : effectObserved ? 'EFFECT_OBSERVED' : 'EXTERNAL_EFFECT_NOT_OBSERVED',
    beforeFingerprint: before && before.fingerprint,
    afterFingerprint: after.fingerprint
  };
}

module.exports = { captureProjectState, verifyExternalResult, parsePorcelain, changedBetween };
