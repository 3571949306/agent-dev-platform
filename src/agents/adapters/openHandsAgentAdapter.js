'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenHands 适配器（spec §4.3）。
 *
 * OpenHands Agent Server（FastAPI + uvicorn）提供 HTTP + WebSocket 接口。
 * 本适配器支持两种模式：
 *   - "remote"：用户配置的远端 server URL（config.serverUrl + 可选 apiKey）
 *   - "local" ：受管本地 server（探测 openhands-agent-server / python -m openhands.agent_server）
 *
 * 设计要点：
 *   - 不自动安装 OpenHands；detect 不到 → unavailable
 *   - working_dir 永远是 task.projectRoot（绝不 home）
 *   - 优先用 WebSocket 流式；不可用则降级 HTTP 轮询
 *   - 事件经 mapOpenHandsEvent 归一化后通过 context.emit 发射
 *   - maxConcurrency = 1
 *   - 取消：close WebSocket + DELETE conversation
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { OPENHANDS } = require('../manifests/builtinAgents');
const { createOpenHandsClient } = require('../integrations/openhands/serverClient');
const { mapOpenHandsEvent } = require('../integrations/openhands/eventStream');
const { resolveCliInPath, killTree } = require('../../services/externalAgents');

const VERSION_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 600000;

/**
 * OpenHands Agent 适配器。
 */
class OpenHandsAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] OpenHands manifest（缺省取内置 OPENHANDS）
   * @param {object} [opts.store]    存储（保留接口）
   * @param {object} [opts.config]   { serverUrl?, apiKey?, timeoutMs? }
   */
  constructor({ manifest, store, config } = {}) {
    super({ manifest: manifest || OPENHANDS, config });
    this.store = store || null;
    this._runs = new Map();
    this._detected = null;
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测 OpenHands 是否可用：
   *   - 检查 openhands-agent-server 命令
   *   - 检查 python -m openhands.agent_server --help
   *   - 若配置了 serverUrl，视为 remote 模式可用
   * @returns {Promise<{ available: boolean, version: string|null, path: string|null, mode?: string }>}
   */
  async detect() {
    if (this._detected) return this._detected;
    const cfg = this.config || {};
    let path = null;
    let version = null;
    let mode = null;

    // remote 模式：配置了 serverUrl
    if (cfg.serverUrl) {
      mode = 'remote';
      this._detected = { available: true, version: null, path: cfg.serverUrl, mode };
      return this._detected;
    }

    // local 模式：探测 CLI
    try { path = await resolveCliInPath('openhands-agent-server'); } catch { path = null; }
    if (!path) {
      // 尝试 python -m openhands.agent_server
      const py = await tryPythonModule();
      if (py) { path = py.path; version = py.version; }
    }
    if (path) {
      mode = 'local';
      if (!version) version = await readVersion(path);
    }
    this._detected = { available: !!path, version, path, mode };
    return this._detected;
  }

  /**
   * 健康检查：配置了 serverUrl 则探 /health；否则探 CLI。
   * @returns {Promise<{ status, version, latencyMs, detail }>}
   */
  async healthCheck() {
    const start = Date.now();
    const cfg = this.config || {};
    const detected = await this.detect();
    if (!detected.available && !cfg.serverUrl) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: 'openhands agent server not detected (no CLI and no serverUrl configured)'
      };
    }
    // 探 /health
    const serverUrl = cfg.serverUrl || null;
    if (serverUrl) {
      try {
        const client = createOpenHandsClient({ baseUrl: serverUrl, apiKey: cfg.apiKey });
        const r = await client.health({ signal: null });
        if (r.healthy) {
          return {
            status: HEALTH_STATE.HEALTHY,
            version: r.version,
            latencyMs: Date.now() - start,
            detail: 'openhands server healthy'
          };
        }
        return {
          status: HEALTH_STATE.UNAVAILABLE,
          version: null,
          latencyMs: Date.now() - start,
          detail: `openhands server unhealthy (HTTP ${r.httpStatus})`
        };
      } catch (e) {
        return {
          status: HEALTH_STATE.DEGRADED,
          version: null,
          latencyMs: Date.now() - start,
          detail: `openhands health check failed: ${e.message}`
        };
      }
    }
    // local 模式：CLI 版本探测
    if (detected.version) {
      return {
        status: HEALTH_STATE.HEALTHY,
        version: detected.version,
        latencyMs: Date.now() - start,
        detail: 'openhands CLI responsive'
      };
    }
    return {
      status: HEALTH_STATE.DEGRADED,
      version: null,
      latencyMs: Date.now() - start,
      detail: 'openhands detected but version unknown'
    };
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
    const projectRoot = task.projectRoot || (context && context.projectRoot) || null;
    if (!projectRoot) {
      throw new Error('OpenHandsAgentAdapter.startTask: task.projectRoot 必填（OpenHands 必须有 working_dir）');
    }

    const detected = await this.detect();
    const cfg = this.config || {};
    // remote 模式必须配置 serverUrl；local 模式需要 CLI
    if (!cfg.serverUrl && !detected.available) {
      throw new Error('OpenHandsAgentAdapter: openhands not available (no serverUrl and no local CLI detected)');
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
      conversationId: null,
      projectRoot,
      taskText,
      client: null,
      terminal: false
    };
    this._runs.set(runId, runState);

    this._executeRun(runId, taskText, projectRoot, context, ac.signal).catch(err => {
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

  async _executeRun(runId, taskText, projectRoot, context, signal) {
    const run = this._runs.get(runId);
    if (!run) return;
    const cfg = this.config || {};
    const timeoutMs = cfg.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;

    const serverUrl = cfg.serverUrl || null;
    if (!serverUrl) {
      // local 模式：本适配器不自动起 server（不自动安装）。
      // 若用户已自行启动 openhands agent server，可通过 config.serverUrl 指向它。
      // 否则视为不可用。
      throw new Error('OpenHandsAgentAdapter: local managed server not supported without config.serverUrl; set config.serverUrl to a running OpenHands Agent Server');
    }

    const client = createOpenHandsClient({ baseUrl: serverUrl, apiKey: cfg.apiKey });
    run.client = client;
    run.status = LIFECYCLE.RUNNING;

    const timer = setTimeout(() => {
      try { run.ac.abort(); } catch { /* noop */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      // 2. 创建 conversation，working_dir = projectRoot
      const conv = await client.createConversation({ working_dir: projectRoot }, { signal });
      run.conversationId = conv && (conv.conversation_id || conv.id) || null;
      if (!run.conversationId) {
        throw new Error('openhands createConversation returned no conversation_id');
      }

      // 3 + 4 + 5 + 6. WebSocket 流式（或 HTTP 轮询降级）→ 归一化 → emit
      await this._consumeEvents(run, taskText, context, signal);

      // 7. 已收到终态（或流断开兜底）
      if (!run.terminal) {
        run.status = LIFECYCLE.COMPLETED;
      }

      const result = {
        status: lifecycleToResultStatus(run.status),
        summary: run.summary || '',
        findings: [],
        changedFiles: run.changedFiles || [],
        artifacts: [],
        errors: run.status === LIFECYCLE.FAILED ? (run.errors || ['openhands run failed']) : [],
        diff: run.changedFiles || [],
        conversationId: run.conversationId
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
          findings: [], changedFiles: run.changedFiles || [], artifacts: [], diff: [],
          conversationId: run.conversationId
        };
      } else {
        run.status = LIFECYCLE.FAILED;
        run.result = {
          status: 'failed',
          summary: '',
          errors: [err && err.message ? err.message : String(err)],
          findings: [], changedFiles: run.changedFiles || [], artifacts: [], diff: [],
          conversationId: run.conversationId
        };
      }
      this._finish(context, runId, run.result.status, run.result);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 消费 WebSocket / 轮询事件流直到终态 / 取消。 */
  async _consumeEvents(run, taskText, context, signal) {
    const client = run.client;
    if (!client || !run.conversationId) return;
    const emit = context && context.emit;
    const agentId = this.manifest.id;
    run.changedFiles = run.changedFiles || [];

    try {
      for await (const rawEvt of client.websocketEvents(run.conversationId, { content: taskText, signal })) {
        if (signal.aborted || run.ac.signal.aborted) break;
        const evt = mapOpenHandsEvent(rawEvt, run.runId, agentId);
        if (emit) {
          try { emit(evt.type, evt); } catch { /* listener must not break */ }
        }
        // 累积消息摘要
        if (evt.type === 'agent.message' && evt.data) {
          const txt = typeof evt.data === 'string'
            ? evt.data
            : (evt.data.text || evt.data.content || '');
          if (txt) run.summary = (run.summary || '') + String(txt);
        }
        // 累积文件变更
        if (evt.type === 'agent.file.changed') {
          const p = (evt.data && (evt.data.path || evt.data.file || evt.data.filename)) || '';
          if (p && !run.changedFiles.includes(String(p))) run.changedFiles.push(String(p));
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
      if (!signal.aborted && !run.ac.signal.aborted) {
        run.errors = run.errors || [];
        run.errors.push(`event stream error: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  _finish(context, runId, status, result) {
    const run = this._runs.get(runId);
    if (run) run.status = resultStatusToLifecycle(status);
    if (context && typeof context.finishRun === 'function') {
      try { context.finishRun(status, result); } catch { /* noop */ }
    }
  }

  /** sendMessage：向运行中 conversation 追加消息。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run || !run.conversationId || !run.client) {
      return { ok: false, error: 'no active openhands conversation to message' };
    }
    if (run.ac.signal.aborted) return { ok: false, error: 'run aborted' };
    try {
      const text = typeof message === 'string' ? message : (message && (message.text || message.goal)) || '';
      if (!text) return { ok: false, error: 'empty message' };
      await run.client.sendMessage(run.conversationId, text, { signal: run.ac.signal });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 取消：close WebSocket + DELETE conversation。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    // 远端删除 conversation
    let deleted = false;
    if (run.conversationId && run.client) {
      try { deleted = await run.client.deleteConversation(run.conversationId, { signal: run.ac.signal }); }
      catch { /* fall through to local abort */ }
    }
    // 本地 abort（关闭 WebSocket / 停止轮询）
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true, cancelled: deleted };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
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
    for (const [, run] of this._runs) {
      try {
        if (run.conversationId && run.client && !run.ac.signal.aborted) {
          try { await run.client.deleteConversation(run.conversationId); } catch { /* noop */ }
        }
      } catch { /* noop */ }
      try { run.ac.abort(); } catch { /* noop */ }
    }
    this._runs.clear();
    this._detected = null;
  }
}

/** 探测 `python -m openhands.agent_server --help` 是否可用。 */
function tryPythonModule() {
  return new Promise((resolve) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    let child;
    try {
      child = spawn(py, ['-m', 'openhands.agent_server', '--help'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(null); }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', () => { /* ignore */ });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ path: `${py} -m openhands.agent_server`, version: extractVersion(out) });
      } else {
        resolve(null);
      }
    });
  });
}

/** 读取 openhands-agent-server --version。 */
function readVersion(cliPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath, ['--version'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(null); }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', () => { /* ignore */ });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
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

function resultStatusToLifecycle(status) {
  switch (status) {
    case 'completed': return LIFECYCLE.COMPLETED;
    case 'failed': return LIFECYCLE.FAILED;
    case 'cancelled': return LIFECYCLE.CANCELLED;
    case 'timeout': return LIFECYCLE.TIMEOUT;
    default: return LIFECYCLE.FAILED;
  }
}

module.exports = { OpenHandsAgentAdapter, tryPythonModule, readVersion };
