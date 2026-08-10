'use strict';
/**
 * v2.9.0 Unified Main Agent Orchestrator（spec §8-9）。
 *
 * 模块：
 *   agentTaskContract        AgentTask 契约（§11）+ delegationPath/depth（§42-44）
 *   orchestrationBlackboard  Root Run 共享工作状态（§34-38）
 *   childRunTracker           Parent/Child Run 树 + 取消级联（§23-29）
 *   executionContextFactory   统一 Adapter context（§39-40，修复 §7B 缺口）
 *   delegationController      fallback policy + no-bypass（§30-33）
 *   agentHubBridge            AgentTask → AgentHub → Child Run → AgentResult（§18）
 *   mainAgentOrchestrator     统一编排入口（§9）+ 事件总线（§72）
 */

const { createAgentTask, checkDelegationDepth, isSelfDelegation, DEFAULT_BUDGET, MAX_DELEGATION_DEPTH, MAX_DELEGATION_ATTEMPTS } = require('./agentTaskContract');
const { createBlackboard, sanitize: sanitizeBlackboard } = require('./orchestrationBlackboard');
const { createChildRunTracker, TERMINAL_STATUSES } = require('./childRunTracker');
const { createExecutionContextFactory } = require('./executionContextFactory');
const { FAILURE_TYPE, classifyFailure, shouldFallback, chooseFallback } = require('./delegationController');
const { createAgentHubBridge } = require('./agentHubBridge');
const { createMainAgentOrchestrator, register, get, unregister } = require('./mainAgentOrchestrator');

module.exports = {
  // 契约
  createAgentTask, checkDelegationDepth, isSelfDelegation,
  DEFAULT_BUDGET, MAX_DELEGATION_DEPTH, MAX_DELEGATION_ATTEMPTS,
  // Blackboard
  createBlackboard, sanitizeBlackboard,
  // Child Run Tracker
  createChildRunTracker, TERMINAL_STATUSES,
  // Execution Context
  createExecutionContextFactory,
  // Delegation Controller
  FAILURE_TYPE, classifyFailure, shouldFallback, chooseFallback,
  // Bridge
  createAgentHubBridge,
  // Orchestrator
  createMainAgentOrchestrator, register, get, unregister
};
