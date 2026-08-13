'use strict';

const fs = require('fs');
const path = require('path');
const { guard } = require('../security/pathguard');
const { workbenchMutations } = require('../tools/filesystem');

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.jsx': 'JavaScript React', '.json': 'JSON', '.md': 'Markdown', '.css': 'CSS', '.html': 'HTML', '.htm': 'HTML',
  '.py': 'Python', '.java': 'Java', '.c': 'C', '.h': 'C Header', '.cpp': 'C++', '.hpp': 'C++ Header',
  '.cs': 'C#', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.sh': 'Shell', '.ps1': 'PowerShell',
  '.yml': 'YAML', '.yaml': 'YAML', '.xml': 'XML', '.sql': 'SQL', '.toml': 'TOML', '.ini': 'INI'
});

function normalizeRelative(root, value) {
  const abs = guard(root, value);
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  if (!rel || rel === '.') return '.';
  return rel;
}

function safeTarget(root, value, { allowRoot = false } = {}) {
  const rel = normalizeRelative(root, value);
  if (!allowRoot && rel === '.') {
    const error = new Error('不能修改项目根目录');
    error.code = 'WORKSPACE_ROOT_MUTATION_BLOCKED';
    throw error;
  }
  return { rel, abs: guard(root, rel) };
}

function languageFor(rel) {
  const name = path.basename(rel).toLowerCase();
  if (name === 'dockerfile') return 'Dockerfile';
  if (name === 'makefile') return 'Makefile';
  return LANGUAGE_BY_EXT[path.extname(name)] || 'Plain Text';
}

function looksBinary(buffer) {
  if (!buffer || !buffer.length) return false;
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

function createWorkbenchFileService(root) {
  if (!root) throw new Error('project root is required');
  const toolContext = { projectRoot: root };

  async function runMutation(name, args, collisionCodes = []) {
    const mutation = workbenchMutations[name];
    if (!mutation) throw new Error(`文件工具不存在：${name}`);
    const result = await mutation(toolContext, args);
    if (result && result.ok) return result.data || {};
    const detail = result && result.error || {};
    const error = new Error(detail.message || `${name} 执行失败`);
    error.code = collisionCodes.includes(detail.code) ? 'FILE_COLLISION' : (detail.code || 'FILE_OPERATION_FAILED');
    throw error;
  }

  function preview(relPath) {
    const target = safeTarget(root, relPath);
    const st = fs.statSync(target.abs);
    if (!st.isFile()) {
      const error = new Error('目标不是文件');
      error.code = 'NOT_A_FILE';
      throw error;
    }
    const base = {
      path: target.rel,
      size: st.size,
      language: languageFor(target.rel),
      readOnly: true,
      binary: false,
      truncated: false,
      lineCount: null,
      content: ''
    };
    if (st.size > MAX_PREVIEW_BYTES) {
      return { ...base, truncated: true, reason: 'File too large to preview' };
    }
    const buffer = fs.readFileSync(target.abs);
    if (looksBinary(buffer)) return { ...base, binary: true, reason: 'Binary file' };
    const content = buffer.toString('utf8');
    return { ...base, content, lineCount: content === '' ? 0 : content.split(/\r?\n/).length };
  }

  async function createFile(relPath) {
    const target = safeTarget(root, relPath);
    await runMutation('create_file', { path: target.rel, content: '' }, ['FILE_EXISTS']);
    return { ok: true, path: target.rel, type: 'file' };
  }

  async function createDir(relPath) {
    const target = safeTarget(root, relPath);
    await runMutation('create_directory', { path: target.rel }, ['DIRECTORY_EXISTS']);
    return { ok: true, path: target.rel, type: 'directory' };
  }

  async function rename(from, to) {
    const source = safeTarget(root, from);
    const destination = safeTarget(root, to);
    await runMutation('move_file', { source: source.rel, destination: destination.rel, replace: false }, ['DESTINATION_EXISTS']);
    return { ok: true, from: source.rel, path: destination.rel };
  }

  async function remove(relPath) {
    const target = safeTarget(root, relPath);
    const st = fs.lstatSync(target.abs);
    await runMutation(st.isDirectory() && !st.isSymbolicLink() ? 'delete_directory' : 'delete_file', { path: target.rel });
    return { ok: true, path: target.rel, type: st.isDirectory() ? 'directory' : 'file' };
  }

  function absolute(relPath) {
    const target = safeTarget(root, relPath, { allowRoot: true });
    return { path: target.rel, absolutePath: target.abs };
  }

  return { preview, createFile, createDir, rename, remove, absolute, normalizeRelative: value => normalizeRelative(root, value) };
}

module.exports = { createWorkbenchFileService, MAX_PREVIEW_BYTES, languageFor, looksBinary };
