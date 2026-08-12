'use strict';
/**
 * v2.6.0 Main Agent Runtime — Completion Policy（spec §14/§15）。
 *
 * 模型说「完成了」不能直接算完成；必须由 Runtime 判断。Completion 至少检查：
 *   - 计划任务是否完成
 *   - 要求文件是否修改
 *   - 命令是否成功
 *   - 要求测试是否 PASS
 *   - 是否存在 unresolved error
 *
 * Verification Contract（§15）：plan 中可定义 verification 列表，required=true 的
 * 命令必须 PASS 才能 completed。否则不得 completed（继续 Repair 或 FAILED）。
 */

/**
 * 评估是否满足完成策略。
 * @param {object} ctx {
 *   plan,                // taskPlanner plan
 *   blackboard,          // blackboard
 *   changedFiles,        // string[] 已修改文件
 *   verification,        // [{ type:'command', command, required, lastResult? }]
 *   unresolvedErrors,    // string[]
 *   requiredFiles,       // string[] 期望被修改的文件（可选）
 *   mutationSeq?,        // number 当前累计文件变异次数（v2.9.8 R4）
 *   latestTest?          // { passed, seq? } 最近一次测试运行结果（v2.9.8 R4）
 * }
 * @returns {{ satisfied: boolean, reasons: string[], missing: string[],
 *             verificationStatus: 'PASS'|'FAIL'|'NOT_AVAILABLE' }}
 */
function evaluate(ctx) {
  const reasons = [];
  const missing = [];
  const plan = ctx.plan;
  const bb = ctx.blackboard;
  const verification = Array.isArray(ctx.verification) ? ctx.verification : [];
  const unresolvedErrors = Array.isArray(ctx.unresolvedErrors) ? ctx.unresolvedErrors : [];
  const changedFiles = Array.isArray(ctx.changedFiles) ? ctx.changedFiles : [];
  const requiredFiles = Array.isArray(ctx.requiredFiles) ? ctx.requiredFiles : [];
  // v2.9.8 R4 — Verification Freshness：测试 PASS 只对执行时的代码状态有效。
  const mutationSeq = Number.isFinite(ctx.mutationSeq) ? ctx.mutationSeq : null;
  const latestTest = ctx.latestTest || null;

  // 1. 计划任务是否完成
  if (plan && plan.tasks && plan.tasks.length) {
    const incomplete = plan.tasks.filter(t => !['completed', 'cancelled', 'skipped'].includes(t.status));
    if (incomplete.length) {
      reasons.push(`还有 ${incomplete.length} 个未完成任务`);
      missing.push(...incomplete.map(t => `task:${t.title}`));
    }
  }

  // 2. 要求文件是否修改
  for (const f of requiredFiles) {
    if (!changedFiles.some(c => samePath(c, f))) {
      reasons.push(`要求修改的文件未修改: ${f}`);
      missing.push(`file:${f}`);
    }
  }

  // 3. required verification 命令必须 PASS，且不得过期（stale）
  let requiredVerificationCount = 0;
  for (const v of verification) {
    if (v.type === 'command' && v.required) {
      requiredVerificationCount++;
      const r = v.lastResult;
      if (!r) {
        reasons.push(`必需验证未执行: ${v.command}`);
        missing.push(`verify:${v.command}`);
      } else if (mutationSeq !== null && Number.isFinite(r.seq) && r.seq < mutationSeq) {
        // 验证通过后又发生了文件修改 → 旧 PASS 已 STALE，不得用于完成
        reasons.push(`必需验证已过期（seq=${r.seq} < mutation seq=${mutationSeq}）: ${v.command}`);
        missing.push(`verify-stale:${v.command}`);
      } else if (!r.passed) {
        reasons.push(`必需验证失败: ${v.command}（exit=${r.exitCode}）`);
        missing.push(`verify:${v.command}`);
      }
    }
  }

  // 3b. v2.9.8 R4 — 手动测试运行的新鲜度：最后一次 PASS 之后又有文件修改 →
  //     该 PASS 对当前代码状态无效，完成必须被拒绝（要求重新验证）。
  if (latestTest && latestTest.passed && mutationSeq !== null
      && Number.isFinite(latestTest.seq) && latestTest.seq < mutationSeq) {
    reasons.push(`最近一次测试通过后文件又被修改（测试 seq=${latestTest.seq} < mutation seq=${mutationSeq}），验证已过期，必须重新运行测试`);
    missing.push('verify:freshness');
  }
  // 3c. v2.9.8 R4 — 最近一次测试对当前代码状态失败 → 不得 completed（只能 REPAIR/FAILED）。
  if (latestTest && latestTest.passed === false
      && (mutationSeq === null || !Number.isFinite(latestTest.seq) || latestTest.seq >= mutationSeq)) {
    reasons.push(`最近一次测试对当前代码状态失败（exit=${latestTest.exitCode}），完成被拒绝`);
    missing.push('verify:latest-test-failed');
  }

  // 4. 是否存在 unresolved error
  if (unresolvedErrors.length) {
    reasons.push(`存在 ${unresolvedErrors.length} 个未解决错误`);
    missing.push(...unresolvedErrors.slice(0, 5).map(e => `error:${String(e).slice(0, 80)}`));
  }

  // 5. blackboard 中无未解决问题（软约束，只警告不计入 missing）
  if (bb && bb.problems && bb.problems.length) {
    reasons.push(`blackboard 仍有 ${bb.problems.length} 个未解决问题（警告）`);
  }

  // 6. v2.9.8 R4 — verificationStatus 真话：禁止伪造 Tests PASS。
  //    无 configured required verification 且从未运行测试 → NOT_AVAILABLE（可完成，
  //    但报告必须如实）；否则 PASS/FAIL 由新鲜且真实的验证结果决定。
  let verificationStatus;
  if (requiredVerificationCount > 0) {
    verificationStatus = missing.some(m => m.startsWith('verify')) ? 'FAIL' : 'PASS';
  } else if (latestTest) {
    const fresh = mutationSeq === null || !Number.isFinite(latestTest.seq) || latestTest.seq >= mutationSeq;
    verificationStatus = (latestTest.passed && fresh) ? 'PASS' : 'FAIL';
  } else {
    verificationStatus = 'NOT_AVAILABLE';
  }

  return { satisfied: missing.length === 0, reasons, missing, verificationStatus };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
}

/**
 * 从 plan.verification 或显式 verification 构建验证清单。
 * 兼容 plan 上挂 verification 字段。
 */
function verificationFromPlan(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.verification)) return plan.verification;
  return [];
}

module.exports = { evaluate, verificationFromPlan, samePath };
