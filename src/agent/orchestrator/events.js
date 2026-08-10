'use strict';
/**
 * v2.9.0 Framework Closure Patch — 统一 Orchestration / Delegation 事件命名空间（spec §65-72）。
 *
 * 单一标准：orchestration.* 。
 * 后端（AgentHubBridge / MainAgentOrchestrator）与前端（public/js/orchestration.js）
 * 一律使用本常量，杜绝「后端发 agent.delegation.* 而前端监听 delegation.*」的错位。
 *
 * Legacy alias：agent.delegation.*（短期兼容 hub eventNormalizer / 旧监听器）。
 * bridge 同时 emit 新旧两套，过渡期不破坏既有消费方。
 */

const ORCHESTRATION_EVENT = {
  RUN_STARTED: 'orchestration.run.started',
  DELEGATION_BEFORE: 'orchestration.delegation.before',
  DELEGATION_STARTED: 'orchestration.delegation.started',
  DELEGATION_COMPLETED: 'orchestration.delegation.completed',
  DELEGATION_FAILED: 'orchestration.delegation.failed',
  DELEGATION_CANCELLED: 'orchestration.delegation.cancelled',
  VERIFICATION_STARTED: 'orchestration.verification.started',
  VERIFICATION_COMPLETED: 'orchestration.verification.completed',
  RUN_BEFORE_COMPLETE: 'orchestration.run.before_complete',
  RUN_COMPLETED: 'orchestration.run.completed'
};

/** 旧事件名（兼容别名）。 */
const LEGACY_EVENT = {
  DELEGATION_STARTED: 'agent.delegation.started',
  DELEGATION_TERMINAL: 'agent.delegation.terminal'
};

/**
 * Delegation terminal status → canonical event（§72/§76：completed/failed/cancelled/timeout）。
 * @param {string} status
 * @returns {string}
 */
function delegationTerminalEvent(status) {
  switch (status) {
    case 'completed': return ORCHESTRATION_EVENT.DELEGATION_COMPLETED;
    case 'cancelled': return ORCHESTRATION_EVENT.DELEGATION_CANCELLED;
    default: return ORCHESTRATION_EVENT.DELEGATION_FAILED; // failed / timeout / interrupted / unknown
  }
}

/** 是否为 delegation 事件（canonical 或 legacy 任意前缀）。前端据此分流。 */
function isDelegationEventType(type) {
  return typeof type === 'string' && type.includes('delegation.');
}

module.exports = { ORCHESTRATION_EVENT, LEGACY_EVENT, delegationTerminalEvent, isDelegationEventType };
