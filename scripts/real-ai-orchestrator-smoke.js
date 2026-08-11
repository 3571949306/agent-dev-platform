'use strict';
/**
 * Real AI Orchestrator Smoke — v2.9.0 Real Runtime Smoke Closure + Harness Safety Patch。
 *
 * 真实链路（唯一被接受的 Proof 链路）：
 *   REAL DEEPSEEK → MainAgentRuntime → MODEL ACTION: delegate → MainAgentOrchestrator
 *   → AgentHub → real-ai-fixture-reviewer → Child Result → Main Agent NEXT ITERATION
 *   → read_file → patch_file → terminal_run(test) → PASS → complete → Parent = completed
 *
 * Harness Safety Patch（本轮）三大安全 Gate：
 *   R1 Explicit Connection Fail-Closed：显式 ID（CLI / REAL_AI_TEST_CONNECTION_ID）无效时
 *      立即停止（EXPLICIT_CONNECTION_NOT_FOUND / EXPLICIT_CONNECTION_UNDECRYPTABLE），
 *      禁止 fallback 到 settings / Store / env —— 绝无 Provider 调用机会。
 *   R2 Cleanup Gate：fixture cleanup 失败 → REAL_AI_FIXTURE_CLEANUP_FAILED 覆盖原 PASS；
 *      finalPass = runtimePass && cleanupOk && 本 fixture root 已不存在。
 *   R3 Paid Run Guard：RealAiPaidRunGuard 在任何真实 Provider 请求之前 reserve slot；
 *      同一 Closure Session maxPaidRuns=2，第三次 REAL_AI_ATTEMPT_LIMIT_EXCEEDED（0 provider call）。
 *
 * 执行顺序（§10）：resolve connection → deterministic PASS → acquire paid-run slot → 真实 Provider。
 * 一次 CLI invocation 最多一个 paid run（§28，无自动 retry）。
 *
 * Dry Run（§36，不消耗 attempt）：--dry-run 或 REAL_AI_SMOKE_DRY_RUN=1，验证
 * Connection resolution / Attempt session / DPAPI decrypt / Model selection，providerCalls=0。
 *
 * 退出码：PASS=0；FAIL=1；ENVIRONMENT_FAILURE=2；BLOCKED(ATTEMPT_LIMIT)=3；SESSION_LOCKED=4；SKIP=0。
 *
 * 运行：node scripts/real-ai-orchestrator-smoke.js [connectionId] [--dry-run]
 */

const path = require('path');
const rt = require('./lib/real-ai-runtime');
const { createRealAiPaidRunGuard } = require('./lib/real-ai-paid-run-guard');

// ---------------------------------------------------------------------------
// Runtime 守卫：平台 Store 需要 Electron ABI 的 better-sqlite3，且平台 API Key
// 由 Electron safeStorage（DPAPI + app 身份绑定熵）加密 —— 只有以真实 App 身份
// （electron . 即 main.js）运行时才能解密。plain node 下自动 re-exec 到
// `electron . --real-ai-smoke`（main.js 门控模式，不初始化窗口/服务）。
// ---------------------------------------------------------------------------
if (require.main === module && process.type === undefined) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  let electronBin = null;
  try { electronBin = require('electron'); } catch { /* noop */ }
  if (electronBin && typeof electronBin === 'string') {
    const repoRoot = path.join(__dirname, '..');
    const args = ['.'];
    args.push('--real-ai-smoke');
    const argvTail = process.argv.slice(2);
    for (const a of argvTail) {
      if (a === '--dry-run') args.push('--real-ai-dry-run');
      else args.push(`--real-ai-connection=${a}`);
    }
    // §71 同款：退出码以结果文件为权威（Electron 的 process.exit 经 stdio/spawn
    // 转发链偶发丢失）；guard 预生成路径并经 env 传入，子进程写、父进程读。
    const resultFile = path.join(os.tmpdir(), `adp-real-ai-result-${Date.now()}-${process.pid}.json`);
    const r = spawnSync(electronBin, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, REAL_AI_RESULT_FILE: resultFile }
    });
    let code = r.status;
    try {
      const fromFile = JSON.parse(fs.readFileSync(resultFile, 'utf8')).exitCode;
      if (typeof fromFile === 'number') code = fromFile;
    } catch { /* stdout/exit 仍是备选 */ }
    try { fs.unlinkSync(resultFile); } catch { /* noop */ }
    process.exit(code === null || code === undefined ? 1 : code);
  }
  console.log('[real-ai-smoke] WARN: 非 Electron 运行时，平台 Store 不可用，Connection 解析将退化到 env fallback');
}

const MAX_PROVIDER_CALLS = 6;
const MAX_RUNTIME_MS = 360000;

function log(msg) { console.log(`[real-ai-smoke] ${msg}`); }

/** §10：仅 HTTP auth failure / quota exhausted / network unreachable 才算 Environment Failure。 */
function isEnvironmentFailure(message) {
  const m = String(message || '');
  return /(\b40[13]\b|\b429\b|API Key|鉴权|认证失败|额度|余额|insufficient|quota|billing)/i.test(m) ||
    /(network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket|unreachable|无法连接|网络)/i.test(m);
}

/** 脱敏：绝不打印 api_key；只留 Connection ID / Name / Provider / Model / Base URL host。 */
function describeConnection(resolved, modelInfo) {
  const c = resolved.conn;
  let host = null;
  try { if (c.base_url) host = new URL(c.base_url).host; } catch { /* noop */ }
  return [
    `Connection: ${c.name} (source=${resolved.source}, id=${resolved.connectionId})`,
    `Provider: ${c.provider}`,
    `Model: ${modelInfo.model} (source=${modelInfo.source})`,
    host ? `Base URL host: ${host}` : null,
    `Budget: ${MAX_PROVIDER_CALLS} provider calls / ${MAX_RUNTIME_MS}ms`
  ].filter(Boolean);
}

/**
 * Smoke 主体（可注入依赖，供单测以 Provider Spy / 隔离 session dir 验证安全语义）。
 * 返回 { status, reason?, exitCode, ... }，不做 process.exit。
 */
async function runSmoke(opts = {}) {
  const connectionId = opts.connectionId !== undefined ? opts.connectionId : (process.argv[2] || null);
  const dryRun = opts.dryRun !== undefined ? opts.dryRun
    : (process.argv.includes('--dry-run') || process.env.REAL_AI_SMOKE_DRY_RUN === '1');
  const repoRoot = opts.repoRoot || path.join(__dirname, '..');
  const store = opts.store !== undefined ? opts.store : rt.initStandaloneStore();
  const guard = opts.guard || createRealAiPaidRunGuard({ repoRoot, sessionDir: opts.sessionDir });
  const providerFactory = opts.providerFactory || ((conn) => require('../src/providers').getProvider(conn));

  log('v2.9.0 Real Runtime Smoke Closure — Real AI Orchestrator Smoke');

  // ---- Step 1: Connection 解析（R1 Fail-Closed；在一切之前）----
  const resolved = rt.resolveRealAiConnection(connectionId, { store });
  if (!resolved.ok) {
    if (resolved.code === 'CONNECTION_NOT_CONFIGURED') {
      console.log('');
      console.log('REAL_AI_ORCHESTRATOR_SMOKE');
      console.log('STATUS: SKIPPED');
      console.log('REASON: CONNECTION_NOT_CONFIGURED');
      console.log('NOTE: 在平台绑定 DeepSeek Test Connection 后重跑（或 REAL_AI_TEST_CONNECTION_ID / CLI arg）');
      return { status: 'SKIPPED', reason: 'CONNECTION_NOT_CONFIGURED', exitCode: 0, providerCallsStarted: 0 };
    }
    // EXPLICIT fail-closed：绝不 fallback；绝无 Provider 调用机会（provider 从未被构造）
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${resolved.code}`);
    console.log(`Detail: ${resolved.detail}`);
    console.log('Note: EXPLICIT 模式 fail-closed —— 禁止 fallback；Provider calls: 0');
    return { status: 'FAIL', reason: resolved.code, exitCode: 1, providerCallsStarted: 0 };
  }

  const modelInfo = rt.resolveSmokeModel({ conn: resolved.conn, store });
  if (!modelInfo.model) {
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log('Reason: CONNECTION_HAS_NO_MODEL');
    return { status: 'FAIL', reason: 'CONNECTION_HAS_NO_MODEL', exitCode: 1, providerCallsStarted: 0 };
  }
  for (const line of describeConnection(resolved, modelInfo)) log(line);

  // ---- Step 2: Session 状态（§27：Smoke 开始前打印；inspect 不消耗 slot）----
  const sessionBefore = guard.inspect();
  if (sessionBefore.hasSession) {
    log(`Real AI Session: ${sessionBefore.sessionId}`);
    log(`Paid runs: ${sessionBefore.paidRunsStarted} / ${sessionBefore.maxPaidRuns}（context=${sessionBefore.sameContext}, ttl-ok=${sessionBefore.withinTtl}）`);
  } else {
    log('Real AI Session: （无 —— 首次执行将创建）');
  }

  // ---- Step 3: Dry Run（§36：验证 resolution / session / DPAPI decrypt / model，0 provider call，不消耗 attempt）----
  if (dryRun) {
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: DRY_RUN');
    console.log(`Connection: ${resolved.conn.name} (source=${resolved.source}, key_decrypted=${!!resolved.conn.api_key})`);
    console.log(`Model: ${modelInfo.model} (source=${modelInfo.source})`);
    console.log(`Session: ${sessionBefore.hasSession ? sessionBefore.sessionId + ` (${sessionBefore.paidRunsStarted}/${sessionBefore.maxPaidRuns})` : 'none (first run will create)'}`);
    console.log('Provider calls: 0 (dry run 不消耗 paid attempt)');
    return { status: 'DRY_RUN', exitCode: 0, providerCallsStarted: 0, session: sessionBefore };
  }

  // ---- Step 4: Deterministic Integration 全绿前禁止烧真实 API ----
  const { runDeterministicIntegration } = require('./deterministic-orchestrator-smoke');
  log('Step 1/2 — Deterministic Integration（FakeCodingModel + 全生产链路，不消耗 API）');
  const det = await runDeterministicIntegration();
  if (!det.pass) {
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log('Reason: DETERMINISTIC_INTEGRATION_FAILED');
    console.log('Detail: ' + JSON.stringify(det.report, null, 1));
    console.log('Note: 禁止运行真实 DeepSeek（先修 deterministic integration）');
    return { status: 'FAIL', reason: 'DETERMINISTIC_INTEGRATION_FAILED', exitCode: 1, providerCallsStarted: 0 };
  }
  log('Deterministic Integration: PASS');

  // ---- Step 5: R3 Paid Run Guard —— 在任何真实 Provider 请求之前 reserve slot ----
  const slot = guard.reservePaidRun({
    connectionId: resolved.connectionId,
    model: modelInfo.model,
    reason: 'real-ai-orchestrator-smoke'
  });
  if (!slot.ok) {
    console.log('');
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: BLOCKED');
    console.log(`Reason: ${slot.code}`);
    if (slot.detail) console.log(`Detail: ${slot.detail}`);
    if (slot.sessionId) console.log(`Session: ${slot.sessionId} (${slot.paidRunsStarted}/${slot.maxPaidRuns})`);
    if (slot.code === 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED') {
      console.log('Provider calls: 0');
      console.log('Note: 同一 Closure Session 已达 maxPaidRuns；如确需新 session 必须由操作者显式');
      console.log('      执行 `npm run test:real-ai:new-session` 或外部环境传入 REAL_AI_ALLOW_NEW_SESSION=1。');
    }
    return {
      status: 'BLOCKED', reason: slot.code,
      exitCode: slot.code === 'REAL_AI_SESSION_LOCKED' ? 4 : 3,
      providerCallsStarted: 0,
      session: slot.sessionId || null
    };
  }
  log(`Reserved paid run: ${slot.paidRunsStarted} / ${slot.maxPaidRuns} (session=${slot.sessionId})`);

  // ---- Step 6: 真实 Provider 执行（§28：一次 CLI invocation 最多一个 paid run，无 retry）----
  const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
  const provider = providerFactory(resolved.conn);
  const budget = rt.createRealAiBudget({ maxProviderCalls: MAX_PROVIDER_CALLS, maxRuntimeMs: MAX_RUNTIME_MS });
  const mainModel = createProviderModelAdapter({
    buildProvider: () => provider,
    agent: { id: 'native-main', api_connection_id: resolved.conn.id, model: modelInfo.model },
    resolveModel: () => ({ model: modelInfo.model }),
    timeoutMs: MAX_RUNTIME_MS
  });

  log('Step 2/2 — Real DeepSeek 执行（真实 Main Agent Runtime）');

  // R2 Cleanup Gate：withRealAiFixture 在 cleanup 失败时抛 REAL_AI_FIXTURE_CLEANUP_FAILED（覆盖原 PASS）
  let outcome = null;
  let cleanupFailure = null;
  try {
    await rt.withRealAiFixture(async (fixture) => {
      outcome = await rt.executeRealAiChain({
        fixture,
        modelAdapter: mainModel,
        modelId: modelInfo.model,
        conn: resolved.conn,
        connectionSource: resolved.source,
        provider,
        store,
        budget,
        timeoutMs: MAX_RUNTIME_MS,
        maxProviderCalls: MAX_PROVIDER_CALLS
      });
    });
  } catch (e) {
    if (e && e.code === 'REAL_AI_FIXTURE_CLEANUP_FAILED') {
      cleanupFailure = e;
    } else {
      throw e;
    }
  }
  const leftovers = rt.countFixtureLeftovers(); // 仅诊断（并发友好：不作为唯一 Proof）

  const { pass, report, evidence } = outcome || { pass: false, report: null, evidence: { modelActions: [] } };
  // §5 finalPass = runtimePass && cleanupOk &&（withRealAiFixture 已保证）本 fixture root 不存在
  const finalPass = pass && !cleanupFailure;

  console.log('');
  console.log('REAL_AI_ORCHESTRATOR_SMOKE');

  // §10: Environment Failure 分类（API 能返回模型输出就不是环境 blocker）
  let exitCode;
  const modelProducedOutput = evidence.modelActions.length > 0;
  if (cleanupFailure) {
    console.log('Status: FAIL');
    console.log(`Reason: ${cleanupFailure.code}`);
    console.log(`Detail: ${cleanupFailure.message}`);
    console.log(`Note: runtime=${pass ? 'PASS' : 'FAIL'}，但 cleanup FAIL 覆盖最终结果（R2 Gate）`);
    exitCode = 1;
  } else if (!finalPass && report && report.parentStatus === 'failed' && report.parentError &&
      isEnvironmentFailure(report.parentError) && !modelProducedOutput) {
    console.log('Status: ENVIRONMENT_FAILURE');
    console.log(`Evidence: ${String(report.parentError).slice(0, 300)}`);
    console.log('Note: HTTP auth / quota / network 脱敏证据；修复环境后重跑（已消耗 1 个 paid attempt，§21）');
    exitCode = 2;
  } else {
    console.log(`Status: ${finalPass ? 'PASS' : 'FAIL'}`);
    exitCode = finalPass ? 0 : 1;
  }

  if (report) {
    console.log(`Provider: ${report.provider}`);
    console.log(`Model: ${report.model}`);
    console.log(`Provider calls: attempts=${report.budget.modelCallAttempts} started=${report.budget.providerCallsStarted} succeeded=${report.budget.providerCallsSucceeded} failed=${report.budget.providerCallsFailed} (max=${MAX_PROVIDER_CALLS})`);
    console.log(`Delegation: MODEL_ACTION(delegate)=${report.delegateModelAction} ORCHESTRATION(delegation.started)=${report.delegationStartedEvent} → ${report.delegateObserved ? 'YES' : 'NO'}`);
    console.log(`Child agent: ${report.childAgentId}`);
    console.log(`Child result consumed (real next-iteration context): ${report.childResultConsumed ? 'YES' : 'NO'} (delegate@iter=${report.delegateIteration}, consumed@iter=${report.consumedIteration})`);
    console.log(`Production tools: read_file=${report.productionToolsObserved.read_file} mutation=${report.productionToolsObserved.mutation} terminal_test=${report.productionToolsObserved.terminal_test}`);
    console.log(`File diff: modified=[${report.fileDiff.modified.join(', ')}] added=[${report.fileDiff.added.join(', ')}] removed=[${report.fileDiff.removed.join(', ')}]`);
    console.log(`Test file unchanged: ${report.testFileUnchanged ? 'YES' : 'NO'}; package.json unchanged: ${report.packageJsonUnchanged ? 'YES' : 'NO'}`);
    console.log(`Tests (harness re-run): ${report.testsPass ? 'PASS' : 'FAIL'} (exit=${report.harnessTestExitCode})`);
    console.log(`Parent: ${report.parentStatus}${report.parentError ? ' — ' + String(report.parentError).slice(0, 200) : ''}`);
    console.log(`Outside writes: ${report.successfulOutsideWrites}/${report.outsideWriteAttempts} attempts succeeded (must be 0)`);
    console.log(`Permission asks (all denied by policy): ${report.permissionAsks}`);
    console.log(`Elapsed: ${Math.round(report.elapsedMs / 1000)}s`);
  }
  console.log(`Cleanup: ${cleanupFailure ? 'FAIL (' + cleanupFailure.code + ')' : 'OK'}`);
  console.log(`Fixture leftovers (diagnostic): ${leftovers}`);
  console.log(`Paid session: ${slot.sessionId} (${slot.paidRunsStarted}/${slot.maxPaidRuns})`);

  if (!finalPass && !cleanupFailure && leftovers === 0) {
    console.log('Failure is runtime/prompt/parser/harness class — 不是 Environment Blocker，必须继续修。');
  }
  return {
    status: cleanupFailure ? 'FAIL' : (finalPass ? 'PASS' : ((exitCode === 2) ? 'ENVIRONMENT_FAILURE' : 'FAIL')),
    exitCode,
    report,
    cleanupFailure: cleanupFailure ? cleanupFailure.code : null,
    leftovers,
    session: slot.sessionId,
    providerCallsStarted: report ? report.budget.providerCallsStarted : 0
  };
}

async function main() {
  let result;
  try {
    result = await runSmoke();
  } catch (e) {
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${e.code || 'UNEXPECTED'}`);
    console.log(`Message: ${e.message}`);
    result = { status: 'FAIL', reason: e.code || 'UNEXPECTED', exitCode: 1 };
  }
  // §71 同款兑底：结果写文件（REAL_AI_RESULT_FILE），不依赖 stdout/exit code 转发链。
  if (process.env.REAL_AI_RESULT_FILE) {
    try {
      require('fs').writeFileSync(process.env.REAL_AI_RESULT_FILE, JSON.stringify({
        status: result.status,
        exitCode: result.exitCode,
        reason: result.reason || null,
        providerCallsStarted: result.providerCallsStarted || 0
      }, null, 2));
    } catch { /* stdout 仍是备选 */ }
  }
  process.exit(result.exitCode);
}

module.exports = { isEnvironmentFailure, main, runSmoke };

if (require.main === module) {
  main().catch((e) => {
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${e.code || 'UNEXPECTED'}`);
    console.log(`Message: ${e.message}`);
    process.exit(1);
  });
}
