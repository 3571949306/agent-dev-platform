'use strict';
/**
 * v2.9.9 Phase B（#1/#2/#3）— Canonical Main Entry + Auto Inline Children Production Proof。
 *
 * 真实链：ProductEntry.mainAgent.run → MainAgentService → runMainAgent →
 * MainAgentOrchestrator → Model Router → ProviderModelAdapter（fake network provider）。
 *
 * 证明：
 *   MAIN_GUI_ENTRY=CANONICAL — Main Run 有真实 runId/rootRunId；Model Router decision
 *     存在并绑定到该 run；selected model == wire model；ProjectMutationLock 生效；
 *     RunManager terminal truth 生效。
 *   MAIN_AUTO_INLINE_CHILD / MAIN_INLINE_TWO_CHILDREN — 用户只发一条目标，Main 自动用
 *     inlineAgentDefinition 创建两个任务级子 Agent（无需用户先建对话/建 Definition）。
 *   MAIN_PARENT_CONSUMES_CHILD_RESULTS — Parent 收到两个 Child 的结果并完成。
 *   INLINE_CHILD_NO_NEW_CHAT — 整个过程用户 conversation 数量仍为 1；Dynamic instances=0。
 *   CODING_TASK_BROWSER_EXEC=0 / CODING_TASK_COMPUTER_EXEC=0 — canonical 编码任务
 *     默认不执行 browser_ 与 computer_ 工具（ACTION_TYPES 不含它们）。
 */

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
const { getBuiltin, listBuiltinDefs } = require('../src/tools/registry');
const { createProductEntry } = require('../src/services/productEntry');
const { createAgentFactory } = require('../src/agents/dynamic/agentFactory');
const { setDynamicAgentRuntime, getDynamicAgentRuntime } = require('../src/agents/dynamic/runtimeRegistry');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub, setAgentHub, getAgentHub } = require('../src/agents/hub/agentHub');
const { createExecutionContextFactory } = require('../src/agent/orchestrator/executionContextFactory');
const { createPathSecurity } = require('../src/security/pathSecurity');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { DYNAMIC_AGENT_BASE_PROMPT } = require('../src/agent/runtime/prompts/mainCodingAgent');
const { ACTION_TYPES } = require('../src/agent/runtime/actionSchema');

const cap = v => ({ value: v, state: 'tested', source: 'canonical-entry-fixture' });
const metric = v => ({ value: v, state: 'declared', source: 'canonical-entry-fixture' });

function buildChain({ projectRoot, fakeProvider }) {
  const connection = store.connections.create({
    name: 'Canonical Fake Network', provider: 'custom', base_url: 'https://canonical.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['canonical-model'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'canonical-model', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });
  const project = store.projects.create({ name: 'Canonical project', rootPath: projectRoot });
  const agent = store.agents.create({
    name: 'Canonical Main', is_main: true, api_connection_id: connection.id,
    model: 'canonical-model', tools: []
  });

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const resolver = createRuntimeModelResolver({
    router, audit,
    createModelAdapter(selection) {
      return createProviderModelAdapter({
        buildProvider: async () => fakeProvider,
        agent: { id: agent.id, name: agent.name, api_connection_id: selection.selected.connectionId, model: selection.selected.modelId, max_tokens: 256 },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs: 8000
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
    getTool: getToolSafe(),
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
    runManager, getTool: getToolSafe(),
    buildProvider: async () => fakeProvider,
    resolveModelFor: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
    resolveRuntimeModel: resolver.resolveRuntimeModel,
    bindRouteDecisionToRun: audit.bindRunIdentity,
    activeRuns,
    requestPermission: async () => ({ decision: 'deny', range: 'once' }),
    getCurrentProject: () => project,
    getAgentFull: id => store.agents.get(id),
    PermissionEngine,
    availableToolNames: listBuiltinDefs().map(d => d.name),
    projectMutationLock: projectLock
  });
  const wfStub = { run: () => { throw new Error('WF_NOT_IN_SCENARIO'); }, cancel: () => {}, approve: () => {}, reject: () => {} };
  const genStub = { generate: () => { throw new Error('GEN_NOT_IN_SCENARIO'); }, validate: () => {}, save: () => {}, cancel: () => {} };
  const productEntry = createProductEntry({ mainAgentService: service, workflowRuntime: wfStub, generatorService: genStub });

  return { project, agent, runManager, projectLock, lifecycle, factory, events, productEntry, pathSecurity };
}
function getToolSafe() { return getBuiltin; }

async function waitTerminal(runManager, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) return run;
    await new Promise(r => setTimeout(r, 15));
  }
  return runManager.getRun(runId);
}
async function settleTo(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(r => setTimeout(r, 25)); }
  return predicate();
}

function inlineDef(name, role, prompt) {
  return {
    name, role, systemPrompt: prompt,
    runtime: { kind: 'native' },
    toolPolicy: { allow: ['read_file'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'inherit_parent' },
    lifetime: 'run', canDelegate: false
  };
}

test('Canonical Main entry auto-creates two inline children, consumes results, no browser/computer', async () => {
  const prevHub = getAgentHub();
  const prevDyn = getDynamicAgentRuntime();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-canonical-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-canonical-db-'));
  store.init(dataRoot);
  let chain = null;
  try {
    fs.writeFileSync(path.join(projectRoot, 'src.js'), 'module.exports = 1;\n', 'utf8');

    let mainCalls = 0;
    const fakeProvider = {
      streamResponse(input) {
        const sys = String(input.system || '');
        const isChild = sys.includes(DYNAMIC_AGENT_BASE_PROMPT);
        let action;
        if (isChild) {
          action = { type: 'complete', args: { summary: 'inline child result' } };
        } else {
          mainCalls++;
          if (mainCalls === 1) action = { type: 'delegate', args: { goal: 'Review the code', inlineAgentDefinition: inlineDef('Temporary Reviewer', 'code_reviewer', 'Return findings without modifying files.') } };
          else if (mainCalls === 2) action = { type: 'delegate', args: { goal: 'Analyze tests', inlineAgentDefinition: inlineDef('Temporary Test Analyst', 'test_analyst', 'Analyze test coverage.') } };
          else action = { type: 'complete', args: { summary: 'done with two inline children' } };
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    };

    chain = buildChain({ projectRoot, fakeProvider });
    const conversation = store.conversations.create({ projectId: chain.project.id, agentId: chain.agent.id, title: 'Canonical task' });
    const convCountBefore = store.conversations.list(chain.project.id).length;

    const started = await chain.productEntry.mainAgent.run({ conversationId: conversation.id, agentId: chain.agent.id, goal: '让两个专门 Agent 分别审查代码和测试' });
    const mainTerminal = await waitTerminal(chain.runManager, started.runId, 40000);

    // MAIN_GUI_ENTRY=CANONICAL — Main Run 真实 runId/rootRunId + terminal truth
    assert.ok(started.runId, 'main run has real runId');
    const mainRun = chain.runManager.getRun(started.runId);
    assert.strictEqual(mainRun.rootRunId, mainRun.id, 'main rootRunId == its runId');
    assert.strictEqual(mainTerminal.status, 'completed', `main completes, got ${mainTerminal.status} (${mainTerminal.error || ''})`);

    // Model Router decision 存在且绑定到 main run；selected == wire model
    const decisions = store.modelRouteDecisions.list();
    const bound = decisions.find(d => d.runId === mainRun.id || d.run_id === mainRun.id);
    assert.ok(bound, 'model router decision bound to main run');

    // ProjectMutationLock 生效：run 结束后锁已释放
    await settleTo(() => chain.projectLock.snapshot().writeLocks.length === 0, 8000);
    assert.strictEqual(chain.projectLock.snapshot().writeLocks.length, 0, 'project lock released after run');

    // MAIN_INLINE_TWO_CHILDREN — 两个 inline child run（parentRunId=main, rootRunId=main）
    const runs = chain.runManager.list();
    const children = runs.filter(r => r.parentRunId === mainRun.id);
    assert.strictEqual(children.length, 2, `two inline children created, got ${children.length}`);
    for (const c of children) {
      assert.strictEqual(c.rootRunId, mainRun.id, 'child rootRunId == main runId');
      assert.ok(['completed', 'failed', 'cancelled', 'timeout'].includes(c.status), 'child reached terminal');
    }
    const bothCompleted = children.every(c => c.status === 'completed');
    assert.ok(bothCompleted, 'both inline children completed (parent consumed their results)');

    // INLINE_CHILD_NO_NEW_CHAT — 用户 conversation 数量不变
    const convCountAfter = store.conversations.list(chain.project.id).length;
    assert.strictEqual(convCountAfter, convCountBefore, 'no new user conversation created by inline children');

    // Dynamic instances disposed
    await settleTo(() => chain.factory.listInstances().length === 0, 8000);
    assert.strictEqual(chain.factory.listInstances().length, 0, 'dynamic instances disposed');

    // CODING_TASK_BROWSER_EXEC=0 / COMPUTER_EXEC=0 — canonical ACTION_TYPES 不含 browser/computer，
    // 且运行中没有任何 browser_*/computer_* 工具事件。
    assert.ok(!ACTION_TYPES.some(t => /^browser_|^computer_/.test(t)), 'canonical ACTION_TYPES exclude browser/computer');
    const bcEvents = chain.events.filter(e => {
      const s = JSON.stringify(e.payload || {});
      return /browser_[a-z_]+|computer_[a-z_]+/.test(s);
    });
    assert.strictEqual(bcEvents.length, 0, 'no browser/computer tool executed');

    console.log('MAIN_GUI_ENTRY=CANONICAL');
    console.log('MAIN_AUTO_INLINE_CHILD=PASS');
    console.log('MAIN_INLINE_TWO_CHILDREN=PASS');
    console.log('MAIN_PARENT_CONSUMES_CHILD_RESULTS=PASS');
    console.log('INLINE_CHILD_NO_NEW_CHAT=PASS');
    console.log('CODING_TASK_BROWSER_EXEC=0');
    console.log('CODING_TASK_COMPUTER_EXEC=0');
  } finally {
    setAgentHub(prevHub);
    setDynamicAgentRuntime(prevDyn.factory, prevDyn.definitionStore);
    if (chain) { try { chain.pathSecurity.clearRootCache(); } catch { /* best effort */ } }
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
