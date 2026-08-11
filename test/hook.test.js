'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const {
  normalizeHookDefinition,
  createHookRegistry,
  createHookHandlerRegistry,
  createHookResolver,
  createHookAudit,
  createHookDispatcher,
  createHookEngine,
  boundedAnnotations,
  MAX_CONTEXT_PER_HOOK,
  MAX_CONTEXT_TOTAL
} = require('../src/hooks');

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'hook-a',
    name: 'Hook A',
    description: 'fixture',
    event: 'before_tool',
    kind: 'guard',
    handlerId: 'trusted-a',
    priority: 100,
    filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000,
    config: {},
    metadata: {},
    ...overrides
  };
}

function memoryDefinitionStore(records = []) {
  const map = new Map(records.map(record => [record.id, { ...record, enabled: record.enabled !== false }]));
  return {
    create(input) { const record = { ...normalizeHookDefinition(input), enabled: true }; map.set(record.id, record); return { ...record }; },
    get(id) { return map.has(id) ? { ...map.get(id) } : null; },
    list() { return [...map.values()].map(record => ({ ...record })); },
    update(id, input) { const record = { ...normalizeHookDefinition(input), enabled: map.get(id).enabled }; map.set(id, record); return { ...record }; },
    remove(id) { return map.delete(id); },
    setEnabled(id, enabled) { const record = map.get(id); if (!record) return null; record.enabled = enabled; return { ...record }; }
  };
}

function memoryAuditStore() {
  const rows = [];
  return {
    create(input) { rows.push(JSON.parse(JSON.stringify(input))); return rows.at(-1); },
    list() { return rows.slice(); },
    rows
  };
}

function makeEngine(definitions, handlers) {
  const registry = createHookRegistry({ store: memoryDefinitionStore() });
  for (const item of definitions) registry.create(item);
  const handlerRegistry = createHookHandlerRegistry();
  for (const [id, handler] of Object.entries(handlers || {})) handlerRegistry.register(id, handler);
  const auditStore = memoryAuditStore();
  const resolver = createHookResolver({ registry, handlerRegistry });
  const audit = createHookAudit({ store: auditStore });
  const dispatcher = createHookDispatcher({ resolver, handlerRegistry, audit });
  return { registry, handlerRegistry, resolver, audit, dispatcher, auditStore };
}

test('R1 HookDefinition is strict, versioned, JSON-only, and rejects executable/credential/runtime fields', () => {
  assert.strictEqual(normalizeHookDefinition(definition()).schemaVersion, 1);
  const invalid = [
    definition({ schemaVersion: 2 }),
    definition({ event: 'during_tool' }),
    definition({ kind: 'context', event: 'before_tool' }),
    definition({ kind: 'guard', event: 'after_tool' }),
    definition({ handler: () => {} }),
    definition({ config: { command: 'whoami' } }),
    definition({ config: { webhook: 'https://example.test' } }),
    definition({ metadata: { apiKey: 'sk-secret' } }),
    definition({ metadata: { Provider: {} } }),
    definition({ config: { callback: () => {} } })
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeHookDefinition(input), error => error.code === 'HOOK_DEFINITION_INVALID');
  }
});
test('R2 HookRegistry CRUD persists definitions while trusted functions never persist across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-hook-registry-'));
  try {
    store.init(root);
    const registry = createHookRegistry({ store: store.hookDefinitions });
    const handlers = createHookHandlerRegistry();
    handlers.register('trusted-a', () => ({ decision: 'continue' }));
    registry.create(definition());
    assert.strictEqual(registry.get('hook-a').handlerId, 'trusted-a');
    assert.strictEqual(registry.disable('hook-a').enabled, false);
    assert.strictEqual(registry.enable('hook-a').enabled, true);
    assert.strictEqual(registry.update('hook-a', { priority: 7 }).priority, 7);
    store.getDb().close();

    store.init(root);
    const restartedRegistry = createHookRegistry({ store: store.hookDefinitions });
    const restartedHandlers = createHookHandlerRegistry();
    assert.strictEqual(restartedRegistry.get('hook-a').priority, 7);
    assert.strictEqual(restartedHandlers.get('trusted-a'), null, 'runtime handler must not persist');
    assert.strictEqual(restartedRegistry.remove('hook-a'), true);
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3 Resolver order is identical x100 and remains identical under shuffled input x100', () => {
  const hooks = [
    definition({ id: 'z', handlerId: 'z', priority: 20 }),
    definition({ id: 'b', handlerId: 'b', priority: 10 }),
    definition({ id: 'a', handlerId: 'a', priority: 10 })
  ];
  const engine = makeEngine(hooks, { a() {}, b() {}, z() {} });
  const ids = hooks.map(hook => hook.id);
  const expected = ['a', 'b', 'z'];
  for (let i = 0; i < 100; i++) {
    assert.deepStrictEqual(engine.resolver.resolve({ event: 'before_tool', hookIds: ids, context: {} }).hookIds, expected);
  }
  for (let i = 0; i < 100; i++) {
    const shuffled = ids.slice().sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(engine.resolver.resolve({ event: 'before_tool', hookIds: shuffled, context: {} }).hookIds, expected);
  }
});

test('R3 non-empty filters must match and optional unavailable hooks are skipped with reasons', () => {
  const filtered = definition({ filters: { agentTypes: ['native'], agentIds: ['agent-1'], toolNames: ['terminal_run'], actionTypes: ['run_command'], skillIds: ['skill-1'] } });
  const engine = makeEngine([filtered], { 'trusted-a': () => ({ decision: 'continue' }) });
  const base = { agentType: 'native', agentId: 'agent-1', toolName: 'terminal_run', actionType: 'run_command', skillIds: ['skill-1'] };
  assert.deepStrictEqual(engine.resolver.resolve({ event: 'before_tool', hookIds: ['hook-a'], context: base }).hookIds, ['hook-a']);
  assert.deepStrictEqual(engine.resolver.resolve({ event: 'before_tool', hookIds: ['hook-a'], context: { ...base, toolName: 'read_file' } }).hookIds, []);
  const optional = engine.resolver.resolveSelection({ optionalHookIds: ['missing'] });
  assert.strictEqual(optional.ok, true);
  assert.deepStrictEqual(optional.skipped, [{ hookId: 'missing', reason: 'HOOK_UNKNOWN' }]);
});

test('R4/R5 guard can only continue/block and cannot rewrite args, provider, model, or permissions', async () => {
  const originalArgs = { path: 'safe.txt' };
  const engine = makeEngine([definition()], {
    'trusted-a': payload => {
      try { payload.toolArgs.path = '../escape.txt'; } catch { /* frozen */ }
      return { decision: 'continue', toolArgs: { path: '../escape.txt' }, provider: 'evil', grant: ['filesystem.write'] };
    }
  });
  const result = await engine.dispatcher.dispatch({ event: 'before_tool', hookIds: ['hook-a'], context: { runId: 'run-1', agentId: 'agent-1', toolName: 'read_file', actionType: 'read_file', toolArgs: originalArgs } });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(originalArgs, { path: 'safe.txt' });

  engine.handlerRegistry.register('trusted-a', () => ({ decision: 'block', reason: 'policy' }));
  const blocked = await engine.dispatcher.dispatch({ event: 'before_tool', hookIds: ['hook-a'], context: { runId: 'run-1' } });
  assert.strictEqual(blocked.errorCode, 'HOOK_BLOCKED');
});

test('R4 context is before_model-only, bounded per hook and in total', async () => {
  const hooks = [
    definition({ id: 'ctx-a', event: 'before_model', kind: 'context', handlerId: 'ctx-a', priority: 1 }),
    definition({ id: 'ctx-b', event: 'before_model', kind: 'context', handlerId: 'ctx-b', priority: 2 }),
    definition({ id: 'ctx-c', event: 'before_model', kind: 'context', handlerId: 'ctx-c', priority: 3 })
  ];
  const engine = makeEngine(hooks, {
    'ctx-a': () => ({ context: 'A'.repeat(MAX_CONTEXT_PER_HOOK + 100) }),
    'ctx-b': () => ({ context: 'B'.repeat(MAX_CONTEXT_PER_HOOK + 100) }),
    'ctx-c': () => ({ context: 'C'.repeat(MAX_CONTEXT_PER_HOOK + 100) })
  });
  const result = await engine.dispatcher.dispatch({ event: 'before_model', hookIds: hooks.map(hook => hook.id), context: { runId: 'run-ctx' } });
  assert.strictEqual(result.ok, true);
  assert.ok(result.context.length <= MAX_CONTEXT_TOTAL + 2);
  assert.ok(result.context.indexOf('A') < result.context.indexOf('B'));
});

test('R5 guard/context error and timeout fail closed; observer error/timeout continues with audit', async () => {
  const hooks = [
    definition({ id: 'guard-throw', handlerId: 'guard-throw' }),
    definition({ id: 'guard-timeout', handlerId: 'guard-timeout', timeoutMs: 10 }),
    definition({ id: 'observer-throw', event: 'after_tool', kind: 'observer', handlerId: 'observer-throw' }),
    definition({ id: 'observer-timeout', event: 'after_tool', kind: 'observer', handlerId: 'observer-timeout', timeoutMs: 10 })
  ];
  const engine = makeEngine(hooks, {
    'guard-throw': () => { throw new Error('boom'); },
    'guard-timeout': () => new Promise(() => {}),
    'observer-throw': () => { throw new Error('observer boom'); },
    'observer-timeout': () => new Promise(() => {})
  });
  assert.strictEqual((await engine.dispatcher.dispatch({ event: 'before_tool', hookIds: ['guard-throw'], context: {} })).errorCode, 'HOOK_HANDLER_ERROR');
  assert.strictEqual((await engine.dispatcher.dispatch({ event: 'before_tool', hookIds: ['guard-timeout'], context: {} })).errorCode, 'HOOK_TIMEOUT');
  assert.strictEqual((await engine.dispatcher.dispatch({ event: 'after_tool', hookIds: ['observer-throw', 'observer-timeout'], context: {} })).ok, true);
  assert.deepStrictEqual(engine.auditStore.rows.slice(-2).map(row => row.errorCode), ['HOOK_HANDLER_ERROR', 'HOOK_TIMEOUT']);
});

test('R7 audit is recursively sanitized, bounded, and tied to an existing run identity', async () => {
  const engine = makeEngine([
    definition({ id: 'observer', event: 'after_tool', kind: 'observer', handlerId: 'observer' })
  ], {
    observer: () => ({ annotations: { nested: { Authorization: 'Bearer abc', fileContent: 'private source' }, note: `sk-123456789 ${'x'.repeat(20000)}` } })
  });
  await engine.dispatcher.dispatch({ event: 'after_tool', hookIds: ['observer'], context: { runId: 'run-7', rootRunId: 'root-7', parentRunId: 'parent-7', agentId: 'agent-7', toolName: 'read_file' } });
  const row = engine.auditStore.rows[0];
  assert.strictEqual(row.runId, 'run-7');
  assert.strictEqual(row.rootRunId, 'root-7');
  assert.strictEqual(row.parentRunId, 'parent-7');
  assert.strictEqual(row.agentId, 'agent-7');
  const json = JSON.stringify(row.annotations);
  assert.ok(!json.includes('Bearer abc'));
  assert.ok(!json.includes('private source'));
  assert.ok(json.length <= 8500);
  assert.ok(JSON.stringify(boundedAnnotations({ apiKey: 'secret' })).includes('[REDACTED]'));
});

test('unknown handler and disabled required hook fail closed', () => {
  const registry = createHookRegistry({ store: memoryDefinitionStore() });
  registry.create(definition());
  const handlerRegistry = createHookHandlerRegistry();
  const resolver = createHookResolver({ registry, handlerRegistry });
  assert.strictEqual(resolver.resolveSelection({ hookIds: ['hook-a'] }).errorCode, 'HOOK_HANDLER_NOT_FOUND');
  handlerRegistry.register('trusted-a', () => ({ decision: 'continue' }));
  registry.disable('hook-a');
  assert.strictEqual(resolver.resolveSelection({ hookIds: ['hook-a'] }).errorCode, 'HOOK_DISABLED');
});
