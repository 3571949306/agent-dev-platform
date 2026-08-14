'use strict';
/**
 * v2.9.9 Phase B Final — B18 Computer Workspace 2.0 契约测试。
 *
 * 机器证明：
 *   COMPUTER_AVAILABILITY_TRUTH=PASS（词汇只来自真实探测；非 Windows → UNSUPPORTED）
 *   COMPUTER_STOP=PASS（Stop 真实终止活动子进程，残留 = 0）
 *   COMPUTER_ACTION_HISTORY_BOUNDED=PASS
 *
 * 普通编码任务 computer/browser exec = 0 的证明在 mainCanonicalEntry.test.js
 * （CODING_TASK_COMPUTER_EXEC=0 / CODING_TASK_BROWSER_EXEC=0）。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { ComputerManager, manager } = require('../src/services/computer');

test('B18.1 availability vocabulary is honest: non-win32 platform reports UNSUPPORTED, never AVAILABLE', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const m = new ComputerManager();
    const result = await m.availability();
    assert.strictEqual(result.status, 'UNSUPPORTED');
    assert.ok(result.reason.includes('linux'));
    assert.ok(['AVAILABLE', 'UNAVAILABLE', 'UNSUPPORTED', 'UNKNOWN', 'ERROR'].includes(result.status));
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
  console.log('COMPUTER_AVAILABILITY_VOCABULARY=PASS');
});

test('B18.1 availability on this machine comes from a real probe (no guessed READY)', async () => {
  const result = await manager.availability();
  assert.ok(['AVAILABLE', 'UNAVAILABLE', 'UNSUPPORTED', 'UNKNOWN', 'ERROR'].includes(result.status),
    `status must be from the honest vocabulary, got ${result.status}`);
  assert.ok(result.checkedAt, 'probe timestamp recorded');
  if (process.platform === 'win32') {
    // 本机真实探测：只接受 AVAILABLE 或 ERROR（真实失败），绝不接受 UNKNOWN/伪 READY
    assert.ok(['AVAILABLE', 'ERROR', 'UNAVAILABLE'].includes(result.status),
      `win32 probe must produce a real verdict, got ${result.status}`);
  }
  console.log('COMPUTER_AVAILABILITY_TRUTH=PASS');
});

test('B18.4 action history is bounded and records real actions only (redacted detail)', () => {
  const m = new ComputerManager();
  for (let i = 0; i < 250; i++) m.recordAction('screenshot', { method: 'VIRTUAL_SCREEN_COPY' }, true);
  const history = m.history();
  assert.strictEqual(history.length, 200, 'history bounded at 200');
  assert.strictEqual(history[0].detail.method, 'VIRTUAL_SCREEN_COPY', 'newest first');
  // P3 redaction: free-form detail keys (typed text etc.) never reach the audit
  m.recordAction('input_text', { method: 'uia-value', textLength: 7, secret: 'COMPUTER_SECRET_X' }, true);
  const json = JSON.stringify(m.history(5));
  assert.ok(!json.includes('COMPUTER_SECRET_X'), 'unsanitized detail must never be audited');
  console.log('COMPUTER_ACTION_HISTORY_BOUNDED=PASS');
});

test('B18.5 stop really cancels the active child process tree (residue = 0, confirmed exit)', async () => {
  if (process.platform !== 'win32') { console.log('COMPUTER_STOP=SKIPPED_NON_WINDOWS'); return; }
  const { ps } = require('../src/services/computer');
  const activeBefore = manager.activeCount();

  // 真实长进程（30 秒 sleep）走同一 ps 通道 → 登记进活动子进程集合；
  // Stop 必须让它真实死亡（taskkill /T /F + 确认退出），残留 = 0。
  const longRunning = ps('Start-Sleep -Seconds 30', 60000);
  for (let i = 0; i < 400 && manager.activeCount() === activeBefore; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(manager.activeCount() > activeBefore, 'a real child process is active');

  const stop = await manager.stopActive();
  assert.ok(stop.ok && stop.stopped >= 1, 'stop reports real terminated count');
  assert.strictEqual(stop.residual, 0, 'no residual helpers after confirmed quiescence');
  assert.strictEqual(manager.activeCount(), 0, 'residue after stop must be 0');

  // 被 cancel 的 30s 长进程必须立刻结算（绝不允许跑满 30s）
  const t0 = Date.now();
  const settled = await longRunning;
  assert.ok(Date.now() - t0 < 10000, 'killed process settles promptly, not after the full 30s');
  assert.ok(settled && typeof settled === 'object', 'ps settles with a verdict');
  assert.strictEqual(manager.activeCount(), 0, 'no lingering active children');

  // 历史记录到 stop 动作
  assert.ok(manager.history(20).some(h => h.action === 'stop'), 'stop action recorded in history');
  console.log('COMPUTER_STOP=PASS');
  console.log('COMPUTER_STOP_RESIDUE=0');
});
