'use strict';
/**
 * v2.6.0 Main Agent Runtime — Task Planner（spec §7）。
 *
 * Main Agent 收到用户请求后建立 Execution Plan。Plan 由若干 Task 组成，
 * 每个 Task 有 id / title / status。Main Agent 可动态新增 / 修改 / 取消 /
 * 标记完成 / 重新打开失败任务。不要求用户手动拆任务。
 *
 * 本模块是 plan 的纯数据管理器；plan 的「生成」由模型（或 Fake Model）通过
 * planner action 提供，Planner 只负责存储与状态流转。
 */

const VALID_STATUS = ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'skipped'];

function newTaskId() {
  return 'task-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 创建一个 Plan。
 * @param {string} goal 用户目标
 * @param {Array<{title, id?}>} initialTasks 初始任务（可选）
 */
function createPlan(goal, initialTasks = []) {
  const tasks = (initialTasks || []).map(t => ({
    id: t.id || newTaskId(),
    title: String(t.title || '').slice(0, 200),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));
  return {
    goal: String(goal || '').slice(0, 1000),
    tasks,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function findTask(plan, taskId) {
  if (!plan || !plan.tasks) return null;
  return plan.tasks.find(t => t.id === taskId) || null;
}

function addTask(plan, title, opts = {}) {
  if (!plan) return null;
  const t = {
    id: opts.id || newTaskId(),
    title: String(title || '').slice(0, 200),
    status: opts.status || 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  plan.tasks.push(t);
  plan.updatedAt = Date.now();
  return t;
}

function updateTask(plan, taskId, patch) {
  const t = findTask(plan, taskId);
  if (!t) return null;
  if (patch.title) t.title = String(patch.title).slice(0, 200);
  if (patch.status && VALID_STATUS.includes(patch.status)) t.status = patch.status;
  t.updatedAt = Date.now();
  plan.updatedAt = Date.now();
  return t;
}

function cancelTask(plan, taskId) { return updateTask(plan, taskId, { status: 'cancelled' }); }
function completeTask(plan, taskId) { return updateTask(plan, taskId, { status: 'completed' }); }
function failTask(plan, taskId) { return updateTask(plan, taskId, { status: 'failed' }); }
function reopenTask(plan, taskId) { return updateTask(plan, taskId, { status: 'in_progress' }); }
function startTask(plan, taskId) { return updateTask(plan, taskId, { status: 'in_progress' }); }

/** 统计。 */
function stats(plan) {
  if (!plan || !plan.tasks) return { total: 0, completed: 0, pending: 0, inProgress: 0, failed: 0 };
  const s = { total: plan.tasks.length, completed: 0, pending: 0, inProgress: 0, failed: 0 };
  for (const t of plan.tasks) {
    if (t.status === 'completed') s.completed++;
    else if (t.status === 'pending') s.pending++;
    else if (t.status === 'in_progress') s.inProgress++;
    else if (t.status === 'failed') s.failed++;
  }
  return s;
}

/** 是否所有任务都已完成（或取消/跳过）。 */
function allDone(plan) {
  if (!plan || !plan.tasks || !plan.tasks.length) return true;
  return plan.tasks.every(t => ['completed', 'cancelled', 'skipped'].includes(t.status));
}

/** 序列化为给模型的上下文片段。 */
function summarize(plan) {
  if (!plan || !plan.tasks || !plan.tasks.length) return `目标: ${plan ? plan.goal : ''}\n（尚无任务）`;
  const lines = [`目标: ${plan.goal}`, '任务:'];
  const icons = { pending: '○', in_progress: '●', completed: '✓', failed: '✕', cancelled: '–', skipped: '–' };
  for (const t of plan.tasks) {
    lines.push(`  ${icons[t.status] || '○'} ${t.title}`);
  }
  return lines.join('\n');
}

module.exports = {
  VALID_STATUS, newTaskId,
  createPlan, findTask, addTask, updateTask,
  cancelTask, completeTask, failTask, reopenTask, startTask,
  stats, allDone, summarize
};
