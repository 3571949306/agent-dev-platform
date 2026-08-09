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
 *   requiredFiles        // string[] 期望被修改的文件（可选）
 * }
 * @returns {{ satisfied: boolean, reasons: string[], missing: string[] }}
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

  // 3. required verification 命令必须 PASS
  for (const v of verification) {
    if (v.type === 'command' && v.required) {
      const r = v.lastResult;
      if (!r) {
        reasons.push(`必需验证未执行: ${v.command}`);
        missing.push(`verify:${v.command}`);
      } else if (!r.passed) {
        reasons.push(`必需验证失败: ${v.command}（exit=${r.exitCode}）`);
        missing.push(`verify:${v.command}`);
      }
    }
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

  return { satisfied: missing.length === 0, reasons, missing };
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
