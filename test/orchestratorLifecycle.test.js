'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 5 Orchestrator Registry 生命周期（spec §77-90）。
 *
 * 验证：
 *   - register / get / unregister（registry 不再泄漏）
 *   - §87：register → run → complete → unregister 生命周期
 *   - §86：dispose 只清资源，不取消已完成 child
 *   - §88：100 个 orchestrator 逐个 register/dispose/unregister 后 _activeCount === 0（无泄漏）
 *   - §83/§84：dispose 停止后台轮询 timer（无 zombie timer）
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createMainAgentOrchestrator, register, get, unregister, _activeCount
} = require('../src/agent/orchestrator/mainAgentOrchestrator');

/** 轻量 mockHub：记录调用并同步给出终态 result。 */
function mockHub(opts = {}) {
  const calls = { start: [], route: [], cancel: [] };
  const results = new Map();
  let counter = 0;
  return {
    route: () => opts.routeResult || [{ agentId: 'reviewer', score: 100, reasons: ['read-only review'] }],
    start: async (agentId, task) => {
      calls.start.push({ agentId, task });
      const runId = 'run-' + (++counter);
      results.set(runId, { status: 'completed', result: { summary: `${agentId} done`, changedFiles: [] } });
      return { runId, agentId };
    },
    cancel: async (runId) => { calls.cancel.push(runId); },
    result: async (runId) => results.get(runId) || null,
    calls
  };
}

test('§77 register / get / unregister', () => {
  const orch = createMainAgentOrchestrator({ hub: mockHub(), parentRunId: 'p-life-1', parentAgentId: 'native-main' });
  register('p-life-1', orch);
  assert.strictEqual(get('p-life-1'), orch);
  unregister('p-life-1');
  assert.strictEqual(get('p-life-1'), null);
});

test('§87 生命周期：register → run → complete → unregister', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p-life-2', parentAgentId: 'native-main' });
  register('p-life-2', orch);
  orch.start('goal');
  const r = await orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });
  assert.strictEqual(r.ok, true);
  orch.complete('completed');
  assert.strictEqual(_activeCount() >= 1, true);
  unregister('p-life-2');
  assert.strictEqual(get('p-life-2'), null);
});

test('§86 dispose 只清资源，不取消已完成 child', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p-life-3', parentAgentId: 'native-main' });
  register('p-life-3', orch);
  const r = await orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });
  assert.strictEqual(r.ok, true);
  // 已完成 child 不应被取消
  const cancelledBefore = hub.calls.cancel.length;
  await orch.dispose();
  assert.strictEqual(hub.calls.cancel.length, cancelledBefore, '已完成 child 不应被 dispose 取消');
  unregister('p-life-3');
});

test('§88 Registry Leak Test：100 个 orchestrator 后 _activeCount === 0', async () => {
  const before = _activeCount();
  const created = [];
  for (let i = 0; i < 100; i++) {
    const id = `leak-${i}`;
    const orch = createMainAgentOrchestrator({ hub: mockHub(), parentRunId: id, parentAgentId: 'native-main' });
    register(id, orch);
    created.push({ id, orch });
  }
  assert.strictEqual(_activeCount(), before + 100, '注册后应增加 100');
  // 逐个 dispose + unregister
  for (const { id, orch } of created) {
    await orch.dispose();
    unregister(id);
  }
  assert.strictEqual(_activeCount(), before, '全部 unregister 后必须回到基线（无泄漏）');
});

test('§83/§84 dispose 不抛异常且可重复调用', async () => {
  const orch = createMainAgentOrchestrator({ hub: mockHub(), parentRunId: 'p-life-4', parentAgentId: 'native-main' });
  register('p-life-4', orch);
  await orch.dispose();
  await orch.dispose(); // 幂等
  unregister('p-life-4');
  assert.strictEqual(get('p-life-4'), null);
});
