'use strict';
/**
 * v2.6.0 — Action Schema 解析与校验单元测试（spec §25）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { validateAction, parseActionJson, parseAndValidate, ACTION_TYPES } = require('../src/agent/runtime/actionSchema');

test('validateAction：合法 { thought_summary, action }', () => {
  const r = validateAction({ thought_summary: '读取文件', action: { type: 'read_file', args: { path: 'src/a.js' } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action.type, 'read_file');
  assert.strictEqual(r.action.args.path, 'src/a.js');
  assert.strictEqual(r.action.thought, '读取文件');
});

test('validateAction：裸 action 对象也接受', () => {
  const r = validateAction({ type: 'run_tests', args: { command: 'npm test' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action.type, 'run_tests');
});

test('validateAction：缺 action.type → 失败 retryable', () => {
  const r = validateAction({ action: { args: {} } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('validateAction：未知类型 → 失败', () => {
  const r = validateAction({ action: { type: 'fly_to_moon', args: {} } });
  assert.strictEqual(r.ok, false);
  assert.ok(/未知/.test(r.error));
});

test('validateAction：非对象 → 失败', () => {
  assert.strictEqual(validateAction(null).ok, false);
  assert.strictEqual(validateAction('hello').ok, false);
  assert.strictEqual(validateAction(42).ok, false);
});

test('validateAction：args 缺省为空对象', () => {
  const r = validateAction({ action: { type: 'git_status' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.action.args, {});
});

test('validateAction：thought 截断到 500 字符', () => {
  const long = 'x'.repeat(1000);
  const r = validateAction({ thought_summary: long, action: { type: 'git_status' } });
  assert.strictEqual(r.action.thought.length, 500);
});

test('parseActionJson：纯 JSON', () => {
  const r = parseActionJson('{"action":{"type":"complete","args":{}}}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.raw.action.type, 'complete');
});

test('parseActionJson：```json 代码块', () => {
  const r = parseActionJson('下面是动作:\n```json\n{"action":{"type":"read_file","args":{"path":"a.js"}}}\n```\n');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.raw.action.type, 'read_file');
});

test('parseActionJson：前后带说明文字（第一个 { 到最后一个 }）', () => {
  const r = parseActionJson('我认为应该读取文件。{"action":{"type":"read_file","args":{"path":"a.js"}}} 以上。');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.raw.action.type, 'read_file');
});

test('parseActionJson：空 / 非字符串 → 失败', () => {
  assert.strictEqual(parseActionJson('').ok, false);
  assert.strictEqual(parseActionJson(null).ok, false);
  assert.strictEqual(parseActionJson('not json at all').ok, false);
});

test('parseAndValidate：完整流程', () => {
  const r = parseAndValidate('```json\n{"thought_summary":"测试","action":{"type":"run_tests","args":{"command":"npm test"}}}\n```');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action.type, 'run_tests');
  assert.strictEqual(r.action.thought, '测试');
});

test('parseAndValidate：malformed JSON → retryable', () => {
  const r = parseAndValidate('totally not json');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.retryable, true);
});

test('ACTION_TYPES 包含所有 spec §25 类型', () => {
  const required = ['read_file', 'read_files', 'search', 'patch_file', 'write_file', 'terminal', 'test', 'git_diff', 'complete', 'ask_permission', 'delegate'];
  // 注意：terminal→run_command, test→run_tests 在 executor 映射
  for (const t of ['read_file', 'read_files', 'search', 'patch_file', 'write_file', 'run_command', 'run_tests', 'git_diff', 'complete', 'ask_permission', 'delegate']) {
    assert.ok(ACTION_TYPES.includes(t), `缺少 action 类型: ${t}`);
  }
});
