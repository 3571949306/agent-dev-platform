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
      // §8-17: Native Hub Model Context 真修复（Gap 1）。
      // 优先用 shared resolver 产出真实 ProviderModelAdapter（带 decide），
      // 优先级：modelOverride → context.model → agent api_connection_id/model → parentModelContext。
      // 其中 parentModelContext 仅在「Main Agent 委派子任务」的编排路径注入（见 handlers.js
      // 与 orchestrator 构造），用于让 native child 复用 Main Agent 当前 model（Gap 1 修复点）。
      const resolver = deps.nativeModelContextResolver;
      let providerModelAdapter = null;
      let modelInfo = null;
      let connection = null;
      if (resolver) {
        try {
          const resolved = resolver.resolveNativeModelContext(agent, {
            modelOverride: task.modelOverride || null,
            contextModel: (task.context && task.context.model) || null,
            parentModelContext: deps.parentModelContext || null
          });
          providerModelAdapter = resolved.providerModelAdapter;
          modelInfo = resolved.modelInfo;
          connection = resolved.connection;
        } catch (e) {
          // §9-6：resolver 在无「真实 ProviderModelAdapter」来源时明确抛错（不静默选首个 Connection）。
          // 但生产「顶层」native-start（fallback-to-native-main / 用户直接启动 native-main）不携带
          // parentModelContext，且 native-main 的真实模型由 mainAgentRuntime 内部解析。NativeAgentAdapter
          // 仅要求 context.model 非空（startTask line 98）。故此处沿用 v2.9.0 之前行为：给一个 truthy
          // 的 model 描述（resolveModel(agent) / defaultModel），避免回归 fallback / 顶层启动路径。
          try {
            modelInfo = (deps.resolveModel ? deps.resolveModel(agent) : null) || deps.defaultModel || { model: null };
          } catch {
            modelInfo = deps.defaultModel || { model: null };
          }
        }
      } else {
        // 无 resolver（极端降级）：保持最小可用 model 描述
        modelInfo = (deps.resolveModel ? deps.resolveModel(agent) : null) || deps.defaultModel || { model: null };
      }
      // §13: 明确字段 modelInfo / modelAdapter / provider / connection；
      // NativeAgentAdapter 使用 context.model（真实 adapter 优先，否则 model 描述）。
      return Object.assign(base, {
        runManager: deps.runManager || null,
        model: providerModelAdapter || modelInfo || (deps.defaultModel || null),
        modelInfo,
        modelAdapter: providerModelAdapter,
        provider: providerModelAdapter,
        connection: connection || (modelInfo && modelInfo.connectionId ? { id: modelInfo.connectionId } : null),
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
