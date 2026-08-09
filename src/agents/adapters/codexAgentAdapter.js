'use strict';
/**
 * v2.6.0 Agent Integration Hub — Codex 适配器（spec §4.3）。
 *
 * 包装已有的 Codex 集成（src/services/externalAgents.js runCodex），
 * 让 Hub 路由层可以用统一 AgentAdapter 接口调度 Codex CLI / OpenAI 兼容模型。
 *
 * 设计要点：
 *  - 不重写 Codex 调用逻辑（已有 runCodex 处理 CLI 启动 / 超时 / killTree / 退出码），
 *    只做接口归一化：把统一 task/context 翻译成 runCodex 期望的 (adapter, taskText, store, ctx)。
 *  - runCodex 是 Promise<string>（JSON via structured()），startTask 不能 await 它，
 *    需立即返回 runId，后台执行；状态/结果通过 getStatus / getResult 查询。
 *  - 取消通过 AbortSignal：runCodex 内部已注册 signal.abort → killTree 的钩子，
 *    本适配器只需 ac.abort() 即可让 Codex 进程树被回收。
 *  - detect 用 resolveCliInPath('codex') 探测 PATH；healthCheck 跑 `codex --version`。
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { CODEX } = require('../manifests/builtinAgents');
const {
  runCodex,
  killTree,
  resolveCliInPath,
  resolveCodexCli,
  TERMINAL_STATES
} = require('../../services/externalAgents');

const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600000;

/** 把 runCodex 返回的 JSON 字符串解析为统一结果对象。 */
function parseCodexResult(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const status = TERMINAL_STATES.includes(parsed.status) ? parsed.status : 'failed';
    return {
      status,
      summary: parsed.summary || '',
      findings: parsed.findings || [],
      changedFiles: parsed.changedFiles || [],
      artifacts: parsed.artifacts || [],
      errors: parsed.errors || [],
      raw: parsed
    };
  } catch {
    return {
      status: 'failed',
      summary: String(raw || '').slice(0, 4000),
      findings: [], changedFiles: [], artifacts: [], errors: ['无法解析 Codex 返回结果']
    };
  }
}

class CodexAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] codex manifest（缺省取内置 CODEX）
   * @param {object} [opts.store]    连接存储（runCodex API 模式需要 store.connections.getDecrypted）
   */
  constructor({ manifest, store } = {}) {
    super({ manifest: manifest || CODEX });
    this.store = store || null;
    // runId -> { ac, status, result, startedAt, cliPath }
    this._runs = new Map();
    // detect 缓存
    this._detected = null;
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测 Codex CLI 是否在 PATH 里。
   * 同时尝试读版本号（用于路由层选型）。
   * @returns {Promise<{ available: boolean, version: string|null, path: string|null }>}
   */
  async detect() {
    if (this._detected) return this._detected;
    const cfg = this.manifest.config || this.config || {};
    let cliPath = null;
    try { cliPath = await resolveCodexCli(cfg); } catch { /* fallthrough to PATH */ }
    if (!cliPath) {
      try { cliPath = await resolveCliInPath('codex'); } catch { cliPath = null; }
    }
    let version = null;
    if (cliPath) {
      try { version = await this._readVersion(cliPath); } catch { version = null; }
    }
    this._detected = { available: !!cliPath, version, path: cliPath };
    return this._detected;
  }

  /**
   * 健康检查：跑 `codex --version`，限时 5s。
   * @returns {Promise<{ status: string, version: string|null, latencyMs: number, detail: string }>}
   */
  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: 'codex CLI not found in PATH'
      };
    }
    try {
      const version = await this._readVersion(detected.path);
      return {
        status: HEALTH_STATE.HEALTHY,
        version,
        latencyMs: Date.now() - start,
        detail: 'codex CLI responsive'
      };
    } catch (e) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: `codex --version failed: ${e.message}`
      };
    }
  }

  /** 跑 `${cliPath} --version`，限时 5s，返回 trimmed stdout。 */
  _readVersion(cliPath) {
    return new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawn(cliPath, ['--version'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(new Error('spawn failed: ' + e.message));
      }
      const timer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        reject(new Error('version command timed out'));
      }, HEALTH_TIMEOUT_MS);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`codex --version exited with code ${code}`));
      });
    });
  }

  /**
   * 启动一次 Codex Run。
   * 立即返回 runId；runCodex 在后台执行，状态/结果走 getStatus / getResult。
   *
   * @param {object} task    { goal, projectId, projectRoot, timeoutMs, model, args, cliPath, cliMode, connectionId }
   * @param {object} context { signal, onChunk, onState, projectRoot, projectId, store, visionReader, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('CodexAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;

    const runId = crypto.randomUUID();
    const ac = new AbortController();
    // 外部 signal（context.signal）联动到本 Run 的 AC。
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const cfg = {
      ...(this.manifest.config || {}),
      ...(this.config || {}),
      ...(task.config || {}),
      cliPath: task.cliPath || (this.manifest.config && this.manifest.config.cliPath) || (this.config && this.config.cliPath),
      cliMode: task.cliMode || (this.manifest.config && this.manifest.config.cliMode) || (this.config && this.config.cliMode),
      connectionId: task.connectionId || (this.manifest.config && this.manifest.config.connectionId) || (this.config && this.config.connectionId),
      model: task.model || (this.manifest.config && this.manifest.config.model) || (this.config && this.config.model),
      args: task.args || (this.manifest.config && this.manifest.config.args) || (this.config && this.config.args),
      cwd: task.cwd || task.projectRoot || context.projectRoot || (this.config && this.config.cwd),
      timeoutMs: task.timeoutMs || (this.config && this.config.timeoutMs) || DEFAULT_TIMEOUT_MS
    };

    // 兼容 runCodex 期望的 legacy adapter 形状
    const legacyAdapter = {
      id: this.manifest.id,
      name: this.manifest.displayName,
      adapter_type: 'codex',
      config: cfg,
      model: cfg.model || null,
      command: cfg.cliPath || 'codex'
    };

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      taskText,
      cfg
    };
    this._runs.set(runId, runState);

    // 后台执行（不 await），结果回写到 runState
    this._executeCodex(runId, legacyAdapter, taskText, ac.signal, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
    });

    return { runId };
  }

  async _executeCodex(runId, legacyAdapter, taskText, signal, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.status = LIFECYCLE.RUNNING;
    const store = (context && context.store) || this.store;
    const raw = await runCodex(legacyAdapter, taskText, store, {
      signal,
      onChunk: context && context.onChunk,
      onState: context && context.onState,
      projectId: (context && context.projectId) || null,
      projectRoot: (context && context.projectRoot) || null,
      conversationId: context && context.conversationId,
      taskId: context && context.taskId
    });
    const result = parseCodexResult(raw);
    // signal 已 abort 但 runCodex 仍返回 completed/failed 时，统一改写为 cancelled
    if (signal.aborted && result.status !== 'cancelled') {
      result.status = 'cancelled';
      if (!result.errors || !result.errors.length) result.errors = ['用户已停止'];
    }
    runState.status = this._mapToLifecycle(result.status);
    runState.result = result;
  }

  _mapToLifecycle(status) {
    switch (status) {
      case 'completed': return LIFECYCLE.COMPLETED;
      case 'failed': return LIFECYCLE.FAILED;
      case 'cancelled': return LIFECYCLE.CANCELLED;
      case 'timeout': return LIFECYCLE.TIMEOUT;
      case 'running': return LIFECYCLE.RUNNING;
      default: return LIFECYCLE.FAILED;
    }
  }

  /** sendMessage：Codex CLI 单次 exec 不支持运行中追加消息。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'codex CLI does not support mid-run messages' };
  }

  /**
   * 取消：abort signal → runCodex 内部已注册 killTree 钩子会回收进程树。
   * 这里不需要再持有 child 引用（runCodex 封装了进程生命周期）。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: run.status, startedAt: run.startedAt };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：取消所有在跑的 Codex run。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try {
        if (run.status === LIFECYCLE.RUNNING || run.status === LIFECYCLE.STARTING) {
          run.ac.abort();
        }
      } catch { /* non-fatal */ }
    }
    this._runs.clear();
    this._detected = null;
  }
}

module.exports = { CodexAgentAdapter, parseCodexResult };
