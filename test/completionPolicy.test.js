'use strict';
/**
 * v2.6.0 — Completion Policy 单元测试（spec §14/§15）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('../src/agent/runtime/completionPolicy');
const planner = require('../src/agent/runtime/taskPlanner');
const { createBlackboard } = require('../src/agent/runtime/blackboard');

test('required 测试 PASS → satisfied', () => {
  const v = cp.evaluate({
    verification: [{ type: 'command', command: 'npm test', required: true, lastResult: { passed: true, exitCode: 0 } }],
    changedFiles: ['src/a.js'],
    requiredFiles: ['src/a.js'],
    unresolvedErrors: []
  });
  assert.strictEqual(v.satisfied, true);
});

test('required 测试 FAIL → 不得 completed', () => {
  const v = cp.evaluate({
    verification: [{ type: 'command', command: 'npm test', required: true, lastResult: { passed: false, exitCode: 1 } }]
  });
  assert.strictEqual(v.satisfied, false);
  assert.ok(v.reasons.some(r => /必需验证失败/.test(r)));
});

test('required 测试未执行 → 不得 completed', () => {
  const v = cp.evaluate({
    verification: [{ type: 'command', command: 'npm test', required: true }]
  });
  assert.strictEqual(v.satisfied, false);
  assert.ok(v.reasons.some(r => /必需验证未执行/.test(r)));
});

test('模型说 completed 但 tests FAIL → 不得 completed（spec §30）', () => {
  // 模拟模型返回 complete 但 verification 显示测试失败
  const v = cp.evaluate({
    verification: [{ type: 'command', command: 'npm test', required: true, lastResult: { passed: false, exitCode: 1 } }],
    unresolvedErrors: []
  });
  assert.strictEqual(v.satisfied, false);
});

test('未完成任务 → 不得 completed', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }, { title: 't2' }]);
  planner.completeTask(plan, plan.tasks[0].id);
  const v = cp.evaluate({ plan });
  assert.strictEqual(v.satisfied, false);
  assert.ok(v.reasons.some(r => /未完成任务/.test(r)));
});

test('所有任务完成 + 测试 PASS → satisfied', () => {
  const plan = planner.createPlan('g', [{ title: 't1' }]);
  planner.completeTask(plan, plan.tasks[0].id);
  const v = cp.evaluate({
    plan,
    verification: [{ type: 'command', command: 'npm test', required: true, lastResult: { passed: true } }],
    unresolvedErrors: []
  });
  assert.strictEqual(v.satisfied, true);
});

test('required 文件未修改 → 不得 completed', () => {
  const v = cp.evaluate({
    changedFiles: ['src/other.js'],
    requiredFiles: ['src/auth.js']
  });
  assert.strictEqual(v.satisfied, false);
  assert.ok(v.reasons.some(r => /src\/auth.js/.test(r)));
});

test('unresolved error → 不得 completed', () => {
  const v = cp.evaluate({ unresolvedErrors: ['登录仍失败'] });
  assert.strictEqual(v.satisfied, false);
  assert.ok(v.reasons.some(r => /未解决错误/.test(r)));
});

test('blackboard 有未解决问题 → 警告但可 satisfied', () => {
  const bb = createBlackboard('g');
  bb.problems.push('某个警告');
  const v = cp.evaluate({ blackboard: bb, unresolvedErrors: [] });
  // problems 是软约束（警告），不计入 missing
  assert.strictEqual(v.satisfied, true);
  assert.ok(v.reasons.some(r => /警告/.test(r)));
});

test('samePath：大小写 / 斜杠无关', () => {
  assert.strictEqual(cp.samePath('src\\A.js', 'src/a.js'), true);
  assert.strictEqual(cp.samePath('src/a.js', 'src/b.js'), false);
  assert.strictEqual(cp.samePath('', 'x'), false);
});

test('verificationFromPlan：从 plan 提取', () => {
  const plan = { verification: [{ type: 'command', command: 'npm test', required: true }] };
  const v = cp.verificationFromPlan(plan);
  assert.strictEqual(v.length, 1);
  assert.strictEqual(cp.verificationFromPlan(null).length, 0);
});
