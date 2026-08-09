'use strict';
/**
 * AgentRegistry tests.
 *
 * Verifies register / get / unregister / list / listAvailable / detectAll /
 * getByCapability / getManifests behave per the registry contract.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { FakeNativeAdapter } = require('./fakes/fakeNativeAdapter');
const { FakeCliAdapter } = require('./fakes/fakeCliAdapter');
const { FakeDesktopAdapter } = require('./fakes/fakeDesktopAdapter');

/**
 * Wrap a fake adapter so it exposes the direct properties the registry
 * inspects: id / capabilities / transport / disabled / available.
 */
function asRegistered(adapter, manifest) {
  adapter.manifest = manifest;
  adapter.id = manifest.id;
  adapter.capabilities = Object.keys(manifest.capabilities || {}).filter(k => manifest.capabilities[k]);
  adapter.transport = manifest.transport || null;
  adapter.disabled = false;
  adapter.available = manifest.availability !== false;
  adapter.healthStatus = 'unknown';
  return adapter;
}

function makeNative() {
  return asRegistered(new FakeNativeAdapter({ delayMs: 5 }), {
    id: 'native-main', displayName: 'Native', transport: 'native',
    capabilities: { coding: true, filesystem: true, terminal: true }, availability: true
  });
}
function makeCli() {
  return asRegistered(new FakeCliAdapter({ delayMs: 5 }), {
    id: 'codex', displayName: 'Codex', transport: 'cli',
    capabilities: { coding: true, filesystem: true, terminal: true, sandbox: true }, availability: false
  });
}
function makeDesktop(opts = {}) {
  return asRegistered(new FakeDesktopAdapter({ delayMs: 5, ...opts }), {
    id: 'workbuddy', displayName: 'WorkBuddy', transport: 'desktop',
    capabilities: { coding: true, computer: true, vision: true }, availability: opts.windowFound === false ? false : false
  });
}

test('register: adapter.id 必填', () => {
  const r = createAgentRegistry();
  assert.throws(() => r.register({}), /adapter\.id 必填/);
  assert.throws(() => r.register(null), /adapter\.id 必填/);
});

test('register / get: 注册后可按 id 获取', () => {
  const r = createAgentRegistry();
  const a = makeNative();
  r.register(a);
  assert.strictEqual(r.get('native-main'), a);
  assert.strictEqual(r.get('missing'), null);
});

test('list: 返回所有已注册 adapter', () => {
  const r = createAgentRegistry();
  const n = makeNative(); const c = makeCli();
  r.register(n); r.register(c);
  const all = r.list();
  assert.strictEqual(all.length, 2);
  assert.ok(all.includes(n));
  assert.ok(all.includes(c));
});

test('listAvailable: 未 detect 时只返回 available=true 的 adapter', () => {
  const r = createAgentRegistry();
  r.register(makeNative());   // availability:true
  r.register(makeCli());      // availability:false
  const avail = r.listAvailable();
  assert.strictEqual(avail.length, 1);
  assert.strictEqual(avail[0].id, 'native-main');
});

test('listAvailable: disabled 的 adapter 被排除', () => {
  const r = createAgentRegistry();
  const n = makeNative();
  n.disabled = true;
  r.register(n);
  assert.strictEqual(r.listAvailable().length, 0);
});

test('detectAll: 对所有 adapter 执行 detect，回填 detection 状态', async () => {
  const r = createAgentRegistry();
  r.register(makeNative());   // detect returns available:true
  r.register(makeDesktop({ windowFound: false })); // available:false
  const m = await r.detectAll();
  assert.ok(m.get('native-main').available === true);
  assert.ok(m.get('workbuddy').available === false);
  // detectAll 后 listAvailable 反映检测结果
  const avail = r.listAvailable();
  assert.strictEqual(avail.length, 1);
  assert.strictEqual(avail[0].id, 'native-main');
});

test('detectAll: 单个 adapter 抛错不影响其他', async () => {
  const r = createAgentRegistry();
  const good = makeNative();
  const bad = {
    id: 'bad', manifest: { id: 'bad' }, capabilities: [], transport: 'native',
    disabled: false,
    async detect() { throw new Error('boom'); },
    async healthCheck() { return { status: 'healthy' }; }
  };
  r.register(good); r.register(bad);
  const m = await r.detectAll();
  assert.strictEqual(m.get('bad').available, false);
  assert.strictEqual(m.get('bad').error, 'boom');
  assert.strictEqual(m.get('native-main').available, true);
});

test('getByCapability: 仅返回满足所有 required 能力的 adapter', () => {
  const r = createAgentRegistry();
  r.register(makeNative());   // coding, filesystem, terminal
  r.register(makeDesktop());  // coding, computer, vision
  const coding = r.getByCapability(['coding']);
  assert.strictEqual(coding.length, 2);
  const terminal = r.getByCapability(['terminal']);
  assert.strictEqual(terminal.length, 1);
  assert.strictEqual(terminal[0].id, 'native-main');
  const computer = r.getByCapability(['computer']);
  assert.strictEqual(computer.length, 1);
  assert.strictEqual(computer[0].id, 'workbuddy');
  const impossible = r.getByCapability(['coding', 'computer', 'terminal']);
  assert.strictEqual(impossible.length, 0);
});

test('getByCapability: required 为空时返回全部', () => {
  const r = createAgentRegistry();
  r.register(makeNative()); r.register(makeCli());
  assert.strictEqual(r.getByCapability().length, 2);
  assert.strictEqual(r.getByCapability([]).length, 2);
});

test('getManifests: 返回所有 adapter 的 manifest', () => {
  const r = createAgentRegistry();
  r.register(makeNative()); r.register(makeCli());
  const ms = r.getManifests();
  assert.strictEqual(ms.length, 2);
  const ids = ms.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['codex', 'native-main']);
});

test('unregister: 移除 adapter，get/list 不再返回', () => {
  const r = createAgentRegistry();
  const n = makeNative();
  r.register(n);
  assert.ok(r.unregister('native-main'));
  assert.strictEqual(r.get('native-main'), null);
  assert.strictEqual(r.list().length, 0);
  // 再次 unregister 返回 false
  assert.strictEqual(r.unregister('native-main'), false);
});

test('unregister: 同时清理 detection 缓存', async () => {
  const r = createAgentRegistry();
  const n = makeNative();
  r.register(n);
  await r.detectAll();
  assert.ok(r.listAvailable().length === 1);
  r.unregister('native-main');
  assert.strictEqual(r.listAvailable().length, 0);
});
