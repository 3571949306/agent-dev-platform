'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 3 Child Cancel（spec §56-64）。
 *
 * 验证：
 *   - orchestrator.cancelChild(childRunId) 经 bridge → ChildRunTracker.cancel → hub.cancel
 *   - §64：cancel 后 child 进入 terminal(cancelled)，tracker 状态正确
 *   - 父 orchestrator 在 child 取消后仍存在（parent continues，§89）
 *   - §57-58：IPC orchestrator:cancelChild 语义等价于 registry.get(parentRunId).cancelChild
 *
 * 关键契约（§19）：delegate 会 await child terminal，因此本测试在「后台」启动 delegate，
 * 待 child 注册进 tracker 后由「外部 IPC 层」并发调用 cancelChild（真实 GUI 即此模式），
 * 随后 delegate 应在 child 被取消后 resolve（status=cancelled），不再挂起。
 *
 * 注：完整 GUI E2E（child stop 按钮 / delegation reason 渲染）在 orchestration.js / api.js
 * 已落地；此处以 IPC / tracker 单元级验证其底层契约，避免脆弱的浏览器级 flaky。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createMainAgentOrchestrator, register, get, unregister } = require('../src/agent/orchestrator/mainAgentOrchestrator');

function mockHub(opts = {}) {
  const calls = { start: [], route: [], cancel: [] };
  const results = new Map();
  let counter = 0;
  return {
    route: () => opts.routeResult || [{ agentId: 'reviewer', score: 100, reasons: ['read-only review'] }],
    start: async (agentId, task) => {
      calls.start.push({ agentId, task });
      const runId = 'run-' + (++counter);
      results.set(runId, { status: 'running', result: null });
      return { runId, agentId };
    },
    cancel: async (runId) => { calls.cancel.push(runId); results.set(runId, { status: 'cancelled', result: null }); },
    result: async (runId) => results.get(runId) || null,
    calls
  };
}

// delegate 会 await child terminal（mockHub 不自动完成），用轮询等待中间态而不阻塞测试
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

test('§64 cancelChild：child 进入 terminal(cancelled)，hub.cancel 被调用', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p-cancel-1', parentAgentId: 'native-main' });
  register('p-cancel-1', orch);
  orch.start('goal');

  // delegate 会 await child terminal（§19），mockHub 不自动完成 → 后台启动
  const delegatePromise = orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });

  // 等到 child 已在 tracker 注册（hub.start 已调用，尚未 terminal）
  const registered = await waitFor(() => orch.childRunTracker.getChildren('p-cancel-1').length > 0);
  assert.ok(registered, 'child 应在后台 delegate 中注册');
  const childRunId = orch.childRunTracker.getChildren('p-cancel-1')[0];
  assert.ok(childRunId, '应返回 child runId');

  // 此时 child 仍 running → 外部 IPC 层取消
  const cancelled = await orch.cancelChild(childRunId);
  assert.ok(cancelled.includes(childRunId), 'cancelChild 应返回被取消的 childRunId');
  assert.strictEqual(orch.childRunTracker.isTerminal(childRunId), true, 'child 应进入 terminal');
  assert.ok(hub.calls.cancel.includes(childRunId), 'hub.cancel 应被调用（外部 abort）');

  // 背景 delegate 应在 cancel 后 resolve（status=cancelled），不再挂起
  const res = await delegatePromise;
  assert.strictEqual(res.status, 'cancelled', 'delegate 在 child 取消后应返回 cancelled');

  unregister('p-cancel-1');
});

test('§89 parent 在 child 取消后仍存在（parent continues）', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p-cancel-2', parentAgentId: 'native-main' });
  register('p-cancel-2', orch);

  const delegatePromise = orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });
  await waitFor(() => orch.childRunTracker.getChildren('p-cancel-2').length > 0);
  const childRunId = orch.childRunTracker.getChildren('p-cancel-2')[0];
  await orch.cancelChild(childRunId);
  await delegatePromise; // 必须 resolve，不得挂起

  // 父 orchestrator 仍在 registry（未被取消）
  assert.strictEqual(get('p-cancel-2'), orch, 'parent orchestrator 应仍存在');
  assert.strictEqual(orch.childRunTracker.isTerminal(childRunId), true);

  unregister('p-cancel-2');
});

test('§57-58 IPC 语义：orchestrator:cancelChild = registry.get(parentRunId).cancelChild', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p-cancel-3', parentAgentId: 'native-main' });
  register('p-cancel-3', orch);

  const delegatePromise = orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });
  await waitFor(() => orch.childRunTracker.getChildren('p-cancel-3').length > 0);
  const childRunId = orch.childRunTracker.getChildren('p-cancel-3')[0];

  // 模拟 IPC 层：先 orchestratorGet(parentRunId)，再 cancelChild(childRunId)
  const lookedUp = get('p-cancel-3');
  assert.strictEqual(lookedUp, orch);
  const cancelled = await lookedUp.cancelChild(childRunId);
  assert.ok(cancelled.includes(childRunId));
  assert.strictEqual(orch.childRunTracker.isTerminal(childRunId), true);

  await delegatePromise;

  unregister('p-cancel-3');
});
