'use strict';
/**
 * test/permissionAudit.test.js（spec §31/§32/§78）。
 *
 * 审计流会同时进内存环形缓冲、DB 和 GUI，所以命令原文必须在入库前脱敏。
 * 这里不调用 store.init()，DB 写入会被 log() 内部的 try/catch 吞掉，
 * 测试只观察内存缓冲，保持无副作用。
 *
 * 两条约束：
 *   §78 命中凭据模式的片段替换为 [REDACTED]
 *   §24 普通命令不得被误伤（redactCommand 不产生误报）
 */
const test = require('node:test');
const assert = require('node:assert');

const permissionAudit = require('../src/security/permissionAudit');

test('凭据回归：命令中的 Bearer 令牌在审计记录中被脱敏（§78）', () => {
  permissionAudit.clear();
  permissionAudit.log({
    runId: 'r1',
    agentId: 'a1',
    operation: 'run_shell',
    risk: 'low',
    decision: true,
    command: 'curl -H "Authorization: Bearer sk-test-secret" https://api.x'
  });
  const rec = permissionAudit.recent(1)[0];
  assert.ok(!rec.command.includes('sk-test-secret'), `审计记录泄漏凭据：${rec.command}`);
  assert.ok(rec.command.includes('[REDACTED]'));
});

test('redactCommand 脱敏 Bearer 令牌', () => {
  assert.ok(permissionAudit.redactCommand('Bearer fake-token-123').includes('[REDACTED]'));
});

test('redactCommand 不误伤普通命令（§24 误报防护）', () => {
  assert.strictEqual(permissionAudit.redactCommand('git status'), 'git status');
});

test('clear() 清空内存缓冲', () => {
  permissionAudit.log({ runId: 'r2', operation: 'run_shell', decision: false });
  assert.ok(permissionAudit.recent().length > 0);
  permissionAudit.clear();
  assert.strictEqual(permissionAudit.recent().length, 0);
});
