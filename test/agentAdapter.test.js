'use strict';
/**
 * AgentAdapter contract tests.
 *
 * Verifies:
 *   - BaseAgentAdapter methods throw NOT_IMPLEMENTED by default
 *   - Each fake adapter implements the required method set
 *   - detect() / healthCheck() / startTask() / getStatus() / getResult() /
 *     cancel() / dispose() behave per the AgentAdapter contract.
 */
const test = require('node:test');
const assert = require('node:assert');

const { BaseAgentAdapter } = require('../src/agents/adapters/baseAgentAdapter');
const { FakeNativeAdapter } = require('./fakes/fakeNativeAdapter');
const { FakeCliAdapter } = require('./fakes/fakeCliAdapter');
const { FakeHttpAdapter } = require('./fakes/fakeHttpAdapter');
const { FakeDesktopAdapter } = require('./fakes/fakeDesktopAdapter');

const REQUIRED_METHODS = [
  'detect', 'healthCheck', 'startTask', 'sendMessage',
  'cancel', 'getStatus', 'getResult', 'dispose'
];

function makeFake(adapterClass, extra = {}) {
  return new adapterClass({
    manifest: { id: 'fake', displayName: 'fake', capabilities: {}, transport: 'native' },
    resultText: 'done',
    delayMs: 5,
    ...extra
  });
}

test('BaseAgentAdapter: 未覆盖的方法抛 NOT_IMPLEMENTED', async () => {
  const base = new BaseAgentAdapter();
  assert.throws(() => base.getManifest(), /NOT_IMPLEMENTED/);
  for (const m of REQUIRED_METHODS) {
    await assert.rejects(() => base[m](), /NOT_IMPLEMENTED/);
  }
});

test('BaseAgentAdapter: constructor 存储manifest与config', () => {
  const base = new BaseAgentAdapter({ manifest: { id: 'x' }, config: { k: 'v' } });
  assert.deepStrictEqual(base.manifest, { id: 'x' });
  assert.deepStrictEqual(base.config, { k: 'v' });
});

for (const [name, cls] of [
  ['FakeNativeAdapter', FakeNativeAdapter],
  ['FakeCliAdapter', FakeCliAdapter],
  ['FakeHttpAdapter', FakeHttpAdapter],
  ['FakeDesktopAdapter', FakeDesktopAdapter]
]) {
  test(`${name}: 实现所有必需方法`, () => {
    const a = makeFake(cls);
    for (const m of REQUIRED_METHODS) {
      assert.strictEqual(typeof a[m], 'function', `${name} 缺少方法 ${m}`);
    }
    assert.strictEqual(typeof a.getManifest, 'function');
  });
}

test('FakeNativeAdapter: detect() 返回 expected shape', async () => {
  const a = makeFake(FakeNativeAdapter);
  const r = await a.detect();
  assert.strictEqual(r.available, true);
  assert.strictEqual(typeof r.version, 'string');
  assert.ok(r.path === null || typeof r.path === 'string');
});

test('FakeNativeAdapter: healthCheck() 返回 expected shape', async () => {
  const a = makeFake(FakeNativeAdapter);
  const r = await a.healthCheck();
  assert.strictEqual(r.status, 'healthy');
  assert.ok(typeof r.version === 'string');
  assert.ok(typeof r.latencyMs === 'number');
});

test('FakeNativeAdapter: startTask 返回 { runId }', async () => {
  const a = makeFake(FakeNativeAdapter);
  const r = await a.startTask({ goal: 'hi' }, {});
  assert.ok(typeof r.runId === 'string');
  assert.ok(r.runId.length > 0);
});

test('FakeNativeAdapter: getStatus 返回合法 lifecycle 状态', async () => {
  const a = makeFake(FakeNativeAdapter);
  const { runId } = await a.startTask({ goal: 'hi' }, {});
  const s = await a.getStatus(runId);
  assert.ok(['idle', 'starting', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timeout', 'unavailable', 'unknown'].includes(s));
});

test('FakeNativeAdapter: getResult 在完成后返回 expected shape', async () => {
  const a = makeFake(FakeNativeAdapter, { delayMs: 5 });
  const { runId } = await a.startTask({ goal: 'hi' }, {});
  await new Promise(r => setTimeout(r, 30));
  const res = await a.getResult(runId);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(typeof res.summary, 'string');
  assert.ok(Array.isArray(res.changedFiles));
  assert.ok(Array.isArray(res.artifacts));
});

test('FakeNativeAdapter: cancel 标记为 cancelled', async () => {
  const a = makeFake(FakeNativeAdapter, { delayMs: 100 });
  const { runId } = await a.startTask({ goal: 'hi' }, {});
  await a.cancel(runId);
  const s = await a.getStatus(runId);
  assert.strictEqual(s, 'cancelled');
  assert.ok(a.aborted.has(runId));
});

test('FakeNativeAdapter: dispose 清理内部状态', async () => {
  const a = makeFake(FakeNativeAdapter);
  await a.startTask({ goal: 'hi' }, {});
  assert.ok(a.runs.size > 0);
  await a.dispose();
  assert.strictEqual(a.runs.size, 0);
});

test('FakeCliAdapter: startFails=true 时 startTask 抛错', async () => {
  const a = makeFake(FakeCliAdapter, { startFails: true });
  await assert.rejects(() => a.startTask({ goal: 'hi' }, {}), /simulated start failure/);
});

test('FakeCliAdapter: detect 返回可用 + 路径', async () => {
  const a = makeFake(FakeCliAdapter);
  const r = await a.detect();
  assert.strictEqual(r.available, true);
  assert.ok(typeof r.path === 'string');
});

test('FakeHttpAdapter: healthEndpoint 透传到 detect.path', async () => {
  const a = makeFake(FakeHttpAdapter, { healthEndpoint: '/api/health' });
  const r = await a.detect();
  assert.strictEqual(r.path, '/api/health');
});

test('FakeDesktopAdapter: windowFound=false 时 detect 不可用', async () => {
  const a = makeFake(FakeDesktopAdapter, { windowFound: false });
  const r = await a.detect();
  assert.strictEqual(r.available, false);
  const h = await a.healthCheck();
  assert.strictEqual(h.status, 'unavailable');
});

test('FakeDesktopAdapter: windowFound=true 时 detect 可用', async () => {
  const a = makeFake(FakeDesktopAdapter, { windowFound: true });
  const r = await a.detect();
  assert.strictEqual(r.available, true);
  const h = await a.healthCheck();
  assert.strictEqual(h.status, 'healthy');
});
