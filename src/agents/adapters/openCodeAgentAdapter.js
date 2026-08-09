'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenCode 适配器（spec §4.3）。
 *
 * OpenCode 通过 `opencode serve` 暴露 HTTP + SSE API。本适配器把它接入
 * 统一 AgentAdapter 接口：
 *
 *   detect()      → 探测 opencode CLI 是否在 PATH
 *   healthCheck() → server 在跑则探 /global/health；否则探 CLI --version
 *   startTask()   → 启动/复用 server → 建 session → prompt_async → 订阅 SSE
 *                   → 归一化事件 → context.emit → 等终态 → 取 diff → 返回结果
 *   cancel()      → POST /session/:id/abort + abort SSE 流
 *   dispose()     → 释放所有受管 server（引用计数清零才真正 kill）
 *
 * 设计要点：
 *   - cwd 永远是 task.projectRoot（绝不 home / process.cwd）
 *   - server 进程绑定 127.0.0.1，口令仅内存持有
 *   - 同一 projectRoot 的多个 Run 复用同一 server（serverManager 引用计数）
 *   - SSE 事件经 mapOpenCodeEvent 归一化后通过 context.emit 发射
 *   - 终态后拉取 /session/:id/diff 填充 changedFiles / diff
 *   - maxConcurrency = 2
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { OPENCODE } = require('../manifests/builtinAgents');
const { createOpenCodeServerManager } = require('../integrations/opencode/serverManager');
const { createOpenCodeClient } = require('../integrations/opencode/client');
const { mapOpenCodeEvent } = require('../integrations/opencode/eventStream');

const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 600000;

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
    // runId -> { ac, status, result, startedAt, sessionId, projectRoot, client, sseAbort }
    this._runs = new Map();
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
    this._detected = { available: !!cliPath, version, path: cliPath };
    return this._detected;
  }

  /**
   * 健康检查：server 在跑则探 /global/health；否则探 CLI --version。
   * @returns {Promise<{ status, version, latencyMs, detail }>}
   */
  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: 'opencode CLI not found in PATH'
      };
    }
    // 若有受管 server 在跑，直接探它的 /global/health
    // （serverManager.getServer 需要 projectRoot，这里没有特定 project，
    //   所以走 CLI 版本探测路径——更通用）
    try {
      const version = await this.serverManager.getVersion();
      if (version) {
        return {
          status: HEALTH_STATE.HEALTHY,
          version,
          latencyMs: Date.now() - start,
          detail: 'opencode CLI responsive'
        };
      }
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: 'opencode --version returned empty'
      };
    } catch (e) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: `opencode --version failed: ${e.message}`
      };
    }
  }

  /**
   * 启动一次 OpenCode Run。
   *
   * @param {object} task    { goal, projectRoot, projectId, model, agent, timeoutMs }
   * @param {object} context { signal, emit, finishRun, projectRoot, projectId, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('OpenCodeAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    // cwd 必须是 projectRoot，绝不 home
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
      sseAbort: null,
      terminal: false
    };
    this._runs.set(runId, runState);

    // 后台执行（不 await），结果回写到 runState
    this._executeRun(runId, task, context, ac.signal).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: [], diff: []
      };
      this._finish(context, runId, 'failed', runState.result);
    });

    return { runId };
  }

  async _executeRun(runId, task, context, signal) {
    const run = this._runs.get(runId);
    if (!run) return;
    const taskText = run.taskText;
    const projectRoot = run.projectRoot;
    const timeoutMs = task.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;

    // 1. 启动 / 复用 server（引用计数 +1）
    const serverInfo = await this.serverManager.start({ projectRoot, runId });
    const baseUrl = serverInfo.baseUrl;
    const client = createOpenCodeClient({ baseUrl, password: serverInfo.password });
    run.client = client;
    run.status = LIFECYCLE.RUNNING;

    // 超时定时器
    const timer = setTimeout(() => {
      try { run.ac.abort(); } catch { /* noop */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      // 2. 创建 session
      const session = await client.createSession({ title: task.title || taskText.slice(0, 80) }, { signal });
      run.sessionId = session && (session.id || session.sessionID) || null;
      if (!run.sessionId) {
        throw new Error('opencode createSession returned no session id');
      }

      // 3. 发送 prompt（async）
      await client.sendPromptAsync(run.sessionId, {
        parts: [{ type: 'text', text: taskText }],
        model: task.model || undefined,
        agent: task.agent || undefined
      }, { signal });

      // 4 + 5 + 6. 订阅 SSE → 归一化 → emit，直到终态或取消
      await this._consumeEvents(run, context, signal);

      // 7. 已收到终态（或在 SSE 断开时由 _consumeEvents 标记）
      // 8. 取 diff
      let diff = [];
      let changedFiles = [];
      try {
        diff = await client.getDiff(run.sessionId, undefined, { signal });
        changedFiles = extractChangedFiles(diff);
      } catch { /* diff 可选 */ }

      if (!run.terminal) {
        // SSE 断开但未收到显式终态事件：视为完成
        run.status = LIFECYCLE.COMPLETED;
      }

      const result = {
        status: lifecycleToResultStatus(run.status),
        summary: run.summary || '',
        findings: [],
        changedFiles,
        artifacts: [],
        errors: run.status === LIFECYCLE.FAILED ? (run.errors || ['opencode run failed']) : [],
        diff,
        sessionId: run.sessionId
      };
      run.result = result;
      this._finish(context, runId, result.status, result);
    } catch (err) {
      const aborted = signal.aborted || run.ac.signal.aborted;
      if (aborted) {
        run.status = LIFECYCLE.CANCELLED;
        run.result = {
          status: 'cancelled',
          summary: run.summary || '',
          errors: ['用户已停止'],
          findings: [], changedFiles: [], artifacts: [], diff: [],
          sessionId: run.sessionId
        };
      } else {
        run.status = LIFECYCLE.FAILED;
        run.result = {
          status: 'failed',
          summary: '',
          errors: [err && err.message ? err.message : String(err)],
          findings: [], changedFiles: [], artifacts: [], diff: [],
          sessionId: run.sessionId
        };
      }
      this._finish(context, runId, run.result.status, run.result);
    } finally {
      if (timer) clearTimeout(timer);
      // 释放 server 引用（refs--，清零才真正 kill）
      try { this.serverManager.release(projectRoot, runId); } catch { /* noop */ }
    }
  }

  /** 消费 SSE 事件流直到终态 / 取消。 */
  async _consumeEvents(run, context, signal) {
    const client = run.client;
    if (!client) return;
    const emit = context && context.emit;
    const agentId = this.manifest.id;

    try {
      for await (const rawEvt of client.events({ signal })) {
        if (signal.aborted || run.ac.signal.aborted) break;
        // 跳过 server.connected 等连接级事件（仍 emit，但不影响状态）
        const evt = mapOpenCodeEvent(rawEvt, run.runId, agentId);
        if (emit) {
          try { emit(evt.type, evt); } catch { /* listener must not break */ }
        }
        // 累积文本摘要
        if (evt.type === 'agent.message' && evt.data) {
          const txt = typeof evt.data === 'string'
            ? evt.data
            : (evt.data.text || evt.data.content || evt.data.part || '');
          if (txt) run.summary = (run.summary || '') + String(txt);
        }
        // 累积错误
        if (evt.type === 'agent.run.failed' || evt.type === 'agent.tool.failed') {
          const em = (evt.data && (evt.data.error || evt.data.message)) || '';
          if (em) { run.errors = run.errors || []; run.errors.push(String(em)); }
        }
        // 终态
        if (evt.terminal) {
          run.terminal = true;
          run.status = evt.type === 'agent.run.completed' ? LIFECYCLE.COMPLETED
            : evt.type === 'agent.run.cancelled' ? LIFECYCLE.CANCELLED
            : LIFECYCLE.FAILED;
          break;
        }
      }
    } catch (err) {
      // SSE 中断：若已被取消则忽略，否则记录错误（终态由调用方兜底）
      if (!signal.aborted && !run.ac.signal.aborted) {
        run.errors = run.errors || [];
        run.errors.push(`SSE stream error: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  /** 通知 Hub 终态（如果提供了 finishRun）。 */
  _finish(context, runId, status, result) {
    const run = this._runs.get(runId);
    if (run) run.status = resultStatusToLifecycle(status);
    if (context && typeof context.finishRun === 'function') {
      try { context.finishRun(status, result); } catch { /* noop */ }
    }
  }

  /** sendMessage：通过 sync prompt 接口追加消息到同一 session。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run || !run.sessionId || !run.client) {
      return { ok: false, error: 'no active opencode session to message' };
    }
    if (run.ac.signal.aborted) return { ok: false, error: 'run aborted' };
    try {
      const text = typeof message === 'string' ? message : (message && (message.text || message.goal)) || '';
      if (!text) return { ok: false, error: 'empty message' };
      await run.client.sendPromptSync(run.sessionId, {
        parts: [{ type: 'text', text }]
      }, { signal: run.ac.signal });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 取消：POST /session/:id/abort + abort SSE 流。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    // 远端 abort
    let remoteCancelled = false;
    if (run.sessionId && run.client) {
      try { remoteCancelled = await run.client.abort(run.sessionId, { signal: run.ac.signal }); }
      catch { /* fall through to local abort */ }
    }
    // 本地 abort SSE / fetch
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true, cancelled: remoteCancelled };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
      startedAt: run.startedAt,
      sessionId: run.sessionId
    };
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

function lifecycleToResultStatus(status) {
  switch (status) {
    case LIFECYCLE.COMPLETED: return 'completed';
    case LIFECYCLE.FAILED: return 'failed';
    case LIFECYCLE.CANCELLED: return 'cancelled';
    case LIFECYCLE.TIMEOUT: return 'timeout';
    default: return 'failed';
  }
}

function resultStatusToLifecycle(status) {
  switch (status) {
    case 'completed': return LIFECYCLE.COMPLETED;
    case 'failed': return LIFECYCLE.FAILED;
    case 'cancelled': return LIFECYCLE.CANCELLED;
    case 'timeout': return LIFECYCLE.TIMEOUT;
    default: return LIFECYCLE.FAILED;
  }
}

module.exports = { OpenCodeAgentAdapter, extractChangedFiles };
