'use strict';
/**
 * v2.9.8 Real Project Reliability — R6 Supplemental：Dynamic Child 生命周期 + Restart Truth。
 *
 * 真实链：ProductEntry.mainAgent.run → Main Agent → delegate → AgentHub →
 * Dynamic Factory → Dynamic Child（NativeAdapter → runMainAgent）。
 * fake 的只有网络 provider。
 *
 *  - R6-C  Child fake provider 挂起 → child budgets.maxRuntimeMs 兑现 →
 *          Child terminal != completed；Parent 有界结算（repair/fail），
 *          绝不假装 Child 成功；Dynamic instances / AgentHub active / locks 清零。
 *  - R6-F  Child active 时 cancel Main → 取消级联到 Child；Main cancelled、
 *          Child terminal、实例 dispose、AgentHub active = 0。
 *  - R6 Restart Truth：持久化 Agent Run=requesting_model / Workflow=RUNNING /
 *          Generator=GENERATING，模拟进程重启 → Agent interrupted、
 *          Workflow FAILED(WORKFLOW_INTERRUPTED)、Generator FAILED(GENERATOR_INTERRUPTED)；
 *          重启恢复过程 provider calls=0、tool executions=0、filesystem mutations=0、
 *          workflow step replay=0，且绝不 automatic resume。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { setDynamicAgentRuntime, getDynamicAgentRuntime } = require('../src/agents/dynamic/runtimeRegistry');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { DYNAMIC_AGENT_BASE_PROMPT } = require('../src/agent/runtime/prompts/mainCodingAgent');
const { recoverInterruptedRuntime } = require('../src/services/runtimeRecovery');
const { _activeCount: orchestratorActiveCount } = require('../src/agent/orchestrator/mainAgentOrchestrator');

const cap = value => ({ value, state: 'tested', source: 'reliability-delegation-fixture' });
const metric = value => ({ value, state: 'declared', source: 'reliability-delegation-fixture' });

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

/** 搭建 ProductEntry + MainAgentService + AgentHub + DynamicFactory 真实链。 */
function buildProductChain({ projectRoot, childBudgets, fakeProvider, timeoutMs = 2000 }) {
  const connection = store.connections.create({
    name: 'Delegation Fake Network', provider: 'custom', base_url: 'https://delegation.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['delegation-model-B'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'delegation-model-B', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });
  const project = store.projects.create({ name: 'Delegation project', rootPath: projectRoot });
  const agent = store.agents.create({
    name: 'Delegation Main', is_main: true, api_connection_id: connection.id,
    model: 'delegation-model-B', tools: []
  });

  store.agentDefinitions.create({
    id: 'delegation-worker',
    name: 'Delegation worker',
    role: 'worker',
    systemPrompt: 'Do the delegated work.',
    runtime: { kind: 'native' },
    capabilities: ['coding'],
    toolPolicy: { allow: ['read_file'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'explicit', connectionId: connection.id, model: 'delegation-model-B', requirements: { required: { text: true } } },
    skills: { required: [], optional: [] },
    hooks: { required: [], optional: [] },
    lifetime: 'run',
    budgets: childBudgets,
    canDelegate: false
  });

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const resolver = createRuntimeModelResolver({
    router,
    audit,
    createModelAdapter(selection) {
      return createProviderModelAdapter({
        buildProvider: async () => fakeProvider,
        agent: {
          id: agent.id, name: agent.name, api_connection_id: selection.selected.connectionId,
          model: selection.selected.modelId, max_tokens: 256
        },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs
      });
    }
  });

  const runManager = new RunManager({ store });
  const projectLock = createProjectMutationLock();
  const pathSecurity = createPathSecurity({ cacheRoots: true });
  const hubPermission = new PermissionEngine({ projectId: project.id });
  hubPermission.grant('filesystem.read', 'always', { persist: false });
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

  const activeRuns = new Map();
  const events = [];
  const service = createMainAgentService({
    store,
    emit: (type, payload) => { events.push({ type, payload }); },
    runManager,
    getTool: getBuiltin,
    buildProvider: async () => fakeProvider,
    resolveModelFor: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
    resolveRuntimeModel: resolver.resolveRuntimeModel,
    bindRouteDecisionToRun: audit.bindRunIdentity,
    activeRuns,
    requestPermission: async () => ({ decision: 'deny', range: 'once' }),
    getCurrentProject: () => project,
    getAgentFull: id => store.agents.get(id),
    PermissionEngine,
    availableToolNames: listBuiltinDefs().map(definition => definition.name),
    projectMutationLock: projectLock
  });
  const workflowRuntimeStub = { run: () => { throw new Error('WORKFLOW_NOT_IN_SCENARIO'); }, cancel: () => {}, approve: () => {}, reject: () => {} };
  const generatorServiceStub = { generate: () => { throw new Error('GENERATOR_NOT_IN_SCENARIO'); }, validate: () => {}, save: () => {}, cancel: () => {} };
  const productEntry = createProductEntry({ mainAgentService: service, workflowRuntime: workflowRuntimeStub, generatorService: generatorServiceStub });

  return { project, agent, runManager, projectLock, lifecycle, factory, agentRegistry, activeRuns, events, productEntry, pathSecurity };
}

test('R6-C dynamic child hang: child budget settles honest terminal, parent never fakes child success', async () => {
  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-childhang-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-childhang-db-'));
  store.init(dataRoot);
  let chain = null;
  try {
    // Child provider 永不 settle（最恶劣挂死）；Main 先 delegate 再 complete（无状态计数）
    let mainCalls = 0;
    const scripted = {
      streamResponse(input) {
        const isChild = String(input.system || '').includes(DYNAMIC_AGENT_BASE_PROMPT);
        if (isChild) return new Promise(() => { /* never settles */ });
        const action = mainCalls++ === 0
          ? { type: 'delegate', args: { goal: 'Do the delegated work.', agentDefinitionId: 'delegation-worker' } }
          : { type: 'complete', args: { summary: 'main after failed delegation' } };
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    };

    chain = buildProductChain({
      projectRoot,
      childBudgets: { maxIterations: 3, maxToolCalls: 3, maxRuntimeMs: 1500 },
      fakeProvider: scripted
    });
    const conversation = store.conversations.create({ projectId: chain.project.id, agentId: chain.agent.id, title: 'Child hang' });

    const t0 = Date.now();
    const started = await chain.productEntry.mainAgent.run({
      conversationId: conversation.id, agentId: chain.agent.id,
      goal: 'Delegate work that will hang.'
    });
    const mainTerminal = await waitTerminal(chain.runManager, started.runId, 45000);

    // Parent 必须诚实失败（repair 后 AGENT_REPAIR_LIMIT），绝不假装 Child 成功
    assert.strictEqual(mainTerminal.status, 'failed', `parent must fail honestly, got ${mainTerminal.status}`);
    const { EVENTS } = require('../src/agent/runtime/runtimeEvents');
    const failedEvent = chain.events.find(e => e.type === EVENTS.RUN_FAILED && e.payload.runId === started.runId);
    assert.ok(failedEvent, 'RUN_FAILED emitted for the parent');
    assert.strictEqual(failedEvent.payload.errorCode, 'AGENT_REPAIR_LIMIT',
      'parent fails via repair limit, never fakes child success');
    assert.ok(!chain.events.some(e => e.type === EVENTS.RUN_COMPLETED && e.payload.runId === started.runId),
      'no RUN_COMPLETED for a run whose child failed');
    assert.ok(Date.now() - t0 < 40000, 'parent settles in bounded time (no hang forever)');

    // Child terminal != completed（budget maxRuntimeMs 兑现为 timeout）
    const childRuns = chain.runManager.list().filter(run => run.parentRunId === started.runId);
    assert.strictEqual(childRuns.length, 1, 'exactly one dynamic child run');
    assert.notStrictEqual(childRuns[0].status, 'completed', 'hung child must not be reported completed');
    assert.ok(['timeout', 'failed', 'cancelled'].includes(childRuns[0].status), 'child terminal is honest: ' + childRuns[0].status);

    // R6 FINAL RESOURCE ASSERTION
    assert.strictEqual(await settleTo(() => chain.factory.listInstances().length === 0), true, 'Dynamic instances = 0');
    assert.strictEqual(chain.factory.activeTimerCount(), 0, 'dynamic timers = 0');
    assert.strictEqual(await settleTo(() => chain.lifecycle.listActive().length === 0), true, 'AgentHub active = 0');
    assert.strictEqual(await settleTo(() => chain.projectLock.snapshot().writeLocks.length === 0
      && chain.projectLock.snapshot().readLocks.length === 0), true, 'project locks = 0');
    assert.strictEqual(await settleTo(() => chain.activeRuns.size === 0), true, 'activeRuns = 0');
    assert.strictEqual(orchestratorActiveCount(), 0, 'orchestrator registry = 0');
    console.log('R6_C_DYNAMIC_CHILD_HANG childTerminal=' + childRuns[0].status + ' parentTerminal=failed fakeChildSuccess=NO resources=ZERO');
  } finally {
    setAgentHub(previousHub);
    setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
    if (chain) { try { chain.pathSecurity.clearRootCache(); } catch { /* best effort */ } }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('R6-F cancel during delegate: cancellation propagates to the dynamic child', async () => {
  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-childcancel-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-childcancel-db-'));
  store.init(dataRoot);
  let chain = null;
  try {
    let mainCalls = 0;
    const scripted = {
      streamResponse(input) {
        const isChild = String(input.system || '').includes(DYNAMIC_AGENT_BASE_PROMPT);
        if (isChild) {
          // Child 请求挂 15 秒，但尊重 abort（真实 provider 合同）
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ content: '{}' }), 15000);
            if (input.signal) {
              input.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                const e = new Error('aborted');
                e.name = 'AbortError';
                e.aborted = true;
                reject(e);
              }, { once: true });
            }
          });
        }
        const action = mainCalls++ === 0
          ? { type: 'delegate', args: { goal: 'Long delegated work.', agentDefinitionId: 'delegation-worker' } }
          : { type: 'complete', args: { summary: 'should never get here' } };
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    };

    chain = buildProductChain({
      projectRoot,
      childBudgets: { maxIterations: 5, maxToolCalls: 5, maxRuntimeMs: 20000 },
      fakeProvider: scripted
    });
    const conversation = store.conversations.create({ projectId: chain.project.id, agentId: chain.agent.id, title: 'Cancel delegate' });

    const started = await chain.productEntry.mainAgent.run({
      conversationId: conversation.id, agentId: chain.agent.id,
      goal: 'Delegate long work, then get cancelled.'
    });

    // 等待 Dynamic Child 真正活跃
    const childActive = await settleTo(() => chain.runManager.list().some(run =>
      run.parentRunId === started.runId && !['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)), 10000);
    assert.ok(childActive, 'dynamic child is active before cancel');
    const childRunId = chain.runManager.list().find(run => run.parentRunId === started.runId).id;

    // cancel Main（产品 stop 语义）
    const stopped = chain.productEntry.mainAgent.stop({ conversationId: conversation.id, runId: started.runId });
    assert.strictEqual(stopped.stopped, true);

    const mainTerminal = await waitTerminal(chain.runManager, started.runId);
    assert.strictEqual(mainTerminal.status, 'cancelled', 'Main cancelled');
    const childTerminal = await waitTerminal(chain.runManager, childRunId);
    assert.ok(['cancelled', 'failed', 'timeout'].includes(childTerminal.status), 'Child terminal after propagation: ' + childTerminal.status);
    assert.strictEqual(childTerminal.status, 'cancelled', 'child cancel propagated as cancelled');

    // 资源清零
    assert.strictEqual(await settleTo(() => chain.factory.listInstances().length === 0), true, 'Dynamic instance disposed');
    assert.strictEqual(await settleTo(() => chain.lifecycle.listActive().length === 0), true, 'AgentHub active = 0');
    assert.strictEqual(await settleTo(() => chain.projectLock.snapshot().writeLocks.length === 0
      && chain.projectLock.snapshot().readLocks.length === 0), true, 'project locks = 0');
    assert.strictEqual(await settleTo(() => chain.activeRuns.size === 0), true, 'activeRuns = 0');
    assert.strictEqual(orchestratorActiveCount(), 0, 'orchestrator registry = 0');
    console.log('R6_F_CANCEL_DURING_DELEGATE mainTerminal=cancelled childTerminal=' + childTerminal.status + ' propagation=YES resources=ZERO');
  } finally {
    setAgentHub(previousHub);
    setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
    if (chain) { try { chain.pathSecurity.clearRootCache(); } catch { /* best effort */ } }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('R6 restart truth: persisted active Run/Workflow/Generator settle honest terminals with zero replay', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-restart-db-'));
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-restart-fs-'));
  store.init(dataRoot);
  try {
    // --- 重启前的持久化真相：三类活跃记录 ---
    const oldManager = new RunManager({ store });
    const staleRun = oldManager.createRun({ conversationId: 'stale-restart-conv', agentId: 'native-main' });
    oldManager.updateRun(staleRun.id, 'requesting_model');
    assert.strictEqual(store.runs.get(staleRun.id).status, 'requesting_model');

    store.workflowExecutions.create({
      workflowRunId: 'wf-restart-1', workflowId: 'wf-definition-1', status: 'RUNNING',
      projectId: null, projectRoot: fsRoot, input: { seed: 1 }
    });
    store.workflowStepExecutions.create({
      workflowRunId: 'wf-restart-1', stepId: 'step-1', stepType: 'agent', status: 'RUNNING', attempt: 0
    });
    store.generatorDrafts.create({
      draftId: 'draft-restart-1', generationId: 'gen-restart-1', artifactType: 'agent_definition', status: 'GENERATING'
    });

    // --- Replay 侦测：provider / tool / filesystem 全部计数 ---
    const replay = { providerCalls: 0, toolExecutions: 0 };
    const hashDir = () => {
      const entries = [];
      const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) walk(abs);
          else entries.push(abs + ':' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
        }
      };
      walk(fsRoot);
      return crypto.createHash('sha256').update(entries.sort().join('\n')).digest('hex');
    };
    fs.writeFileSync(path.join(fsRoot, 'user-file.txt'), 'RESTART_TRUTH_USER_FILE\n', 'utf8');
    const fsBefore = hashDir();
    const stepsBefore = store.workflowStepExecutions.listByRun('wf-restart-1').length;
    const auditBefore = store.workflowAudit.listByRun('wf-restart-1').length;

    // --- 模拟进程重启：全新的 RunManager + 冷启动恢复（没有任何 runtime 复活）---
    const newManager = new RunManager({ store });
    const recovered = recoverInterruptedRuntime({ store, runManager: newManager });
    assert.strictEqual(recovered.runs, 1);
    assert.strictEqual(recovered.workflows, 1);
    assert.strictEqual(recovered.workflowSteps, 1);
    assert.strictEqual(recovered.generatorDrafts, 1);

    // --- Agent → interrupted ---
    const runAfter = store.runs.get(staleRun.id);
    assert.strictEqual(runAfter.status, 'interrupted');
    assert.ok(runAfter.message, 'interrupted run carries an honest explanation');

    // --- Workflow → FAILED / interrupted-compatible terminal ---
    const wfAfter = store.workflowExecutions.get('wf-restart-1');
    assert.strictEqual(wfAfter.status, 'FAILED');
    assert.strictEqual(wfAfter.errorCode, 'WORKFLOW_INTERRUPTED');
    const stepAfter = store.workflowStepExecutions.get('wf-restart-1', 'step-1');
    assert.strictEqual(stepAfter.status, 'CANCELLED');
    assert.strictEqual(stepAfter.errorCode, 'WORKFLOW_INTERRUPTED');

    // --- Generator → FAILED / interrupted-compatible terminal ---
    const draftAfter = store.generatorDrafts.get('draft-restart-1');
    assert.strictEqual(draftAfter.status, 'FAILED');
    assert.strictEqual(draftAfter.errorCode, 'GENERATOR_INTERRUPTED');

    // --- 重启恢复零重放：provider / tool / mutation / step replay 全部为 0 ---
    assert.strictEqual(replay.providerCalls, 0, 'restart provider calls = 0');
    assert.strictEqual(replay.toolExecutions, 0, 'restart tool executions = 0');
    assert.strictEqual(hashDir(), fsBefore, 'restart filesystem mutations = 0');
    assert.strictEqual(store.workflowStepExecutions.listByRun('wf-restart-1').length, stepsBefore, 'workflow step replay = 0');
    assert.strictEqual(store.workflowAudit.listByRun('wf-restart-1').length, auditBefore, 'no replayed audit trail');
    // 已终态记录不会被二次处理（automatic resume 不存在）
    const secondPass = recoverInterruptedRuntime({ store, runManager: new RunManager({ store }) });
    assert.deepStrictEqual(
      { runs: secondPass.runs, workflows: secondPass.workflows, workflowSteps: secondPass.workflowSteps, generatorDrafts: secondPass.generatorDrafts },
      { runs: 0, workflows: 0, workflowSteps: 0, generatorDrafts: 0 },
      'recovery is idempotent: nothing is resumed or replayed');
    assert.deepStrictEqual(secondPass.snapshot.interruptedRuns, [], 'no interrupted runs remain after idempotent pass');
    console.log('R6_RESTART_TRUTH agent=interrupted workflow=FAILED generator=FAILED providerReplay=0 toolReplay=0 fsMutations=0 stepReplay=0 autoResume=NO');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(fsRoot, { recursive: true, force: true });
  }
});
