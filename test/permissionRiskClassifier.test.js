'use strict';
/**
 * test/permissionRiskClassifier.test.js（spec §17-§21/§24）。
 *
 * 分级规则：先按最高档匹配，命中即返回；全部未命中时 fail-closed。
 *   CRITICAL — git reset --hard / rm -rf
 *   HIGH     — git checkout / 未知可执行程序 / 越出 projectRoot
 *   MEDIUM   — projectRoot 内的文件写入
 *   LOW      — git status / npm test / 已知安全程序
 *
 * 关键回归：fail-closed 不得误伤良性命令——`ls` 属已知安全程序，
 * 必须落 LOW 而非被兜底成 HIGH（§18/§24）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { classifyRisk } = require('../src/security/permissionRiskClassifier');

test('git reset --hard → critical', () => {
  assert.strictEqual(
    classifyRisk({ command: 'git reset --hard HEAD~1' }, 'run_shell', '/p').risk,
    'critical'
  );
});

test('rm -rf / → critical', () => {
  assert.strictEqual(
    classifyRisk({ command: 'rm -rf /' }, 'run_shell', '/p').risk,
    'critical'
  );
});

test('git status → low', () => {
  assert.strictEqual(
    classifyRisk({ command: 'git status' }, 'run_shell', '/p').risk,
    'low'
  );
});

test('npm test → low', () => {
  assert.strictEqual(
    classifyRisk({ command: 'npm test' }, 'run_shell', '/p').risk,
    'low'
  );
});

test('git checkout → high（可能覆盖工作区改动）', () => {
  assert.strictEqual(
    classifyRisk({ command: 'git checkout main' }, 'run_shell', '/p').risk,
    'high'
  );
});

test('已知安全程序 ls → low，不得被 fail-closed 成 high（§24 误报防护）', () => {
  assert.strictEqual(
    classifyRisk({ command: 'ls' }, 'run_shell', '/p').risk,
    'low'
  );
});

test('未知可执行程序 ./malware → high（fail-closed）', () => {
  assert.strictEqual(
    classifyRisk({ command: './malware' }, 'run_shell', '/p').risk,
    'high'
  );
});

test('write_file（projectRoot 内）→ medium', () => {
  assert.strictEqual(classifyRisk({}, 'write_file', '/p').risk, 'medium');
});

test('write_file 目标越出 projectRoot → high', () => {
  assert.strictEqual(
    classifyRisk({ targetPath: '/outside/x' }, 'write_file', '/p').risk,
    'high'
  );
});
