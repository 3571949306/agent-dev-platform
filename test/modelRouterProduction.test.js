'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub } = require('../src/agents/hub/agentHub');
const { resolveConfiguredMainModel, bindMainRouteDecision } = require('../src/ipc/mainAgent');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit, filterCandidates, normalizeModelRequirements } = require('../src/models/router');

const cap = (value, state = 'tested') => ({ value, state, source: 'production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'production-fixture' });

function addConnection(name, provider, models, options = {}) {
  return store.connections.create({
    name,
    provider,
    base_url: provider === 'local' ? 'http://127.0.0.1:12345/v1' : `https://${name.toLowerCase()}.invalid/v1`,
    api_key: options.apiKey === undefined ? (provider === 'local' ? '' : 'fixture-placeholder-key') : options.apiKey,
    headers: options.headers || {},
    models,
    enabled: options.enabled !== false
  });
}

async function waitForRun(runManager, runId) {
  for (let i = 0; i < 200; i++) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return runManager.getRun(runId);
}

async function waitForResult(adapter, runId) {
  for (let i = 0; i < 200; i++) {
    const result = await adapter.getResult(runId);
    if (result && ['completed', 'failed', 'cancelled', 'timeout'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

test('R6/R7 production Dynamic auto routes B through existing ProviderModelAdapter onto fake provider wire and completes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-model-router-'));
  store.init(root);
  try {
    const r1 = addConnection('RemoteOne', 'custom', ['A', 'B']);
    const local = addConnection('Local', 'local', ['C', 'F']);
    const r2 = addConnection('RemoteTwo', 'custom', ['D', 'G']);
    const off = addConnection('Disabled', 'custom', ['E', 'H'], { enabled: false });
    const header = addConnection('HeaderRemote', 'custom', ['I'], { apiKey: '', headers: { Authorization: 'Bearer production-header-should-not-leak' } });
    const testedNoAuth = addConnection('TestedNoAuth', 'custom', ['J'], { apiKey: '' });
    const untestedNoAuth = addConnection('UntestedNoAuth', 'custom', ['K'], { apiKey: '' });
    store.connections.setTestResult(testedNoAuth.id, { ok: true, latency: 75 });
    const put = (conn, id, caps) => store.models.upsert(conn.id, id, caps);
    put(r1, 'A', { text: cap(true), vision: cap(false), contextWindow: metric(32000), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 100 });
    put(r1, 'B', { text: cap(true), vision: cap(true), contextWindow: metric(128000), pricing: { input: metric(2), output: metric(4), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 250 });
    put(local, 'C', { text: cap(true), vision: cap(null, 'unknown'), contextWindow: metric(64000), pricing: {}, latencyMs: 40 });
    put(local, 'F', { text: cap(null, 'unknown'), vision: cap(false), contextWindow: metric(64000) });
    put(r2, 'D', { text: cap(true), vision: cap(true, 'inferred'), contextWindow: cap(null, 'unknown'), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens' } });
    put(r2, 'G', { text: cap(true), vision: cap(false), contextWindow: metric(16000) });
    put(off, 'E', { text: cap(true), vision: cap(true), contextWindow: metric(1000000), latencyMs: 1 });
    put(off, 'H', { text: cap(true), vision: cap(false), contextWindow: metric(32000) });
    put(header, 'I', { text: cap(true), vision: cap(false), contextWindow: metric(32000) });
    put(testedNoAuth, 'J', { text: cap(true), vision: cap(false), contextWindow: metric(32000) });
    put(untestedNoAuth, 'K', { text: cap(true), vision: cap(false), contextWindow: metric(32000) });

    const catalog = createModelCatalog({ store });
    const catalogCandidates = catalog.listCandidates();
    assert.strictEqual(catalogCandidates.length, 11);
    const usability = filterCandidates(normalizeModelRequirements({}), catalogCandidates);
    assert.ok(usability.eligible.some(item => item.modelId === 'I'), 'custom-header remote remains eligible');
    assert.ok(usability.eligible.some(item => item.modelId === 'J'), 'tested no-auth remote remains eligible');
    assert.ok(usability.eligible.some(item => item.modelId === 'K'), 'untested no-auth remote is not rejected for missing key');
    assert.strictEqual(catalogCandidates.find(item => item.modelId === 'I').authEvidence.mode, 'custom_headers');
    assert.doesNotMatch(JSON.stringify(catalogCandidates), /production-header-should-not-leak|Authorization|Bearer/i);
    const audit = createRouteAudit(store.modelRouteDecisions);
    const router = createModelRouter({ catalog, audit });
    const wireModels = [];
    const fakeProvider = {
      async streamResponse(input) {
        wireModels.push(input.model);
        const text = JSON.stringify({ action: { type: 'complete', args: { summary: 'routed dynamic child complete' } } });
        input.onChunk(text);
        return { content: text };
      }
    };
    const resolver = createRuntimeModelResolver({
      router,
      audit,
      createModelAdapter(selection) {
        const agent = { id: 'production-routed-child', api_connection_id: selection.selected.connectionId, model: selection.selected.modelId, max_tokens: 256 };
        return createProviderModelAdapter({
          buildProvider: async () => fakeProvider,
          agent,
          resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id })
        });
      }
    });
    const factory = createAgentFactory({ resolveRuntimeModel: resolver.resolveRuntimeModel, bindRouteDecisionToRun: audit.bindRunIdentity });
    const instance = factory.createInstance({
      id: 'production-auto-child', name: 'Production auto child', runtime: { kind: 'native' },
      toolPolicy: { allow: [], deny: [] }, permissionPolicy: { readOnly: true, allow: [], deny: [] },
      modelPolicy: { mode: 'auto', requirements: { required: { vision: true } }, fallback: 'fail' },
      budgets: { maxIterations: 2, maxToolCalls: 0, maxRuntimeMs: 3000 }, lifetime: 'run'
    }, { rootRunId: 'production-route-root', parentRunId: 'production-parent-run', conversationId: 'dynamic-conversation-X' });
    assert.strictEqual(instance.modelSelection.selected.modelId, 'B');

    const runManager = new RunManager();
    const registry = createAgentRegistry();
    const lifecycle = createLifecycleManager();
    const hub = createAgentHub({
      registry,
      router: createAgentRouter({ registry }),
      healthManager: createHealthManager({ registry }),
      lifecycleManager: lifecycle,
      runBridge: createRunBridge({ runManager, lifecycleManager: lifecycle }),
      contextFactory: createExecutionContextFactory({ runManager, store })
    });
    factory.registerInstance(instance.instanceId, hub);
    const childStart = await hub.start(instance.adapterId, {
      goal: 'Complete through the routed model', projectRoot: root, projectId: 'router-project',
      conversationId: 'dynamic-conversation-X', parentRunId: 'production-parent-run'
    });
    assert.ok(childStart.runId);
    const childResult = await waitForResult(instance.adapter, childStart.runId);
    assert.ok(childResult);
    assert.strictEqual(childResult.status, 'completed');
    assert.deepStrictEqual(wireModels, ['B']);
    assert.strictEqual(instance.modelSelection.selected.modelId, wireModels[0]);

    let decisions = store.modelRouteDecisions.list(20);
    const dynamicDecision = decisions.find(item => item.conversation_id === 'dynamic-conversation-X');
    assert.ok(dynamicDecision);
    assert.strictEqual(dynamicDecision.run_id, childStart.runId);
    assert.strictEqual(dynamicDecision.parent_run_id, 'production-parent-run');
    assert.strictEqual(dynamicDecision.root_run_id, 'production-route-root');
    assert.strictEqual(dynamicDecision.status, 'completed');
    console.log(`DYNAMIC_ROUTE_IDENTITY root=production-route-root parent=production-parent-run child=${childStart.runId} decision=${dynamicDecision.run_id}`);

    const mainResolution = resolveConfiguredMainModel({
      agent: { id: 'production-main-auto', workspace: { modelRoutingMode: 'auto', modelRequirements: { required: { vision: true } } } },
      agentId: 'production-main-auto', conversationId: 'conversation-X', resolveRuntimeModel: resolver.resolveRuntimeModel,
      buildProvider: async () => fakeProvider, resolveModelFor: configured => ({ model: configured.model })
    });
    const mainRunManager = new RunManager();
    const mainStarted = runMainAgent({
      conversationId: 'conversation-X', agentId: 'production-main-auto', goal: 'Complete main routed run',
      projectRoot: root, projectId: 'router-project', model: mainResolution.modelAdapter,
      getTool: () => null, store, emit: () => {}, runManager: mainRunManager, timeoutMs: 3000,
      onRunCreated: ({ runId }) => bindMainRouteDecision({
        selection: mainResolution.selection, bindRouteDecisionToRun: audit.bindRunIdentity,
        runId, conversationId: 'conversation-X'
      })
    });
    const mainResult = await waitForRun(mainRunManager, mainStarted.runId);
    assert.strictEqual(mainResult.status, 'completed');
    decisions = store.modelRouteDecisions.list(20);
    const mainDecision = decisions.find(item => item.conversation_id === 'conversation-X');
    assert.ok(mainDecision);
    assert.strictEqual(mainDecision.run_id, mainStarted.runId);
    assert.notStrictEqual(mainDecision.run_id, mainDecision.conversation_id);
    console.log(`MAIN_ROUTE_IDENTITY conversation=conversation-X actual=${mainStarted.runId} decision=${mainDecision.run_id}`);
    assert.deepStrictEqual(wireModels, ['B', 'B']);
    assert.doesNotMatch(JSON.stringify(decisions), /fixture-placeholder-key|production-header-should-not-leak|Authorization|Bearer|Cookie/i);

    assert.throws(() => factory.createInstance({
      name: 'Impossible auto child', runtime: { kind: 'native' },
      modelPolicy: { mode: 'auto', requirements: { constraints: { allowedModels: ['missing'] } }, fallback: 'fail' },
      budgets: { maxIterations: 1, maxToolCalls: 0, maxRuntimeMs: 1000 }
    }, { rootRunId: 'no-candidate-root', parentModelAdapter: { decide: async () => ({ text: '{}' }) } }), error => error.code === 'MODEL_ROUTE_NO_CANDIDATE');
    const failedDecision = store.modelRouteDecisions.list(20).find(item => item.status === 'route_failed' && item.error_code === 'MODEL_ROUTE_NO_CANDIDATE');
    assert.ok(failedDecision);
    assert.strictEqual(failedDecision.run_id, null);
    await factory.disposeInstance(instance.instanceId);
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
