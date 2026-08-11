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
const { NativeAgentAdapter } = require('../src/agents/adapters/nativeAgentAdapter');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { NATIVE_MAIN } = require('../src/agents/manifests/builtinAgents');
const { setDynamicAgentRuntime, getDynamicAgentRuntime } = require('../src/agents/dynamic/runtimeRegistry');
const { getBuiltin } = require('../src/tools/registry');
const { PermissionEngine } = require('../src/security/permissions');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');
const { createSkillRegistry, createSkillResolver, BUILTIN_SKILLS, setSkillRuntime, getSkillRuntime } = require('../src/skills');
const { createHookEngine, setHookRuntime, getHookRuntime } = require('../src/hooks');
const { createWorkflowEngine } = require('../src/workflows');
const { createProductEntry } = require('../src/services/productEntry');

const HOOK_MARKER = 'WORKFLOW_HOOK_MARKER_8427';
const cap = value => ({ value, state: 'tested', source: 'workflow-production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'workflow-production-fixture' });

function hook(overrides) {
  return {
    schemaVersion: 1,
    id: overrides.id,
    name: overrides.id,
    description: 'workflow production fixture',
    event: overrides.event,
    kind: overrides.kind,
    handlerId: overrides.id,
    priority: 100,
    filters: overrides.filters || { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000,
    config: overrides.config || {},
    metadata: {}
  };
}

function workflow(id, steps, outputs = {}) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: 'workflow production fixture',
    inputs: {},
    steps,
    outputs,
    limits: { maxSteps: 32, maxRuntimeMs: 10000 },
    metadata: {}
  };
}

async function waitStatus(runtime, workflowRunId, status) {
  for (let i = 0; i < 500; i++) {
    const run = runtime.getRun(workflowRunId);
    if (run && run.status === status) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return runtime.getRun(workflowRunId);
}

test('R8 production Workflow scenarios A-F traverse real runtimes with zero paid calls', async () => {
  const previousHub = getAgentHub();
  const previousDynamic = getDynamicAgentRuntime();
  const previousHook = getHookRuntime();
  const previousSkill = getSkillRuntime();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workflow-production-db-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workflow-production-fixture-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'safe.txt'), 'WORKFLOW_SAFE_CONTENT', 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, 'outside.txt'), 'WORKFLOW_OUTSIDE_SENTINEL', 'utf8');
  store.init(dataRoot);

  const skillRegistry = createSkillRegistry({ store: store.skillDefinitions, builtins: BUILTIN_SKILLS });
  const skillResolver = createSkillResolver({ registry: skillRegistry });
  setSkillRuntime(skillRegistry, skillResolver);
  skillRegistry.create({
    id: 'workflow-unavailable-tool',
    name: 'Unavailable Tool Requirement',
    description: 'production fail-closed fixture',
    instructions: 'Require a tool that the Dynamic Agent runtime does not expose.',
    tags: ['fixture'],
    toolRequirements: { required: ['terminal_run'], optional: [], denied: [] },
    permissionRequirements: { required: ['terminal.write'] },
    modelRequirements: {},
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  });
  skillRegistry.create({
    id: 'workflow-write-request',
    name: 'Workflow write request',
    description: 'adversarial authority-chain fixture',
    instructions: 'SECURITY_WRITE_MARKER: request write_file, but never grant authority.',
    tags: ['fixture'],
    toolRequirements: { required: ['write_file'], optional: [], denied: [] },
    permissionRequirements: { required: ['filesystem.read'] },
    modelRequirements: {},
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  });

  const hookEngine = createHookEngine({
    definitionStore: store.hookDefinitions,
    auditStore: store.hookInvocations
  });
  setHookRuntime(hookEngine);
  const registerHook = (definition, handler) => {
    hookEngine.handlerRegistry.register(definition.handlerId, handler);
    hookEngine.registry.create(definition);
  };
  let securityHookCalls = 0;
  registerHook(hook({ id: 'workflow-context', event: 'before_model', kind: 'context', config: { marker: HOOK_MARKER } }),
    payload => ({ context: payload.config.marker }));
  registerHook(hook({ id: 'workflow-block-model', event: 'before_model', kind: 'guard' }),
    () => ({ decision: 'block', reason: 'workflow model blocked' }));
  registerHook(hook({
    id: 'workflow-block-tool',
    event: 'before_tool',
    kind: 'guard',
    filters: { agentTypes: [], agentIds: [], toolNames: ['read_file'], actionTypes: [], skillIds: [] }
  }), () => ({ decision: 'block', reason: 'workflow tool blocked' }));
  registerHook(hook({
    id: 'workflow-agent-tool',
    event: 'before_tool',
    kind: 'guard',
    filters: { agentTypes: ['native'], agentIds: [], toolNames: ['read_file'], actionTypes: [], skillIds: [] }
  }), () => ({ decision: 'continue' }));
  registerHook(hook({
    id: 'workflow-security-write', event: 'before_tool', kind: 'guard',
    filters: { agentTypes: ['native'], agentIds: [], toolNames: ['write_file'], actionTypes: [], skillIds: ['workflow-write-request'] }
  }), () => { securityHookCalls++; return { decision: 'continue' }; });

  let activeProvider;
  const providerCaptures = [];
  const providerCounter = { calls: 0 };
  let agentToolProviderCalls = 0;
  let securityProviderCalls = 0;
  activeProvider = {
    async streamResponse(input) {
      providerCounter.calls++;
      providerCaptures.push({ system: input.system, model: input.model });
      const context = (input.messages || []).map(message => String(message.content || '')).join('\n');
      let action = { type: 'complete', args: { summary: 'workflow agent complete' } };
      if (input.system.includes('SECURITY_WRITE_MARKER')) {
        securityProviderCalls++;
        action = securityProviderCalls === 1
          ? { type: 'write_file', args: { path: 'security-denied.txt', content: 'must not execute' } }
          : { type: 'complete', args: { summary: 'write remained denied' } };
      }
      if (context.includes('Exercise agent-owned tool hook')) {
        agentToolProviderCalls++;
        action = agentToolProviderCalls === 1
          ? { type: 'read_file', args: { path: 'safe.txt' } }
          : { type: 'complete', args: { summary: 'agent-owned tool hook complete' } };
      }
      const text = JSON.stringify({ action });
      input.onChunk(text);
      return { content: text };
    }
  };

  const connection = store.connections.create({
    name: 'Workflow Fake Network',
    provider: 'custom',
    base_url: 'https://workflow.invalid/v1',
    api_key: 'fixture-placeholder-key',
    models: ['workflow-model'],
    enabled: true
  });
  store.models.upsert(connection.id, 'workflow-model', {
    text: cap(true),
    vision: cap(false),
    contextWindow: metric(32000),
    pricing: {
      input: metric(0),
      output: metric(0),
      currency: 'USD',
      unit: 'per_1m_tokens'
    },
    latencyMs: 1
  });
  const routeAudit = createRouteAudit(store.modelRouteDecisions);
  const modelRouter = createModelRouter({ catalog: createModelCatalog({ store }), audit: routeAudit });
  const selectedModels = [];
  const runtimeResolver = createRuntimeModelResolver({
    router: modelRouter,
    audit: routeAudit,
    createModelAdapter(selection) {
      selectedModels.push(selection.selected.modelId);
      return createProviderModelAdapter({
        buildProvider: async () => activeProvider,
        agent: {
          id: 'workflow-production-agent',
          api_connection_id: selection.selected.connectionId,
          model: selection.selected.modelId,
          max_tokens: 256
        },
        resolveModel: configured => ({
          model: configured.model,
          connectionId: configured.api_connection_id
        })
      });
    }
  });

  const projectId = 'workflow-production-project';
  const permissions = new PermissionEngine({ projectId });
  permissions.grant('filesystem.read', 'always', { persist: false });
  permissions.grant('filesystem.write', 'deny', { persist: false });
  const pathSecurity = createPathSecurity({ cacheRoots: true });
  const projectLock = createProjectMutationLock();
  const runManager = new RunManager({ store });
  const agentRegistry = createAgentRegistry();
  const lifecycle = createLifecycleManager();
  const nativeResolver = {
    resolveNativeModelContext(agent) {
      const resolved = runtimeResolver.resolveRuntimeModel({
        mode: 'auto',
        requirements: { required: { text: true } },
        context: { agentId: agent.id }
      });
      return {
        providerModelAdapter: resolved.modelAdapter,
        modelInfo: {
          model: resolved.selection.selected.modelId,
          connectionId: resolved.selection.selected.connectionId
        },
        connection: { id: resolved.selection.selected.connectionId }
      };
    }
  };
  const contextFactory = createExecutionContextFactory({
    runManager,
    getTool: getBuiltin,
    store,
    permissionEngine: permissions,
    pathSecurity,
    projectMutationLock: projectLock,
    nativeModelContextResolver: nativeResolver
  });
  const hub = createAgentHub({
    registry: agentRegistry,
    router: createAgentRouter({ registry: agentRegistry }),
    healthManager: createHealthManager({ registry: agentRegistry }),
    lifecycleManager: lifecycle,
    runBridge: createRunBridge({ runManager, lifecycleManager: lifecycle }),
    projectLock,
    contextFactory
  });
  const nativeAdapter = new NativeAgentAdapter({ manifest: NATIVE_MAIN, runMainAgentFn: runMainAgent });
  hub.register(nativeAdapter);
  const factory = createAgentFactory({
    getTool: name => workflowGetTool(name),
    resolveRuntimeModel: runtimeResolver.resolveRuntimeModel,
    bindRouteDecisionToRun: routeAudit.bindRunIdentity,
    availableToolNames: () => ['read_file', 'search', 'git_diff', 'write_file'],
    hookEngine,
    skillResolver
  });
  setAgentHub(hub);
  setDynamicAgentRuntime(factory, store.agentDefinitions);

  const dynamicDefinition = store.agentDefinitions.create({
    id: 'workflow-reviewer',
    name: 'Workflow Reviewer',
    role: 'reviewer',
    systemPrompt: 'Review the supplied workflow context.',
    runtime: { kind: 'native' },
    capabilities: ['review'],
    toolPolicy: { allow: ['read_file', 'search', 'git_diff'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'auto', requirements: { required: { text: true } } },
    skills: { required: [], optional: [] },
    hooks: { required: [], optional: [] },
    lifetime: 'run',
    budgets: { maxIterations: 3, maxToolCalls: 2, maxRuntimeMs: 3000 },
    canDelegate: false
  });
  const securityDefinition = store.agentDefinitions.create({
    id: 'workflow-security-writer',
    name: 'Workflow Security Writer',
    role: 'writer',
    systemPrompt: 'Exercise the frozen authority chain.',
    runtime: { kind: 'native' },
    capabilities: ['coding'],
    toolPolicy: { allow: ['write_file'], deny: [] },
    permissionPolicy: { readOnly: false, allow: ['filesystem.read', 'filesystem.write'], deny: [] },
    modelPolicy: { mode: 'auto', requirements: { required: { text: true } } },
    skills: { required: ['workflow-write-request'], optional: [] },
    hooks: { required: ['workflow-security-write'], optional: [] },
    lifetime: 'run',
    budgets: { maxIterations: 3, maxToolCalls: 2, maxRuntimeMs: 3000 },
    canDelegate: false
  });

  let readExec = 0;
  let writeExec = 0;
  let flakyAttempts = 0;
  const workflowGetTool = name => {
    if (name === 'read_file') {
      const base = getBuiltin(name);
      return { ...base, exec: async (...args) => { readExec++; return base.exec(...args); } };
    }
    if (name === 'write_file') {
      const base = getBuiltin(name);
      return { ...base, exec: async (...args) => { writeExec++; return base.exec(...args); } };
    }
    if (name === 'workflow_flaky') {
      return {
        name,
        permission: 'filesystem.read',
        async exec() {
          flakyAttempts++;
          if (flakyAttempts === 1) throw new Error('transient fixture error');
          return { ok: true, data: { attempts: flakyAttempts } };
        }
      };
    }
    return getBuiltin(name);
  };
  const workflowEngine = createWorkflowEngine({
    definitionStore: store.workflowDefinitions,
    executionStore: store.workflowExecutions,
    stepStore: store.workflowStepExecutions,
    auditStore: store.workflowAudit,
    agentHub: hub,
    dynamicAgentFactory: factory,
    agentDefinitionStore: store.agentDefinitions,
    getTool: workflowGetTool,
    hookEngine,
    pathSecurity,
    projectLock,
    store,
    createPermissionEngine: () => permissions
  });
  const productEntry = createProductEntry({
    mainAgentService: { run() {}, stop() {} },
    workflowRuntime: workflowEngine.runtime,
    generatorService: { generate() {}, validate() {}, save() {}, cancel() {} }
  });

  class LongAgent {
    constructor() {
      this.id = 'workflow-long-agent';
      this.available = true;
      this.disabled = false;
      this.adapterType = 'fixture';
      this.transport = 'fixture';
      this.capabilities = ['review'];
      this.manifest = {
        id: this.id,
        displayName: 'Long Agent',
        transport: 'fixture',
        capabilities: { review: true },
        availability: true,
        maxConcurrency: 1
      };
      this.contexts = new Map();
      this.cancelCount = 0;
    }
    async detect() { return { available: true }; }
    async healthCheck() { return { status: 'healthy', latencyMs: 0 }; }
    async startTask(_task, context) {
      this.contexts.set(context.runId, context);
      return { runId: context.runId };
    }
    async cancel() { this.cancelCount++; return { ok: true }; }
  }
  const longAgent = new LongAgent();
  hub.register(longAgent);

  try {
    // Scenario A: Main -> real Tool -> Dynamic reviewer + Skill + Hook -> condition.
    workflowEngine.registry.create(workflow('scenario-a', [
      {
        id: 'main',
        type: 'agent',
        config: { goal: 'Inspect project', target: { mode: 'main' }, readOnly: true }
      },
      {
        id: 'read',
        type: 'tool',
        dependsOn: ['main'],
        config: { toolName: 'read_file', args: { path: 'safe.txt' } }
      },
      {
        id: 'review',
        type: 'agent',
        dependsOn: ['read'],
        config: {
          goal: 'Review the inspected file',
          target: { mode: 'dynamic', agentDefinitionId: dynamicDefinition.id },
          skillIds: ['readonly-code-review'],
          hookIds: ['workflow-context'],
          readOnly: true
        }
      },
      {
        id: 'condition',
        type: 'condition',
        dependsOn: ['review'],
        config: { source: 'steps.review.status', operator: 'eq', value: 'completed' }
      }
    ], { reviewed: '$' + '{steps.condition.output.result}' }));
    const aStart = await productEntry.workflow.run('scenario-a', { projectRoot, projectId });
    const a = await workflowEngine.runtime.wait(aStart.workflowRunId);
    assert.strictEqual(a.status, 'COMPLETED');
    assert.strictEqual(readExec, 1);
    const mainStep = a.steps.find(step => step.stepId === 'main');
    const reviewStep = a.steps.find(step => step.stepId === 'review');
    assert.ok(mainStep.runId && runManager.getRun(mainStep.runId));
    assert.ok(reviewStep.childRunId && runManager.getRun(reviewStep.childRunId));
    assert.notStrictEqual(mainStep.runId, 'main');
    assert.notStrictEqual(reviewStep.childRunId, 'review');
    assert.ok(providerCaptures.some(capture => capture.system.includes('Act as a strict read-only code reviewer.')));
    assert.ok(providerCaptures.some(capture => capture.system.includes(HOOK_MARKER)));
    assert.ok(selectedModels.every(model => model === 'workflow-model'));
    assert.ok(providerCaptures.every(capture => capture.model === 'workflow-model'));
    assert.strictEqual(a.output.reviewed, true);

    // A Workflow declaration cannot make an unavailable Skill capability appear.
    const beforeUnavailableSkill = providerCounter.calls;
    workflowEngine.registry.create(workflow('unavailable-skill', [{
      id: 'review',
      type: 'agent',
      config: {
        goal: 'Must fail before starting',
        target: { mode: 'dynamic', agentDefinitionId: dynamicDefinition.id },
        skillIds: ['workflow-unavailable-tool'],
        readOnly: true
      }
    }]));
    const unavailableStart = await workflowEngine.runtime.run('unavailable-skill', { projectRoot, projectId });
    const unavailable = await workflowEngine.runtime.wait(unavailableStart.workflowRunId);
    assert.strictEqual(unavailable.status, 'FAILED');
    assert.strictEqual(providerCounter.calls, beforeUnavailableSkill);
    assert.match(unavailable.errorCode, /^SKILL_/);

    // Scenario B: denied write fails before the tool implementation and is not retried.
    workflowEngine.registry.create(workflow('scenario-b', [{
      id: 'write',
      type: 'tool',
      config: { toolName: 'write_file', args: { path: 'denied.txt', content: 'no' } },
      retry: { maxAttempts: 3 }
    }]));
    const bStart = await workflowEngine.runtime.run('scenario-b', { projectRoot, projectId });
    const b = await workflowEngine.runtime.wait(bStart.workflowRunId);
    assert.strictEqual(b.status, 'FAILED');
    assert.strictEqual(b.errorCode, 'PERMISSION_DENIED');
    assert.strictEqual(writeExec, 0);
    assert.strictEqual(b.steps[0].attempt, 1);

    // Full adversarial chain: Workflow -> Dynamic -> Skill -> Hook -> write_file.
    // The Parent deny remains the final ceiling and the implementation is never called.
    workflowEngine.registry.create(workflow('security-chain', [{ id: 'security-child', type: 'agent', config: {
      goal: 'Attempt the requested write and then report the denial.',
      target: { mode: 'dynamic', agentDefinitionId: securityDefinition.id },
      skillIds: ['workflow-write-request'],
      hookIds: ['workflow-security-write'],
      readOnly: false
    } }]));
    const securityStart = await productEntry.workflow.run('security-chain', { projectRoot, projectId });
    const security = await workflowEngine.runtime.wait(securityStart.workflowRunId);
    assert.strictEqual(security.status, 'COMPLETED');
    assert.strictEqual(writeExec, 0);
    assert.strictEqual(securityHookCalls, 1);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, 'security-denied.txt')), false);

    // Outside-workspace paths still fail in the existing PathSecurity gate.
    workflowEngine.registry.create(workflow('outside-path', [{
      id: 'outside',
      type: 'tool',
      config: { toolName: 'read_file', args: { path: '../outside.txt' } }
    }]));
    const outsideStart = await workflowEngine.runtime.run('outside-path', { projectRoot, projectId });
    const outside = await workflowEngine.runtime.wait(outsideStart.workflowRunId);
    assert.strictEqual(outside.status, 'FAILED');
    assert.strictEqual(outside.errorCode, 'PATH_OUTSIDE_WORKSPACE');

    // Scenario C: before_model blocks the real Main runtime before provider wire.
    const beforeBlockCalls = providerCounter.calls;
    workflowEngine.registry.create(workflow('scenario-c', [{
      id: 'blocked',
      type: 'agent',
      config: {
        goal: 'Must be blocked',
        target: { mode: 'main' },
        hookIds: ['workflow-block-model'],
        readOnly: true
      }
    }]));
    const cStart = await workflowEngine.runtime.run('scenario-c', { projectRoot, projectId });
    const c = await workflowEngine.runtime.wait(cStart.workflowRunId);
    assert.strictEqual(c.status, 'FAILED');
    assert.strictEqual(providerCounter.calls, beforeBlockCalls);

    // before_tool uses the same Hook Engine and leaves the implementation count unchanged.
    workflowEngine.registry.create(workflow('tool-hook-block', [
      {
        id: 'main',
        type: 'agent',
        config: { goal: 'Create a real run identity', target: { mode: 'main' }, readOnly: true }
      },
      {
        id: 'blocked-read',
        type: 'tool',
        dependsOn: ['main'],
        config: { toolName: 'read_file', args: { path: 'safe.txt' }, hookIds: ['workflow-block-tool'] }
      }
    ]));
    const readBeforeBlock = readExec;
    const toolBlockStart = await workflowEngine.runtime.run('tool-hook-block', { projectRoot, projectId });
    const toolBlock = await workflowEngine.runtime.wait(toolBlockStart.workflowRunId);
    assert.strictEqual(toolBlock.status, 'FAILED');
    assert.strictEqual(toolBlock.errorCode, 'HOOK_BLOCKED');
    assert.strictEqual(readExec, readBeforeBlock);
    const blockedHookAudit = store.hookInvocations.list(100)
      .find(row => row.hook_id === 'workflow-block-tool' &&
        row.workflow_run_id === toolBlockStart.workflowRunId && row.workflow_step_id === 'blocked-read');
    assert.ok(blockedHookAudit);
    assert.strictEqual(blockedHookAudit.run_id, null);
    assert.strictEqual(blockedHookAudit.root_run_id, null);
    assert.strictEqual(blockedHookAudit.parent_run_id, null);
    assert.notStrictEqual(blockedHookAudit.run_id, toolBlock.steps.find(step => step.stepId === 'main').runId);

    // A tool genuinely selected by an AgentLoop keeps the actual Agent Run identity.
    workflowEngine.registry.create(workflow('agent-tool-hook-identity', [{
      id: 'agent-owned-tool',
      type: 'agent',
      config: {
        goal: 'Exercise agent-owned tool hook',
        target: { mode: 'main' },
        hookIds: ['workflow-agent-tool'],
        readOnly: true
      }
    }]));
    const agentToolStart = await workflowEngine.runtime.run('agent-tool-hook-identity', { projectRoot, projectId });
    const agentToolRun = await workflowEngine.runtime.wait(agentToolStart.workflowRunId);
    assert.strictEqual(agentToolRun.status, 'COMPLETED');
    const agentToolStep = agentToolRun.steps.find(step => step.stepId === 'agent-owned-tool');
    assert.ok(agentToolStep.runId && runManager.getRun(agentToolStep.runId));
    const agentToolHookAudit = store.hookInvocations.list(100)
      .find(row => row.hook_id === 'workflow-agent-tool' && row.event === 'before_tool');
    assert.ok(agentToolHookAudit);
    const actualInnerRunId = nativeAdapter._hubRuns.get(agentToolStep.runId) || agentToolStep.runId;
    assert.ok(runManager.getRun(actualInnerRunId));
    assert.strictEqual(agentToolHookAudit.run_id, actualInnerRunId);

    // Scenario D: approval suspends; following tool starts only after approval.
    workflowEngine.registry.create(workflow('scenario-d', [
      { id: 'approval', type: 'approval', config: { message: 'Approve production continuation?' } },
      { id: 'after', type: 'tool', dependsOn: ['approval'], config: { toolName: 'read_file', args: { path: 'safe.txt' } } }
    ]));
    const dStart = await productEntry.workflow.run('scenario-d', { projectRoot, projectId });
    const waiting = await waitStatus(workflowEngine.runtime, dStart.workflowRunId, 'WAITING_APPROVAL');
    const readsWhileWaiting = readExec;
    assert.strictEqual(waiting.steps.find(step => step.stepId === 'after').status, 'PENDING');
    await productEntry.workflow.approve(dStart.workflowRunId);
    const d = await workflowEngine.runtime.wait(dStart.workflowRunId);
    assert.strictEqual(d.status, 'COMPLETED');
    assert.strictEqual(readExec, readsWhileWaiting + 1);

    // Approval timeout owns and clears its waiter; late decisions cannot revive the terminal Workflow.
    workflowEngine.registry.create(workflow('approval-timeout', [
      {
        id: 'approval-timeout',
        type: 'approval',
        config: { message: 'This approval intentionally times out.' },
        timeoutMs: 25,
        retry: { maxAttempts: 3 }
      },
      {
        id: 'never-after-timeout',
        type: 'tool',
        dependsOn: ['approval-timeout'],
        config: { toolName: 'read_file', args: { path: 'safe.txt' } }
      }
    ]));
    const timeoutReadsBefore = readExec;
    const approvalTimeoutStart = await workflowEngine.runtime.run('approval-timeout', { projectRoot, projectId });
    await waitStatus(workflowEngine.runtime, approvalTimeoutStart.workflowRunId, 'WAITING_APPROVAL');
    const approvalTimeoutControl = workflowEngine.runtime.active.get(approvalTimeoutStart.workflowRunId);
    const approvalTimedOut = await workflowEngine.runtime.wait(approvalTimeoutStart.workflowRunId);
    assert.strictEqual(approvalTimedOut.status, 'FAILED');
    assert.strictEqual(approvalTimedOut.errorCode, 'APPROVAL_TIMEOUT');
    assert.strictEqual(approvalTimedOut.steps.find(step => step.stepId === 'approval-timeout').status, 'FAILED');
    assert.strictEqual(approvalTimedOut.steps.find(step => step.stepId === 'approval-timeout').attempt, 1);
    assert.strictEqual(approvalTimeoutControl.approval, null);
    assert.strictEqual(readExec, timeoutReadsBefore);
    await assert.rejects(
      workflowEngine.runtime.approve(approvalTimeoutStart.workflowRunId),
      error => error.code === 'WORKFLOW_NOT_WAITING_APPROVAL'
    );
    await assert.rejects(
      workflowEngine.runtime.reject(approvalTimeoutStart.workflowRunId),
      error => error.code === 'WORKFLOW_NOT_WAITING_APPROVAL'
    );
    assert.strictEqual(workflowEngine.runtime.getRun(approvalTimeoutStart.workflowRunId).status, 'FAILED');
    assert.strictEqual(readExec, timeoutReadsBefore);

    // Scenario E: cancel reaches the active AgentHub adapter; pending stays at zero,
    // and a late completion cannot overwrite the workflow terminal.
    workflowEngine.registry.create(workflow('scenario-e', [
      {
        id: 'long',
        type: 'agent',
        config: { goal: 'Long running', target: { mode: 'hub', agentId: longAgent.id }, readOnly: true }
      },
      { id: 'never', type: 'tool', dependsOn: ['long'], config: { toolName: 'read_file', args: { path: 'safe.txt' } } }
    ]));
    const readsBeforeCancel = readExec;
    const eStart = await productEntry.workflow.run('scenario-e', { projectRoot, projectId });
    await new Promise(resolve => setTimeout(resolve, 30));
    const activeContext = [...longAgent.contexts.values()][0];
    await productEntry.workflow.cancel(eStart.workflowRunId);
    assert.strictEqual(longAgent.cancelCount, 1);
    activeContext.finishRun('completed', { summary: 'late result' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const e = workflowEngine.runtime.getRun(eStart.workflowRunId);
    assert.strictEqual(e.status, 'CANCELLED');
    assert.strictEqual(readExec, readsBeforeCancel);
    assert.strictEqual(e.steps.find(step => step.stepId === 'never').status, 'CANCELLED');

    // Scenario F: transient tool error retries exactly once and completes.
    workflowEngine.registry.create(workflow('scenario-f', [{
      id: 'flaky',
      type: 'tool',
      config: { toolName: 'workflow_flaky', args: {} },
      retry: { maxAttempts: 2 }
    }]));
    const fStart = await workflowEngine.runtime.run('scenario-f', { projectRoot, projectId });
    const f = await workflowEngine.runtime.wait(fStart.workflowRunId);
    assert.strictEqual(f.status, 'COMPLETED');
    assert.strictEqual(flakyAttempts, 2);
    assert.strictEqual(f.steps[0].attempt, 2);

    const audits = store.workflowAudit.list(500);
    assert.ok(audits.length > 0);
    assert.ok(audits.every(row => row.workflow_run_id));
    assert.doesNotMatch(JSON.stringify(audits), /fixture-placeholder-key|WORKFLOW_OUTSIDE_SENTINEL|Authorization|Cookie/i);
    assert.strictEqual(runManager.list().some(run => run.agentId === 'workflow'), false);
    const hookRows = store.hookInvocations.list(100);
    assert.ok(hookRows.filter(row => row.hook_id === 'workflow-block-tool')
      .every(row => row.run_id === null && row.workflow_run_id && row.workflow_step_id === 'blocked-read'));
    assert.ok(hookRows.filter(row => row.hook_id === 'workflow-agent-tool')
      .every(row => row.run_id && runManager.getRun(row.run_id)));
    assert.strictEqual(factory.listInstances().length, 0);
    console.log(
      'WORKFLOW_PRODUCTION fakeProviderCalls=' + providerCounter.calls +
      ' paidProviderCalls=0 selectedModel=workflow-model wireModel=workflow-model'
    );
  } finally {
    setAgentHub(previousHub);
    setDynamicAgentRuntime(previousDynamic.factory, previousDynamic.definitionStore);
    setHookRuntime(previousHook);
    setSkillRuntime(previousSkill.registry, previousSkill.resolver);
    try { pathSecurity.clearRootCache(); } catch { /* best effort */ }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
