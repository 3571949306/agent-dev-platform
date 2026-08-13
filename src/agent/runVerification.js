'use strict';
/**
 * v2.9.9 Phase B PART A（A1）— Verification Truth 唯一裁决源。
 *
 * Run completion 与 Verification 是两个独立事实：
 *   - run.status 由 RunManager 状态机裁决（执行是否走到终点）
 *   - verificationStatus 由机器证据裁决（CompletionPolicy 结果 / 真实测试事件）
 *
 * 铁律：completed != PASS。禁止任何地方（尤其 Renderer）从 run.status
 * 反推验证结论。本模块是 backend 唯一裁决入口。
 *
 * 词汇表（可适配系统命名，语义不变）：
 *   PASS          — 真实且新鲜的验证/测试证据全部通过
 *   FAIL          — 存在真实的验证/测试失败证据
 *   NOT_AVAILABLE — Run 完成，但从未配置任何测试/验证（无证据可得）
 *   NOT_VERIFIED  — 验证从未执行（或证据缺失，不作猜测）
 *   RUNNING       — Run 尚未终态，验证进行中
 *   UNKNOWN       — 无法确定（记录缺失）
 */

const VERIFICATION_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  NOT_VERIFIED: 'NOT_VERIFIED',
  RUNNING: 'RUNNING',
  UNKNOWN: 'UNKNOWN'
});

const VOCABULARY = Object.freeze(Object.values(VERIFICATION_STATUS));

const TERMINAL_RUN_STATUS = Object.freeze(['completed', 'failed', 'cancelled', 'timeout', 'interrupted']);

function isVerificationStatus(value) {
  return VOCABULARY.includes(String(value || '').toUpperCase());
}

/**
 * Run 终态时刻从真实结果计算机器证据（写入 runs.verification_status）。
 *
 * @param {object} p { status, completion, tests }
 *   status     — RunManager 终态（仅用于分支，绝不直接映射为验证结论）
 *   completion — CompletionPolicy.evaluate() 的真实裁决（含 verificationStatus）
 *   tests      — 真实执行过的测试结果 [{ passed, ... }]
 * @returns {string} VERIFICATION_STATUS 词汇表值
 */
function verificationFromOutcome({ status, completion, tests } = {}) {
  const list = Array.isArray(tests) ? tests.filter(Boolean) : [];
  const s = String(status || '').toLowerCase();
  if (s === 'completed') {
    // CompletionPolicy 是完成路径上的机器证据；其 NOT_AVAILABLE 表示
    // 「确实无配置测试/验证」（Run B）。缺失裁决时验证从未执行 → NOT_VERIFIED。
    const v = completion && String(completion.verificationStatus || '').toUpperCase();
    return isVerificationStatus(v) ? v : VERIFICATION_STATUS.NOT_VERIFIED;
  }
  if (s === 'failed' || s === 'timeout') {
    // 禁止简单 failed => FAIL：只有真实测试失败/策略 FAIL 证据才给 FAIL
    const failedEvidence = list.some(t => t.passed === false);
    const policyFail = !!(completion && String(completion.verificationStatus || '').toUpperCase() === 'FAIL');
    return (failedEvidence || policyFail) ? VERIFICATION_STATUS.FAIL : VERIFICATION_STATUS.NOT_VERIFIED;
  }
  // cancelled / interrupted：验证未执行完成
  return VERIFICATION_STATUS.NOT_VERIFIED;
}

/**
 * 从存储的真实 test/verification 事件推导（历史数据通道：runs 行无持久化证据时）。
 * 无证据返回 null，由调用方决定落点（绝不猜测）。
 *
 * @param {Array<{passed?: boolean}>} testEvents 该 run 的 mainAgent:testResult 事件负载
 * @returns {string|null} PASS / FAIL / null
 */
function verificationFromTestEvents(testEvents) {
  const events = Array.isArray(testEvents) ? testEvents.filter(Boolean) : [];
  if (!events.length) return null;
  return events.some(e => e.passed === false) ? VERIFICATION_STATUS.FAIL : VERIFICATION_STATUS.PASS;
}

/**
 * mapRunRecord 使用的唯一裁决入口。
 *
 * 证据优先级：
 *   1. runs.verification_status 持久化证据（终态时由 CompletionPolicy 写入）
 *   2. 存储的真实 test/verification 事件（历史数据）
 *   3. 非终态 → RUNNING；终态无证据 → NOT_VERIFIED（不猜）
 *
 * @param {object} p { row, testEvents }
 * @returns {string} VERIFICATION_STATUS 词汇表值
 */
function resolveRunVerificationStatus({ row, testEvents } = {}) {
  if (!row) return VERIFICATION_STATUS.UNKNOWN;
  const stored = String(row.verification_status || '').toUpperCase();
  if (isVerificationStatus(stored)) return stored;
  const status = String(row.status || '').toLowerCase();
  if (!TERMINAL_RUN_STATUS.includes(status)) return VERIFICATION_STATUS.RUNNING;
  return verificationFromTestEvents(testEvents) || VERIFICATION_STATUS.NOT_VERIFIED;
}

module.exports = {
  VERIFICATION_STATUS,
  VOCABULARY,
  TERMINAL_RUN_STATUS,
  isVerificationStatus,
  verificationFromOutcome,
  verificationFromTestEvents,
  resolveRunVerificationStatus
};
