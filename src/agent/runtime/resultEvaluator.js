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

  return { needsRepair: false, repairReason: '', isTestFailure: false, fatal: false, fatalReason: '' };
}

/**
 * 把测试结果转成 blackboard 的 latestTestStatus。
 */
function testStatusFromResult(action, result) {
  if (!isTestAction(action) || !result) return null;
  return {
    passed: result.ok && result.passed !== false,
    command: action.args && action.args.command,
    exitCode: result.exitCode,
    summary: result.stderrSummary || result.stdoutSummary || '',
    errors: result.errors || []
  };
}

module.exports = { evaluateActionResult, testStatusFromResult, isTestCommand };
