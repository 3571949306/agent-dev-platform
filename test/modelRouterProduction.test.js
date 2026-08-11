'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');

const cap = (value, state = 'tested') => ({ value, state, source: 'production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'production-fixture' });

function addConnection(name, provider, models, options = {}) {
  return store.connections.create({
    name,
    provider,
    base_url: provider === 'local' ? 'http://127.0.0.1:12345/v1' : `https://${name.toLowerCase()}.invalid/v1`,
    api_key: provider === 'local' ? '' : 'fixture-placeholder-key',
    models,
    enabled: options.enabled !== false
  });
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
    const put = (conn, id, caps) => store.models.upsert(conn.id, id, caps);
    put(r1, 'A', { text: cap(true), vision: cap(false), contextWindow: metric(32000), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', source: 'fixture' }, latencyMs: 100 });
    put(r1, 'B', { text: cap(true), vision: cap(true), contextWindow: metric(128000), pricing: { input: metric(2), output: metric(4), currency: 'USD', source: 'fixture' }, latencyMs: 250 });
    put(local, 'C', { text: cap(true), vision: cap(null, 'unknown'), contextWindow: metric(64000), pricing: {}, latencyMs: 40 });
    put(local, 'F', { text: cap(null, 'unknown'), vision: cap(false), contextWindow: metric(64000) });
    put(r2, 'D', { text: cap(true), vision: cap(true, 'inferred'), contextWindow: cap(null, 'unknown'), pricing: { input: metric(0.1), output: metric(0.2) } });
    put(r2, 'G', { text: cap(true), vision: cap(false), contextWindow: metric(16000) });
    put(off, 'E', { text: cap(true), vision: cap(true), contextWindow: metric(1000000), latencyMs: 1 });
    put(off, 'H', { text: cap(true), vision: cap(false), contextWindow: metric(32000) });

    const catalog = createModelCatalog({ store });
    assert.strictEqual(catalog.listCandidates().length, 8);
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
    const factory = createAgentFactory({ resolveRuntimeModel: resolver.resolveRuntimeModel });
    const instance = factory.createInstance({
      id: 'production-auto-child', name: 'Production auto child', runtime: { kind: 'native' },
      toolPolicy: { allow: [], deny: [] }, permissionPolicy: { readOnly: true, allow: [], deny: [] },
      modelPolicy: { mode: 'auto', requirements: { required: { vision: true } }, fallback: 'fail' },
      budgets: { maxIterations: 2, maxToolCalls: 0, maxRuntimeMs: 3000 }, lifetime: 'run'
    }, { rootRunId: 'production-route-root' });
    assert.strictEqual(instance.modelSelection.selected.modelId, 'B');

    const runManager = new RunManager();
    await instance.adapter.startTask({ goal: 'Complete through the routed model', projectRoot: root, projectId: 'router-project' }, {
      runId: 'production-route-hub-run', runManager, projectRoot: root, projectId: 'router-project', emit: () => {},
      finishRun: () => {}
    });
    const childResult = await waitForResult(instance.adapter, 'production-route-hub-run');
    assert.ok(childResult);
    assert.strictEqual(childResult.status, 'completed');
    assert.deepStrictEqual(wireModels, ['B']);
    assert.strictEqual(instance.modelSelection.selected.modelId, wireModels[0]);

    const decisions = store.modelRouteDecisions.list(10);
    const decision = decisions.find(item => item.model_id === 'B');
    assert.ok(decision);
    assert.strictEqual(decision.status, 'completed');
    assert.strictEqual(decision.input_tokens, null);
    assert.strictEqual(decision.output_tokens, null);
    assert.doesNotMatch(JSON.stringify(decisions), /fixture-placeholder-key|Authorization|Bearer|Cookie/i);

    assert.throws(() => factory.createInstance({
      name: 'Impossible auto child', runtime: { kind: 'native' },
      modelPolicy: { mode: 'auto', requirements: { constraints: { allowedModels: ['missing'] } }, fallback: 'fail' },
      budgets: { maxIterations: 1, maxToolCalls: 0, maxRuntimeMs: 1000 }
    }, { rootRunId: 'no-candidate-root', parentModelAdapter: { decide: async () => ({ text: '{}' }) } }), error => error.code === 'MODEL_ROUTE_NO_CANDIDATE');
    assert.ok(store.modelRouteDecisions.list(10).some(item => item.status === 'route_failed' && item.error_code === 'MODEL_ROUTE_NO_CANDIDATE'));
    await factory.disposeInstance(instance.instanceId);
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
