'use strict';
/**
 * Terminal runtime — real local command execution with streaming output,
 * timeout, and reliable PROCESS-TREE kill (so npm -> node children all die on Stop).
 */
const { spawn } = require('child_process');
const path = require('path');
const { guard, PathGuardError } = require('../security/pathguard');

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

const DANGEROUS = [
  /\brm\s+-rf\b/i, /\bdel\s+\/s\b/i, /\brd\s+\/s\b/i, /\bformat\b/i, /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-fd\b/i, /\bgit\s+push\b.*--force/i, /\bgit\s+push\b.*-f\b/i,
  /\bshutdown\b/i, /\breg\s+delete\b/i, /\bnpm\s+publish\b/i, /\bsudo\b/i,
  />\s*\\\\\.\\\\\w+:?/i, /\btruncate\b/i, /\bmkfs\b/i
];
function isDangerous(cmd) { return DANGEROUS.some(re => re.test(cmd)); }

function killTree(pid) {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

class TerminalManager {
  constructor() { this.runs = new Map(); }
  cancel(runId) {
    const r = this.runs.get(runId);
    if (!r) return false;
    try { if (r.child && !r.child.killed) { killTree(r.child.pid); r.child.killed = true; } } catch {}
    r.status = 'killed';
    return true;
  }
  status(runId) { const r = this.runs.get(runId); return r ? { id: r.id, status: r.status, exitCode: r.exitCode } : null; }
}

const terminalManager = new TerminalManager();

async function runCommand(ctx, command, cwd, timeoutMs, usePowershell, runId, abortSignal) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const shellBin = usePowershell ? 'powershell.exe' : 'cmd.exe';
    const shellArgs = usePowershell ? ['-NoProfile', '-Command', command] : ['/c', command];
    let child;
    try {
      // NOTE: `detached` must stay FALSE on Windows.
      // DETACHED_PROCESS makes cmd.exe run without a console, and any grandchild
      // (node/npm/python...) then writes to a void — we would get an exit code but
      // ZERO stdout, which silently breaks the run -> read-error -> fix loop.
      // Killing the whole tree on Windows is handled by `taskkill /t /f`, so
      // detaching buys us nothing here. On POSIX we keep it for `kill(-pid)`.
      child = spawn(shellBin, shellArgs, {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (e) { return resolve(fail('SPAWN_FAILED', e.message)); }

    terminalManager.runs.set(runId, { id: runId, child, status: 'running', startTime: Date.now(), exitCode: null });

    const onData = (type) => (chunk) => {
      const s = chunk.toString();
      if (type === 'out') stdout += s; else stderr += s;
      if (ctx.emit) ctx.emit('terminal_output', { runId, stream: type, chunk: s });
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (child && !child.killed) { killTree(child.pid); child.killed = true; }
        terminalManager.runs.get(runId).status = 'timeout';
        resolve(fail('TERMINAL_TIMEOUT', `命令超时（${timeoutMs}ms）`, false));
      }, timeoutMs);
    }
    const onAbort = () => {
      if (child && !child.killed) { killTree(child.pid); child.killed = true; }
      terminalManager.runs.get(runId).status = 'aborted';
      resolve(fail('TERMINAL_ABORTED', '命令已被中止', false));
    };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve(fail('SPAWN_FAILED', err.message)); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      const rec = terminalManager.runs.get(runId);
      if (rec) { rec.status = 'exited'; rec.exitCode = code; }
      if (ctx.emit) ctx.emit('terminal_exit', { runId, exitCode: code });
      resolve(ok({ exit_code: code, stdout, stderr, cwd }));
    });
  });
}

const tools = [
  {
    name: 'terminal_run', description: '在项目中执行 shell 命令（npm install/build/test 等），输出流式返回。', risk_level: 'high', permission: 'terminal.write',
    permissionFor(args) { return isDangerous(args.command || '') ? 'terminal.dangerous' : 'terminal.write'; },
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（相对项目根，默认项目根）' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 120000' },
        shell: { type: 'string', enum: ['cmd', 'powershell'], description: '默认 cmd' }
      },
      required: ['command']
    },
    async exec(ctx, args) {
      try {
        const cwd = guard(ctx.projectRoot, args.cwd || '.');
        const runId = 'run_' + Math.random().toString(36).slice(2, 10);
        if (ctx.emit) ctx.emit('terminal_start', { runId, command: args.command, cwd });
        const res = await runCommand(ctx, args.command, cwd, args.timeout_ms || 120000, args.shell === 'powershell', runId, ctx.abortSignal);
        return res;
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('TERMINAL_FAILED', e.message); }
    }
  },
  {
    name: 'terminal_cancel', description: '取消正在运行的终端命令（杀掉整个进程树）。', risk_level: 'medium', permission: 'terminal.write',
    input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    async exec(ctx, args) {
      const okCancel = terminalManager.cancel(args.run_id);
      return okCancel ? ok({ cancelled: args.run_id }) : fail('NO_SUCH_RUN', '未找到该运行实例', false);
    }
  },
  {
    name: 'terminal_status', description: '查询终端运行实例状态。', risk_level: 'low', permission: 'terminal.read',
    input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    async exec(ctx, args) { return ok(terminalManager.status(args.run_id) || { status: 'not_found' }); }
  }
];

module.exports = { tools, terminalManager, isDangerous, killTree, runCommand };
