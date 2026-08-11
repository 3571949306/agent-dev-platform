'use strict';
/**
 * Deterministic Orchestrator Integration — v2.9.0 Real Runtime Smoke Closure（spec §7）。
 *
 * 在烧真实 API 前必须全绿的生产链路集成：
 *   只替换 LLM = FakeCodingModel，其余全部生产：
 *     MainAgentRuntime / AgentLoop / ActionExecutor / Built-in Tool Registry /
 *     PermissionEngine / PathSecurity / MainAgentOrchestrator / AgentHub /
 *     TestAgentAdapter reviewer / RunManager
 *
 * Fake model script：
 *   Turn 1 → delegate（real-ai-fixture-reviewer）
 *   Turn 2 → read_file
 *   Turn 3 → patch_file
 *   Turn 4 → run_tests
 *   Turn 5 → complete
 *
 * 必须在真实 TEMP fixture 上完成，且全部 R1-R9 风格的确定性断言通过：
 *   MODEL_ACTION(delegate) + orchestration.delegation.started 双层证据、
 *   生产工具事件（read_file / apply_patch / terminal_run）、
 *   Child Result 进入下一轮 model context、PathSecurity outside-write 拒绝、
 *   fixture 无条件清理（0 残留）。
 *
 * 本脚本不 PASS 时禁止运行真实 DeepSeek（real-ai-orchestrator-smoke.js 自动先跑本集成）。
 *
 * 运行：node scripts/deterministic-orchestrator-smoke.js
 */

const rt = require('./lib/real-ai-runtime');
const { createFakeCodingModel, buildDelegateFixAddScript } = require('../src/agent/runtime/fakeCodingModel');

function log(msg) { console.log(`[deterministic-integration] ${msg}`); }

/**
 * 运行一次 deterministic integration。
 * @returns {Promise<{ pass: boolean, report: object }>}
 */
async function runDeterministicIntegration() {
  const fakeModel = createFakeCodingModel(buildDelegateFixAddScript());
  let outcome = null;
  const leftoversBefore = rt.countFixtureLeftovers();

  // R8: fixture create/cleanup 同一函数 try/finally
  await rt.withRealAiFixture(async (fixture) => {
    outcome = await rt.executeRealAiChain({
      fixture,
      modelAdapter: fakeModel,
      timeoutMs: 120000,
      maxProviderCalls: 8
    });
  });

  const { pass, report, evidence } = outcome;
  const leftoversAfter = rt.countFixtureLeftovers();

  const checks = {
    pass,
    delegateModelAction: report.delegateModelAction,
    delegationStartedEvent: report.delegationStartedEvent,
    childAgentId: report.childAgentId === rt.REVIEWER_AGENT_ID,
    childResultConsumed: report.childResultConsumed,
    read_file: report.productionToolsObserved.read_file,
    mutation: report.productionToolsObserved.mutation,
    terminal_test: report.productionToolsObserved.terminal_test,
    testFileUnchanged: report.testFileUnchanged,
    packageJsonUnchanged: report.packageJsonUnchanged,
    onlyExpectedMutation: report.sourceModified,
    testsPass: report.testsPass,
    parentCompleted: report.parentStatus === 'completed',
    outsideWritesZero: report.successfulOutsideWrites === 0,
    fixtureLeakZero: leftoversAfter - leftoversBefore <= 0
  };

  const allOk = Object.values(checks).every(Boolean);
  return {
    pass: allOk,
    report: { ...report, checks, leftoversBefore, leftoversAfter, toolEvents: evidence.toolEvents.length }
  };
}

async function main() {
  log('Deterministic Integration — FakeCodingModel + 全生产链路（不消耗 API）');
  const { pass, report } = await runDeterministicIntegration();
  console.log('');
  console.log('DETERMINISTIC_ORCHESTRATOR_INTEGRATION');
  console.log(`Status: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`Checks: ${JSON.stringify(report.checks, null, 1)}`);
  console.log(`Delegation: MODEL_ACTION=${report.delegateModelAction} EVENT=${report.delegationStartedEvent} child=${report.childAgentId}`);
  console.log(`Consumed: ${report.childResultConsumed} (iter ${report.delegateIteration} → ${report.consumedIteration})`);
  console.log(`Production tools: ${JSON.stringify(report.productionToolsObserved)}`);
  console.log(`Files: modified=[${report.fileDiff.modified.join(', ')}] tests=${report.testsPass ? 'PASS' : 'FAIL'} parent=${report.parentStatus}`);
  console.log(`Outside writes: ${report.successfulOutsideWrites}; fixture leftovers delta<=0: ${report.checks.fixtureLeakZero}`);
  if (!pass) {
    console.log('NOTE: Deterministic Integration 未 PASS — 禁止运行真实 DeepSeek。');
  }
  process.exit(pass ? 0 : 1);
}

module.exports = { runDeterministicIntegration };

if (require.main === module) {
  main().catch((e) => {
    console.log('DETERMINISTIC_ORCHESTRATOR_INTEGRATION');
    console.log('Status: FAIL');
    console.log(`Reason: ${e.code || 'UNEXPECTED'}`);
    console.log(`Message: ${e.stack || e.message}`);
    process.exit(1);
  });
}
