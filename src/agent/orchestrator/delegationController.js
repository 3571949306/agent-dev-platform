'use strict';
/**
 * DelegationController — v2.9.0 委派失败策略与 fallback 控制（spec §30-33）。
 *
 * 失败分类（§30）：
 *   RUNTIME_UNAVAILABLE  Agent 未安装/未检测/health fail
 *   PROTOCOL_ERROR       通信协议错误（app-server 崩溃/sidecar 握手失败）
 *   CRASH                Adapter 进程崩溃
 *   TIMEOUT              超时
 *   PERMISSION_DENIED    权限拒绝
 *   USER_CANCELLED       用户取消
 *   POLICY_DENIED        策略拒绝
 *   TASK_FAILED          Agent 执行但任务失败（逻辑失败，非运行时）
 *
 * 自动 fallback 允许（§31）：RUNTIME_UNAVAILABLE / PROTOCOL_ERROR / CRASH
 * 第一版可选允许（§31）：TIMEOUT
 * 禁止自动 fallback（§32）：PERMISSION_DENIED / USER_CANCELLED / POLICY_DENIED
 *
 * No-Bypass（§29）：PERMISSION_DENIED 后禁止换 Agent 重试相同危险操作。
 * maxDelegationAttempts = 2（§33），避免无限烧资源。
 */

const { MAX_DELEGATION_ATTEMPTS } = require('./agentTaskContract');

const FAILURE_TYPE = Object.freeze({
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  CRASH: 'CRASH',
  TIMEOUT: 'TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  USER_CANCELLED: 'USER_CANCELLED',
  POLICY_DENIED: 'POLICY_DENIED',
  TASK_FAILED: 'TASK_FAILED'
});

/** 可自动 fallback 的类型（§31）。 */
const AUTO_FALLBACK_ALLOWED = new Set([
  FAILURE_TYPE.RUNTIME_UNAVAILABLE,
  FAILURE_TYPE.PROTOCOL_ERROR,
  FAILURE_TYPE.CRASH
  // §31 第一版可选 TIMEOUT：本轮保守，不自动 fallback TIMEOUT
]);

/** 禁止 fallback 的类型（§32）。 */
const FALLBACK_FORBIDDEN = new Set([
  FAILURE_TYPE.PERMISSION_DENIED,
  FAILURE_TYPE.USER_CANCELLED,
  FAILURE_TYPE.POLICY_DENIED
]);

/**
 * 从 Child Agent 的终态/错误推断失败类型。
 * @param {object} childResult  { status, error, errorCode }
 * @returns {string} FAILURE_TYPE
 */
function classifyFailure(childResult) {
  if (!childResult) return FAILURE_TYPE.RUNTIME_UNAVAILABLE;
  const status = childResult.status || '';
  const errorCode = childResult.errorCode || '';
  const errMsg = String(childResult.error || childResult.message || '');

  if (status === 'cancelled' || errorCode === 'USER_CANCELLED') return FAILURE_TYPE.USER_CANCELLED;
  if (status === 'timeout' || /timeout/i.test(errMsg)) return FAILURE_TYPE.TIMEOUT;
  if (/permission|denied|forbidden|EPERM|EACCES/i.test(errMsg) || errorCode === 'PERMISSION_DENIED') {
    return FAILURE_TYPE.PERMISSION_DENIED;
  }
  if (/crash|killed|SIGTERM|SIGKILL|abnormal/i.test(errMsg)) return FAILURE_TYPE.CRASH;
  if (/protocol|handshake|ECONNRESET|EPIPE|app-server/i.test(errMsg)) return FAILURE_TYPE.PROTOCOL_ERROR;
  if (status === 'unavailable' || /unavailable|not.*(found|detected|installed)/i.test(errMsg)) {
    return FAILURE_TYPE.RUNTIME_UNAVAILABLE;
  }
  if (status === 'failed') return FAILURE_TYPE.TASK_FAILED;
  return FAILURE_TYPE.RUNTIME_UNAVAILABLE;
}

/**
 * 判断是否允许自动 fallback（§31-32）。
 * @param {string} failureType  FAILURE_TYPE
 * @returns {boolean}
 */
function shouldFallback(failureType) {
  return AUTO_FALLBACK_ALLOWED.has(failureType);
}

/**
 * 从候选列表选下一个 fallback Agent（§33）。
 * @param {object[]} rankedAgents  AgentHub.route 返回的已排序候选
 * @param {number} attempt         当前尝试次数（1-based）
 * @param {string[]} excludeAgentIds  已失败/已试过的 agentId
 * @returns {object|null}  下一个 agent 或 null（无可用 fallback）
 */
function chooseFallback(rankedAgents, attempt, excludeAgentIds) {
  if (attempt >= MAX_DELEGATION_ATTEMPTS) return null;
  if (!Array.isArray(rankedAgents) || !rankedAgents.length) return null;
  const excluded = new Set(excludeAgentIds || []);
  for (const a of rankedAgents) {
    if (a && a.agentId && !excluded.has(a.agentId)) {
      return a;
    }
  }
  return null;
}

module.exports = {
  FAILURE_TYPE,
  AUTO_FALLBACK_ALLOWED,
  FALLBACK_FORBIDDEN,
  classifyFailure,
  shouldFallback,
  chooseFallback
};
