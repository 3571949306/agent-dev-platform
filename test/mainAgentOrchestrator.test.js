'use strict';
/**
 * test/mainAgentOrchestrator.test.js
 *
 * v2.9.0 §106/§107 — Unified Main Agent Orchestrator contract tests。
 *
 * 覆盖（§106）：
 *   - Main Agent delegate → AgentHub
 *   - Child result → Blackboard
 *   - Child FAILED → parent continues（不抛）
 *   - self delegation blocked
 *   - delegation depth exceeded
 *   - changedFiles aggregation
 *   - fallback: RUNTIME_UNAVAILABLE 可 fallback
 *   - fallback: PERMISSION_DENIED 禁止（No-Bypass §29）
 *   - external tests externalClaim ≠ localVerification（§53）
 */

const test = require('node:test');
const assert = require('node:assert');

const { createMainAgentOrchestrator } = require('../src/agent/orchestrator/mainAgentOrchestrator');
const { createAgentTask, checkDelegationDepth, isSelfDelegation, MAX_DELEGATION_DEPTH } = require('../src/agent/orchestrator/agentTaskContract');
const { classifyFailure, shouldFallback, FAILURE_TYPE } = require('../src/agent/orchestrator/delegationController');
const { createBlackboard, sanitize } = require('../src/agent/orchestrator/orchestrationBlackboard');

/** Mock AgentHub：记录调用，同步设置 result（让 pollUntilTerminal 立即拿到终态）。 */
function mockHub(opts = {}) {
  const calls = { start: [], route: [], cancel: [] };
  const results = new Map();   // runId -> { status, result }
  let counter = 0;
  return {
    route: (task) => opts.routeResult || [{ agentId: 'fake-codex', score: 100, reasons: [] }, { agentId: 'fake-claude', score: 80, reasons: [] }],
    start: async (agentId, task) => {
      calls.start.push({ agentId, task });
      const runId = 'run-' + (++counter);
      // 同步设置终态 result（adapter "已完成"），pollUntilTerminal 第一次 poll 即拿到
      const outcome = opts.resultFor ? opts.resultFor(runId, agentId) : { status: 'completed', result: { summary: `${agentId} done`, changedFiles: ['src/a.js'] } };
      results.set(runId, outcome);
      return { runId, agentId };
    },
    cancel: async (runId) => { calls.cancel.push(runId); },
    result: async (runId) => results.get(runId) || null,
    calls
  };
}

test('§106 delegate → AgentHub.start 被调用', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'parent-1', parentAgentId: 'native-main', emit: null });
  orch.start('测试目标');
  const r = await orch.delegate({ goal: 'review code', requiredCapabilities: ['review'] }, {});
  assert.strictEqual(hub.calls.start.length, 1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'completed');
  assert.ok(r.agentId);
});

test('§36 Child result → Blackboard', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p1', parentAgentId: 'native-main' });
  await orch.delegate({ goal: 'review', requiredCapabilities: ['review'] });
  const obs = orch.getObservation();
  assert.match(obs, /子 Agent 结果/);
  assert.match(obs, /状态: completed/);
  // §52: changedFiles 聚合
  const snap = orch.blackboard.snapshot();
  assert.ok(snap.childResults.length >= 1);
  assert.ok(snap.changedFiles.includes('src/a.js'));
});

test('§28 Child FAILED → parent continues（不抛异常）', async () => {
  const hub = mockHub({ resultFor: () => ({ status: 'failed', result: { summary: 'agent crashed', errors: ['crash'] } }) });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p2', parentAgentId: 'native-main' });
  const r = await orch.delegate({ goal: 'task', requiredCapabilities: ['coding'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'failed');
  // parent 可继续（不抛）
  assert.doesNotThrow(() => orch.blackboard.buildObservation());
});

test('§42 self delegation blocked', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p3', parentAgentId: 'native-main' });
  // preferredAgentId = parentAgentId → 自委派
  const r = await orch.delegate({ goal: 'self', preferredAgentId: 'native-main', requiredCapabilities: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /SELF_DELEGATION/i.test(e)));
});

test('§44 delegation depth exceeded', () => {
  // 构造已满深度的 delegationPath
  const path = ['native-main', 'codex', 'claude'];  // depth 3
  assert.strictEqual(checkDelegationDepth(path), false);
  assert.strictEqual(checkDelegationDepth(['native-main']), true);
  assert.strictEqual(MAX_DELEGATION_DEPTH, 3);
});

test('§52 changedFiles aggregation across multiple children', async () => {
  let i = 0;
  const hub = mockHub({
    resultFor: () => {
      i++;
      return { status: 'completed', result: { summary: 'done', changedFiles: [`file${i}.js`] } };
    }
  });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p4', parentAgentId: 'native-main' });
  await orch.delegate({ goal: 't1', requiredCapabilities: ['review'] });
  await orch.delegate({ goal: 't2', requiredCapabilities: ['review'] });
  const snap = orch.blackboard.snapshot();
  assert.ok(snap.changedFiles.includes('file1.js'));
  assert.ok(snap.changedFiles.includes('file2.js'));
});

test('§31 fallback: RUNTIME_UNAVAILABLE 可自动 fallback', async () => {
  let attempt = 0;
  const hub = mockHub({
    routeResult: [{ agentId: 'agent-a', score: 100 }, { agentId: 'agent-b', score: 80 }],
    resultFor: (_runId, agentId) => {
      attempt++;
      if (agentId === 'agent-a') return { status: 'unavailable', result: { summary: 'not installed' } };
      return { status: 'completed', result: { summary: 'b done' } };
    }
  });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p5', parentAgentId: 'native-main' });
  const r = await orch.delegate({ goal: 'task', requiredCapabilities: ['coding'] }, { maxAttempts: 2 });
  // 应 fallback 到 agent-b 并完成
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.agentId, 'agent-b');
});

test('§32 fallback: PERMISSION_DENIED 禁止（No-Bypass）', async () => {
  const hub = mockHub({
    routeResult: [{ agentId: 'agent-a', score: 100 }, { agentId: 'agent-b', score: 80 }],
    resultFor: () => ({ status: 'failed', result: { summary: 'permission denied', error: 'PERMISSION_DENIED: EPERM' } })
  });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p6', parentAgentId: 'native-main' });
  const r = await orch.delegate({ goal: 'task', requiredCapabilities: ['coding'] }, { maxAttempts: 2 });
  assert.strictEqual(r.ok, false);
  // 不应 fallback（只 start 一次）
  assert.strictEqual(hub.calls.start.length, 1);
});

test('§53 external tests externalClaim ≠ localVerification', async () => {
  const hub = mockHub({
    resultFor: () => ({ status: 'completed', result: { summary: 'done', tests: { passed: true, summary: 'all pass' } } })
  });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p7', parentAgentId: 'native-main' });
  await orch.delegate({ goal: 'task', requiredCapabilities: ['coding'] });
  const snap = orch.blackboard.snapshot();
  const cr = snap.childResults[0];
  assert.ok(cr.tests);
  assert.strictEqual(cr.tests.externalClaim, true);   // §53: external ≠ local
  assert.strictEqual(cr.tests.passed, true);
});

test('§29 No-Bypass: classifyFailure + shouldFallback', () => {
  assert.strictEqual(classifyFailure({ status: 'failed', error: 'permission denied EPERM' }), FAILURE_TYPE.PERMISSION_DENIED);
  assert.strictEqual(shouldFallback(FAILURE_TYPE.PERMISSION_DENIED), false);
  assert.strictEqual(shouldFallback(FAILURE_TYPE.RUNTIME_UNAVAILABLE), true);
  assert.strictEqual(shouldFallback(FAILURE_TYPE.CRASH), true);
  assert.strictEqual(shouldFallback(FAILURE_TYPE.USER_CANCELLED), false);
});

test('§115 secret sanitization in blackboard', async () => {
  const hub = mockHub({
    resultFor: () => ({ status: 'completed', result: { summary: 'found key sk-abc123 in code', findings: ['token=Bearer xyz123'] } })
  });
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p8', parentAgentId: 'native-main' });
  await orch.delegate({ goal: 'task', requiredCapabilities: ['review'] });
  const snap = orch.blackboard.snapshot();
  const cr = snap.childResults[0];
  assert.match(cr.summary, /\[REDACTED\]/);
  assert.ok(!/sk-abc123/.test(cr.summary));
});

test('§23 ChildRunTracker: register/getChildren/cancel cascade', async () => {
  const hub = mockHub();
  const orch = createMainAgentOrchestrator({ hub, parentRunId: 'p9', parentAgentId: 'native-main' });
  // delegate 后 child 注册到 tracker
  const r = await orch.delegate({ goal: 'task', requiredCapabilities: ['review'] });
  const children = orch.getChildren();
  assert.ok(children.length >= 1);
  assert.ok(children.includes(r.runId));
});

test('§11 AgentTask contract: createAgentTask validation', () => {
  const { ok, task } = createAgentTask({ goal: 'review', requiredCapabilities: ['review'], readOnly: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(task.goal, 'review');
  assert.strictEqual(task.readOnly, true);
  assert.deepStrictEqual(task.requiredCapabilities, ['review']);
  assert.ok(task.id);
  assert.ok(task.budget.maxRuntimeMs > 0);
  const bad = createAgentTask({});
  assert.strictEqual(bad.ok, false);
});

test('§42 isSelfDelegation', () => {
  assert.strictEqual(isSelfDelegation('native-main', 'native-main'), true);
  assert.strictEqual(isSelfDelegation('native-main', 'codex'), false);
  assert.strictEqual(isSelfDelegation(null, 'codex'), false);
});
