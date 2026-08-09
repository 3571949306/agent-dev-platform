'use strict';
/**
 * v2.7.0 Agent Integration Hub — Cline SDK 适配器（spec §4.3）。
 *
 * 包装 @cline/sdk（ESM-only）接入统一 AgentAdapter 接口。通过 sdkBridge 动态
 * import SDK，使主进程（CJS）能在不安装 SDK 时也正常加载（detect 返回 unavailable）。
 *
 * 设计要点：
 *  - 不在启动时加载 SDK：sdkBridge.loadSdk() 是 lazy 的，probeSdk 失败即标记不可用。
 *  - detect / healthCheck 用 probeSdk() 判定 @cline/sdk 是否安装。
 *  - startTask：connectionId → store.connections.getDecrypted → configMapper →
 *    sdkBridge.createAgent → agent.subscribe(事件映射 → context.emit) → agent.run(goal)。
 *    agent.run() 阻塞到 turn 结束，故后台执行，立即返回 runId；结果回写 runState。
 *  - 取消：AbortController + agent.cancel()（如果 SDK 暴露）。context.signal 联动到本 Run AC。
 *  - projectRoot 取自 task.projectRoot / context.projectRoot，绝不回退到 home 目录。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { CLINE } = require('../manifests/builtinAgents');
const { probeSdk, createAgent } = require('../integrations/cline/sdkBridge');
const { mapClineEvent } = require('../integrations/cline/eventMapper');
const { mapConnection } = require('../integrations/cline/configMapper');

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * 把 agent.run() 返回的 { text, usage, iterations } 解析为统一结果对象。
 */
function parseClineResult(raw, status) {
  const r = raw || {};
  return {
    status: status || 'completed',
    summary: typeof r.text === 'string' ? r.text : '',
    findings: [],
    changedFiles: [],
    artifacts: [],
    errors: [],
    usage: r.usage || null,
    iterations: r.iterations != null ? r.iterations : 0,
    raw: r
  };
}

class ClineAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] cline manifest（缺省取内置 CLINE）
   * @param {object} [opts.store]    连接存储（store.connections.getDecrypted 解密 API 连接）
   */
  constructor({ manifest, store } = {}) {
    super({ manifest: manifest || CLINE });
    this.store = store || null;
    // runId -> { ac, status, result, startedAt, agent, projectRoot, taskText }
    this._runs = new Map();
    // detect 缓存
    this._detected = null;
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测 @cline/sdk 是否已安装。
   * @returns {Promise<{ available: boolean, version: string|null, error: string|null }>}
   */
  async detect() {
    if (this._detected) return this._detected;
    const probe = await probeSdk();
    this._detected = {
      available: !!probe.available,
      version: probe.version,
      error: probe.error
    };
    return this._detected;
  }

  /**
   * 健康检查：probeSdk 判定 SDK 可用性。
   * @returns {Promise<{ status: string, version: string|null, latencyMs: number, detail: string }>}
   */
  async healthCheck() {
    const start = Date.now();
    const probe = await probeSdk();
    const latencyMs = Date.now() - start;
    if (probe.available) {
      return {
        status: HEALTH_STATE.HEALTHY,
        version: probe.version,
        latencyMs,
        detail: '@cline/sdk available'
      };
    }
    return {
      status: HEALTH_STATE.UNAVAILABLE,
      version: null,
      latencyMs,
      detail: probe.error ? `@cline/sdk unavailable: ${probe.error}` : '@cline/sdk not installed'
    };
  }

  /**
   * 启动一次 Cline Run。
   * 立即返回 runId；agent.run() 在后台执行，状态/结果走 getStatus / getResult。
   *
   * @param {object} task    { goal, connectionId, model, systemPrompt?, maxIterations?, projectRoot }
   * @param {object} context { signal, emit, finishRun, projectRoot, projectId, store, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('ClineAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;

    // SDK 必须可用
    const detected = await this.detect();
    if (!detected.available) {
      throw new Error('ClineAgentAdapter: @cline/sdk 未安装，无法启动任务');
    }

    // 解析 API 连接：task.connectionId → store.connections.getDecrypted
    const store = (context && context.store) || this.store;
    const connectionId = task.connectionId || (this.config && this.config.connectionId);
    let connection = null;
    if (connectionId && store && store.connections && typeof store.connections.getDecrypted === 'function') {
      try { connection = store.connections.getDecrypted(connectionId); } catch { /* leave null */ }
    }
    if (!connection) {
      throw new Error(`ClineAgentAdapter: 未找到 API 连接 (connectionId=${connectionId || 'null'})`);
    }

    const model = task.model || (this.config && this.config.model) || null;
    const clineConfig = mapConnection(connection, model);
    if (!clineConfig) {
      throw new Error('ClineAgentAdapter: API 连接映射失败');
    }

    // projectRoot 取自 task / context，绝不回退到 home 目录
    const projectRoot = task.projectRoot || (context && context.projectRoot) || null;

    const runId = (context && context.runId) || crypto.randomUUID();
    const ac = new AbortController();
    // 外部 signal（context.signal）联动到本 Run 的 AC。
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
      agent: null,
      projectRoot,
      taskText
    };
    this._runs.set(runId, runState);

    // 后台执行（不 await），结果回写到 runState
    this._executeCline(runId, clineConfig, taskText, task, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      if (context && typeof context.finishRun === 'function') {
        try { context.finishRun('failed', runState.result); } catch { /* noop */ }
      }
    });

    return { runId };
  }

  async _executeCline(runId, clineConfig, taskText, task, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.status = LIFECYCLE.RUNNING;

    // 事件回调：Cline 原生事件 → eventMapper → context.emit
    const onEvent = (rawEvent) => {
      let mapped = null;
      try { mapped = mapClineEvent(rawEvent, runId, this.manifest.id); } catch { /* drop malformed */ }
      if (!mapped) return;
      if (context && typeof context.emit === 'function') {
        try { context.emit(mapped.type, mapped.data); } catch { /* listener must not break the run */ }
      }
      // 终态事件同步生命周期
      if (mapped.type === 'agent.run.failed' && runState.status === LIFECYCLE.RUNNING) {
        runState.status = LIFECYCLE.FAILED;
      }
    };

    const agentConfig = {
      providerId: clineConfig.providerId,
      modelId: clineConfig.modelId,
      apiKey: clineConfig.apiKey,
      systemPrompt: task.systemPrompt || (this.config && this.config.systemPrompt) || undefined,
      maxIterations: task.maxIterations || (this.config && this.config.maxIterations) || DEFAULT_MAX_ITERATIONS
    };

    const agent = await createAgent(agentConfig, onEvent);
    runState.agent = agent;

    // SDK 可能同时支持 subscribe —— 注册同一回调以兼容只走 subscribe 的实现
    if (agent && typeof agent.subscribe === 'function') {
      try { agent.subscribe(onEvent); } catch { /* already wired via onEvent */ }
    }

    // 已在等待期间被取消
    if (runState.ac.signal.aborted) {
      this._cancelAgent(agent);
      runState.status = LIFECYCLE.CANCELLED;
      runState.result = {
        status: 'cancelled',
        summary: '',
        errors: ['用户已停止'],
        findings: [], changedFiles: [], artifacts: []
      };
      if (context && typeof context.finishRun === 'function') {
        try { context.finishRun('cancelled', runState.result); } catch { /* noop */ }
      }
      return;
    }

    // abort 联动：取消时调用 agent.cancel()
    const onAbort = () => this._cancelAgent(agent);
    if (runState.ac.signal.aborted) onAbort();
    else {
      try { runState.ac.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ }
    }

    let raw;
    try {
      raw = await agent.run(taskText);
    } catch (e) {
      if (runState.ac.signal.aborted) {
        runState.status = LIFECYCLE.CANCELLED;
        runState.result = {
          status: 'cancelled',
          summary: '',
          errors: ['用户已停止'],
          findings: [], changedFiles: [], artifacts: []
        };
      } else {
        runState.status = LIFECYCLE.FAILED;
        runState.result = {
          status: 'failed',
          summary: '',
          errors: [e && e.message ? e.message : String(e)],
          findings: [], changedFiles: [], artifacts: []
        };
      }
      if (context && typeof context.finishRun === 'function') {
        try { context.finishRun(runState.status === LIFECYCLE.CANCELLED ? 'cancelled' : 'failed', runState.result); } catch { /* noop */ }
      }
      return;
    }

    // signal 已 abort 但 run 仍返回 → 统一改写为 cancelled
    if (runState.ac.signal.aborted) {
      runState.status = LIFECYCLE.CANCELLED;
      runState.result = parseClineResult(raw, 'cancelled');
      if (!runState.result.errors.length) runState.result.errors = ['用户已停止'];
    } else {
      runState.status = LIFECYCLE.COMPLETED;
      runState.result = parseClineResult(raw, 'completed');
    }
    if (context && typeof context.finishRun === 'function') {
      try { context.finishRun(runState.status === LIFECYCLE.COMPLETED ? 'completed' : 'cancelled', runState.result); } catch { /* noop */ }
    }
  }

  _cancelAgent(agent) {
    if (!agent) return;
    if (typeof agent.cancel === 'function') {
      try { agent.cancel(); } catch { /* already cancelled */ }
    }
    if (typeof agent.abort === 'function') {
      try { agent.abort(); } catch { /* noop */ }
    }
  }

  /** sendMessage：Cline Agent 单次 run 不支持运行中追加消息。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'cline agent does not support mid-run messages' };
  }

  /**
   * 取消：abort signal + agent.cancel()。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    this._cancelAgent(run.agent);
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
      if (!run.result) {
        run.result = {
          status: 'cancelled',
          summary: '',
          errors: ['用户已停止'],
          findings: [], changedFiles: [], artifacts: []
        };
      }
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

  /** 释放：取消所有在跑的 Cline run。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try {
        this._cancelAgent(run.agent);
        if (run.status === LIFECYCLE.RUNNING || run.status === LIFECYCLE.STARTING) {
          run.ac.abort();
        }
      } catch { /* non-fatal */ }
    }
    this._runs.clear();
    this._detected = null;
  }
}

module.exports = { ClineAgentAdapter, parseClineResult };
