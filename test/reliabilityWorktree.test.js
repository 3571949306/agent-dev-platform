'use strict';
/**
 * v2.9.8 Real Project Reliability — R1/R2.
 *
 * R1: Dirty worktree / user data preservation + Destructive Git Guard.
 * R2: Checkpoint truthfulness (non-mutating create, exact-id restore,
 *     no fake success for non-Git projects).
 *
 * 全部使用真实临时 Git 仓库 + 真实文件 + 真实 Agent Runtime。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');
const { executeAction } = require('../src/agent/runtime/actionExecutor');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { getBuiltin } = require('../src/tools/registry');
const { snapshotGitProject, restoreGitProject } = require('../src/agent/runtime/checkpoint');

const USER_UNCOMMITTED_MARKER = 'USER_UNCOMMITTED_MARKER_4827';
const USER_README_MARKER = 'USER_README_MARKER_9184';
const USER_UNTRACKED_MARKER = 'USER_UNTRACKED_MARKER_3371';

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function waitForTerminal(runManager, runId) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const run = runManager.getRun(runId);
      if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) {
        clearInterval(timer);
        resolve(run);
      }
    }, 15);
  });
}

/** 真实脏工作区 fixture：初始 commit + 用户未提交修改 + staged + untracked。 */
function makeDirtyWorktreeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-fixture-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'fixture');

  // 初始提交：带 bug 的 calc（无用户 marker）+ 测试脚本 + README
  fs.writeFileSync(path.join(root, 'src', 'calc.js'),
    'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n', 'utf8');
  fs.writeFileSync(path.join(root, 'test', 'run-check.js'),
    'const { add } = require(\'../src/calc\');\n' +
    'if (add(2, 3) !== 5) { console.error(\'CALC_TESTS_FAIL\'); process.exit(1); }\n' +
    'console.log(\'CALC_TESTS_PASS\');\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'original readme\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');

  // 用户未提交修改 1：tracked 文件追加 marker（仍是 bug 实现）
  fs.appendFileSync(path.join(root, 'src', 'calc.js'), `// ${USER_UNCOMMITTED_MARKER}\n`, 'utf8');
  // 用户未提交修改 2：README staged 状态
  fs.writeFileSync(path.join(root, 'README.md'), `# project\n${USER_README_MARKER}\n`, 'utf8');
  git(root, 'add', 'README.md');
  // 用户 untracked 文件
  fs.writeFileSync(path.join(root, 'notes-user.txt'), `${USER_UNTRACKED_MARKER}\n`, 'utf8');
  return root;
}

test('R1 dirty worktree: agent fix preserves every byte of user uncommitted state', async () => {
  const root = makeDirtyWorktreeFixture();
  try {
    // --- Git State Proof：before ---
    const headBefore = git(root, 'rev-parse', 'HEAD');
    const statusBefore = git(root, 'status', '--porcelain=v2');
    const readmeBefore = fs.readFileSync(path.join(root, 'README.md'));
    const notesBefore = fs.readFileSync(path.join(root, 'notes-user.txt'));
    const calcBefore = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    assert.ok(calcBefore.includes(USER_UNCOMMITTED_MARKER));
    assert.ok(statusBefore.includes('notes-user.txt'));

    const fixedCalc = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n' + `// ${USER_UNCOMMITTED_MARKER}\n`;
    const model = createFakeCodingModel([
      { type: 'read_file', args: { path: 'src/calc.js' } },
      { type: 'write_file', args: { path: 'src/calc.js', content: fixedCalc } },
      { type: 'run_tests', args: { command: 'node test/run-check.js' } },
      { type: 'complete', args: { summary: 'calc fixed' } }
    ]);

    const runManager = new RunManager();
    const pe = new PermissionEngine({ projectId: 'rpr-fixture' });
    pe.grant('filesystem.read', 'always', { persist: false });
    pe.grant('filesystem.write', 'always', { persist: false });
    pe.grant('terminal.write', 'always', { persist: false });

    const { runId } = runMainAgent({
      conversationId: 'rpr-dirty-worktree', agentId: 'native-main',
      goal: '修复 calc bug 使测试通过，不要修改无关文件',
      projectRoot: root, projectId: 'rpr-fixture',
      model, getTool: getBuiltin, store: null, emit: () => {},
      runManager, permissionEngine: pe,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      timeoutMs: 20000
    });
    const terminal = await waitForTerminal(runManager, runId);
    assert.strictEqual(terminal.status, 'completed', `run should complete, got ${terminal.status} (${terminal.error || ''})`);

    // --- 任务真实完成：测试 PASS ---
    const check = spawnSync('node', [path.join(root, 'test', 'run-check.js')], { encoding: 'utf8' });
    assert.strictEqual(check.status, 0, 'tests must PASS after the fix');
    assert.ok(check.stdout.includes('CALC_TESTS_PASS'));
    const calcAfter = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    assert.ok(calcAfter.includes('return a + b'), 'calc bug fixed');

    // --- 用户数据保留（任务未要求修改的文件 byte-identical）---
    assert.ok(calcAfter.includes(USER_UNCOMMITTED_MARKER), 'USER_UNCOMMITTED_MARKER_4827 still present in the same file the agent edited');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'README.md')), readmeBefore, 'USER_README_MARKER_9184 byte-identical');
    assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes(USER_README_MARKER));
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'notes-user.txt')), notesBefore, 'USER_UNTRACKED_MARKER_3371 byte-identical');
    assert.ok(fs.existsSync(path.join(root, 'notes-user.txt')), 'no user file deleted');

    // --- Git State Proof：after（不得偷偷 stash/reset/clean/checkout/restore）---
    assert.strictEqual(git(root, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged (agent made no commit)');
    const statusAfter = git(root, 'status', '--porcelain=v2');
    // porcelain=v2 条目形如：1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>，
    // 用户 staged 的 README 必须仍保持 X=M（staged modified）
    assert.ok(statusAfter.split('\n').some(l => /^1 M\S? /.test(l) && l.endsWith('README.md')),
      'user staged README state preserved: ' + statusAfter);
    assert.ok(statusAfter.includes('notes-user.txt'), 'untracked file still present in status');
    assert.strictEqual(git(root, 'stash', 'list'), '', 'no stash was used to "protect" the worktree');
    // 自动 checkpoint 以非变异方式存在（命名空间 ref），不触碰 HEAD/分支/status
    const checkpointRefs = git(root, 'for-each-ref', 'refs/adp-checkpoints');
    assert.ok(checkpointRefs.length > 0, 'non-mutating checkpoint refs exist');
    assert.strictEqual(git(root, 'branch', '--show-current'), 'main');
    assert.strictEqual(statusBefore.split('\n').filter(l => l.includes('README.md')).length,
      statusAfter.split('\n').filter(l => l.includes('README.md')).length, 'README status entry count unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R1 destructive git guard: denied permission means zero spawn and unchanged worktree', async () => {
  const root = makeDirtyWorktreeFixture();
  try {
    const dirtyBefore = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    const statusBefore = git(root, 'status', '--porcelain=v2');
    const worktreeHashBefore = sha256(JSON.stringify([
      dirtyBefore,
      fs.readFileSync(path.join(root, 'README.md')),
      fs.readFileSync(path.join(root, 'notes-user.txt'))
    ]));

    // 1) permissionFor：任务列出的每一类破坏性命令都必须进入高风险确认域
    const terminalTool = getBuiltin('terminal_run');
    const destructiveCommands = [
      'git reset --hard',
      'git clean -f',
      'git clean -fd',
      'git clean -fdx',
      'git checkout -- src/calc.js',
      'git restore src/calc.js',
      'git restore --staged src/calc.js',
      'git stash',
      'git switch -f other-branch'
    ];
    for (const command of destructiveCommands) {
      assert.strictEqual(terminalTool.permissionFor({ command }), 'terminal.dangerous', `must be high-risk: ${command}`);
    }
    // 假阳性守卫：常规命令不得升级
    for (const command of ['npm test', 'git status', 'git diff', 'git log -3', 'node -v', 'node test/run-check.js']) {
      assert.strictEqual(terminalTool.permissionFor({ command }), 'terminal.write', `must stay normal: ${command}`);
    }

    // 2) Parent permission = deny → PERMISSION_DENIED，process spawn = 0
    const peDeny = new PermissionEngine({ projectId: 'rpr-fixture' });
    peDeny.grant('terminal.dangerous', 'deny', { persist: false });
    const ctx = {
      projectRoot: root, projectId: 'rpr-fixture', taskId: 'guard-task',
      permissionEngine: peDeny, store: null, emit: () => {},
      requestPermission: async () => ({ decision: 'deny', range: 'once' })
    };
    const denied = await executeAction(ctx, {
      type: 'run_command',
      args: { command: 'git reset --hard && echo PWNED > pwned.txt' }
    }, getBuiltin);
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'PERMISSION_DENIED');
    assert.strictEqual(fs.existsSync(path.join(root, 'pwned.txt')), false, 'process spawn count = 0 (no side-effect file)');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8'), dirtyBefore, 'worktree content unchanged');

    // 3) 无批准通道（默认 ask）也必须 fail-safe 拒绝
    const peAsk = new PermissionEngine({ projectId: 'rpr-fixture' });
    const ctxAsk = { ...ctx, permissionEngine: peAsk, requestPermission: async () => ({ decision: 'deny', range: 'once' }) };
    const askDenied = await executeAction(ctxAsk, {
      type: 'run_command',
      args: { command: 'git stash push -u -m "sneaky"' }
    }, getBuiltin);
    assert.strictEqual(askDenied.ok, false);
    assert.strictEqual(askDenied.error.code, 'PERMISSION_DENIED');
    assert.strictEqual(git(root, 'stash', 'list'), '', 'no stash was created');

    // 4) worktree hash unchanged
    const worktreeHashAfter = sha256(JSON.stringify([
      fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8'),
      fs.readFileSync(path.join(root, 'README.md')),
      fs.readFileSync(path.join(root, 'notes-user.txt'))
    ]));
    assert.strictEqual(worktreeHashAfter, worktreeHashBefore);
    assert.strictEqual(git(root, 'status', '--porcelain=v2'), statusBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R2 checkpoint create is NON-MUTATING (HEAD/index/worktree/status/untracked unchanged)', async () => {
  const root = makeDirtyWorktreeFixture();
  try {
    const headBefore = git(root, 'rev-parse', 'HEAD');
    const statusBefore = git(root, 'status', '--porcelain=v2');
    const indexBefore = git(root, 'ls-files', '--stage');
    const readmeBefore = fs.readFileSync(path.join(root, 'README.md'));
    const calcBefore = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    const notesBefore = fs.readFileSync(path.join(root, 'notes-user.txt'), 'utf8');

    const snap = await snapshotGitProject(root, 'nonmutating-proof');
    assert.strictEqual(snap.ok, true);
    assert.ok(snap.ref.startsWith('refs/adp-checkpoints/'));

    assert.strictEqual(git(root, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged');
    assert.strictEqual(git(root, 'status', '--porcelain=v2'), statusBefore, 'git status unchanged');
    assert.strictEqual(git(root, 'ls-files', '--stage'), indexBefore, 'real Git index unchanged');
    assert.strictEqual(fs.readFileSync(path.join(root, 'README.md')).equals(readmeBefore), true, 'worktree bytes unchanged');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8'), calcBefore);
    assert.strictEqual(fs.readFileSync(path.join(root, 'notes-user.txt'), 'utf8'), notesBefore, 'untracked file unchanged');
    assert.strictEqual(git(root, 'stash', 'list'), '', 'no stash used');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R2 restore is EXACT by checkpoint id: S0 -> A -> S1 -> B -> S2, restore A then B', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-restore-'));
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'fixture');
    // S0
    fs.writeFileSync(path.join(root, 'a.txt'), 'S0-A', 'utf8');
    fs.writeFileSync(path.join(root, 'b.txt'), 'S0-B', 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'S0');

    const ctx = { projectRoot: root, projectId: 'rpr-restore', taskId: null, store: null, emit: () => {} };
    const createTool = getBuiltin('checkpoint_create');
    const restoreTool = getBuiltin('checkpoint_restore');

    // checkpoint A @ S0
    const ca = await createTool.exec(ctx, { note: 'A' });
    assert.strictEqual(ca.ok, true);
    assert.strictEqual(ca.data.non_mutating, true);

    // S1
    fs.writeFileSync(path.join(root, 'a.txt'), 'S1-A', 'utf8');
    fs.writeFileSync(path.join(root, 'c.txt'), 'S1-C', 'utf8');
    const cb = await createTool.exec(ctx, { note: 'B' });
    assert.strictEqual(cb.ok, true);

    // S2
    fs.writeFileSync(path.join(root, 'a.txt'), 'S2-A', 'utf8');
    fs.rmSync(path.join(root, 'b.txt'));

    // restore A → content == S0（b.txt 回来，c.txt 消失，checkpoint id 不是装饰字段）
    const ra = await restoreTool.exec(ctx, { checkpoint_id: ca.data.checkpoint_id });
    assert.strictEqual(ra.ok, true, JSON.stringify(ra));
    assert.strictEqual(ra.data.restored, ca.data.checkpoint_id);
    assert.ok(ra.data.emergency_checkpoint_id, 'emergency checkpoint created before destructive restore');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'S0-A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'S0-B');
    assert.strictEqual(fs.existsSync(path.join(root, 'c.txt')), false);

    // restore B → content == S1（精确恢复 B，而不是“最近的 A/emergency”；
    // S1 状态 = a:S1-A、b:S0-B（b 在 S2 才被删）、c:S1-C）
    const rb = await restoreTool.exec(ctx, { checkpoint_id: cb.data.checkpoint_id });
    assert.strictEqual(rb.ok, true, JSON.stringify(rb));
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'S1-A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'S0-B');
    assert.strictEqual(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'S1-C');

    // emergency checkpoint 可把状态恢复到 restore 之前（原状态 recoverable）：
    // rb 的 emergency 在 restore B 落盘前创建，因此恢复它回到 restore A 之后的 S0 状态
    const rEmergency = await restoreTool.exec(ctx, { checkpoint_id: rb.data.emergency_checkpoint_id });
    assert.strictEqual(rEmergency.ok, true, JSON.stringify(rEmergency));
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'S0-A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'S0-B');
    assert.strictEqual(fs.existsSync(path.join(root, 'c.txt')), false);

    // 未知 id → CHECKPOINT_NOT_FOUND（绝不 pop latest stash）
    const rMissing = await restoreTool.exec(ctx, { checkpoint_id: 'does-not-exist' });
    assert.strictEqual(rMissing.ok, false);
    assert.strictEqual(rMissing.error.code, 'CHECKPOINT_NOT_FOUND');

    // 低层 restoreGitProject 缺 id 也必须拒绝
    const rNoId = await restoreGitProject(root, null);
    assert.strictEqual(rNoId.ok, false);
    assert.strictEqual(rNoId.code, 'CHECKPOINT_ID_REQUIRED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R2 non-git truthfulness: CHECKPOINT_UNSUPPORTED instead of fake success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-nongit-'));
  try {
    fs.writeFileSync(path.join(root, 'file.txt'), 'hello', 'utf8');
    const ctx = { projectRoot: root, projectId: 'rpr-nongit', taskId: null, store: null, emit: () => {} };
    const created = await getBuiltin('checkpoint_create').exec(ctx, { note: 'x' });
    assert.strictEqual(created.ok, false, 'non-git checkpoint must not claim success');
    assert.strictEqual(created.error.code, 'CHECKPOINT_UNSUPPORTED');
    assert.doesNotMatch(JSON.stringify(created), /snapshot created|快照已创建|restore available/i);
    const restored = await getBuiltin('checkpoint_restore').exec(ctx, { checkpoint_id: 'any' });
    assert.strictEqual(restored.ok, false);
    assert.strictEqual(restored.error.code, 'CHECKPOINT_UNSUPPORTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
