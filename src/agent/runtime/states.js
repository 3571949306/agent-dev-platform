'use strict';
/**
 * v2.6.0 Main Agent Runtime — 状态机定义（spec §5）。
 *
 * 每个 Run 必须有明确的 state，不靠字符串消息猜 Agent 当前状态。
 *
 * 状态语义：
 *   IDLE             — Run 已创建但尚未开始
 *   PLANNING         — 生成 / 调整执行计划
 *   READING_CONTEXT  — 读取项目文件 / 构建上下文
 *   EXECUTING        — 执行 Action（文件 / 终端 / git）
 *   WAITING_TOOL     — 等待工具返回（中间态）
 *   TESTING          — 运行验证命令（npm test 等）
 *   EVALUATING       — 评估结果是否满足完成策略
 *   REPAIRING        — 测试失败后进入修复
 *   WAITING_PERMISSION — 等待用户权限确认
 *   COMPLETED        — 终态：完成策略全部满足
 *   FAILED           — 终态：错误 / 不可继续
 *   CANCELLED        — 终态：用户停止
 *   TIMEOUT          — 终态：超时
 */

const NON_TERMINAL = [
  'IDLE',
  'PLANNING',
  'READING_CONTEXT',
  'EXECUTING',
  'WAITING_TOOL',
  'TESTING',
  'EVALUATING',
  'REPAIRING',
  'WAITING_PERMISSION'
];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'];
const ALL = [...NON_TERMINAL, ...TERMINAL];

function isTerminal(state) { return TERMINAL.includes(state); }
function isNonTerminal(state) { return NON_TERMINAL.includes(state); }
function isValid(state) { return ALL.includes(state); }

/**
 * 合法的非终态迁移表。同一状态重复允许；终态只能由 finish 进入。
 * 设计原则：Main Agent 可在 PLAN/READ/EXEC/TEST/EVAL/REPAIR 之间自由流转，
 * 任何非终态都可直接进入终态（由 Runtime finishRun 决定）。
 */
const TRANSITIONS = {
  IDLE: ['PLANNING', 'READING_CONTEXT', 'EXECUTING'],
  PLANNING: ['READING_CONTEXT', 'EXECUTING', 'EVALUATING', 'TESTING'],
  READING_CONTEXT: ['EXECUTING', 'PLANNING', 'TESTING'],
  EXECUTING: ['WAITING_TOOL', 'TESTING', 'EVALUATING', 'READING_CONTEXT', 'PLANNING', 'REPAIRING'],
  WAITING_TOOL: ['EXECUTING', 'TESTING', 'EVALUATING', 'REPAIRING'],
  TESTING: ['EVALUATING', 'REPAIRING', 'EXECUTING'],
  EVALUATING: ['COMPLETED', 'REPAIRING', 'EXECUTING', 'TESTING', 'PLANNING'],
  REPAIRING: ['EXECUTING', 'TESTING', 'EVALUATING', 'PLANNING'],
  WAITING_PERMISSION: ['EXECUTING', 'TESTING']
};

/** 是否允许从 from 迁移到 to（非终态之间）。 */
function canTransition(from, to) {
  if (from === to) return true;
  if (isTerminal(from)) return false; // 终态后不再迁移
  if (isTerminal(to)) return true;    // 非终态 → 终态由 finishRun 统一处理
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

module.exports = {
  NON_TERMINAL, TERMINAL, ALL,
  isTerminal, isNonTerminal, isValid,
  canTransition, TRANSITIONS
};
