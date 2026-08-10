'use strict';
/**
 * test/permissionDecision.test.js（spec §20/§21/§26/§28）。
 *
 * decidePermission 是权限裁决的最后一环，输入三样东西：
 *   evaluation — 策略层的初判（父 Run 只读 / 平台策略等）
 *   riskInfo   — PermissionRiskClassifier 的风险档位
 *   opts       — 是否有 GUI resolver、项目是否 auto-allow medium
 *
 * 两条不变量：
 *   §28 有 GUI resolver 时平台不替用户做选择 → decisionSource 恒为 USER
 *   §26 无 GUI resolver 时 fail-closed：仅 LOW 自动放行，MEDIUM 需项目显式
 *       auto-allow，HIGH / CRITICAL 一律拒绝
 *   策略层已拒绝的，风险再低也维持拒绝，并保留原始拒绝原因
 */
const test = require('node:test');
const assert = require('node:assert');

const { decidePermission } = require('../src/agents/protocols/acp/permissionBroker');

test('无 resolver + low → 自动放行（POLICY_AUTO_ALLOW）', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: true }, { risk: 'low' }, { hasResolver: false }),
    { granted: true, decisionSource: 'POLICY_AUTO_ALLOW' }
  );
});

test('无 resolver + critical → fail-closed 拒绝', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: true }, { risk: 'critical' }, { hasResolver: false }),
    { granted: false, decisionSource: 'RISK_FAIL_CLOSED' }
  );
});

test('无 resolver + high → fail-closed 拒绝', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: true }, { risk: 'high' }, { hasResolver: false }),
    { granted: false, decisionSource: 'RISK_FAIL_CLOSED' }
  );
});

test('无 resolver + medium → 默认 fail-closed 拒绝', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: true }, { risk: 'medium' }, { hasResolver: false }),
    { granted: false, decisionSource: 'RISK_FAIL_CLOSED' }
  );
});

test('无 resolver + medium + 项目显式 auto-allow → 放行（PROJECT_POLICY）', () => {
  assert.deepStrictEqual(
    decidePermission(
      { granted: true },
      { risk: 'medium' },
      { hasResolver: false, autoAllowMedium: true }
    ),
    { granted: true, decisionSource: 'PROJECT_POLICY' }
  );
});

test('有 GUI resolver → 交由用户决定（USER），平台不自动 allow_always（§28）', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: true }, { risk: 'low' }, { hasResolver: true }),
    { granted: true, decisionSource: 'USER' }
  );
});

test('策略层已拒绝时维持拒绝，并保留原始原因', () => {
  assert.deepStrictEqual(
    decidePermission({ granted: false, reason: 'PARENT_READ_ONLY' }, { risk: 'low' }, {}),
    { granted: false, decisionSource: 'PARENT_READ_ONLY' }
  );
});
