'use strict';
/**
 * v2.9.0 Harness Safety Patch — R3 Paid Real-AI Attempt Guard（RealAiPaidRunGuard）。
 *
 * 违约背景（如实记录）：
 *   Prompt allowed max 2 paid attempts; actual execution performed 5.
 *   Root cause: limit existed only in natural-language instructions,
 *   not in executable harness. Fix: RealAiPaidRunGuard.
 *
 * 覆盖：
 *   - §22 对抗测试：max=2 → consume/allowed、consume/allowed、consume/BLOCKED，
 *     且第三次 provider spy calls = 0（绝无 Provider 调用机会）。
 *   - §12 同一 Closure Session 共享（repoRoot + HEAD + TTL），不得每次自动新建绕过。
 *   - §15/§16 TTL 过期 / HEAD 变化 → 无 override 时 FAIL CLOSED；显式 new-session 可创建。
 *   - §19/§23 attempt 定义（开始即计数）+ crash consistency（先写 session 再调 API）。
 *   - §25 并发锁：拿不到锁 → REAL_AI_SESSION_LOCKED；stale 锁回收。
 *   - §9 session 文件不含密钥。
 *   - runSmoke 集成：session 已满 → BLOCKED exit=3 + provider spy 零调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRealAiPaidRunGuard } = require('../scripts/lib/real-ai-paid-run-guard');
const rt = require('../scripts/lib/real-ai-runtime');
const { runSmoke } = require('../scripts/real-ai-orchestrator-smoke');
const store = require('../src/db/store');

const REPO_ROOT = path.join(__dirname, '..');

function tmpSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r3-session-'));
}

/** Provider spy：模拟「只有 reserve.ok 才调用 Provider」的 harness 契约。 */
function createProviderSpy() {
  const spy = { calls: 0 };
  return {
    spy,
    runIfAllowed(reserveResult) {
      if (reserveResult.ok) spy.calls += 1;   // 模拟真实 Provider 请求
      return reserveResult;
    }
  };
}

test('R3 §22 对抗：max=2 → 第 1/2 次 allowed，第 3 次 REAL_AI_ATTEMPT_LIMIT_EXCEEDED，provider spy=0', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir, maxPaidRuns: 2 });
  const { spy, runIfAllowed } = createProviderSpy();

  const r1 = runIfAllowed(guard.reservePaidRun({ connectionId: 'c1', model: 'm', reason: 'test-1' }));
  assert.strictEqual(r1.ok, true, 'attempt 1 应 allowed');
  assert.strictEqual(r1.paidRunsStarted, 1);
  assert.strictEqual(r1.maxPaidRuns, 2);

  const r2 = runIfAllowed(guard.reservePaidRun({ connectionId: 'c1', model: 'm', reason: 'test-2' }));
  assert.strictEqual(r2.ok, true, 'attempt 2 应 allowed');
  assert.strictEqual(r2.paidRunsStarted, 2);
  assert.strictEqual(r2.sessionId, r1.sessionId, '同一 Closure Session 共享（不得自动新建绕过）');

  const r3 = runIfAllowed(guard.reservePaidRun({ connectionId: 'c1', model: 'm', reason: 'test-3' }));
  assert.strictEqual(r3.ok, false, 'attempt 3 必须被拒');
  assert.strictEqual(r3.code, 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED');
  assert.strictEqual(r3.providerCallsStarted, 0);
  assert.strictEqual(r3.paidRunsStarted, 2, '计数不得超过 max');

  assert.strictEqual(spy.calls, 2, '第三次绝无 Provider 调用机会（spy 只被触发 2 次）');
});

test('R3 session 跨 guard 实例共享（同一 sessionDir + 同 HEAD → 复用）', () => {
  const dir = tmpSessionDir();
  const g1 = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const g2 = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const a = g1.reservePaidRun({ reason: 'instance-1' });
  const b = g2.reservePaidRun({ reason: 'instance-2' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.sessionId, a.sessionId, '不同进程/实例也必须共享同一 session');
  assert.strictEqual(b.paidRunsStarted, 2);
  const c = g2.reservePaidRun({ reason: 'instance-3' });
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.code, 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED');
});

test('R3 crash consistency：reserve 返回 ok 之前 session 文件已落盘（先记账再调 API）', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const r = guard.reservePaidRun({ connectionId: 'conn-x', model: 'model-y', reason: 'atomic' });
  assert.strictEqual(r.ok, true);
  // reserve 一返回，文件必须已包含本次计数（即使进程随即 crash 也不丢计数）
  const sessionFile = path.join(dir, `adp-real-ai-session-${r.sessionId}.json`);
  const onDisk = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(onDisk.paidRunsStarted, 1);
  assert.strictEqual(onDisk.runs.length, 1);
  assert.strictEqual(onDisk.runs[0].connectionId, 'conn-x');
  assert.strictEqual(onDisk.runs[0].model, 'model-y');
});

test('R3 §9 session 文件禁止记录密钥/Bearer/完整 Prompt', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  guard.reservePaidRun({ connectionId: 'conn-1', model: 'deepseek-chat', reason: 'secret-scan' });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(content), 'session 文件不得含 API key 样式');
    assert.ok(!/Bearer/i.test(content), 'session 文件不得含 Authorization/Bearer');
    assert.ok(!/Authorization/i.test(content));
  }
});

test('R3 HEAD 变化（context 不一致）且无 override → FAIL CLOSED，不自动新建 session', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const a = guard.reservePaidRun({ reason: 'before-head-change' });
  assert.strictEqual(a.ok, true);
  // 篡改 session 的 head，模拟 repo HEAD 变化后的下一次运行
  const sessionFile = path.join(dir, `adp-real-ai-session-${a.sessionId}.json`);
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  s.head = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.writeFileSync(sessionFile, JSON.stringify(s, null, 2));

  const b = guard.reservePaidRun({ reason: 'after-head-change' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.code, 'REAL_AI_NEW_SESSION_REQUIRES_OVERRIDE');
  assert.strictEqual(b.providerCallsStarted, 0);
});

test('R3 TTL 过期且无 override → FAIL CLOSED', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const a = guard.reservePaidRun({ reason: 'before-ttl' });
  assert.strictEqual(a.ok, true);
  const sessionFile = path.join(dir, `adp-real-ai-session-${a.sessionId}.json`);
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  s.createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // > 4h TTL
  fs.writeFileSync(sessionFile, JSON.stringify(s, null, 2));

  const b = guard.reservePaidRun({ reason: 'after-ttl' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.code, 'REAL_AI_NEW_SESSION_REQUIRES_OVERRIDE');
});

test('R3 §16 显式 new-session（人工 override 通道）→ 创建新 session 并留日志', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const a = guard.reservePaidRun({ reason: 'fill-1' });
  guard.reservePaidRun({ reason: 'fill-2' });
  const blocked = guard.reservePaidRun({ reason: 'should-block' });
  assert.strictEqual(blocked.code, 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED');

  const logs = [];
  const origLog = console.log;
  console.log = (msg) => { logs.push(String(msg)); };
  let acq;
  try {
    acq = guard.forceNewSession('explicit_new_session_command');
  } finally {
    console.log = origLog;
  }
  assert.strictEqual(acq.ok, true);
  assert.strictEqual(acq.createdNew, true);
  assert.notStrictEqual(acq.session.sessionId, a.sessionId, '必须是新 session');
  assert.strictEqual(acq.session.paidRunsStarted, 0);
  assert.ok(logs.some(l => l.includes('NEW_PAID_TEST_SESSION_CREATED')), '§17：override 必须留下日志');
  assert.ok(logs.some(l => l.includes('reason=explicit_new_session_command')));

  // 新 session 重新获得 2 个 slot
  const r = guard.reservePaidRun({ reason: 'new-session-run' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sessionId, acq.session.sessionId);
});

test('R3 §25 并发锁：锁被占用 → REAL_AI_SESSION_LOCKED（不冒险执行 Provider）；stale 锁可回收', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const lockFile = path.join(dir, 'adp-real-ai-session.lock');
  fs.writeFileSync(lockFile, 'other-pid', { flag: 'wx' });
  try {
    const r = guard.reservePaidRun({ reason: 'locked' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'REAL_AI_SESSION_LOCKED');
    assert.strictEqual(r.providerCallsStarted, 0);
  } finally {
    fs.unlinkSync(lockFile);
  }
  // stale 锁（>30s）应被回收
  fs.writeFileSync(lockFile, 'stale-pid', { flag: 'wx' });
  const past = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lockFile, past, past);
  const r2 = guard.reservePaidRun({ reason: 'after-stale' });
  assert.strictEqual(r2.ok, true, 'stale 锁回收后应可 reserve');
});

test('R3 §21 attempt 开始即计数：reserve 后不提供 refund（API failure 也消耗 attempt）', () => {
  const dir = tmpSessionDir();
  const guard = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  const a = guard.reservePaidRun({ reason: 'will-fail-at-api' });
  assert.strictEqual(a.ok, true);
  // 模拟 API failure：guard 无 refund 接口，计数保持
  const inspect = guard.inspect();
  assert.strictEqual(inspect.paidRunsStarted, 1);
});

test('R3 runSmoke 集成：session 已满 → BLOCKED exit=3 + Provider spy 零调用（deterministic 后拒绝）', async () => {
  // 独立 store：一个可用 DeepSeek 连接（AUTO 解析目标）
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r3-store-'));
  store.init(userData);
  store.connections.create({
    name: 'DS R3', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-r3-store'
  });

  const dir = tmpSessionDir();
  const prefill = createRealAiPaidRunGuard({ repoRoot: REPO_ROOT, sessionDir: dir });
  assert.strictEqual(prefill.reservePaidRun({ reason: 'prefill-1' }).ok, true);
  assert.strictEqual(prefill.reservePaidRun({ reason: 'prefill-2' }).ok, true);

  const spy = { constructions: 0, streamCalls: 0 };
  const factory = () => {
    spy.constructions += 1;
    return { async streamResponse() { spy.streamCalls += 1; return { content: '{}' }; } };
  };

  const savedEnv = process.env.REAL_AI_TEST_CONNECTION_ID;
  const savedModel = process.env.REAL_AI_TEST_MODEL;
  delete process.env.REAL_AI_TEST_CONNECTION_ID;
  process.env.REAL_AI_TEST_MODEL = 'r3-model'; // 测试 store 连接无 model 字段，用 override 提供
  let result;
  try {
    result = await runSmoke({ connectionId: null, store, sessionDir: dir, providerFactory: factory, dryRun: false });
  } finally {
    if (savedEnv !== undefined) process.env.REAL_AI_TEST_CONNECTION_ID = savedEnv;
    if (savedModel !== undefined) process.env.REAL_AI_TEST_MODEL = savedModel;
    else delete process.env.REAL_AI_TEST_MODEL;
  }

  assert.strictEqual(result.status, 'BLOCKED');
  assert.strictEqual(result.reason, 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED');
  assert.strictEqual(result.exitCode, 3);
  assert.strictEqual(result.providerCallsStarted, 0);
  assert.strictEqual(spy.constructions, 0, '第三次绝无 Provider 调用机会');
  assert.strictEqual(spy.streamCalls, 0);
});
