'use strict';
/**
 * v2.9.9 Phase B Final — B20 Diagnostics / Product Health Center 契约测试。
 *
 * 机器证明：
 *   HEALTH_SECTIONS=PASS            所有子系统区段齐备（Status/Reason/LastChecked）
 *   DIAGNOSTICS_FALSE_READY=0       未测试连接绝不显示 AVAILABLE/READY
 *   RUNTIME_RESIDUE_TRUTH=PASS      残留计数全部来自真实 backend
 *   SELF_TEST_ZERO_PAID_CALLS=PASS  自检 safe/bounded/0 paid calls
 *   PROBLEM_INTEGRATION=PASS        mismatch/DB/stale run 进 Problems Center
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('../src/db/store');
const { createModelCatalog } = require('../src/models/router');
const { createProductDiagnostics } = require('../src/services/productDiagnostics');
const { createProblemCenter } = require('../src/services/problemCenter');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-health-'));
store.init(DATA_ROOT);

function buildDiagnostics(extra = {}) {
  const events = [];
  const problemCenter = createProblemCenter({ store, emit: (type, payload) => events.push({ type, payload }) });
  const registry = { list: () => [] };
  const healthManager = { checkAll: async () => new Map(), getStatus: () => null };
  const diagnostics = createProductDiagnostics({
    version: '2.9.9', store, getDb: store.getDb,
    modelCatalog: createModelCatalog({ store }),
    dynamicAgentFactory: { createInstance() {}, disposeInstance() {}, listInstances: () => [] },
    skillRegistry: { list: () => [] }, hookEngine: { registry: { list: () => [] } },
    workflowEngine: { registry: { list: () => [] }, runtime: { listRuns: () => [] } },
    generatorEngine: { service: { generate() {}, save() {}, listDrafts: () => [] } },
    computerManager: { listWindows: async () => ({ ok: true, windows: [] }), activeCount: () => 0 },
    browserManager: { status: () => ({ installed: true, launched: false, available: null, engine: null }) },
    mcpManager: { clients: new Map() }, agentRegistry: registry, healthManager,
    projectLock: createProjectMutationLock(),
    pendingPermissions: new Map(),
    workflowRuntime: { listRuns: () => [], run: () => {} },
    agentHub: { detect: async () => [] },
    terminalManager: { activeCount: () => 0 },
    runManager: { list: () => [] },
    problemCenter,
    getCurrentProject: () => null,
    ...extra
  });
  return { diagnostics, problemCenter, events };
}

test('B20 health center sections + no fake READY for untested connections', async () => {
  // 从未测试的连接：必须 UNKNOWN，绝不因为「没报错」显示 AVAILABLE
  store.connections.create({ name: 'Health Untested', provider: 'custom', base_url: 'https://health.invalid/v1', api_key: 'fixture' });
  const { diagnostics } = buildDiagnostics();
  const report = await diagnostics.inspect({ probeExternal: false, probeComputer: false });

  for (const section of ['application', 'database', 'project', 'modelConnections', 'modelRouter', 'mainAgent',
    'skills', 'hooks', 'workflows', 'generator', 'permissionEngine', 'workflowRuntime', 'agentHub',
    'terminal', 'processes', 'computerUse', 'browser', 'mcp', 'projectLock', 'runtimeResidue']) {
    assert.ok(report[section], `section ${section} present`);
  }
  assert.strictEqual(report.modelConnections.unknown, 1, 'untested connection stays UNKNOWN');
  assert.strictEqual(report.modelConnections.available, 0, 'untested connection never AVAILABLE');
  assert.strictEqual(report.mainAgent.status === 'READY', false, 'main agent never fake READY');
  assert.ok(report.application.lastCheckedAt, 'last checked recorded');
  console.log('HEALTH_SECTIONS=PASS');
  console.log('DIAGNOSTICS_FALSE_READY=0');
});

test('B20.1 runtime residue truth comes from real backends', async () => {
  const { diagnostics } = buildDiagnostics({
    terminalManager: { activeCount: () => 3 },
    runManager: {
      list: () => [
        { id: 'r-running', status: 'executing_tool', lastActivityAt: new Date().toISOString() },
        { id: 'r-stale', status: 'requesting_model', lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        { id: 'r-done', status: 'completed', lastActivityAt: new Date().toISOString() }
      ]
    },
    pendingPermissions: new Map([['p1', () => {}], ['p2', () => {}]]),
    dynamicAgentFactory: { createInstance() {}, disposeInstance() {}, listInstances: () => [{}, {}] },
    generatorEngine: { service: { generate() {}, save() {}, listDrafts: () => [{ status: 'GENERATING' }, { status: 'READY' }] } }
  });
  const report = await diagnostics.inspect({ probeExternal: false, probeComputer: false });
  const residue = report.runtimeResidue;
  assert.strictEqual(residue.activeRuns, 2, 'non-terminal runs counted');
  assert.deepStrictEqual(residue.staleRuns, ['r-stale'], 'stale run identified by real inactivity');
  assert.strictEqual(residue.terminalProcesses, 3);
  assert.strictEqual(residue.pendingPermissions, 2);
  assert.strictEqual(residue.dynamicInstances, 2);
  assert.strictEqual(residue.generatorActive, 1);
  console.log('RUNTIME_RESIDUE_TRUTH=PASS');
});

test('B20.3 problem integration: model mismatch and stale runs flow into Problems Center', async () => {
  // 真实 mismatch 记录（model_calls 真源）
  store.modelCalls.record({
    agentId: 'a1', agentName: 'Main', conversationId: null, taskId: null,
    connectionId: 'c1', connectionName: 'C', provider: 'openai', protocol: 'openai-chat',
    endpoint: '/chat', requestedModel: 'gpt-x', actualModel: 'gpt-substituted',
    modelSource: 'router', fellBack: false, imageParts: 0, latencyMs: 10, ok: true
  });
  const { diagnostics, problemCenter } = buildDiagnostics({
    runManager: { list: () => [{ id: 'stale-run-1', status: 'executing_tool', lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }] }
  });
  const report = await diagnostics.inspect({ probeExternal: false, probeComputer: false });
  assert.ok(report.modelMismatches >= 1, 'mismatch counted');
  const problems = problemCenter.list();
  assert.ok(problems.some(p => p.code === 'MODEL_MISMATCH'), 'mismatch became a Problem');
  assert.ok(problems.some(p => p.code === 'STALE_RUN' && p.run_id === 'stale-run-1'), 'stale run became a Problem');

  // 去重：重复 inspect 不刷新问题
  const before = problemCenter.list().filter(p => p.code === 'MODEL_MISMATCH').map(p => p.occur_count);
  await diagnostics.inspect({ probeExternal: false, probeComputer: false });
  const after = problemCenter.list().filter(p => p.code === 'MODEL_MISMATCH');
  assert.strictEqual(after.length, before.length, 'no duplicate problem rows');
  console.log('PROBLEM_INTEGRATION=PASS');
  console.log('PROBLEM_SPAM_BLOCKED=PASS');
});

test('B20.2 quick self test is safe, bounded and makes zero paid calls', async () => {
  const { diagnostics } = buildDiagnostics();
  const result = await diagnostics.selfTest();
  assert.strictEqual(result.paidProviderCalls, 0, 'self test must never call paid providers');
  assert.ok(Array.isArray(result.results) && result.results.length >= 5, 'bounded checklist');
  const names = result.results.map(r => r.name);
  for (const expected of ['database', 'skills', 'hooks', 'workflows', 'modelRouter', 'permissionEngine', 'terminal']) {
    assert.ok(names.includes(expected), `self test covers ${expected}`);
  }
  const dbCheck = result.results.find(r => r.name === 'database');
  assert.strictEqual(dbCheck.ok, true, 'local database check passes');
  const termCheck = result.results.find(r => r.name === 'terminal');
  assert.strictEqual(termCheck.ok, true, 'local terminal echo roundtrip passes: ' + termCheck.detail);
  assert.ok(result.durationMs < 60000, 'self test bounded in time');
  console.log('SELF_TEST_ZERO_PAID_CALLS=PASS');
});
