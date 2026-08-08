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
const { DesktopAgentBridge } = require('./desktopBridge');
// NOTE: do NOT require('../agent/subagent') here — subagent.js requires this
// module, so a top-level require creates a cycle and yields `undefined`
// bindings at load time. External adapters never recurse into sub-agents.

const TERMINAL_STATES = ['completed', 'failed', 'timeout', 'cancelled'];

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

// -------------------------------------------------------------------- Codex
async function runCodex(adapter, taskText, store, ctx = {}) {
  const cfg = adapter.config || {};
  const timeoutMs = Number(cfg.timeoutMs) || 600000;

  // Option A: official CLI
  if (cfg.cliPath && fs.existsSync(cfg.cliPath)) {
    return new Promise((resolve) => {
      const args = Array.isArray(cfg.args) && cfg.args.length ? [...cfg.args, taskText] : ['exec', '--', taskText];
      const child = spawn(cfg.cliPath, args, { windowsHide: true, cwd: cfg.cwd || undefined });
      let out = '', errOut = '', settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener?.('abort', onAbort);
        resolve(v);
      };
      const kill = () => { try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(() => {
        kill();
        done(structured('timeout', out.slice(0, 2000), {
          errors: [`Codex CLI 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`], exitCode: null
        }));
      }, timeoutMs);
      const onAbort = () => { kill(); done(structured('cancelled', out.slice(0, 2000), { errors: ['用户已停止'] })); };
      if (ctx.signal) {
        if (ctx.signal.aborted) { kill(); return done(structured('cancelled', '', { errors: ['用户已停止'] })); }
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', d => { out += d.toString(); if (ctx.onChunk) ctx.onChunk(d.toString()); });
      child.stderr.on('data', d => { errOut += d.toString(); });
      // An unhandled 'error' event on a ChildProcess throws and kills the app.
      child.on('error', e => done(structured('failed', '', { errors: ['Codex CLI 启动失败: ' + e.message] })));
      child.on('close', code => done(structured(
        code === 0 ? 'completed' : 'failed',
        (out || errOut).slice(0, 4000),
        { exitCode: code, errors: code === 0 ? [] : [`Codex CLI 退出码 ${code}${errOut ? '：' + errOut.slice(0, 300) : ''}`] }
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
    onState: (state, detail) => { if (ctx.onState) ctx.onState(state, detail); }
  });
  const res = await bridge.run(taskText);
  return structured(res.status, res.summary, {
    window: res.window, inputVia: res.inputVia, detection: res.detection,
    polls: res.polls, elapsedMs: res.elapsedMs, screenshot: res.screenshot || null,
    trace: res.trace, errors: res.errors || [], attempts: res.attempts
  });
}

// --------------------------------------------------------------------- HTTP
async function runHttpAgent(adapter, taskText, ctx = {}) {
  const cfg = adapter.config || {};
  const timeoutMs = Number(cfg.timeoutMs) || 120000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (ctx.signal) ctx.signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const resp = await fetch(cfg.endpoint || adapter.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
      body: JSON.stringify({ task: taskText, ...(cfg.payload || {}) }),
      signal: ac.signal
    });
    const txt = await resp.text();
    return structured(resp.ok ? 'completed' : 'failed', txt.slice(0, 4000), {
      httpStatus: resp.status,
      errors: resp.ok ? [] : [`HTTP ${resp.status}`]
    });
  } catch (e) {
    const cancelled = ctx.signal && ctx.signal.aborted;
    return structured(cancelled ? 'cancelled' : 'failed', '', { errors: [e.message] });
  } finally { clearTimeout(timer); }
}

/**
 * @param adapter external agent record (type='external')
 * @param taskText the task string
 * @param ctx { store, computerManager, signal, onState, onChunk, sleep, now }
 */
async function runExternalAgent(adapter, taskText, ctx = {}) {
  let raw;
  switch (adapter.adapter_type) {
    case 'codex': raw = await runCodex(adapter, taskText, ctx.store, ctx); break;
    case 'workbuddy': raw = await runWorkBuddyBridge(adapter, taskText, ctx.computerManager, ctx); break;
    case 'http': raw = await runHttpAgent(adapter, taskText, ctx); break;
    default: raw = structured('failed', '', { errors: ['未知外部 Agent 类型：' + adapter.adapter_type] });
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

module.exports = { runExternalAgent, runCodex, runWorkBuddyBridge, runHttpAgent, TERMINAL_STATES };
