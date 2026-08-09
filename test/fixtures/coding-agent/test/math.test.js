'use strict';
// Fake Coding Project fixture — math 测试（spec §34）。
// 使用 node:test，无需第三方依赖。

const { test } = require('node:test');
const assert = require('node:assert');
const { add, subtract } = require('../src/math');

test('add(1, 2) 应返回 3', () => {
  assert.strictEqual(add(1, 2), 3);
});

test('add(2, 3) 应返回 5', () => {
  assert.strictEqual(add(2, 3), 5);
});

test('subtract(5, 3) 应返回 2', () => {
  assert.strictEqual(subtract(5, 3), 2);
});
