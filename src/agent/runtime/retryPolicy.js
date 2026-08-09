'use strict';
/**
 * v2.6.0 Main Agent Runtime — Retry / Limit Policy（spec §6）。
 *
 * Agent Loop 不能无限循环。至少限制：
 *   maxIterations    — 总迭代轮数上限
 *   maxToolCalls     — 总工具调用次数上限
 *   maxCommandRetries— 单条命令最大重试
 *   maxRepairRounds  — 修复轮数上限
 *   maxRuntimeMs     — 运行总时长上限
 *   maxInvalidActions— 连续无效 Action 上限
 *
 * 超过限制 → FAILED，errorCode = AGENT_LOOP_LIMIT，不能假装 completed。
 */

const DEFAULTS = {
  maxIterations: 30,
  maxToolCalls: 80,
  maxCommandRetries: 3,
  maxRepairRounds: 5,
  maxRuntimeMs: 10 * 60 * 1000,   // 10 分钟
  maxInvalidActions: 3,
  maxResponseRepair: 2            // 模型返回 malformed JSON 的最大重试
};

function createLimits(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

/**
 * 检查是否超过任一限制。
 * @param {object} limits  限制配置
 * @param {object} counters 当前计数 { iteration, toolCalls, repairRounds, invalidActions, runtimeMs }
 * @returns {{ exceeded: boolean, code?: string, message?: string }}
 */
function checkLimits(limits, counters) {
  if (counters.iteration > limits.maxIterations) {
    return exceeded('AGENT_LOOP_LIMIT', `已达最大迭代数 ${limits.maxIterations}`);
  }
  if (counters.toolCalls > limits.maxToolCalls) {
    return exceeded('AGENT_TOOL_LIMIT', `已达最大工具调用数 ${limits.maxToolCalls}`);
  }
  if (counters.repairRounds > limits.maxRepairRounds) {
    return exceeded('AGENT_REPAIR_LIMIT', `已达最大修复轮数 ${limits.maxRepairRounds}`);
  }
  if (counters.invalidActions > limits.maxInvalidActions) {
    return exceeded('AGENT_RESPONSE_INVALID', `连续 ${counters.invalidActions} 次无效 Action 响应`);
  }
  if (counters.runtimeMs > limits.maxRuntimeMs) {
    return exceeded('AGENT_TIMEOUT', `运行超时 ${limits.maxRuntimeMs}ms`);
  }
  return { exceeded: false };
}

function exceeded(code, message) { return { exceeded: true, code, message }; }

module.exports = { DEFAULTS, createLimits, checkLimits };
