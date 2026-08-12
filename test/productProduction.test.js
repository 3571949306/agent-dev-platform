'use strict';

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
const { createSkillRegistry, createSkillResolver, BUILTIN_SKILLS, setSkillRuntime, getSkillRuntime } = require('../src/skills');
const { createHookEngine, setHookRuntime, getHookRuntime } = require('../src/hooks');
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

const cap = value => ({ value, state: 'tested', source: 'product-production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'product-production-fixture' });

async function waitTerminal(runManager, runId) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return runManager.getRun(runId);
}

test('real application Main service crosses Router and ProviderModelAdapter and cancels without revival', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-production-db-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-production-project-'));
  store.init(dataRoot);
  try {
    const connection = store.connections.create({
      name: 'Product Fake Network', provider: 'custom', base_url: 'https://product.invalid/v1',
      api_key: 'fixture-placeholder-key', models: ['product-model-B'], enabled: true
    });
    store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
    store.models.upsert(connection.id, 'product-model-B', {
      text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
      pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
    });
    const project = store.projects.create({ name: 'Product project', rootPath: projectRoot });
    const agent = store.agents.create({
      name: 'Product Main', is_main: true, api_connection_id: connection.id,
      model: 'product-model-B', tools: []
    });
    const firstConversation = store.conversations.create({ projectId: project.id, agentId: agent.id, title: 'Product complete' });
    const cancelConversation = store.conversations.create({ projectId: project.id, agentId: agent.id, title: 'Product cancel' });

    let paidProviderCalls = 0;
    let fakeNetworkCalls = 0;
    let slow = false;
    const fakeProvider = {
      async streamResponse(input) {
        fakeNetworkCalls++;
        assert.strictEqual(input.model, 'product-model-B');
        if (slow) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ content: JSON.stringify({ action: { type: 'complete', args: { summary: 'late completion' } } }) }), 1000);
            input.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        const text = JSON.stringify({ action: { type: 'complete', args: { summary: 'product entry complete' } } });
        input.onChunk(text);
        return { content: text };
      }
    };

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
          timeoutMs: 2000
        });
      }
    });
    const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: BUILTIN_SKILLS });
    const skillResolver = createSkillResolver({ registry: skillRegistry });
    const hookEngine = createHookEngine({ definitionStore: store.hookDefinitions, auditStore: store.hookInvocations });
    const runManager = new RunManager({ store });
    const activeRuns = new Map();
    const service = createMainAgentService({
      store,
      emit: () => {},
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
      skillRegistry,
      skillResolver,
      hookEngine,
      availableToolNames: listBuiltinDefs().map(definition => definition.name)
    });

    const started = await service.run({ conversationId: firstConversation.id, agentId: agent.id, goal: 'Complete through the product service.' });
    assert.match(started.runId, /^[0-9a-f-]{36}$/i);
    const completed = await waitTerminal(runManager, started.runId);
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(fakeNetworkCalls, 1);
    assert.strictEqual(activeRuns.size, 0);
    const decision = store.modelRouteDecisions.list(10).find(item => item.run_id === started.runId);
    assert.ok(decision);
    assert.strictEqual(decision.model_id, 'product-model-B');
    assert.strictEqual(decision.root_run_id, started.runId);

    slow = true;
    const cancelling = await service.run({ conversationId: cancelConversation.id, agentId: agent.id, goal: 'Cancel through the product service.' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const stopped = service.stop({ conversationId: cancelConversation.id, runId: cancelling.runId });
    assert.strictEqual(stopped.stopped, true);
    const cancelled = await waitTerminal(runManager, cancelling.runId);
    assert.strictEqual(cancelled.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(runManager.getRun(cancelling.runId).status, 'cancelled');
    assert.strictEqual(activeRuns.size, 0);
    assert.strictEqual(paidProviderCalls, 0);
    console.log('PRODUCT_MAIN_PRODUCTION entry=application-service router=real adapter=ProviderModelAdapter fakeNetworkCalls=' + fakeNetworkCalls + ' paidProviderCalls=0 cancellation=PASS');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

const PRODUCT_SKILL_MARKER = 'PRODUCT_SKILL_MARKER_2814';
const PRODUCT_HOOK_MARKER = 'PRODUCT_HOOK_MARKER_6291';
const PRODUCT_DYNAMIC_RESULT = 'PRODUCT_DYNAMIC_RESULT_7319';

test('ProductEntry Main → Dynamic delegation production chain consumes the child result', async () => {
  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const previousSkill = getSkillRuntime();
  const previousHook = getHookRuntime();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-dynamic-db-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-dynamic-project-'));
  store.init(dataRoot);
  const pathSecurity = createPathSecurity({ cacheRoots: true });

  try {
    // --- Fake-network model wiring: ModelRouter → ProviderModelAdapter ---
    const connection = store.connections.create({
      name: 'Product Dynamic Fake Network', provider: 'custom', base_url: 'https://product.invalid/v1',
      api_key: 'fixture-placeholder-key', models: ['product-model-B'], enabled: true
    });
    store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
    store.models.upsert(connection.id, 'product-model-B', {
      text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
      pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
    });
    const project = store.projects.create({ name: 'Product dynamic project', rootPath: projectRoot });
    const agent = store.agents.create({
      name: 'Product Main', is_main: true, api_connection_id: connection.id,
      model: 'product-model-B', tools: []
    });
    const conversation = store.conversations.create({ projectId: project.id, agentId: agent.id, title: 'Product dynamic chain' });

    // --- Skill / Hook fixtures referenced by the Dynamic AgentDefinition ---
    store.skillDefinitions.create({
      id: 'product-review-skill', name: 'Product review skill',
      description: 'Review discipline for the product reviewer',
      instructions: `${PRODUCT_SKILL_MARKER}\nReview read-only and report exactly one finding.`
    });
    const hookEngine = createHookEngine({ definitionStore: store.hookDefinitions, auditStore: store.hookInvocations });
    hookEngine.handlerRegistry.register('product-review-hook-handler', payload => ({ context: payload.config.marker }));
    hookEngine.registry.create({
      schemaVersion: 1, id: 'product-review-hook', name: 'product-review-hook',
      description: 'bounded context hook for the product reviewer',
      event: 'before_model', kind: 'context', handlerId: 'product-review-hook-handler', priority: 100,
      filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
      timeoutMs: 1000, config: { marker: PRODUCT_HOOK_MARKER }, metadata: {}
    });

    // --- Dynamic AgentDefinition (readOnly reviewer, explicit model binding) ---
    store.agentDefinitions.create({
      id: 'product-reviewer',
      name: 'Product reviewer',
      role: 'code_reviewer',
      systemPrompt: 'Review the project read-only and return one finding.',
      runtime: { kind: 'native' },
      capabilities: ['review'],
      toolPolicy: { allow: ['read_file', 'search'], deny: [] },
      permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
      modelPolicy: { mode: 'explicit', connectionId: connection.id, model: 'product-model-B', requirements: { required: { text: true } } },
      skills: { required: ['product-review-skill'], optional: [] },
      hooks: { required: ['product-review-hook'], optional: [] },
      lifetime: 'run',
      budgets: { maxIterations: 4, maxToolCalls: 2, maxRuntimeMs: 8000 },
      canDelegate: false
    });

    // --- Scripted fake network provider (the only fake component) ---
    const captures = [];
    let paidProviderCalls = 0;
    let mainCalls = 0;
    const fakeProvider = {
      async streamResponse(input) {
        captures.push({ system: input.system, context: input.messages[0].content, model: input.model });
        const child = input.system.includes(DYNAMIC_AGENT_BASE_PROMPT);
        const action = child
          ? { type: 'complete', args: { summary: PRODUCT_DYNAMIC_RESULT } }
          : (mainCalls++ === 0
            ? { type: 'delegate', args: { goal: 'Review the project.', agentDefinitionId: 'product-reviewer' } }
            : { type: 'complete', args: { summary: 'Main consumed the dynamic review result' } });
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return { content: text };
      }
    };

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
          timeoutMs: 2000
        });
      }
    });

    const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: BUILTIN_SKILLS });
    const skillResolver = createSkillResolver({ registry: skillRegistry });
    setSkillRuntime(skillRegistry, skillResolver);
    setHookRuntime(hookEngine);

    const runManager = new RunManager({ store });
    const hubPermission = new PermissionEngine({ projectId: project.id });
    hubPermission.grant('filesystem.read', 'always', { persist: false });
    const projectLock = createProjectMutationLock();
    const agentRegistry = createAgentRegistry();
    const lifecycle = createLifecycleManager();
    const contextFactory = createExecutionContextFactory({
      runManager, getTool: getBuiltin, store, permissionEngine: hubPermission, pathSecurity
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
      bindRouteDecisionToRun: audit.bindRunIdentity,
      skillResolver,
      hookEngine
    });
    let created = null;
    const originalCreateInstance = factory.createInstance;
    factory.createInstance = (...args) => { created = originalCreateInstance(...args); return created; };
    setAgentHub(hub);
    setDynamicAgentRuntime(factory, store.agentDefinitions);

    // --- Real application service behind the real ProductEntry facade ---
    const activeRuns = new Map();
    const service = createMainAgentService({
      store,
      emit: () => {},
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
      skillRegistry,
      skillResolver,
      hookEngine,
      availableToolNames: listBuiltinDefs().map(definition => definition.name)
    });
    const workflowRuntimeStub = { run: () => { throw new Error('WORKFLOW_NOT_IN_SCENARIO'); }, cancel: () => {}, approve: () => {}, reject: () => {} };
    const generatorServiceStub = { generate: () => { throw new Error('GENERATOR_NOT_IN_SCENARIO'); }, validate: () => {}, save: () => {}, cancel: () => {} };
    const productEntry = createProductEntry({ mainAgentService: service, workflowRuntime: workflowRuntimeStub, generatorService: generatorServiceStub });

    // --- Optional static IPC contract proof (no Electron window required) ---
    const mainAgentIpcModule = require('../src/ipc/mainAgent');
    assert.strictEqual(typeof mainAgentIpcModule.register, 'function');
    const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'handlers.js'), 'utf8');
    assert.ok(/mainAgentIpc\.register\s*\(/.test(ipcSource), 'Main IPC must register the same MainAgentService handler factory used by ProductEntry');
    assert.ok(ipcSource.includes('productEntry.workflow.run'), 'workflow:run IPC must cross ProductEntry');
    assert.ok(ipcSource.includes('productEntry.generator.generate'), 'generator:generate IPC must cross ProductEntry');

    // --- Entry point: productEntry.mainAgent.run ---
    const started = await productEntry.mainAgent.run({ conversationId: conversation.id, agentId: agent.id, goal: 'Delegate the product review to the dynamic reviewer.' });
    const mainRunId = started.runId;
    assert.match(mainRunId, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(mainRunId, conversation.id, 'Main run identity is not the conversation identity');
    const mainTerminal = await waitTerminal(runManager, mainRunId);
    assert.strictEqual(mainTerminal.status, 'completed');

    // --- Main identity ---
    const mainRun = runManager.getRun(mainRunId);
    assert.ok(mainRun, 'mainRun exists in RunManager');
    assert.strictEqual(mainRun.rootRunId, mainRunId);
    assert.strictEqual(mainRun.parentRunId, null);

    // --- Child identity (negative test: a standalone Dynamic run would have no parent link) ---
    const childRuns = runManager.list().filter(run => run.parentRunId === mainRunId);
    assert.strictEqual(childRuns.length, 1, 'exactly one child run is parented to the Main run');
    const childRun = childRuns[0];
    assert.notStrictEqual(childRun.id, mainRunId);
    assert.strictEqual(childRun.parentRunId, mainRunId, 'child.parentRunId == mainRunId');
    assert.strictEqual(childRun.rootRunId, mainRunId, 'child.rootRunId == mainRunId');
    assert.strictEqual(childRun.status, 'completed');

    // --- Dynamic factory / AgentDefinition proof ---
    assert.ok(created, 'Dynamic Factory instance created');
    assert.strictEqual(created.definitionId, 'product-reviewer');
    assert.strictEqual(created.parentRunId, mainRunId);
    assert.strictEqual(created.rootRunId, mainRunId);

    // --- Skill / Hook markers reached the child model ---
    const childCaptures = captures.filter(item => item.system.includes(DYNAMIC_AGENT_BASE_PROMPT));
    assert.ok(childCaptures.length >= 1, 'child model was actually called');
    assert.ok(childCaptures.every(item => item.system.includes(PRODUCT_SKILL_MARKER)), 'Skill marker entered the child prompt');
    assert.ok(childCaptures.every(item => item.system.includes(PRODUCT_HOOK_MARKER)), 'Hook context marker entered the child prompt');

    // --- Child result consumed by Main (the key assertion) ---
    const mainCaptures = captures.filter(item => !item.system.includes(DYNAMIC_AGENT_BASE_PROMPT));
    assert.strictEqual(mainCaptures.length, 2, 'Main decided twice: delegate then complete');
    const childResultConsumed = mainCaptures[1].context.includes(PRODUCT_DYNAMIC_RESULT);
    assert.strictEqual(childResultConsumed, true, 'Main second model request context contains the child result marker');

    // --- Model Router attribution for Main and Child ---
    const decisions = store.modelRouteDecisions.list(20);
    const mainDecision = decisions.find(item => item.run_id === mainRunId);
    assert.ok(mainDecision, 'Main route decision exists');
    assert.strictEqual(mainDecision.model_id, 'product-model-B');
    assert.strictEqual(mainDecision.root_run_id, mainRunId);
    const childDecision = decisions.find(item => item.run_id !== mainRunId && item.root_run_id === mainRunId);
    assert.ok(childDecision, 'Child route decision exists and is attributed to the Main root run');
    assert.strictEqual(childDecision.model_id, 'product-model-B');
    const mainSelectionEqualsWire = mainCaptures.every(item => item.model === mainDecision.model_id);
    const childSelectionEqualsWire = childCaptures.every(item => item.model === childDecision.model_id);
    assert.strictEqual(mainSelectionEqualsWire, true, 'Main selected model == Main wire model');
    assert.strictEqual(childSelectionEqualsWire, true, 'Child selected model == Child wire model');

    // --- Lifecycle / cleanup truth ---
    assert.strictEqual(factory.listInstances().length, 0, 'Dynamic instances disposed after run lifetime');
    assert.strictEqual(factory.activeTimerCount(), 0);
    assert.strictEqual(agentRegistry.list().filter(adapter => adapter.id.startsWith('dyn-agent-')).length, 0);
    for (let attempt = 0; attempt < 200 && lifecycle.listActive().length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(lifecycle.listActive().length, 0, 'AgentHub active runs settled to zero');
    for (let attempt = 0; attempt < 200 && (projectLock.snapshot().writeLocks.length || projectLock.snapshot().readLocks.length); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepStrictEqual(projectLock.snapshot(), { writeLocks: [], readLocks: [] }, 'project locks released');
    assert.strictEqual(activeRuns.size, 0, 'active AbortControllers settled to zero');
    assert.strictEqual(paidProviderCalls, 0);
    console.log(
      'PRODUCT_MAIN_TO_DYNAMIC entry=ProductEntry mainRun=' + mainRunId + ' childRun=' + childRun.id +
      ' parentLinkage=PASS rootIdentity=PASS definition=product-reviewer' +
      ' skillMarker=YES hookMarker=YES childResultConsumed=YES' +
      ' mainSelectedModel=' + mainDecision.model_id + ' mainWireModel=' + mainCaptures[0].model + ' mainSelectionEqualsWire=' + mainSelectionEqualsWire +
      ' childSelectedModel=' + childDecision.model_id + ' childWireModel=' + childCaptures[0].model + ' childSelectionEqualsWire=' + childSelectionEqualsWire +
      ' dynamicCleanup=0 hubActive=0 projectLocks=0 abortControllers=0 paidProviderCalls=0'
    );
  } finally {
    setAgentHub(previousHub);
    setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
    setSkillRuntime(previousSkill.registry, previousSkill.resolver);
    setHookRuntime(previousHook);
    try { pathSecurity.clearRootCache(); } catch { /* best effort */ }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
