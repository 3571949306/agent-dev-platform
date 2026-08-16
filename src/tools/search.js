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

const RG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4MB 硬上限（背压）

/**
 * v2.9.9 CU2-A §47/§48 — 流式 rg 传输（背压 + 早停 + abort + 确认退出）。
 * 边读 stdout 边按行回调 onLine；onLine 返回 'stop' 立即 kill rg（达到 maxResults）；
 * 累计输出超 RG_MAX_OUTPUT_BYTES 立即 kill 并标 truncated；signal abort 立即 kill。
 * 关键：kill/timeout 后必须等待 close/exit confirmed 才 resolve，避免 rg 仍活着就 fallback。
 * @returns {Promise<null | {code:number, truncated:boolean, stoppedEarly:boolean}>}
 */
function runRgStreaming(argv, { timeoutMs, signal, onLine, maxBytes } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn('rg', argv); } catch { return resolve(null); }
    let done = false;
    let bytes = 0;
    let truncated = false;
    let stoppedEarly = false;
    let stopReason = 'NORMAL'; // NORMAL|LIMIT|OUTPUT_CAP|ABORT|TIMEOUT|ERROR
    let buf = '';
    const cap = maxBytes || RG_MAX_OUTPUT_BYTES;
    const kill = () => { try { p.kill(); } catch { /* noop */ } };
    const hasSignal = signal && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function';
    const onAbort = () => { stoppedEarly = true; stopReason = 'ABORT'; kill(); };
    const cleanup = () => { if (hasSignal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } } };
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve({ code, truncated, stoppedEarly, stopReason, aborted: stopReason === 'ABORT' }); };
    const timer = setTimeout(() => { truncated = true; if (stopReason === 'NORMAL') stopReason = 'TIMEOUT'; kill(); }, timeoutMs || RG_TIMEOUT_MS);
    if (hasSignal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    p.on('error', () => { if (stopReason === 'NORMAL') stopReason = 'ERROR'; finish(-1); });
    p.stderr.on('data', () => { /* drain */ });
    p.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > cap) { truncated = true; if (stopReason === 'NORMAL') stopReason = 'OUTPUT_CAP'; kill(); return; } // 硬上限背压
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line) continue;
        let stop = false;
        try { stop = onLine(line) === 'stop'; } catch { /* ignore */ }
        if (stop) { stoppedEarly = true; if (stopReason === 'NORMAL') stopReason = 'LIMIT'; kill(); return; } // 早停
      }
    });
    // 必须等 close confirmed 才 resolve（RG_TIMEOUT_OVERLAP_FALLBACK=0）
    p.on('close', (code) => finish(code));
  });
}

async function rgSearch(root, pattern, opts = {}) {
  const max = opts.maxResults || 200;
  const results = [];
  const argv = ['--json', '--max-count', String(Math.max(1, opts.perFileMax || 20)), ...rgExcludeArgs(), '--', pattern, root];
  const run = await runRgStreaming(argv, {
    timeoutMs: opts.timeoutMs, signal: opts.signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type !== 'match' || !ev.data) return;
      const d = ev.data;
      const abs = (d.path && d.path.text) || '';
      if (!abs) return;
      const col = (d.submatches && d.submatches[0]) ? d.submatches[0].start + 1 : 1;
      results.push({ path: path.relative(root, abs), line: d.line_number || 0, column: col, preview: String((d.lines && d.lines.text) || '').trim().slice(0, 200) });
      if (results.length >= max) return 'stop'; // 早停
    }
  });
  if (!run) return null;
  if (run.aborted) return { matches: results, truncated: true, stopReason: 'ABORT', aborted: true }; // ABORT 不当 success
  if (run.code !== 0 && run.code !== 1 && !run.stoppedEarly && !run.truncated) return null;
  return { matches: results, truncated: !!run.truncated, stopReason: run.stopReason, aborted: false };
}

async function rgFindFiles(root, namePattern, opts = {}) {
  const max = opts.maxResults || 50;
  const results = [];
  const re = namePattern.includes('*') ? new RegExp('^' + namePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  const argv = ['--files', ...rgExcludeArgs(), root];
  const run = await runRgStreaming(argv, {
    timeoutMs: opts.timeoutMs, signal: opts.signal,
    onLine: (line) => {
      const base = path.basename(line);
      if (re ? re.test(base) : base.includes(namePattern)) { results.push({ path: path.relative(root, line) }); if (results.length >= max) return 'stop'; }
    }
  });
  if (!run) return null;
  if (run.aborted) return { files: results, truncated: true, stopReason: 'ABORT', aborted: true };
  if (run.code !== 0 && run.code !== 1 && !run.stoppedEarly && !run.truncated) return null;
  return { files: results, truncated: !!run.truncated, stopReason: run.stopReason, aborted: false };
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
        if (await hasRipgrep()) { const r = await rgFindFiles(abs, args.pattern, { maxResults: args.max_results || 50, signal: ctx.abortSignal }); if (r && r.aborted) return fail('SEARCH_ABORTED', '搜索已取消'); files = r ? r.files : null; }
        if (files === null) files = await jsFindFiles(abs, args.pattern, args.max_results || 50); // 无 rg 无缝回退（abort 不 fallback）
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
        if (await hasRipgrep()) { const r = await rgSearch(abs, args.pattern, { maxResults: (args.max_results || 50) * 4, signal: ctx.abortSignal }); if (r && r.aborted) return fail('SEARCH_ABORTED', '搜索已取消'); res = r ? r.matches : null; }
        if (res === null) res = await jsGrep(abs, args.pattern, (args.max_results || 50) * 4); // 无 rg 无缝回退（abort 不 fallback）
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
        if (await hasRipgrep()) { const r = await rgSearch(abs, pattern, { maxResults: (args.max_results || 30) * 3, signal: ctx.abortSignal }); if (r && r.aborted) return fail('SEARCH_ABORTED', '搜索已取消'); res = r ? r.matches : null; }
        if (res === null) res = await jsGrep(abs, pattern, (args.max_results || 30) * 3); // 复用同一 rg 路径（abort 不 fallback）
        return ok({ matches: res.slice(0, args.max_results || 30) });
      } catch (e) { return fail('SEARCH_FAILED', e.message); }
    }
  }
];

module.exports = { tools, jsGrep, jsFindFiles, hasRipgrep, rgSearch, rgFindFiles, runRgStreaming, RG_MAX_OUTPUT_BYTES, DEFAULT_EXCLUDES };
