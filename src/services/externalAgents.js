'use strict';
/**
 * External Agent adapters — Codex (official CLI / OpenAI-compatible model),
 * WorkBuddy Desktop Bridge, and generic HTTP.
 *
 * All adapters share one contract and one result shape:
 *   { status: 'completed'|'failed'|'timeout'|'cancelled'|'running',
 *     summary, findings[], changedFiles[], artifacts[], errors[] , ...detail }
 *
 * v2.1.0:
 *  - the WorkBuddy bridge no longer sleeps 3s and claims success; it drives a
 *    real state machine and returns the answer it actually read back
 *  - Codex CLI gets a timeout, a Stop signal and a real exit-code contract
 *  - every run writes last_status / last_run_at back to the external_agents row
 */
const { spawn } = require('child_process');
const fs = require('fs');
const providers = require('../providers');
const { linkSignals } = require('../providers/http');
const { DesktopAgentBridge } = require('./desktopBridge');
const { externalAgentScopes, ensureScopes } = require('../security/agentScopes');
// NOTE: do NOT require('../agent/subagent') here — subagent.js requires this
// module, so a top-level require creates a cycle and yields `undefined`
// bindings at load time. External adapters never recurse into sub-agents.

const TERMINAL_STATES = ['completed', 'failed', 'timeout', 'cancelled'];

/**
 * v2.3.1 (P0-4) — 把 External Agent 返回（string 或对象）映射为 Run 终态结果：
 *   { status, error }
 * completed/failed/timeout/cancelled 统一映射；无法解析一律 failed。
 * 供 runChatTurn 使用：外部结果 = Run 结果（当外部智能体直接作为聊天运行时）。
 */
function mapExternalResult(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    if (parsed && TERMINAL_STATES.includes(parsed.status)) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors.join('; ') : null;
      let error = errors || null;
      // 失败/超时且没有 errors 数组时，用 summary 兜底；completed 的 summary 是答案不是错误
      if (!error && (parsed.status === 'failed' || parsed.status === 'timeout')) error = parsed.summary || null;
      return { status: parsed.status, error };
    }
  } catch { /* fallthrough */ }
  return { status: 'failed', error: null };
}

function structured(status, summary, extra = {}) {
  return JSON.stringify({
    status,
    summary: (summary || '').slice(0, 4000),
    findings: [], changedFiles: [], artifacts: [], errors: [],
    ...extra
  });
}

/** Keep the Agents page honest about what happened last time. */
function recordStatus(store, adapter, status, error) {
  if (!store || !store.externalAgents || !adapter || !adapter.id) return;
  try {
    store.externalAgents.setRunStatus(adapter.id, {
      status,
      error: error || '',
      online: status === 'completed'
    });
  } catch { /* telemetry must never break a run */ }
}

/**
 * P0-3: kill the whole process tree, not just the launcher.
 *
 * `child.kill()` sends a signal to the process we spawned. Codex CLI (like npm,
 * python -m, or any shim) immediately spawns children of its own, and those
 * survive — the user presses Stop, the UI says cancelled, and a compiler keeps
 * chewing through their CPU. On Windows only `taskkill /T` walks the tree; on
 * POSIX we spawn detached so the pid doubles as a process-group id.
 */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch { /* gone */ } });
    } catch { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try {
    process.kill(-child.pid, signal);          // negative pid == the group
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
  // Escalate if the tree ignores SIGTERM.
  const t = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, 3000);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * P1-5: which directory Codex actually runs in.
 * cfg.cwd (explicit per-adapter override) > current project root > app cwd.
 */
function resolveCodexCwd(cfg, ctx) {
  const candidates = [cfg.cwd, ctx && ctx.projectRoot, process.cwd()];
  for (const c of candidates) {
    if (!c) continue;
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch { /* try next */ }
  }
  return process.cwd();
}

/**
 * P0: resolve whether a CLI command exists in PATH.
 * On Windows uses `where`, on POSIX uses `which`.
 * NEVER use fs.existsSync("codex") — that checks the CWD, not PATH.
 */
function resolveCliInPath(cmd) {
  return new Promise((resolve) => {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(checker, [cmd], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code === 0 && out.trim()) resolve(out.trim().split(/\r?\n/)[0]);
      else resolve(null);
    });
  });
}

/**
 * P0: detect Codex CLI path.
 * - cliMode='auto': search PATH for 'codex'
 * - cliMode='path': use cfg.cliPath (absolute path or bare command — resolve via PATH if bare)
 * - cliMode='api': return null (no CLI needed)
 */
async function resolveCodexCli(cfg) {
  const mode = cfg.cliMode || (cfg.cliPath ? 'path' : 'auto');
  if (mode === 'api') return null;
  if (mode === 'auto') return resolveCliInText('codex');
  // mode === 'path'
  const p = cfg.cliPath;
  if (!p) return resolveCliInText('codex');
  // If it looks like a path (has separator or .exe), check fs
  if (p.includes('/') || p.includes('\\') || p.toLowerCase().endsWith('.exe')) {
    return fs.existsSync(p) ? p : null;
  }
  // Bare command like "codex" — resolve via PATH
  return resolveCliInText(p);
}

function resolveCliInText(cmd) {
  return resolveCliInPath(cmd);
}

// -------------------------------------------------------------------- Codex
async function runCodex(adapter, taskText, store, ctx = {}) {
  const cfg = adapter.config || {};
  const timeoutMs = Number(cfg.timeoutMs) || 600000;

  // P0: resolve CLI path properly (auto-detect / PATH resolution)
  const cliPath = await resolveCodexCli(cfg);
  // Also handle old data: if cfg.cliPath is empty but adapter.command exists, migrate
  const fallbackPath = cliPath || (adapter.command && adapter.command.trim() ? (await resolveCliInText(adapter.command.trim().split(/\s+/)[0])) : null);

  // Option A: official CLI
  if (fallbackPath || (cfg.cliPath && fs.existsSync(cfg.cliPath))) {
    const actualPath = fallbackPath || cfg.cliPath;
    const cwd = resolveCodexCwd(cfg, ctx);
    const cwdSource = cfg.cwd ? 'adapter.cwd' : (ctx.projectRoot ? 'projectRoot' : 'process.cwd');
    return new Promise((resolve) => {
      const args = Array.isArray(cfg.args) && cfg.args.length ? [...cfg.args, taskText] : ['exec', '--', taskText];
      let child;
      try {
        child = spawn(actualPath, args, {
          windowsHide: true,
          cwd,
          // POSIX: become a process-group leader so killTree() can take the group down.
          detached: process.platform !== 'win32'
        });
      } catch (e) {
        // Windows 直接 spawn .cmd/.bat 会同步抛出 EINVAL；必须捕获，否则异常会
        // 击穿 Promise 让整次运行卡死（#44 的 Spinner 永不收尾）。
        return resolve(structured('failed', '', { errors: ['Codex CLI 启动失败: ' + e.message], cwd, cwdSource }));
      }
      let out = '', errOut = '', settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener?.('abort', onAbort);
        resolve(v);
      };
      const timer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        done(structured('timeout', out.slice(0, 2000), {
          errors: [`Codex CLI 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`], exitCode: null, cwd, cwdSource, pid: child.pid
        }));
      }, timeoutMs);
      const onAbort = () => {
        killTree(child, 'SIGKILL');
        done(structured('cancelled', out.slice(0, 2000), { errors: ['用户已停止'], cwd, cwdSource, pid: child.pid, killedTree: true }));
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) { killTree(child, 'SIGKILL'); return done(structured('cancelled', '', { errors: ['用户已停止'], cwd, cwdSource, killedTree: true })); }
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', d => { out += d.toString(); if (ctx.onChunk) ctx.onChunk(d.toString()); });
      child.stderr.on('data', d => { errOut += d.toString(); });
      // An unhandled 'error' event on a ChildProcess throws and kills the app.
      child.on('error', e => done(structured('failed', '', { errors: ['Codex CLI 启动失败: ' + e.message], cwd, cwdSource })));
      child.on('close', code => done(structured(
        code === 0 ? 'completed' : 'failed',
        (out || errOut).slice(0, 4000),
        { exitCode: code, cwd, cwdSource, pid: child.pid, errors: code === 0 ? [] : [`Codex CLI 退出码 ${code}${errOut ? '：' + errOut.slice(0, 300) : ''}`] }
      )));
    });
  }

  // Option B: OpenAI-compatible model (e.g. codex-mini via Responses/Chat)
  if (cfg.connectionId) {
    const conn = store.connections.getDecrypted(cfg.connectionId);
    if (!conn) return structured('failed', '', { errors: ['Codex 未配置 API 连接'] });
    const provider = providers.getProvider(conn);
    const routed = providers.resolveModel({ agent: { model: cfg.model || adapter.model }, conn });
    try {
      const r = await provider.streamResponse({
        model: routed.model,
        system: 'You are Codex, an autonomous coding agent. Complete the task by producing the necessary code/changes. Reply concisely with the result.',
        messages: [{ role: 'user', content: taskText }],
        tools: undefined,
        signal: ctx.signal,
        onChunk: ctx.onChunk || (() => {})
      });
      return structured('completed', r.content || '', { model: r.responseModel || routed.model, modelSource: routed.source });
    } catch (e) {
      const cancelled = ctx.signal && ctx.signal.aborted;
      return structured(cancelled ? 'cancelled' : 'failed', '', { errors: [e.message], model: routed.model });
    }
  }
  return structured('failed', '', { errors: ['Codex 适配器未配置 CLI 路径或 API 连接'] });
}

// --------------------------------------------------------- WorkBuddy bridge
/**
 * Drive the user's already-logged-in WorkBuddy desktop app and return the real
 * answer. `bridgeOptions` lets tests inject a fake clock/sleep so the harness
 * runs in milliseconds instead of minutes.
 */
async function runWorkBuddyBridge(adapter, taskText, computerManager, ctx = {}) {
  if (!computerManager) return structured('failed', '', { errors: ['Computer 运行时不可用'] });
  const bridge = new DesktopAgentBridge({
    computer: computerManager,
    config: { windowMatch: /workbuddy/i, ...(adapter.config || {}) },
    signal: ctx.signal,
    sleep: ctx.sleep,
    now: ctx.now,
    // P0-4: without this the bridge can only read UI-automation text and gives
    // up on any window that exposes none.
    visionReader: ctx.visionReader || null,
    onState: (state, detail) => { if (ctx.onState) ctx.onState(state, detail); }
  });
  const res = await bridge.run(taskText);
  return structured(res.status, res.summary, {
    window: res.window, inputVia: res.inputVia, readVia: res.readVia, detection: res.detection,
    polls: res.polls, elapsedMs: res.elapsedMs, screenshot: res.screenshot || null,
    trace: res.trace, errors: res.errors || [], attempts: res.attempts,
    code: res.code, visionCalls: res.visionCalls, visionModel: res.visionModel,
    visionModelSource: res.visionModelSource, confidence: res.confidence
  });
}

// --------------------------------------------------------------------- HTTP
async function runHttpAgent(adapter, taskText, ctx = {}) {
  const cfg = adapter.config || {};
  const timeoutMs = Number(cfg.timeoutMs) || 120000;
  // Same abort contract as the model providers: one merged signal handed to
  // fetch(), so Stop kills the socket even while the body is still streaming.
  const link = linkSignals(timeoutMs, ctx.signal);
  try {
    const resp = await fetch(cfg.endpoint || adapter.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
      body: JSON.stringify({ task: taskText, ...(cfg.payload || {}) }),
      signal: link.signal
    });
    const txt = await resp.text();
    return structured(resp.ok ? 'completed' : 'failed', txt.slice(0, 4000), {
      httpStatus: resp.status,
      errors: resp.ok ? [] : [`HTTP ${resp.status}`]
    });
  } catch (e) {
    if (link.timedOut) return structured('timeout', '', { errors: [`HTTP 智能体超过 ${Math.round(timeoutMs / 1000)} 秒未响应`] });
    const cancelled = (ctx.signal && ctx.signal.aborted) || link.externallyAborted;
    return structured(cancelled ? 'cancelled' : 'failed', '', { errors: [cancelled ? '用户已停止' : e.message] });
  } finally { link.dispose(); }
}

/**
 * @param adapter external agent record (type='external')
 * @param taskText the task string
 * @param ctx ExternalAgentContext — see agent/subagent.js buildExternalContext():
 *   { projectId, projectRoot, conversationId, taskId, parentAgentId, signal,
 *     store, computerManager, permissionEngine, requestPermission,
 *     emit, onState, onChunk, sleep, now, visionReader }
 */
async function runExternalAgent(adapter, taskText, ctx = {}) {
  const scopes = externalAgentScopes(adapter);

  // Stop pressed before we even started.
  if (ctx.signal && ctx.signal.aborted) {
    return structured('cancelled', '', { errors: ['用户已停止'], requiredScopes: scopes });
  }

  // P0-2: the permission gate lives here as well as in the Agent Runtime.
  // runExternalAgent is also reachable from the IPC layer (the Agents page "run
  // now" button), and a gate that only exists on one of two paths is not a gate.
  if (ctx.permissionEngine) {
    const gate = await ensureScopes(
      ctx.permissionEngine,
      scopes,
      { taskId: ctx.taskId, projectId: ctx.projectId },
      ctx.requestPermission
        ? ({ scope }) => ctx.requestPermission({
            scope, tool: `external:${adapter.adapter_type}`, agent: adapter.name,
            external: true, conversationId: ctx.conversationId, taskId: ctx.taskId
          })
        : null
    );
    if (!gate.ok) {
      const raw = structured('failed', '', {
        code: 'PERMISSION_DENIED',
        requiredScopes: scopes,
        deniedScope: gate.scope,
        errors: [`外部智能体「${adapter.name}」需要权限 ${gate.scope}，${gate.reason === 'user_denied' ? '用户已拒绝' : '当前策略不允许'}`]
      });
      recordStatus(ctx.store, adapter, 'failed', `权限不足：${gate.scope}`);
      return raw;
    }
  }

  let raw;
  switch (adapter.adapter_type) {
    case 'codex': raw = await runCodex(adapter, taskText, ctx.store, ctx); break;
    case 'workbuddy': raw = await runWorkBuddyBridge(adapter, taskText, ctx.computerManager, ctx); break;
    case 'http': raw = await runHttpAgent(adapter, taskText, ctx); break;
    default: raw = structured('failed', '', { errors: ['未知外部智能体类型：' + adapter.adapter_type] });
  }
  let status = 'failed';
  try { status = JSON.parse(raw).status || 'failed'; } catch { /* keep failed */ }
  if (TERMINAL_STATES.includes(status)) {
    let err = '';
    try { err = (JSON.parse(raw).errors || [])[0] || ''; } catch { /* ignore */ }
    recordStatus(ctx.store, adapter, status, err);
  }
  return raw;
}

module.exports = {
  runExternalAgent, runCodex, runWorkBuddyBridge, runHttpAgent,
  killTree, resolveCodexCwd, TERMINAL_STATES, mapExternalResult
};
