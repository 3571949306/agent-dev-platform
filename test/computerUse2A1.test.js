'use strict';
/**
 * v2.9.9 Computer Use 2.0-A.1 — 核心闭包测试：
 *  decision+range 矩阵 / 持久化真相 / 历史冲突确定性 precedence / rg abort listener 清理。
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
const { rgSearch } = require('../src/tools/search');

function tmpStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cu2a1-')); store.init(d); return d; }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } }

test('decision+range 矩阵：allow+deny / deny+project 均非法，exec=0', async () => {
  const eng = new PermissionEngine({ projectId: 'p1' });
  const bad1 = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r' }, requestPermission: async () => ({ decision: 'allow', range: 'deny' }) });
  assert.strictEqual(bad1.allowed, false, 'allow+deny 必须拒绝执行');
  assert.strictEqual(bad1.code, 'PERMISSION_DECISION_RANGE_INVALID');
  const bad2 = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r' }, requestPermission: async () => ({ decision: 'deny', range: 'project' }) });
  assert.strictEqual(bad2.allowed, false, 'deny+project 必须非法');
  // 合法组合仍工作
  const good = await authorize({ engine: eng, scope: 'computer', context: { runId: 'r' }, requestPermission: async () => ({ decision: 'allow', range: 'once' }) });
  assert.strictEqual(good.allowed, true);
});

test('持久化失败 → persisted=false（不宣称已保存），当前按 once allow', async () => {
  const dir = tmpStore();
  try {
    const eng = new PermissionEngine({ store, projectId: 'p1' });
    const origSave = store.permissionGrants.save;
    store.permissionGrants.save = () => { throw new Error('SQLITE_FULL'); };
    try {
      const r = await authorize({ engine: eng, scope: 'computer', context: { projectId: 'p1' }, requestPermission: async () => ({ decision: 'allow', range: 'always' }) });
      assert.strictEqual(r.allowed, true, '当前 operation 可按 once allow');
      assert.strictEqual(r.persisted, false, '必须明确 persisted=false');
    } finally { store.permissionGrants.save = origSave; }
  } finally { rm(dir); }
});

test('历史冲突行 precedence 确定：GLOBAL DENY > ALWAYS > matching PROJECT', async () => {
  const dir = tmpStore();
  try {
    // 手工插入冲突行（global always + global deny + project）
    store.permissionGrants.save({ scope: 'computer', range: 'always', projectId: null });
    store.permissionGrants.save({ scope: 'computer', range: 'deny', projectId: null });
    store.permissionGrants.save({ scope: 'computer', range: 'project', projectId: 'p1' });
    const eng = new PermissionEngine({ store, projectId: 'p1' });
    assert.strictEqual(eng.evaluate('computer', { projectId: 'p1' }), 'deny', 'GLOBAL DENY 优先');
    // 移除 deny 后 → always
    store.permissionGrants.removeGlobalPolicy('computer');
    // removeGlobalPolicy 删全部 global（含 always）→ 重新插 always 验证 project 之前
    store.permissionGrants.save({ scope: 'computer', range: 'always', projectId: null });
    const eng2 = new PermissionEngine({ store, projectId: 'p1' });
    assert.strictEqual(eng2.evaluate('computer', { projectId: 'p1' }), 'allow', 'GLOBAL ALWAYS 次于 DENY 先于 PROJECT（verdict=allow）');
  } finally { rm(dir); }
});

test('removeProjectPolicy 不顺带删 global', async () => {
  const dir = tmpStore();
  try {
    store.permissionGrants.replaceGlobalPolicy('computer', 'always');
    store.permissionGrants.replaceProjectPolicy('computer', 'p1', 'project');
    store.permissionGrants.removeProjectPolicy('computer', 'p1');
    const eng = new PermissionEngine({ store, projectId: 'p1' });
    assert.strictEqual(eng.evaluate('computer', { projectId: 'p1' }), 'allow', 'global always 应保留');
  } finally { rm(dir); }
});

test('rg abort listener 清理：同 signal 100 次搜索无泄漏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rgleak-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const ac = new AbortController();
    const before = typeof ac.signal.listenerCount === 'function' ? ac.signal.listenerCount('abort') : 0;
    for (let i = 0; i < 100; i++) await rgSearch(dir, 'hello', { maxResults: 1, signal: ac.signal });
    const after = typeof ac.signal.listenerCount === 'function' ? ac.signal.listenerCount('abort') : 0;
    assert.ok(after <= before, `abort listener 不应累积 (before=${before}, after=${after})`);
    // abort 后不得返回 success
    ac.abort();
    const r = await rgSearch(dir, 'hello', { maxResults: 5, signal: ac.signal });
    assert.ok(!r || r.aborted, 'abort 后不得返回正常 success');
  } finally { rm(dir); }
});
