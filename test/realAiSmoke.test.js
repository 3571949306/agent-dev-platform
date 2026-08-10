'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 2 Real AI Smoke 单元测试（spec §19-53）。
 *
 * 这些测试不消耗任何 API（§109）：只验证真实生产路径的「构建块」正确性。
 *   - §21：createRealAiFixture() 独立可用（目录创建顺序 / 去重 / cleanup）
 *   - §31-32：resolveRealAiConnection 优先平台 Store，env 仅 fallback；无 Connection → null（SKIP）
 *   - §37-39：createBudgetEnforcer 真实统计 model calls，超限立即抛 REAL_AI_BUDGET_EXCEEDED
 *   - §102：buildMainModelAdapter.decide() 包装生产 provider.streamResponse 并记账
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const {
  resolveRealAiConnection, createBudgetEnforcer, buildMainModelAdapter, createRealAiFixture
} = require('../scripts/real-ai-orchestrator-smoke');
const { sha256File } = require('../scripts/lib/real-ai-fixture');

test('§21 createRealAiFixture 独立可用：返回字段 + cleanup 删除目录', () => {
  const fx = createRealAiFixture();
  try {
    assert.ok(fs.existsSync(fx.root), 'fixture 目录应存在');
    assert.ok(fs.existsSync(fx.sourcePath), 'src/math.js 应存在');
    assert.ok(fs.existsSync(fx.testPath), 'test/math.test.js 应存在');
    assert.ok(typeof fx.sha256Test === 'string' && fx.sha256Test.length === 64, 'sha256Test 应为 64 位 hex');
    // §46/§47：sha 与独立计算一致
    assert.strictEqual(fx.sha256Test, sha256File(fx.testPath));
    // 初始测试应 FAIL（add 用了减法）—— 验证 fixture 真的有 bug
    assert.throws(() => require('child_process').execFileSync(process.execPath, [fx.testPath], { cwd: fx.root, stdio: 'pipe' }));
  } finally {
    fx.cleanup();
  }
  assert.strictEqual(fs.existsSync(fx.root), false, 'cleanup 后应删除目录');
});

test('§21/§52 createRealAiFixture 不含重复写入（cleanup 幂等）', () => {
  const fx = createRealAiFixture();
  fx.cleanup();
  fx.cleanup(); // 第二次调用不应抛
  assert.strictEqual(fs.existsSync(fx.root), false);
});

test('§31-32 无 Connection → resolveRealAiConnection 返回 null（SKIP 路径）', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const resolved = resolveRealAiConnection(null);
    assert.strictEqual(resolved, null, '无 store connection 且无 env key → 必须为 null（如实 SKIP，不得伪造）');
  } finally {
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('§32 env fallback：设置 DEEPSEEK_API_KEY 时解析出 env Connection', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-unit-test-placeholder';
  try {
    const resolved = resolveRealAiConnection(null);
    assert.ok(resolved, '应有解析结果');
    assert.strictEqual(resolved.source, 'env');
    assert.strictEqual(resolved.conn.api_key, 'sk-unit-test-placeholder');
  } finally {
    if (saved) process.env.DEEPSEEK_API_KEY = saved; else delete process.env.DEEPSEEK_API_KEY;
  }
});

test('§37-39 createBudgetEnforcer：超限立即抛 REAL_AI_BUDGET_EXCEEDED', () => {
  const budget = createBudgetEnforcer({ maxModelCalls: 2, maxRuntimeMs: 60000 });
  budget.recordModelCall();
  budget.recordModelCall();
  assert.throws(() => budget.recordModelCall(), /REAL_AI_BUDGET_EXCEEDED/);
});

test('§37-39 createBudgetEnforcer：超时立即抛 REAL_AI_RUNTIME_EXCEEDED', () => {
  const budget = createBudgetEnforcer({ maxModelCalls: 999, maxRuntimeMs: -1 });
  assert.throws(() => budget.checkRuntime(), /REAL_AI_RUNTIME_EXCEEDED/);
});

test('§102 buildMainModelAdapter.decide 包装 provider.streamResponse 并记账', async () => {
  let streamCalled = false;
  const provider = {
    async streamResponse(opts) {
      streamCalled = true;
      assert.strictEqual(opts.model, 'deepseek-chat');
      return { content: 'action-json' };
    }
  };
  const budget = createBudgetEnforcer({ maxModelCalls: 5, maxRuntimeMs: 60000 });
  const adapter = buildMainModelAdapter(provider, 'deepseek-chat', budget);
  assert.strictEqual(typeof adapter.decide, 'function', '必须是带 decide 的 Model Adapter');
  const out = await adapter.decide({ system: 's', context: 'c', abortSignal: null });
  assert.strictEqual(streamCalled, true);
  assert.strictEqual(out.text, 'action-json');
  assert.strictEqual(budget.modelCalls, 1);
});

test('§102 buildMainModelAdapter.decide 在超限时抛错（不会无限调用 API）', async () => {
  const provider = { async streamResponse() { return { content: 'x' }; } };
  const budget = createBudgetEnforcer({ maxModelCalls: 0, maxRuntimeMs: 60000 });
  const adapter = buildMainModelAdapter(provider, 'deepseek-chat', budget);
  await assert.rejects(() => adapter.decide({ system: 's', context: 'c' }), /REAL_AI_BUDGET_EXCEEDED/);
});
