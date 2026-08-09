'use strict';
/**
 * v2.6.0 Main Agent Runtime — Project Blackboard（spec §23）。
 *
 * Shared Blackboard：Goal / Confirmed Facts / Current Problems / Important Files /
 * Completed / Pending。Main Agent 每轮可更新；以后 Subagent 会共享它。
 */

/**
 * 创建一个 Blackboard。
 * @param {string} goal 用户目标
 */
function createBlackboard(goal) {
  return {
    goal: String(goal || '').slice(0, 1000),
    confirmed: [],     // 已确认事实
    problems: [],      // 当前问题
    importantFiles: [],// 重要文件
    completed: [],     // 已完成项
    pending: [],       // 待办项
    latestTestStatus: null, // { passed, command, summary } | null
    updatedAt: Date.now()
  };
}

function update(bb, patch) {
  if (!bb || !patch) return bb;
  for (const key of ['confirmed', 'problems', 'importantFiles', 'completed', 'pending']) {
    if (Array.isArray(patch[key])) {
      // 合并去重（保留最近 50 条）
      const merged = [...bb[key], ...patch[key]];
      bb[key] = Array.from(new Set(merged)).slice(-50);
    }
  }
  if (patch.latestTestStatus !== undefined) bb.latestTestStatus = patch.latestTestStatus;
  if (patch.goal) bb.goal = String(patch.goal).slice(0, 1000);
  bb.updatedAt = Date.now();
  return bb;
}

/** 记录一个已确认事实。 */
function addFact(bb, fact) {
  if (!bb || !fact) return bb;
  const f = String(fact).slice(0, 500);
  if (!bb.confirmed.includes(f)) bb.confirmed.push(f);
  bb.confirmed = bb.confirmed.slice(-50);
  bb.updatedAt = Date.now();
  return bb;
}

/** 记录一个当前问题。 */
function addProblem(bb, problem) {
  if (!bb || !problem) return bb;
  const p = String(problem).slice(0, 500);
  if (!bb.problems.includes(p)) bb.problems.push(p);
  bb.problems = bb.problems.slice(-30);
  bb.updatedAt = Date.now();
  return bb;
}

/** 解决（移除）一个问题。 */
function resolveProblem(bb, problem) {
  if (!bb || !problem) return bb;
  const p = String(problem);
  bb.problems = bb.problems.filter(x => x !== p);
  bb.updatedAt = Date.now();
  return bb;
}

/**
 * 解决所有「包含给定子串」的问题（模糊匹配）。
 * 用于测试通过后清理「测试命令失败: npm test」这类以命令为标识的问题——
 * 之前 resolveProblem 用失败时的 repairReason（精确串）去匹配，但测试通过时
 * evaluateActionResult 返回的 repairReason 是空串，导致问题永远残留、阻塞完成。
 * @returns {number} 实际移除的问题数
 */
function resolveProblemsMatching(bb, substring) {
  if (!bb || !substring) return 0;
  const sub = String(substring);
  const before = bb.problems.length;
  bb.problems = bb.problems.filter(p => !String(p).includes(sub));
  const removed = before - bb.problems.length;
  if (removed > 0) bb.updatedAt = Date.now();
  return removed;
}

/** 记录重要文件。 */
function addImportantFile(bb, file) {
  if (!bb || !file) return bb;
  const f = String(file).slice(0, 500);
  if (!bb.importantFiles.includes(f)) bb.importantFiles.push(f);
  bb.importantFiles = bb.importantFiles.slice(-30);
  bb.updatedAt = Date.now();
  return bb;
}

/** 序列化为给模型的上下文片段。 */
function summarize(bb) {
  if (!bb) return '';
  const lines = [`目标: ${bb.goal}`];
  if (bb.confirmed.length) lines.push('已确认事实:\n' + bb.confirmed.map(f => '- ' + f).join('\n'));
  if (bb.problems.length) lines.push('当前问题:\n' + bb.problems.map(f => '- ' + f).join('\n'));
  if (bb.importantFiles.length) lines.push('重要文件: ' + bb.importantFiles.join(', '));
  if (bb.completed.length) lines.push('已完成: ' + bb.completed.slice(-10).join(', '));
  if (bb.pending.length) lines.push('待办:\n' + bb.pending.slice(-10).map(f => '- ' + f).join('\n'));
  if (bb.latestTestStatus) {
    lines.push(`最近测试: ${bb.latestTestStatus.passed ? 'PASS' : 'FAIL'} (${bb.latestTestStatus.command})`);
  }
  return lines.join('\n');
}

module.exports = {
  createBlackboard, update, addFact, addProblem, resolveProblem, resolveProblemsMatching,
  addImportantFile, summarize
};
