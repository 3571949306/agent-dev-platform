'use strict';

const fs = require('fs');
const path = require('path');
const { guard } = require('../security/pathguard');
const { gitExec } = require('../tools/git');

async function git(root, args) {
  // Workbench Git reads share the already-frozen Git transport. This service
  // only parses presentation data; it never creates a second process engine.
  const result = await gitExec({ projectRoot: root }, args);
  if (result && result.ok) return result.data.output || '';
  const detail = result && result.error || {};
  const error = new Error(detail.message || 'Git command failed');
  error.code = detail.code || 'GIT_FAILED';
  throw error;
}

async function isGitProject(root) {
  try { return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; }
  catch { return false; }
}

function parseStatus(raw) {
  const rows = String(raw || '').split('\0').filter(Boolean);
  return rows.map(row => {
    const code = row.slice(0, 2);
    const body = row.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    const parts = renamed ? body.split(' -> ') : [body];
    const filePath = parts[parts.length - 1].replace(/\\/g, '/');
    let status = code === '??' ? 'A' : (code.includes('R') ? 'R' : (code.includes('A') ? 'A' : (code.includes('D') ? 'D' : 'M')));
    return { path: filePath, oldPath: renamed ? parts[0].replace(/\\/g, '/') : null, status, porcelain: code };
  });
}

async function numstatFor(root, relPath) {
  try {
    const out = (await git(root, ['diff', '--numstat', 'HEAD', '--', relPath])).trim();
    if (out) {
      const [added, deleted] = out.split(/\s+/);
      return { added: Number(added) || 0, deleted: Number(deleted) || 0 };
    }
  } catch { /* non-git or unborn repository */ }
  const abs = guard(root, relPath);
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { added: text === '' ? 0 : text.split(/\r?\n/).length, deleted: 0 };
  } catch { return { added: 0, deleted: 0 }; }
}

function syntheticUntrackedDiff(root, relPath) {
  const abs = guard(root, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  const body = lines.map(line => '+' + line).join('\n');
  return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

function untrackedStat(root, relPath) {
  try {
    const text = fs.readFileSync(guard(root, relPath), 'utf8');
    return { added: text === '' ? 0 : text.split(/\r?\n/).length, deleted: 0 };
  } catch { return { added: 0, deleted: 0 }; }
}

function createWorkbenchGitService(root) {
  async function status() {
    if (!await isGitProject(root)) return { isGit: false, branch: null, dirty: false, label: 'No Git' };
    let branch = 'HEAD';
    try { branch = (await git(root, ['branch', '--show-current'])).trim() || (await git(root, ['rev-parse', '--short', 'HEAD'])).trim(); } catch {}
    const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { isGit: true, branch, dirty: raw.length > 0, label: raw.length > 0 ? 'dirty' : 'clean' };
  }

  async function changedFiles() {
    if (!await isGitProject(root)) return { label: 'Working Tree Changes', files: [] };
    const records = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const bounded = records.slice(0, 500);
    const stats = new Map();
    try {
      const rawStats = await git(root, ['diff', '--numstat', 'HEAD']);
      for (const line of rawStats.split(/\r?\n/).filter(Boolean)) {
        const [added, deleted, ...pathParts] = line.split('\t');
        stats.set(pathParts.join('\t').replace(/\\/g, '/'), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
      }
    } catch { /* unborn repo */ }
    return {
      label: 'Working Tree Changes',
      files: bounded.map(record => ({ ...record, ...(stats.get(record.path) || (record.porcelain === '??' ? untrackedStat(root, record.path) : { added: 0, deleted: 0 })) })),
      truncated: records.length > bounded.length
    };
  }

  async function diff(relPath) {
    const rel = path.relative(root, guard(root, relPath)).split(path.sep).join('/');
    const statusRows = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const record = statusRows.find(row => row.path === rel);
    if (!record) return { path: rel, diff: '', status: null };
    let text = '';
    if (record.porcelain === '??') text = syntheticUntrackedDiff(root, rel);
    else text = await git(root, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', rel]);
    return { path: rel, diff: text, status: record.status, ...await numstatFor(root, rel) };
  }

  return { status, changedFiles, diff };
}

module.exports = { createWorkbenchGitService, parseStatus };
