'use strict';
/**
 * v2.9.9 Phase B Final（B15.1）— Connection Status Truth。
 *
 * 连接状态词汇只能从真实测试真话推导，绝不允许「没报错就是 READY」式猜测：
 *   AVAILABLE   最近一次真实测试成功（延迟正常）
 *   DEGRADED    最近一次真实测试成功但延迟过高（真实测量值推导）
 *   UNAVAILABLE 最近一次真实测试报告失败（provider 返回的错误）
 *   ERROR       最近一次测试动作本身异常（provider 崩溃/不可用）
 *   UNKNOWN     从未测试 —— 未知就是未知
 */

const CONNECTION_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
  ERROR: 'ERROR'
});

// 真实测量延迟超过该阈值视为降级（不是猜测，来自最近一次测试的 latency_ms）。
const DEGRADED_LATENCY_MS = 3000;

/** 旧库没有 test_state 列时的确定性回退：tested=1 → ok；有 last_error → failed；否则未知。 */
function legacyTestState(conn) {
  if (conn.tested) return 'ok';
  if (conn.last_error) return 'failed';
  return '';
}

function resolveConnectionStatus(conn) {
  if (!conn) return { status: CONNECTION_STATUS.UNKNOWN, reason: 'NO_CONNECTION', latencyMs: null, lastTestedAt: null };
  const state = conn.test_state || legacyTestState(conn);
  const lastTestedAt = conn.tested_at || null;
  const latencyMs = typeof conn.latency_ms === 'number' ? conn.latency_ms : null;
  switch (state) {
    case 'ok':
      if (latencyMs !== null && latencyMs > DEGRADED_LATENCY_MS) {
        return { status: CONNECTION_STATUS.DEGRADED, reason: 'HIGH_LATENCY', latencyMs, lastTestedAt };
      }
      return { status: CONNECTION_STATUS.AVAILABLE, reason: 'TEST_OK', latencyMs, lastTestedAt };
    case 'failed':
      return { status: CONNECTION_STATUS.UNAVAILABLE, reason: conn.last_error || 'TEST_FAILED', latencyMs, lastTestedAt };
    case 'error':
      return { status: CONNECTION_STATUS.ERROR, reason: conn.last_error || 'TEST_ERROR', latencyMs, lastTestedAt };
    default:
      return { status: CONNECTION_STATUS.UNKNOWN, reason: 'NEVER_TESTED', latencyMs: null, lastTestedAt: null };
  }
}

/** B15.1 — Auth Mode：只描述真实存储形态，不代表凭据有效性。 */
function resolveAuthMode(conn) {
  if (!conn) return 'UNKNOWN';
  const hasKey = !!conn.has_key;
  const hasHeaders = !!(conn.header_names || []).length;
  if (hasKey && hasHeaders) return 'API_KEY_HEADERS';
  if (hasKey) return 'API_KEY';
  if (hasHeaders) return 'CUSTOM_HEADERS';
  return 'NO_AUTH';
}

module.exports = { CONNECTION_STATUS, DEGRADED_LATENCY_MS, resolveConnectionStatus, resolveAuthMode };
