'use strict';
/**
 * v2.9.0 Framework Closure Patch — 生产集成测试（spec §103-105）。
 *
 * 不使用 mockHub：使用真实 createAgentHub() + RunBridge + RunManager + TestAgentAdapter
 * + MainAgentRuntime（runMainAgent），验证完整闭环：
 *   Fake LLM（先 delegate reviewer → 读 → 修 → run_tests → complete）
 *   → MainAgentRuntime
 *   → MainAgentOrchestrator（Main Agent 自己生成 delegate，§24 禁止测试代发）
 *   → AgentHub（生产契约：register/start/Child Run/AgentResult）
 *   → read-only reviewer（TestAgentAdapter）
 *   → Blackboard（child result 写回）
 *   → Main Agent 读 / 修 / run_tests
 *   → complete
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createFakeCodingModel, buildFixAddScript } = require('../src/agent/runtime/fakeCodingModel');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { TestAgentAdapter } = require('../src/agents/adapters/testAgentAdapter');
const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { ORCHESTRATION_EVENT } = require('../src/agent/orchestrator/events');
const toolRegistry = require('../src/tools/registry');
const { copyFixture, cleanup } = require('./fixtures/coding-agent/reset');

function getTool(name) {
  const b = toolRegistry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

test('§103-105 生产集成：Fake LLM + 真实 AgentHub + TestAgentAdapter child + MainAgentRuntime → complete', async () => {
  const root = await copyFixture();
  const prevHub = getAgentHub();
  try {
    const registry = createAgentRegistry();
    const lm = createLifecycleManager();
    const rm = new RunManager();
    const runBridge = createRunBridge({ runManager: rm, lifecycleManager: lm });
    const hub = createAgentHub({
      registry,
      router: createAgentRouter({ registry }),
      healthManager: createHealthManager({ registry }),
      lifecycleManager: lm,
      runBridge
    });
    setAgentHub(hub);   // runMainAgent 内部据此创建 Orchestrator → delegate 走真实 AgentHub

    // §25-27：read-only reviewer 子 Agent（走生产 AgentHub 契约）
    const reviewer = new TestAgentAdapter({
      id: 'reviewer',
      transport: 'sdk',
      capabilities: ['review', 'filesystem.read'],
      resultText: 'src/math.js 的 add(a,b) 使用 a - b，与测试期待 add(2,3) === 5 不一致。建议将减法改为加法。',
      delayMs: 20   // 稍后完成，确保 lifecycle RUNNING → COMPLETED 合法迁移
    });
    hub.register(reviewer);

    // Fake LLM：先 delegate 给 reviewer，再读 / 修 / run_tests / complete（§24 模型自发生成 delegate）
    const script = buildFixAddScript();
    script.unshift({
      type: 'delegate',
      args: { task: 'review src/math.js and report the bug', requiredCapabilities: ['review'], agentId: 'reviewer', readOnly: true },
      thought: '先委派只读 reviewer 检查错误'
    });
    const fakeModel = createFakeCodingModel(script);

    const observed = [];
    const emit = (type, payload) => observed.push({ type, payload });

    const { runId } = runMainAgent({
      conversationId: 'integration-test',
      agentId: 'native-main',
      agentName: 'Main Agent',
      goal: 'fix add and ensure tests pass',
      projectRoot: root,
      projectId: null,
      model: fakeModel,
      getTool,
      store: null,
      emit,
      runManager: rm,
      timeoutMs: 60000,
      registerAbort: () => {},
      unregisterAbort: () => {}
    });

    // 等待 Parent Run 终态
    let status = null;
    for (let i = 0; i < 160; i++) {
      const r = rm.getRun(runId);
      if (r && ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)) { status = r.status; break; }
      await new Promise(res => setTimeout(res, 250));
    }
    assert.strictEqual(status, 'completed', `Parent Run 应 completed，实际 ${status}`);

    // §29-30：Main Agent 自己产生 delegate（经 Orchestrator，非测试代发）
    const delegationStarted = observed.find(e => e.type === ORCHESTRATION_EVENT.DELEGATION_STARTED || e.type === 'agent.delegation.started');
    assert.ok(delegationStarted, '应观测到 delegation.started（Main Agent 自发生成 delegate）');
    assert.strictEqual(delegationStarted.payload.agentId, 'reviewer', 'delegate 目标应为 reviewer 子 Agent');
    assert.strictEqual(delegationStarted.payload.readOnly, true, 'reviewer 应为 read-only（§26）');

    // Blackboard consumed：delegate 完成后应写回 child result（观测到 delegation 终态）
    const delegationCompleted = observed.find(e => e.type === ORCHESTRATION_EVENT.DELEGATION_COMPLETED || e.type === 'agent.delegation.terminal');
    assert.ok(delegationCompleted, '应观测到 delegation 终态事件（child result 进入 Blackboard）');

    // §103-105：文件确实被修复且测试通过
    const after = fs.readFileSync(path.join(root, 'src', 'math.js'), 'utf8');
    assert.ok(after.includes('return a + b'), 'add 应被修复为 a + b');
  } finally {
    setAgentHub(prevHub);
    await cleanup(root);
  }
});
