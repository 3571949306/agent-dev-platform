'use strict';
/**
 * v2.6.0 — Blackboard + Runtime 编排单元测试（spec §23）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const bb = require('../src/agent/runtime/blackboard');

test('createBlackboard：初始状态', () => {
  const b = bb.createBlackboard('修复登录');
  assert.strictEqual(b.goal, '修复登录');
  assert.deepStrictEqual(b.confirmed, []);
  assert.deepStrictEqual(b.problems, []);
  assert.strictEqual(b.latestTestStatus, null);
});

test('addFact：去重 + 截断', () => {
  const b = bb.createBlackboard('g');
  bb.addFact(b, 'add 函数有 bug');
  bb.addFact(b, 'add 函数有 bug'); // 重复
  assert.strictEqual(b.confirmed.length, 1);
  const long = 'x'.repeat(600);
  bb.addFact(b, long);
  assert.ok(b.confirmed[1].length <= 500);
});

test('addProblem / resolveProblem', () => {
  const b = bb.createBlackboard('g');
  bb.addProblem(b, '测试失败');
  assert.strictEqual(b.problems.length, 1);
  bb.resolveProblem(b, '测试失败');
  assert.strictEqual(b.problems.length, 0);
});

test('addImportantFile：去重', () => {
  const b = bb.createBlackboard('g');
  bb.addImportantFile(b, 'src/math.js');
  bb.addImportantFile(b, 'src/math.js');
  assert.strictEqual(b.importantFiles.length, 1);
});

test('update：合并数组字段', () => {
  const b = bb.createBlackboard('g');
  bb.addFact(b, 'fact1');
  bb.update(b, { confirmed: ['fact2'], problems: ['p1'] });
  assert.ok(b.confirmed.includes('fact1'));
  assert.ok(b.confirmed.includes('fact2'));
  assert.ok(b.problems.includes('p1'));
});

test('update：latestTestStatus', () => {
  const b = bb.createBlackboard('g');
  bb.update(b, { latestTestStatus: { passed: true, command: 'npm test' } });
  assert.strictEqual(b.latestTestStatus.passed, true);
});

test('summarize：包含目标与各字段', () => {
  const b = bb.createBlackboard('修复 add');
  bb.addFact(b, 'add 返回减法');
  bb.addProblem(b, '测试失败');
  bb.addImportantFile(b, 'src/math.js');
  bb.update(b, { latestTestStatus: { passed: false, command: 'npm test' } });
  const s = bb.summarize(b);
  assert.ok(s.includes('修复 add'));
  assert.ok(s.includes('add 返回减法'));
  assert.ok(s.includes('测试失败'));
  assert.ok(s.includes('src/math.js'));
  assert.ok(s.includes('FAIL'));
});

test('summarize：空 blackboard 也安全', () => {
  const b = bb.createBlackboard('');
  const s = bb.summarize(b);
  assert.ok(s.includes('目标'));
});
