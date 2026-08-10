'use strict';
/**
 * test/commandRiskAnalyzer.test.js（spec §23/§24）。
 *
 * CommandRiskAnalyzer 是纯逻辑的危险命令识别层，只输出风险信号，
 * 不做分级、不做 I/O。本文件覆盖两类约束：
 *   - §23 破坏性模式必须被识别：rm -rf / git reset --hard / del /s /
 *     Remove-Item -Recurse -Force
 *   - §24 误报防护：git status / npm test / node -v 不得被判为破坏性
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeCommandRisk,
  normalizeExecutable
} = require('../src/security/commandRiskAnalyzer');

test('rm -rf 被识别为递归删除', () => {
  const result = analyzeCommandRisk({ command: 'rm -rf build' });
  assert.strictEqual(result.isRecursiveDelete, true);
});

test('git reset --hard 被识别为 git 破坏性命令', () => {
  const result = analyzeCommandRisk({ command: 'git reset --hard HEAD~1' });
  assert.strictEqual(result.isGitDestructive, true);
});

test('git status 是只读 git 命令，不得判为破坏性（§24 误报防护）', () => {
  const result = analyzeCommandRisk({ command: 'git status' });
  assert.strictEqual(result.isReadonlyGit, true);
  assert.strictEqual(result.isGitDestructive, false);
});

test('npm test 被识别为已知测试/构建命令（§24 误报防护）', () => {
  const result = analyzeCommandRisk({ command: 'npm test' });
  assert.strictEqual(result.isKnownTestLint, true);
});

test('cmd 下的 del /s 被识别为 Windows 破坏性命令', () => {
  // analyzeCommandRisk 只接受单个 input 对象，shell/platform 必须并入其中，
  // 否则会退回 process.platform，测试在非 Windows 平台上将失去意义。
  const result = analyzeCommandRisk({
    command: 'del /s C:\\x',
    shell: 'cmd',
    platform: 'win32'
  });
  assert.strictEqual(result.isPowerShellDestructive, true);
});

test('Remove-Item -Recurse -Force 被识别为递归删除', () => {
  const result = analyzeCommandRisk({
    command: 'Remove-Item -Recurse -Force foo',
    shell: 'powershell',
    platform: 'win32'
  });
  assert.strictEqual(result.isRecursiveDelete, true);
});

test('node -v 不触发任何破坏性信号（§24 误报防护）', () => {
  const result = analyzeCommandRisk({ command: 'node -v' });
  assert.strictEqual(result.isRecursiveDelete, false);
  assert.strictEqual(result.isGitDestructive, false);
  assert.strictEqual(result.isPowerShellDestructive, false);
});

test('normalizeExecutable 去掉绝对路径与 .exe 后缀', () => {
  assert.strictEqual(normalizeExecutable('C:\\WINDOWS\\system32\\git.exe'), 'git');
});
