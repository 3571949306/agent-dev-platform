'use strict';
/**
 * HealthManager tests.
 *
 * Verifies:
 *   - check returns { status, version, latencyMs }
 *   - check with force=true bypasses cache
 *   - check caches result (getStatus returns cached)
 *   - checkAll checks all agents in parallel
 *   - check timeout returns unavailable
 *   - invalidate clears cache
 *   - invalidateAll clears all cache
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { HEALTH_STATE } = require('../src/agents/hub/types');

function makeAdapter(id, opts = {}) {
  let callCount = 0;
  return {
    id,
    manifest: { id },
    capabilities: [],
    transport: 'native',
    disabled: false,
    available: true,
    healthStatus: HEALTH_STATE.UNKNOWN,
    _callCount: 0,
    async healthCheck() {
      callCount++;
      this._callCount = callCount;
      if (opts.fail) throw new Error('healthcheck failed');
      if (opts.slow) {
        await new Promise(r => setTimeout(r, 200));
      }
      return {
        status: opts.status || HEALTH_STATE.HEALTHY,
        version: opts.version || '1.0.0',
        latencyMs: 5,
        detail: opts.detail || 'ok'
      };
    }
  };
}

test('check: 返回 { status, version, latencyMs }', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg });
  const r = await hm.check('a');
  assert.strictEqual(r.status, HEALTH_STATE.HEALTHY);
  assert.strictEqual(r.version, '1.0.0');
  assert.ok(typeof r.latencyMs === 'number');
  assert.ok(r.latencyMs >= 0);
});

test('check: 未注册 agent 返回 unavailable', async () => {
  const reg = createAgentRegistry();
  const hm = createHealthManager({ registry: reg });
  const r = await hm.check('missing');
  assert.strictEqual(r.status, HEALTH_STATE.UNAVAILABLE);
  assert.ok(r.error);
});

test('check: disabled agent 返回 disabled', async () => {
  const reg = createAgentRegistry();
  const a = makeAdapter('a');
  a.disabled = true;
  reg.register(a);
  const hm = createHealthManager({ registry: reg });
  const r = await hm.check('a');
  assert.strictEqual(r.status, HEALTH_STATE.DISABLED);
  assert.strictEqual(a.healthStatus, HEALTH_STATE.DISABLED);
});

test('check: force=true 绕过缓存', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  await hm.check('a');
  const first = reg.get('a')._callCount;
  await hm.check('a', { force: true });
  const second = reg.get('a')._callCount;
  assert.ok(second > first, 'force=true 应触发新的 healthCheck 调用');
});

test('check: 缓存命中时不重新调用 healthCheck', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  await hm.check('a');
  const first = reg.get('a')._callCount;
  await hm.check('a');  // 应命中缓存
  const second = reg.get('a')._callCount;
  assert.strictEqual(second, first, '缓存命中不应再次调用 healthCheck');
});

test('getStatus: 返回缓存的检查结果', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  assert.strictEqual(hm.getStatus('a'), null);  // 未检查
  await hm.check('a');
  const s = hm.getStatus('a');
  assert.ok(s);
  assert.strictEqual(s.status, HEALTH_STATE.HEALTHY);
});

test('checkAll: 并行检查所有 agent', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  reg.register(makeAdapter('b'));
  reg.register(makeAdapter('c'));
  const hm = createHealthManager({ registry: reg });
  const m = await hm.checkAll();
  assert.strictEqual(m.size, 3);
  for (const [id, r] of m) {
    assert.strictEqual(r.status, HEALTH_STATE.HEALTHY);
  }
});

test('checkAll: force=true 强制全部刷新', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  await hm.checkAll();
  const first = reg.get('a')._callCount;
  await hm.checkAll({ force: true });
  assert.ok(reg.get('a')._callCount > first);
});

test('check: 超时返回 unavailable', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a', { slow: true }));
  const hm = createHealthManager({ registry: reg, timeoutMs: 30 });
  const r = await hm.check('a');
  assert.strictEqual(r.status, HEALTH_STATE.UNAVAILABLE);
  assert.ok(r.error.includes('健康检查超过'));
});

test('check: adapter.healthCheck 抛错返回 unavailable', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a', { fail: true }));
  const hm = createHealthManager({ registry: reg });
  const r = await hm.check('a');
  assert.strictEqual(r.status, HEALTH_STATE.UNAVAILABLE);
  assert.strictEqual(r.error, 'healthcheck failed');
  assert.strictEqual(reg.get('a').healthStatus, HEALTH_STATE.UNAVAILABLE);
});

test('check: 同时写回 adapter.healthStatus', async () => {
  const reg = createAgentRegistry();
  const a = makeAdapter('a', { status: HEALTH_STATE.DEGRADED });
  reg.register(a);
  const hm = createHealthManager({ registry: reg });
  await hm.check('a');
  assert.strictEqual(a.healthStatus, HEALTH_STATE.DEGRADED);
});

test('invalidate: 清除单个 agent 缓存', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  await hm.check('a');
  assert.ok(hm.getStatus('a'));
  hm.invalidate('a');
  assert.strictEqual(hm.getStatus('a'), null);
});

test('invalidateAll: 清除所有缓存', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  reg.register(makeAdapter('b'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 60000 });
  await hm.checkAll();
  assert.ok(hm.getStatus('a'));
  assert.ok(hm.getStatus('b'));
  hm.invalidateAll();
  assert.strictEqual(hm.getStatus('a'), null);
  assert.strictEqual(hm.getStatus('b'), null);
});

test('getStatus: 缓存过期后返回 null', async () => {
  const reg = createAgentRegistry();
  reg.register(makeAdapter('a'));
  const hm = createHealthManager({ registry: reg, cacheTtlMs: 5 });
  await hm.check('a');
  assert.ok(hm.getStatus('a'));
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(hm.getStatus('a'), null);
});
