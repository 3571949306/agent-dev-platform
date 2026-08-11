'use strict';
/**
 * v2.9.0 Real Runtime Smoke Closure（spec §7）— Deterministic Integration 纳入单测回归。
 *
 * FakeCodingModel（delegate → read_file → patch_file → run_tests → complete）
 * + 除 LLM 外全部生产链路（MainAgentRuntime / AgentLoop / ActionExecutor /
 * Built-in Tool Registry / PermissionEngine / PathSecurity / Orchestrator /
 * AgentHub / TestAgentAdapter reviewer / RunManager），在真实 TEMP fixture 上完成。
 *
 * 不消耗任何 API；该测试 FAIL 时禁止运行真实 DeepSeek。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { runDeterministicIntegration } = require('../scripts/deterministic-orchestrator-smoke');
const rt = require('../scripts/lib/real-ai-runtime');

test('§7 Deterministic Integration：FakeCodingModel + 全生产链路闭环（R2-R8 风格断言）', async () => {
  const before = rt.countFixtureLeftovers();
  const { pass, report } = await runDeterministicIntegration();
  assert.strictEqual(pass, true, 'Deterministic Integration 必须 PASS：' + JSON.stringify(report.checks, null, 1));

  // R5 双层证据
  assert.strictEqual(report.checks.delegateModelAction, true, 'MODEL_ACTION(delegate) 必须存在');
  assert.strictEqual(report.checks.delegationStartedEvent, true, 'orchestration.delegation.started 必须存在');
  assert.strictEqual(report.childAgentId, rt.REVIEWER_AGENT_ID);
  // R6 真实 runtime 消费证据
  assert.strictEqual(report.checks.childResultConsumed, true, '下一轮 model context 必须包含 reviewer finding');
  assert.ok(report.consumedIteration > report.delegateIteration, '消费必须发生在 delegate 之后的迭代');
  // R2 生产工具事件
  assert.deepStrictEqual(report.productionToolsObserved, { read_file: true, mutation: true, terminal_test: true });
  // R7 独立终验
  assert.strictEqual(report.checks.testFileUnchanged, true);
  assert.strictEqual(report.checks.packageJsonUnchanged, true);
  assert.strictEqual(report.checks.onlyExpectedMutation, true, 'src/math.js 必须是唯一 mutation');
  assert.strictEqual(report.checks.testsPass, true);
  assert.strictEqual(report.checks.parentCompleted, true);
  // R3 / R8
  assert.strictEqual(report.successfulOutsideWrites, 0);
  assert.ok(rt.countFixtureLeftovers() <= before, 'fixture 零残留');
});
