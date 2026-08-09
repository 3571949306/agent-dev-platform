'use strict';
/**
 * v2.6.0 — Task Planner 单元测试（spec §7）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const planner = require('../src/agent/runtime/taskPlanner');

test('createPlan：带初始任务', () => {
  const plan = planner.createPlan('加入深色模式', [
    { title: '分析 UI 结构' },
    { title: '实现主题切换' },
    { title: '运行测试' }
  ]);
  assert.strictEqual(plan.goal, '加入深色模式');
  assert.strictEqual(plan.tasks.length, 3);
  assert.ok(plan.tasks[0].id);
  assert.strictEqual(plan.tasks[0].status, 'pending');
});

test('createPlan：空任务', () => {
  const plan = planner.createPlan('目标');
  assert.strictEqual(plan.tasks.length, 0);
});

test('addTask：动态新增任务', () => {
  const plan = planner.createPlan('g');
  const t = planner.addTask(plan, '新任务');
  assert.strictEqual(plan.tasks.length, 1);
  assert.strictEqual(t.title, '新任务');
  assert.strictEqual(t.status, 'pending');
});

test('updateTask：状态变化', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }]);
  const t = plan.tasks[0];
  planner.startTask(plan, t.id);
  assert.strictEqual(t.status, 'in_progress');
  planner.completeTask(plan, t.id);
  assert.strictEqual(t.status, 'completed');
  planner.failTask(plan, t.id);
  assert.strictEqual(t.status, 'failed');
});

test('cancelTask / reopenTask', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }]);
  const t = plan.tasks[0];
  planner.cancelTask(plan, t.id);
  assert.strictEqual(t.status, 'cancelled');
  planner.reopenTask(plan, t.id);
  assert.strictEqual(t.status, 'in_progress');
});

test('updateTask：无效状态拒绝', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }]);
  const t = plan.tasks[0];
  planner.updateTask(plan, t.id, { status: 'wat' });
  assert.strictEqual(t.status, 'pending'); // 未变
});

test('findTask：找不到返回 null', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }]);
  assert.strictEqual(planner.findTask(plan, 'nope'), null);
  assert.strictEqual(planner.findTask(null, 'x'), null);
});

test('stats：统计各状态数量', () => {
  const plan = planner.createPlan('g', [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
  planner.completeTask(plan, plan.tasks[0].id);
  planner.startTask(plan, plan.tasks[1].id);
  planner.failTask(plan, plan.tasks[2].id);
  const s = planner.stats(plan);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.inProgress, 1);
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.pending, 0);
});

test('allDone：全部完成才 true', () => {
  const plan = planner.createPlan('g', [{ title: 'a' }, { title: 'b' }]);
  assert.strictEqual(planner.allDone(plan), false);
  planner.completeTask(plan, plan.tasks[0].id);
  assert.strictEqual(planner.allDone(plan), false);
  planner.completeTask(plan, plan.tasks[1].id);
  assert.strictEqual(planner.allDone(plan), true);
});

test('allDone：cancelled/skipped 也算 done', () => {
  const plan = planner.createPlan('g', [{ title: 'a' }]);
  planner.cancelTask(plan, plan.tasks[0].id);
  assert.strictEqual(planner.allDone(plan), true);
});

test('allDone：空 plan 视为 done', () => {
  assert.strictEqual(planner.allDone(planner.createPlan('g')), true);
});

test('summarize：渲染任务图标', () => {
  const plan = planner.createPlan('加入深色模式', [{ title: '分析' }, { title: '实现' }]);
  planner.completeTask(plan, plan.tasks[0].id);
  const s = planner.summarize(plan);
  assert.ok(s.includes('✓'));
  assert.ok(s.includes('○'));
  assert.ok(s.includes('分析'));
});

test('newTaskId：每次不同', () => {
  const a = planner.newTaskId();
  const b = planner.newTaskId();
  assert.notStrictEqual(a, b);
});
