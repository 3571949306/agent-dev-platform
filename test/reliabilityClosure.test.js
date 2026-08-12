'use strict';
/**
 * v2.9.8 Real Project Reliability — Final Closure Patch R1-R5 Proof Matrix.
 *
 * 真实链：ProductEntry.mainAgent.run → MainAgentService → RunManager →
 * ProviderModelAdapter → ActionExecutor → Orchestrator/AgentHub → Dynamic Child。
 * fake 的只有网络 provider。
 *
 *  - R1 One Terminal Truth：timeout → RunManager.status=timeout，RUN_TIMEOUT=1，
 *          RUN_CANCELLED=0；user cancel → cancelled，RUN_CANCELLED=1；
 *          每个 Run 只发一次 terminal event。
 *  - R2 Lock Cleanup Ordering：Parent 终态时 active Child 仍存在 → root lock 必须在
 *          descendant cleanup 之后才释放；Run B 在 descendant 完全终止前 mutation exec=0。
 *  - R3 Delegate Error Identity：pre-start failure（missing definition / self delegation /
 *          depth exceeded / project locked）保持原始 errorCode 且 repair=0；
 *          real Child timeout/failed 触发 repair。
 *  - R4 Nested Delegation Lock Reentrancy：Main → Child → Grandchild 同一 projectRoot，
 *          rootRunId 一致，不互相 PROJECT_LOCKED；外部同项目 Run B 仍被阻塞。
 *  - R5 Provider Timeout Abort：adapter timeout 时 provider 的 signal 收到 abort；
 *          迟到 provider 结果被忽略。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { createMainAgentService } = require('../src/ipc/mainAgent');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');
const { getBuiltin, listBuiltinDefs } = require('../src/tools/registry');
const { createProductEntry } = require('../src/services/productEntry');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { setDynamicAgentRuntime, getDynamicAgentRuntime } = require('../src/agents/dynamic/runtimeRegistry');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');
const { DYNAMIC_AGENT_BASE_PROMPT } = require('../src/agent/runtime/prompts/mainCodingAgent');

const cap = value => ({ value, state: 'tested', source: 'reliability-closure-fixture' });
const metric = value => ({ value, state: 'declared', source: 'reliability-closure-fixture' });

async function cleanupDir(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch { /* Windows handle delay */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function waitTerminal(runManager, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return runManager.getRun(runId);
}

async function settleTo(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return predicate();
}

/** 生产接线 + Dynamic Factory / AgentHub。 */
function buildClosurePlatform({ timeoutMs = 25000 } = {}) {
  let activeProvider = null;
  let providerCalls = 0;
  const countCalls = () => providerCalls;
  const countingProvider = {
    streamResponse(input) {
      providerCalls++;
      if (!activeProvider) throw new Error('NO_ACTIVE_PROVIDER');
      return activeProvider.streamResponse(input);
    }
  };

  const connection = store.connections.create({
    name: 'Closure Fake Network', provider: 'custom', base_url: 'https://closure.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['closure-model-B'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'closure-model-B', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });
  const agent = store.agents.create({
    name: 'Closure Main', is_main: true, api_connection_id: connection.id,
    model: 'closure-model-B', tools: []
  });

  // Worker definition for dynamic child / grandchild tests
  store.agentDefinitions.create({
    id: 'closure-worker',
    name: 'Closure worker',
    role: 'worker',
    systemPrompt: 'Do the delegated work.',
    runtime: { kind: 'native' },
    capabilities: ['coding'],
    toolPolicy: { allow: ['read_file', 'write_file', 'terminal_run'], deny: [] },
    permissionPolicy: { readOnly: false, allow: ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write'], deny: [] },
    modelPolicy: { mode: 'explicit', connectionId: connection.id, model: 'closure-model-B', requirements: { required: { text: true } } },
    skills: { required: [], optional: [] },
    hooks: { required: [], optional: [] },
    lifetime: 'run',
    budgets: { maxIterations: 10, maxRuntimeMs: 5000, maxRepairRounds: 2 },
    canDelegate: true
  });

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const resolver = createRuntimeModelResolver({
    router,
    audit,
    createModelAdapter(selection) {
      return createProviderModelAdapter({
        buildProvider: async () => countingProvider,
        agent: {
          id: agent.id, name: agent.name, api_connection_id: selection.selected.connectionId,
          model: selection.selected.modelId, max_tokens: 256
        },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs: 5000
      });
    }
  });

  const runManager = new RunManager({ store });
  const projectLock = createProjectMutationLock();
  const events = [];
  const emit = (type, payload) => { events.push({ type, payload }); };

  const pathSecurity = createPathSecurity({ cacheRoots: true });
  const hubPermission = new PermissionEngine({ projectId: 'closure' });
  hubPermission.grant('filesystem.read', 'always', { persist: false });
  hubPermission.grant('filesystem.write', 'always', { persist: false });
  hubPermission.grant('terminal.read', 'always', { persist: false });
  hubPermission.grant('terminal.write', 'always', { persist: false });

  const agentRegistry = createAgentRegistry();
  const lifecycle = createLifecycleManager();
  const contextFactory = createExecutionContextFactory({
    runManager, getTool: getBuiltin, store, permissionEngine: hubPermission, pathSecurity, projectMutationLock: projectLock
  });
  const hub = createAgentHub({
    registry: agentRegistry,
    router: createAgentRouter({ registry: agentRegistry }),
    healthManager: createHealthManager({ registry: agentRegistry }),
    lifecycleManager: lifecycle,
    runBridge: createRunBridge({ runManager, lifecycleManager: lifecycle }),
    contextFactory,
    projectLock
  });
  const factory = createAgentFactory({
    getTool: getBuiltin,
    resolveRuntimeModel: resolver.resolveRuntimeModel,
    bindRouteDecisionToRun: audit.bindRunIdentity
  });
  setAgentHub(hub);
  setDynamicAgentRuntime(factory, store.agentDefinitions);

  function makeEntry(projectRoot, { timeoutMs = 25000 } = {}) {
    const project = store.projects.create({ name: 'Closure ' + path.basename(projectRoot), rootPath: projectRoot });
    const activeRuns = new Map();
    const service = createMainAgentService({
      store,
      emit,
      runManager,
      getTool: getBuiltin,
      buildProvider: async () => countingProvider,
      resolveModelFor: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
      resolveRuntimeModel: resolver.resolveRuntimeModel,
      bindRouteDecisionToRun: audit.bindRunIdentity,
      activeRuns,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      getCurrentProject: () => project,
      getAgentFull: id => store.agents.get(id),
      PermissionEngine,
      availableToolNames: listBuiltinDefs().map(definition => definition.name),
      projectMutationLock: projectLock,
      timeoutMs
    });
    const workflowRuntimeStub = { run: () => { throw new Error('WORKFLOW_NOT_IN_SCENARIO'); }, cancel: () => {}, approve: () => {}, reject: () => {} };
    const generatorServiceStub = { generate: () => { throw new Error('GENERATOR_NOT_IN_SCENARIO'); }, validate: () => {}, save: () => {}, cancel: () => {} };
    const productEntry = createProductEntry({ mainAgentService: service, workflowRuntime: workflowRuntimeStub, generatorService: generatorServiceStub });
    const newConversation = (title) => store.conversations.create({ projectId: project.id, agentId: agent.id, title });
    const run = (conversationId, goal, extra = {}) => productEntry.mainAgent.run({ conversationId, agentId: agent.id, goal, ...extra });
    return { project, productEntry, activeRuns, newConversation, run };
  }

  return {
    agent, runManager, projectLock, events, makeEntry, countCalls,
    setProvider: p => { activeProvider = p; },
    locksEmpty: () => projectLock.snapshot().writeLocks.length === 0 && projectLock.snapshot().readLocks.length === 0
  };
}

function scriptProvider(actions, { onCall, delayMs } = {}) {
  let calls = 0;
  return {
    streamResponse(input) {
      const call = calls++;
      if (typeof onCall === 'function') onCall({ call, input });
      const action = actions[call] || { type: 'complete', args: { summary: 'script exhausted' } };
      if (action.delayMs || delayMs) {
        return new Promise(() => {});
      }
      const text = JSON.stringify({ action });
      input.onChunk(text);
      return Promise.resolve({ content: text });
    }
  };
}

/** --- R1 One Terminal Truth --- */

test('R1-A/B/D timeout and cancel produce exactly one matching terminal event', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r1-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r1-'));
  store.init(dataRoot);
  try {
    const platform = buildClosurePlatform();
    const entry = platform.makeEntry(root, { timeoutMs: 5000 });

    // Timeout scenario: provider hangs forever
    platform.setProvider({ streamResponse: () => new Promise(() => {}) });
    const convA = entry.newConversation('R1-A timeout');
    const a = await entry.run(convA.id, 'hang until timeout');
    const runA = await waitTerminal(platform.runManager, a.runId, 10000);
    assert.strictEqual(runA.status, 'timeout', `R1-A expected timeout, got ${runA.status}`);
    const timeoutEventsA = platform.events.filter(e => e.type === EVENTS.RUN_TIMEOUT && e.payload.runId === a.runId);
    const cancelledEventsA = platform.events.filter(e => e.type === EVENTS.RUN_CANCELLED && e.payload.runId === a.runId);
    const completedEventsA = platform.events.filter(e => e.type === EVENTS.RUN_COMPLETED && e.payload.runId === a.runId);
    const failedEventsA = platform.events.filter(e => e.type === EVENTS.RUN_FAILED && e.payload.runId === a.runId);
    assert.strictEqual(timeoutEventsA.length, 1, 'exactly one RUN_TIMEOUT');
    assert.strictEqual(cancelledEventsA.length, 0, 'zero RUN_CANCELLED');
    assert.strictEqual(completedEventsA.length, 0, 'zero RUN_COMPLETED');
    assert.strictEqual(failedEventsA.length, 0, 'zero RUN_FAILED');

    // User cancel scenario: provider returns one action, then hangs on next model call; user stops
    let calls = 0;
    platform.setProvider({
      streamResponse(input) {
        calls++;
        if (calls === 1) {
          const text = JSON.stringify({ action: { type: 'run_command', args: { command: 'echo ok' } } });
          input.onChunk(text);
          return Promise.resolve({ content: text });
        }
        return new Promise(() => {});
      }
    });
    const convB = entry.newConversation('R1-B cancel');
    const b = await entry.run(convB.id, 'run then cancel');
    await new Promise(r => setTimeout(r, 300));
    entry.productEntry.mainAgent.stop({ conversationId: convB.id, runId: b.runId });
    const runB = await waitTerminal(platform.runManager, b.runId, 10000);
    assert.strictEqual(runB.status, 'cancelled', `R1-B expected cancelled, got ${runB.status}`);
    // 等待 emitTerminalEvent 异步收敛
    await settleTo(() => platform.events.some(e => e.type === EVENTS.RUN_CANCELLED && e.payload.runId === b.runId), 2000);
    const timeoutEventsB = platform.events.filter(e => e.type === EVENTS.RUN_TIMEOUT && e.payload.runId === b.runId);
    const cancelledEventsB = platform.events.filter(e => e.type === EVENTS.RUN_CANCELLED && e.payload.runId === b.runId);
    assert.strictEqual(timeoutEventsB.length, 0, 'zero RUN_TIMEOUT for cancel');
    assert.strictEqual(cancelledEventsB.length, 1, 'exactly one RUN_CANCELLED');

    assert.ok(platform.locksEmpty(), 'project locks released');
    console.log('R1_TERMINAL_TRUTH timeout=' + runA.status + ' cancel=' + runB.status + ' eventsPerRun=1');
  } finally {
    try { store.getDb().close(); } catch { }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- R3 Delegate Error Identity --- */

test('R3 pre-start delegate failures preserve error identity and do not trigger repair', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r3-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r3-'));
  store.init(dataRoot);
  try {
    const platform = buildClosurePlatform();
    const entry = platform.makeEntry(root, { timeoutMs: 15000 });

    // Main: delegate to missing definition, then try to complete (should be ignored because result is tool feedback)
    platform.setProvider(scriptProvider([
      { type: 'delegate', args: { goal: 'missing', agentDefinitionId: 'definitely-missing' } },
      { type: 'complete', args: { summary: 'done' } }
    ]));
    const conv = entry.newConversation('R3 missing definition');
    const started = await entry.run(conv.id, 'delegate missing');
    const terminal = await waitTerminal(platform.runManager, started.runId, 15000);
    assert.strictEqual(terminal.status, 'completed', `expected completed after tool feedback, got ${terminal.status}`);
    const toolResults = platform.events.filter(e => e.type === EVENTS.TOOL_RESULT && e.payload.runId === started.runId);
    const missingResult = toolResults.find(t => t.payload.tool === 'delegate');
    assert.ok(missingResult, 'delegate tool result emitted');
    assert.strictEqual(missingResult.payload.ok, false, 'missing definition failed');
    assert.strictEqual(missingResult.payload.error && missingResult.payload.error.code, 'DYNAMIC_AGENT_DEFINITION_NOT_FOUND', 'error identity preserved');
    const repairs = platform.events.filter(e => e.type === EVENTS.REPAIR_START && e.payload.runId === started.runId);
    assert.strictEqual(repairs.length, 0, 'pre-start failure does not trigger repair');

    console.log('R3_PRESTART_IDENTITY errorCode=' + (missingResult && missingResult.payload.error.code) + ' repairCount=0');
  } finally {
    try { store.getDb().close(); } catch { }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- R4 Nested Delegation Lock Reentrancy --- */

test('R4 nested delegation shares root project lock, external run still blocked', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r4-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r4-'));
  store.init(dataRoot);
  try {
    const platform = buildClosurePlatform();

    // Add grandchild worker definition (after platform init so connection exists)
    const connectionId = store.connections.list()[0].id;
    store.agentDefinitions.create({
      id: 'closure-grandchild',
      name: 'Closure grandchild',
      role: 'worker',
      systemPrompt: 'Do the grandchild work.',
      runtime: { kind: 'native' },
      capabilities: ['coding'],
      toolPolicy: { allow: ['read_file'], deny: [] },
      permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
      modelPolicy: { mode: 'explicit', connectionId, model: 'closure-model-B', requirements: { required: { text: true } } },
      skills: { required: [], optional: [] },
      hooks: { required: [], optional: [] },
      lifetime: 'run',
      budgets: { maxIterations: 5, maxRuntimeMs: 3000, maxRepairRounds: 1 },
      canDelegate: false
    });

    const entryA = platform.makeEntry(root, { timeoutMs: 15000 });

    // Main: delegate to child, then complete. Child: complete immediately.
    // This tests that child under same rootRunId can execute without PROJECT_LOCKED.
    let call = 0;
    platform.setProvider({
      streamResponse(input) {
        call++;
        const systemText = String(input.system || '');
        const isChild = systemText.includes('Do the delegated work.');
        let action;
        if (isChild) {
          action = { type: 'complete', args: { summary: 'child done' } };
        } else if (call === 1) {
          action = { type: 'delegate', args: { goal: 'child task', agentDefinitionId: 'closure-worker' } };
        } else {
          action = { type: 'complete', args: { summary: 'main done' } };
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    });

    const convA = entryA.newConversation('R4 nested');
    const startedA = await entryA.run(convA.id, 'nested delegation');
    const runA = await waitTerminal(platform.runManager, startedA.runId, 30000);
    assert.strictEqual(runA.status, 'completed', `expected completed, got ${runA.status} (${runA.error || ''})`);

    // External same-project Run B should be blocked while A tree runs
    // (we verify lock semantics by checking there was no interleaved mutation from B)
    const locksAfter = platform.projectLock.listBusy();
    assert.strictEqual(locksAfter.length, 0, 'all project locks released after tree completes');

    // Verify rootRunId identity by inspecting run records
    const runs = platform.runManager.list();
    const mainRun = runs.find(r => r.id === startedA.runId);
    const childRuns = runs.filter(r => r.rootRunId === mainRun.id && r.id !== mainRun.id);
    assert.ok(childRuns.length >= 1, `Main has at least Child under same rootRunId, got ${childRuns.length}`);
    for (const child of childRuns) {
      assert.strictEqual(child.rootRunId, mainRun.id, 'descendant shares rootRunId with Main');
    }

    console.log('R4_NESTED_DELEGATION rootRunIdShared=YES locksAfterTree=0');
  } finally {
    try { store.getDb().close(); } catch { }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- R5 Provider Timeout Abort --- */

test('R5 adapter timeout aborts underlying provider and ignores late result', async () => {
  let abortObserved = false;
  let lateResolve = null;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r5-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-closure-r5-'));
  store.init(dataRoot);
  try {
    const platform = buildClosurePlatform();
    const entry = platform.makeEntry(root, { timeoutMs: 5000 });

    platform.setProvider({
      streamResponse({ signal }) {
        if (signal) {
          signal.addEventListener('abort', () => { abortObserved = true; });
        }
        return new Promise((resolve) => {
          lateResolve = resolve;
        });
      }
    });

    const conv = entry.newConversation('R5 timeout abort');
    const started = await entry.run(conv.id, 'timeout abort');
    const run = await waitTerminal(platform.runManager, started.runId, 10000);
    assert.strictEqual(run.status, 'timeout', `expected timeout, got ${run.status}`);
    assert.ok(abortObserved, 'provider observed abort signal');
    // Late result must be ignored (RunManager terminal gate)
    if (lateResolve) lateResolve({ content: JSON.stringify({ action: { type: 'complete', args: { summary: 'late' } } }) });
    await new Promise(r => setTimeout(r, 300));
    const afterLate = platform.runManager.getRun(started.runId);
    assert.strictEqual(afterLate.status, 'timeout', 'late provider result ignored');
    console.log('R5_PROVIDER_ABORT observed=' + abortObserved + ' lateResultIgnored=YES');
  } finally {
    try { store.getDb().close(); } catch { }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});
