'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 1 Native Hub 生产路径集成测试（spec §16-17）。
 *
 * 验证：真实的 AgentHub.start('native-main') 经统一的 contextFactory（含
 * nativeModelContextResolver）构建出带 decide() 的真实 Model Adapter，进入
 * NativeAgentAdapter.startTask → runMainAgent → AgentLoop → terminal，
 * 不再因 model=null / 缺 runManager / getTool / store 而 FAIL。
 *
 * 与 handlers.js 完全一致的 contextFactory 注入；parentModelContext 用
 * FakeCodingModel 作为真实 Model Adapter（带 decide）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createFakeCodingModel, buildFixAddScript } = require('../src/agent/runtime/fakeCodingModel');
const { createExecutionContextFactory } = require('../src/agent/orchestrator');
const { createNativeModelContextResolver } = require('../src/agent/orchestrator/nativeModelContextResolver');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { NativeAgentAdapter } = require('../src/agents/adapters/nativeAgentAdapter');
const { NATIVE_MAIN } = require('../src/agents/manifests/builtinAgents');
const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const toolRegistry = require('../src/tools/registry');
// v2.9.0 Real Runtime Closure（R3）：contextFactory 的 pathSecurity 现在会真正传入
// 工具层，禁止 fake allow-all；使用生产 PathSecurity。
const pathSecurity = require('../src/security/pathSecurity');
const { copyFixture, cleanup } = require('./fixtures/coding-agent/reset');

function getTool(name) {
  const b = toolRegistry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

const FAKE_PROVIDER = { id: 'fake', streamResponse: async () => ({ content: '' }) };

test('§16-17 AgentHub.start(native-main) → NativeAgentAdapter → runMainAgent → AgentLoop → terminal', async () => {
  const root = await copyFixture();
  try {
    const rm = new RunManager();
    // §8-17：与 handlers.js 完全一致的 contextFactory（nativeModelContextResolver + parentModelContext）。
    const fakeModel = createFakeCodingModel(buildFixAddScript());
    const contextFactory = createExecutionContextFactory({
      runManager: rm,
      getTool,
      store: null,
      buildProvider: () => FAKE_PROVIDER,
      resolveModel: () => ({ model: 'fake', provider: 'fake', connectionId: 'c' }),
      pathSecurity,
      projectMutationLock: { acquireWrite: () => ({ ok: true }), acquireRead: () => ({ ok: true }), release: () => {} },
      emit: () => {},
      nativeModelContextResolver: createNativeModelContextResolver({
        buildProvider: () => FAKE_PROVIDER,
        resolveModel: () => ({ model: 'fake' })
      }),
      parentModelContext: fakeModel   // §9-5：Main Agent 当前 Model Context 兜底
    });

    const registry = createAgentRegistry();
    const hub = createAgentHub({
      registry,
      router: createAgentRouter({ registry }),
      healthManager: createHealthManager({ registry }),
      lifecycleManager: createLifecycleManager(),
      runBridge: createRunBridge({ runManager: rm, lifecycleManager: createLifecycleManager() }),
      contextFactory
    });

    // 捕获 runMainAgent 内部 runId（hub.start 返回的是 runBridge runId，不是 MainAgentRuntime runId）
    let mainRunId = null;
    const native = new NativeAgentAdapter({
      manifest: NATIVE_MAIN,
      runMainAgentFn: (opts) => { const r = runMainAgent(opts); mainRunId = r.runId; return r; },
      emit: () => {}
    });
    hub.register(native);

    // §17 最低要求：contextFactory 必须补全 model.decide / runManager / getTool / store
    const ctx = contextFactory.create(native, { goal: 'fix add', projectRoot: root }, { runId: 'h', lifecycleRunId: 'l', agentId: 'native-main', parentRunId: null, projectRoot: root, projectId: null }, {});
    assert.strictEqual(typeof ctx.model.decide, 'function', 'Native Hub context.model 必须是带 decide 的真实 ProviderModelAdapter（不是 ModelInfo）');
    assert.strictEqual(ctx.runManager, rm, '不缺 runManager');
    assert.strictEqual(typeof ctx.getTool, 'function', '不缺 getTool');
    assert.strictEqual(ctx.store, null, 'store 已注入');

    // §16：真实 AgentHub.start('native-main')
    const startResult = await hub.start('native-main', { goal: 'fix add', projectRoot: root });
    assert.ok(startResult && startResult.runId, 'hub.start 应返回 runId（未因缺 model 抛错）');
    assert.ok(mainRunId, '应捕获到 MainAgentRuntime runId');

    // 轮询 MainAgentRuntime 内部 run 直到终态
    let status = null;
    for (let i = 0; i < 160; i++) {
      const r = rm.getRun(mainRunId);
      if (r && ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)) { status = r.status; break; }
      await new Promise(res => setTimeout(res, 250));
    }
    assert.strictEqual(status, 'completed', `Native Main Run 应 completed，实际 ${status}`);

    // §17：最终 terminal 且完成实际工作（add 被修复）
    const after = fs.readFileSync(path.join(root, 'src', 'math.js'), 'utf8');
    assert.ok(after.includes('return a + b'), 'add 应被修复为 a + b');
  } finally {
    await cleanup(root);
  }
});
