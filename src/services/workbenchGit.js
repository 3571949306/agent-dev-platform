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

/**
 * v2.9.9 Phase B PART A（A4）— 按 Git `-z` 真实格式解析 porcelain=v1 输出。
 *
 * `-z` 下条目以 NUL 分隔；rename/copy 条目的原路径不是用 "old -> new" 字符串
 * 内联，而是紧随其后的独立 NUL 元素：`R  new.js\0old.js\0`。
 * 状态映射：M / A / D / R / C，`??`（untracked）呈现为 A。
 */
function parseStatus(raw) {
  const tokens = String(raw || '').split('\0');
  const records = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 3) continue;
    const code = token.slice(0, 2);
    const body = token.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    let oldPath = null;
    if (renamed) {
      oldPath = tokens[i + 1] ? tokens[i + 1].replace(/\\/g, '/') : null;
      i += 1; // 原路径是独立条目，跳过
    }
    const filePath = body.replace(/\\/g, '/');
    let status;
    if (code === '??') status = 'A';
    else if (code.includes('R') || code.includes('C')) status = 'R';
    else if (code.includes('A')) status = 'A';
    else if (code.includes('D')) status = 'D';
    else status = 'M';
    records.push({ path: filePath, oldPath, status, porcelain: code });
  }
  return records;
}

/** numstat 的 rename 行形如 `old => new` 或 `pre/{old => new}/post`，归一到新路径。 */
function numstatPath(rawPath) {
  let p = String(rawPath || '').replace(/\\/g, '/');
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (brace) p = (brace[1] + brace[3] + brace[4]).replace(/\/\//g, '/');
  else if (p.includes(' => ')) p = p.split(' => ')[1];
  return p;
}

async function numstatFor(root, relPath, oldPath) {
  try {
    // rename 时用 --find-renames 对旧路径取 numstat，保证纯改名（0 内容变化）也有真实证据
    const diffArgs = oldPath
      ? ['diff', '--numstat', '--find-renames', 'HEAD', '--', oldPath, relPath]
      : ['diff', '--numstat', 'HEAD', '--', relPath];
    const out = (await git(root, diffArgs)).trim();
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
      const rawStats = await git(root, ['diff', '--numstat', '--find-renames', 'HEAD']);
      for (const line of rawStats.split(/\r?\n/).filter(Boolean)) {
        const [added, deleted, ...pathParts] = line.split('\t');
        stats.set(numstatPath(pathParts.join('\t')), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
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
    if (!record) return { path: rel, diff: '', status: null, oldPath: null, renamed: false };
    let text = '';
    if (record.porcelain === '??') text = syntheticUntrackedDiff(root, rel);
    else if (record.status === 'R') {
      // Rename truth：即使内容未变化，diff 也必须呈现 rename 事实（old → new）
      text = await git(root, ['diff', '--no-ext-diff', '--unified=3', '--find-renames', 'HEAD', '--', record.oldPath || rel, rel]);
    }
    else text = await git(root, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', rel]);
    return { path: rel, diff: text, status: record.status, oldPath: record.oldPath, renamed: record.status === 'R', ...await numstatFor(root, rel, record.oldPath) };
  }

  return { status, changedFiles, diff };
}

module.exports = { createWorkbenchGitService, parseStatus, numstatPath };
