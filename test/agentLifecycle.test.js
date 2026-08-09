'use strict';
/**
 * LifecycleManager tests.
 *
 * Verifies:
 *   - createRun returns run with idle status
 *   - transition updates state
 *   - terminal states cannot transition out
 *   - getRun returns run
 *   - listActive returns non-terminal runs
 *   - listByAgent returns runs for specific agent
 *   - cancel sets state to cancelled
 *   - isTerminal returns true for terminal states
 *   - createRun with parentRunId links runs
 */
const test = require('node:test');
const assert = require('node:assert');

const { createLifecycleManager, isTerminalState, TERMINAL_STATES } = require('../src/agents/hub/lifecycleManager');
const { LIFECYCLE } = require('../src/agents/hub/types');

test('createRun: 返回 idle 状态的 run', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a', goal: 'do something' });
  assert.strictEqual(run.status, LIFECYCLE.IDLE);
  assert.strictEqual(run.agentId, 'a');
  assert.strictEqual(run.goal, 'do something');
  assert.ok(run.id);
  assert.ok(run.startedAt > 0);
  assert.strictEqual(run.terminalAt, null);
  assert.strictEqual(run.result, null);
  assert.strictEqual(run.error, null);
  assert.strictEqual(run.parentRunId, null);
  assert.deepStrictEqual(run.metadata, {});
});

test('createRun: 缺省参数有合理默认值', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun();
  assert.strictEqual(run.agentId, null);
  assert.strictEqual(run.taskId, null);
  assert.strictEqual(run.goal, null);
  assert.strictEqual(run.adapterType, null);
});

test('transition: 合法迁移更新状态', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  const updated = lm.transition(run.id, LIFECYCLE.STARTING);
  assert.strictEqual(updated.status, LIFECYCLE.STARTING);
  assert.ok(updated.updatedAt >= run.startedAt);
});

test('transition: idle → running 直接迁移被拒绝（必须经过 starting）', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  // idle -> running 不在合法表里
  const r = lm.transition(run.id, LIFECYCLE.RUNNING);
  assert.strictEqual(r.status, LIFECYCLE.IDLE, '非法非终态迁移应保留原状态');
});

test('transition: 非终态 → 终态始终合法', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  const r = lm.transition(run.id, LIFECYCLE.FAILED, 'something broke');
  assert.strictEqual(r.status, LIFECYCLE.FAILED);
  assert.strictEqual(r.error, 'something broke');
  assert.ok(r.terminalAt > 0);
});

test('transition: completed 存为 result', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  lm.transition(run.id, LIFECYCLE.RUNNING);
  const r = lm.transition(run.id, LIFECYCLE.COMPLETED, { summary: 'done' });
  assert.strictEqual(r.status, LIFECYCLE.COMPLETED);
  assert.deepStrictEqual(r.result, { summary: 'done' });
  assert.strictEqual(r.error, null);
});

test('transition: 终态后无法再迁移', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  lm.transition(run.id, LIFECYCLE.COMPLETED, 'done');
  // 已终态：所有后续迁移被忽略
  const r1 = lm.transition(run.id, LIFECYCLE.RUNNING);
  assert.strictEqual(r1.status, LIFECYCLE.COMPLETED);
  const r2 = lm.transition(run.id, LIFECYCLE.FAILED, 'late error');
  assert.strictEqual(r2.status, LIFECYCLE.COMPLETED);
  assert.strictEqual(r2.error, null);
});

test('transition: 不存在的 runId 返回 null', () => {
  const lm = createLifecycleManager();
  assert.strictEqual(lm.transition('missing', LIFECYCLE.RUNNING), null);
});

test('getRun: 返回 run 或 null', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  assert.strictEqual(lm.getRun(run.id), run);
  assert.strictEqual(lm.getRun('missing'), null);
});

test('listActive: 只返回非终态 run', () => {
  const lm = createLifecycleManager();
  const r1 = lm.createRun({ agentId: 'a' });
  const r2 = lm.createRun({ agentId: 'a' });
  const r3 = lm.createRun({ agentId: 'b' });
  lm.transition(r1.id, LIFECYCLE.STARTING);
  lm.transition(r1.id, LIFECYCLE.RUNNING);
  lm.transition(r2.id, LIFECYCLE.STARTING);
  lm.transition(r2.id, LIFECYCLE.COMPLETED, 'done');
  const active = lm.listActive();
  const ids = active.map(r => r.id);
  assert.ok(ids.includes(r1.id));
  assert.ok(ids.includes(r3.id));
  assert.ok(!ids.includes(r2.id));
});

test('listByAgent: 返回指定 agent 的所有 run', () => {
  const lm = createLifecycleManager();
  const r1 = lm.createRun({ agentId: 'a' });
  const r2 = lm.createRun({ agentId: 'a' });
  const r3 = lm.createRun({ agentId: 'b' });
  const aRuns = lm.listByAgent('a');
  assert.strictEqual(aRuns.length, 2);
  assert.ok(aRuns.every(r => r.agentId === 'a'));
  const bRuns = lm.listByAgent('b');
  assert.strictEqual(bRuns.length, 1);
  assert.strictEqual(bRuns[0].id, r3.id);
  assert.strictEqual(lm.listByAgent('missing').length, 0);
});

test('cancel: 设置状态为 cancelled', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  lm.transition(run.id, LIFECYCLE.RUNNING);
  const r = lm.cancel(run.id, 'user cancelled');
  assert.strictEqual(r.status, LIFECYCLE.CANCELLED);
  assert.strictEqual(r.error, 'user cancelled');
  assert.ok(r.terminalAt > 0);
});

test('cancel: 默认原因', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  const r = lm.cancel(run.id);
  assert.strictEqual(r.error, '用户已取消');
});

test('isTerminal: 终态返回 true，非终态返回 false', () => {
  const lm = createLifecycleManager();
  const run = lm.createRun({ agentId: 'a' });
  assert.strictEqual(lm.isTerminal(run.id), false);
  lm.transition(run.id, LIFECYCLE.STARTING);
  lm.transition(run.id, LIFECYCLE.RUNNING);
  assert.strictEqual(lm.isTerminal(run.id), false);
  lm.transition(run.id, LIFECYCLE.COMPLETED, 'done');
  assert.strictEqual(lm.isTerminal(run.id), true);
});

test('isTerminal: 不存在的 runId 返回 false', () => {
  const lm = createLifecycleManager();
  assert.strictEqual(lm.isTerminal('missing'), false);
});

test('isTerminalState: 终态常量正确', () => {
  for (const s of [LIFECYCLE.COMPLETED, LIFECYCLE.FAILED, LIFECYCLE.CANCELLED, LIFECYCLE.TIMEOUT, LIFECYCLE.UNAVAILABLE]) {
    assert.strictEqual(isTerminalState(s), true, `${s} 应为终态`);
  }
  for (const s of [LIFECYCLE.IDLE, LIFECYCLE.STARTING, LIFECYCLE.RUNNING, LIFECYCLE.WAITING]) {
    assert.strictEqual(isTerminalState(s), false, `${s} 不应为终态`);
  }
  assert.strictEqual(TERMINAL_STATES.length, 5);
});

test('createRun: parentRunId 链接父子 run', () => {
  const lm = createLifecycleManager();
  const parent = lm.createRun({ agentId: 'main' });
  const child = lm.createRun({ agentId: 'sub', parentRunId: parent.id });
  assert.strictEqual(child.parentRunId, parent.id);
  assert.notStrictEqual(child.id, parent.id);
});

test('createRun: 发射 RUN_STARTED 事件', () => {
  const events = [];
  const lm = createLifecycleManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  lm.createRun({ agentId: 'a', goal: 'g' });
  assert.ok(events.some(e => e.type === 'agent.run.started'));
});

test('transition: 终态时发射专用事件', () => {
  const events = [];
  const lm = createLifecycleManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  const run = lm.createRun({ agentId: 'a' });
  lm.transition(run.id, LIFECYCLE.STARTING);
  lm.transition(run.id, LIFECYCLE.RUNNING);
  lm.transition(run.id, LIFECYCLE.COMPLETED, 'done');
  const types = events.map(e => e.type);
  assert.ok(types.includes('agent.run.completed'));
});
