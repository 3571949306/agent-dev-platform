'use strict';
/**
 * AgentHub tests.
 *
 * Verifies the central facade orchestrates registry / router / healthManager /
 * lifecycleManager / runBridge correctly:
 *   - register / detect / health / route delegate properly
 *   - start creates a run and calls adapter.startTask
 *   - start returns { runId, agentId }
 *   - start with unavailable agent returns error
 *   - startAuto routes and starts best candidate
 *   - startAuto fallback on start failure
 *   - startAuto exhausts after 3 fallbacks (AGENT_ROUTE_EXHAUSTED)
 *   - cancel / status / result / getManifests / getAvailable
 */
const test = require('node:test');
const assert = require('node:assert');

const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { HEALTH_STATE, LIFECYCLE, ERROR_CODE } = require('../src/agents/hub/types');

const { FakeNativeAdapter } = require('./fakes/fakeNativeAdapter');
const { FakeCliAdapter } = require('./fakes/fakeCliAdapter');
const { FakeHttpAdapter } = require('./fakes/fakeHttpAdapter');
const { FakeDesktopAdapter } = require('./fakes/fakeDesktopAdapter');

function asRegistered(adapter, manifest) {
  adapter.manifest = manifest;
  adapter.id = manifest.id;
  adapter.capabilities = Object.keys(manifest.capabilities || {}).filter(k => manifest.capabilities[k]);
  adapter.transport = manifest.transport || null;
  adapter.adapterType = manifest.transport || null;
  adapter.disabled = false;
  adapter.available = manifest.availability !== false;
  adapter.healthStatus = HEALTH_STATE.UNKNOWN;
  adapter.maxConcurrency = manifest.maxConcurrency || 1;
  adapter.activeRunCount = 0;
  return adapter;
}

function makeHub(extraAdapters = []) {
  const registry = createAgentRegistry();
  const lm = createLifecycleManager();
  const rm = new RunManager();
  const runBridge = createRunBridge({ runManager: rm, lifecycleManager: lm });
  const healthManager = createHealthManager({ registry });
  const router = createAgentRouter({ registry });
  const hub = createAgentHub({
    registry, router, healthManager, lifecycleManager: lm, runBridge
  });
  const native = asRegistered(new FakeNativeAdapter({ delayMs: 5 }), {
    id: 'native', displayName: 'Native', transport: 'native',
    capabilities: { coding: true, filesystem: true, terminal: true }, availability: true,
    maxConcurrency: 3
  });
  const codex = asRegistered(new FakeCliAdapter({ delayMs: 5 }), {
    id: 'codex', displayName: 'Codex', transport: 'cli',
    capabilities: { coding: true, filesystem: true, terminal: true, sandbox: true }, availability: true,
    maxConcurrency: 2
  });
  hub.register(native);
  hub.register(codex);
  for (const a of extraAdapters) hub.register(a);
  return { hub, registry, lm, rm, runBridge, healthManager, router };
}

test('createAgentHub: 必填依赖缺失时抛错', () => {
  assert.throws(() => createAgentHub({}), /registry 必填/);
  assert.throws(() => createAgentHub({ registry: {} }), /router 必填/);
  assert.throws(() => createAgentHub({ registry: {}, router: {} }), /healthManager 必填/);
});

test('register: 添加 adapter 到 registry', () => {
  const { hub, registry } = makeHub();
  assert.ok(registry.get('native'));
  assert.ok(registry.get('codex'));
  const extra = asRegistered(new FakeHttpAdapter({ delayMs: 5 }), {
    id: 'http', displayName: 'HTTP', transport: 'http',
    capabilities: { coding: true }, availability: true
  });
  hub.register(extra);
  assert.strictEqual(registry.get('http'), extra);
});

test('detect: 委托 registry.detectAll', async () => {
  const { hub } = makeHub();
  const m = await hub.detect();
  assert.ok(m.get('native').available);
  assert.ok(m.get('codex').available);
});

test('health: 委托 healthManager.checkAll', async () => {
  const { hub } = makeHub();
  const m = await hub.health();
  assert.ok(m.get('native'));
  assert.ok(m.get('codex'));
  assert.strictEqual(m.get('native').status, HEALTH_STATE.HEALTHY);
});

test('route: 委托 router.route', () => {
  const { hub } = makeHub();
  const res = hub.route({ required: ['coding'] });
  assert.ok(Array.isArray(res));
  assert.ok(res.length >= 1);
});

test('start: 创建 run 并调用 adapter.startTask，返回 { runId, agentId }', async () => {
  const { hub } = makeHub();
  const r = await hub.start('native', { goal: 'do something' });
  assert.ok(r.runId);
  assert.strictEqual(r.agentId, 'native');
});

test('start: 不存在的 agent 返回 AGENT_NOT_FOUND', async () => {
  const { hub } = makeHub();
  const r = await hub.start('missing', { goal: 'x' });
  assert.ok(r.error);
  assert.strictEqual(r.errorCode, ERROR_CODE.AGENT_NOT_FOUND);
});

test('start: disabled agent 返回 AGENT_DISABLED', async () => {
  const { hub, registry } = makeHub();
  registry.get('native').disabled = true;
  const r = await hub.start('native', { goal: 'x' });
  assert.strictEqual(r.errorCode, ERROR_CODE.AGENT_DISABLED);
});

test('start: adapter.startTask 抛错返回 AGENT_START_FAILED', async () => {
  const { hub, registry } = makeHub();
  // 替换为 startFails 的 cli adapter
  const failing = asRegistered(new FakeCliAdapter({ delayMs: 5, startFails: true }), {
    id: 'failing', displayName: 'Failing', transport: 'cli',
    capabilities: { coding: true }, availability: true
  });
  registry.register(failing);
  const r = await hub.start('failing', { goal: 'x' });
  assert.strictEqual(r.errorCode, ERROR_CODE.AGENT_START_FAILED);
  assert.ok(r.error.includes('simulated start failure'));
});

test('startAuto: 自动路由并启动最佳候选', async () => {
  const { hub } = makeHub();
  const r = await hub.startAuto({ required: ['coding', 'filesystem', 'terminal'] });
  assert.ok(r.runId);
  assert.ok(r.agentId);
  // native 或 codex 都满足，应该是其中之一
  assert.ok(['native', 'codex'].includes(r.agentId));
});

test('startAuto: 第一个候选失败时 fallback 到下一个', async () => {
  const { hub, registry } = makeHub();
  // 让 native 启动失败
  const failing = asRegistered(new FakeCliAdapter({ delayMs: 5, startFails: true }), {
    id: 'native', displayName: 'Native', transport: 'native',
    capabilities: { coding: true, filesystem: true, terminal: true }, availability: true,
    maxConcurrency: 3
  });
  registry.register(failing);  // 覆盖 native
  const r = await hub.startAuto({ required: ['coding', 'filesystem', 'terminal'] });
  // native 失败 → fallback 到 codex
  assert.strictEqual(r.agentId, 'codex');
  assert.ok(r.runId);
});

test('startAuto: 所有候选都失败 → AGENT_ROUTE_EXHAUSTED', async () => {
  const { hub, registry } = makeHub();
  // 让两个候选都失败
  registry.register(asRegistered(new FakeCliAdapter({ delayMs: 5, startFails: true }), {
    id: 'native', displayName: 'Native', transport: 'native',
    capabilities: { coding: true, filesystem: true, terminal: true }, availability: true
  }));
  registry.register(asRegistered(new FakeCliAdapter({ delayMs: 5, startFails: true }), {
    id: 'codex', displayName: 'Codex', transport: 'cli',
    capabilities: { coding: true, filesystem: true, terminal: true, sandbox: true }, availability: true
  }));
  const r = await hub.startAuto({ required: ['coding'] });
  assert.strictEqual(r.errorCode, ERROR_CODE.AGENT_ROUTE_EXHAUSTED);
  assert.ok(!r.agentId);
});

test('startAuto: 没有候选 → AGENT_ROUTE_EXHAUSTED', async () => {
  const { hub, registry } = makeHub();
  // 禁用所有 adapter 使 router.route 返回空列表
  registry.get('native').disabled = true;
  registry.get('codex').disabled = true;
  const r = await hub.startAuto({ required: ['coding'] });
  assert.strictEqual(r.errorCode, ERROR_CODE.AGENT_ROUTE_EXHAUSTED);
});

test('cancel: 取消 run', async () => {
  const { hub } = makeHub();
  const { runId } = await hub.start('native', { goal: 'x' });
  const r = await hub.cancel(runId);
  assert.ok(r);
  assert.strictEqual(r.runId, runId);
});

test('status: 返回 run 状态', async () => {
  const { hub } = makeHub();
  const { runId, agentId } = await hub.start('native', { goal: 'x' });
  const s = await hub.status(runId);
  assert.ok(s);
  assert.strictEqual(s.runId, runId);
  assert.strictEqual(s.agentId, agentId);
  assert.ok(typeof s.status === 'string');
});

test('status: 不存在的 runId 返回 null', async () => {
  const { hub } = makeHub();
  assert.strictEqual(await hub.status('missing'), null);
});

test('result: 返回 run 结果', async () => {
  const { hub, lm } = makeHub();
  const { runId } = await hub.start('native', { goal: 'x' });
  // 手动完成 lifecycle run 以设置 result
  const mapping = hub.status(runId) && null;  // just trigger
  // 直接通过 lifecycleManager 完成
  const statusRes = await hub.status(runId);
  lm.transition(statusRes.lifecycleRunId, LIFECYCLE.COMPLETED, { summary: 'done' });
  const r = await hub.result(runId);
  assert.ok(r);
  assert.strictEqual(r.runId, runId);
  assert.strictEqual(r.status, LIFECYCLE.COMPLETED);
  assert.deepStrictEqual(r.result, { summary: 'done' });
});

test('result: 不存在的 runId 返回 null', async () => {
  const { hub } = makeHub();
  assert.strictEqual(await hub.result('missing'), null);
});

test('getManifests: 返回所有 manifest', () => {
  const { hub } = makeHub();
  const ms = hub.getManifests();
  assert.ok(ms.length >= 2);
  const ids = ms.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['codex', 'native']);
});

test('getAvailable: 返回可用 agent 及健康状态', async () => {
  const { hub } = makeHub();
  await hub.health();
  const avail = hub.getAvailable();
  assert.ok(avail.length >= 1);
  for (const a of avail) {
    assert.ok(a.id);
    assert.ok(typeof a.healthStatus === 'string');
    assert.ok(Array.isArray(a.capabilities));
  }
});

test('getAvailable: 列出的是 listAvailable 过滤后的结果', async () => {
  const { hub, registry } = makeHub();
  await hub.detect();   // 让 native/codex 都被检测过
  const avail = hub.getAvailable();
  const ids = avail.map(a => a.id);
  assert.ok(ids.includes('native'));
  assert.ok(ids.includes('codex'));
  // 禁用后不再出现
  registry.get('codex').disabled = true;
  const avail2 = hub.getAvailable();
  assert.ok(!avail2.map(a => a.id).includes('codex'));
});
