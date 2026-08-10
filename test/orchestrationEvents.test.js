'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 4 统一 Delegation 事件命名空间（spec §65-76）。
 *
 * 验证：
 *   - 单一标准命名空间 orchestration.*（后端 / 前端统一消费）
 *   - Legacy alias agent.delegation.*（过渡兼容）
 *   - delegationTerminalEvent 映射 completed/cancelled/failed(timeout/...)
 *   - isDelegationEventType 同时匹配 canonical + legacy（前端分流）
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  ORCHESTRATION_EVENT, LEGACY_EVENT, delegationTerminalEvent, isDelegationEventType
} = require('../src/agent/orchestrator/events');

test('§65 单一标准命名空间 orchestration.*', () => {
  assert.strictEqual(ORCHESTRATION_EVENT.RUN_STARTED, 'orchestration.run.started');
  assert.strictEqual(ORCHESTRATION_EVENT.DELEGATION_STARTED, 'orchestration.delegation.started');
  assert.strictEqual(ORCHESTRATION_EVENT.DELEGATION_COMPLETED, 'orchestration.delegation.completed');
  assert.strictEqual(ORCHESTRATION_EVENT.DELEGATION_FAILED, 'orchestration.delegation.failed');
  assert.strictEqual(ORCHESTRATION_EVENT.DELEGATION_CANCELLED, 'orchestration.delegation.cancelled');
  assert.strictEqual(ORCHESTRATION_EVENT.VERIFICATION_STARTED, 'orchestration.verification.started');
  assert.strictEqual(ORCHESTRATION_EVENT.RUN_COMPLETED, 'orchestration.run.completed');
});

test('§65/§71 Legacy alias 仍存在（过渡兼容）', () => {
  assert.strictEqual(LEGACY_EVENT.DELEGATION_STARTED, 'agent.delegation.started');
  assert.strictEqual(LEGACY_EVENT.DELEGATION_TERMINAL, 'agent.delegation.terminal');
});

test('§72 delegationTerminalEvent 映射 completed', () => {
  assert.strictEqual(delegationTerminalEvent('completed'), ORCHESTRATION_EVENT.DELEGATION_COMPLETED);
});

test('§72 delegationTerminalEvent 映射 cancelled', () => {
  assert.strictEqual(delegationTerminalEvent('cancelled'), ORCHESTRATION_EVENT.DELEGATION_CANCELLED);
});

test('§72 delegationTerminalEvent 映射 failed/timeout/unknown → DELEGATION_FAILED', () => {
  assert.strictEqual(delegationTerminalEvent('failed'), ORCHESTRATION_EVENT.DELEGATION_FAILED);
  assert.strictEqual(delegationTerminalEvent('timeout'), ORCHESTRATION_EVENT.DELEGATION_FAILED);
  assert.strictEqual(delegationTerminalEvent('interrupted'), ORCHESTRATION_EVENT.DELEGATION_FAILED);
  assert.strictEqual(delegationTerminalEvent('weird'), ORCHESTRATION_EVENT.DELEGATION_FAILED);
});

test('§65 isDelegationEventType 匹配 canonical', () => {
  assert.strictEqual(isDelegationEventType('orchestration.delegation.started'), true);
  assert.strictEqual(isDelegationEventType('orchestration.delegation.completed'), true);
});

test('§65 isDelegationEventType 匹配 legacy（前端仍能分流旧事件）', () => {
  assert.strictEqual(isDelegationEventType('agent.delegation.started'), true);
  assert.strictEqual(isDelegationEventType('agent.delegation.terminal'), true);
});

test('§65 isDelegationEventType 拒绝非 delegation 事件', () => {
  assert.strictEqual(isDelegationEventType('orchestration.run.started'), false);
  assert.strictEqual(isDelegationEventType('agent.something.else'), false);
  assert.strictEqual(isDelegationEventType(null), false);
});
