'use strict';
/**
 * v2.6.0 Main Agent Runtime — Result Evaluator（spec §13）。
 *
 * 评估工具 / 测试结果，决定：
 *   - 是否需要 repair（测试失败 → REPAIRING）
 *   - 是否可进入完成评估（EVALUATING）
 *   - 是否出现无法自动解决的问题
 */

const { isTestAction, isTestCommand } = require('./actionExecutor');

/**
 * 评估一次工具结果，给出 loop 决策建议。
 * @param {object} action  执行的 action
 * @param {object} result  actionExecutor 返回的 Tool Result
 * @returns {{
 *   needsRepair: boolean,     // 是否需要进入修复
 *   repairReason: string,
 *   isTestFailure: boolean,   // 是否为测试失败
 *   fatal: boolean,           // 是否致命（无法自动修复）
 *   fatalReason: string
 * }}
 */
function evaluateActionResult(action, result) {
  // 测试类 action 失败 → 需要 repair
  if (isTestAction(action) && result && !result.ok) {
    return {
      needsRepair: true,
      repairReason: `测试命令失败: ${action.args && action.args.command}`,
      isTestFailure: true,
      fatal: false,
      fatalReason: ''
    };
  }
  if (isTestAction(action) && result && result.ok && result.passed === false) {
    return {
      needsRepair: true,
      repairReason: `测试未通过: ${action.args && action.args.command}（exit=${result.exitCode}）`,
      isTestFailure: true,
      fatal: false,
      fatalReason: ''
    };
  }

  // patch 失败（上下文不匹配）→ 需要 repair（重新读取再生成 patch）
  if (action && action.type === 'patch_file' && result && !result.ok) {
    return {
      needsRepair: true,
      repairReason: 'patch 应用失败，需重新读取文件并生成 patch',
      isTestFailure: false,
      fatal: false,
      fatalReason: ''
    };
  }

  // 权限拒绝 → 致命（不能假装完成）
  if (result && result.error && /PERMISSION_DENIED|USER_DENIED/.test(result.error.code || '')) {
    return {
      needsRepair: false,
      repairReason: '',
      isTestFailure: false,
      fatal: true,
      fatalReason: '权限被拒绝，无法继续'
    };
  }

  // 路径逃逸 → 致命（安全）
  if (result && result.error && /PATH_OUTSIDE_WORKSPACE|SYMLINK_ESCAPE/.test(result.error.code || '')) {
    return {
      needsRepair: false,
      repairReason: '',
      isTestFailure: false,
      fatal: true,
      fatalReason: '路径违反项目沙箱策略'
    };
  }

  // v2.9.8 R6-C — Child 真实进入执行却未成功（timeout/failed/cancelled）绝不允许被静默吞掉：
  // 进入 repair 通道并把失败记入 blackboard 未解决问题，完成策略会拒绝
  // 「假装 Child 成功」的 complete；模型可修复/重试，否则以 repair 上限诚实失败。
  // 区分于策略/守卫拦截（HOOK_BLOCKED、PERMISSION_DENIED、DELEGATE_START_FAILED 等）：
  // 那些是「Child 从未启动」的工具反馈，父 Agent 观察后自行决策（与其他工具失败同语义）。
  if (action && action.type === 'delegate' && result && result.ok === false
      && result.error && /^DELEGATE_(TIMEOUT|FAILED|CANCELLED|INTERRUPTED|UNAVAILABLE)$/.test(result.error.code || '')) {
    return {
      needsRepair: true,
      repairReason: `委派任务失败: ${result.error.code}（${result.error.message || ''}）`,
      isTestFailure: false,
      fatal: false,
      fatalReason: ''
    };
  }

  return { needsRepair: false, repairReason: '', isTestFailure: false, fatal: false, fatalReason: '' };
}

/**
 * 把测试结果转成 blackboard 的 latestTestStatus。
 * v2.9.8 R4：exitCode 必须显式判 0 —— 非零退出码是 truthy 数字，旧逻辑
 * `result.ok && result.passed !== false` 会把 exit=1 误判为 PASS（假验证）。
 */
function testStatusFromResult(action, result) {
  if (!isTestAction(action) || !result) return null;
  const hasExitCode = result.exitCode !== undefined && result.exitCode !== null;
  const passed = hasExitCode ? result.exitCode === 0 : (result.ok && result.passed !== false);
  return {
    passed,
    command: action.args && action.args.command,
    exitCode: result.exitCode,
    summary: result.stderrSummary || result.stdoutSummary || '',
    errors: result.errors || []
  };
}

module.exports = { evaluateActionResult, testStatusFromResult, isTestCommand };
