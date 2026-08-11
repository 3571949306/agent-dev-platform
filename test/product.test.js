'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { createProductEntry } = require('../src/services/productEntry');
const { recoverInterruptedRuntime } = require('../src/services/runtimeRecovery');
const { createProductDiagnostics } = require('../src/services/productDiagnostics');
const { createModelCatalog } = require('../src/models/router');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');

test('product entry is a thin facade over frozen application services', async () => {
  const calls = [];
  const entry = createProductEntry({
    mainAgentService: {
      run: input => { calls.push(['main.run', input]); return { runId: 'real-run' }; },
      stop: input => { calls.push(['main.stop', input]); return { stopped: true }; }
    },
    workflowRuntime: {
      run: (...args) => { calls.push(['workflow.run', ...args]); return { workflowRunId: 'workflow-run' }; },
      cancel: id => { calls.push(['workflow.cancel', id]); return true; },
      approve: id => { calls.push(['workflow.approve', id]); return true; },
      reject: id => { calls.push(['workflow.reject', id]); return true; }
    },
    generatorService: {
      generate: request => { calls.push(['generator.generate', request]); return { draftId: 'draft' }; },
      validate: id => { calls.push(['generator.validate', id]); return true; },
      save: id => { calls.push(['generator.save', id]); return true; },
      cancel: id => { calls.push(['generator.cancel', id]); return true; }
    }
  });

  assert.deepStrictEqual(entry.mainAgent.run({ goal: 'x' }), { runId: 'real-run' });
  assert.deepStrictEqual(entry.workflow.run('wf', { value: 1 }), { workflowRunId: 'workflow-run' });
  assert.deepStrictEqual(entry.generator.generate({ artifactType: 'skill' }), { draftId: 'draft' });
  assert.strictEqual(entry.generator.save('draft'), true);
  assert.deepStrictEqual(calls.map(item => item[0]), ['main.run', 'workflow.run', 'generator.generate', 'generator.save']);
});

test('cold-start recovery terminates stale Agent, Workflow, approval, and Generator state', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-recovery-'));
  store.init(dataRoot);
  try {
    const oldManager = new RunManager({ store });
    const run = oldManager.createRun({ conversationId: 'stale-conversation', agentId: 'native-main' });
    oldManager.updateRun(run.id, 'requesting_model');

    store.workflowDefinitions.create({
      schemaVersion: 1,
      id: 'stale-workflow',
      name: 'Stale workflow',
      description: '',
      inputs: {},
      steps: [{ id: 'approval', type: 'approval', dependsOn: [], config: { message: 'Approve?' } }],
      outputs: {},
      limits: { maxSteps: 4, maxRuntimeMs: 1000 },
      metadata: {}
    });
    store.workflowExecutions.create({ workflowRunId: 'workflow-stale-run', workflowId: 'stale-workflow', status: 'WAITING_APPROVAL' });
    store.workflowStepExecutions.create({ workflowRunId: 'workflow-stale-run', stepId: 'approval', stepType: 'approval', status: 'WAITING_APPROVAL' });
    store.generatorDrafts.create({
      draftId: 'generator-stale-draft', generationId: 'generation-stale', artifactType: 'skill',
      status: 'GENERATING', candidate: null, validation: { valid: false, errors: [], warnings: [] }
    });

    const newManager = new RunManager({ store });
    const recovered = recoverInterruptedRuntime({ store, runManager: newManager, now: () => '2026-08-11T00:00:00.000Z' });
    assert.deepStrictEqual(recovered, { runs: 1, workflows: 1, workflowSteps: 1, generatorDrafts: 1 });
    assert.strictEqual(store.runs.get(run.id).status, 'interrupted');
    assert.strictEqual(store.workflowExecutions.get('workflow-stale-run').status, 'FAILED');
    assert.strictEqual(store.workflowExecutions.get('workflow-stale-run').errorCode, 'WORKFLOW_INTERRUPTED');
    assert.strictEqual(store.workflowStepExecutions.get('workflow-stale-run', 'approval').status, 'CANCELLED');
    assert.strictEqual(store.generatorDrafts.get('generator-stale-draft').status, 'FAILED');
    assert.strictEqual(store.generatorDrafts.get('generator-stale-draft').errorCode, 'GENERATOR_INTERRUPTED');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('product diagnostics never turns unknown evidence into READY or AVAILABLE', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-diagnostics-'));
  store.init(dataRoot);
  try {
    const connection = store.connections.create({
      name: 'Untested fixture', provider: 'custom', base_url: 'https://diagnostics.invalid/v1',
      api_key: 'fixture-placeholder-key', models: ['diagnostics-model'], enabled: true
    });
    store.agents.create({ name: 'Main', is_main: true, api_connection_id: connection.id, model: 'diagnostics-model' });
    const lock = createProjectMutationLock();
    const registry = { list: () => [{ id: 'missing-cli', manifest: { displayName: 'Missing CLI', transport: 'cli' } }] };
    const healthManager = { checkAll: async () => new Map(), getStatus: () => null };
    const diagnostics = createProductDiagnostics({
      version: '2.9.6', store, getDb: store.getDb,
      modelCatalog: createModelCatalog({ store }),
      dynamicAgentFactory: { createInstance() {}, disposeInstance() {}, listInstances: () => [] },
      skillRegistry: { list: () => [] }, hookEngine: { registry: { list: () => [] } },
      workflowEngine: { registry: { list: () => [] } },
      generatorEngine: { service: { generate() {}, save() {} } },
      computerManager: { listWindows: async () => ({ ok: true, windows: [] }) },
      browserManager: { status: () => ({ installed: true, launched: false, available: null, engine: null }) },
      mcpManager: { clients: new Map() }, agentRegistry: registry, healthManager, projectLock: lock
    });
    const unknown = await diagnostics.inspect();
    assert.strictEqual(unknown.database.status, 'OK');
    assert.strictEqual(unknown.modelConnections.unknown, 1);
    assert.strictEqual(unknown.modelRouter.status, 'DEGRADED');
    assert.strictEqual(unknown.mainAgent.status, 'UNKNOWN');
    assert.strictEqual(unknown.browser.status, 'UNKNOWN');
    assert.strictEqual(unknown.externalAgents[0].status, 'UNKNOWN');
    assert.strictEqual(JSON.stringify(unknown).includes('fixture-placeholder-key'), false);

    store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
    const proven = await diagnostics.inspect({ probeExternal: false });
    assert.strictEqual(proven.modelConnections.available, 1);
    assert.strictEqual(proven.modelRouter.status, 'READY');
    assert.strictEqual(proven.mainAgent.status, 'READY');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('application shutdown is bounded and clears owned controllers, approvals, MCP, and project locks', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-product-shutdown-'));
  store.init(dataRoot);
  const originalLoad = Module._load;
  const electronMock = {
    ipcMain: { handle() {}, removeHandler() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { showItemInFolder() {}, openExternal() {} },
    app: { getPath: () => dataRoot, getVersion: () => '2.9.6' }
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.apply(this, arguments);
  };
  let handlers;
  try {
    handlers = require('../src/ipc/handlers');
  } finally {
    Module._load = originalLoad;
  }

  try {
    const internals = handlers._internals;
    const controller = new AbortController();
    internals.activeRuns.set('shutdown-conversation', controller);
    let approvalDecision = null;
    internals.pendingPermissions.set('shutdown-approval', decision => { approvalDecision = decision; });
    const locked = internals.projectLock.acquireWrite(dataRoot, 'shutdown-run', 'native-main');
    assert.strictEqual(locked.ok, true);
    let mcpDisconnected = false;
    internals.mcpManager.clients.set('shutdown-mcp', {
      connected: true,
      disconnect() { this.connected = false; mcpDisconnected = true; }
    });

    const result = await handlers.shutdownServices();
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(controller.signal.aborted, true);
    assert.strictEqual(approvalDecision.decision, 'deny');
    assert.strictEqual(internals.activeRuns.size, 0);
    assert.strictEqual(internals.pendingPermissions.size, 0);
    assert.strictEqual(internals.mcpManager.clients.size, 0);
    assert.strictEqual(mcpDisconnected, true);
    assert.deepStrictEqual(internals.projectLock.snapshot(), { writeLocks: [], readLocks: [] });
    assert.strictEqual(internals.dynamicAgentFactory.listInstances().length, 0);
    assert.strictEqual(internals.workflowEngine.runtime.active.size, 0);
    assert.strictEqual(internals.generatorEngine.service.active.size, 0);
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
