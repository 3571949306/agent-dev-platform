'use strict';
/**
 * v2.9.0 Real Runtime Smoke Closure — R1 Proof: NativeHubTopLevelFallbackIntegration。
 *
 * 验证任何进入 NativeAgentAdapter → runMainAgent 的 context.model 都是真实
 * Runtime ModelAdapter（typeof context.model.decide === 'function'）：
 *
 *   A. parentModelContext exists → native child 继承有效 Parent ModelAdapter → terminal
 *   B. parentModelContext absent → top-level AgentHub.start('native-main') fallback
 *      → 从真实配置的 Native Main Agent（store.agents.listNative is_main +
 *      api_connection_id + model）解析 Connection + Model → createProviderModelAdapter
 *      → context.model.decide exists → runMainAgent actually starts → terminal
 *      （测试环境用 Mock Provider 避免付费，但 Model resolution 路径与生产一致）
 *   C. no parent model + no configured native model → NATIVE_MODEL_CONTEXT_UNRESOLVED
 *   D. metadata object { model:'x', provider:'y' } 作为 context.model → 必须拒绝
 *
 * 禁止：truthy 弱检查 / 静默选择第一个 API Connection / metadata 冒充。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const providers = require('../src/providers');
const { createExecutionContextFactory } = require('../src/agent/orchestrator');
const {
  createNativeModelContextResolver, nativeMainAgentConfigFromStore
} = require('../src/agent/orchestrator/nativeModelContextResolver');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { NativeAgentAdapter } = require('../src/agents/adapters/nativeAgentAdapter');
const { NATIVE_MAIN } = require('../src/agents/manifests/builtinAgents');
const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const toolRegistry = require('../src/tools/registry');
const { createRealAiFixture } = require('../scripts/lib/real-ai-fixture');

function builtinGetTool(name) {
  const b = toolRegistry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

const COMPLETE_ACTION_JSON = JSON.stringify({
  thought_summary: 'mock complete',
  action: { type: 'complete', args: { summary: 'mock 完成（R1 仅验证 model resolution 链路）' } }
});

// 独立 store（TEMP userData）：不污染平台真实数据
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r1-native-'));
store.init(USER_DATA);

/** 创建 mock connection + is_main native agent（平台配置形态与生产一致）。 */
function seedMainAgentConfig() {
  const conn = store.connections.create({
    name: 'Mock Native Main', provider: 'mock', base_url: 'mock://native-main', api_key: 'mk-r1-test'
  });
  const agent = store.agents.create({
    name: '主智能体(R1)', type: 'native', is_main: true,
    api_connection_id: conn.id, model: 'mock-fast'
  });
  return { conn, agent };
}

/** 生产一致的 buildProvider / resolveModel（Store 解密 → providers.getProvider）。 */
function productionDeps() {
  const buildProvider = (agent) => {
    const c = store.connections.getDecrypted(agent.api_connection_id);
    if (!c) throw new Error('智能体未绑定 API 连接');
    // Mock Provider 脚本化：返回 complete action JSON，使 run 真正走到 terminal completed
    c.mockScript = [{ text: COMPLETE_ACTION_JSON }];
    return providers.getProvider(c);
  };
  const resolveModel = (agent) => {
    const raw = agent && agent.api_connection_id ? store.connections.get(agent.api_connection_id) : null;
    const r = providers.resolveModel({ agent, conn: raw, override: null });
    return { ...r, provider: raw ? raw.provider : null, connectionId: raw ? raw.id : null };
  };
  return { buildProvider, resolveModel };
}

function buildHub({ rm, contextFactory, captureMainRunId }) {
  const registry = createAgentRegistry();
  const lm = createLifecycleManager();
  const hub = createAgentHub({
    registry,
    router: createAgentRouter({ registry }),
    healthManager: createHealthManager({ registry }),
    lifecycleManager: lm,
    runBridge: createRunBridge({ runManager: rm, lifecycleManager: lm }),
    contextFactory
  });
  const native = new NativeAgentAdapter({
    manifest: NATIVE_MAIN,
    runMainAgentFn: (opts) => {
      const r = runMainAgent(opts);
      if (captureMainRunId) captureMainRunId(r.runId);
      return r;
    },
    emit: () => {}
  });
  hub.register(native);
  return { hub, native };
}

async function waitTerminal(rm, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = rm.getRun(runId);
    if (r && ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)) return r;
    await new Promise(res => setTimeout(res, 100));
  }
  return null;
}

test('R1-B top-level fallback：无 parentModelContext → 从配置化 Native Main Agent 解析真实 ModelAdapter → terminal completed', async () => {
  const { conn, agent } = seedMainAgentConfig();
  const fixture = createRealAiFixture();
  const prevHub = getAgentHub();
  try {
    // 唯一性前提：store 中恰好一个 is_main + api_connection_id 配置
    const cfg = nativeMainAgentConfigFromStore(store);
    assert.ok(cfg, 'store 必须能解析出唯一 Native Main Agent 配置');
    assert.strictEqual(cfg.id, agent.id);
    assert.strictEqual(cfg.api_connection_id, conn.id);

    const rm = new RunManager();
    const { buildProvider, resolveModel } = productionDeps();
    const contextFactory = createExecutionContextFactory({
      runManager: rm,
      getTool: builtinGetTool,
      store,
      buildProvider,
      resolveModel,
      emit: () => {},
      // 关键：NO parentModelContext，NO 手动注入 FakeCodingModel
      nativeModelContextResolver: createNativeModelContextResolver({
        buildProvider, resolveModel,
        getNativeMainAgentConfig: () => nativeMainAgentConfigFromStore(store)
      })
    });

    let mainRunId = null;
    const { hub, native } = buildHub({ rm, contextFactory, captureMainRunId: (id) => { mainRunId = id; } });
    setAgentHub(hub);

    // context.model 必须是带 decide 的真实 adapter（不是 metadata）
    const ctx = contextFactory.create(native, { goal: 'r1-b', projectRoot: fixture.root },
      { runId: 'h', lifecycleRunId: 'l', agentId: 'native-main', parentRunId: null, projectRoot: fixture.root, projectId: null }, {});
    assert.ok(ctx.model, 'context.model 不得为空');
    assert.strictEqual(typeof ctx.model.decide, 'function', 'context.model 必须是带 decide() 的 Runtime ModelAdapter');
    assert.notStrictEqual(ctx.model.model, 'mock-fast', 'context.model 不得是 ModelInfo metadata object');

    // AgentHub.start('native-main') → runMainAgent actually starts → terminal
    const startResult = await hub.start('native-main', { goal: 'R1-B top-level fallback', projectRoot: fixture.root });
    assert.ok(startResult && startResult.runId, `hub.start 应成功：${startResult && startResult.error}`);
    assert.ok(mainRunId, 'runMainAgent 必须真正启动');

    const terminal = await waitTerminal(rm, mainRunId);
    assert.ok(terminal, 'Main Run 必须到达 terminal');
    assert.strictEqual(terminal.status, 'completed', `Mock Provider 驱动的 native-main 应 completed，实际 ${terminal.status}（${terminal.error || ''}）`);
  } finally {
    setAgentHub(prevHub);
    fixture.cleanup();
  }
});

test('R1-A delegated path：parentModelContext / context.model 存在 → native child 继承有效 Parent ModelAdapter → terminal', async () => {
  const cfg = nativeMainAgentConfigFromStore(store);
  assert.ok(cfg, '需要 R1-B 先 seed 的配置');
  const fixture = createRealAiFixture();
  const prevHub = getAgentHub();
  try {
    const rm = new RunManager();
    const { buildProvider, resolveModel } = productionDeps();
    // Parent ModelAdapter：生产 createProviderModelAdapter（Mock Provider 脚本化 complete）
    const parentAdapter = createProviderModelAdapter({
      buildProvider: () => buildProvider(cfg),
      agent: cfg,
      resolveModel,
      timeoutMs: 30000
    });
    const contextFactory = createExecutionContextFactory({
      runManager: rm,
      getTool: builtinGetTool,
      store,
      buildProvider,
      resolveModel,
      emit: () => {},
      // 无 getNativeMainAgentConfig 兜底：本用例只验证继承路径
      nativeModelContextResolver: createNativeModelContextResolver({ buildProvider, resolveModel })
    });

    let mainRunId = null;
    const { hub, native } = buildHub({ rm, contextFactory, captureMainRunId: (id) => { mainRunId = id; } });
    setAgentHub(hub);

    // 委派场景：task.context.model = 有效 Parent ModelAdapter
    const task = { goal: 'R1-A inherited model', projectRoot: fixture.root, context: { model: parentAdapter } };
    const ctx = contextFactory.create(native, task,
      { runId: 'h', lifecycleRunId: 'l', agentId: 'native-main', parentRunId: 'parent-run', projectRoot: fixture.root, projectId: null }, {});
    assert.strictEqual(ctx.model, parentAdapter, 'native child 应继承 Parent ModelAdapter');
    assert.strictEqual(typeof ctx.model.decide, 'function');

    const startResult = await hub.start('native-main', task);
    assert.ok(startResult && startResult.runId, `hub.start 应成功：${startResult && startResult.error}`);
    const terminal = await waitTerminal(rm, mainRunId);
    assert.ok(terminal, 'child run 必须到达 terminal');
    assert.strictEqual(terminal.status, 'completed');
  } finally {
    setAgentHub(prevHub);
    fixture.cleanup();
  }
});

test('R1-C no parent model + no configured native model → NATIVE_MODEL_CONTEXT_UNRESOLVED（明确失败，不静默选第一个 Connection）', async () => {
  const fixture = createRealAiFixture();
  try {
    const rm = new RunManager();
    const { buildProvider, resolveModel } = productionDeps();
    // resolver 无 getNativeMainAgentConfig（模拟无配置环境），且无 parentModelContext
    const resolver = createNativeModelContextResolver({ buildProvider, resolveModel });
    assert.throws(
      () => resolver.resolveNativeModelContext({ id: 'native-main' }, {}),
      /NATIVE_MODEL_CONTEXT_UNRESOLVED/,
      '无任何 model 来源时必须明确抛 NATIVE_MODEL_CONTEXT_UNRESOLVED'
    );

    // hub.start 层面：contextFactory 抛错 → start 返回 error，runMainAgent 不启动
    const contextFactory = createExecutionContextFactory({
      runManager: rm, getTool: builtinGetTool, store: null,
      buildProvider, resolveModel, emit: () => {},
      nativeModelContextResolver: resolver
    });
    let mainRunId = null;
    const { hub } = buildHub({ rm, contextFactory, captureMainRunId: (id) => { mainRunId = id; } });
    const startResult = await hub.start('native-main', { goal: 'R1-C', projectRoot: fixture.root });
    assert.ok(startResult.error, 'hub.start 应返回 error');
    assert.match(String(startResult.error), /NATIVE_MODEL_CONTEXT_UNRESOLVED/);
    assert.strictEqual(mainRunId, null, 'runMainAgent 不得启动');
  } finally {
    fixture.cleanup();
  }
});

test('R1-D metadata object 冒充 context.model → NativeAgentAdapter 必须拒绝（含 null）', async () => {
  const rm = new RunManager();
  const native = new NativeAgentAdapter({ manifest: NATIVE_MAIN, runMainAgentFn: runMainAgent, emit: () => {} });
  const task = { goal: 'R1-D', projectRoot: os.tmpdir() };

  await assert.rejects(
    () => native.startTask(task, { runManager: rm, model: { model: 'x', provider: 'y', connectionId: 'c' } }),
    /NATIVE_MODEL_CONTEXT_UNRESOLVED/,
    '{ model, provider, connectionId } metadata 不得被接受'
  );
  await assert.rejects(
    () => native.startTask(task, { runManager: rm, model: null }),
    /NATIVE_MODEL_CONTEXT_UNRESOLVED/,
    '空 model 不得被接受'
  );
  await assert.rejects(
    () => native.startTask(task, { runManager: rm, model: { decide: 'not-a-function' } }),
    /NATIVE_MODEL_CONTEXT_UNRESOLVED/,
    'decide 非函数不得被接受'
  );
});

test('R1 唯一性规则：store 中存在 2 个 is_main+connection 配置 → nativeMainAgentConfigFromStore 返回 null（不静默选第一个）', () => {
  const conn2 = store.connections.create({
    name: 'Mock Second', provider: 'mock', base_url: 'mock://second', api_key: 'mk-second'
  });
  store.agents.create({
    name: '第二主智能体(R1)', type: 'native', is_main: true,
    api_connection_id: conn2.id, model: 'mock-fast'
  });
  try {
    assert.strictEqual(nativeMainAgentConfigFromStore(store), null, '歧义配置必须返回 null → 落到明确失败');
  } finally {
    // 恢复唯一配置，避免影响其他测试
    const dup = store.agents.listNative().filter(a => a.is_main && a.name === '第二主智能体(R1)');
    for (const a of dup) store.agents.remove(a.id);
  }
});
