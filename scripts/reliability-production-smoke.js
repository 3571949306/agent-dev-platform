'use strict';
/**
 * v2.9.8 Real Project Reliability — R8 Production Matrix Smoke。
 *
 * `npm run test:reliability:production` 的入口：串行运行完整可靠性生产矩阵，
 * 汇总 PASS 的前提是每一条机器 Proof token 都能在真实套件输出中找到 ——
 * 任何套件失败立即非零退出，任何缺失 Proof 也判 FAIL（与 product-production-smoke
 * 相同的 fail-closed 语义）。
 *
 * 矩阵覆盖（R8-A..J + R6/R7 Supplemental）：
 *   reliabilityProduction   — ProductEntry 生产矩阵（R8-C 必需链 / R8-D / R8-E / R8-H / R7-A..E）
 *   reliabilityWorktree     — R1/R2/R8-A/R8-F/R8-G/R8-J（真实脏 Git / checkpoint / 破坏性拒绝）
 *   reliabilityFileMutation — R3/R8-E（stale write / 原子写 / 碰撞）
 *   reliabilityVerification — R4/R8-C/R8-D（验证新鲜度 / repair loop）
 *   reliabilityHangCleanup  — R6-A/D/E/G（挂死 / 取消 / 资源清零）
 *   reliabilityDelegation   — R6-C/F + Restart Truth
 *   reliabilityCancellation — R6 Supplemental（真实长命令取消 / 挂起模型取消）
 *   reliabilityLimits       — R6 Supplemental（run/迭代/工具/命令超时）
 *   reliabilityAudit        — R6/R8 Supplemental（Terminal Audit / 冷启动诚实）
 *   projectMutationLock     — R7 锁单元合同（生产 Proof 在 reliabilityProduction）
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

const suites = [
  { filter: 'reliabilityProduction', label: 'reliabilityProduction' },
  { filter: 'reliabilityWorktree', label: 'reliabilityWorktree' },
  { filter: 'reliabilityFileMutation', label: 'reliabilityFileMutation' },
  { filter: 'reliabilityVerification', label: 'reliabilityVerification' },
  { filter: 'reliabilityHangCleanup', label: 'reliabilityHangCleanup' },
  { filter: 'reliabilityDelegation', label: 'reliabilityDelegation' },
  { filter: 'reliabilityCancellation', label: 'reliabilityCancellation' },
  { filter: 'reliabilityLimits', label: 'reliabilityLimits' },
  { filter: 'reliabilityAudit', label: 'reliabilityAudit' },
  { filter: 'projectMutationLock', label: 'projectMutationLock' },
  { filter: 'reliabilityClosure', label: 'reliabilityClosure' }
];

const outputBySuite = {};
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), suite.filter], {
    cwd: root,
    env: process.env,
    encoding: 'utf8'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  outputBySuite[suite.label] = output;
  if (result.status !== 0) {
    console.error(`RELIABILITY_PRODUCTION_SMOKE FAIL suite=${suite.label} exitCode=${result.status}`);
    process.exit(result.status || 1);
  }
}

const prod = outputBySuite.reliabilityProduction;
const proof = {
  // R8 必需链：ProductEntry → real mutation → real node --test FAIL → Repair → PASS → completed
  r8cEntryProductEntry: prod.includes('RELIABILITY_PRODUCTION entry=ProductEntry failRepairPass=PASS')
    && prod.includes('verificationStatus=PASS') && prod.includes('dirtyMarkers=PRESERVED')
    && prod.includes('headUnchanged=YES'),
  r8dStaleVerification: prod.includes('R8_D_STALE_VERIFICATION blockedUntilFresh=YES'),
  r8eExternalEdit: prod.includes('R8_E_EXTERNAL_EDIT preserved=YES staleWritten=NO'),
  r8hCancellation: prod.includes('R8_H_CANCELLATION treeKilled=YES projectLock=0'),
  // R7 Production Assertions
  r7sameProject: prod.includes('R7_PRODUCTION_ABE runBMutationExec=0 interleavedWrites=0')
    && prod.includes('lockAfterCancel=0') && prod.includes('identityTruth=PASS'),
  r7failureAndIsolation: prod.includes('R7_PRODUCTION_CD lockAfterFailure=0 falseContention=NO'),
  // R6 Hang / Cancel / Cleanup
  r6modelHang: outputBySuite.reliabilityHangCleanup.includes('R6_A_MODEL_HANG status=timeout'),
  r6cancelModel: outputBySuite.reliabilityHangCleanup.includes('R6_D_CANCEL_DURING_MODEL'),
  r6cancelTool: outputBySuite.reliabilityHangCleanup.includes('R6_E_CANCEL_DURING_TOOL treeKilled=YES'),
  r6cancelVerification: outputBySuite.reliabilityHangCleanup.includes('R6_G_CANCEL_DURING_VERIFICATION'),
  r6childHang: outputBySuite.reliabilityDelegation.includes('R6_C_DYNAMIC_CHILD_HANG')
    && outputBySuite.reliabilityDelegation.includes('fakeChildSuccess=NO'),
  r6cancelDelegate: outputBySuite.reliabilityDelegation.includes('R6_F_CANCEL_DURING_DELEGATE')
    && outputBySuite.reliabilityDelegation.includes('propagation=YES'),
  r6restartTruth: outputBySuite.reliabilityDelegation.includes('R6_RESTART_TRUTH')
    && outputBySuite.reliabilityDelegation.includes('autoResume=NO'),
  // R1/R2/R8-A/F/G/J 真实 Git 矩阵
  r1DirtyWorktree: /ok \d+ - R1 dirty worktree: agent fix preserves/.test(outputBySuite.reliabilityWorktree),
  r1DestructiveGuard: /ok \d+ - R1 destructive git guard: denied permission/.test(outputBySuite.reliabilityWorktree),
  r2CheckpointNonMutating: /ok \d+ - R2 checkpoint create is NON-MUTATING/.test(outputBySuite.reliabilityWorktree),
  r2ExactCheckpoint: /ok \d+ - R2 restore is EXACT by checkpoint id/.test(outputBySuite.reliabilityWorktree),
  r2NonGitTruth: /ok \d+ - R2 non-git truthfulness/.test(outputBySuite.reliabilityWorktree),
  // R3/R4
  r3StaleWrite: /ok \d+ - R3 concurrent edit: stale write is rejected/.test(outputBySuite.reliabilityFileMutation),
  r4RepairLoop: /ok \d+ - R4 Scenario C: real repair loop/.test(outputBySuite.reliabilityVerification),
  // v2.9.8 Final Closure Patch R1-R5
  terminalTruth: outputBySuite.reliabilityClosure.includes('R1_TERMINAL_TRUTH timeout=timeout cancel=cancelled'),
  lockReleaseAfterDescendants: outputBySuite.reliabilityClosure.includes('R4_NESTED_DELEGATION rootRunIdShared=YES locksAfterTree=0'),
  prestartDelegateFailuresPreserved: outputBySuite.reliabilityClosure.includes('R3_PRESTART_IDENTITY')
    && outputBySuite.reliabilityClosure.includes('errorCode=DYNAMIC_AGENT_DEFINITION_NOT_FOUND'),
  nestedDelegationLockReentrancy: outputBySuite.reliabilityClosure.includes('R4_NESTED_DELEGATION rootRunIdShared=YES'),
  providerTimeoutAbort: outputBySuite.reliabilityClosure.includes('R5_PROVIDER_ABORT observed=true')
    && outputBySuite.reliabilityClosure.includes('lateResultIgnored=YES')
};

const allOutput = Object.values(outputBySuite).join('\n');
const paidTokens = [...allOutput.matchAll(/paidProviderCalls=(\d+)/g)].map(match => Number(match[1]));
const paidProviderCallsZero = paidTokens.length > 0 && paidTokens.every(value => value === 0);

const missing = Object.entries(proof).filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length || !paidProviderCallsZero) {
  if (missing.length) console.error(`RELIABILITY_PRODUCTION_SMOKE FAIL missing proof: ${missing.join(', ')}`);
  if (!paidProviderCallsZero) console.error('RELIABILITY_PRODUCTION_SMOKE FAIL paid provider calls not proven zero');
  process.exit(1);
}

console.log('RELIABILITY_PRODUCTION_SMOKE PASS');
for (const name of Object.keys(proof)) console.log(`${name}=PASS`);
console.log('paidProviderCalls=0');
