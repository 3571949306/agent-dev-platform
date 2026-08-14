'use strict';
/**
 * v2.7.2 Agent Integration Hub — OpenHands 适配器（spec §4.3 / §11-§23 / §30-§34 / §39-§41）。
 *
 * OpenHands Agent Server（FastAPI + uvicorn）提供 HTTP + WebSocket 接口。
 *
 * 相对 v2.7.1 的可靠性修正：
 *   - 【§30-§33 运行时诚实性 · 方案 B】不再假装支持「受管本地 server」。
 *     本适配器不会自动安装/自动拉起 openhands agent server。因此：
 *       · 仅探测到 CLI（未配置 serverUrl）→ installed=true / configured=false / available=false
 *       · 配置 serverUrl 后                → installed=true / configured=true / available=true
 *     路由器只会挑选 available && healthy 的 Agent，绝不把「装了但没配」当可用。
 *   - 【§11-§13 终态闸门】引入共享 ExternalAgentTerminalGate，终态一次。
 *     删除 `if (!run.terminal) run.status = COMPLETED` 这一「无终态即成功」的谎报：
 *     事件流在没有显式终态事件的情况下结束 → FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL。
 *   - 【§16-§18 超时 / 取消分离】超时 → TIMEOUT（发 agent.run.timeout），
 *     用户取消 → CANCELLED（发 agent.run.cancelled）。二者不再共用一个 abort 语义。
 *   - 【§20-§22 晚期结果保护】取消 / 超时之后到达的 finished 事件被闸门忽略。
 *   - 【§27/§36 远端错误分类】401/403→AUTH_FAILED，404→SESSION_NOT_FOUND，5xx→REMOTE_ERROR。
 *   - 【§39-§41 统一结果契约】buildExternalResult + 凭据脱敏，不落完整 raw。
 *
 * 其他不变的约束：
 *   - working_dir 永远是 task.projectRoot（绝不 home）
 *   - 优先 WebSocket 流式；不可用则降级 HTTP 轮询
 *   - maxConcurrency = 1
 *   - 取消：DELETE conversation + close WebSocket / 停止轮询
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../hub/types');
const { OPENHANDS } = require('../manifests/builtinAgents');
const { createOpenHandsClient } = require('../integrations/openhands/serverClient');
const { mapOpenHandsEvent } = require('../integrations/openhands/eventStream');
const { createExternalAgentTerminalGate } = require('../runtime/externalTerminalGate');
const { buildExternalResult, sanitizeErrors } = require('../runtime/resultSanitizer');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const pathSecurity = require('../../security/pathSecurity');

const VERSION_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 600000;

/** §33 方案 B：未配置 serverUrl 时对外解释为什么不可用。 */
const NOT_CONFIGURED_DETAIL =
  'OpenHands Agent Server not configured. Managed local server is not supported; ' +
  'start an OpenHands Agent Server yourself and set config.serverUrl.';

/**
 * OpenHands Agent 适配器。
 */
class OpenHandsAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest]      OpenHands manifest（缺省取内置 OPENHANDS）
   * @param {object} [opts.store]         存储（保留接口）
   * @param {object} [opts.config]        { serverUrl?, apiKey?, timeoutMs? }
   * @param {Function} [opts.clientFactory] 可注入的 client 工厂（对抗性测试用）
   */
  constructor({ manifest, store, config, clientFactory, supervisor } = {}) {
    super({ manifest: manifest || OPENHANDS, config });
    this.store = store || null;
    this._runs = new Map();
    this._gate = createExternalAgentTerminalGate();
    this._detected = null;
    this._clientFactory = clientFactory || createOpenHandsClient;
    this.supervisor = supervisor || createCliProcessSupervisor();
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测（§30-§33 方案 B / §51 检测与健康分离）。
   *
   * 返回的三态含义严格区分：
   *   installed  — 机器上存在 openhands（CLI / python module），或已给出 serverUrl
   *   configured — 已配置可连接的 serverUrl
   *   available  — 真的能跑任务 = configured（受管本地 server 不支持）
   *
   * @returns {Promise<{ available, installed, configured, version, path, mode, detail }>}
   */
  async detect() {
    if (this._detected) return this._detected;
    const cfg = this.config || {};

    // 已配置 serverUrl → remote 模式，可用
    if (cfg.serverUrl) {
      this._detected = {
        available: true,
        installed: true,
        configured: true,
        version: null,
        path: cfg.serverUrl,
        mode: 'remote',
        detail: 'openhands remote agent server configured'
      };
      return this._detected;
    }

    // 未配置 serverUrl：探测本地安装情况，但一律不可用（方案 B）
    let path = null;
    let version = null;
    try { path = (await this.supervisor.detect('openhands-agent-server')).path; } catch { path = null; }
    if (!path) {
      const py = await tryPythonModule(this.supervisor);
      if (py) { path = py.path; version = py.version; }
    }
    if (path && !version) version = await readVersion(path, this.supervisor);

    this._detected = {
      available: false,
      installed: !!path,
      configured: false,
      version,
      path,
      mode: null,
      detail: path
        ? `openhands installed but not configured. ${NOT_CONFIGURED_DETAIL}`
        : 'openhands not installed (no CLI, no python module) and no serverUrl configured'
    };
    return this._detected;
  }

  /**
   * 健康检查（§50-§52：健康只描述「现在能不能连通」，不承担 detection 语义）。
   * @returns {Promise<{ status, version, latencyMs, detail, detection }>}
   */
  async healthCheck() {
    const start = Date.now();
    const cfg = this.config || {};
    const detection = await this.detect();

    // 未配置 → 一律 UNAVAILABLE（哪怕本地装了 CLI，也不谎报 healthy）
    if (!detection.configured) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: detection.version || null,
        latencyMs: Date.now() - start,
        detail: detection.detail,
        detection
      };
    }

    try {
      const client = this._clientFactory({ baseUrl: cfg.serverUrl, apiKey: cfg.apiKey });
      const r = await client.health({ signal: null });
      if (r.healthy) {
        return {
          status: HEALTH_STATE.HEALTHY,
          version: r.version,
          latencyMs: Date.now() - start,
          detail: 'openhands server healthy',
          detection
        };
      }
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: `openhands server unhealthy (HTTP ${r.httpStatus})`,
        detection
      };
    } catch (e) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: `openhands health check failed: ${e.message}`,
        detection
      };
    }
  }

  /**
   * 启动一次 OpenHands Run。
   *
   * @param {object} task    { goal, projectRoot, projectId, timeoutMs }
   * @param {object} context { signal, emit, finishRun, projectRoot, projectId, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('OpenHandsAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    // working_dir 必须是 projectRoot，绝不 home
    const requestedRoot = task.projectRoot || (context && context.projectRoot) || null;
    const projectRoot = requestedRoot && context.productionHub
      ? pathSecurity.canonicalizeRoot(requestedRoot)
      : requestedRoot;
    if (!projectRoot) {
      throw new Error('OpenHandsAgentAdapter.startTask: task.projectRoot 必填（OpenHands 必须有 working_dir）');
    }

    const detected = await this.detect();
    // §33 方案 B：没有 serverUrl 就是不可用，绝不进入「假装本地受管」的分支
    if (!detected.available) {
      throw new Error(
        `OpenHandsAgentAdapter: openhands not available ` +
        `(installed=${detected.installed}, configured=${detected.configured}). ${NOT_CONFIGURED_DETAIL}`
      );
    }

    const runId = (context && context.runId) || crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try {
          context.signal.addEventListener('abort', () => {
            const r = this._runs.get(runId);
            // 父级取消：与超时区分（§16）
            if (r && !r.abortReason) r.abortReason = 'parent_cancel';
            ac.abort();
          }, { once: true });
        } catch { /* noop */ }
      }
    }

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      conversationId: null,
      projectRoot,
      taskText,
      client: null,
      context: context || {},
      abortReason: null,       // 'user_cancel' | 'timeout' | 'parent_cancel' | 'shutdown'
      pendingTerminal: null,   // 来自事件流的终态（由单一漏斗裁定）
      summary: '',
      errors: [],
      changedFiles: []
    };
    this._runs.set(runId, runState);
    this._gate.init(runId, LIFECYCLE.STARTING);

    runState.executionPromise = this._executeRun(runId, taskText, projectRoot, context, ac.signal).catch(err => {
      const run = this._runs.get(runId);
      const msg = err && err.message ? err.message : String(err);
      const tr = this._finish(runId, LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR',
        this._buildResult(run, LIFECYCLE.FAILED, { extraErrors: [msg] }));
      if (!tr.accepted && run) {
        run.errors = sanitizeErrors([...(run.errors || []), msg]);
      }
      return runState.result;
    });

    return { runId };
  }

  async _executeRun(runId, taskText, projectRoot, context, signal) {
    const run = this._runs.get(runId);
    if (!run) return;
    const cfg = this.config || {};
    const timeoutMs = cfg.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;
    const serverUrl = cfg.serverUrl || null;

    // 防御：detect 已挡住，这里再兜一层（§33 明确不支持受管本地 server）
    if (!serverUrl) {
      throw new Error(
        'OpenHandsAgentAdapter: local managed server not supported without config.serverUrl; ' +
        'set config.serverUrl to a running OpenHands Agent Server'
      );
    }

    const client = this._clientFactory({ baseUrl: serverUrl, apiKey: cfg.apiKey });
    run.client = client;
    run.status = LIFECYCLE.RUNNING;
    run.executionStarted = true;

    // 超时定时器：超时 -> TIMEOUT（与取消分离，§17/§18）
    const timer = setTimeout(() => {
      const r = this._runs.get(runId);
      if (!r || this._gate.isTerminal(runId)) return;
      r.abortReason = 'timeout';
      const ctx = r.context || {};
      if (ctx.emit) {
        try { ctx.emit(AGENT_EVENT.RUN_TIMEOUT, { runId, agentId: this.manifest.id }); } catch { /* noop */ }
      }
      this._finish(runId, LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT', this._buildResult(r, LIFECYCLE.TIMEOUT));
      try { r.ac.abort(); } catch { /* noop */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      // 创建 conversation，working_dir = projectRoot
      const conv = await client.createConversation({ working_dir: projectRoot }, { signal });
      run.conversationId = (conv && (conv.conversation_id || conv.id)) || null;
      if (!run.conversationId) {
        throw new Error('openhands createConversation returned no conversation_id');
      }

      // WebSocket 流式（或 HTTP 轮询降级）→ 归一化 → emit
      await this._consumeEvents(run, taskText, context, signal);

      // 终态裁定（单一漏斗，terminal once）——绝不再有「没终态就算成功」
      let status;
      let reason;
      if (this._gate.isTerminal(runId)) {
        status = this._gate.getStatus(runId);
        reason = (this._gate.getState(runId) || {}).terminalReason || null;
      } else if (run.pendingTerminal) {
        status = run.pendingTerminal.status;
        reason = run.pendingTerminal.reason;
      } else if (run.ac.signal.aborted || signal.aborted) {
        status = run.abortReason === 'timeout' ? LIFECYCLE.TIMEOUT : LIFECYCLE.CANCELLED;
        reason = run.abortReason === 'timeout' ? 'AGENT_TIMEOUT' : 'AGENT_CANCELLED';
      } else {
        // §12/§13：事件流结束但没有任何显式终态证据 → 失败，不是成功
        status = LIFECYCLE.FAILED;
        reason = 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL';
        run.errors.push('openhands event stream ended without a terminal event');
      }

      this._finish(runId, status, reason, this._buildResult(run, status));
    } catch (err) {
      const { status, reason } = this._classifyFailure(run, err, signal);
      this._finish(runId, status, reason,
        this._buildResult(run, status, { extraErrors: [err && err.message ? err.message : String(err)] }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 失败分类（§16/§18/§27/§36）：取消 / 超时 / 鉴权 / 会话丢失 / 远端错误。
   * @returns {{ status: string, reason: string }}
   */
  _classifyFailure(run, err, signal) {
    const aborted = (signal && signal.aborted) || (run && run.ac.signal.aborted);
    const reasonTag = run && run.abortReason;
    if (reasonTag === 'timeout') {
      return { status: LIFECYCLE.TIMEOUT, reason: 'AGENT_TIMEOUT' };
    }
    // 取消意图一旦确立即优先，哪怕 abort 尚未生效（避免把「删会话导致的 404」误报为远端故障）
    if (reasonTag === 'user_cancel' || reasonTag === 'parent_cancel' || reasonTag === 'shutdown' || aborted) {
      return { status: LIFECYCLE.CANCELLED, reason: 'AGENT_CANCELLED' };
    }
    const code = err && err.httpStatus;
    if (code === 401 || code === 403) return { status: LIFECYCLE.FAILED, reason: 'AGENT_AUTH_FAILED' };
    if (code === 404) return { status: LIFECYCLE.FAILED, reason: 'AGENT_SESSION_NOT_FOUND' };
    if (code && code >= 500) return { status: LIFECYCLE.FAILED, reason: 'AGENT_REMOTE_ERROR' };
    if (err && err.streamEnded) {
      return { status: LIFECYCLE.FAILED, reason: 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL' };
    }
    return { status: LIFECYCLE.FAILED, reason: 'AGENT_REMOTE_ERROR' };
  }

  /**
   * 消费 WebSocket / 轮询事件流直到终态 / 取消。
   * 终态只记录 pendingTerminal，由 _executeRun 单一漏斗经闸门裁定（晚期事件被忽略）。
   */
  async _consumeEvents(run, taskText, context, signal) {
    const client = run.client;
    if (!client || !run.conversationId) return;
    const emit = context && context.emit;
    const agentId = this.manifest.id;
    run.changedFiles = run.changedFiles || [];

    for await (const rawEvt of client.websocketEvents(run.conversationId, { content: taskText, signal })) {
      if (signal.aborted || run.ac.signal.aborted) break;
      const evt = mapOpenHandsEvent(rawEvt, run.runId, agentId);
      if (emit) {
        try { emit(evt.type, evt); } catch { /* listener must not break */ }
      }
      // 累积消息摘要
      if (evt.type === AGENT_EVENT.MESSAGE && evt.data) {
        const txt = typeof evt.data === 'string'
          ? evt.data
          : (evt.data.text || evt.data.content || '');
        if (txt) run.summary = (run.summary || '') + String(txt);
      }
      // 累积文件变更
      if (evt.type === AGENT_EVENT.FILE_CHANGED) {
        const p = (evt.data && (evt.data.path || evt.data.file || evt.data.filename)) ||
          (evt.rawMetadata && evt.rawMetadata.path) || '';
        if (p && !run.changedFiles.includes(String(p))) run.changedFiles.push(String(p));
      }
      // 累积错误
      if (evt.type === AGENT_EVENT.RUN_FAILED || evt.type === AGENT_EVENT.TOOL_FAILED) {
        const em = (evt.data && (evt.data.error || evt.data.message)) || '';
        if (em) run.errors.push(String(em));
      }
      // 终态：只记录，不直接落地（§21 晚期结果由闸门裁决）
      if (evt.terminal) {
        run.pendingTerminal = {
          status: evt.type === AGENT_EVENT.RUN_COMPLETED ? LIFECYCLE.COMPLETED
            : evt.type === AGENT_EVENT.RUN_CANCELLED ? LIFECYCLE.CANCELLED
            : LIFECYCLE.FAILED,
          reason: evt.type === AGENT_EVENT.RUN_COMPLETED ? 'AGENT_DONE'
            : evt.type === AGENT_EVENT.RUN_CANCELLED ? 'AGENT_CANCELLED'
            : 'AGENT_RUN_FAILED'
        };
        break;
      }
    }
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
        try { ctx.finishRun(lifecycleToResultStatus(tr.status), run ? run.result : result); } catch { /* noop */ }
      }
    }
    return tr;
  }

  /** 统一结果契约（§39）+ 凭据脱敏（§41）。 */
  _buildResult(run, status, extra = {}) {
    if (!run) {
      return buildExternalResult({ agentId: this.manifest.id, runId: null, status: 'failed' });
    }
    const errors = sanitizeErrors([...(run.errors || []), ...(extra.extraErrors || [])]);
    const result = buildExternalResult({
      agentId: this.manifest.id,
      runId: run.runId,
      status: lifecycleToResultStatus(status),
      summary: run.summary || '',
      findings: [],
      changedFiles: extra.changedFiles || run.changedFiles || [],
      diff: extra.diff || run.changedFiles || [],
      errors,
      durationMs: run.startedAt ? Date.now() - run.startedAt : null,
      provenance: {
        agent: 'openhands',
        transport: 'http',
        conversationId: run.conversationId
      },
      startedAt: run.startedAt
    });
    result.conversationId = run.conversationId;
    return result;
  }

  /** sendMessage：向运行中 conversation 追加消息。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run || !run.conversationId || !run.client) {
      return { ok: false, error: 'no active openhands conversation to message' };
    }
    if (run.ac.signal.aborted) return { ok: false, error: 'run aborted' };
    if (this._gate.isTerminal(runId)) return { ok: false, error: 'run already terminal' };
    try {
      const text = typeof message === 'string' ? message : (message && (message.text || message.goal)) || '';
      if (!text) return { ok: false, error: 'empty message' };
      await run.client.sendMessage(run.conversationId, text, { signal: run.ac.signal });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 取消（§16/§18）：标记 user_cancel → DELETE conversation → 闸门 CANCELLED → abort 流。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    run.abortReason = 'user_cancel';

    let deleted = false;
    if (run.conversationId && run.client) {
      try { deleted = await run.client.deleteConversation(run.conversationId, { signal: run.ac.signal }); }
      catch { /* fall through to local abort */ }
    }

    try { run.ac.abort(); } catch { /* already aborted */ }
    const q = await this.awaitQuiescence(runId, 10000);
    if (q.quiesced && !this._gate.isTerminal(runId)) {
      this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED',
        this._buildResult(run, LIFECYCLE.CANCELLED, { extraErrors: ['用户已停止'] }));
    }
    if (q.quiesced && this._gate.getStatus(runId) === LIFECYCLE.CANCELLED && !run.cancelEventEmitted) {
      run.cancelEventEmitted = true;
      const ctx = run.context || {};
      if (ctx.emit) {
        try { ctx.emit(AGENT_EVENT.RUN_CANCELLED, { runId, agentId: this.manifest.id }); } catch { /* noop */ }
      }
    }
    return { ok: q.quiesced, cancelled: deleted, status: q.quiesced ? 'cancelled' : 'cancelling', quiesced: q.quiesced, residual: q.residual, detail: q.detail };
  }

  async awaitQuiescence(runId, timeoutMs = 10000) {
    const run = this._runs.get(runId);
    if (!run) return { quiesced: false, residual: 'unknown runId', detail: 'unknown runId' };
    if (!run.executionPromise) return { quiesced: true, residual: 0, detail: 'OpenHands run not executing' };
    let timer;
    const settled = await Promise.race([
      run.executionPromise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
    return settled
      ? { quiesced: true, residual: 0, detail: 'OpenHands stream closed' }
      : { quiesced: false, residual: { runId, conversationId: run.conversationId }, detail: 'OpenHands stream still active' };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: this._gate.getStatus(runId) || run.status,
      startedAt: run.startedAt,
      conversationId: run.conversationId
    };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：abort 所有在跑 Run。 */
  async dispose() {
    for (const [runId, run] of this._runs) {
      try {
        if (!run.abortReason) run.abortReason = 'shutdown';
        if (run.conversationId && run.client && !run.ac.signal.aborted) {
          try { await run.client.deleteConversation(run.conversationId); } catch { /* noop */ }
        }
      } catch { /* noop */ }
      try { run.ac.abort(); } catch { /* noop */ }
      try { this._gate.remove(runId); } catch { /* noop */ }
    }
    this._runs.clear();
    this._gate.clear();
    this._detected = null;
    this.supervisor.dispose();
  }
}

/** 探测 `python -m openhands.agent_server --help` 是否可用。 */
async function tryPythonModule(supervisor = createCliProcessSupervisor()) {
  try {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const handle = await supervisor.spawnProcess({
      command: py, args: ['-m', 'openhands.agent_server', '--help'],
      env: buildEnvAllowlist(), timeoutMs: VERSION_TIMEOUT_MS
    });
    const exit = await handle.done;
    return exit.code === 0
      ? { path: `${py} -m openhands.agent_server`, version: extractVersion(handle.stdout) }
      : null;
  } catch { return null; }
}

/** 读取 openhands-agent-server --version。 */
function readVersion(cliPath, supervisor = createCliProcessSupervisor()) {
  return supervisor.readVersion(cliPath, ['--version'], VERSION_TIMEOUT_MS).catch(() => null);
}

function extractVersion(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function lifecycleToResultStatus(status) {
  switch (status) {
    case LIFECYCLE.COMPLETED: return 'completed';
    case LIFECYCLE.FAILED: return 'failed';
    case LIFECYCLE.CANCELLED: return 'cancelled';
    case LIFECYCLE.TIMEOUT: return 'timeout';
    default: return 'failed';
  }
}

module.exports = { OpenHandsAgentAdapter, tryPythonModule, readVersion, NOT_CONFIGURED_DETAIL };
