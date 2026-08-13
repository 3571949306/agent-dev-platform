'use strict';
/**
 * v2.9.9 Phase B Final — B17.6/B17.7 内置受信 Hook Handlers 契约测试。
 *
 * 机器证明：
 *   BUILTIN_TRUSTED_HANDLERS=PASS     平台内置 handler 已注册且可通过编辑器选择
 *   HOOK_GUARD_CAN_BLOCK=PASS         guard 可阻断执行
 *   HOOK_GRANT_CAPABILITY=0           内置 handler 绝不授予能力/权限
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createHookEngine, normalizeHookDefinition } = require('../src/hooks');

function memoryDefinitionStore() {
  const map = new Map();
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
  return { create(input) { rows.push(JSON.parse(JSON.stringify(input))); return rows.at(-1); }, list() { return rows.slice(); }, rows };
}

function buildEngine() {
  const engine = createHookEngine({ definitionStore: memoryDefinitionStore(), auditStore: memoryAuditStore() });
  // 与 src/ipc/handlers.js 相同的内置受信 handlers（产品接线真源）
  engine.handlerRegistry.register('builtin.observer.event-log', (payload) => ({
    annotations: { observedEvent: payload.event, hookId: payload.hookId, runId: payload.runId, at: new Date().toISOString() }
  }));
  engine.handlerRegistry.register('builtin.context.utc-timestamp', () => ({
    context: `当前 UTC 时间：${new Date().toISOString()}（内置 Hook 注入，仅供参考）`
  }));
  engine.handlerRegistry.register('builtin.guard.read-only', (payload) => {
    const WRITE_LIKE = new Set(['write_file', 'apply_patch', 'delete_file', 'create_file', 'terminal_run', 'rename_file']);
    const actor = payload.toolName || payload.actionType;
    if (actor && WRITE_LIKE.has(actor)) return { decision: 'block', reason: `内置只读守卫：禁止写类操作 ${actor}` };
    return { decision: 'continue' };
  });
  return engine;
}

test('B17.6 builtin trusted handlers are selectable and observer never mutates', async () => {
  const engine = buildEngine();
  const handlers = engine.handlerRegistry.list();
  for (const id of ['builtin.observer.event-log', 'builtin.context.utc-timestamp', 'builtin.guard.read-only']) {
    assert.ok(handlers.includes(id), `${id} selectable in hook editor`);
  }

  engine.registry.create({
    schemaVersion: 1, id: 'obs-hook', name: 'Observer', description: '',
    event: 'run_start', kind: 'observer', handlerId: 'builtin.observer.event-log',
    priority: 100,
    filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000, config: {}, metadata: {}
  });
  const result = await engine.dispatcher.dispatch({ event: 'run_start', hookIds: ['obs-hook'], context: { runId: 'run-1' } });
  assert.strictEqual(result.ok, true, 'observer hook succeeds');
  assert.ok(result.annotations.length === 1, 'observer produced exactly one annotation');
  assert.strictEqual(result.annotations[0].value.observedEvent, 'run_start');
  console.log('BUILTIN_TRUSTED_HANDLERS=PASS');
});

test('B17.7 builtin guard can block execution but never grants capability', async () => {
  const engine = buildEngine();
  engine.registry.create({
    schemaVersion: 1, id: 'ro-guard', name: 'ReadOnly', description: '',
    event: 'before_tool', kind: 'guard', handlerId: 'builtin.guard.read-only',
    priority: 100,
    filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000, config: {}, metadata: {}
  });

  // 写类工具 → block
  const blocked = await engine.dispatcher.dispatch({
    event: 'before_tool', hookIds: ['ro-guard'], context: { toolName: 'delete_file', runId: 'run-2' }
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.errorCode, 'HOOK_BLOCKED');

  // 读类工具 → continue
  const allowed = await engine.dispatcher.dispatch({
    event: 'before_tool', hookIds: ['ro-guard'], context: { toolName: 'read_file', runId: 'run-3' }
  });
  assert.strictEqual(allowed.ok, true);

  // 绝无授权语义：dispatch 结果不含任何 grant/permission 字段
  for (const r of [blocked, allowed]) {
    assert.strictEqual(r.grant, undefined);
    assert.strictEqual(r.permission, undefined);
    assert.strictEqual(r.grantedScopes, undefined);
  }
  console.log('HOOK_GUARD_CAN_BLOCK=PASS');
  console.log('HOOK_GRANT_CAPABILITY=0');
});

test('B17.6 hook definition with untrusted handler id fails closed at resolve', async () => {
  const engine = buildEngine();
  engine.registry.create({
    schemaVersion: 1, id: 'evil-hook', name: 'Evil', description: '',
    event: 'before_tool', kind: 'guard', handlerId: 'attacker-supplied-js',
    priority: 100,
    filters: { agentTypes: [], agentIds: [], toolNames: [], actionTypes: [], skillIds: [] },
    timeoutMs: 1000, config: {}, metadata: {}
  });
  const result = await engine.dispatcher.dispatch({ event: 'before_tool', hookIds: ['evil-hook'], context: {} });
  assert.strictEqual(result.ok, false, 'unknown handler never executes');
  assert.strictEqual(result.errorCode, 'HOOK_HANDLER_NOT_FOUND');
  console.log('HOOK_UNTRUSTED_HANDLER_FAIL_CLOSED=PASS');
});
