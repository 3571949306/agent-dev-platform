'use strict';
/**
 * v2.9.9 体验对标 Phase 6 — Patch 空白容忍匹配测试。
 *
 *  - context/删除行与文件实际内容仅缩进空白不同 → 应用成功，保留文件原有缩进，whitespaceFuzzy=true
 *  - 内容本身不同（非空白差异）→ 三级匹配均失败，正确报错（防止空白容忍掩盖真实错误）
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { applyToLines } = require('../src/tools/patch');

test('仅缩进空白差异 → 应用成功且保留文件原缩进 + whitespaceFuzzy=true', () => {
  const lines = ['function a() {', '    return 1;', '}'];
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' function a() {',
    '   return 1;',   // 2 空格，文件是 4 空格 → 仅空白差异
    '-}',
    '+};'
  ].join('\n');
  const meta = {};
  const out = applyToLines(lines, patch, meta);
  assert.strictEqual(meta.whitespaceFuzzy, true, '应标记空白容忍匹配');
  assert.strictEqual(out[1], '    return 1;', 'context 行应保留文件原有 4 空格缩进');
  assert.strictEqual(out[2], '};', '删除/新增行正常应用');
});

test('内容本身不同 → 三级匹配均失败并报错', () => {
  const lines = ['function a() {', '    return 1;', '}'];
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' function a() {',
    '   return 999;',  // 内容不同，不只是空白
    '-}',
    '+};'
  ].join('\n');
  assert.throws(() => applyToLines(lines, patch, {}), /空白容忍匹配均未成功/, '应明确说明三级匹配均失败');
});

test('精确匹配优先：完全一致时不标记 whitespaceFuzzy', () => {
  const lines = ['a', 'b', 'c'];
  const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n');
  const meta = {};
  const out = applyToLines(lines, patch, meta);
  assert.strictEqual(meta.whitespaceFuzzy, undefined, '精确匹配不应标记模糊');
  assert.deepStrictEqual(out, ['a', 'B', 'c']);
});
