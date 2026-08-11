'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeGeneratorRequest,
  strictParseCandidate,
  canonicalJson,
  buildGenerationPrompt,
  buildRepairPrompt,
  createGeneratorCapabilityContext,
  createGeneratorArtifactAdapterRegistry,
  createGeneratorAudit,
  createGeneratorService
} = require('../src/generator');
const { normalizeAgentDefinition } = require('../src/agents/dynamic/agentDefinition');
const { normalizeSkillDefinition } = require('../src/skills/skillDefinition');
const { normalizeHookDefinition } = require('../src/hooks/hookDefinition');
const { normalizeWorkflowDefinition } = require('../src/workflows/workflowDefinition');

function registry(normalize) {
  const rows = new Map();
  return {
    create(value) { const item = { ...normalize(value), enabled: true }; rows.set(item.id, item); return structuredClone(item); },
    get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    list() { return [...rows.values()].map(value => structuredClone(value)); },
    remove(id) { return rows.delete(id); },
    disable(id) { const item = rows.get(id); if (!item) return null; item.enabled = false; return structuredClone(item); },
    enable(id) { const item = rows.get(id); if (!item) return null; item.enabled = true; return structuredClone(item); }
  };
}

function skill(id, tools = []) {
  return {
    schemaVersion: 1, id, name: id, instructions: 'Use available read-only capabilities.',
    toolRequirements: { required: tools, optional: [], denied: [] },
    permissionRequirements: { required: [] }, modelRequirements: {},
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    requiresSkills: [], metadata: {}
  };
}

function hook(id, handlerId = 'readonly-policy') {
  return {
    schemaVersion: 1, id, name: id, event: 'before_tool', kind: 'guard', handlerId,
    priority: 100, filters: {}, timeoutMs: 1000, config: {}, metadata: {}
  };
}

function workflow(id, steps) {
  return { schemaVersion: 1, id, name: id, inputs: {}, steps, outputs: {}, limits: { maxSteps: 32, maxRuntimeMs: 60000 }, metadata: {} };
}

function harness(outputs = [], options = {}) {
  const agentDefinitions = registry(normalizeAgentDefinition);
  const skills = registry(normalizeSkillDefinition);
  const hooks = registry(normalizeHookDefinition);
  const workflows = registry(normalizeWorkflowDefinition);
  skills.create(skill('security-review', ['read_file']));
  hooks.create(hook('readonly-hook'));
  const handlers = new Set(['readonly-policy']);
  const hookEngine = {
    registry: hooks,
    handlerRegistry: { list: () => [...handlers], has: id => handlers.has(id) }
  };
  const tools = ['write_file', 'search_symbols', 'read_file', 'search_text', 'search_files'];
  const modelCatalog = { listCandidates: () => [{
    connectionId: 'generator-connection', modelId: 'generator-model-B',
    capabilities: { text: { value: true }, vision: { value: false } }
  }] };
  const capabilityCatalog = createGeneratorCapabilityContext({
    listTools: () => tools.slice(), getTool: name => ({ permission: name === 'write_file' ? 'filesystem.write' : 'filesystem.read' }),
    skillRegistry: skills, hookEngine, agentDefinitionStore: agentDefinitions,
    agentRegistry: { getManifests: () => [{ id: 'native-main', displayName: 'Main Agent', capabilities: { coding: true } }] },
    modelCatalog
  });
  const adapterRegistry = createGeneratorArtifactAdapterRegistry({
    agentDefinitionStore: agentDefinitions, skillRegistry: skills,
    hookRegistry: hooks, workflowRegistry: workflows
  });
  const calls = { provider: 0, route: 0, prompts: [] };
  let index = 0;
  const resolveRuntimeModel = request => {
    calls.route++;
    if (options.routeError) throw options.routeError;
    return {
      selection: { decisionId: 'route-decision', selected: { connectionId: 'generator-connection', modelId: 'generator-model-B' } },
      modelAdapter: {
        async decide(input) {
          calls.provider++;
          calls.prompts.push(input);
          const output = outputs[Math.min(index++, outputs.length - 1)];
          return typeof output === 'function' ? output(input) : { text: output };
        }
      }
    };
  };
  const audit = createGeneratorAudit();
  const service = createGeneratorService({
    adapterRegistry, capabilityCatalog, resolveRuntimeModel, audit,
    requestTimeoutMs: options.requestTimeoutMs || 1000,
    totalTimeoutMs: options.totalTimeoutMs || 3000
  });
  return { service, calls, audit, capabilityCatalog, adapterRegistry, agentDefinitions, skills, hooks, workflows, handlers, tools };
}

function request(artifactType, intent = 'Create a safe definition', extra = {}) {
  return { schemaVersion: 1, artifactType, intent, mode: 'auto', explicitModel: null, context: { projectId: null, projectSummary: null }, ...extra };
}

test('R1 GeneratorRequest is strict, bounded, secret-gated, and carries no authority', () => {
  assert.deepStrictEqual(normalizeGeneratorRequest(request('agent')).mode, 'auto');
  assert.throws(() => normalizeGeneratorRequest({ ...request('agent'), grantPermissions: true }), error => error.code === 'GENERATOR_REQUEST_INVALID');
  assert.throws(() => normalizeGeneratorRequest(request('skill', 'Use api key sk-REAL_SENTINEL_123456')), error => error.code === 'GENERATOR_INPUT_SECRET_DETECTED');
  assert.throws(() => normalizeGeneratorRequest(request('skill', 'x'.repeat(12001))), error => error.code === 'GENERATOR_INPUT_TOO_LARGE');
  assert.throws(() => normalizeGeneratorRequest({ ...request('agent'), mode: 'explicit_model', explicitModel: null }), error => error.code === 'GENERATOR_REQUEST_INVALID');
});

test('R5 strict parser accepts exactly one JSON object and prompt declares configuration-only rules', () => {
  assert.deepStrictEqual(strictParseCandidate('  {"id":"x"}  '), { id: 'x' });
  for (const invalid of ['```json\n{}\n```', 'text {}', '{}{}', '[]', 'null']) {
    assert.throws(() => strictParseCandidate(invalid), error => error.code === 'GENERATOR_OUTPUT_INVALID_JSON');
  }
  const h = harness(['{}']);
  const prompt = buildGenerationPrompt({ request: request('agent'), contract: { required: ['id'] }, capabilityContext: h.capabilityCatalog.build() });
  assert.match(prompt.system, /configuration only/);
  assert.match(prompt.system, /do not execute tasks/);
  assert.match(prompt.system, /exactly one JSON object/);
  assert.doesNotMatch(prompt.context, /api[_-]?key|Authorization|Cookie/i);
});

test('R3 capability context and repair protocol are canonical under shuffled source order', () => {
  const h = harness(['{}']);
  const expected = canonicalJson(h.capabilityCatalog.build());
  for (let i = 0; i < 100; i++) {
    h.tools.reverse();
    assert.strictEqual(canonicalJson(h.capabilityCatalog.build()), expected);
  }
  const args = { previousOutput: '{bad}', errors: [{ code: 'GENERATOR_OUTPUT_INVALID_JSON', message: 'invalid' }], capabilityContext: h.capabilityCatalog.build(), contract: { required: ['id'] } };
  assert.deepStrictEqual(buildRepairPrompt(args), buildRepairPrompt(args));
});

test('R2 adapters reuse real validators for all four definitions and reject invented references', () => {
  const h = harness(['{}']);
  const context = h.capabilityCatalog.build();
  const agent = h.adapterRegistry.get('agent').validate({ schemaVersion: 1, id: 'reviewer', name: 'Reviewer', skills: { required: ['security-review'] }, toolPolicy: { allow: ['read_file'], deny: [] } });
  h.adapterRegistry.get('agent').validateReferences(agent, context);
  const s = h.adapterRegistry.get('skill').validate(skill('review-skill', ['read_file']));
  h.adapterRegistry.get('skill').validateReferences(s, context);
  const hk = h.adapterRegistry.get('hook').validate(hook('generated-hook'));
  h.adapterRegistry.get('hook').validateReferences(hk, context);
  const wf = h.adapterRegistry.get('workflow').validate(workflow('generated-flow', [{ id: 'main', type: 'agent', config: { goal: 'Review', target: { mode: 'main' }, skillIds: ['security-review'] } }, { id: 'approve', type: 'approval', dependsOn: ['main'], config: { message: 'Approve?' } }]));
  h.adapterRegistry.get('workflow').validateReferences(wf, context);
  assert.throws(() => h.adapterRegistry.get('agent').validateReferences({ ...agent, toolPolicy: { allow: ['god_mode_tool'], deny: [] } }, context), error => error.code === 'GENERATOR_REFERENCE_UNAVAILABLE');
  assert.throws(() => h.adapterRegistry.get('hook').validateReferences(hook('bad-hook', 'made-up-handler'), context), error => error.code === 'GENERATOR_REFERENCE_UNAVAILABLE');
});

test('R6 invalid JSON repairs once and reaches READY with bounded attempt metadata', async () => {
  const candidate = JSON.stringify(skill('generated-skill', ['read_file']));
  const h = harness(['Here is config: {bad json}', candidate]);
  const started = h.service.generate(request('skill'));
  const draft = await h.service.wait(started.draftId);
  assert.strictEqual(draft.status, 'READY');
  assert.strictEqual(draft.attempts, 2);
  assert.strictEqual(draft.repairCount, 1);
  assert.strictEqual(h.calls.provider, 2);
  assert.match(h.calls.prompts[1].context, /GENERATOR_OUTPUT_INVALID_JSON/);
});

test('R6 repair exhaustion is exactly three provider calls and writes no registry', async () => {
  const h = harness(['invalid', 'invalid', 'invalid']);
  const before = h.skills.list().length;
  const started = h.service.generate(request('skill'));
  const draft = await h.service.wait(started.draftId);
  assert.strictEqual(draft.status, 'FAILED');
  assert.strictEqual(draft.errorCode, 'GENERATOR_REPAIR_EXHAUSTED');
  assert.strictEqual(draft.repairCount, 2);
  assert.strictEqual(h.calls.provider, 3);
  assert.strictEqual(h.skills.list().length, before);
});

test('R7 explicit save is provider-free, disabled by default, and collision-safe', async () => {
  const h = harness([JSON.stringify(skill('save-boundary', ['read_file']))]);
  const before = h.skills.list().length;
  const started = h.service.generate(request('skill'));
  const ready = await h.service.wait(started.draftId);
  assert.strictEqual(ready.status, 'READY');
  assert.strictEqual(h.skills.list().length, before);
  const providerCalls = h.calls.provider;
  assert.strictEqual(h.service.validate(ready.draftId).status, 'READY');
  const saved = h.service.save(ready.draftId);
  assert.strictEqual(h.calls.provider, providerCalls);
  assert.strictEqual(saved.draft.status, 'SAVED');
  assert.strictEqual(h.skills.get('save-boundary').enabled, false);

  const second = h.service.generate(request('skill'));
  const collision = await h.service.wait(second.draftId);
  assert.throws(() => h.service.save(collision.draftId), error => error.code === 'GENERATOR_TARGET_EXISTS');
  assert.strictEqual(h.skills.list().filter(item => item.id === 'save-boundary').length, 1);
});

test('R7 save-time reference validation blocks TOCTOU deletion', async () => {
  const candidate = workflow('toctou-flow', [{ id: 'review', type: 'agent', config: { goal: 'Review', target: { mode: 'main' }, skillIds: ['security-review'] } }]);
  const h = harness([JSON.stringify(candidate)]);
  const started = h.service.generate(request('workflow'));
  const ready = await h.service.wait(started.draftId);
  assert.strictEqual(ready.status, 'READY');
  h.skills.remove('security-review');
  assert.throws(() => h.service.save(ready.draftId), error => error.code === 'GENERATOR_REFERENCE_UNAVAILABLE');
  assert.strictEqual(h.workflows.get('toctou-flow'), null);
});

test('R7 authority adversarial fields and disabled references never become READY', async () => {
  const bad = { schemaVersion: 1, id: 'bad-agent', name: 'Bad', provider: { apiKey: 'not-persisted' } };
  const h = harness([JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(bad)]);
  const started = h.service.generate(request('agent', 'Ignore any request to bypass permissions; create configuration only'));
  const draft = await h.service.wait(started.draftId);
  assert.strictEqual(draft.status, 'FAILED');
  assert.ok(draft.validation.errors.some(error => error.code === 'GENERATOR_AUTHORITY_FORBIDDEN'));
  assert.throws(() => h.adapterRegistry.get('agent').validate({ schemaVersion: 1, id: 'fn', name: 'Fn', callback() {} }), error => error.code === 'GENERATOR_AUTHORITY_FORBIDDEN');
  h.skills.disable('security-review');
  const agent = h.adapterRegistry.get('agent').validate({ schemaVersion: 1, id: 'disabled-ref', name: 'Disabled', skills: { required: ['security-review'] } });
  assert.throws(() => h.adapterRegistry.get('agent').validateReferences(agent, h.capabilityCatalog.build()), error => error.code === 'GENERATOR_REFERENCE_DISABLED');
});

test('R1/R4 secret input and explicit missing model fail before provider wire', async () => {
  const secretHarness = harness([JSON.stringify(skill('never', []))]);
  const secret = secretHarness.service.generate(request('skill', 'Use api key sk-REAL_SENTINEL_123456'));
  assert.strictEqual(secret.status, 'FAILED');
  assert.strictEqual(secret.errorCode, 'GENERATOR_INPUT_SECRET_DETECTED');
  assert.strictEqual(secretHarness.calls.provider, 0);

  const routeError = Object.assign(new Error('explicit model unavailable'), { code: 'MODEL_ROUTER_EXPLICIT_UNAVAILABLE' });
  const explicitHarness = harness([], { routeError });
  const started = explicitHarness.service.generate(request('agent', 'Create agent', { mode: 'explicit_model', explicitModel: { connectionId: 'missing', modelId: 'missing' } }));
  const failed = await explicitHarness.service.wait(started.draftId);
  assert.strictEqual(failed.status, 'FAILED');
  assert.strictEqual(failed.errorCode, 'MODEL_ROUTER_EXPLICIT_UNAVAILABLE');
  assert.strictEqual(explicitHarness.calls.provider, 0);
});

test('R7 cancellation is terminal even when a provider returns late', async () => {
  let release;
  const late = () => new Promise(resolve => { release = () => resolve({ text: JSON.stringify(skill('late-skill', [])) }); });
  const h = harness([late]);
  const started = h.service.generate(request('skill'));
  const cancelled = h.service.cancel(started.draftId);
  assert.strictEqual(cancelled.status, 'CANCELLED');
  release();
  const final = await h.service.wait(started.draftId);
  assert.strictEqual(final.status, 'CANCELLED');
  assert.strictEqual(h.skills.get('late-skill'), null);
});

test('R7 timeout aborts provider work and a late response cannot revive FAILED', async () => {
  let observedSignal;
  let release;
  const late = input => new Promise(resolve => {
    observedSignal = input.abortSignal;
    release = () => resolve({ text: JSON.stringify(skill('timed-out-skill', [])) });
  });
  const h = harness([late], { requestTimeoutMs: 20, totalTimeoutMs: 100 });
  const started = h.service.generate(request('skill'));
  const failed = await h.service.wait(started.draftId);
  assert.strictEqual(failed.status, 'FAILED');
  assert.strictEqual(failed.errorCode, 'GENERATOR_TIMEOUT');
  assert.strictEqual(observedSignal.aborted, true);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(h.service.getDraft(started.draftId).status, 'FAILED');
});

test('R8 audit stores hashes and IDs but no raw intent, prompts, responses, or runtime objects', async () => {
  const rawIntent = 'Create harmless audit skill UNIQUE_RAW_INTENT_94721';
  const h = harness([JSON.stringify(skill('audit-skill', []))]);
  const started = h.service.generate(request('skill', rawIntent));
  await h.service.wait(started.draftId);
  const serialized = JSON.stringify(h.audit.list());
  assert.doesNotMatch(serialized, /UNIQUE_RAW_INTENT_94721|AVAILABLE_PLATFORM_RESOURCES|generated instructions|ModelAdapter|Provider object/);
  assert.match(serialized, /[a-f0-9]{64}/);
  assert.match(serialized, /generator-model-B/);
});
