'use strict';
/**
 * v2.6.0 — Context Builder 单元测试（spec §21/§22）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildContext, compact, runSummary, projectSummary } = require('../src/agent/runtime/contextBuilder');
const { createBlackboard } = require('../src/agent/runtime/blackboard');
const planner = require('../src/agent/runtime/taskPlanner');

test('buildContext：包含目标 / 计划 / blackboard', () => {
  const plan = planner.createPlan('修复 add', [{ title: '读取文件' }, { title: '修复' }]);
  const bb = createBlackboard('修复 add');
  const ctx = buildContext({
    goal: '修复 add', plan, blackboard: bb,
    toolResults: [], changedFiles: [], iteration: 1, repairRounds: 0
  });
  assert.ok(ctx.includes('修复 add'));
  assert.ok(ctx.includes('读取文件'));
  assert.ok(ctx.includes('# 执行计划'));
});

test('buildContext：包含最近工具结果', () => {
  const ctx = buildContext({
    goal: 'g', toolResults: [
      { ok: true, tool: 'terminal_run', command: 'npm test', exitCode: 0 },
      { ok: false, tool: 'patch_file', path: 'src/a.js' }
    ],
    iteration: 2
  });
  assert.ok(ctx.includes('npm test'));
  assert.ok(ctx.includes('src/a.js'));
  assert.ok(ctx.includes('✕')); // 失败标记
});

test('buildContext：包含已修改文件', () => {
  const ctx = buildContext({ goal: 'g', changedFiles: ['src/a.js', 'src/b.js'] });
  assert.ok(ctx.includes('src/a.js'));
  assert.ok(ctx.includes('# 已修改文件'));
});

test('compact：少于上限时全部保留', () => {
  const r = compact([{ ok: true, tool: 'a' }, { ok: true, tool: 'b' }]);
  assert.strictEqual(r.recent.length, 2);
  assert.strictEqual(r.summary, '');
});

test('compact：超过上限时压缩早期结果', () => {
  const results = [];
  for (let i = 0; i < 15; i++) results.push({ ok: i % 2 === 0, tool: 'tool' + i });
  const r = compact(results);
  assert.ok(r.recent.length <= 12);
  assert.ok(r.summary.includes('已压缩'));
  assert.ok(r.summary.includes('tool0'));
});

test('runSummary：结构化摘要', () => {
  const plan = planner.createPlan('g', [{ title: 'done' }, { title: 'todo' }]);
  planner.completeTask(plan, plan.tasks[0].id);
  const bb = createBlackboard('g');
  bb.importantFiles.push('src/a.js');
  const s = runSummary({ goal: 'g', plan, blackboard: bb });
  assert.strictEqual(s.goal, 'g');
  assert.ok(s.completedTasks.includes('done'));
  assert.ok(s.pendingTasks.includes('todo'));
  assert.ok(s.importantFiles.includes('src/a.js'));
});

test('projectSummary：空 listDir 返回空', () => {
  assert.strictEqual(projectSummary('/tmp', null), '');
});

test('buildContext：currentTask 显示', () => {
  const plan = planner.createPlan('g', [{ title: '进行中' }]);
  planner.startTask(plan, plan.tasks[0].id);
  const ctx = buildContext({ goal: 'g', plan, currentTask: plan.tasks[0], iteration: 1 });
  assert.ok(ctx.includes('# 当前任务'));
  assert.ok(ctx.includes('进行中'));
});
