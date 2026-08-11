'use strict';
/**
 * v2.6.0 Agent Integration Hub — Native 主智能体适配器（spec §4.3）。
 *
 * 把已有的 MainAgentRuntime（src/agent/runtime/mainAgentRuntime.js runMainAgent）
 * 包装成统一 AgentAdapter 接口，让 Hub 路由层可以像调度外部 Agent 一样调度
 * 平台内置的主智能体，无需为 native 写特殊路径。
 *
 * 设计要点：
 *  - runMainAgentFn 通过构造器注入（便于测试注入 FakeCodingModel / mock runtime），
 *    生产环境传入 require('../agent/runtime/mainAgentRuntime').runMainAgent。
 *  - runMainAgent 内部自建 AbortController 并通过 opts.registerAbort 回吐给本适配器，
 *    cancel() 直接调用 ac.abort() 即可让 Agent Loop 立即停下。
 *  - runId 复用 RunManager 分配的 id（runMainAgent 返回 { runId, conversationId }），
 *    getStatus / getResult 直接反查 RunManager，无需维护第二份状态。
 *  - 主智能体永远可用（同进程），detect() 永远返回 available:true。
 */

const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { NATIVE_MAIN } = require('../manifests/builtinAgents');

/** RunManager stage → 统一 LIFECYCLE 状态映射。 */
function mapRunManagerStatus(status) {
  if (!status) return LIFECYCLE.IDLE;
  switch (status) {
    case 'preparing':
    case 'requesting_model':
      return LIFECYCLE.STARTING;
    case 'streaming':
    case 'executing_tool':
    case 'testing':
      return LIFECYCLE.RUNNING;
    case 'waiting_permission':
    case 'waiting_subagent':
    case 'waiting_external_agent':
      return LIFECYCLE.WAITING;
    case 'completed':
      return LIFECYCLE.COMPLETED;
    case 'failed':
    case 'interrupted':
      return LIFECYCLE.FAILED;
    case 'cancelled':
      return LIFECYCLE.CANCELLED;
    case 'timeout':
      return LIFECYCLE.TIMEOUT;
    default:
      return LIFECYCLE.RUNNING;
  }
}

class NativeAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest           native-main manifest（缺省取内置 NATIVE_MAIN）
   * @param {Function} opts.runMainAgentFn   mainAgentRuntime.runMainAgent 注入
   * @param {Function} [opts.emit]           默认事件发射器（context.emit 优先）
   */
  constructor({ manifest, runMainAgentFn, emit } = {}) {
    super({ manifest: manifest || NATIVE_MAIN });
    if (typeof runMainAgentFn !== 'function') {
      throw new Error('NativeAgentAdapter: runMainAgentFn 必填（mainAgentRuntime.runMainAgent）');
    }
    this.runMainAgentFn = runMainAgentFn;
    this.emit = emit || (() => {});
    // conversationId -> AbortController（runMainAgent 通过 registerAbort 回吐）
    this._abortControllers = new Map();
    // runId -> { conversationId, task, context, startedAt }
    this._runs = new Map();
  }

  /** 主智能体永远存在；maxConcurrency 由 manifest 给出（默认 3）。 */
  getManifest() {
    return { ...this.manifest, maxConcurrency: this.manifest.maxConcurrency || 3 };
  }

  /** 同进程内置 Agent，永远可用。 */
  async detect() {
    return { available: true };
  }

  /** 健康检查：永远 healthy，附带平台版本号与 0 延迟。 */
  async healthCheck() {
    let version = null;
    try { version = require('../../../package.json').version; } catch { /* 测试环境可能无 package.json */ }
    return { status: HEALTH_STATE.HEALTHY, version, latencyMs: 0, detail: 'native in-process agent' };
  }

  /**
   * 启动一次 Main Agent Run。
   * @param {object} task    { goal, projectId, projectRoot, limits, verification, requiredFiles, initialPlan, timeoutMs }
   * @param {object} context { conversationId, agentId, agentName, model, getTool, store, emit, runManager, requestPermission, permissionEngine, onToolResult }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || !task.goal) throw new Error('NativeAgentAdapter.startTask: task.goal 必填');
    if (!context.runManager) throw new Error('NativeAgentAdapter.startTask: context.runManager 必填');
    // v2.9.0 Real Runtime Closure（R1）：context.model 必须是真实 Runtime ModelAdapter（带 decide()）。
    // 禁止 truthy 弱检查：{ model, provider, connectionId } 这类 metadata object 不得冒充
    // ModelAdapter；解析失败必须明确抛 NATIVE_MODEL_CONTEXT_UNRESOLVED。
    if (!context.model || typeof context.model.decide !== 'function') {
      const got = !context.model ? '空值' : (
        typeof context.model === 'object'
          ? `metadata object（keys: ${Object.keys(context.model).join(',')}，无 decide()）`
          : typeof context.model
      );
      throw new Error(
        'NATIVE_MODEL_CONTEXT_UNRESOLVED: NativeAgentAdapter.startTask 收到非法 context.model（' + got +
        '）；必须是带 decide() 的 ProviderModelAdapter，禁止用元数据 object 冒充'
      );
    }

    const conversationId = context.conversationId || null;
    const projectRoot = task.projectRoot || context.projectRoot;
    if (!projectRoot) throw new Error('NativeAgentAdapter.startTask: projectRoot 必填');

    // 捕获 runMainAgent 内部创建的 AbortController，cancel() 时直接 abort。
    const registerAbort = (convId, ac) => {
      if (convId) this._abortControllers.set(convId, ac);
    };
    const unregisterAbort = (convId) => {
      if (convId) this._abortControllers.delete(convId);
    };

    const { runId } = this.runMainAgentFn({
      conversationId,
      agentId: context.agentId || this.manifest.id,
      agentName: context.agentName || this.manifest.displayName,
      goal: task.goal,
      projectRoot,
      projectId: task.projectId || context.projectId,
      projectName: context.projectName,
      projectSummary: context.projectSummary,
      model: context.model,
      getTool: context.getTool,
      store: context.store,
      emit: context.emit || this.emit,
      runManager: context.runManager,
      requestPermission: context.requestPermission,
      permissionEngine: context.permissionEngine || null,
      pathSecurity: context.pathSecurity || null,
      limits: task.limits,
      verification: task.verification,
      requiredFiles: task.requiredFiles,
      initialPlan: task.initialPlan,
      timeoutMs: task.timeoutMs,
      dynamicSystemPrompt: task.dynamicSystemPrompt,
      dynamicRole: task.dynamicRole,
      skillInstructions: task.skillInstructions,
      skillIds: task.skillIds,
      hookIds: task.hookIds,
      canDelegate: task.canDelegate,
      delegationPath: context.delegationPath,
      rootRunId: task.rootRunId || context.rootRunId,
      parentRunId: task.parentRunId || context.parentRunId,
      dynamicAgentFactory: context.dynamicAgentFactory,
      definitionStore: context.definitionStore,
      parentPolicy: context.parentPolicy,
      onToolResult: context.onToolResult,
      registerAbort,
      unregisterAbort
    });

    this._runs.set(runId, {
      runId,
      conversationId,
      task,
      context,
      startedAt: Date.now()
    });

    return { runId };
  }

  /** sendMessage：主智能体暂不支持运行中追加消息，保留接口以便未来接入。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'native agent does not support mid-run messages' };
  }

  /**
   * 取消运行：abort runMainAgent 内部的 AbortController，
   * 并把 RunManager 标记为 cancelled（runMainAgent 的 catch 也会处理）。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    let aborted = false;
    if (run.conversationId) {
      const ac = this._abortControllers.get(run.conversationId);
      if (ac) {
        try { ac.abort(); aborted = true; } catch { /* already aborted */ }
        this._abortControllers.delete(run.conversationId);
      }
    }
    // RunManager.cancelByConversation 是终态门，幂等；这里做兜底，
    // 万一 ac 没回吐也能让 Run 标记为 cancelled。
    if (run.context && run.context.runManager && run.conversationId) {
      try { run.context.runManager.cancelByConversation(run.conversationId, { message: 'NativeAgentAdapter.cancel' }); } catch { /* non-fatal */ }
    }
    return { ok: true, aborted };
  }

  /** 查询 Run 状态：直接反查 RunManager（runId 即 RunManager 的 run id）。 */
  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    const rm = run.context && run.context.runManager;
    if (!rm) return { status: LIFECYCLE.RUNNING };
    const r = rm.getRun(runId);
    if (!r) return { status: LIFECYCLE.IDLE, detail: 'run not found in RunManager' };
    return {
      status: mapRunManagerStatus(r.status),
      stage: r.stage,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      terminalAt: r.terminalAt
    };
  }

  /** 取终态结果：从 RunManager 拉 status/error/message。 */
  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    const rm = run.context && run.context.runManager;
    if (!rm) return null;
    const r = rm.getRun(runId);
    if (!r) return null;
    return {
      status: mapRunManagerStatus(r.status),
      summary: r.message || '',
      error: r.error || null,
      terminalAt: r.terminalAt,
      raw: { runManagerStatus: r.status, stage: r.stage }
    };
  }

  /** 释放资源：取消所有仍在运行的 native run。 */
  async dispose() {
    for (const [runId] of this._runs) {
      try { await this.cancel(runId); } catch { /* non-fatal */ }
    }
    this._runs.clear();
    this._abortControllers.clear();
  }
}

module.exports = { NativeAgentAdapter, mapRunManagerStatus };
