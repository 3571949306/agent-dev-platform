'use strict';
/**
 * Terminal runtime — real local command execution with streaming output,
 * timeout, and reliable PROCESS-TREE kill (so npm -> node children all die on Stop).
 */
const { spawn } = require('child_process');
const path = require('path');
const { guard, PathGuardError } = require('../security/pathguard');
const { analyzeCommandRisk } = require('../security/commandRiskAnalyzer');
const { authorizeSystemAction } = require('../security/systemIntentGate');

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

const DANGEROUS = [
  /\brm\s+-rf\b/i, /\bdel\s+\/s\b/i, /\brd\s+\/s\b/i, /\bformat\b/i, /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-fd\b/i, /\bgit\s+push\b.*--force/i, /\bgit\s+push\b.*-f\b/i,
  /\bshutdown\b/i, /\breg\s+delete\b/i, /\bnpm\s+publish\b/i, /\bsudo\b/i,
  />\s*\\\\\.\\\\\w+:?/i, /\btruncate\b/i, /\bmkfs\b/i
];
function isDangerous(cmd) { return DANGEROUS.some(re => re.test(cmd)); }

/**
 * v2.9.8 R1 — Destructive Git Guard：除旧的正则清单外，统一用 CommandRiskAnalyzer
 * 结构化识别破坏性命令（git reset / clean 强删 / checkout / restore / stash /
 * switch 强切、递归删除、Windows 破坏性命令）。识别结果映射到 terminal.dangerous
 * 权限域，由现有 PermissionEngine 高风险确认路径裁决（默认 ask；无批准通道时 fail-safe 拒绝）。
 */
function riskSignals(cmd) {
  try { return analyzeCommandRisk({ command: cmd, platform: process.platform }); }
  catch { return null; }
}
function isHighRisk(cmd) {
  if (isDangerous(cmd)) return true;
  const signals = riskSignals(cmd);
  return !!(signals && (signals.isGitDestructive || signals.isRecursiveDelete || signals.isPowerShellDestructive));
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

class TerminalManager {
  constructor() {
    this.runs = new Map();
    // B19.2 — 终端执行历史（有界）：只保留最近 N 条已终态记录，
    // 完整 stdout/stderr 随记录可 backend 查询/审计。
    this._history = [];
  }
  cancel(runId) {
    const r = this.runs.get(runId);
    if (!r) return false;
    try { if (r.child && !r.child.killed) { killTree(r.child.pid); r.child.killed = true; } } catch {}
    r.status = 'killed';
    r.cancelled = true;
    return true;
  }
  status(runId) {
    const r = this.runs.get(runId);
    if (r) return { id: r.id, status: r.status, exitCode: r.exitCode, owner: r.owner || null };
    const h = this._history.find(rec => rec.id === runId);
    return h ? { id: h.id, status: h.status, exitCode: h.exitCode, owner: h.owner || null } : null;
  }
  /**
   * v2.9.8 R6 — Owned Child Process Truth：仍存活的受管子进程计数。
   * 只有 status='running' 的记录持有活 child；exited/killed/aborted/timeout
   * 均意味着进程树已终。终止后残留的记录仅是审计元数据，会随 close 事件结算。
   */
  activeCount() {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === 'running') n++;
    return n;
  }
  /** B19.1 — 活动命令：Command / CWD / Owner / Run / Started / Duration / Status。 */
  active() {
    const list = [];
    for (const r of this.runs.values()) {
      if (r.status !== 'running') continue;
      list.push({
        id: r.id, command: r.command, cwd: r.cwd, owner: r.owner || 'UNKNOWN',
        agentRunId: r.agentRunId || null, startedAt: r.startTime,
        durationMs: Date.now() - r.startTime, status: r.status
      });
    }
    return list.sort((a, b) => b.startedAt - a.startedAt);
  }
  /** B19.3 — 完整输出（backend 查询/审计用；Renderer 自行 bounded 展示）。 */
  output(runId) {
    const rec = this.runs.get(runId) || this._history.find(h => h.id === runId);
    if (!rec) return null;
    return {
      id: rec.id, command: rec.command, cwd: rec.cwd, owner: rec.owner || null,
      status: rec.status, exitCode: rec.exitCode, durationMs: rec.durationMs ?? null,
      timeout: !!rec.timedOut, cancelled: !!rec.cancelled,
      stdout: rec.stdout || '', stderr: rec.stderr || ''
    };
  }
  history(limit = 50) { return this._history.slice(0, limit); }
  /** 记录终态 → 有界历史（保留完整输出供审计）。 */
  _finalize(runId) {
    const rec = this.runs.get(runId);
    if (!rec || rec._finalized) return;
    rec._finalized = true;
    rec.durationMs = Date.now() - rec.startTime;
    this._history.unshift({
      id: rec.id, command: rec.command, cwd: rec.cwd, owner: rec.owner || 'UNKNOWN',
      agentRunId: rec.agentRunId || null, status: rec.status, exitCode: rec.exitCode,
      startedAt: rec.startTime, durationMs: rec.durationMs,
      timeout: !!rec.timedOut, cancelled: !!rec.cancelled,
      stdout: rec.stdout || '', stderr: rec.stderr || ''
    });
    if (this._history.length > 50) this._history.length = 50;
  }
  /** v2.9.8 R6 — 清理已终态的审计记录（仅删非 running 条目，不碰活进程）。 */
  pruneTerminal() {
    for (const [id, r] of [...this.runs.entries()]) {
      if (r.status !== 'running') this.runs.delete(id);
    }
  }
}

const terminalManager = new TerminalManager();

/**
 * B19 — meta：{ owner: USER|MAIN_AGENT|CHILD_AGENT|WORKFLOW, agentRunId, workflowRunId }。
 * Owner 是真话：谁发起的命令就记谁，绝不混淆。
 */
async function runCommand(ctx, command, cwd, timeoutMs, usePowershell, runId, abortSignal, meta = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const shellBin = usePowershell ? 'powershell.exe' : 'cmd.exe';
    const shellArgs = usePowershell ? ['-NoProfile', '-Command', command] : ['/c', command];
    // 子进程环境：剥离 node:test 的内部通信变量。
    // 当平台自身在 `node --test` 下运行（单元测试 / CI），process.env 会带上
    // NODE_TEST_CONTEXT=child-v8；若不剥离，子进程里的 `node --test`（如 npm test
    // 跑的 node --test test/...）会误以为自己是被父测试运行器托管的子测试，
    // 改走 IPC 通信模式并退出 0，从而吞掉真实的测试失败退出码。
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_TMPDIR;
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
        env: childEnv,
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (e) { return resolve(fail('SPAWN_FAILED', e.message)); }

    terminalManager.runs.set(runId, {
      id: runId, child, status: 'running', startTime: Date.now(), exitCode: null,
      command, cwd, owner: meta.owner || 'UNKNOWN', agentRunId: meta.agentRunId || null,
      workflowRunId: meta.workflowRunId || null,
      stdout: '', stderr: '', cancelled: false, timedOut: false
    });

    const onData = (type) => (chunk) => {
      const s = chunk.toString();
      if (type === 'out') stdout += s; else stderr += s;
      const rec = terminalManager.runs.get(runId);
      if (rec) { if (type === 'out') rec.stdout += s; else rec.stderr += s; }
      if (ctx.emit) ctx.emit('terminal_output', { runId, stream: type, chunk: s });
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (child && !child.killed) { killTree(child.pid); child.killed = true; }
        const rec = terminalManager.runs.get(runId);
        if (rec) { rec.status = 'timeout'; rec.timedOut = true; }
        terminalManager._finalize(runId);
        resolve(fail('TERMINAL_TIMEOUT', `命令超时（${timeoutMs}ms）`, false));
      }, timeoutMs);
    }
    const onAbort = () => {
      if (child && !child.killed) { killTree(child.pid); child.killed = true; }
      const rec = terminalManager.runs.get(runId);
      if (rec) { rec.status = 'aborted'; rec.cancelled = true; }
      terminalManager._finalize(runId);
      resolve(fail('TERMINAL_ABORTED', '命令已被中止', false));
    };
    // 防御：abortSignal 必须是真正的 AbortSignal（含 addEventListener）才挂监听。
    // 部分调用方（单元测试 / 旧路径）可能传入 { aborted:false } 这种普通对象，
    // 此时无法监听中止，但不应该让 spawn 崩溃。
    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      if (abortSignal.aborted) { // 已中止：直接 kill + resolve
        if (child && !child.killed) { killTree(child.pid); child.killed = true; }
        resolve(fail('TERMINAL_ABORTED', '命令已被中止', false));
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => { if (timer) clearTimeout(timer); terminalManager._finalize(runId); resolve(fail('SPAWN_FAILED', err.message)); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (abortSignal && typeof abortSignal.removeEventListener === 'function') abortSignal.removeEventListener('abort', onAbort);
      const rec = terminalManager.runs.get(runId);
      if (rec && rec.status === 'running') { rec.status = 'exited'; rec.exitCode = code; }
      else if (rec) { rec.exitCode = code; }
      terminalManager._finalize(runId);
      if (ctx.emit) ctx.emit('terminal_exit', { runId, exitCode: code });
      resolve(ok({ exit_code: code, stdout, stderr, cwd }));
    });
  });
}

const tools = [
  {
    name: 'terminal_run', description: '在项目中执行 shell 命令（npm install/build/test 等），输出流式返回。', risk_level: 'high', permission: 'terminal.write',
    permissionFor(args) { return isHighRisk(args.command || '') ? 'terminal.dangerous' : 'terminal.write'; },
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
        // P3 P0 safety — system-level actions (shutdown/restart/format/…) require
        // the CURRENT user request + explicit destructive confirmation. Stale
        // history / model suggestions never count; without a confirm channel the
        // gate fails closed (spawn = 0), even with an `always` grant.
        const gate = await authorizeSystemAction({
          command: args.command,
          currentUserMessage: ctx.currentUserMessage,
          confirm: ctx.confirmSystemAction || null
        });
        if (!gate.allowed) {
          return fail(gate.code || 'SYSTEM_ACTION_DENIED', gate.error || '系统级动作被拦截', false);
        }
        const cwd = guard(ctx.projectRoot, args.cwd || '.');
        const runId = 'run_' + Math.random().toString(36).slice(2, 10);
        if (ctx.emit) ctx.emit('terminal_start', { runId, command: args.command, cwd });
        // B19.1 — Owner 真话：Workflow 步骤 / Child Agent / Main Agent
        const owner = ctx.workflowRunId ? 'WORKFLOW' : (ctx.parentRunId ? 'CHILD_AGENT' : 'MAIN_AGENT');
        const res = await runCommand(ctx, args.command, cwd, args.timeout_ms || 120000, args.shell === 'powershell', runId, ctx.abortSignal,
          { owner, agentRunId: ctx.runId || null, workflowRunId: ctx.workflowRunId || null });
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

module.exports = { tools, terminalManager, isDangerous, isHighRisk, killTree, runCommand };
