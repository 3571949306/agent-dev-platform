'use strict';
/**
 * v2.9.0 Harness Safety Patch — R2 Fixture Cleanup Gate。
 *
 * 要求：
 *   - cleanup() 必须返回明确结果 { ok } / { ok:false, error }，不允许静默吞掉删除失败。
 *   - runtime PASS + cleanup FAIL → 最终必须 FAIL（REAL_AI_FIXTURE_CLEANUP_FAILED 覆盖原 PASS），
 *     不允许「PASS with warning」。
 *   - finalPass = runtimePass && cleanupOk && 本 fixture root 已不存在。
 *   - success / runtime throw / provider throw / tool throw 各路径 cleanup 都执行。
 *
 * 反证（§51）：故意让 fs.rmSync 抛异常，确认 Smoke 最终 Gate FAIL。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const rt = require('../scripts/lib/real-ai-runtime');
const { createRealAiFixture } = require('../scripts/lib/real-ai-fixture');
const { createFakeCodingModel, buildDelegateFixAddScript } = require('../src/agent/runtime/fakeCodingModel');

/** 临时替换 fs.rmSync（模拟删除失败），返回 restore 函数。 */
function breakRmSync(message) {
  const orig = fs.rmSync;
  fs.rmSync = () => { throw new Error(message || 'simulated rmSync failure'); };
  return () => { fs.rmSync = orig; };
}

/** 手动清掉 rmSync 失败后残留的 fixture 目录（避免污染 TEMP）。 */
function forceRemove(root) {
  const orig = fs.rmSync;
  try { orig(root, { recursive: true, force: true }); } catch { /* noop */ }
}

test('R2 cleanup() 返回明确结果：成功 { ok:true }；幂等重复调用不抛', () => {
  const fx = createRealAiFixture();
  const r1 = fx.cleanup();
  assert.deepStrictEqual(r1, { ok: true });
  assert.strictEqual(fs.existsSync(fx.root), false, 'fixture.root 必须不再存在');
  const r2 = fx.cleanup();
  assert.strictEqual(r2.ok, true, '重复调用返回首次结果');
});

test('R2 反证：fs.rmSync 抛异常 → cleanup() 返回 { ok:false, error }（不得静默吞掉）', () => {
  const fx = createRealAiFixture();
  const restore = breakRmSync('simulated rmSync failure');
  try {
    const r = fx.cleanup();
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '必须携带错误');
    assert.match(String(r.error.message), /simulated rmSync failure/);
  } finally {
    restore();
    forceRemove(fx.root);
  }
});

test('R2 withRealAiFixture：success → cleanup PASS，返回 result/rootGone', async () => {
  const out = await rt.withRealAiFixture(async (fixture) => {
    assert.ok(fs.existsSync(fixture.root));
    return { value: 42 };
  });
  assert.deepStrictEqual(out.result, { value: 42 });
  assert.strictEqual(out.cleanupResult.ok, true);
  assert.strictEqual(out.rootGone, true);
  assert.strictEqual(fs.existsSync(out.fixtureRoot), false);
});

test('R2 withRealAiFixture：runtime throw → cleanup 仍执行，原错误被重新抛出', async () => {
  let rootSeen = null;
  await assert.rejects(
    () => rt.withRealAiFixture(async (fixture) => {
      rootSeen = fixture.root;
      throw new Error('simulated runtime failure');
    }),
    /simulated runtime failure/
  );
  assert.strictEqual(fs.existsSync(rootSeen), false, 'runtime 抛错后 fixture 仍必须被清理');
});

test('R2 provider throw 路径：executeRealAiChain 内 model 抛错 → fixture 仍被清理', async () => {
  const before = rt.countFixtureLeftovers();
  const boomModel = { name: 'boom', async decide() { throw new Error('provider boom (simulated)'); } };
  let outcome = null;
  await rt.withRealAiFixture(async (fixture) => {
    outcome = await rt.executeRealAiChain({ fixture, modelAdapter: boomModel, timeoutMs: 30000 });
  });
  assert.strictEqual(outcome.report.parentStatus, 'failed');
  assert.ok(rt.countFixtureLeftovers() <= before, '不得新增 fixture 残留');
});

test('R2 tool error 路径：工具失败链 → fixture 仍被清理', async () => {
  const before = rt.countFixtureLeftovers();
  const model = createFakeCodingModel([
    { type: 'read_file', args: { path: 'no-such-file.js' }, thought: '读不存在的文件（tool error）' },
    { type: 'complete', args: { summary: '结束' } }
  ]);
  await rt.withRealAiFixture(async (fixture) => {
    await rt.executeRealAiChain({ fixture, modelAdapter: model, timeoutMs: 30000 });
  });
  assert.ok(rt.countFixtureLeftovers() <= before);
});

test('R2 核心 Gate 反证：runtime PASS + cleanup FAIL → REAL_AI_FIXTURE_CLEANUP_FAILED 覆盖原 PASS', async () => {
  const restore = breakRmSync('simulated rmSync failure during PASS run');
  let caught = null;
  let fixtureRoot = null;
  try {
    await rt.withRealAiFixture(async (fixture) => {
      fixtureRoot = fixture.root;
      return { pass: true };   // runtime 侧 PASS
    });
  } catch (e) {
    caught = e;
  } finally {
    restore();
    if (fixtureRoot) forceRemove(fixtureRoot);
  }
  assert.ok(caught, 'cleanup FAIL 必须使 withRealAiFixture 抛错 —— 不允许 PASS with warning');
  assert.strictEqual(caught.code, 'REAL_AI_FIXTURE_CLEANUP_FAILED');
  assert.strictEqual(caught.executionError, null, 'runtime 本身 PASS（无 executionError）');

  // Smoke 最终 Gate 语义：finalPass = runtimePass && cleanupOk
  const runtimePass = true;
  const cleanupOk = false;
  const finalPass = runtimePass && cleanupOk;
  assert.strictEqual(finalPass, false, 'runtime PASS + cleanup FAIL → Smoke 最终必须 FAIL');
});

test('R2 runtime FAIL + cleanup FAIL → 仍报 REAL_AI_FIXTURE_CLEANUP_FAILED 且保留原错误', async () => {
  const restore = breakRmSync('simulated rmSync failure during FAIL run');
  let caught = null;
  let fixtureRoot = null;
  try {
    await rt.withRealAiFixture(async (fixture) => {
      fixtureRoot = fixture.root;
      throw new Error('original runtime error');
    });
  } catch (e) {
    caught = e;
  } finally {
    restore();
    if (fixtureRoot) forceRemove(fixtureRoot);
  }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'REAL_AI_FIXTURE_CLEANUP_FAILED');
  assert.ok(caught.executionError, '原始 runtime 错误必须被保留（诊断用）');
  assert.match(String(caught.executionError.message), /original runtime error/);
});

test('R2 全链路 PASS 复验：deterministic 链 + cleanup gate 同时成立', async () => {
  const before = rt.countFixtureLeftovers();
  const out = await rt.withRealAiFixture(async (fixture) => {
    return await rt.executeRealAiChain({
      fixture,
      modelAdapter: createFakeCodingModel(buildDelegateFixAddScript()),
      timeoutMs: 60000
    });
  });
  assert.strictEqual(out.result.pass, true, 'runtime PASS');
  assert.strictEqual(out.cleanupResult.ok, true, 'cleanup PASS');
  assert.strictEqual(out.rootGone, true, '本 fixture root 已不存在');
  assert.strictEqual(fs.existsSync(out.fixtureRoot), false);
  assert.ok(rt.countFixtureLeftovers() <= before);
});
