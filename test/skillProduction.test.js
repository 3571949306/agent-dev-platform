'use strict';
/**
 * v2.9.3 Skill Engine — R8 Production Deterministic Skill Smoke.
 *
 * Full production chain with ZERO paid provider calls:
 *   Fake Main Model (via production ModelRouter + ProviderModelAdapter + fake network provider)
 *     ↓ delegate Dynamic Reviewer
 *     ↓ Dynamic Definition references Skills (security-review + vision-review)
 *     ↓ Production SkillRegistry (real store) → SkillResolver
 *     ↓ Tool/Permission validation → Prompt Composition
 *     ↓ Model Requirements Merge → Production ModelRouter
 *     ↓ Vision model B → Production ProviderModelAdapter → Fake network provider
 *     ↓ Child complete → Parent consumes result
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { executeAction } = require('../src/agent/runtime/actionExecutor');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { setDynamicAgentRuntime, getDynamicAgentRuntime } = require('../src/agents/dynamic/runtimeRegistry');
const { getBuiltin } = require('../src/tools/registry');
const { PermissionEngine } = require('../src/security/permissions');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { resolveConfiguredMainModel, bindMainRouteDecision } = require('../src/ipc/mainAgent');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');
const { createSkillRegistry, createSkillResolver, setSkillRuntime, getSkillRuntime } = require('../src/skills');
const { DynamicPermissionEngine } = require('../src/agents/dynamic/permissionPolicy');
const {
  RUNTIME_SAFETY_CONTRACT,
  DYNAMIC_AGENT_BASE_PROMPT,
  DYNAMIC_AGENT_API_GUIDE
} = require('../src/agent/runtime/prompts/mainCodingAgent');

const MARKER_SECURITY = 'SKILL_SECURITY_MARKER_7319';
const MARKER_VISION = 'SKILL_VISION_MARKER_4821';
const FINDING = 'PRODUCTION_SKILL_FINDING: example.js returns the constant 1';
const SOURCE = 'module.exports = function value() {\n  return 1;\n};\n';

function skillA() {
  return {
    id: 'prod-security-review',
    name: 'Production Security Review',
    instructions: `${MARKER_SECURITY}\nReview the security posture of the target code.`,
    tags: ['security'],
    toolRequirements: { required: ['read_file', 'search'], optional: [], denied: ['write_file'] },
    permissionRequirements: { required: ['filesystem.read'] },
    modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
}

function skillB() {
  return {
    id: 'prod-vision-review',
    name: 'Production Vision Review',
    instructions: `${MARKER_VISION}\nInspect visual output as part of the review.`,
    tags: ['vision'],
    toolRequirements: { required: ['read_file'], optional: [], denied: [] },
    permissionRequirements: { required: [] },
    modelRequirements: { required: { vision: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
}

function childDefinition() {
  return {
    id: 'production-skill-reviewer',
    name: 'Production Skill Reviewer',
    role: 'code_reviewer',
    systemPrompt: 'PRODUCTION_SKILL_CHILD_ROLE: review only, never modify.',
    runtime: { kind: 'native' },
    capabilities: ['review'],
    toolPolicy: { allow: ['read_file', 'search'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'auto', requirements: { required: { text: true } }, fallback: 'fail' },
    skills: { required: ['prod-security-review', 'prod-vision-review'], optional: [] },
    lifetime: 'run',
    budgets: { maxIterations: 5, maxToolCalls: 5, maxRuntimeMs: 5000 },
    canDelegate: false
  };
}

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

async function waitForTerminal(runManager, runId) {
  for (let i = 0; i < 300; i++) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return runManager.getRun(runId);
}

test('R8: production deterministic Skill chain — registry → resolver → prompt → router → provider wire → child result', async () => {
  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const previousSkill = getSkillRuntime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-skill-production-'));
  store.init(root);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-skill-production-fixture-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  const sourceFile = path.join(projectRoot, 'src', 'example.js');
  const outsideFile = path.join(fixtureRoot, 'outside.txt');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, SOURCE, 'utf8');
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sourceHashBefore = sha(sourceFile);

  try {
    // ---- production catalog: B is the ONLY proven vision model ----
    const r1 = addConnection('RemoteOne', 'custom', ['A', 'B']);
    const local = addConnection('Local', 'local', ['C']);
    const r2 = addConnection('RemoteTwo', 'custom', ['D', 'G']);
    const put = (conn, id, caps) => store.models.upsert(conn.id, id, caps);
    put(r1, 'A', { text: cap(true), vision: cap(false), contextWindow: metric(32000), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 100 });
    put(r1, 'B', { text: cap(true), vision: cap(true), contextWindow: metric(128000), pricing: { input: metric(2), output: metric(4), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 250 });
    put(local, 'C', { text: cap(true), vision: cap(null, 'unknown'), contextWindow: metric(64000), pricing: {}, latencyMs: 40 });
    put(r2, 'D', { text: cap(true), vision: cap(true, 'inferred'), contextWindow: cap(null, 'unknown'), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens' } });
    put(r2, 'G', { text: cap(true), vision: cap(false), contextWindow: metric(16000) });

    const catalog = createModelCatalog({ store });
    const audit = createRouteAudit(store.modelRouteDecisions);
    const router = createModelRouter({ catalog, audit });

    // ---- production SkillRegistry + SkillResolver over the real store ----
    const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: [] });
    skillRegistry.create(skillA());
    skillRegistry.create(skillB());
    const skillResolver = createSkillResolver({ registry: skillRegistry });
    setSkillRuntime(skillRegistry, skillResolver);

    // ---- fake network provider (wire model recorder; the ONLY "network") ----
    const wireModels = [];
    const parentContexts = [];
    let childRead = false;
    let parentDelegated = false;
    let parentWriteAttempted = false;
    const fakeProvider = {
      async streamResponse(input) {
        wireModels.push(input.model);
        let action;
        if (input.system.includes(DYNAMIC_AGENT_API_GUIDE)) {
          // Parent Main Agent
          parentContexts.push(input.messages[0].content);
          if (!parentWriteAttempted) {
            parentWriteAttempted = true;
            action = { type: 'write_file', args: { path: 'src/example.js', content: 'skill bypass attempt' } };
          } else if (!parentDelegated) {
            parentDelegated = true;
            action = {
              type: 'delegate',
              args: {
                goal: 'Review src/example.js with the security and vision skills; return one finding without modifying anything',
                inlineAgentDefinition: childDefinition()
              }
            };
          } else {
            action = { type: 'complete', args: { summary: 'Parent consumed production skill child finding' } };
          }
        } else {
          // Dynamic child (skill markers present)
          if (!childRead) {
            childRead = true;
            action = { type: 'read_file', args: { path: 'src/example.js' } };
          } else {
            action = { type: 'complete', args: { summary: FINDING } };
          }
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return { content: text };
      }
    };
    const resolver = createRuntimeModelResolver({
      router,
      audit,
      createModelAdapter(selection) {
        const agent = { id: `production-skill-routed-${selection.selected.modelId}`, api_connection_id: selection.selected.connectionId, model: selection.selected.modelId, max_tokens: 256 };
        return createProviderModelAdapter({
          buildProvider: async () => fakeProvider,
          agent,
          resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id })
        });
      }
    });

    // ---- production services ----
    const pathSecurity = createPathSecurity({ cacheRoots: true });
    const projectId = 'skill-production-project';
    const parentPermissionEngine = new PermissionEngine({ projectId });
    parentPermissionEngine.grant('filesystem.read', 'always', { persist: false });
    parentPermissionEngine.grant('filesystem.write', 'deny', { persist: false });

    const runManager = new RunManager();
    const registry = createAgentRegistry();
    const lifecycle = createLifecycleManager();
    const contextFactory = createExecutionContextFactory({
      runManager,
      getTool: getBuiltin,
      store,
      permissionEngine: parentPermissionEngine,
      pathSecurity
    });
    const hub = createAgentHub({
      registry,
      router: createAgentRouter({ registry }),
      healthManager: createHealthManager({ registry }),
      lifecycleManager: lifecycle,
      runBridge: createRunBridge({ runManager, lifecycleManager: lifecycle }),
      contextFactory
    });
    const factory = createAgentFactory({
      getTool: getBuiltin,
      resolveRuntimeModel: resolver.resolveRuntimeModel,
      bindRouteDecisionToRun: audit.bindRunIdentity,
      skillResolver
    });
    let created = null;
    const originalCreate = factory.createInstance;
    factory.createInstance = (...args) => {
      created = originalCreate(...args);
      return created;
    };
    setAgentHub(hub);
    setDynamicAgentRuntime(factory, null);

    // ---- Main Agent with skills: routing happens through the production router ----
    const toolLookups = [];
    const spyGetTool = name => { toolLookups.push(name); return getBuiltin(name); };
    const mainResolution = resolveConfiguredMainModel({
      agent: {
        id: 'production-skill-main',
        workspace: {
          modelRoutingMode: 'auto',
          modelRequirements: skillResolver.resolveModelMerge(['prod-security-review', 'prod-vision-review'], {}).modelRequirements
        }
      },
      agentId: 'production-skill-main', conversationId: 'skill-main-conv',
      resolveRuntimeModel: resolver.resolveRuntimeModel,
      buildProvider: async () => fakeProvider,
      resolveModelFor: configured => ({ model: configured.model })
    });
    assert.strictEqual(mainResolution.selection.selected.modelId, 'B', 'Main + Skill vision requirement routes to vision model B');

    const { runId: parentRunId } = runMainAgent({
      conversationId: 'skill-main-conv', agentId: 'production-skill-main', goal: 'Run the production skill chain',
      projectRoot, projectId, projectName: 'skill-fixture',
      model: mainResolution.modelAdapter,
      getTool: spyGetTool, store, emit: () => {}, runManager,
      permissionEngine: parentPermissionEngine, pathSecurity,
      timeoutMs: 15000,
      skillIds: ['prod-security-review', 'prod-vision-review'],
      skillRegistry, skillResolver,
      onRunCreated: ({ runId }) => bindMainRouteDecision({ selection: mainResolution.selection, bindRouteDecisionToRun: audit.bindRunIdentity, runId, conversationId: 'skill-main-conv' })
    });

    const parentResult = await waitForTerminal(runManager, parentRunId);
    assert.strictEqual(parentResult.status, 'completed', `parent failed: ${parentResult.error}`);

    // ---- R8 assertions ----
    assert.ok(created, 'production orchestrator created the dynamic skill reviewer');
    const child = created;
    assert.strictEqual(child.adapter.getTool('write_file'), null, 'Skill denied write_file → write_file unavailable');
    assert.strictEqual(child.adapter.getTool('read_file') !== null, true, 'read_file remains available');
    assert.ok(child.adapter.skillInstructions.length === 2, 'two skills resolved onto the child');
    assert.deepStrictEqual(child.adapter.skillInstructions.map(i => i.skillId), ['prod-security-review', 'prod-vision-review']);
    assert.strictEqual(child.definition.modelPolicy.requirements.required.vision, true, 'skill vision merged into child modelPolicy');
    assert.strictEqual(child.modelSelection.selected.modelId, 'B', 'child routed to vision model B');
    assert.strictEqual(child.modelSelection.selected.modelId, wireModels[wireModels.length - 1], 'selected model == provider wire model');

    // parent write attempt was filtered by the skill denied set
    assert.ok(!toolLookups.includes('write_file'), `parent write_file filtered: ${toolLookups.join(',')}`);

    // child completed and parent consumed the result
    assert.ok(parentContexts.length >= 3, 'parent had at least 3 model turns');
    assert.ok(parentContexts.slice(1).some(context => context.includes(FINDING)), 'child finding reached parent context');
    assert.strictEqual(child.status, 'DISPOSED', 'run-lifetime child disposed');

    // Run tree: parent + (hub-level child + inner native child) only.
    // NO independent Skill Run: skills never create their own run record.
    const allRuns = runManager.list();
    assert.strictEqual(allRuns.length, 3, `expected 3 runs (parent + hub child + inner child), got ${allRuns.length}: ${allRuns.map(r => `${r.id}/${r.agentId}`).join(', ')}`);
    assert.ok(allRuns.some(r => r.id === parentRunId));
    const childRuns = allRuns.filter(r => r.id !== parentRunId);
    assert.strictEqual(childRuns.length, 2, 'exactly two child run records (hub + inner), no skill run');
    assert.ok(childRuns.every(r => r.agentId && r.agentId.startsWith('dyn-agent-')), 'child runs belong to the dynamic agent, not a skill');

    // Permission escalation blocked: read-only child cannot write; parent deny cannot be widened
    const actionContext = {
      projectRoot, projectId, taskId: 'skill-production-task', agentId: child.adapterId,
      store: null, emit: () => {}, pathSecurity
    };
    const childPermissionEngine = new DynamicPermissionEngine({
      policy: child.definition.permissionPolicy,
      parent: parentPermissionEngine
    });
    const childWrite = await executeAction({ ...actionContext, permissionEngine: childPermissionEngine }, {
      type: 'write_file', args: { path: 'src/example.js', content: 'escalation attempt' }
    }, getBuiltin);
    assert.strictEqual(childWrite.error.code, 'PERMISSION_DENIED', 'permission escalation blocked');

    // PathSecurity still blocks outside-workspace writes even if permissions were granted
    const pathProof = new PermissionEngine({ projectId });
    pathProof.grant('filesystem.write', 'always', { persist: false });
    const outside = await executeAction({ ...actionContext, permissionEngine: pathProof }, {
      type: 'write_file', args: { path: '../outside.txt', content: 'must never exist' }
    }, getBuiltin);
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.error.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.strictEqual(fs.existsSync(outsideFile), false);

    assert.strictEqual(sha(sourceFile), sourceHashBefore, 'fixture source unchanged');
    assert.strictEqual(factory.listInstances().length, 0, 'no leaked instances');
    assert.strictEqual(factory.activeTimerCount(), 0);

    // Route audit bound to existing runs, no skill-specific run records
    const decisions = store.modelRouteDecisions.list(20);
    assert.ok(decisions.length >= 2, 'parent + child route decisions recorded');
    for (const decision of decisions) {
      assert.ok(decision.run_id, 'route decision bound to a real run');
      assert.ok(allRuns.some(r => r.id === decision.run_id), `decision run ${decision.run_id} exists in RunManager`);
    }
    assert.doesNotMatch(JSON.stringify(decisions), /fixture-placeholder-key|Authorization|Bearer|Cookie/i, 'no secrets in route audit');

    console.log(`SKILL_PRODUCTION parent=${parentRunId} childRuns=${childRuns.map(r => r.id).join('+')} wire=${wireModels.join(',')} providerCalls=${wireModels.length}`);
  } finally {
    setAgentHub(previousHub);
    setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
    setSkillRuntime(previousSkill.registry, previousSkill.resolver);
    try { if (typeof pathSecurity !== 'undefined') pathSecurity.clearRootCache(); } catch { /* best effort */ }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* §7 — Production Skill Engine closure smoke (R1/R3/R4 adversarial)  */
/* ------------------------------------------------------------------ */

/** Shared production harness: real store + catalog + router + SkillRegistry +
 *  SkillResolver + runtime model resolver + AgentFactory + AgentHub, all wired
 *  exactly like the R8 chain. Used by the §7 adversarial closure tests. */
function buildSkillHarness({ skills = [], grantWrite = 'allow' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-s7-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-s7-fix-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const previousSkill = getSkillRuntime();

  store.init(root);
  const r1 = addConnection('RemoteOne', 'custom', ['A', 'B']);
  const r2 = addConnection('RemoteTwo', 'custom', ['D', 'G']);
  const local = addConnection('Local', 'local', ['C']);
  const put = (conn, id, caps) => store.models.upsert(conn.id, id, caps);
  put(r1, 'A', { text: cap(true), vision: cap(false), contextWindow: metric(32000), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 100 });
  put(r1, 'B', { text: cap(true), vision: cap(true), contextWindow: metric(128000), pricing: { input: metric(2), output: metric(4), currency: 'USD', unit: 'per_1m_tokens', source: 'fixture' }, latencyMs: 250 });
  put(local, 'C', { text: cap(true), vision: cap(null, 'unknown'), contextWindow: metric(64000), pricing: {}, latencyMs: 40 });
  put(r2, 'D', { text: cap(true), vision: cap(true, 'inferred'), contextWindow: cap(null, 'unknown'), pricing: { input: metric(0.1), output: metric(0.2), currency: 'USD', unit: 'per_1m_tokens' } });
  put(r2, 'G', { text: cap(true), vision: cap(false), contextWindow: metric(16000) });

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });

  const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: [] });
  for (const s of skills) skillRegistry.create(s);
  const skillResolver = createSkillResolver({ registry: skillRegistry });
  setSkillRuntime(skillRegistry, skillResolver);

  const wireModels = [];
  let providerCalls = 0;
  const provider = {
    async streamResponse(input) {
      providerCalls++;
      wireModels.push(input.model);
      const text = JSON.stringify({ action: { type: 'complete', args: { summary: 'harness complete' } } });
      input.onChunk(text);
      return { content: text };
    }
  };

  const resolver = createRuntimeModelResolver({
    router,
    audit,
    createModelAdapter(selection) {
      const agent = { id: `s7-${selection.selected.modelId}`, api_connection_id: selection.selected.connectionId, model: selection.selected.modelId, max_tokens: 256 };
      return createProviderModelAdapter({
        buildProvider: async () => provider,
        agent,
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id })
      });
    }
  });

  const parentPermissionEngine = new PermissionEngine({ projectId: 's7-project' });
  parentPermissionEngine.grant('filesystem.read', 'always', { persist: false });
  parentPermissionEngine.grant('filesystem.write', grantWrite, { persist: false });

  const runManager = new RunManager();
  const registry = createAgentRegistry();
  const lifecycle = createLifecycleManager();
  const contextFactory = createExecutionContextFactory({
    runManager,
    getTool: getBuiltin,
    store,
    permissionEngine: parentPermissionEngine,
    pathSecurity: createPathSecurity({ cacheRoots: true })
  });
  const hub = createAgentHub({
    registry,
    router: createAgentRouter({ registry }),
    healthManager: createHealthManager({ registry }),
    lifecycleManager: lifecycle,
    runBridge: createRunBridge({ runManager, lifecycleManager: lifecycle }),
    contextFactory
  });
  const factory = createAgentFactory({
    getTool: getBuiltin,
    resolveRuntimeModel: resolver.resolveRuntimeModel,
    bindRouteDecisionToRun: audit.bindRunIdentity,
    skillResolver
  });
  setAgentHub(hub);
  setDynamicAgentRuntime(factory, null);

  return {
    root, fixtureRoot, projectRoot,
    store, catalog, audit, router, skillRegistry, skillResolver,
    provider, wireModels, getProviderCalls: () => providerCalls,
    resolver, parentPermissionEngine, runManager, hub, factory,
    cleanup() {
      setAgentHub(previousHub);
      setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
      setSkillRuntime(previousSkill.registry, previousSkill.resolver);
      try { store.getDb().close(); } catch { /* best effort */ }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };
}

test('§7a: production — disjoint agent/skill allowed-set fails closed with ZERO provider calls', async () => {
  const conflictSkill = {
    id: 'prod-conflict-prov', name: 'Conflict Provider',
    instructions: 'CONFLICT_PROV_MARKER', tags: ['security'],
    toolRequirements: { required: ['read_file'], optional: [], denied: [] },
    permissionRequirements: { required: [] },
    modelRequirements: { constraints: { allowedProviders: ['anthropic'] } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
  const h = buildSkillHarness({ skills: [conflictSkill] });
  try {
    // (1) IPC pre-check path: agent(openai) ∩ skill(anthropic) must fail closed
    const merged = h.skillResolver.resolveModelMerge(['prod-conflict-prov'], { constraints: { allowedProviders: ['openai'] } });
    assert.strictEqual(merged.ok, false, 'merge must fail closed on disjoint allow-lists');
    assert.strictEqual(merged.errorCode, 'SKILL_MODEL_REQUIREMENTS_CONFLICT');
    assert.strictEqual(h.getProviderCalls(), 0, 'no provider call during pre-routing merge');

    // (2) full run path: runMainAgent must reject BEFORE any provider call
    const mainResolution = resolveConfiguredMainModel({
      agent: { id: 's7a-main', workspace: { modelRoutingMode: 'auto', modelRequirements: {} } },
      agentId: 's7a-main', conversationId: 's7a-conv',
      resolveRuntimeModel: h.resolver.resolveRuntimeModel,
      buildProvider: async () => h.provider,
      resolveModelFor: c => ({ model: c.model })
    });
    assert.strictEqual(h.getProviderCalls(), 0, 'main model resolution does not call provider');

    let threw = null;
    try {
      await runMainAgent({
        conversationId: 's7a-conv', agentId: 's7a-main', goal: 'run conflicting skill',
        projectRoot: h.projectRoot, projectId: 's7a-project', projectName: 's7a-fix',
        model: mainResolution.modelAdapter,
        getTool: getBuiltin, store: h.store, emit: () => {}, runManager: h.runManager,
        permissionEngine: h.parentPermissionEngine,
        timeoutMs: 8000,
        skillIds: ['prod-conflict-prov'],
        skillRegistry: h.skillRegistry, skillResolver: h.skillResolver,
        modelRequirements: { constraints: { allowedProviders: ['openai'] } },
        onRunCreated: ({ runId }) => bindMainRouteDecision({ selection: mainResolution.selection, bindRouteDecisionToRun: h.audit.bindRunIdentity, runId, conversationId: 's7a-conv' })
      });
    } catch (err) { threw = err; }
    assert.ok(threw, 'runMainAgent must reject on conflicting allowed-set');
    assert.strictEqual(threw.code, 'SKILL_MODEL_REQUIREMENTS_CONFLICT', `expected conflict code, got ${threw && threw.code}: ${threw && threw.message}`);
    assert.strictEqual(h.getProviderCalls(), 0, 'provider NEVER called in fail-closed path (0 wire calls)');
    assert.strictEqual(h.wireModels.length, 0, '0 wire models reached the provider');
    console.log(`S7A ok=${merged.ok} code=${merged.errorCode} providerCalls=${h.getProviderCalls()}`);
  } finally {
    h.cleanup();
  }
});

test('§7b: production — required + optional vision skills both reach routing (optional never dropped)', () => {
  const reqVision = {
    id: 'prod-req-vision', name: 'Req Vision', instructions: 'REQ_VISION_MARKER', tags: ['vision'],
    toolRequirements: { required: ['read_file'], optional: [], denied: [] },
    permissionRequirements: { required: [] },
    modelRequirements: { required: { vision: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
  const optVision = {
    id: 'prod-opt-vision', name: 'Opt Vision', instructions: 'OPT_VISION_MARKER', tags: ['vision'],
    toolRequirements: { required: ['read_file'], optional: [], denied: [] },
    permissionRequirements: { required: [] },
    modelRequirements: { required: { vision: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
  const h = buildSkillHarness({ skills: [reqVision, optVision] });
  try {
    // (1) resolver-level: both present in final set, optional not skipped, vision merged
    const res = h.skillResolver.resolveWithOptions({
      requiredSkillIds: ['prod-req-vision'], optionalSkillIds: ['prod-opt-vision'],
      agentContext: { toolPolicy: { allow: ['read_file'], deny: [] }, permissionPolicy: { readOnly: false, allow: [], deny: [] }, availableTools: ['read_file'], agentType: 'native' },
      projectContext: { platform: 'windows' }
    });
    assert.strictEqual(res.ok, true, 'required + compatible optional resolve OK');
    assert.strictEqual(res.skipped.length, 0, 'compatible optional must NOT be skipped');
    assert.deepStrictEqual(res.instructions.map(i => i.skillId).sort(), ['prod-opt-vision', 'prod-req-vision'], 'BOTH required and optional skills in final set');
    assert.strictEqual(res.modelRequirements.required.vision, true, 'vision requirement merged into modelRequirements');

    // (2) routing-level: Main Agent with merged requirements routes to vision model B
    const mainResolution = resolveConfiguredMainModel({
      agent: { id: 's7b-main', workspace: { modelRoutingMode: 'auto', modelRequirements: res.modelRequirements } },
      agentId: 's7b-main', conversationId: 's7b-conv',
      resolveRuntimeModel: h.resolver.resolveRuntimeModel,
      buildProvider: async () => h.provider,
      resolveModelFor: c => ({ model: c.model })
    });
    assert.strictEqual(mainResolution.selection.selected.modelId, 'B', 'required+optional vision routes to vision model B');

    // (3) factory-level: child instance carries BOTH markers and is routed to B
    const def = {
      id: 's7b-child', name: 'S7B Child', role: 'code_reviewer', runtime: { kind: 'native' }, capabilities: ['review'],
      toolPolicy: { allow: ['read_file'], deny: [] }, permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
      modelPolicy: { mode: 'auto', requirements: { required: { text: true } }, fallback: 'fail' },
      skills: { required: ['prod-req-vision'], optional: ['prod-opt-vision'] },
      lifetime: 'run', budgets: { maxIterations: 5, maxToolCalls: 5, maxRuntimeMs: 5000 }, canDelegate: false
    };
    const child = h.factory.createInstance(def, {
      parentPermissionEngine: h.parentPermissionEngine,
      projectContext: { projectRoot: h.projectRoot, projectId: 's7b-project' },
      getTool: getBuiltin
    });
    assert.ok(child, 'child instance created');
    const childMarkers = child.adapter.skillInstructions.map(i => i.instructions).join(' ');
    assert.ok(childMarkers.includes('REQ_VISION_MARKER') && childMarkers.includes('OPT_VISION_MARKER'), 'child carries BOTH required and optional skill instructions');
    assert.strictEqual(child.modelSelection.selected.modelId, 'B', 'child routed to vision model B via combined skill requirements');
    assert.strictEqual(h.factory.listInstances().length, 1, 'exactly one instance created');
    console.log(`S7B markers=${child.adapter.skillInstructions.map(i => i.skillId).join('+')} route=${child.modelSelection.selected.modelId}`);
  } finally {
    h.cleanup();
  }
});

test('§7c: production — required skill needing parent-denied permission fails at factory (0 provider/tool calls)', () => {
  const writeSkill = {
    id: 'prod-write-skill', name: 'Write Skill', instructions: 'WRITE_SKILL_MARKER', tags: ['write'],
    toolRequirements: { required: ['write_file'], optional: [], denied: [] },
    permissionRequirements: { required: ['filesystem.write'] },
    modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  };
  const h = buildSkillHarness({ skills: [writeSkill], grantWrite: 'deny' });
  try {
    const def = {
      id: 's7c-child', name: 'S7C Child', role: 'writer', runtime: { kind: 'native' }, capabilities: ['write'],
      toolPolicy: { allow: ['read_file', 'write_file'], deny: [] }, permissionPolicy: { readOnly: false, allow: ['filesystem.write'], deny: [] },
      modelPolicy: { mode: 'auto', requirements: { required: { text: true } }, fallback: 'fail' },
      skills: { required: ['prod-write-skill'], optional: [] },
      lifetime: 'run', budgets: { maxIterations: 5, maxToolCalls: 5, maxRuntimeMs: 5000 }, canDelegate: false
    };
    let threw = null;
    try {
      h.factory.createInstance(def, {
        parentPermissionEngine: h.parentPermissionEngine,
        projectContext: { projectRoot: h.projectRoot, projectId: 's7c-project' },
        getTool: getBuiltin
      });
    } catch (err) { threw = err; }
    assert.ok(threw, 'factory must reject when required permission is denied by parent');
    assert.strictEqual(threw.code, 'SKILL_REQUIRED_PERMISSION_UNAVAILABLE', `expected permission-unavailable, got ${threw && threw.code}: ${threw && threw.message}`);
    assert.strictEqual(h.factory.listInstances().length, 0, 'no instance leaked on fail-closed');
    assert.strictEqual(h.getProviderCalls(), 0, 'provider never called on fail-closed factory path');
    assert.strictEqual(h.wireModels.length, 0, '0 wire models');
    console.log(`S7C error=${threw.code} providerCalls=${h.getProviderCalls()}`);
  } finally {
    h.cleanup();
  }
});
