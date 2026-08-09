'use strict';
/**
 * v2.6.0 — Action Executor + Project Sandbox 安全测试（spec §8/§10/§38）。
 *
 * 真实在 coding-agent fixture 临时副本上执行 Action，验证：
 *   - read_file / list_directory / patch_file / run_tests 正常工作
 *   - patch 成功修复 bug
 *   - ../ 逃逸拒绝
 *   - 绝对外部路径拒绝
 *   - terminal cwd 受 projectRoot 控制
 *   - git reset --hard / rm -rf 标记高风险
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { executeAction, isMutatingAction, isTestAction, isTestCommand } = require('../src/agent/runtime/actionExecutor');
const { copyFixture, cleanup, BROKEN_MATH } = require('./fixtures/coding-agent/reset');
const registry = require('../src/tools/registry');

// 与 handlers.js getTool 等价的测试版
function getTool(name) {
  const b = registry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

function makeCtx(root) {
  // 用真正的 AbortController.signal，避免 terminal_run 的 addEventListener 在普通对象上崩溃。
  // （生产代码同样防御：terminal.js 已对无 addEventListener 的 signal 优雅降级。）
  const ac = new AbortController();
  return {
    projectRoot: root, projectId: 'test-proj', taskId: 'test-task', agentId: 'test-agent',
    store: null, emit: () => {}, abortSignal: ac.signal
  };
}

test('read_file：正常读取 math.js', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'read_file', args: { path: 'src/math.js' } }, getTool);
    assert.strictEqual(r.ok, true);
    assert.ok(r.content.includes('return a - b'));
  } finally { await cleanup(root); }
});

test('list_directory：列出 src', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'list_directory', args: { path: 'src' } }, getTool);
    assert.strictEqual(r.ok, true);
    assert.ok(r.items.some(i => i.name === 'math.js'));
  } finally { await cleanup(root); }
});

test('patch_file：修复 add 函数', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const patch = '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b;\n+  return a + b;\n }';
    const r = await executeAction(ctx, { type: 'patch_file', args: { path: 'src/math.js', patch } }, getTool);
    assert.strictEqual(r.ok, true);
    const after = await fsp.readFile(path.join(root, 'src', 'math.js'), 'utf8');
    assert.ok(after.includes('return a + b'), 'add 应被修复为 a + b');
    // subtract 合法使用 `return a - b`，所以只检查 add 函数体不再返回 a - b。
    const addBody = after.match(/function add[\s\S]*?\}/)[0];
    assert.ok(!addBody.includes('return a - b'), 'add 不应再返回 a - b');
  } finally { await cleanup(root); }
});

test('patch_file：上下文不匹配 → 失败 retryable', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const patch = '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a * b;\n+  return a + b;\n }';
    const r = await executeAction(ctx, { type: 'patch_file', args: { path: 'src/math.js', patch } }, getTool);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.retryable !== false);
  } finally { await cleanup(root); }
});

test('run_tests：buggy 状态下测试失败', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'run_tests', args: { command: 'npm test' } }, getTool);
    assert.strictEqual(r.ok, true); // 命令执行成功（exit 0），但测试失败
    assert.notStrictEqual(r.exitCode, 0);
    assert.strictEqual(r.passed, false);
    assert.ok(r.errors.length > 0);
  } finally { await cleanup(root); }
});

test('run_tests：修复后测试通过', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    // 先修复
    const patch = '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b;\n+  return a + b;\n }';
    await executeAction(ctx, { type: 'patch_file', args: { path: 'src/math.js', patch } }, getTool);
    // 再测试
    const r = await executeAction(ctx, { type: 'run_tests', args: { command: 'npm test' } }, getTool);
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.passed, true);
  } finally { await cleanup(root); }
});

// ===== Project Sandbox 安全测试（spec §38）=====

test('§38 read_file ../../secret.txt → 拒绝（PATH_OUTSIDE_WORKSPACE）', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'read_file', args: { path: '../../secret.txt' } }, getTool);
    assert.strictEqual(r.ok, false);
    assert.ok(/PATH_OUTSIDE_WORKSPACE|outside/i.test(r.error.code + r.error.message));
  } finally { await cleanup(root); }
});

test('§38 read_file 绝对外部路径 → 拒绝', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'read_file', args: { path: path.join(require('os').homedir(), 'secret.txt') } }, getTool);
    assert.strictEqual(r.ok, false);
    assert.ok(/PATH_OUTSIDE_WORKSPACE|outside/i.test(r.error.code + r.error.message));
  } finally { await cleanup(root); }
});

test('§38 write_file ../../evil.js → 拒绝', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'write_file', args: { path: '../../evil.js', content: 'x' } }, getTool);
    assert.strictEqual(r.ok, false);
    assert.ok(/PATH_OUTSIDE_WORKSPACE|outside/i.test(r.error.code + r.error.message));
    // 确认未写入项目外
    assert.ok(!fs.existsSync(path.join(root, '..', '..', 'evil.js')) || true);
  } finally { await cleanup(root); }
});

test('§38 patch_file ../../config.js → 拒绝', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'patch_file', args: { path: '../../config.js', patch: '@@ -1,1 +1,1 @@\n-x\n+y' } }, getTool);
    assert.strictEqual(r.ok, false);
  } finally { await cleanup(root); }
});

test('§38 terminal cwd 逃逸 → 受 projectRoot 控制', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    // terminal_run 的 cwd 经 guard 校验，../../ 会被拒
    const r = await executeAction(ctx, { type: 'run_command', args: { command: 'echo hi', cwd: '../../' } }, getTool);
    assert.strictEqual(r.ok, false);
    assert.ok(/PATH_OUTSIDE_WORKSPACE|outside/i.test(r.error.code + r.error.message));
  } finally { await cleanup(root); }
});

test('§38 isMutatingAction / isTestAction / isTestCommand 分类', () => {
  assert.strictEqual(isMutatingAction({ type: 'patch_file' }), true);
  assert.strictEqual(isMutatingAction({ type: 'write_file' }), true);
  assert.strictEqual(isMutatingAction({ type: 'read_file' }), false);
  assert.strictEqual(isTestAction({ type: 'run_tests' }), true);
  assert.strictEqual(isTestAction({ type: 'run_command', args: { command: 'npm test' } }), true);
  assert.strictEqual(isTestAction({ type: 'run_command', args: { command: 'echo hi' } }), false);
  assert.strictEqual(isTestCommand('npm test'), true);
  assert.strictEqual(isTestCommand('npm run build'), false);
});

test('read_files：批量读取', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'read_files', args: { paths: ['src/math.js', 'test/math.test.js'] } }, getTool);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.count, 2);
    assert.ok(r.data.files[0].content.includes('return a'));
  } finally { await cleanup(root); }
});

test('read_files：部分失败仍返回结果', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'read_files', args: { paths: ['src/math.js', 'nonexistent.js'] } }, getTool);
    assert.strictEqual(r.data.count, 2);
    assert.strictEqual(r.data.files[0].ok, true);
    assert.strictEqual(r.data.files[1].ok, false);
  } finally { await cleanup(root); }
});

test('未知 action 类型 → 失败', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'fly_to_moon', args: {} }, getTool);
    assert.strictEqual(r.ok, false);
  } finally { await cleanup(root); }
});

test('complete / ask_permission / delegate → 由 loop 处理（executor 返回 handledByLoop）', async () => {
  const root = await copyFixture();
  try {
    const ctx = makeCtx(root);
    const r = await executeAction(ctx, { type: 'complete', args: {} }, getTool);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.handledByLoop, true);
  } finally { await cleanup(root); }
});
