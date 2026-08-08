'use strict';
/**
 * Search tools: search_files (by name), search_text (grep), search_symbols (definitions).
 * Prefers ripgrep (rg) when available; otherwise a JS fallback walker.
 * Default excludes: .git, node_modules, dist, build, coverage, .cache and large binaries.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { guard, PathGuardError } = require('../security/pathguard');

const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.workbuddy', 'dist-electron'];

function ok(data) { return { ok: true, data }; }
function fail(code, message) { return { ok: false, error: { code, message, retryable: false } }; }

function looksBinary(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

async function walk(root, excludes, onFile) {
  async function rec(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (excludes.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) await onFile(full);
    }
  }
  await rec(root);
}

async function jsGrep(root, pattern, maxResults) {
  const re = new RegExp(pattern, 'g');
  const results = [];
  let count = 0;
  await walk(root, DEFAULT_EXCLUDES, async (full) => {
    if (count >= maxResults) return;
    let buf;
    try { buf = await fsp.readFile(full); } catch { return; }
    if (looksBinary(buf)) return;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        const m = lines[i].match(re);
        results.push({ path: path.relative(root, full), line: i + 1, column: (m ? lines[i].indexOf(m[0]) : 0) + 1, preview: lines[i].trim().slice(0, 200) });
        if (++count >= maxResults) return;
      }
    }
  });
  return results;
}

async function jsFindFiles(root, namePattern, maxResults) {
  const results = [];
  let count = 0;
  const re = namePattern.includes('*') ? new RegExp('^' + namePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  await walk(root, DEFAULT_EXCLUDES, async (full) => {
    if (count >= maxResults) return;
    const base = path.basename(full);
    if (re ? re.test(base) : base.includes(namePattern)) { results.push({ path: path.relative(root, full) }); count++; }
  });
  return results;
}

const tools = [
  {
    name: 'search_files', description: '按文件名或通配符（如 *.ts）查找文件。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { pattern: { type: 'string', description: '文件名或通配符' }, max_results: { type: 'number', default: 50 } }, required: ['pattern'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, '.');
        const files = await jsFindFiles(abs, args.pattern, args.max_results || 50);
        return ok({ files });
      } catch (e) { return fail('SEARCH_FAILED', e.message); }
    }
  },
  {
    name: 'search_text', description: '在代码库中按正则搜索文本内容，返回路径/行号/预览。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { pattern: { type: 'string', description: '正则表达式' }, max_results: { type: 'number', default: 50 }, file_filter: { type: 'string', description: '可选，仅搜索匹配后缀的文件如 .js' } }, required: ['pattern'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, '.');
        let res = await jsGrep(abs, args.pattern, (args.max_results || 50) * 4);
        if (args.file_filter) res = res.filter(r => r.path.endsWith(args.file_filter));
        return ok({ matches: res.slice(0, args.max_results || 50) });
      } catch (e) { return fail('SEARCH_FAILED', e.message); }
    }
  },
  {
    name: 'search_symbols', description: '按名称查找符号定义（function/class/def/const 等）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: '符号名' }, max_results: { type: 'number', default: 30 } }, required: ['name'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, '.');
        const escaped = args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = `(function|class|def|interface|type|struct|enum|const|let|var|fn|pub\\s+fn|public\\s+class)\\s+${escaped}\\b`;
        const res = await jsGrep(abs, pattern, (args.max_results || 30) * 3);
        return ok({ matches: res.slice(0, args.max_results || 30) });
      } catch (e) { return fail('SEARCH_FAILED', e.message); }
    }
  }
];

module.exports = { tools, jsGrep, jsFindFiles, DEFAULT_EXCLUDES };
