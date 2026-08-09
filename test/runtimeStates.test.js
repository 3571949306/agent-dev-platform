'use strict';
/**
 * v2.6.0 — Main Agent Runtime 状态机单元测试（spec §5）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const states = require('../src/agent/runtime/states');

test('终态 / 非终态分类正确', () => {
  assert.strictEqual(states.isTerminal('COMPLETED'), true);
  assert.strictEqual(states.isTerminal('FAILED'), true);
  assert.strictEqual(states.isTerminal('CANCELLED'), true);
  assert.strictEqual(states.isTerminal('TIMEOUT'), true);
  assert.strictEqual(states.isTerminal('EXECUTING'), false);
  assert.strictEqual(states.isNonTerminal('PLANNING'), true);
  assert.strictEqual(states.isNonTerminal('COMPLETED'), false);
});

test('isValid 识别全部状态', () => {
  for (const s of states.ALL) assert.ok(states.isValid(s));
  assert.strictEqual(states.isValid('FOO'), false);
});

test('canTransition：同一状态允许', () => {
  assert.strictEqual(states.canTransition('EXECUTING', 'EXECUTING'), true);
  assert.strictEqual(states.canTransition('PLANNING', 'PLANNING'), true);
});

test('canTransition：合法迁移', () => {
  assert.strictEqual(states.canTransition('IDLE', 'PLANNING'), true);
  assert.strictEqual(states.canTransition('PLANNING', 'EXECUTING'), true);
  assert.strictEqual(states.canTransition('EXECUTING', 'TESTING'), true);
  assert.strictEqual(states.canTransition('TESTING', 'REPAIRING'), true);
  assert.strictEqual(states.canTransition('REPAIRING', 'EXECUTING'), true);
  assert.strictEqual(states.canTransition('EVALUATING', 'COMPLETED'), true);
});

test('canTransition：非法迁移', () => {
  // IDLE 不能直接到 TESTING（需先 PLAN/EXEC）
  assert.strictEqual(states.canTransition('IDLE', 'TESTING'), false);
  // WAITING_PERMISSION 只能到 EXECUTING/TESTING
  assert.strictEqual(states.canTransition('WAITING_PERMISSION', 'PLANNING'), false);
});

test('canTransition：终态后不再迁移', () => {
  assert.strictEqual(states.canTransition('COMPLETED', 'EXECUTING'), false);
  assert.strictEqual(states.canTransition('FAILED', 'PLANNING'), false);
  assert.strictEqual(states.canTransition('CANCELLED', 'EXECUTING'), false);
});

test('canTransition：非终态 → 终态允许（由 finishRun 处理）', () => {
  assert.strictEqual(states.canTransition('EXECUTING', 'FAILED'), true);
  assert.strictEqual(states.canTransition('TESTING', 'TIMEOUT'), true);
  assert.strictEqual(states.canTransition('PLANNING', 'CANCELLED'), true);
});

test('NON_TERMINAL / TERMINAL / ALL 数量一致', () => {
  assert.strictEqual(states.NON_TERMINAL.length, 9);
  assert.strictEqual(states.TERMINAL.length, 4);
  assert.strictEqual(states.ALL.length, 13);
});
