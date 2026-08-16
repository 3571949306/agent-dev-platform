'use strict';
/**
 * v2.9.9 Computer Use 2.0-A.1 — Computer Tool Profile 测试。
 * 不暴露 coding/terminal/fs/git/delete/raw-coordinate；validator 拒绝未知 tool 与非法参数。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { computerToolProfile, COMPUTER_ALLOWED, buildTools, validateToolCall } = require('../src/agents/computerToolProfile');

test('profile 不暴露 coding/terminal/fs/git/delete/raw-coordinate', () => {
  const tools = buildTools();
  const names = new Set(tools.map(t => t.name));
  for (const bad of ['computer_click_at', 'terminal_run', 'write_file', 'delete_file', 'git_diff', 'read_file']) {
    assert.ok(!names.has(bad), `不应暴露 ${bad}`);
  }
  assert.ok(names.has('computer_set_element_value'));
  assert.ok(names.has('computer_invoke_element'));
  assert.ok(names.has('complete'));
  assert.strictEqual(computerToolProfile.multipleToolCallPolicy, 'single');
});

test('validator 拒绝未知 tool 与缺参/类型错', () => {
  assert.strictEqual(validateToolCall('computer_click_at', {}).ok, false, 'deprecated raw coordinate 拒绝');
  assert.strictEqual(validateToolCall('not_a_tool', {}).ok, false);
  assert.strictEqual(validateToolCall('computer_set_element_value', { observation_id: 'o', element_ref: 'e' }).ok, false, '缺 text');
  const ok = validateToolCall('computer_set_element_value', { observation_id: 'o', element_ref: 'e', text: 'hi' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(validateToolCall('computer_set_element_value', { observation_id: 'o', element_ref: 'e', text: 123 }).ok, false, 'text 类型错');
});
