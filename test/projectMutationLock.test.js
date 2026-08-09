'use strict';
/**
 * ProjectMutationLock 单元测试（spec §42-§45）。
 *
 * 覆盖：
 *   - §44：Windows 大小写不敏感 —— `D:\Project` 与 `d:\project` 视为同一 root；
 *          非存在路径也通过 normalize + 小写得到一致 key。
 *   - §45：symlink / junction 解析到真实目标 —— `A\link → B` 不能绕过同一把锁。
 *   - §42/§43：写锁互斥、同 runId 幂等、读锁共享、释放后归还、PROJECT_LOCKED 返回 lockHolder。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProjectMutationLock } = require('../src/security/projectMutationLock');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pml-'));
}

// ── §44：canonical 大小写不敏感 + normalize ───────────────────────────────
test('canonical: differing case resolves to the same key (§44)', () => {
  const lock = createProjectMutationLock();
  const snap = lock.snapshot; // 仅确认实例可用
  assert.ok(typeof snap === 'function');
  // 直接用模块内部 canonical 不易导出，这里通过行为验证：同一临时目录的两种大小写视为同一 root
  const base = tmpDir();
  const upper = path.join(base.toUpperCase(), 'Sub');
  const lower = path.join(base.toLowerCase(), 'sub');
  // 确保子路径存在（realpath 需要存在）
  fs.mkdirSync(upper, { recursive: true });
  fs.mkdirSync(lower, { recursive: true });

  const r1 = lock.acquireWrite(upper, 'run-A', 'agent1');
  assert.strictEqual(r1.ok, true, 'first write acquire should succeed');
  const r2 = lock.acquireWrite(lower, 'run-B', 'agent2');
  assert.strictEqual(r2.ok, false, 'case-variant path must map to the SAME root → blocked');
  assert.strictEqual(r2.lockHolder && r2.lockHolder.runId, 'run-A', 'lockHolder should be the first run');
  lock.release('run-A');
});

test('canonical: nonexistent path still normalizes case-insensitively (§44)', () => {
  // 非存在路径走 path.resolve 回退 + 小写；两种大小写必须得到一致 key
  const lock = createProjectMutationLock();
  // 使用一个稳定且不会存在的子路径组合
  const p1 = 'C:\\nonexistent-root\\alpha';
  const p2 = 'c:\\NONEXISTENT-ROOT\\Alpha';
  const r1 = lock.acquireWrite(p1, 'r1', 'a1');
  assert.strictEqual(r1.ok, true);
  const r2 = lock.acquireWrite(p2, 'r2', 'a2');
  assert.strictEqual(r2.ok, false, 'nonexistent but case-variant paths must share the lock key');
  assert.strictEqual(r2.lockHolder && r2.lockHolder.runId, 'r1');
  lock.release('r1');
});

// ── §45：symlink / junction 解析到真实目标 ────────────────────────────────
test('canonical: junction/symlink resolves to real target so link cannot bypass lock (§45)', () => {
  const lock = createProjectMutationLock();
  const real = tmpDir();
  const link = path.join(tmpDir(), 'link');
  try {
    // Windows junction 不需要提权；其它平台用 symlink
    if (process.platform === 'win32') {
      fs.symlinkSync(real, link, 'junction');
    } else {
      fs.symlinkSync(real, link, 'dir');
    }
  } catch (e) {
    // 无权限创建链接时跳过，不视为失败
    return;
  }
  // 在 link 上拿写锁
  const rl = lock.acquireWrite(link, 'run-link', 'agent1');
  assert.strictEqual(rl.ok, true, 'write lock on the junction path should succeed');
  // 在真实目标上再拿写锁必须被挡下（否则 link 绕过锁）
  const rr = lock.acquireWrite(real, 'run-real', 'agent2');
  assert.strictEqual(rr.ok, false, 'real target must be locked through the junction (§45)');
  assert.strictEqual(rr.lockHolder && rr.lockHolder.runId, 'run-link');
  lock.release('run-link');
});

// ── §42/§43：写锁互斥 + 同 run 幂等 + PROJECT_LOCKED ──────────────────────
test('write lock is exclusive; same run is idempotent; PROJECT_LOCKED returns holder', () => {
  const lock = createProjectMutationLock();
  const root = tmpDir();
  const a = lock.acquireWrite(root, 'run-1', 'agentA');
  assert.strictEqual(a.ok, true);

  // 不同 run 同 root 必须被挡
  const b = lock.acquireWrite(root, 'run-2', 'agentB');
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.lockHolder.runId, 'run-1');
  assert.strictEqual(b.lockHolder.agentId, 'agentA');

  // 同 run 再次获取写锁：幂等成功
  const a2 = lock.acquireWrite(root, 'run-1', 'agentA');
  assert.strictEqual(a2.ok, true);

  // 释放后新 run 可获取
  assert.strictEqual(lock.release('run-1'), true);
  const c = lock.acquireWrite(root, 'run-2', 'agentB');
  assert.strictEqual(c.ok, true);
  lock.release('run-2');
});

// ── 读锁共享，写锁被读锁阻塞 ─────────────────────────────────────────────
test('read locks are shared; a writer is blocked while readers are held', () => {
  const lock = createProjectMutationLock();
  const root = tmpDir();
  const r1 = lock.acquireRead(root, 'read-1', 'agentA');
  const r2 = lock.acquireRead(root, 'read-2', 'agentB');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);

  // 写锁被读锁阻塞
  const w = lock.acquireWrite(root, 'write-1', 'agentC');
  assert.strictEqual(w.ok, false);
  assert.ok(w.lockHolder, 'should report a reader as holder');

  // 释放全部读锁后，写锁可获取（最后一个读锁释放触发写等待者唤醒）
  assert.strictEqual(lock.release('read-1'), true);
  // 仍有一个读锁，写锁依然阻塞
  const w2 = lock.acquireWrite(root, 'write-1', 'agentC');
  assert.strictEqual(w2.ok, false);
  assert.strictEqual(lock.release('read-2'), true);
  const w3 = lock.acquireWrite(root, 'write-1', 'agentC');
  assert.strictEqual(w3.ok, true);
  lock.release('write-1');
});

// ── release 幂等 / 未知 runId 安全 ────────────────────────────────────────
test('release is safe for unknown runId and idempotent', () => {
  const lock = createProjectMutationLock();
  assert.strictEqual(lock.release('never-existed'), false, 'unknown runId release is a no-op');
  const root = tmpDir();
  lock.acquireWrite(root, 'r', 'a');
  assert.strictEqual(lock.release('r'), true);
  assert.strictEqual(lock.release('r'), false, 'double release returns false');
});
