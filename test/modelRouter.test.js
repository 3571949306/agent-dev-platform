'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeModelRequirements,
  normalizeModelCandidate,
  createModelCatalog,
  filterCandidates,
  scoreCandidates,
  createModelRouter,
  createRuntimeModelResolver,
  createRouteAudit
} = require('../src/models/router');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { resolveConfiguredMainModel } = require('../src/ipc/mainAgent');

const cap = (value, state = 'tested', source = 'fixture') => ({ value, state, source });
const metric = (value, state = 'declared') => ({ value, state, source: 'fixture' });

function candidate(id, patch = {}) {
  return normalizeModelCandidate({
    connectionId: patch.connectionId || `conn-${id}`,
    connectionName: patch.connectionName || `Connection ${id}`,
    provider: patch.provider || 'fixture-remote',
    protocol: patch.protocol || 'openai',
    modelId: id,
    displayName: id,
    enabled: patch.enabled !== false,
    authenticated: patch.authenticated !== false,
    capabilities: {
      text: cap(true), vision: cap(false), nativeTools: cap(false), streaming: cap(true),
      ...(patch.capabilities || {})
    },
    contextWindow: patch.contextWindow === undefined ? metric(32000) : patch.contextWindow,
    pricing: patch.pricing === undefined ? { input: metric(0.1), output: metric(0.2), currency: 'USD', source: 'fixture' } : patch.pricing,
    latency: patch.latency === undefined ? { ms: 100, source: 'fixture', measuredAt: '2026-01-01T00:00:00.000Z' } : patch.latency,
    locality: patch.locality || 'remote',
    metadata: patch.metadata || {}
  });
}

function dataset() {
  return [
    candidate('A'),
    candidate('B', { capabilities: { vision: cap(true) }, contextWindow: metric(128000), pricing: { input: metric(2), output: metric(4), currency: 'USD', source: 'fixture' }, latency: { ms: 250, source: 'fixture' } }),
    candidate('C', { connectionId: 'conn-local', provider: 'local', locality: 'local', capabilities: { vision: cap(null, 'unknown') }, contextWindow: metric(64000), pricing: { input: null, output: null }, latency: { ms: 40, source: 'fixture' } }),
    candidate('D', { capabilities: { vision: cap(true, 'inferred') }, contextWindow: null, latency: { ms: null } }),
    candidate('E', { enabled: false, capabilities: { vision: cap(true) }, contextWindow: metric(1000000), latency: { ms: 1 } }),
    candidate('F', { capabilities: { text: cap(null, 'unknown') } }),
    candidate('G', { contextWindow: metric(16000), latency: { ms: 500 } }),
    candidate('H', { authenticated: false })
  ];
}

function routerFor(candidates, decisions = null) {
  const audit = decisions ? createRouteAudit(decisions) : null;
  return createModelRouter({ catalog: { listCandidates: () => candidates.slice() }, audit });
}

test('R1 ModelRequirements is versioned, serializable and fail-closed for invalid/unknown fields', () => {
  const valid = normalizeModelRequirements({ required: { minContextWindow: 64000 }, preferences: { latency: 'low' } });
  assert.strictEqual(valid.schemaVersion, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(valid)), valid);
  const invalid = [
    { schemaVersion: 2 },
    { preferences: { latency: 'fastest' } },
    { constraints: { maxInputPrice: -1 } },
    { required: { minContextWindow: 3.5 } },
    { required: { vision: 'yes' } },
    { mystery: true }
  ];
  for (const value of invalid) assert.throws(() => normalizeModelRequirements(value), error => error.code === 'MODEL_REQUIREMENTS_INVALID');
});

test('R2 production-shaped ModelCatalog discovers 4 connections/8 models, skips missing entries and strips secrets', () => {
  const connections = [
    { id: 'r1', name: 'Remote 1', provider: 'custom', base_url: 'https://one.invalid/v1', has_key: true, enabled: 1, models: [{ id: 'A' }, { id: 'B' }, {}], Authorization: 'Bearer should-not-leak' },
    { id: 'local', name: 'Local', provider: 'local', base_url: 'http://127.0.0.1:1234/v1', has_key: false, enabled: 1, models: [{ id: 'C' }, { id: 'F' }] },
    { id: 'r2', name: 'Remote 2', provider: 'custom', base_url: 'https://two.invalid/v1', has_key: true, enabled: 1, models: [{ id: 'D' }, { id: 'G' }] },
    { id: 'off', name: 'Disabled', provider: 'custom', base_url: 'https://off.invalid/v1', has_key: true, enabled: 0, models: [{ id: 'E' }, { id: 'H' }] }
  ];
  const rows = Object.fromEntries(connections.map(connection => [connection.id, connection.models.filter(m => m.id).map(model => ({
    model_id: model.id,
    capabilities: { text: cap(true), vision: model.id === 'B' ? cap(true) : cap(false), contextWindow: metric(model.id === 'B' ? 128000 : 32000), metadata: { apiKey: 'must-not-leak' } }
  }))]));
  const catalog = createModelCatalog({ store: { connections: { list: () => connections }, models: { listByConnection: id => rows[id] } } });
  const found = catalog.listCandidates();
  assert.strictEqual(found.length, 8);
  assert.strictEqual(found.find(item => item.modelId === 'B').capabilities.vision.state, 'tested');
  assert.strictEqual(found.find(item => item.modelId === 'C').locality, 'local');
  assert.strictEqual(found.find(item => item.modelId === 'E').enabled, false);
  assert.doesNotMatch(JSON.stringify(found), /must-not-leak|Bearer|Authorization|apiKey/i);
});

test('R3 hard constraints reject unproven vision, small/unknown context, unknown price, disabled/authless candidates', () => {
  const data = dataset();
  let result = filterCandidates(normalizeModelRequirements({ required: { vision: true } }), data);
  assert.deepStrictEqual(result.eligible.map(item => item.modelId), ['B']);
  assert.ok(result.rejected.find(item => item.candidate.modelId === 'D').reasons.some(r => r.code === 'VISION_REQUIRED_NOT_PROVEN'));
  result = filterCandidates(normalizeModelRequirements({ required: { minContextWindow: 100000 } }), data);
  assert.deepStrictEqual(result.eligible.map(item => item.modelId), ['B']);
  assert.ok(result.rejected.find(item => item.candidate.modelId === 'D').reasons.some(r => r.code === 'CONTEXT_WINDOW_UNKNOWN'));
  result = filterCandidates(normalizeModelRequirements({ constraints: { maxInputPrice: 1 } }), data);
  assert.ok(result.rejected.find(item => item.candidate.modelId === 'C').reasons.some(r => r.code === 'PRICE_UNKNOWN_FOR_HARD_LIMIT'));
  assert.ok(result.rejected.find(item => item.candidate.modelId === 'E').reasons.some(r => r.code === 'CONNECTION_DISABLED'));
  assert.ok(result.rejected.find(item => item.candidate.modelId === 'H').reasons.some(r => r.code === 'CONNECTION_UNAUTHENTICATED'));
});

test('R3 explicit exact selection never falls back and all-rejected routes fail closed', () => {
  const router = routerFor(dataset());
  assert.strictEqual(router.select({ mode: 'explicit', explicit: { connectionId: 'conn-local', modelId: 'C' } }).selected.modelId, 'C');
  assert.throws(() => router.select({ mode: 'explicit', explicit: { connectionId: 'missing', modelId: 'nope' } }), error => error.code === 'MODEL_ROUTE_EXPLICIT_NOT_FOUND');
  assert.throws(() => router.select({ requirements: { constraints: { allowedModels: ['nope'] } } }), error => error.code === 'MODEL_ROUTE_NO_CANDIDATE' && error.rejectedCandidates.length === 8);
});

test('R4 deterministic metadata scoring chooses C for low latency and is stable across shuffle x100/ties', () => {
  const data = dataset();
  const requirements = normalizeModelRequirements({ preferences: { latency: 'low' } });
  assert.strictEqual(scoreCandidates(requirements, filterCandidates(requirements, data).eligible)[0].candidate.modelId, 'C');
  const expected = routerFor(data).select({ requirements: { preferences: { latency: 'low' } } }).selected.modelId;
  for (let i = 0; i < 100; i++) {
    const shuffled = data.slice(i % data.length).concat(data.slice(0, i % data.length));
    if (i % 2) shuffled.reverse();
    assert.strictEqual(routerFor(shuffled).select({ requirements: { preferences: { latency: 'low' } } }).selected.modelId, expected);
  }
  const tie = [candidate('z', { connectionId: 'b' }), candidate('a', { connectionId: 'a' })];
  assert.strictEqual(routerFor(tie).select({ requirements: { preferences: { latency: 'ignore', cost: 'ignore' } } }).selected.modelId, 'a');
  const unknownCost = scoreCandidates(normalizeModelRequirements({ preferences: { cost: 'low' } }), [data[0], data[2]]);
  assert.ok(unknownCost.find(item => item.candidate.modelId === 'C').breakdown.cost < 0, 'unknown cost is penalized, never treated as free');
});

test('R5 selection and R7 successful/failed audit are explainable and secret-free', async () => {
  const records = [];
  const decisions = {
    record(value) { records.push(JSON.parse(JSON.stringify(value))); return `decision-${records.length}`; },
    updateOutcome(id, value) { records.push({ id, outcome: value }); return true; }
  };
  const router = routerFor([candidate('B', { capabilities: { vision: cap(true) }, metadata: { password: 'leak', nested: { Cookie: 'leak' } } })], decisions);
  const selection = router.select({ requirements: { required: { vision: true } }, context: { runId: 'run-1', agentId: 'agent-1' } });
  assert.ok(selection.scoreBreakdown && selection.reasons.length);
  assert.strictEqual(selection.decisionId, 'decision-1');
  assert.doesNotMatch(JSON.stringify({ selection, records }), /leak|password|Cookie/i);
  assert.throws(() => router.select({ requirements: { constraints: { allowedModels: ['missing'] } }, context: { runId: 'run-2' } }), error => error.code === 'MODEL_ROUTE_NO_CANDIDATE' && error.decisionId === 'decision-2');
});

test('R6 unified resolver preserves inherit_parent/explicit and auto no-candidate never falls back to parent', () => {
  let routes = 0;
  const baseRouter = routerFor(dataset());
  const router = { select(input) { routes++; return baseRouter.select(input); } };
  const resolver = createRuntimeModelResolver({ router, createModelAdapter: selection => ({ name: selection.selected.modelId, decide: async () => ({ text: '{}' }) }) });
  const parent = { decide: async () => ({ text: '{}' }) };
  const inherited = resolver.resolveRuntimeModel({ mode: 'inherit_parent', parentModelAdapter: parent });
  assert.strictEqual(inherited.modelAdapter, parent);
  assert.strictEqual(routes, 0);
  const explicit = resolver.resolveRuntimeModel({ mode: 'explicit', explicit: { connectionId: 'conn-local', modelId: 'C' } });
  assert.strictEqual(explicit.selection.selected.modelId, 'C');
  assert.strictEqual(routes, 1);
  assert.throws(() => resolver.resolveRuntimeModel({ mode: 'auto', requirements: { constraints: { allowedModels: ['missing'] } }, parentModelAdapter: parent }), error => error.code === 'MODEL_ROUTE_NO_CANDIDATE');
  assert.strictEqual(routes, 2);

  const factory = createAgentFactory({ resolveRuntimeModel: resolver.resolveRuntimeModel });
  const base = { name: 'Auto', runtime: { kind: 'native' }, modelPolicy: { mode: 'auto', requirements: { preferences: { latency: 'low' } }, fallback: 'fail' }, budgets: { maxIterations: 1, maxToolCalls: 0, maxRuntimeMs: 1000 } };
  const instance = factory.createInstance(base, { rootRunId: 'root' });
  assert.strictEqual(instance.modelSelection.selected.modelId, 'C');
  assert.strictEqual(instance.adapter.modelAdapter.name, 'C');
  const routesAfterAuto = routes;
  const inheritedInstance = factory.createInstance({ ...base, name: 'Inherited', modelPolicy: { mode: 'inherit_parent' } }, { rootRunId: 'root-inherit', parentModelAdapter: parent });
  assert.strictEqual(inheritedInstance.adapter.modelAdapter, parent);
  assert.strictEqual(routes, routesAfterAuto, 'inherit_parent never invokes ModelRouter');
  const explicitInstance = factory.createInstance({ ...base, name: 'Explicit', modelPolicy: { mode: 'explicit', connectionId: 'conn-local', model: 'C' } }, { rootRunId: 'root-explicit' });
  assert.strictEqual(explicitInstance.modelSelection.selected.modelId, 'C');
  assert.strictEqual(explicitInstance.adapter.modelAdapter.name, 'C');
});

test('R8 router candidates cannot become Agent Providers and secret-bearing public data is removed', () => {
  const value = normalizeModelCandidate({ connectionId: 'x', provider: 'model-provider', modelId: 'm', authenticated: true, capabilities: {}, metadata: { Authorization: 'Bearer abcdefgh', providerObject: { secret: 'x' }, safe: 'yes' } });
  assert.strictEqual(value.metadata.safe, 'yes');
  assert.strictEqual(value.metadata.Authorization, undefined);
  assert.strictEqual(value.metadata.providerObject, undefined);
  assert.strictEqual(value.agentId, undefined);
  assert.strictEqual(value.adapterId, undefined);
});

test('R6 Main runtime shares the resolver: a manual Connection+Model remains explicit and auto is opt-in', () => {
  const calls = [];
  const adapter = { decide: async () => ({ text: '{}' }) };
  const resolveRuntimeModel = input => { calls.push(input); return { modelAdapter: adapter, selection: {} }; };
  const explicit = resolveConfiguredMainModel({
    agent: { id: 'main', api_connection_id: 'conn-manual', model: 'manual-model', routingMode: 'auto' },
    agentId: 'main', conversationId: 'conv', resolveRuntimeModel,
    buildProvider: async () => ({}), resolveModelFor: () => ({ model: 'manual-model' })
  });
  assert.strictEqual(explicit, adapter);
  assert.strictEqual(calls[0].mode, 'explicit');
  assert.deepStrictEqual(calls[0].explicit, { connectionId: 'conn-manual', modelId: 'manual-model' });
  resolveConfiguredMainModel({
    agent: { id: 'main-auto', workspace: { modelRoutingMode: 'auto', modelRequirements: { preferences: { latency: 'low' } } } },
    agentId: 'main-auto', conversationId: 'conv-auto', resolveRuntimeModel,
    buildProvider: async () => ({}), resolveModelFor: () => ({ model: null })
  });
  assert.strictEqual(calls[1].mode, 'auto');
  assert.strictEqual(calls[1].explicit, null);
});
