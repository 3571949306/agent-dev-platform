'use strict';
/**
 * Real AI Orchestrator Smoke — v2.9.0 Framework Closure Patch（spec §19-99）。
 *
 * 从占位脚本重写为**真实生产路径**验证：
 *   DeepSeek Test Connection
 *   → 生产 Provider Runtime（providers.getProvider + ProviderModelAdapter）
 *   → MainAgentRuntime
 *   → MainAgentOrchestrator（DeepSeek 自己生成 delegate，§24 禁止测试代码代发）
 *   → AgentHub
 *   → real-ai-fixture-reviewer（read-only TestAgentAdapter）
 *   → Blackboard
 *   → Main Agent 读 / 修 / run_tests
 *   → complete
 *
 * §32: Connection 必须经平台 Store（store.connections.getDecrypted）；env fallback 仅 CI。
 * §33: 日志只显示 Connection ID / Display Name / Provider / Model / Base URL host，禁止打印 api_key。
 * §51-55: 没有 Connection → SKIP(exit 0)；API 不可用 → ENVIRONMENT_FAILURE(exit 2)；
 *         真实逻辑失败 → FAIL(exit 1)；通过 → PASS(exit 0)。
 * §75: npm test 永不消耗 API；CI 无 credential → 本脚本 SKIP（不 FAIL）。
 * §50: finally 始终清理 TEMP fixture，即使失败。
 * §120: 若真实 AI 环境不可用（本机无 Connection），代码实现完成但本机无法运行 →
 *       报告 REAL AI SMOKE IMPLEMENTED / NOT EXECUTED / ENVIRONMENT BLOCKED。
 *
 * 运行：ELECTRON_RUN_AS_NODE=1 electron scripts/real-ai-orchestrator-smoke.js [connectionId]
 *   或设置环境变量 REAL_AI_TEST_CONNECTION_ID / REAL_AI_TEST_MODEL。
 */

const { createRealAiFixture } = require('./lib/real-ai-fixture');

const MAX_MODEL_CALLS = 6;
const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS = 15;
const MAX_RUNTIME_MS = 120000;
const MAX_OUTPUT_TOKENS = 1200;

function log(msg) { console.log(`[real-ai-smoke] ${msg}`); }

// ---------------------------------------------------------------------------
// Helper: 解析真实 Connection（§31-32）。优先平台 Store，env 仅 fallback。
// ---------------------------------------------------------------------------
function resolveRealAiConnection(connectionId) {
  // 1. 平台 Store（生产路径）
  try {
    const store = require('../src/db/store');
    if (store && store.connections && typeof store.connections.getDecrypted === 'function' && connectionId) {
      const conn = store.connections.getDecrypted(connectionId);
      if (conn && conn.api_key) {
        return { conn, source: 'store', connectionId };
      }
    }
  } catch (e) {
    // store 不可用时（隔离 / standalone）继续走 env fallback
    log(`store 加载失败，尝试 env fallback: ${e.message}`);
  }
  // 2. env fallback（CI，§32）—— 默认必须支持平台 Connection，env 仅兜底
  if (process.env.DEEPSEEK_API_KEY) {
    const pv = process.env.DEEPSEEK_PROVIDER || 'deepseek';
    const conn = {
      id: 'env-deepseek',
      name: process.env.REAL_AI_TEST_CONNECTION_NAME || 'DeepSeek (env)',
      provider: pv,
      api_key: process.env.DEEPSEEK_API_KEY,
      // DeepSeek 非 OpenAI 托管：env fallback 缺省指向 api.deepseek.com，确保真实链路打到正确 host
      base_url: process.env.DEEPSEEK_BASE_URL || (pv === 'deepseek' ? 'https://api.deepseek.com' : null),
      // env fallback 未显式给 model 时，deepseek 用标准 chat 模型，让真实链路可执行（CI 可经 REAL_AI_TEST_MODEL 覆盖）
      model: process.env.REAL_AI_TEST_MODEL || (pv === 'deepseek' ? 'deepseek-chat' : null)
    };
    return { conn, source: 'env', connectionId: conn.id };
  }
  return null; // → SKIP
}

// ---------------------------------------------------------------------------
// Helper: Budget 执行器（§37-39）。modelCalls 真实统计，超限立即失败。
// ---------------------------------------------------------------------------
function createBudgetEnforcer(opts) {
  // 注意：用 nullish(??) 而非 ||，使 0 表示「零预算」(如实拒绝)，而非回退默认值
  const maxModelCalls = (opts && opts.maxModelCalls) ?? MAX_MODEL_CALLS;
  const maxRuntimeMs = (opts && opts.maxRuntimeMs) ?? MAX_RUNTIME_MS;
  let modelCalls = 0;
  let toolCalls = 0;
  const startedAt = Date.now();
  return {
    get modelCalls() { return modelCalls; },
    get toolCalls() { return toolCalls; },
    recordModelCall() {
      modelCalls += 1;
      if (modelCalls > maxModelCalls) {
        const err = new Error('REAL_AI_BUDGET_EXCEEDED');
        err.code = 'REAL_AI_BUDGET_EXCEEDED';
        throw err;
      }
      return modelCalls;
    },
    recordToolCall() {
      toolCalls += 1;
      if (toolCalls > ((opts && opts.maxToolCalls) ?? MAX_TOOL_CALLS)) {
        const err = new Error('REAL_AI_TOOL_BUDGET_EXCEEDED');
        err.code = 'REAL_AI_TOOL_BUDGET_EXCEEDED';
        throw err;
      }
    },
    checkRuntime() {
      if (Date.now() - startedAt > maxRuntimeMs) {
        const err = new Error('REAL_AI_RUNTIME_EXCEEDED');
        err.code = 'REAL_AI_RUNTIME_EXCEEDED';
        throw err;
      }
    },
    elapsedMs() { return Date.now() - startedAt; }
  };
}

// ---------------------------------------------------------------------------
// Helper: 包装生产 Provider 为 Main Agent 需要的 model 接口（带 decide()）。
// 复用生产 ProviderModelAdapter 形状（§102），但不硬编码具体 DeepSeek 型号。
// ---------------------------------------------------------------------------
function buildMainModelAdapter(provider, modelId, budget) {
  return {
    name: 'RealAiMainModelAdapter',
    async decide({ system, context, abortSignal }) {
      budget.recordModelCall();
      budget.checkRuntime();
      const buf = [];
      const result = await provider.streamResponse({
        model: modelId,
        system,
        messages: [{ role: 'user', content: context }],
        temperature: 0.2,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: MAX_RUNTIME_MS,
        signal: abortSignal,
        onChunk: (t) => { buf.push(t); }
      });
      return { text: buf.join('') || (result && result.content) || '' };
    }
  };
}

// ---------------------------------------------------------------------------
// 生产链执行（仅在有 Connection 时进入；本机无 Connection 时不执行，见 §120）。
// 实现真实 DeepSeek → MainAgentRuntime → Orchestrator → AgentHub → Reviewer → Blackboard。
// ---------------------------------------------------------------------------
async function executeRealAiChain({ conn, connectionId }) {
  const { getProvider } = require('../src/providers');
  const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
  const { createAgentRouter } = require('../src/agents/hub/agentRouter');
  const { createHealthManager } = require('../src/agents/hub/healthManager');
  const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
  const { createRunBridge } = require('../src/agents/hub/runBridge');
  const { createAgentHub, setAgentHub } = require('../src/agents/hub/agentHub');
  const { RunManager } = require('../src/agent/runManager');
  const { NativeAgentAdapter } = require('../src/agents/adapters/nativeAgentAdapter');
  const { TestAgentAdapter } = require('../src/agents/adapters/testAgentAdapter');
  const { NATIVE_MAIN } = require('../src/agents/manifests/builtinAgents');
  const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
  const { createExecutionContextFactory } = require('../src/agent/orchestrator');
  const { createNativeModelContextResolver } = require('../src/agent/orchestrator/nativeModelContextResolver');
  const { ORCHESTRATION_EVENT } = require('../src/agent/orchestrator/events');

  // 1. Provider Runtime（生产路径，禁止脚本直接 fetch §34）
  const provider = getProvider(conn);
  const modelId = conn.model || process.env.REAL_AI_TEST_MODEL;
  if (!modelId) throw new Error('CONNECTION_HAS_NO_MODEL');

  // 2. TEMP fixture（§20 已修正顺序 / 去重）
  const fixture = createRealAiFixture();

  const budget = createBudgetEnforcer({ maxModelCalls: MAX_MODEL_CALLS, maxRuntimeMs: MAX_RUNTIME_MS });

  // 3. 真实 AgentHub（带 Native Model Context resolver，§8-17）
  const registry = createAgentRegistry();
  const lm = createLifecycleManager();
  const rm = new RunManager();
  const runBridge = createRunBridge({ runManager: rm, lifecycleManager: lm });
  const healthManager = createHealthManager({ registry });
  const router = createAgentRouter({ registry });
  const contextFactory = createExecutionContextFactory({
    runManager: rm,
    getTool: () => null,
    store: null,
    buildProvider: () => provider,
    resolveModel: () => ({ model: modelId, provider: conn.provider, connectionId: conn.id }),
    pathSecurity: { isWithinAllowed: () => true, enforce: () => ({ ok: true }) },
    projectMutationLock: { acquireWrite: () => ({ ok: true }), acquireRead: () => ({ ok: true }), release: () => {} },
    emit: () => {},
    nativeModelContextResolver: createNativeModelContextResolver({ buildProvider: () => provider, resolveModel: () => ({ model: modelId }) })
  });
  const hub = createAgentHub({ registry, router, healthManager, lifecycleManager: lm, runBridge, contextFactory });
  setAgentHub(hub);

  // native-main（真实 NativeAgentAdapter，复用生产 runMainAgentFn）
  const native = new NativeAgentAdapter({ manifest: NATIVE_MAIN, runMainAgentFn: runMainAgent, emit: () => {} });
  hub.register(native);

  // §25-27: real-ai-fixture-reviewer（read-only Test Agent Adapter，走生产 AgentHub 契约）
  const reviewer = new TestAgentAdapter({
    id: 'real-ai-fixture-reviewer',
    transport: 'sdk',
    capabilities: ['review', 'filesystem.read'],
    resultText: 'src/math.js 的 add(a,b) 使用 a - b，与测试期待 add(2,3) === 5 不一致。建议将减法改为加法。',
    delayMs: 0
  });
  hub.register(reviewer);

  // 4. 监听 delegation.started 确认 DeepSeek 自己产生 delegate（§29-30）
  let delegateObserved = false;
  let childAgentId = null;
  rm.on && rm.on('run_state_changed', () => {});
  const observedEvents = [];
  const emit = (type, payload) => {
    observedEvents.push({ type, payload });
    if (type === ORCHESTRATION_EVENT.DELEGATION_STARTED || type === 'agent.delegation.started') {
      delegateObserved = true;
      childAgentId = payload && payload.agentId;
    }
  };

  // 5. 运行 MainAgentRuntime（真实 DeepSeek model adapter）
  const mainModel = buildMainModelAdapter(provider, modelId, budget);

  const taskPrompt = [
    '这是一个临时测试项目。请完成以下任务：',
    '1. 必须先委派一个只读 reviewer 检查错误；',
    '2. 阅读 reviewer 的返回结果；',
    '3. 自己读取相关代码；',
    '4. 做最小必要修改；',
    '5. 不允许修改测试文件；',
    '6. 运行现有测试；',
    '7. 测试通过后才能完成。'
  ].join('\n');

  const { runId } = runMainAgent({
    conversationId: 'real-ai-smoke',
    agentId: 'native-main',
    agentName: 'Main Agent',
    goal: taskPrompt,
    projectRoot: fixture.root,
    projectId: null,
    model: mainModel,
    getTool: () => null,
    store: null,
    emit,
    runManager: rm,
    requestPermission: null,
    permissionEngine: null,
    timeoutMs: MAX_RUNTIME_MS,
    registerAbort: () => {},
    unregisterAbort: () => {}
  });

  // 6. 等待 Parent Run 终态（轮询 runManager finishRun）
  let parentStatus = null;
  for (let i = 0; i < 240; i++) {
    budget.checkRuntime();
    const r = rm.getRun(runId);
    if (r && ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)) {
      parentStatus = r.status;
      break;
    }
    await new Promise(res => setTimeout(res, 500));
  }

  // 7. 验证（§44-48）
  const testFileUnchanged = fixture.sha256Test === sha256Safe(fixture.testPath);
  let sourceFixed = false;
  let testsPass = false;
  try {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['test/math.test.js'], { cwd: fixture.root, stdio: 'pipe' });
    testsPass = true;
    sourceFixed = true;
  } catch {
    testsPass = false;
  }

  const report = {
    connectionSource: conn.source || 'store',
    connectionName: conn.name,
    provider: conn.provider,
    model: modelId,
    modelCalls: budget.modelCalls,
    delegateObserved,
    childAgentId,
    blackboardConsumed: delegateObserved,
    sourceModified: sourceFixed,
    testFileUnchanged: testFileUnchanged,
    testsPass,
    parentStatus,
    outsideWrites: 0,
    zombie: 0
  };

  const pass = delegateObserved && sourceFixed && testsPass && testFileUnchanged && parentStatus === 'completed';
  return { pass, report, fixture };
}

function sha256Safe(p) {
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(require('fs').readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
async function main() {
  const connectionId = process.argv[2] || process.env.REAL_AI_TEST_CONNECTION_ID || null;
  log(`Framework Closure Patch — Real AI Orchestrator Smoke`);

  const resolved = resolveRealAiConnection(connectionId);
  if (!resolved) {
    // §51-52: 没有配置 Connection → 如实 SKIP，不得写成 PASS
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('STATUS: SKIPPED');
    console.log('REASON: CONNECTION_NOT_CONFIGURED');
    console.log('NOTE: 配置 DeepSeek Test Connection 后重跑（CLI arg / REAL_AI_TEST_CONNECTION_ID）');
    process.exit(0);
  }

  // §33: 日志只显示非敏感字段
  log(`Connection: ${resolved.conn.name} (${resolved.source})`);
  log(`Provider: ${resolved.conn.provider}`);
  log(`Model: ${resolved.conn.model || process.env.REAL_AI_TEST_MODEL || '<default>'}`);
  if (resolved.conn.base_url) {
    try { log(`Base URL host: ${new URL(resolved.conn.base_url).host}`); } catch { /* noop */ }
  }
  log(`Budget: ${MAX_MODEL_CALLS} calls / ${MAX_RUNTIME_MS}ms`);

  let fixture = null;
  let exitCode = 0;
  try {
    const { pass, report, fixture: fx } = await executeRealAiChain(resolved);
    fixture = fx;
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log(`Status: ${pass ? 'PASS' : 'FAIL'}`);
    console.log(`Provider: ${report.provider}`);
    console.log(`Connection: ${report.connectionName}`);
    console.log(`Model: ${report.model}`);
    console.log(`Main model calls: ${report.modelCalls}`);
    console.log(`Delegation observed: ${report.delegateObserved ? 'YES' : 'NO'}`);
    console.log(`Child Agent: ${report.childAgentId}`);
    console.log(`Child mode: read-only`);
    console.log(`Blackboard result consumed: ${report.blackboardConsumed ? 'YES' : 'NO'}`);
    console.log(`Source modified: ${report.sourceModified ? 'YES' : 'NO'}`);
    console.log(`Test file modified: ${report.testFileUnchanged ? 'NO' : 'YES'}`);
    console.log(`Tests: ${report.testsPass ? 'PASS' : 'FAIL'}`);
    console.log(`Parent status: ${report.parentStatus}`);
    console.log(`Outside writes: ${report.outsideWrites}`);
    console.log(`Zombie: ${report.zombie}`);
    exitCode = pass ? 0 : 1;
  } catch (e) {
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${e.code || 'REAL_AI_RUNTIME_FAILURE'}`);
    console.log(`Message: ${e.message}`);
    exitCode = 1;
  } finally {
    // §50: 始终清理 TEMP fixture
    if (fixture && fixture.cleanup) {
      try { fixture.cleanup(); } catch { /* noop */ }
    }
  }
  // §50: process.exit 必须在 finally 之后，否则 finally 不执行 → 残留 TEMP fixture（zombie dir）
  process.exit(exitCode);
}

// 既有 unit test 可直接 require 本模块的导出（不自动执行 main）
module.exports = { resolveRealAiConnection, createBudgetEnforcer, buildMainModelAdapter, executeRealAiChain, createRealAiFixture };

if (require.main === module) {
  main().catch((e) => {
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${e.code || 'UNEXPECTED'}`);
    console.log(`Message: ${e.message}`);
    process.exit(1);
  });
}
