'use strict';
/**
 * Search tools: search_files (by name), search_text (grep), search_symbols (definitions).
 * Prefers ripgrep (rg) when available; otherwise a JS fallback walker.
 * Default excludes: .git, node_modules, dist, build, coverage, .cache and large binaries.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { guard, PathGuardError } = require('../security/pathguard');

const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.workbuddy', 'dist-electron'];
const RG_TIMEOUT_MS = 20000;

function ok(data) { return { ok: true, data }; }
function fail(code, message) { return { ok: false, error: { code, message, retryable: false } }; }

/* ---------------- v2.9.9 体验对标 Phase 3：真用 ripgrep ----------------
 * hasRipgrep() 进程级缓存探测；rgSearch/rgFindFiles 用 spawn('rg', argv) 数组传参，
 * 用户输入的 pattern 作为独立 argv 元素，绝不拼 shell 字符串（防命令注入）。
 * rg 不可用 / 出错 / 超时时返回 null，由调用方无缝 fallback 到 jsGrep/jsFindFiles。 */

let _rgAvailable = null;
function hasRipgrep() {
  if (_rgAvailable !== null) return Promise.resolve(_rgAvailable);
  return new Promise((resolve) => {
    let done = false;
    let p;
    try { p = spawn('rg', ['--version']); } catch { _rgAvailable = false; return resolve(false); }
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); _rgAvailable = v; resolve(v); };
    const t = setTimeout(() => { try { p.kill(); } catch { /* noop */ } finish(false); }, 1500);
    p.on('error', () => finish(false));
    p.stdout.on('data', () => { /* drain */ });
    p.stderr.on('data', () => { /* drain */ });
    p.on('close', (code) => finish(code === 0));
  });
}

/** 把 DEFAULT_EXCLUDES 转成 rg 的排除 glob（argv 数组，非 shell）。 */
function rgExcludeArgs() {
  const args = [];
  for (const e of DEFAULT_EXCLUDES) { args.push('-g', '!' + e, '-g', '!' + e + '/**'); }
  return args;
}

/** spawn rg 并收集 stdout；超时/错误 kill 并 resolve(null)（触发 JS fallback）。 */
function runRg(argv, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let p;
    try { p = spawn('rg', argv); } catch { return resolve(null); }
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { p.kill(); } catch { /* noop */ } finish(null); }, timeoutMs || RG_TIMEOUT_MS);
    p.on('error', () => finish(null));
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => { /* drain */ });
    p.on('close', (code) => { if (code !== 0 && code !== 1) return finish(null); finish(out); }); // rg: 0=match,1=no match
  });
}

async function rgSearch(root, pattern, opts = {}) {
  const max = opts.maxResults || 200;
  const argv = ['--json', '--max-count', String(Math.max(1, opts.perFileMax || 20)), ...rgExcludeArgs(), '--', pattern, root];
  const out = await runRg(argv, opts.timeoutMs);
  if (out === null) return null;
  const results = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'match' || !ev.data) continue;
    const d = ev.data;
    const abs = (d.path && d.path.text) || '';
    if (!abs) continue;
    const col = (d.submatches && d.submatches[0]) ? d.submatches[0].start + 1 : 1;
    results.push({
      path: path.relative(root, abs),
      line: d.line_number || 0,
      column: col,
      preview: String((d.lines && d.lines.text) || '').trim().slice(0, 200)
    });
    if (results.length >= max) break;
  }
  return results;
}

async function rgFindFiles(root, namePattern, opts = {}) {
  const max = opts.maxResults || 50;
  const argv = ['--files', ...rgExcludeArgs(), root];
  const out = await runRg(argv, opts.timeoutMs);
  if (out === null) return null;
  const re = namePattern.includes('*') ? new RegExp('^' + namePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  const results = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const base = path.basename(line);
    if (re ? re.test(base) : base.includes(namePattern)) { results.push({ path: path.relative(root, line) }); if (results.length >= max) break; }
  }
  return results;
}

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
        let files = null;
        if (await hasRipgrep()) files = await rgFindFiles(abs, args.pattern, { maxResults: args.max_results || 50 });
        if (files === null) files = await jsFindFiles(abs, args.pattern, args.max_results || 50); // 无 rg 无缝回退
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
        let res = null;
        if (await hasRipgrep()) res = await rgSearch(abs, args.pattern, { maxResults: (args.max_results || 50) * 4 });
        if (res === null) res = await jsGrep(abs, args.pattern, (args.max_results || 50) * 4); // 无 rg 无缝回退
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
        let res = null;
        if (await hasRipgrep()) res = await rgSearch(abs, pattern, { maxResults: (args.max_results || 30) * 3 });
        if (res === null) res = await jsGrep(abs, pattern, (args.max_results || 30) * 3); // 复用同一 rg 路径
        return ok({ matches: res.slice(0, args.max_results || 30) });
      } catch (e) { return fail('SEARCH_FAILED', e.message); }
    }
  }
];

module.exports = { tools, jsGrep, jsFindFiles, hasRipgrep, rgSearch, rgFindFiles, DEFAULT_EXCLUDES };
