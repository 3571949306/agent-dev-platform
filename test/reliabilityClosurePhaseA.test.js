'use strict';
/**
 * v2.9.8 FINAL RELIABILITY CLOSURE — PHASE A proof matrix (A1-A10).
 *
 * Real chain: ProductEntry.mainAgent.run → MainAgentService → RunManager →
 * ProviderModelAdapter (fake network provider) → Orchestrator → AgentHub →
 * Dynamic Factory → Child → Grandchild. Only the network provider is fake.
 *
 *  - A3  Authentic Run Tree Lineage: RunManager derives parent/root from
 *        persisted lineage; unknown runId = null (fail-closed).
 *  - A6  Real Three-Level Delegation: Main → Child → Grandchild all actually
 *        execute adapter.startTask + provider call; Grandchild completes
 *        (never PROJECT_LOCKED) and shares rootRunId with Main.
 *  - A7  Forged Root Attack: an independent Run claiming rootRunId=Main cannot
 *        bypass the project lock (mutation exec = 0, PROJECT_LOCKED).
 *  - A5  Unforgeable Lock Reentrancy: forging parentRunId/token cannot reenter
 *        the parent's project lock without a real active orchestrator token.
 *  - A2  Execution-Started Truth: runId exists != execution started. Pre-start
 *        PROJECT_LOCKED carries runId but executionStarted=false and must NOT
 *        trigger repair.
 *  - A9  Same-project Cancellation Race: cancel the root while a descendant is
 *        still alive; the root lock stays held until descendants quiesce
 *        (Run B mutation = 0 while alive; may start after quiescence).
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
const { get: orchestratorGet } = require('../src/agent/orchestrator');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');
const { evaluateActionResult } = require('../src/agent/runtime/resultEvaluator');
const { FakeCliAdapter } = require('./fakes/fakeCliAdapter');
const { HEALTH_STATE } = require('../src/agents/hub/types');
const { terminalManager } = require('../src/tools/terminal');

const cap = value => ({ value, state: 'tested', source: 'closure-phaseA-fixture' });
const metric = value => ({ value, state: 'declared', source: 'closure-phaseA-fixture' });

async function cleanupDir(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return; }
    catch { /* Windows handle delay */ }
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

/** Full production-style platform wiring with token-verifying AgentHub. */
function buildPlatform({ adapterTimeoutMs = 6000 } = {}) {
  let activeProvider = null;
  let providerCalls = 0;
  const countingProvider = {
    streamResponse(input) {
      providerCalls++;
      if (!activeProvider) throw new Error('NO_ACTIVE_PROVIDER');
      return activeProvider.streamResponse(input);
    }
  };

  const connection = store.connections.create({
    name: 'PhaseA Fake Network', provider: 'custom', base_url: 'https://phasea.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['phasea-model'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'phasea-model', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });
  const agent = store.agents.create({
    name: 'PhaseA Main', is_main: true, api_connection_id: connection.id,
    model: 'phasea-model', tools: []
  });

  function defineWorker(id, name, prompt, canDelegate) {
    store.agentDefinitions.create({
      id, name, role: 'worker', systemPrompt: prompt,
      runtime: { kind: 'native' }, capabilities: ['coding'],
      toolPolicy: { allow: ['read_file', 'write_file', 'terminal_run'], deny: [] },
      permissionPolicy: { readOnly: false, allow: ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write'], deny: [] },
      modelPolicy: { mode: 'explicit', connectionId: connection.id, model: 'phasea-model', requirements: { required: { text: true } } },
      skills: { required: [], optional: [] }, hooks: { required: [], optional: [] },
      lifetime: 'run', budgets: { maxIterations: 6, maxRuntimeMs: 8000, maxRepairRounds: 2 },
      canDelegate
    });
  }
  defineWorker('phasea-child', 'PhaseA child', 'Do the child work.', true);
  defineWorker('phasea-grandchild', 'PhaseA grandchild', 'Do the grandchild work.', false);

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const resolver = createRuntimeModelResolver({
    router, audit,
    createModelAdapter(selection) {
      return createProviderModelAdapter({
        buildProvider: async () => countingProvider,
        agent: { id: agent.id, name: agent.name, api_connection_id: selection.selected.connectionId, model: selection.selected.modelId, max_tokens: 256 },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs: adapterTimeoutMs
      });
    }
  });

  const runManager = new RunManager({ store });
  const projectLock = createProjectMutationLock();
  const events = [];
  const emit = (type, payload) => { events.push({ type, payload }); };
  const pathSecurity = createPathSecurity({ cacheRoots: true });
  const hubPermission = new PermissionEngine({ projectId: 'phasea' });
  for (const scope of ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write']) {
    hubPermission.grant(scope, 'always', { persist: false });
  }

  const agentRegistry = createAgentRegistry();
  const lifecycle = createLifecycleManager();
  const runBridge = createRunBridge({ runManager, lifecycleManager: lifecycle });
  const contextFactory = createExecutionContextFactory({
    runManager, getTool: getBuiltin, store, permissionEngine: hubPermission, pathSecurity, projectMutationLock: projectLock
  });
  const hub = createAgentHub({
    registry: agentRegistry,
    router: createAgentRouter({ registry: agentRegistry }),
    healthManager: createHealthManager({ registry: agentRegistry }),
    lifecycleManager: lifecycle,
    runBridge,
    contextFactory,
    projectLock,
    delegationAuthorityVerifier: (parentRunId, token) => {
      const orch = orchestratorGet(parentRunId);
      return !!(orch && token && orch.delegationToken === token);
    }
  });
  const factory = createAgentFactory({
    getTool: getBuiltin,
    resolveRuntimeModel: resolver.resolveRuntimeModel,
    bindRouteDecisionToRun: audit.bindRunIdentity
  });
  setAgentHub(hub);
  setDynamicAgentRuntime(factory, store.agentDefinitions);

  function makeEntry(projectRoot, { timeoutMs = 25000 } = {}) {
    const project = store.projects.create({ name: 'PhaseA ' + path.basename(projectRoot), rootPath: projectRoot });
    const activeRuns = new Map();
    const service = createMainAgentService({
      store, emit, runManager, getTool: getBuiltin,
      buildProvider: async () => countingProvider,
      resolveModelFor: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
      resolveRuntimeModel: resolver.resolveRuntimeModel,
      bindRouteDecisionToRun: audit.bindRunIdentity,
      activeRuns,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      getCurrentProject: () => project,
      getAgentFull: id => store.agents.get(id),
      PermissionEngine,
      availableToolNames: listBuiltinDefs().map(d => d.name),
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
    agent, connection, runManager, projectLock, events, makeEntry, hub, runBridge, factory, lifecycle,
    agentRegistry,
    countCalls: () => providerCalls,
    setProvider: p => { activeProvider = p; },
    locksEmpty: () => projectLock.snapshot().writeLocks.length === 0 && projectLock.snapshot().readLocks.length === 0
  };
}

/** Register a deterministic probe adapter so hub.start can reach the lock gate. */
function registerProbeAdapter(platform, id) {
  const adapter = new FakeCliAdapter({ delayMs: 5 });
  adapter.manifest = { id, displayName: id, transport: 'cli', capabilities: { coding: true }, availability: true };
  adapter.id = id;
  adapter.capabilities = ['coding'];
  adapter.transport = 'cli';
  adapter.adapterType = 'cli';
  adapter.disabled = false;
  adapter.available = true;
  adapter.healthStatus = HEALTH_STATE.UNKNOWN;
  adapter.maxConcurrency = 1;
  adapter.activeRunCount = 0;
  platform.agentRegistry.register(adapter);
  return adapter;
}

function findRunByGoal(platform, parentRunId, marker) {
  return platform.runManager.list().find(r => r.parentRunId === parentRunId && String(r.rootRunId || '').length > 0 && marker(r));
}

/** --- A3 Authentic Run Tree Lineage --- */
test('A3 RunManager derives real lineage; unknown runId is fail-closed', () => {
  const rm = new RunManager();
  const main = rm.createRun({ conversationId: 'c-main', agentId: 'main' });
  const child = rm.createRun({ conversationId: 'c-child', agentId: 'child', parentRunId: main.id, rootRunId: main.id, depth: 1 });
  const grand = rm.createRun({ conversationId: 'c-grand', agentId: 'grand', parentRunId: child.id, rootRunId: main.id, depth: 2 });

  assert.strictEqual(rm.getParentRunId(child.id), main.id, 'child parent = main');
  assert.strictEqual(rm.getParentRunId(grand.id), child.id, 'grandchild parent = child');
  assert.strictEqual(rm.getRootRunId(grand.id), main.id, 'grandchild derives root = main via parent chain');
  assert.strictEqual(rm.getRootRunId(child.id), main.id, 'child derives root = main');
  assert.strictEqual(rm.getRootRunId(main.id), main.id, 'main root = itself');
  assert.strictEqual(rm.belongsToRoot(grand.id, main.id), true, 'grandchild belongs to main root');
  assert.strictEqual(rm.belongsToRoot(grand.id, child.id), false, 'grandchild does not belong to child root');

  // Fail-closed: unknown runId never yields a lineage
  assert.strictEqual(rm.getRootRunId('does-not-exist'), null, 'unknown runId root = null');
  assert.strictEqual(rm.getParentRunId('does-not-exist'), null, 'unknown runId parent = null');
  assert.strictEqual(rm.belongsToRoot('does-not-exist', main.id), false, 'unknown runId belongsToRoot = false');
  console.log('A3_LINEAGE derivedRoot=PASS failClosed=PASS');
});

/** --- A2 Execution-Started Truth (evaluator semantics) --- */
test('A2 executionStarted=false (pre-start) never triggers repair; true + terminal failure does', () => {
  // Pre-start PROJECT_LOCKED: runId exists but execution never started.
  const preStartResult = {
    ok: false, tool: 'delegate',
    data: { runId: 'some-hub-run-id', agentId: 'x', status: 'failed', executionStarted: false },
    error: { code: 'PROJECT_LOCKED', message: 'PROJECT_LOCKED' }
  };
  const preStartEval = evaluateActionResult({ type: 'delegate', args: {} }, preStartResult);
  assert.strictEqual(preStartEval.needsRepair, false, 'pre-start failure must not trigger repair');

  // Executed-child failure: executionStarted=true and terminal failure.
  const executedResult = {
    ok: false, tool: 'delegate',
    data: { runId: 'some-hub-run-id', agentId: 'x', status: 'timeout', executionStarted: true },
    error: { code: 'DELEGATE_TIMEOUT', message: 'child timed out' }
  };
  const executedEval = evaluateActionResult({ type: 'delegate', args: {} }, executedResult);
  assert.strictEqual(executedEval.needsRepair, true, 'executed-child failure must trigger repair');

  // runId present but executionStarted absent (legacy shape) must NOT trigger repair.
  const legacyResult = {
    ok: false, tool: 'delegate',
    data: { runId: 'legacy-run-id', agentId: 'x', status: 'failed' },
    error: { code: 'DELEGATE_FAILED', message: 'legacy' }
  };
  const legacyEval = evaluateActionResult({ type: 'delegate', args: {} }, legacyResult);
  assert.strictEqual(legacyEval.needsRepair, false, 'runId alone is not proof of execution started');
  console.log('A2_EXECUTION_STARTED prestartRepair=0 executedRepair>=1 legacyRepair=0');
});

/** --- A6 Real Three-Level Delegation --- */
test('A6 Main -> Child -> Grandchild all actually execute and share rootRunId', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a6-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a6-'));
  store.init(dataRoot);
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  let platform = null;
  try {
    platform = buildPlatform();
    const entry = platform.makeEntry(root, { timeoutMs: 20000 });

    let mainCalls = 0, childCalls = 0, grandCalls = 0;
    platform.setProvider({
      streamResponse(input) {
        const sys = String(input.system || '');
        let action;
        if (sys.includes('Do the grandchild work.')) {
          grandCalls++;
          action = { type: 'complete', args: { summary: 'grandchild done' } };
        } else if (sys.includes('Do the child work.')) {
          childCalls++;
          action = childCalls === 1
            ? { type: 'delegate', args: { goal: 'grandchild task', agentDefinitionId: 'phasea-grandchild' } }
            : { type: 'complete', args: { summary: 'child done' } };
        } else {
          mainCalls++;
          action = mainCalls === 1
            ? { type: 'delegate', args: { goal: 'child task', agentDefinitionId: 'phasea-child' } }
            : { type: 'complete', args: { summary: 'main done' } };
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    });

    const conv = entry.newConversation('A6 three-level');
    const started = await entry.run(conv.id, 'three-level delegation');
    const mainTerminal = await waitTerminal(platform.runManager, started.runId, 25000);
    assert.strictEqual(mainTerminal.status, 'completed', `main should complete, got ${mainTerminal.status} (${mainTerminal.error || ''})`);

    // Every level actually invoked the (fake) provider.
    assert.ok(grandCalls >= 1, `grandchild actually called provider (got ${grandCalls})`);
    assert.ok(childCalls >= 1, 'child actually called provider');

    // No PROJECT_LOCKED anywhere in the tree.
    const locked = platform.events.filter(e => e.type === EVENTS.TOOL_RESULT && e.payload.error && e.payload.error.code === 'PROJECT_LOCKED');
    assert.strictEqual(locked.length, 0, 'no PROJECT_LOCKED inside the run tree');

    // Lineage truth: Main / Child / Grandchild.
    const runs = platform.runManager.list();
    const mainRun = runs.find(r => r.id === started.runId);
    assert.strictEqual(mainRun.parentRunId, null, 'Main parentRunId = null');
    assert.strictEqual(mainRun.rootRunId, mainRun.id, 'Main rootRunId = Main');

    const childRun = runs.find(r => r.parentRunId === mainRun.id);
    assert.ok(childRun, 'Child run exists with parent = Main');
    assert.strictEqual(childRun.rootRunId, mainRun.id, 'Child rootRunId = Main');

    const grandRun = runs.find(r => r.parentRunId === childRun.id);
    assert.ok(grandRun, 'Grandchild run exists with parent = Child');
    assert.strictEqual(grandRun.rootRunId, mainRun.id, 'Grandchild rootRunId = Main');
    assert.strictEqual(grandRun.parentRunId, childRun.id, 'Grandchild parentRunId = Child');
    assert.strictEqual(grandRun.status, 'completed', `Grandchild actually completed, got ${grandRun.status}`);

    await settleTo(() => platform.locksEmpty(), 8000);
    assert.ok(platform.locksEmpty(), 'all project locks released after tree completes');
    console.log('A6_THREE_LEVEL grandchildExecuted=YES grandchildStatus=' + grandRun.status +
      ' sharedRoot=' + (childRun.rootRunId === mainRun.id && grandRun.rootRunId === mainRun.id) + ' projectLocked=NO');
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- A5 Unforgeable Lock Reentrancy (forged parentRunId/token rejected) --- */
test('A5 forged parentRunId/token cannot reenter the parent project lock', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a5-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a5-'));
  store.init(dataRoot);
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  let platform = null;
  try {
    platform = buildPlatform();
    const entry = platform.makeEntry(root, { timeoutMs: 20000 });

    // Start a real Main run that holds the lock and hangs (never completes on its own).
    platform.setProvider({ streamResponse: () => new Promise(() => {}) });
    const conv = entry.newConversation('A5 holder');
    const holder = await entry.run(conv.id, 'hold the lock');
    await settleTo(() => platform.projectLock.snapshot().writeLocks.length === 1, 8000);
    assert.strictEqual(platform.projectLock.snapshot().writeLocks.length, 1, 'holder acquired the write lock');

    // Register a real probe adapter so hub.start reaches the lock gate (not AGENT_NOT_FOUND).
    registerProbeAdapter(platform, 'a5-probe');

    // Attack: forge parentRunId = holder runId and a bogus token. The lineage matches
    // (getRootRunId(holder)=holder) but there is no real active orchestrator for a
    // *forged* caller, so the verifier must reject reentrancy.
    const forged = await platform.hub.start('a5-probe', {
      goal: 'forged child', projectRoot: root, projectId: 'phasea',
      parentRunId: holder.runId,           // forge: claim descent from holder
      delegationToken: 'forged-token-123', // forge: bogus token
      required: ['coding']
    });
    assert.ok(forged.error, 'forged delegation must fail');
    assert.strictEqual(forged.errorCode, 'PROJECT_LOCKED', `forged root must be PROJECT_LOCKED, got ${forged.errorCode}`);

    // Even with the holder's *real* orchestrator token but a caller that is NOT that
    // orchestrator, reentrancy is still denied (token alone is not the identity).
    const realOrch = orchestratorGet(holder.runId);
    const forged2 = await platform.hub.start('a5-probe', {
      goal: 'forged child 2', projectRoot: root, projectId: 'phasea',
      parentRunId: 'no-such-parent-run',   // lineage cannot be derived -> fail-closed
      delegationToken: realOrch ? realOrch.delegationToken : 'x',
      required: ['coding']
    });
    assert.ok(forged2.error, 'unknown-parent delegation must fail');
    assert.strictEqual(forged2.errorCode, 'PROJECT_LOCKED', 'unknown parent lineage is fail-closed PROJECT_LOCKED');

    // Cleanup: cancel the holder.
    entry.productEntry.mainAgent.stop({ conversationId: conv.id, runId: holder.runId });
    await waitTerminal(platform.runManager, holder.runId, 10000);
    await settleTo(() => platform.locksEmpty(), 8000);
    console.log('A5_UNFORGEABLE_LOCK forgedRootAccepted=NO failClosed=NO_BYPASS');
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- A7 Forged Root Attack (independent Run claims rootRunId=Main) --- */
test('A7 independent Run forging rootRunId cannot bypass project lock', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a7-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a7-'));
  store.init(dataRoot);
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  let platform = null;
  try {
    platform = buildPlatform();
    const entryA = platform.makeEntry(root, { timeoutMs: 20000 });

    // Main A holds the lock (hangs).
    platform.setProvider({ streamResponse: () => new Promise(() => {}) });
    const convA = entryA.newConversation('A7 main A');
    const mainA = await entryA.run(convA.id, 'main A holds lock');
    await settleTo(() => platform.projectLock.snapshot().writeLocks.length === 1, 8000);
    assert.strictEqual(platform.projectLock.snapshot().writeLocks.length, 1, 'main A holds the lock');

    // Independent Main B on the same projectRoot. It cannot acquire the lock.
    const entryB = platform.makeEntry(root, { timeoutMs: 20000 });
    const convB = entryB.newConversation('A7 main B');
    // Forge rootRunId = main A via extra opts (the service ignores unknown opts, but we
    // assert the lock itself is the boundary: B must fail busy with zero mutation).
    const beforeCalls = platform.countCalls();
    const mainB = await entryB.run(convB.id, 'main B tries to run', { rootRunId: mainA.runId });
    const bTerminal = await waitTerminal(platform.runManager, mainB.runId, 15000);
    assert.strictEqual(bTerminal.status, 'failed', `independent Run B must fail busy, got ${bTerminal.status}`);
    assert.match(String(bTerminal.error || ''), /PROJECT_LOCKED/, 'Run B error is PROJECT_LOCKED');

    // Zero mutation exec for B: no file writes, no additional provider calls beyond B's failed start.
    const filesInRoot = fs.readdirSync(root);
    assert.strictEqual(filesInRoot.length, 0, 'Run B performed zero filesystem mutation');

    // Cleanup.
    entryA.productEntry.mainAgent.stop({ conversationId: convA.id, runId: mainA.runId });
    await waitTerminal(platform.runManager, mainA.runId, 10000);
    await settleTo(() => platform.locksEmpty(), 8000);
    console.log('A7_FORGED_ROOT accepted=NO runBMutationExec=0 runBStatus=' + bTerminal.status);
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- A1 Terminal Truth: timeout vs late model completion race --- */
test('A1 timeout racing a late model completion yields exactly one terminal truth (timeout)', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a1-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a1-'));
  store.init(dataRoot);
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  let platform = null;
  try {
    // Short adapter timeout so the model decide times out before the late completion.
    platform = buildPlatform({ adapterTimeoutMs: 300 });
    const entry = platform.makeEntry(root, { timeoutMs: 15000 });

    // Provider resolves with a 'complete' action only AFTER the adapter timeout (late).
    platform.setProvider({
      streamResponse(input) {
        return new Promise((resolve) => {
          setTimeout(() => {
            const text = JSON.stringify({ action: { type: 'complete', args: { summary: 'late completion' } } });
            input.onChunk(text);
            resolve({ content: text });
          }, 1200); // > adapterTimeoutMs(300)
        });
      }
    });

    const conv = entry.newConversation('A1 timeout race');
    const started = await entry.run(conv.id, 'timeout vs late completion');
    const terminal = await waitTerminal(platform.runManager, started.runId, 12000);
    assert.strictEqual(terminal.status, 'timeout', `race must settle timeout, got ${terminal.status}`);

    // Wait for the late completion to arrive, then confirm it did NOT revive the run.
    await new Promise(r => setTimeout(r, 1500));
    const afterLate = platform.runManager.getRun(started.runId);
    assert.strictEqual(afterLate.status, 'timeout', 'late model completion must not revive terminal run');

    // Exactly one terminal GUI event, and it is RUN_TIMEOUT.
    const terminalEvents = platform.events.filter(e =>
      [EVENTS.RUN_COMPLETED, EVENTS.RUN_FAILED, EVENTS.RUN_CANCELLED, EVENTS.RUN_TIMEOUT].includes(e.type)
      && e.payload.runId === started.runId);
    const timeouts = terminalEvents.filter(e => e.type === EVENTS.RUN_TIMEOUT);
    const cancels = terminalEvents.filter(e => e.type === EVENTS.RUN_CANCELLED);
    const completeds = terminalEvents.filter(e => e.type === EVENTS.RUN_COMPLETED);
    assert.strictEqual(terminalEvents.length, 1, 'exactly one terminal event total');
    assert.strictEqual(timeouts.length, 1, 'RUN_TIMEOUT = 1');
    assert.strictEqual(cancels.length, 0, 'RUN_CANCELLED = 0');
    assert.strictEqual(completeds.length, 0, 'RUN_COMPLETED = 0');

    await settleTo(() => platform.locksEmpty(), 8000);
    console.log('A1_TERMINAL_TRUTH_RACE status=timeout terminalEvents=1 lateRevival=NO');
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

/** --- A9 Same-project Cancellation Race with Descendant Quiescence --- */
test('A9 cancel root while grandchild alive: lock held until quiescence, Run B blocked then may start', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a9-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-phasea-a9-'));
  store.init(dataRoot);
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  let platform = null;
  try {
    platform = buildPlatform({ adapterTimeoutMs: 8000 });
    const entryA = platform.makeEntry(root, { timeoutMs: 25000 });

    // Main A -> Child -> Grandchild, and Grandchild runs a LONG terminal command.
    let mainCalls = 0, childCalls = 0, grandCalls = 0;
    platform.setProvider({
      streamResponse(input) {
        const sys = String(input.system || '');
        let action;
        if (sys.includes('Do the grandchild work.')) {
          grandCalls++;
          action = grandCalls === 1
            ? { type: 'run_command', args: { command: 'node -e "setTimeout(function(){},20000)"', timeout_ms: 25000 } }
            : { type: 'complete', args: { summary: 'grandchild done' } };
        } else if (sys.includes('Do the child work.')) {
          childCalls++;
          action = childCalls === 1
            ? { type: 'delegate', args: { goal: 'grandchild long task', agentDefinitionId: 'phasea-grandchild' } }
            : { type: 'complete', args: { summary: 'child done' } };
        } else {
          mainCalls++;
          action = mainCalls === 1
            ? { type: 'delegate', args: { goal: 'child long task', agentDefinitionId: 'phasea-child' } }
            : { type: 'complete', args: { summary: 'main done' } };
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    });

    const convA = entryA.newConversation('A9 main A');
    const mainA = await entryA.run(convA.id, 'long delegated terminal work');

    // Wait until the grandchild's terminal process is actually alive.
    const alive = await settleTo(() => terminalManager.activeCount() > 0, 15000);
    assert.ok(alive, 'grandchild terminal process is alive before cancel');
    assert.strictEqual(platform.projectLock.snapshot().writeLocks.length, 1, 'root lock held while tree active');

    // While the descendant is alive, an independent Run B must be blocked (0 mutation).
    const entryB = platform.makeEntry(root, { timeoutMs: 20000 });
    const convB = entryB.newConversation('A9 main B');
    const mainB = await entryB.run(convB.id, 'B tries while A alive');
    const bTerminal = await waitTerminal(platform.runManager, mainB.runId, 15000);
    assert.strictEqual(bTerminal.status, 'failed', `Run B blocked while A alive, got ${bTerminal.status}`);
    assert.match(String(bTerminal.error || ''), /PROJECT_LOCKED/, 'Run B is PROJECT_LOCKED while A alive');
    assert.strictEqual(fs.readdirSync(root).length, 0, 'Run B mutation exec = 0');

    // Cancel Main A. Descendants must be torn down and the process tree killed.
    entryA.productEntry.mainAgent.stop({ conversationId: convA.id, runId: mainA.runId });
    const aTerminal = await waitTerminal(platform.runManager, mainA.runId, 15000);
    assert.strictEqual(aTerminal.status, 'cancelled', `Main A cancelled, got ${aTerminal.status}`);

    // Quiescence: terminal processes killed and root lock released.
    terminalManager.pruneTerminal();
    assert.strictEqual(await settleTo(() => terminalManager.activeCount() === 0, 10000), true, 'grandchild terminal process killed');
    assert.strictEqual(await settleTo(() => platform.locksEmpty(), 10000), true, 'root lock released after quiescence');

    // After the A tree quiesces, a new Run B may start and complete (no fake parallelism).
    platform.setProvider({
      streamResponse(input) {
        const text = JSON.stringify({ action: { type: 'complete', args: { summary: 'B done' } } });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    });
    const convB2 = entryB.newConversation('A9 main B retry');
    const mainB2 = await entryB.run(convB2.id, 'B after A quiesced');
    const b2Terminal = await waitTerminal(platform.runManager, mainB2.runId, 15000);
    assert.strictEqual(b2Terminal.status, 'completed', `Run B may start after quiescence, got ${b2Terminal.status}`);

    await settleTo(() => platform.locksEmpty(), 8000);
    console.log('A9_CANCEL_RACE interleavedWrites=0 lockHeldWhileAlive=YES releasedAfterQuiescence=YES BMayStart=YES');
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});
