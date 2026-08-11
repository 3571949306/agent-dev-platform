'use strict';
/**
 * v2.9.0 Real Runtime Smoke Closure — 共享生产链路运行时（R1-R9）。
 *
 * 本模块是 Real AI Smoke 与 Deterministic Integration 的共用执行体：
 *   除 LLM 可替换外（Real = 真实 Provider；Deterministic = FakeCodingModel），
 *   其余全部生产组件：
 *     MainAgentRuntime / AgentLoop / ActionExecutor / Built-in Tool Registry /
 *     PermissionEngine / PathSecurity / MainAgentOrchestrator / AgentHub /
 *     TestAgentAdapter reviewer / RunManager
 *
 * 关键规则：
 *   R2  getTool 复用 src/tools/registry.js（生产 Built-in Tools），禁止 fake 工具。
 *   R3  使用生产 src/security/pathSecurity（per-run cacheRoots 实例），TEMP fixture 为 projectRoot。
 *   R4  使用生产 PermissionEngine：仅授权 filesystem.read/write + terminal.read/write + subagent，
 *       显式 deny 项目外 / 危险 / computer / browser / clipboard / network / mcp。
 *   R5  delegate 必须由 model action 产生（MODEL_ACTION）+ orchestration.delegation.started 双层证据。
 *   R6  Child Result 必须出现在 Main Agent 下一轮 model context（真实 runtime 证据，非假证明）。
 *   R8  Fixture 所有权：谁 create 谁在同一函数 try/finally cleanup（withRealAiFixture）。
 *   R9  Budget 精确区分 attempts / started / succeeded / failed；调用前预检，超限 REAL_AI_BUDGET_EXCEEDED。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---- 生产模块（禁止另造第二套） ----
const providers = require('../../src/providers');
const toolRegistry = require('../../src/tools/registry');
const { PermissionEngine } = require('../../src/security/permissions');
const { createPathSecurity } = require('../../src/security/pathSecurity');
const { createAgentRegistry } = require('../../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../../src/agents/hub/agentRouter');
const { createHealthManager } = require('../../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../../src/agents/hub/agentHub');
const { RunManager } = require('../../src/agent/runManager');
const { NativeAgentAdapter } = require('../../src/agents/adapters/nativeAgentAdapter');
const { TestAgentAdapter } = require('../../src/agents/adapters/testAgentAdapter');
const { NATIVE_MAIN } = require('../../src/agents/manifests/builtinAgents');
const { runMainAgent } = require('../../src/agent/runtime/mainAgentRuntime');
const { createExecutionContextFactory } = require('../../src/agent/orchestrator');
const { createNativeModelContextResolver, nativeMainAgentConfigFromStore } = require('../../src/agent/orchestrator/nativeModelContextResolver');
const { ORCHESTRATION_EVENT } = require('../../src/agent/orchestrator/events');
const { createProviderModelAdapter } = require('../../src/agent/runtime/providerModelAdapter');

const REVIEWER_AGENT_ID = 'real-ai-fixture-reviewer';
const FIXTURE_PREFIX = 'adp-real-orchestrator-';

// ---------------------------------------------------------------------------
// Store（standalone：脱离 Electron 主进程时使用平台 userData 的 agent.db）
// ---------------------------------------------------------------------------

function defaultUserDataPath() {
  const name = 'agent-dev-platform';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

/**
 * 初始化平台 Store（仅当尚未初始化）。standalone 脚本用平台真实 userData，
 * 让 Connection / Native Agent 配置与生产 App 完全一致。
 * @returns {object|null} store 或 null（DB 不存在 / 初始化失败）
 */
function initStandaloneStore() {
  try {
    const store = require('../../src/db/store');
    const userData = process.env.ADP_USER_DATA || defaultUserDataPath();
    if (!fs.existsSync(path.join(userData, 'agent.db'))) return null;
    store.init(userData);
    return store;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection / Model 解析（spec §5/§6）
// ---------------------------------------------------------------------------

function isDeepSeekLikeConnection(c) {
  if (!c) return false;
  return c.provider === 'deepseek' ||
    /deepseek/i.test(c.base_url || '') ||
    /deepseek/i.test(c.name || '');
}

function modelIdFromListModel(m) {
  if (!m) return null;
  if (typeof m === 'string') return m;
  return m.id || null;
}

/**
 * 解析 Real AI Test Connection（spec §5 优先级）：
 *   1. explicit CLI connectionId
 *   2. REAL_AI_TEST_CONNECTION_ID
 *   3. 平台保存的 settings.realAiTestConnectionId
 *   4. Store 中恰好唯一可用的 DeepSeek 测试连接
 *   5. env fallback（DEEPSEEK_API_KEY，source = env-fallback）
 * 禁止用 DEEPSEEK_API_KEY env 优先覆盖平台已绑定 Connection。
 */
function resolveRealAiConnection(connectionId, opts = {}) {
  const store = opts.store || null;

  const fromStore = (id, source) => {
    if (!store || !id || typeof store.connections.getDecrypted !== 'function') return null;
    try {
      const conn = store.connections.getDecrypted(id);
      if (conn && conn.api_key) return { conn, source, connectionId: id };
    } catch { /* fallthrough */ }
    return null;
  };

  // 1. explicit CLI connectionId
  const cli = fromStore(connectionId, 'cli');
  if (cli) return cli;

  // 2. REAL_AI_TEST_CONNECTION_ID
  const envId = fromStore(process.env.REAL_AI_TEST_CONNECTION_ID || null, 'env-id');
  if (envId) return envId;

  // 3. 平台保存的 realAiTestConnectionId
  if (store && store.settings) {
    try {
      const saved = store.settings.get('realAiTestConnectionId', null);
      const s = fromStore(saved, 'settings');
      if (s) return s;
    } catch { /* non-fatal */ }
  }

  // 4. Store 中恰好只有一个可用 DeepSeek 测试连接
  if (store && typeof store.connections.list === 'function') {
    try {
      const candidates = store.connections.list().filter(c => c.has_key && isDeepSeekLikeConnection(c));
      if (candidates.length === 1) {
        const one = fromStore(candidates[0].id, 'store-single-deepseek');
        if (one) return one;
      }
    } catch { /* non-fatal */ }
  }

  // 5. env fallback（仅兜底；source 明确标记 env-fallback）
  if (process.env.DEEPSEEK_API_KEY) {
    const pv = process.env.DEEPSEEK_PROVIDER || 'deepseek';
    const conn = {
      id: 'env-deepseek',
      name: process.env.REAL_AI_TEST_CONNECTION_NAME || 'DeepSeek (env)',
      provider: pv,
      api_key: process.env.DEEPSEEK_API_KEY,
      base_url: process.env.DEEPSEEK_BASE_URL || (pv === 'deepseek' ? 'https://api.deepseek.com' : null),
      model: process.env.REAL_AI_TEST_MODEL || (pv === 'deepseek' ? 'deepseek-chat' : null)
    };
    return { conn, source: 'env-fallback', connectionId: conn.id };
  }
  return null;
}

/**
 * 解析 Smoke 使用的 Model（spec §6）：REAL_AI_TEST_MODEL override → Connection default
 * → 已配置 Native Main Agent 的 model（Store 为准）→ connection.models[0]。
 * 禁止硬编码未来型号作为生产规则。
 */
function resolveSmokeModel({ conn, store }) {
  if (process.env.REAL_AI_TEST_MODEL) {
    return { model: process.env.REAL_AI_TEST_MODEL, source: 'env-override' };
  }
  const connDefault = conn && (conn.default_model || conn.model);
  if (connDefault) return { model: connDefault, source: 'connection' };
  const mainCfg = nativeMainAgentConfigFromStore(store);
  if (mainCfg && mainCfg.model) return { model: mainCfg.model, source: 'native-main-agent' };
  const first = conn && Array.isArray(conn.models) ? modelIdFromListModel(conn.models[0]) : null;
  if (first) return { model: first, source: 'connection.models[0]' };
  return { model: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// R9 — Budget（attempts / started / succeeded / failed 精确区分）
// ---------------------------------------------------------------------------

function createRealAiBudget(opts = {}) {
  const maxProviderCalls = opts.maxProviderCalls ?? 6;
  const maxRuntimeMs = opts.maxRuntimeMs ?? 360000;
  let modelCallAttempts = 0;
  let providerCallsStarted = 0;
  let providerCallsSucceeded = 0;
  let providerCallsFailed = 0;
  const startedAt = Date.now();
  return {
    get modelCallAttempts() { return modelCallAttempts; },
    get providerCallsStarted() { return providerCallsStarted; },
    get providerCallsSucceeded() { return providerCallsSucceeded; },
    get providerCallsFailed() { return providerCallsFailed; },
    recordAttempt() { modelCallAttempts += 1; },
    /** 调用前预检：已达上限 → REAL_AI_BUDGET_EXCEEDED（不得先发起第 N+1 次再改口）。 */
    beforeProviderCall() {
      if (providerCallsStarted >= maxProviderCalls) {
        const err = new Error(`REAL_AI_BUDGET_EXCEEDED: provider calls ${providerCallsStarted} >= max ${maxProviderCalls}`);
        err.code = 'REAL_AI_BUDGET_EXCEEDED';
        throw err;
      }
      providerCallsStarted += 1;
    },
    recordSuccess() { providerCallsSucceeded += 1; },
    recordFailure() { providerCallsFailed += 1; },
    checkRuntime() {
      if (Date.now() - startedAt > maxRuntimeMs) {
        const err = new Error(`REAL_AI_RUNTIME_EXCEEDED: ${Date.now() - startedAt}ms > ${maxRuntimeMs}ms`);
        err.code = 'REAL_AI_RUNTIME_EXCEEDED';
        throw err;
      }
    },
    elapsedMs() { return Date.now() - startedAt; },
    counts() {
      return { modelCallAttempts, providerCallsStarted, providerCallsSucceeded, providerCallsFailed };
    }
  };
}

/**
 * 用 Budget 包装 Model Adapter：decide() 前预检预算并记账。
 * 内层 adapter 不变（生产 createProviderModelAdapter / FakeCodingModel 均可）。
 */
function wrapModelWithBudget(model, budget) {
  if (!budget) return model;
  return {
    name: `Budgeted(${model.name || 'model'})`,
    async decide(args) {
      budget.recordAttempt();
      budget.checkRuntime();
      budget.beforeProviderCall();
      try {
        const r = await model.decide(args);
        budget.recordSuccess();
        return r;
      } catch (e) {
        budget.recordFailure();
        throw e;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// R2/R3/R4 — 生产 Tool Registry / PathSecurity / PermissionEngine
// ---------------------------------------------------------------------------

/** R2: 复用生产 src/tools/registry.js 的 Built-in Tools（与 handlers.js getTool 同形状）。 */
function builtinGetTool(name) {
  const b = toolRegistry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

/** R4: 生产 PermissionEngine + 仅限当前 TEMP 项目的测试权限上下文。 */
function createSmokePermissionEngine() {
  const pe = new PermissionEngine({}); // 无 store：不读取/写入任何持久授权
  // 允许：项目内文件读写 + 终端读写 + 子代理
  for (const scope of ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write', 'subagent']) {
    pe.grantSession(scope);
  }
  // 明确不开放
  for (const scope of ['filesystem.outside_workspace', 'filesystem.delete', 'terminal.dangerous', 'terminal.admin',
    'computer', 'browser', 'clipboard', 'network', 'mcp', 'git.write']) {
    pe.grant(scope, 'deny', { persist: false });
  }
  return pe;
}

/** R4: 确定性 requestPermission —— 记录所有 ask，一律不批准（未预授权即拒绝）。 */
function createDeterministicRequestPermission(log) {
  return async (req) => {
    log.push({ scope: req && req.scope, tool: req && req.tool, at: Date.now() });
    return { decision: 'deny' };
  };
}

// ---------------------------------------------------------------------------
// R8 — Fixture 所有权（谁 create 谁在同一函数 try/finally cleanup）
// ---------------------------------------------------------------------------

/**
 * Fixture 生命周期唯一合法模式：create 与 cleanup 在同一函数 try/finally。
 * 中途 throw（provider throws / model timeout / tool error）也不会泄漏 TEMP 目录。
 */
async function withRealAiFixture(fn) {
  const { createRealAiFixture } = require('./real-ai-fixture');
  const fixture = createRealAiFixture();
  try {
    return await fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

/** TEMP 残留目录计数（R8 Proof：异常路径执行后应为 0）。 */
function countFixtureLeftovers() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(FIXTURE_PREFIX)).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// R7 — 目录快照（独立终验：src/math.js 必须是唯一预期 mutation）
// ---------------------------------------------------------------------------

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

function snapshotDir(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), sha256File(full));
    }
  };
  walk(root);
  return out;
}

/** 比较两份快照：返回 { added, removed, modified }（相对路径数组）。 */
function diffSnapshots(before, after) {
  const added = []; const removed = []; const modified = [];
  for (const [p, h] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== h) modified.push(p);
  }
  for (const p of before.keys()) {
    if (!after.has(p)) removed.push(p);
  }
  return { added, removed, modified };
}

// ---------------------------------------------------------------------------
// R3 — Deterministic Security Assertion（Harness 自己验证 PathSecurity）
// ---------------------------------------------------------------------------

/**
 * 用生产 write_file 工具主动尝试逃逸写入，必须全部被 PathSecurity 拒绝。
 * @returns {{ attempts, successfulOutsideWrites, details }}
 */
async function runSecurityAssertions(fixture, pathSecurity) {
  const writeTool = builtinGetTool('write_file');
  const ctx = { projectRoot: fixture.root, pathSecurity, store: null, emit: () => {}, projectId: null, taskId: null, agentId: 'harness' };
  const escapes = [
    '../outside.txt',
    path.join(fixture.root, '..', 'outside-abs.txt'),
    '..\\..\\outside-win.txt'
  ];
  let successfulOutsideWrites = 0;
  const details = [];
  for (const target of escapes) {
    const r = await writeTool.exec(ctx, { path: target, content: 'escape attempt', record_change: false });
    const denied = !r || r.ok === false;
    if (!denied) successfulOutsideWrites += 1;
    details.push({ target, denied, code: r && r.error && r.error.code });
    // 兜底：即便工具误报 ok，也要确认文件真的没有写到项目外
    try {
      const abs = path.resolve(fixture.root, target);
      if (!abs.startsWith(path.resolve(fixture.root)) && fs.existsSync(abs)) {
        successfulOutsideWrites += 1;
        try { fs.unlinkSync(abs); } catch { /* noop */ }
      }
    } catch { /* noop */ }
  }
  return { attempts: escapes.length, successfulOutsideWrites, details };
}

// ---------------------------------------------------------------------------
// 主执行链（Real / Deterministic 共用）
// ---------------------------------------------------------------------------

/**
 * 执行完整生产链路：
 *   model(decide) → MainAgentRuntime → AgentLoop → delegate → Orchestrator →
 *   AgentHub → reviewer(TestAgentAdapter) → Child Result → next iteration →
 *   read_file → patch → terminal_run → complete
 *
 * @param {object} opts {
 *   fixture,          // TEMP fixture（调用方创建并负责 cleanup — R8）
 *   modelAdapter,     // 真实模型 adapter（decide）。Deterministic 传 FakeCodingModel。
 *   conn?,            // resolved connection（Real 必填，供 provider/model 解析与日志）
 *   provider?,        // provider override（测试用 mock；缺省 providers.getProvider(conn)）
 *   store?,           // 平台 Store（可空）
 *   taskPrompt?,
 *   reviewerResultText?,
 *   budget?,          // R9 budget（缺省按默认创建）
 *   timeoutMs?, maxProviderCalls?,
 *   emitSink?         // 额外事件接收（诊断）
 * }
 * @returns {Promise<{ pass, report, evidence }>}
 */
async function executeRealAiChain(opts) {
  const fixture = opts.fixture;
  if (!fixture || !fixture.root) throw new Error('executeRealAiChain: fixture 必填（由调用方创建并负责 cleanup）');
  const conn = opts.conn || null;
  const store = opts.store || null;
  const timeoutMs = opts.timeoutMs ?? 360000;
  const budget = opts.budget || createRealAiBudget({ maxProviderCalls: opts.maxProviderCalls ?? 6, maxRuntimeMs: timeoutMs });

  // 1. Provider Runtime（生产路径，禁止脚本直接 fetch）。
  //    Deterministic 模式（传入 modelAdapter 且无 conn）不需要真实 provider。
  const provider = opts.provider || (conn ? providers.getProvider(conn) : null);
  if (!opts.modelAdapter && !provider) {
    throw new Error('executeRealAiChain: Real 模式必须提供 conn（生产 Provider 路径）或显式 provider');
  }

  // 2. 证据收集
  const evidence = {
    events: [],
    modelActions: [],          // MODEL_ACTION（R5 第一层）
    delegationEvents: [],      // ORCHESTRATION_EVENT（R5 第二层）
    toolEvents: [],            // 生产 Tool Events（R2）
    modelContexts: [],         // 每轮 decide 的 context（R6）
    permissionAsks: [],
    permissionDenials: [],
    delegateIteration: null,
    consumedIteration: null
  };

  const emit = (type, payload) => {
    evidence.events.push({ type, payload });
    if (type === 'mainAgent:action' && payload && payload.action) {
      evidence.modelActions.push({ iteration: evidence.modelContexts.length, type: payload.action.type, args: payload.action.args });
    }
    if (typeof type === 'string' && type.startsWith('orchestration.delegation.')) {
      evidence.delegationEvents.push({ type, agentId: payload && payload.agentId, runId: payload && payload.runId });
    }
    if (opts.emitSink) { try { opts.emitSink(type, payload); } catch { /* noop */ } }
  };

  // 3. R2/R3/R4 生产基础设施
  const getTool = builtinGetTool;
  const pathSecurity = createPathSecurity({ cacheRoots: true });
  const permissionEngine = createSmokePermissionEngine();
  const requestPermission = createDeterministicRequestPermission(evidence.permissionAsks);

  // 4. 真实 AgentHub（生产组件全套）
  const registry = createAgentRegistry();
  const lm = createLifecycleManager();
  const rm = new RunManager();
  const runBridge = createRunBridge({ runManager: rm, lifecycleManager: lm });
  const healthManager = createHealthManager({ registry });
  const router = createAgentRouter({ registry });

  // 生产一致的 model resolution：buildProvider 按 agent.api_connection_id 从 Store 解密，
  // 无 Store 时用本次 run 的 provider（Real Smoke 的 resolved connection）。
  const buildProviderFor = (agent) => {
    if (store && agent && agent.api_connection_id) {
      const c = store.connections.getDecrypted(agent.api_connection_id);
      if (c) return providers.getProvider(c);
    }
    return provider;
  };
  const resolveModelFor = (agent) => {
    const raw = store && agent && agent.api_connection_id ? safeConnGet(store, agent.api_connection_id) : conn;
    const r = providers.resolveModel({ agent, conn: raw, override: null });
    return {
      ...r,
      model: typeof r.model === 'string' ? r.model : modelIdFromListModel(r.model),
      provider: raw ? raw.provider : (conn && conn.provider) || null,
      connectionId: raw ? raw.id : (conn && conn.id) || null
    };
  };

  const contextFactory = createExecutionContextFactory({
    runManager: rm,
    getTool,
    store,
    buildProvider: buildProviderFor,
    resolveModel: resolveModelFor,
    requestPermission,
    permissionEngine,
    pathSecurity,
    projectMutationLock: null,
    emit,
    nativeModelContextResolver: createNativeModelContextResolver({
      buildProvider: buildProviderFor,
      resolveModel: resolveModelFor,
      getNativeMainAgentConfig: () => nativeMainAgentConfigFromStore(store)
    })
  });
  const hub = createAgentHub({ registry, router, healthManager, lifecycleManager: lm, runBridge, contextFactory });
  const prevHub = getAgentHub();
  setAgentHub(hub);

  // native-main（真实 NativeAgentAdapter + 生产 runMainAgent）
  const native = new NativeAgentAdapter({ manifest: NATIVE_MAIN, runMainAgentFn: runMainAgent, emit: () => {} });
  hub.register(native);

  // reviewer：deterministic read-only TestAgentAdapter，但必须经 AgentHub.register → route/start → Child Run → AgentResult
  const reviewerResultText = opts.reviewerResultText ||
    'src/math.js 的 add(a,b) 当前执行 a - b，与测试期待 add(2,3) === 5 冲突。建议把减法改为加法。';
  const reviewer = new TestAgentAdapter({
    id: REVIEWER_AGENT_ID,
    transport: 'sdk',
    capabilities: ['review', 'filesystem.read'],
    resultText: reviewerResultText,
    delayMs: 0
  });
  hub.register(reviewer);

  // 5. Model：预算包装 + R6 context 记录
  const innerModel = opts.modelAdapter || createProviderModelAdapter({
    buildProvider: () => provider,
    agent: { id: 'native-main', api_connection_id: conn && conn.id, model: opts.modelId || (conn && conn.model) || null },
    resolveModel: () => ({ model: opts.modelId || (conn && conn.model) }),
    timeoutMs
  });
  const budgeted = wrapModelWithBudget(innerModel, budget);
  const model = {
    name: budgeted.name,
    async decide(args) {
      const r = await budgeted.decide(args);
      evidence.modelContexts.push({ iteration: evidence.modelContexts.length + 1, context: args && args.context });
      return r;
    }
  };

  // 6. 任务（与 spec §R5 一致的 7 步要求；附项目结构，避免额外探索轮次、稳定预算内完成）
  const taskPrompt = opts.taskPrompt || [
    '这是一个临时测试项目。项目结构：src/math.js（源码）、test/math.test.js（测试，禁止修改）、package.json。',
    '请完成以下任务：',
    '1. 必须先委派只读 reviewer 检查错误（可用 reviewer Agent id: ' + REVIEWER_AGENT_ID + '，能力 review）；',
    '2. 阅读 reviewer 的返回结果；',
    '3. 自己读取 src/math.js；',
    '4. 用 patch_file 做最小必要修改；',
    '5. 禁止修改测试文件；',
    '6. 运行测试（命令：node test/math.test.js）；',
    '7. 测试通过后立即返回 complete，不要重复验证。'
  ].join('\n');

  const onToolResult = (action, result) => {
    evidence.toolEvents.push({
      type: action && action.type,
      tool: result && result.tool,
      ok: !!(result && result.ok),
      path: action && action.args && action.args.path,
      command: action && action.args && action.args.command,
      exitCode: result ? result.exitCode : undefined,
      denied: !!(result && result.error && result.error.code === 'PERMISSION_DENIED'),
      outside: !!(result && result.error && result.error.code === 'PATH_OUTSIDE_WORKSPACE')
    });
  };

  // 7. 运行 MainAgentRuntime（生产入口）；无论成败都恢复 Hub 单例
  const beforeSnapshot = snapshotDir(fixture.root);
  let runId = null;
  try {
    ({ runId } = runMainAgent({
      conversationId: 'real-ai-smoke',
      agentId: 'native-main',
      agentName: 'Main Agent',
      goal: taskPrompt,
      projectRoot: fixture.root,
      projectId: null,
      model,
      getTool,
      store: null,
      emit,
      runManager: rm,
      requestPermission,
      permissionEngine,
      pathSecurity,
      timeoutMs,
      onToolResult,
      registerAbort: () => {},
      unregisterAbort: () => {}
    }));
  } catch (e) {
    setAgentHub(prevHub);
    throw e;
  }

  // 8. 等待 Parent Run 终态
  let parentStatus = null;
  let parentError = null;
  const deadline = Date.now() + timeoutMs + 30000;
  while (Date.now() < deadline) {
    const r = rm.getRun(runId);
    if (r && ['completed', 'failed', 'cancelled', 'timeout'].includes(r.status)) {
      parentStatus = r.status;
      parentError = r.error || null;
      break;
    }
    await new Promise(res => setTimeout(res, 300));
  }
  setAgentHub(prevHub);

  // 9. R3 deterministic security assertion（Harness 自己验证 PathSecurity）
  const security = await runSecurityAssertions(fixture, pathSecurity);

  // 10. R7 独立终验（在 cleanup 前）
  const afterSnapshot = snapshotDir(fixture.root);
  const fileDiff = diffSnapshots(beforeSnapshot, afterSnapshot);
  const testFileUnchanged = fixture.sha256Test === sha256File(fixture.testPath);
  const packageJsonUnchanged = !fileDiff.modified.includes('package.json') && !fileDiff.removed.includes('package.json');
  const onlyExpectedMutation =
    fileDiff.modified.length === 1 && fileDiff.modified[0] === 'src/math.js' &&
    fileDiff.added.length === 0 && fileDiff.removed.length === 0;
  let testsPass = false;
  let harnessTestExitCode = null;
  try {
    const { execFileSync } = require('child_process');
    // 真实 Electron 主进程下 process.execPath 是 electron.exe：子进程必须带
    // ELECTRON_RUN_AS_NODE=1 才按 Node 语义执行（plain node 下该 env 无副作用）。
    execFileSync(process.execPath, ['test/math.test.js'], {
      cwd: fixture.root,
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    testsPass = true;
    harnessTestExitCode = 0;
  } catch (e) {
    harnessTestExitCode = e && typeof e.status === 'number' ? e.status : 1;
  }

  // 11. R5/R6 证据归集
  const delegateModelAction = evidence.modelActions.find(a => a.type === 'delegate') || null;
  const delegationStarted = evidence.delegationEvents.find(e => e.type === ORCHESTRATION_EVENT.DELEGATION_STARTED) || null;
  const delegateObserved = !!(delegateModelAction && delegationStarted);
  const childAgentId = delegationStarted ? delegationStarted.agentId : null;

  // R6：delegate 之后的某一轮 model context 必须真实包含 reviewer finding（runtime 证据）
  const marker = 'a - b';
  let childResultConsumed = false;
  if (delegateModelAction) {
    const after = evidence.modelContexts.slice(delegateModelAction.iteration);
    const hit = after.find(c => typeof c.context === 'string' && c.context.includes(marker));
    if (hit) { childResultConsumed = true; evidence.consumedIteration = hit.iteration; }
    evidence.delegateIteration = delegateModelAction.iteration;
  }

  // R2 生产工具事件
  const observed = {
    read_file: evidence.toolEvents.some(t => t.tool === 'read_file' && t.ok),
    mutation: evidence.toolEvents.some(t => (t.tool === 'apply_patch' || t.tool === 'write_file') && t.ok),
    terminal_test: evidence.toolEvents.some(t => t.tool === 'terminal_run' && typeof t.exitCode === 'number')
  };

  const pass =
    delegateObserved &&
    childAgentId === REVIEWER_AGENT_ID &&
    childResultConsumed &&
    observed.read_file && observed.mutation && observed.terminal_test &&
    testFileUnchanged && packageJsonUnchanged && onlyExpectedMutation &&
    testsPass && parentStatus === 'completed' &&
    security.successfulOutsideWrites === 0;

  const report = {
    connectionSource: conn ? (opts.connectionSource || 'store') : 'n/a',
    provider: conn ? conn.provider : 'fake',
    model: opts.modelId || (conn && conn.model) || 'FakeCodingModel',
    budget: budget.counts(),
    delegateObserved,
    delegateModelAction: !!delegateModelAction,
    delegationStartedEvent: !!delegationStarted,
    childAgentId,
    childResultConsumed,
    delegateIteration: evidence.delegateIteration,
    consumedIteration: evidence.consumedIteration,
    productionToolsObserved: observed,
    sourceModified: onlyExpectedMutation,
    fileDiff: { modified: fileDiff.modified, added: fileDiff.added, removed: fileDiff.removed },
    testFileUnchanged,
    packageJsonUnchanged,
    testsPass,
    harnessTestExitCode,
    parentStatus,
    parentError,
    outsideWriteAttempts: security.attempts,
    successfulOutsideWrites: security.successfulOutsideWrites,
    permissionAsks: evidence.permissionAsks.length,
    elapsedMs: budget.elapsedMs()
  };

  return { pass, report, evidence };
}

function safeConnGet(store, id) {
  try { return store.connections.get(id); } catch { return null; }
}

module.exports = {
  REVIEWER_AGENT_ID,
  FIXTURE_PREFIX,
  initStandaloneStore,
  isDeepSeekLikeConnection,
  resolveRealAiConnection,
  resolveSmokeModel,
  createRealAiBudget,
  wrapModelWithBudget,
  builtinGetTool,
  createSmokePermissionEngine,
  createDeterministicRequestPermission,
  withRealAiFixture,
  countFixtureLeftovers,
  snapshotDir,
  diffSnapshots,
  sha256File,
  runSecurityAssertions,
  executeRealAiChain
};
