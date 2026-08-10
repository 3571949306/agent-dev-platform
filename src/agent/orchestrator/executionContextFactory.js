'use strict';
/**
 * AgentExecutionContextFactory — v2.9.0 统一 Adapter context 构建（spec §39-40）。
 *
 * 修复 §7B 缺口：NativeAgentAdapter.startTask 需要 runManager/model/getTool/store 等，
 * 但 hub.start 只传 8 字段。本工厂统一构建完整 context，让 AgentHub 不再手工拼。
 *
 * 方案 B（解耦）：AgentHub 构造时注入 runtimeDeps 工厂，hub.start 调用
 * contextFactory.create(agent, task, run) 得到完整 context。
 *
 * §50：PathSecurity 必须进入 AgentExecutionContext，不允许新 Orchestrator 绕过。
 * §49：Child effective permission = Parent Auth ∩ Platform Policy ∩ Agent Policy。
 */

/**
 * 创建 ExecutionContextFactory。
 * @param {object} runtimeDeps  全局运行时依赖（由 handlers.js 在 App 启动时注入）
 *   { runManager, getTool, store, buildProvider, resolveModel,
 *     permissionEngine, pathSecurity, projectMutationLock,
 *     sessionPersistence, verificationRegistry, emit }
 * @returns {object} factory
 */
function createExecutionContextFactory(runtimeDeps) {
  const deps = runtimeDeps || {};

  /**
   * 为 adapter.startTask 构建 context。
   * @param {object} agent      adapter 实例（含 adapterType/capabilities）
   * @param {object} task       AgentTask
   * @param {object} run        { runId, lifecycleRunId, agentId, parentRunId, projectRoot, projectId }
   * @param {object} hubCtx    hub 层已有的基础 context（emit/finishRun/allowedScopes）
   * @returns {object} 完整 context
   */
  function create(agent, task, run, hubCtx) {
    const base = Object.assign({}, hubCtx || {}, {
      runId: run.runId,
      lifecycleRunId: run.lifecycleRunId,
      agentId: run.agentId,
      projectRoot: task.projectRoot || run.projectRoot,
      projectId: task.projectId || run.projectId,
      conversationId: task.conversationId || null,
      taskId: task.taskId || null,
      parentRunId: task.parentRunId || run.parentRunId || null
    });

    const transport = (agent && (agent.adapterType || agent.transport)) || '';
    const isNative = transport === 'native';

    if (isNative) {
      // Native Main Agent：需要完整运行时依赖来驱动 runMainAgent
      // §7B 缺口修复：补全 runManager/model/getTool/store/permissionEngine/pathSecurity
      const model = task.model || (deps.resolveModel ? deps.resolveModel(task) : null);
      return Object.assign(base, {
        runManager: deps.runManager || null,
        model: model || (deps.defaultModel || null),
        provider: (model && model.provider) || (deps.buildProvider ? deps.buildProvider(model) : null),
        getTool: deps.getTool || null,
        store: deps.store || null,
        requestPermission: deps.requestPermission || null,
        permissionEngine: deps.permissionEngine || null,
        pathSecurity: deps.pathSecurity || null,
        projectMutationLock: deps.projectMutationLock || null,
        abortSignal: task.abortSignal || null,
        events: deps.emit || base.emit || null,
        sessionPersistence: deps.sessionPersistence || null,
        verification: deps.verificationRegistry || null,
        agentName: (agent && agent.manifest && agent.manifest.displayName) || run.agentId
      });
    }

    // External Agent（Codex/Claude/Cline/...）：提供安全/权限/路径基础设施
    return Object.assign(base, {
      permissionEngine: deps.permissionEngine || null,
      pathSecurity: deps.pathSecurity || null,
      projectMutationLock: deps.projectMutationLock || null,
      // 外部 adapter 自己管理 model/provider（从 manifest/config 取）
      abortSignal: task.abortSignal || null,
      events: deps.emit || base.emit || null
    });
  }

  return { create };
}

module.exports = { createExecutionContextFactory };
