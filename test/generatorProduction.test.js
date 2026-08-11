'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const { listBuiltinDefs, getBuiltin } = require('../src/tools/registry');
const { createSkillRegistry, BUILTIN_SKILLS } = require('../src/skills');
const { createHookEngine } = require('../src/hooks');
const { createWorkflowRegistry } = require('../src/workflows/workflowRegistry');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createGeneratorEngine } = require('../src/generator');

const cap = value => ({ value, state: 'tested', source: 'generator-production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'generator-production-fixture' });

function skill(id, required = ['read_file'], denied = ['write_file']) {
  return {
    schemaVersion: 1, id, name: id, description: 'Generated read-only review skill',
    instructions: 'Inspect code and report findings without modifying files.', tags: ['review', 'readonly'],
    toolRequirements: { required, optional: [], denied },
    permissionRequirements: { required: ['filesystem.read'] }, modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    requiresSkills: [], metadata: {}
  };
}

function agent(id) {
  return {
    schemaVersion: 1, id, name: id, description: 'Read-only generated security reviewer', role: 'security-reviewer',
    systemPrompt: 'Perform a read-only security review.', runtime: { kind: 'native' }, capabilities: ['security-review'],
    toolPolicy: { allow: ['read_file', 'search_text'], deny: ['write_file'] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: ['filesystem.write'] },
    skills: { required: ['security-review'], optional: [] }, hooks: { required: [], optional: [] },
    modelPolicy: { mode: 'auto', requirements: { required: { text: true } }, fallback: 'fail' },
    lifetime: 'run', budgets: { maxIterations: 5, maxToolCalls: 10, maxRuntimeMs: 120000 },
    canDelegate: false, tags: ['security'], metadata: {}
  };
}

function hook(id, handlerId) {
  return {
    schemaVersion: 1, id, name: id, description: 'Generated trusted guard reference',
    event: 'before_tool', kind: 'guard', handlerId, priority: 100,
    filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000, config: {}, metadata: {}
  };
}

function workflow(id, reviewerId, skillIds = ['security-review']) {
  return {
    schemaVersion: 1, id, name: id, description: 'Generated review and approval workflow', inputs: {},
    steps: [
      { id: 'main-review', type: 'agent', dependsOn: [], config: { goal: 'Inspect the code', target: { mode: 'main' }, skillIds: [], hookIds: [], readOnly: true } },
      { id: 'security-review', type: 'agent', dependsOn: ['main-review'], config: { goal: 'Review security', target: { mode: 'dynamic', agentDefinitionId: reviewerId }, skillIds, hookIds: [], readOnly: true } },
      { id: 'approval', type: 'approval', dependsOn: ['security-review'], config: { message: 'Approve the review?' } }
    ],
    outputs: {}, limits: { maxSteps: 32, maxRuntimeMs: 180000 }, metadata: {}
  };
}

test('R8 production generator scenarios A-J use the real framework with zero execution or paid calls', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-generator-production-'));
  store.init(dataRoot);
  const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: BUILTIN_SKILLS });
  const hookEngine = createHookEngine({ definitionStore: store.hookDefinitions, auditStore: store.hookInvocations });
  hookEngine.handlerRegistry.register('readonly-policy', () => ({ decision: 'continue' }));
  const workflowRegistry = createWorkflowRegistry({ store: store.workflowDefinitions });
  const agentRegistry = createAgentRegistry();
  agentRegistry.register({
    id: 'native-main', available: true, disabled: false,
    manifest: { id: 'native-main', displayName: 'Main Agent', capabilities: { coding: true }, availability: true }
  });

  const connection = store.connections.create({
    name: 'Generator Fake Network', provider: 'custom', base_url: 'https://generator.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['generator-model-B'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'generator-model-B', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });

  const providerState = { responses: [], calls: 0, captures: [] };
  const fakeProvider = {
    async streamResponse(input) {
      providerState.calls++;
      providerState.captures.push({
        model: input.model, system: input.system,
        context: (input.messages || []).map(item => item.content).join('\n'),
        hasTools: Object.prototype.hasOwnProperty.call(input, 'tools')
      });
      const text = providerState.responses.shift();
      input.onChunk(text);
      return { content: text };
    }
  };
  const catalog = createModelCatalog({ store });
  const routeAudit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit: routeAudit });
  const selectedModels = [];
  const runtimeResolver = createRuntimeModelResolver({
    router, audit: routeAudit,
    createModelAdapter(selection) {
      selectedModels.push(selection.selected.modelId);
      return createProviderModelAdapter({
        buildProvider: async () => fakeProvider,
        agent: {
          id: 'ai-generator', name: 'AI Generator', api_connection_id: selection.selected.connectionId,
          model: selection.selected.modelId, max_tokens: 8192
        },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs: 2000
      });
    }
  });

  let toolExecutions = 0;
  const generatorGetTool = name => {
    const tool = getBuiltin(name);
    if (!tool) return null;
    return { ...tool, exec: async (...args) => { toolExecutions++; return tool.exec(...args); } };
  };
  const engine = createGeneratorEngine({
    agentDefinitionStore: store.agentDefinitions, skillRegistry, hookEngine, workflowRegistry,
    agentRegistry, modelCatalog: catalog, listTools: () => listBuiltinDefs(), getTool: generatorGetTool,
    resolveRuntimeModel: runtimeResolver.resolveRuntimeModel,
    draftStore: store.generatorDrafts, auditStore: store.generatorAudit,
    requestTimeoutMs: 2000, totalTimeoutMs: 10000
  });
  const service = engine.service;
  const generate = async (artifactType, intent, responses, extra = {}) => {
    providerState.responses = responses.slice();
    const started = service.generate({
      schemaVersion: 1, artifactType, intent, mode: 'auto', explicitModel: null,
      context: { projectId: null, projectSummary: 'Public summary only.' }, ...extra
    });
    return service.wait(started.draftId);
  };

  const initialRuns = store.runs.list(1000).length;
  const initialWorkflowRuns = store.workflowExecutions.list(1000).length;
  const initialGrants = store.permissionGrants.list().length;
  try {
    // A: real Skill validator/reference checks, draft first, then explicit save.
    const skillCandidate = skill('generated-readonly-review');
    const skillBefore = skillRegistry.get(skillCandidate.id);
    const a = await generate('skill', 'Create a read-only review skill requiring read_file and denying write_file.', [JSON.stringify(skillCandidate)]);
    assert.strictEqual(a.status, 'READY');
    assert.strictEqual(skillBefore, null);
    assert.strictEqual(skillRegistry.get(skillCandidate.id), null);
    const callsBeforeSkillSave = providerState.calls;
    const aSaved = service.save(a.draftId);
    assert.strictEqual(providerState.calls, callsBeforeSkillSave);
    assert.strictEqual(aSaved.draft.status, 'SAVED');
    assert.strictEqual(skillRegistry.get(skillCandidate.id).enabled, false);

    // B: real Dynamic Agent definition store, existing Skill reference, no run/grant.
    const reviewer = agent('generated-security-reviewer');
    const b = await generate('agent', 'Create a read-only security audit agent using security-review.', [JSON.stringify(reviewer)]);
    assert.strictEqual(b.status, 'READY');
    assert.strictEqual(store.agentDefinitions.get(reviewer.id), null);
    service.save(b.draftId);
    assert.ok(store.agentDefinitions.get(reviewer.id));
    assert.strictEqual(store.runs.list(1000).length, initialRuns);
    assert.strictEqual(store.permissionGrants.list().length, initialGrants);

    // C: invented handler fails real reference validation, repair chooses trusted handler.
    const c = await generate('hook', 'Create a before_tool guard using readonly-policy.', [
      JSON.stringify(hook('generated-readonly-guard', 'made-up-handler')),
      JSON.stringify(hook('generated-readonly-guard', 'readonly-policy'))
    ]);
    assert.strictEqual(c.status, 'READY');
    assert.strictEqual(c.attempts, 2);
    const cSaved = service.save(c.draftId);
    assert.strictEqual(cSaved.artifact.enabled, false);

    // D: real Workflow validator and cross-artifact references; save does not run it.
    const flow = workflow('generated-security-flow', reviewer.id);
    const d = await generate('workflow', 'Main review, security reviewer, then human approval.', [JSON.stringify(flow)]);
    assert.strictEqual(d.status, 'READY');
    assert.strictEqual(workflowRegistry.get(flow.id), null);
    const dSaved = service.save(d.draftId);
    assert.strictEqual(dSaved.artifact.enabled, false);
    assert.strictEqual(store.workflowExecutions.list(1000).length, initialWorkflowRuns);

    // E: exact JSON parser rejects prose/fence and repairs successfully.
    const e = await generate('skill', 'Create another read-only skill.', [
      'Here is your configuration: {bad json}',
      JSON.stringify(skill('json-repaired-skill'))
    ]);
    assert.strictEqual(e.status, 'READY');
    assert.strictEqual(e.attempts, 2);

    // F: initial + two repairs only.
    const fCalls = providerState.calls;
    const f = await generate('skill', 'This candidate remains invalid.', ['invalid', 'invalid', 'invalid']);
    assert.strictEqual(f.status, 'FAILED');
    assert.strictEqual(f.errorCode, 'GENERATOR_REPAIR_EXHAUSTED');
    assert.strictEqual(providerState.calls - fCalls, 3);
    assert.strictEqual(skillRegistry.get('never-written'), null);

    // G: secret-bearing input never reaches router/provider.
    const gCalls = providerState.calls;
    const g = await generate('skill', 'Use api key sk-REAL_SENTINEL_123456', [JSON.stringify(skill('secret-never'))]);
    assert.strictEqual(g.status, 'FAILED');
    assert.strictEqual(g.errorCode, 'GENERATOR_INPUT_SECRET_DETECTED');
    assert.strictEqual(providerState.calls, gCalls);

    // H: invented executable capability remains invalid through exhaustion.
    const fakeCapability = { ...agent('fake-capability-agent'), toolPolicy: { allow: ['god_mode_tool'], deny: [] } };
    const h = await generate('agent', 'Create a safe agent.', [JSON.stringify(fakeCapability), JSON.stringify(fakeCapability), JSON.stringify(fakeCapability)]);
    assert.strictEqual(h.status, 'FAILED');
    assert.ok(h.validation.errors.some(error => error.code === 'GENERATOR_REFERENCE_UNAVAILABLE'));
    assert.strictEqual(store.agentDefinitions.get(fakeCapability.id), null);

    // I: READY is not permanently trusted; deleting a referenced Skill blocks save.
    skillRegistry.create(skill('temporary-skill', [] , []));
    const toctou = workflow('toctou-workflow', reviewer.id, ['temporary-skill']);
    const i = await generate('workflow', 'Use the currently available temporary skill.', [JSON.stringify(toctou)]);
    assert.strictEqual(i.status, 'READY');
    skillRegistry.remove('temporary-skill');
    const workflowCount = workflowRegistry.list().length;
    assert.throws(() => service.save(i.draftId), error => error.code === 'GENERATOR_REFERENCE_UNAVAILABLE');
    assert.strictEqual(workflowRegistry.list().length, workflowCount);

    // J: real router explicit semantics fail closed, with no provider fallback.
    const jCalls = providerState.calls;
    const startedJ = service.generate({
      schemaVersion: 1, artifactType: 'agent', intent: 'Create an agent.', mode: 'explicit_model',
      explicitModel: { connectionId: 'missing', modelId: 'missing' },
      context: { projectId: null, projectSummary: null }
    });
    const j = await service.wait(startedJ.draftId);
    assert.strictEqual(j.status, 'FAILED');
    assert.strictEqual(providerState.calls, jCalls);

    assert.ok(selectedModels.length > 0);
    assert.ok(selectedModels.every(model => model === 'generator-model-B'));
    assert.ok(providerState.captures.every(capture => capture.model === 'generator-model-B'));
    assert.ok(providerState.captures.every(capture => capture.hasTools === false));
    assert.strictEqual(store.runs.list(1000).length, initialRuns);
    assert.strictEqual(store.workflowExecutions.list(1000).length, initialWorkflowRuns);
    assert.strictEqual(toolExecutions, 0);
    assert.strictEqual(store.permissionGrants.list().length, initialGrants);
    assert.doesNotMatch(JSON.stringify(store.generatorAudit.list(1000)), /REAL_SENTINEL|Public summary only|AVAILABLE_PLATFORM_RESOURCES|fixture-placeholder-key|Authorization|Cookie/i);
    assert.doesNotMatch(JSON.stringify(store.generatorDrafts.list(1000)), /fixture-placeholder-key|ProviderModelAdapter|AbortController|PermissionEngine/i);

    console.log(
      'GENERATOR_PRODUCTION selectedModel=generator-model-B wireModel=generator-model-B match=YES ' +
      'agentRuns=0 workflowRuns=0 toolExec=0 permissionGrants=0 paidProviderCalls=0 secretProviderCalls=0'
    );
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
