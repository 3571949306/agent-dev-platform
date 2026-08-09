'use strict';
/**
 * v2.7.2 Agent Integration Hub — OpenCode 适配器（spec §4.3 / §11-§13 / §16-§29 / §58）。
 *
 * 相对 v2.7.1 的可靠性修正：
 *   - 引入共享 ExternalAgentTerminalGate，保证「终态一次」：达到 COMPLETED /
 *     FAILED / CANCELLED / TIMEOUT 后，任何晚期 event / SSE / promise 都无法覆盖。
 *   - SSE 在收到显式终态事件前意外断开（abrupt disconnect / half-open / 服务端错误）
 *     → FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL，绝不再误判为 COMPLETED（§12/§24）。
 *   - 超时与取消分离（§16/§18）：超时 -> TIMEOUT（abortReason='timeout'，发
 *     agent.run.timeout）；用户取消 -> CANCELLED（abortReason='user_cancel'，发
 *     agent.run.cancelled）。二者不再共用一个 AbortController 含义。
 *   - 晚期结果保护（§21）：取消 / 超时之后才到达的 session.completed 被闸门忽略。
 *   - 畸形事件阈值（§25）：连续 N 个不可解析事件 -> PROTOCOL_ERROR，单个不崩溃。
 *   - 远端错误分类（§27）：401/403->AUTH_FAILED，404 session->SESSION_NOT_FOUND，
 *     5xx->REMOTE_ERROR。
 *   - 终态恢复（§28/§29）：SSE 异常 EOF 时查询官方 session 状态，仅当服务器明确
 *     completed 才标 COMPLETED，否则 PROTOCOL_ERROR。
 *   - 统一结果契约 + 凭据脱敏（§39-§41），不再保留完整 raw。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, ERROR_CODE, AGENT_EVENT } = require('../hub/types');
const { OPENCODE } = require('../manifests/builtinAgents');
const { createOpenCodeServerManager } = require('../integrations/opencode/serverManager');
const { createOpenCodeClient } = require('../integrations/opencode/client');
const { mapOpenCodeEvent } = require('../integrations/opencode/eventStream');
const { createExternalAgentTerminalGate } = require('../runtime/externalTerminalGate');
const { buildExternalResult, sanitizeErrors } = require('../runtime/resultSanitizer');

const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 600000;
const MAX_MALFORMED_EVENTS = 5;

/**
 * OpenCode Agent 适配器。
 */
class OpenCodeAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] OpenCode manifest（缺省取内置 OPENCODE）
   * @param {object} [opts.store]    存储（保留接口，当前 OpenCode 不需要）
   * @param {object} [opts.serverManager] 可注入的 serverManager（测试用）
   */
  constructor({ manifest, store, serverManager } = {}) {
    super({ manifest: manifest || OPENCODE });
    this.store = store || null;
    this.serverManager = serverManager || createOpenCodeServerManager();
    this._runs = new Map();
    this._gate = createExternalAgentTerminalGate();
    this._detected = null;
  }

  getManifest() { return { ...this.manifest }; }

  /** 探测 opencode CLI 是否在 PATH。委托给 serverManager.detect()。 */
  async detect() {
    if (this._detected) return this._detected;
    let cliPath = null;
    try { cliPath = (await this.serverManager.detect()).path; } catch { cliPath = null; }
    let version = null;
    if (cliPath) {
      try { version = await this.serverManager.getVersion(); } catch { version = null; }
    }
    this._detected = {
      available: !!cliPath,
      installed: !!cliPath,
      configured: !!cliPath,
      version,
      path: cliPath
    };
    return this._detected;
  }

  /**
   * 健康检查。
   * @returns {Promise<{ status, version, latencyMs, detail, detection }>}
   */
  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return { status: HEALTH_STATE.UNAVAILABLE, version: null, latencyMs: Date.now() - start, detail: 'opencode CLI not found in PATH', detection: detected };
    }
    try {
      const version = await this.serverManager.getVersion();
      if (version) {
        return { status: HEALTH_STATE.HEALTHY, version, latencyMs: Date.now() - start, detail: 'opencode CLI responsive', detection: detected };
      }
      return { status: HEALTH_STATE.DEGRADED, version: null, latencyMs: Date.now() - start, detail: 'opencode --version returned empty', detection: detected };
    } catch (e) {
      return { status: HEALTH_STATE.DEGRADED, version: null, latencyMs: Date.now() - start, detail: `opencode --version failed: ${e.message}`, detection: detected };
    }
  }

  /**
   * 启动一次 OpenCode Run。
   * @param {object} task    { goal, projectRoot, projectId, model, agent, timeoutMs }
   * @param {object} context { signal, emit, finishRun, projectRoot, projectId, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('OpenCodeAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    const projectRoot = task.projectRoot || (context && context.projectRoot) || null;
    if (!projectRoot) {
      throw new Error('OpenCodeAgentAdapter.startTask: task.projectRoot 必填（OpenCode 必须在项目根运行）');
    }

    const detected = await this.detect();
    if (!detected.available) {
      throw new Error('OpenCodeAgentAdapter: opencode CLI not available; install opencode and ensure it is in PATH');
    }

    const runId = (context && context.runId) || crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      sessionId: null,
      projectRoot,
      taskText,
      client: null,
      abortReason: null,
      context: context || {},
      summary: '',
      errors: [],
      changedFiles: [],
      pendingTerminal: null,
      protocolError: false
    };
    this._runs.set(runId, runState);
    this._gate.init(runId, LIFECYCLE.STARTING);

    // 后台执行：仅当尚未进入终态时才以 FAILED 兜底（终态一次）
    this._executeRun(runId, task, context, ac.signal).catch(err => {
      const tr = this._finish(runId, LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR', this._buildResult(this._runs.get(runId), LIFECYCLE.FAILED, { extraErrors: [err && err.message ? err.message : String(err)] }));
      if (!tr.accepted) {
        // 已终态，仅补充错误记录
        const run = this._runs.get(runId);
        if (run) run.errors = sanitizeErrors([...(run.errors || []), err && err.message ? err.message : String(err)]);
      }
    });

    return { runId };
  }

  async _executeRun(runId, task, context, signal) {
    const run = this._runs.get(runId);
    if (!run) return;
    const taskText = run.taskText;
    const projectRoot = run.projectRoot;
    const timeoutMs = task.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;

    const serverInfo = await this.serverManager.start({ projectRoot, runId });
    const baseUrl = serverInfo.baseUrl;
    const client = createOpenCodeClient({ baseUrl, password: serverInfo.password });
    run.client = client;
    run.status = LIFECYCLE.RUNNING;

    // 超时定时器：超时 -> TIMEOUT（与取消分离）
    const timer = setTimeout(() => {
      const r = this._runs.get(runId);
      if (!r || this._gate.isTerminal(runId)) return;
      r.abortReason = 'timeout';
      const ctx = r.context || {};
      if (ctx.emit) { try { ctx.emit(AGENT_EVENT.RUN_TIMEOUT, { runId, agentId: this.manifest.id }); } catch { /* noop */ } }
      // 经闸门进入 TIMEOUT（terminal once），再 abort SSE/fetch
      this._finish(runId, LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT', this._buildResult(r, LIFECYCLE.TIMEOUT));
      try { r.ac.abort(); } catch { /* noop */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const session = await client.createSession({ title: task.title || taskText.slice(0, 80) }, { signal });
      run.sessionId = session && (session.id || session.sessionID) || null;
      if (!run.sessionId) throw new Error('opencode createSession returned no session id');

      await client.sendPromptAsync(run.sessionId, {
        parts: [{ type: 'text', text: taskText }],
        model: task.model || undefined,
        agent: task.agent || undefined
      }, { signal });

      await this._consumeEvents(run, context, signal);

      // 终态裁定（单一漏斗，terminal once）
      let status;
      let reason;
      if (this._gate.isTerminal(runId)) {
        status = this._gate.getStatus(runId);
        reason = this._gate.getState(runId).terminalReason;
      } else if (run.pendingTerminal) {
        status = run.pendingTerminal.status;
        reason = run.pendingTerminal.reason;
      } else if (run.ac.signal.aborted) {
        status = run.abortReason === 'timeout' ? LIFECYCLE.TIMEOUT : LIFECYCLE.CANCELLED;
        reason = run.abortReason === 'timeout' ? 'AGENT_TIMEOUT' : 'AGENT_CANCELLED';
      } else if (run.protocolError) {
        status = LIFECYCLE.FAILED;
        reason = 'AGENT_PROTOCOL_ERROR';
      } else {
        const recovered = await this._tryTerminalRecovery(run);
        status = recovered || LIFECYCLE.FAILED;
        reason = recovered ? 'AGENT_STREAM_RECOVERED' : 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL';
      }

      // 仅 COMPLETED 时拉取 diff
      let diff = [];
      let changedFiles = [];
      if (status === LIFECYCLE.COMPLETED) {
        try {
          diff = await client.getDiff(run.sessionId, undefined, { signal });
          changedFiles = extractChangedFiles(diff);
        } catch { /* diff 可选 */ }
      }

      this._finish(runId, status, reason, this._buildResult(run, status, { diff, changedFiles }));
    } catch (err) {
      const aborted = signal.aborted || run.ac.signal.aborted;
      let status;
      let reason;
      if (run.abortReason === 'timeout') {
        status = LIFECYCLE.TIMEOUT; reason = 'AGENT_TIMEOUT';
      } else if (aborted) {
        status = LIFECYCLE.CANCELLED; reason = 'AGENT_CANCELLED';
      } else if (err && err.httpStatus) {
        const code = err.httpStatus;
        if (code === 401 || code === 403) { status = LIFECYCLE.FAILED; reason = 'AGENT_AUTH_FAILED'; }
        else if (code === 404) { status = LIFECYCLE.FAILED; reason = 'AGENT_SESSION_NOT_FOUND'; }
        else if (code >= 500) { status = LIFECYCLE.FAILED; reason = 'AGENT_REMOTE_ERROR'; }
        else { status = LIFECYCLE.FAILED; reason = 'AGENT_PROTOCOL_ERROR'; }
      } else {
        status = LIFECYCLE.FAILED; reason = 'AGENT_REMOTE_ERROR';
      }
      this._finish(runId, status, reason, this._buildResult(run, status, { extraErrors: [err && err.message ? err.message : String(err)] }));
    } finally {
      if (timer) clearTimeout(timer);
      try { this.serverManager.release(projectRoot, runId); } catch { /* noop */ }
    }
  }

  /**
   * 消费 SSE 事件流直到终态 / 取消。
   * 处理：畸形事件阈值（§25）、终态仅记录 pending（晚期重复被忽略）、流中断不崩溃。
   */
  async _consumeEvents(run, context, signal) {
    const client = run.client;
    if (!client) return;
    const emit = context && context.emit;
    const agentId = this.manifest.id;
    const runId = run.runId;
    let consecutiveMalformed = 0;

    try {
      for await (const rawEvt of client.events({ signal })) {
        if (signal.aborted || run.ac.signal.aborted) break;
        const evt = mapOpenCodeEvent(rawEvt, runId, agentId);
        if (evt.unrecognized) {
          consecutiveMalformed++;
          run.errors = run.errors || [];
          run.errors.push(`unrecognized opencode event schema: ${evt.rawType}`);
          if (consecutiveMalformed >= MAX_MALFORMED_EVENTS) { run.protocolError = true; break; }
          continue; // 单个畸形事件不崩溃（§25）
        }
        consecutiveMalformed = 0;

        if (emit) { try { emit(evt.type, evt); } catch { /* listener must not break */ } }
        if (evt.type === 'agent.message' && evt.data) {
          const txt = typeof evt.data === 'string' ? evt.data : (evt.data.text || evt.data.content || evt.data.part || '');
          if (txt) run.summary = (run.summary || '') + String(txt);
        }
        if (evt.type === 'agent.run.failed' || evt.type === 'agent.tool.failed') {
          const em = (evt.data && (evt.data.error || evt.data.message)) || '';
          if (em) { run.errors = run.errors || []; run.errors.push(String(em)); }
        }
        if (evt.terminal) {
          // 仅记录 pending 终态，由 _executeRun 单一漏斗经闸门裁定（晚期重复被忽略）
          run.pendingTerminal = {
            status: evt.type === 'agent.run.completed' ? LIFECYCLE.COMPLETED
              : evt.type === 'agent.run.cancelled' ? LIFECYCLE.CANCELLED
              : LIFECYCLE.FAILED,
            reason: evt.type === 'agent.run.completed' ? 'AGENT_DONE'
              : evt.type === 'agent.run.cancelled' ? 'AGENT_CANCELLED'
              : 'AGENT_PROTOCOL_ERROR'
          };
          break;
        }
      }
    } catch (err) {
      if (!signal.aborted && !run.ac.signal.aborted && !this._gate.isTerminal(runId)) {
        run.errors = run.errors || [];
        run.errors.push(`SSE stream error: ${err && err.message ? err.message : String(err)}`);
        consecutiveMalformed++;
        if (consecutiveMalformed >= MAX_MALFORMED_EVENTS) run.protocolError = true;
      }
    }
  }

  /**
   * 终态恢复（§28/§29）：SSE 异常 EOF 后查询官方 session 状态。
   * 仅当服务器明确 completed 才返回 COMPLETED，否则返回 null。
   * @returns {Promise<string|null>}
   */
  async _tryTerminalRecovery(run) {
    try {
      if (!run.client || !run.sessionId) return null;
      const statusMap = await run.client.getSessionStatus(run.sessionId, { signal: run.ac.signal });
      const st = statusMap && statusMap[run.sessionId];
      if (st === 'completed') return LIFECYCLE.COMPLETED;
    } catch { /* 恢复查询失败，按无终态处理 */ }
    return null;
  }

  /**
   * 单一终态漏斗：经闸门 transition（terminal once）；仅首次进入终态时通知 Hub。
   * @returns {{ accepted:boolean, status:string, terminal:boolean, terminalCount:number }}
   */
  _finish(runId, status, reason, result) {
    const tr = this._gate.transition(runId, status, reason);
    const run = this._runs.get(runId);
    if (run) run.status = tr.status;
    const ctx = run && run.context;
    if (tr.accepted) {
      if (run) run.result = result || run.result || null;
      if (ctx && typeof ctx.finishRun === 'function') {
        try { ctx.finishRun(tr.status, run ? run.result : result); } catch { /* noop */ }
      }
    }
    return tr;
  }

  /** 统一结果契约（§39）+ 脱敏（§41）。 */
  _buildResult(run, status, extra = {}) {
    if (!run) return buildExternalResult({ agentId: this.manifest.id, runId: null, status: 'failed' });
    const errors = sanitizeErrors([...(run.errors || []), ...(extra.extraErrors || [])]);
    const result = buildExternalResult({
      agentId: this.manifest.id,
      runId: run.runId,
      status: status === LIFECYCLE.TIMEOUT ? 'timeout'
        : status === LIFECYCLE.CANCELLED ? 'cancelled'
        : status === LIFECYCLE.FAILED ? 'failed'
        : 'completed',
      summary: run.summary || '',
      findings: [],
      changedFiles: extra.changedFiles || run.changedFiles || [],
      diff: extra.diff || [],
      errors,
      durationMs: run.startedAt ? Date.now() - run.startedAt : null,
      provenance: { agent: 'opencode', transport: 'opencode-serve', sessionId: run.sessionId },
      startedAt: run.startedAt
    });
    result.sessionId = run.sessionId;
    return result;
  }

  /** sendMessage：通过 sync prompt 接口追加消息到同一 session。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run || !run.sessionId || !run.client) return { ok: false, error: 'no active opencode session to message' };
    if (run.ac.signal.aborted) return { ok: false, error: 'run aborted' };
    if (this._gate.isTerminal(runId)) return { ok: false, error: 'run already terminal' };
    try {
      const text = typeof message === 'string' ? message : (message && (message.text || message.goal)) || '';
      if (!text) return { ok: false, error: 'empty message' };
      await run.client.sendPromptSync(run.sessionId, { parts: [{ type: 'text', text }] }, { signal: run.ac.signal });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 取消：POST /session/:id/abort + abort SSE 流。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    run.abortReason = 'user_cancel';
    let remoteCancelled = false;
    if (run.sessionId && run.client) {
      try { remoteCancelled = await run.client.abort(run.sessionId, { signal: run.ac.signal }); } catch { /* fall through */ }
    }
    const tr = this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED', this._buildResult(run, LIFECYCLE.CANCELLED));
    const ctx = run.context || {};
    if (tr.accepted) {
      if (ctx.emit) { try { ctx.emit(AGENT_EVENT.RUN_CANCELLED, { runId, agentId: this.manifest.id }); } catch { /* noop */ } }
      try { run.ac.abort(); } catch { /* already aborted */ }
    }
    return { ok: true, cancelled: remoteCancelled };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: this._gate.getStatus(runId) || run.status, startedAt: run.startedAt, sessionId: run.sessionId };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：abort 所有在跑 Run + 释放所有受管 server。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try {
        if (run.sessionId && run.client && !run.ac.signal.aborted) {
          try { await run.client.abort(run.sessionId); } catch { /* noop */ }
        }
      } catch { /* noop */ }
      try { run.ac.abort(); } catch { /* noop */ }
      try { this.serverManager.release(run.projectRoot, run.runId); } catch { /* noop */ }
    }
    this._runs.clear();
    this._gate.clear();
    this._detected = null;
    try { await this.serverManager.dispose(); } catch { /* noop */ }
  }
}

/** 从 FileDiff[] 提取变更文件路径。 */
function extractChangedFiles(diffs) {
  if (!Array.isArray(diffs)) return [];
  const set = new Set();
  for (const d of diffs) {
    const p = d && (d.path || d.file || d.filename || d.name);
    if (p) set.add(String(p));
  }
  return [...set];
}

module.exports = { OpenCodeAgentAdapter, extractChangedFiles, MAX_MALFORMED_EVENTS };
