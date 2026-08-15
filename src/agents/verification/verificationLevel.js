'use strict';
/**
 * VerificationLevel — Agent 验证等级定义与声明约束（spec §39-§43）。
 *
 * 验证等级描述 Agent 经过多少深度的实际验证，从"仅存在实现"到
 * "真实端到端任务完成"。Hub 消费者（Router / GUI）据此决定是否信任
 * 某个 Agent 的能力声明，避免"仅 --version 通过就声称支持真实协议"。
 *
 * 等级定义来源：types.js（VERIFICATION_LEVEL 常量），本文件重导出
 * 以供 verification 模块内消费，避免循环依赖（Option A：types.js 为
 * 单一真相源，verificationLevel.js 重导出）。
 *
 * 声明约束（isClaimAllowed）：
 *   §41 — 本地检测证据必须符合实际 transport profile
 *   §42 — 检测成功（无协议交互）→ 最高只能声明 LOCAL_DETECTION_VERIFIED
 *   §42 — 无真实 initialize/session/prompt → 不能声明 REAL_PROTOCOL_VERIFIED
 *   §43 — paid/subscription 是调用政策，不是永久验证上限
 */

const { VERIFICATION_LEVEL } = require('../hub/types');

/**
 * 验证等级偏序数组：从低到高。用于 isClaimAllowed 的偏序比较与
 * getLevel 的从高到低遍历。
 * @type {string[]}
 */
const VERIFICATION_LEVEL_ORDER = [
  VERIFICATION_LEVEL.NOT_VERIFIED,
  VERIFICATION_LEVEL.IMPLEMENTATION_VERIFIED,
  VERIFICATION_LEVEL.FIXTURE_VERIFIED,
  VERIFICATION_LEVEL.PACKAGED_VERIFIED,
  VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED,
  VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED,
  VERIFICATION_LEVEL.REAL_AGENT_TASK_VERIFIED
];

/** GUI 展示标签映射。 */
const LEVEL_LABELS = {
  [VERIFICATION_LEVEL.NOT_VERIFIED]: '未验证',
  [VERIFICATION_LEVEL.IMPLEMENTATION_VERIFIED]: '实现级验证',
  [VERIFICATION_LEVEL.FIXTURE_VERIFIED]: 'Fixture 验证',
  [VERIFICATION_LEVEL.PACKAGED_VERIFIED]: '打包级验证',
  [VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED]: '本地检测验证',
  [VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED]: '真实协议验证',
  [VERIFICATION_LEVEL.REAL_AGENT_TASK_VERIFIED]: '真实任务验证'
};

/**
 * 返回等级在偏序中的索引（0 起）。非法等级返回 -1。
 * @param {string} level
 * @returns {number}
 */
function levelIndex(level) {
  return VERIFICATION_LEVEL_ORDER.indexOf(level);
}

/**
 * 判断给定等级在当前证据下是否允许声明（spec §41-§43）。
 *
 * 纯函数：不读取外部状态，所有判断依据 evidence 参数。
 *
 * 检查两方面：
 *   1. 正向证据 — 是否有足够证据声明此等级（hasImplementation / hasFixture /
 *      hasPackaged / executableFound+versionSucceeded / protocolInitialized /
 *      agentTaskCompleted）。NOT_VERIFIED 不需要任何正向证据。
 *   2. 负向约束（cap）— 是否有证据将可声明上限压到此等级之下。
 *
 * evidence 摘要字段（由 verificationRegistry.summarizeEvidence 产出）：
 *   - paidProvider        — 是否为付费 provider（仅供政策/展示，不限制证据）
 *   - hasImplementation   — 是否有实现级证据
 *   - hasFixture          — 是否有 fixture 级证据
 *   - hasPackaged         — 是否有打包级证据
 *   - localDetectionVerified — transport-aware 本地/端点/窗口检测是否满足
 *   - protocolInitialized — 是否有真实 initialize/session/prompt（spec §42）
 *   - agentTaskCompleted  — 真实 Agent 任务是否端到端完成
 *
 * @param {string} level — 待声明的验证等级（VERIFICATION_LEVEL.*）
 * @param {object} [evidence] — 证据摘要对象
 * @returns {boolean} 是否允许声明该等级
 */
function isClaimAllowed(level, evidence) {
  const idx = levelIndex(level);
  if (idx < 0) return false; // 非法等级

  const ev = evidence || {};

  // NOT_VERIFIED 不需要任何正向证据
  if (idx === 0) return true;

  // ── 正向证据检查：是否有足够证据声明此等级 ──
  let achieved = false;
  switch (level) {
    case VERIFICATION_LEVEL.IMPLEMENTATION_VERIFIED:
      achieved = !!ev.hasImplementation;
      break;
    case VERIFICATION_LEVEL.FIXTURE_VERIFIED:
      achieved = !!ev.hasFixture;
      break;
    case VERIFICATION_LEVEL.PACKAGED_VERIFIED:
      achieved = !!ev.hasPackaged;
      break;
    case VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED:
      achieved = !!ev.localDetectionVerified || (!!ev.executableFound && !!ev.versionSucceeded);
      break;
    case VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED:
      achieved = !!ev.protocolInitialized;
      break;
    case VERIFICATION_LEVEL.REAL_AGENT_TASK_VERIFIED:
      achieved = !!ev.agentTaskCompleted && !!ev.agentTaskEffectObserved;
      break;
    default:
      achieved = false;
  }
  if (!achieved) return false;

  // ── 负向约束（cap）：检查是否有证据将上限压低到此等级之下 ──
  let capIdx = VERIFICATION_LEVEL_ORDER.length - 1;

  // spec §42：无真实 initialize/session/prompt → 不能声明 REAL_PROTOCOL_VERIFIED 或更高
  if (!ev.protocolInitialized) {
    capIdx = Math.min(capIdx, levelIndex(VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED));
  }

  // Transport-aware detection replaces the old global executable/version
  // assumption. CLI profiles still establish this bit from both probes;
  // HTTP/SDK/ACP/desktop profiles establish it from their own prerequisites.
  if (!ev.localDetectionVerified && !(ev.executableFound && ev.versionSucceeded)) {
    capIdx = Math.min(capIdx, levelIndex(VERIFICATION_LEVEL.PACKAGED_VERIFIED));
  }

  return idx <= capIdx;
}

/**
 * 将验证等级转为人类可读标签，供 GUI 展示。
 * @param {string} level — VERIFICATION_LEVEL.*
 * @returns {string} 标签文本；未知等级回退为原始值或"未知"
 */
function formatLevel(level) {
  return LEVEL_LABELS[level] || (level || '未知');
}

module.exports = {
  VERIFICATION_LEVEL,
  VERIFICATION_LEVEL_ORDER,
  isClaimAllowed,
  formatLevel
};
