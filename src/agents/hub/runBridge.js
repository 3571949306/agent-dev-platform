'use strict';
/**
 * RunBridge — 连接 AgentHub 与现有 RunManager 的桥梁。
 *
 * RunManager 是 v2.3.1 的唯一终态门（所有 Run 的终态由它决定）。
 * LifecycleManager 是 Agent Hub 的 Run 生命周期状态机。
 * RunBridge 确保两者保持同步：创建 / 更新 / 完成 / 取消时同时操作两者。
 *
 * parentRunId 用于将委托子 Run 链接到父 Run，供时间线展示。
 *
 * 映射：RunManager runId ↔ LifecycleManager runId
 *   createAgentRun 同时在两者中创建 Run，并建立双向映射。
 *   所有后续操作通过 RunManager runId 查找映射，同步到 LifecycleManager。
 */

const { LIFECYCLE, AGENT_EVENT } = require('./types');

/**
 * RunManager 状态 → LifecycleManager 状态映射。
 * RunManager 使用自己的状态集（preparing / streaming / ...），
 * LifecycleManager 使用 LIFECYCLE（idle / starting / running / ...）。
 */
const RM_TO_LM = {
  preparing: LIFECYCLE.IDLE,
  requesting_model: LIFECYCLE.RUNNING,
  streaming: LIFECYCLE.RUNNING,
  executing_tool: LIFECYCLE.RUNNING,
  waiting_permission: LIFECYCLE.WAITING,
  waiting_subagent: LIFECYCLE.WAITING,
  waiting_external_agent: LIFECYCLE.WAITING,
  testing: LIFECYCLE.RUNNING,
  completed: LIFECYCLE.COMPLETED,
  failed: LIFECYCLE.FAILED,
  cancelled: LIFECYCLE.CANCELLED,
  timeout: LIFECYCLE.TIMEOUT,
  interrupted: LIFECYCLE.FAILED
};

/** 安全发射事件 — emit 失败不得中断 Run。 */
function safeEmit(emit, type, payload) {
  if (typeof emit !== 'function') return;
  try { emit(type, payload); } catch { /* telemetry must never break a run */ }
}

/**
 * 创建 RunBridge。
 * @param {object} opts
 * @param {object} opts.runManager — RunManager 实例（v2.3.1 终态门）
 * @param {object} opts.lifecycleManager — LifecycleManager 实例
 * @param {Function} [opts.emit] — 事件发射函数
 * @returns {object} runBridge 实例
 */
function createRunBridge({ runManager, lifecycleManager, emit } = {}) {
  if (!runManager) throw new Error('createRunBridge: runManager 必填');
  if (!lifecycleManager) throw new Error('createRunBridge: lifecycleManager 必填');

  /**
   * 双向映射：RunManager runId ↔ LifecycleManager runId。
   * 两个 ID 都映射到同一个 { runId, lifecycleRunId } 对象。
   * @type {Map<string, {runId: string, lifecycleRunId: string}>}
   */
  const mappings = new Map();

  /**
   * 创建 Agent Run（同时在 RunManager 和 LifecycleManager 中创建）。
   * @param {object} params
   * @param {string} params.agentId
   * @param {string} [params.conversationId]
   * @param {string} [params.taskId]
   * @param {string} [params.goal]
   * @param {string} [params.parentRunId]
   * @param {string} [params.projectRoot]
   * @param {string} [params.projectId]
   * @param {string} [params.adapterType]
   * @returns {{ runId: string, lifecycleRunId: string, run: object, lifecycleRun: object }}
   */
  function createAgentRun({
    agentId, conversationId, taskId, goal, parentRunId,
    projectRoot, projectId, adapterType = null
  } = {}) {
    // 1. RunManager 创建 Run（status=preparing，立即返回 runId）
    const run = runManager.createRun({ conversationId, agentId, taskId });
    const runId = run.id;

    // 2. LifecycleManager 创建 Run（status=idle）
    const lifecycleRun = lifecycleManager.createRun({
      agentId, taskId, goal, parentRunId, adapterType
    });
    const lifecycleRunId = lifecycleRun.id;

    // 将项目上下文存入 lifecycle metadata（RunManager 无对应字段）
    if (projectRoot) lifecycleRun.metadata.projectRoot = projectRoot;
    if (projectId) lifecycleRun.metadata.projectId = projectId;

    // 3. 建立双向映射
    const mapping = { runId, lifecycleRunId };
    mappings.set(runId, mapping);
    mappings.set(lifecycleRunId, mapping);

    // 4. Lifecycle → starting
    lifecycleManager.transition(lifecycleRunId, LIFECYCLE.STARTING, 'Run created');

    safeEmit(emit, AGENT_EVENT.RUN_STARTED, {
      runId, lifecycleRunId, agentId, conversationId, taskId,
      goal, parentRunId, projectRoot, projectId,
      timestamp: Date.now()
    });

    return { runId, lifecycleRunId, run, lifecycleRun };
  }

  /**
   * 更新 Agent Run（同时更新 RunManager 和 LifecycleManager）。
   * @param {string} runId — RunManager 的 runId
   * @param {string} status — RunManager 状态名
   * @param {string} [detail]
   * @returns {{ runId: string, lifecycleRunId: string }|null}
   */
  function updateAgentRun(runId, status, detail = null) {
    const mapping = mappings.get(runId);
    if (!mapping) return null;

    // RunManager: 使用原始状态名（RunManager 有自己的状态集和迁移表）
    runManager.updateRun(runId, status, { message: detail });

    // LifecycleManager: 映射到 LIFECYCLE
    const lmStatus = RM_TO_LM[status] || status;
    if (lifecycleManager.getRun(mapping.lifecycleRunId)) {
      lifecycleManager.transition(mapping.lifecycleRunId, lmStatus, detail);
    }

    return { runId, lifecycleRunId: mapping.lifecycleRunId };
  }

  /**
   * 完成 Agent Run（终态，同时完成 RunManager 和 LifecycleManager）。
   * @param {string} runId
   * @param {string} status — 终态状态（completed / failed / cancelled / timeout / interrupted）
   * @param {*} [result] — 完成时为结果，失败时为错误信息
   * @returns {{ runId: string, lifecycleRunId: string }|null}
   */
  function finishAgentRun(runId, status, result = null) {
    const mapping = mappings.get(runId);
    if (!mapping) return null;

    const isError = status === 'failed' || status === 'timeout' || status === 'interrupted';

    // RunManager: 终态入口（唯一终态门）
    runManager.finishRun(runId, status, {
      message: !isError && typeof result === 'string' ? result : null,
      error: isError ? (typeof result === 'string' ? result : (result && result.message) || null) : null,
      source: 'agentHub'
    });

    // LifecycleManager: 映射到 LIFECYCLE 终态
    const lmStatus = RM_TO_LM[status] || status;
    if (lifecycleManager.getRun(mapping.lifecycleRunId)) {
      lifecycleManager.transition(mapping.lifecycleRunId, lmStatus, result);
    }

    return { runId, lifecycleRunId: mapping.lifecycleRunId };
  }

  /**
   * 取消 Agent Run（同时在两个管理器中取消）。
   * @param {string} runId
   * @returns {{ runId: string, lifecycleRunId: string }|null}
   */
  function cancelAgentRun(runId) {
    const mapping = mappings.get(runId);
    if (!mapping) return null;

    // RunManager: cancelled 终态
    runManager.finishRun(runId, 'cancelled', { message: '用户已取消', source: 'agentHub' });

    // LifecycleManager: cancelled 终态
    if (lifecycleManager.getRun(mapping.lifecycleRunId)) {
      lifecycleManager.cancel(mapping.lifecycleRunId, '用户已取消');
    }

    return { runId, lifecycleRunId: mapping.lifecycleRunId };
  }

  /**
   * 获取 RunManager runId 与 LifecycleManager runId 之间的映射。
   * @param {string} runId — 任一 ID（RunManager 或 LifecycleManager 的）
   * @returns {{ runId: string, lifecycleRunId: string }|null}
   */
  function getRunMapping(runId) {
    return mappings.get(runId) || null;
  }

  return {
    createAgentRun,
    updateAgentRun,
    finishAgentRun,
    cancelAgentRun,
    getRunMapping
  };
}

module.exports = { createRunBridge, RM_TO_LM };
