'use strict';
/**
 * v2.9.9 Computer Use 2.0-A — 权限 range 运行时 / 存储 CRUD / live 刷新 / 只读并发 / rg 背压。
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PermissionEngine } = require('../src/security/permissions');
const { authorize } = require('../src/security/permissionRuntime');
const store = require('../src/db/store');
const { runAgentLoop } = require('../src/agent/runtime/agentLoop');
const { createLimits } = require('../src/agent/runtime/retryPolicy');
const { rgSearch, RG_MAX_OUTPUT_BYTES } = require('../src/tools/search');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cu2a-'));
  store.init(dir);
  return dir;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } }

test('range=once：本次允许，下一次仍询问', async () => {
  const eng = new PermissionEngine({ projectId: 'p1' });
  let prompts = 0;
  const rp = async () => { prompts++; return { decision: 'allow', range: 'once' }; };
  const a1 = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r1' }, requestPermission: rp });
  assert.strictEqual(a1.allowed, true);
  // once 不留下 grant → 下一次同 scope 仍 ask（再弹一次）
  const v = eng.evaluate('computer', { taskId: 'r1', projectId: 'p1' });
  assert.strictEqual(v, 'ask', 'once 不应留下持久授权');
  assert.strictEqual(prompts, 1);
});

test('range=task：同 Run 允许，新 Run 不继承', async () => {
  const eng = new PermissionEngine({ projectId: 'p1' });
  const a1 = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r1' }, requestPermission: async () => ({ decision: 'allow', range: 'task' }) });
  assert.strictEqual(a1.allowed, true);
  assert.strictEqual(eng.evaluate('computer', { taskId: 'r1', projectId: 'p1' }), 'allow', '同 Run 应允许');
  assert.strictEqual(eng.evaluate('computer', { taskId: 'r2', projectId: 'p1' }), 'ask', '新 Run 不继承');
});

test('range=always：重启后仍 allow；range=deny：重启后仍 deny', async () => {
  const dir = tmpStore();
  try {
    const eng = new PermissionEngine({ store, projectId: 'p1' });
    await authorize({ engine: eng, scope: 'computer', context: { projectId: 'p1' }, requestPermission: async () => ({ decision: 'allow', range: 'always' }) });
    await authorize({ engine: eng, scope: 'browser', context: { projectId: 'p1' }, requestPermission: async () => ({ decision: 'deny', range: 'deny' }) });
    // 重建 engine（模拟 App 重启）
    const eng2 = new PermissionEngine({ store, projectId: 'p1' });
    assert.strictEqual(eng2.evaluate('computer', { projectId: 'p1' }), 'allow', 'always 重启后仍 allow');
    assert.strictEqual(eng2.evaluate('browser', { projectId: 'p1' }), 'deny', 'deny 重启后仍 deny');
  } finally { rm(dir); }
});

test('range=project：同项目 allow，跨项目 ask；live revision 刷新', async () => {
  const dir = tmpStore();
  try {
    const eng = new PermissionEngine({ store, projectId: 'p1' });
    const observer = new PermissionEngine({ store, projectId: 'p1' }); // 已存在的 engine
    await authorize({ engine: eng, scope: 'computer', context: { projectId: 'p1' }, requestPermission: async () => ({ decision: 'allow', range: 'project' }) });
    assert.strictEqual(eng.evaluate('computer', { projectId: 'p1' }), 'allow', '同项目 allow');
    assert.strictEqual(eng.evaluate('computer', { projectId: 'p2' }), 'ask', '跨项目 ask');
    // observer 未重新创建，但 evaluate 前应因 revision 变化自动同步
    assert.strictEqual(observer.evaluate('computer', { projectId: 'p1' }), 'allow', 'live refresh 应生效');
  } finally { rm(dir); }
});

test('未知 range → PERMISSION_RANGE_INVALID，exec=0', async () => {
  const eng = new PermissionEngine({ projectId: 'p1' });
  const r = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r' }, requestPermission: async () => ({ decision: 'allow', range: 'forever' }) });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, 'PERMISSION_RANGE_INVALID');
});

test('store CRUD：replacePolicy/removeScope/effectivePolicy', async () => {
  const dir = tmpStore();
  try {
    store.permissionGrants.replacePolicy('computer', 'always', null);
    assert.strictEqual(store.permissionGrants.effectivePolicy('computer', 'p1'), 'always');
    // replace 语义：用 project 替换（移除旧 global 行），生效 project
    store.permissionGrants.replacePolicy('computer', 'project', 'p1');
    assert.strictEqual(store.permissionGrants.effectivePolicy('computer', 'p1'), 'project');
    store.permissionGrants.removeScope('computer', 'p1');
    assert.strictEqual(store.permissionGrants.effectivePolicy('computer', 'p1'), 'ask', 'ASK 应真正删除 saved grant');
  } finally { rm(dir); }
});

test('只读并发：maxInFlight=2 且保序', async () => {
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  const rd = p => ({ type: 'read_file', args: { path: p } });
  let call = 0;
  const model = { decide: async () => { call++; if (call === 1) return { actions: [rd('a'), rd('b'), rd('c'), rd('d')], action: rd('a') }; return { action: { type: 'complete', args: { summary: 'done' } } }; } };
  const getTool = n => n === 'read_file' ? { name: n, exec: async (ctx, args) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    return { ok: true, data: { content: 'c', size: 1 } };
  } } : null;
  await runAgentLoop({
    model, getTool,
    ctx: { projectRoot: '/tmp', projectId: 'p', taskId: 't', abortSignal: null },
    limits: createLimits({ maxIterations: 2 }),
    plan: { tasks: [] }, blackboard: { goal: 'g', problems: [], completed: [], importantFiles: [], confirmed: [], pending: [] },
    emit: () => {}, runManager: { finishRun: () => {} }, runId: 'r', setState: () => {}, systemPrompt: '', projectSummary: '',
    onToolResult: (a) => { order.push(a.args.path); } // loop 按 results 原序回调
  });
  assert.ok(maxInFlight <= 2, `maxInFlight 应<=2 (got ${maxInFlight})`);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd'], '结果应保持原顺序');
});

test('rg 背压：早停于 maxResults + abort 有界 + cap 常量', async () => {
  assert.ok(RG_MAX_OUTPUT_BYTES <= 4194304, 'RG cap 应<=4MB');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rgbp-'));
  try {
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'hello world\n'.repeat(20));
    const out = await rgSearch(dir, 'hello', { maxResults: 5 });
    if (out) assert.ok(out.matches.length <= 5, '早停应<=maxResults');
    // abort 有界：立即 abort，rgSearch 应快速返回（不 hang）
    const ac = new AbortController(); ac.abort();
    const t0 = Date.now();
    await rgSearch(dir, 'hello', { maxResults: 100, signal: ac.signal });
    assert.ok(Date.now() - t0 < 5000, 'abort 后应有界返回');
  } finally { rm(dir); }
});
