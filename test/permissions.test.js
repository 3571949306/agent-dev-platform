'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PermissionEngine, SCOPES, DEFAULT_POLICY } = require('../src/security/permissions');

test('默认策略：读写文件放行，删除与危险命令需询问', () => {
  const pe = new PermissionEngine();
  assert.strictEqual(pe.evaluate('filesystem.read'), 'allow');
  assert.strictEqual(pe.evaluate('filesystem.write'), 'allow');
  assert.strictEqual(pe.evaluate('filesystem.delete'), 'ask');
  assert.strictEqual(pe.evaluate('terminal.dangerous'), 'ask');
  assert.strictEqual(pe.evaluate('computer'), 'ask');
  assert.strictEqual(pe.evaluate('browser'), 'ask');
});

test('未知 scope 默认 ask（失败安全）', () => {
  const pe = new PermissionEngine();
  assert.strictEqual(pe.evaluate('totally.unknown.scope'), 'ask');
});

test('deny 授予后永久拒绝，且优先级高于默认放行', () => {
  const pe = new PermissionEngine();
  pe.grant('filesystem.read', 'deny');
  assert.strictEqual(pe.evaluate('filesystem.read'), 'deny');
});

test('always 授予后一直放行', () => {
  const pe = new PermissionEngine();
  pe.grant('computer', 'always');
  assert.strictEqual(pe.evaluate('computer'), 'allow');
  assert.strictEqual(pe.evaluate('computer'), 'allow');
});

test('once 授予只生效一次，之后回落默认策略', () => {
  const pe = new PermissionEngine();
  pe.grant('browser', 'once');
  assert.strictEqual(pe.evaluate('browser'), 'allow');
  assert.strictEqual(pe.evaluate('browser'), 'ask');
});

test('task 授予仅在同一 taskId 内有效', () => {
  const pe = new PermissionEngine();
  pe.setTask('task-1');
  pe.grant('terminal.dangerous', 'task');
  assert.strictEqual(pe.evaluate('terminal.dangerous', { taskId: 'task-1' }), 'allow');
  assert.strictEqual(pe.evaluate('terminal.dangerous', { taskId: 'task-2' }), 'ask');
});

test('project 授予在整个项目会话内有效', () => {
  const pe = new PermissionEngine();
  pe.setProject('proj-1');
  pe.grant('git.write', 'project');
  assert.strictEqual(pe.evaluate('git.write', { projectId: 'proj-1' }), 'allow');
});

test('reset 清空所有授予', () => {
  const pe = new PermissionEngine();
  pe.grant('computer', 'always');
  pe.reset();
  assert.strictEqual(pe.evaluate('computer'), 'ask');
  assert.deepStrictEqual(pe.listGrants(), []);
});

test('非法 scope 无法被授予（防止绕过）', () => {
  const pe = new PermissionEngine();
  pe.grant('filesystem.everything', 'always');
  assert.strictEqual(pe.evaluate('filesystem.everything'), 'ask');
});

test('SCOPES 与 DEFAULT_POLICY 覆盖一致', () => {
  for (const s of SCOPES) {
    assert.ok(DEFAULT_POLICY[s], `scope ${s} 缺少默认策略`);
    assert.ok(['allow', 'ask', 'deny'].includes(DEFAULT_POLICY[s]));
  }
});
