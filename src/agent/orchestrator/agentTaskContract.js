'use strict';
/**
 * AgentTask Contract — v2.9.0 统一委派任务契约（spec §11）。
 *
 * Main Agent delegate action → AgentTask → AgentHubBridge → AgentHub → Child Run。
 * 规范化委派意图，让 AgentLoop 不了解具体 Agent（§10），由 Orchestrator/Router 决定。
 *
 * 字段（§11）：
 *   id, goal, taskType, projectId, projectRoot,
 *   requiredCapabilities, preferredCapabilities, preferredAgentId,
 *   readOnly, permissions, expectedOutput, verificationRequirements,
 *   context, parentRunId, parentAgentId, delegationPath, budget
 *
 * 预留未来接口（§69-71，不实现，只声明）：
 *   modelRequirements, skillIds
 */

const crypto = require('crypto');

/** 默认委派预算（§89 Real AI Smoke 的严格限制可覆盖）。 */
const DEFAULT_BUDGET = Object.freeze({
  maxRuntimeMs: 300000,   // 5min
  maxIterations: 10,
  maxToolCalls: 30
});

/** 最大委派深度（§44）。超过 → DELEGATION_DEPTH_EXCEEDED。 */
const MAX_DELEGATION_DEPTH = 3;

/** 最大自动 fallback 尝试次数（§33）。 */
const MAX_DELEGATION_ATTEMPTS = 2;

/**
 * 创建并校验 AgentTask。
 * @param {object} input  委派意图
 * @returns {{ ok: true, task: AgentTask } | { ok: false, error: string, errorCode: string }}
 */
function createAgentTask(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'AgentTask 输入为空', errorCode: 'INVALID_TASK' };
  }
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!goal) {
    return { ok: false, error: 'AgentTask.goal 必填', errorCode: 'INVALID_TASK' };
  }
  const task = {
    id: input.id || crypto.randomUUID(),
    goal,
    taskType: input.taskType || 'generic',
    projectId: input.projectId || null,
    projectRoot: input.projectRoot || null,

    requiredCapabilities: Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities.slice() : [],
    preferredCapabilities: Array.isArray(input.preferredCapabilities) ? input.preferredCapabilities.slice() : [],
    preferredAgentId: input.preferredAgentId || null,

    readOnly: input.readOnly === true,
    permissions: input.permissions && typeof input.permissions === 'object' ? input.permissions : {},
    expectedOutput: input.expectedOutput || null,
    verificationRequirements: Array.isArray(input.verificationRequirements)
      ? input.verificationRequirements.slice() : [],

    context: input.context && typeof input.context === 'object' ? input.context : {},

    parentRunId: input.parentRunId || null,
    parentAgentId: input.parentAgentId || null,
    delegationPath: Array.isArray(input.delegationPath) ? input.delegationPath.slice() : [],

    budget: Object.assign({}, DEFAULT_BUDGET, input.budget || {}),

    // 预留未来接口（§69-71，当前不实现）
    modelRequirements: input.modelRequirements || null,
    skillIds: Array.isArray(input.skillIds) ? input.skillIds.slice() : []
  };
  return { ok: true, task };
}

/**
 * 检查委派深度（§44）。
 * @param {string[]} delegationPath  已经过的 agentId 链
 * @returns {boolean} true = 允许继续委派
 */
function checkDelegationDepth(delegationPath) {
  const depth = Array.isArray(delegationPath) ? delegationPath.length : 0;
  return depth < MAX_DELEGATION_DEPTH;
}

/**
 * 防自委派（§42）：parentAgentId 不得在 delegationPath 末尾再次被选为 child。
 * @param {string} parentAgentId
 * @param {string} candidateAgentId
 * @returns {boolean} true = 禁止自委派
 */
function isSelfDelegation(parentAgentId, candidateAgentId) {
  return !!parentAgentId && parentAgentId === candidateAgentId;
}

module.exports = {
  createAgentTask,
  checkDelegationDepth,
  isSelfDelegation,
  DEFAULT_BUDGET,
  MAX_DELEGATION_DEPTH,
  MAX_DELEGATION_ATTEMPTS
};
