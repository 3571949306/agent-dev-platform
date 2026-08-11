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
const { createSkillRegistry, createSkillResolver, BUILTIN_SKILLS } = require('../src/skills');
const { createHookEngine } = require('../src/hooks');
const { getBuiltin, listBuiltinDefs } = require('../src/tools/registry');

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
