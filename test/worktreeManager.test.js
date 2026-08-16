'use strict';
/**
 * P5-A Parallel Worktree Isolation Foundation — WorktreeManager / Coordinator 测试。
 *
 * 覆盖（§11 A–L）+ Real Git Production（§12，>=20 项隔离检查）。
 * 全部使用真实临时 Git repository 与 deterministic fixture worker；
 * 不调用任何付费/外部模型（Paid Provider Calls = 0 / Real External Model Calls = 0）。
 *
 * 关键不变量：
 *   - 两个任务在真实 Git worktree 中并行改代码，彼此不污染（CROSS_WORKTREE_CONTAMINATION=0）
 *   - 不修改原项目（BASE_PROJECT_PARALLEL_MUTATION=0）
 *   - Cancel A 不影响 B；Cleanup A 不删 B；非法路径 cleanup 被拒
 *   - 非 Git repo / 重复 branch / worktree ID 均 fail closed
 *   - 收尾 git worktree list 无测试残留（WORKTREE_CLEANUP_RESIDUE=0）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execGit } = require('../src/agent/runtime/gitHelper');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { createWorktreeManager, createParallelWorktreeCoordinator, STATUS, FAIL_CODES, GIT_STATE } = require('../src/services/worktreeManager');

// P5-A.1 §15：Coordinator 必须显式注入共享 ProjectMutationLock（测试自建 test lock 注入）。
function makeCoord(opts = {}) {
  return createParallelWorktreeCoordinator({ mutationLock: createProjectMutationLock(), ...opts });
}

/** 创建真实临时 Git repo（含 baseline commit）。 */
async function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-wt-'));
  await execGit(dir, ['init']);
  await execGit(dir, ['config', 'user.email', 'test@adp.local']);
  await execGit(dir, ['config', 'user.name', 'ADP Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# baseline\n');
  await execGit(dir, ['add', 'README.md']);
  await execGit(dir, ['commit', '-m', 'baseline']);
  return dir;
}

function rmTree(p) {
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
}

/** 统计 git worktree list 中的条目数（含 main）。 */
async function worktreeCount(repo) {
  const res = await execGit(repo, ['worktree', 'list', '--porcelain']);
  return res.out.split('\n').filter(l => l.startsWith('worktree ')).length;
}

// ===========================================================================
// A–L 单元场景
// ===========================================================================

test('A. 创建 Worktree 成功', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'runA' });
    assert.ok(rec.worktreeId);
    assert.strictEqual(rec.status, STATUS.READY);
    assert.ok(fs.existsSync(rec.worktreeRoot), 'worktree dir should exist');
    assert.strictEqual(await worktreeCount(repo), 2, 'main + 1 worktree');
  } finally { rmTree(repo); }
});

test('B. 两个 Worktree 路径不同', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const a = await m.create({ projectRoot: repo, runId: 'runA' });
    const b = await m.create({ projectRoot: repo, runId: 'runB' });
    assert.notStrictEqual(a.worktreeRoot, b.worktreeRoot);
    assert.ok(path.basename(a.worktreeRoot) !== path.basename(b.worktreeRoot));
  } finally { rmTree(repo); }
});

test('C. 两个 Worker 同时修改 same.txt', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'A'); return 'A'; } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'B'); return 'B'; } }
      ]
    });
    assert.strictEqual(results.length, 2);
    const ra = results.find(r => r.runId === 'runA');
    const rb = results.find(r => r.runId === 'runB');
    assert.strictEqual(fs.readFileSync(path.join(ra.worktreeRoot, 'same.txt'), 'utf8'), 'A');
    assert.strictEqual(fs.readFileSync(path.join(rb.worktreeRoot, 'same.txt'), 'utf8'), 'B');
  } finally { rmTree(repo); }
});

test('D. 两个结果彼此隔离', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'file.txt'), 'AAA'); return 'A'; } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'file.txt'), 'BBB'); return 'B'; } }
      ]
    });
    const ra = results.find(r => r.runId === 'runA');
    const rb = results.find(r => r.runId === 'runB');
    assert.strictEqual(fs.readFileSync(path.join(ra.worktreeRoot, 'file.txt'), 'utf8'), 'AAA');
    assert.strictEqual(fs.readFileSync(path.join(rb.worktreeRoot, 'file.txt'), 'utf8'), 'BBB');
    assert.notStrictEqual(ra.result, rb.result);
  } finally { rmTree(repo); }
});

test('E. Base project 未被修改', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'A'); } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'B'); } }
      ]
    });
    // 原项目不应出现 same.txt（无并行污染）
    assert.strictEqual(fs.existsSync(path.join(repo, 'same.txt')), false, 'base project must not have same.txt');
    // 原项目 README 内容不变
    assert.strictEqual(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# baseline\n');
  } finally { rmTree(repo); }
});

test('F. changedFiles 来自真实 git diff（不信任 Agent 自报）', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'runA' });
    // 修改一个被 git 跟踪的文件 → git diff 真实可见
    fs.appendFileSync(path.join(rec.worktreeRoot, 'README.md'), 'CHANGED\n');
    const diff = await m.getDiff(rec.worktreeId);
    assert.ok(diff.changedFiles.includes('README.md'), 'changedFiles should include README.md');
    // 与 git diff --name-only 交叉验证
    const nameRes = await execGit(rec.worktreeRoot, ['diff', '--no-ext-diff', '--name-only']);
    assert.ok(nameRes.out.split('\n').map(s => s.trim()).filter(Boolean).includes('README.md'));
    assert.ok(diff.diff.includes('CHANGED'), 'diff text should contain the change');
  } finally { rmTree(repo); }
});

test('G. Cancel A 不影响 B', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'A'); return 'A'; } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'B'); return 'B'; } }
      ]
    });
    const ra = results.find(r => r.runId === 'runA');
    const rb = results.find(r => r.runId === 'runB');
    // Cancel A（脏 → 默认保留，不影响 B）
    const cancelOut = await coord.cancel(ra.worktreeId);
    assert.ok(cancelOut.cancelled);
    // B 仍存在且内容完好
    assert.ok(fs.existsSync(rb.worktreeRoot), 'B worktree must still exist');
    assert.strictEqual(fs.readFileSync(path.join(rb.worktreeRoot, 'same.txt'), 'utf8'), 'B');
    assert.strictEqual(coord.status(rb.worktreeId).status, STATUS.COMPLETED);
  } finally { rmTree(repo); }
});

test('H. Cleanup A 不删除 B', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'A'); return 'A'; } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'B'); return 'B'; } }
      ]
    });
    const ra = results.find(r => r.runId === 'runA');
    const rb = results.find(r => r.runId === 'runB');
    // 强制清理 A（已保存 diff），B 必须完好
    await coord.cleanup(ra.worktreeId, { force: true });
    assert.strictEqual(coord.status(ra.worktreeId), null, 'A removed');
    assert.ok(fs.existsSync(rb.worktreeRoot), 'B still present after A cleanup');
    assert.strictEqual(fs.readFileSync(path.join(rb.worktreeRoot, 'same.txt'), 'utf8'), 'B');
    // 清理 B
    await coord.cleanup(rb.worktreeId, { force: true });
    assert.strictEqual(await worktreeCount(repo), 1, 'only main remains');
  } finally { rmTree(repo); }
});

test('I. 非法 path cleanup 被拒绝', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    // 未知 worktreeId → fail closed
    await assert.rejects(() => m.remove('wt_does_not_exist'), /WORKTREE_NOT_OWNED/);
    await assert.rejects(() => m.cleanup('wt_does_not_exist'), /WORKTREE_NOT_OWNED/);
    // 原项目根不属于 owned 区域 → isOwnedWorktree 拒绝
    assert.strictEqual(m.isOwnedWorktree(repo, repo), false, 'original project root must not be owned worktree');
    // 同级任意目录不属于 owned → 拒绝
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-sib-'));
    assert.strictEqual(m.isOwnedWorktree(sibling, repo), false);
    rmTree(sibling);
  } finally { rmTree(repo); }
});

test('J. 非 Git repo fail closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-nogit-'));
  try {
    const m = createWorktreeManager();
    await assert.rejects(() => m.create({ projectRoot: dir, runId: 'runX' }), /NOT_A_GIT_REPO/);
  } finally { rmTree(dir); }
});

test('K. 重复 branch / worktree ID fail closed', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    await m.create({ projectRoot: repo, runId: 'runA' });
    // 重复 worktreeId（同一 runId）
    await assert.rejects(() => m.create({ projectRoot: repo, runId: 'runA' }), /DUPLICATE_WORKTREE_ID/);
    // 重复 branch：预建分支后再用同名 branch 创建
    await execGit(repo, ['branch', 'adp-run-manual']);
    await assert.rejects(() => m.create({ projectRoot: repo, runId: 'manual', branch: 'adp-run-manual' }), /BRANCH_EXISTS/);
    // 超过每 project 2 个上限
    await m.create({ projectRoot: repo, runId: 'runB' });
    await assert.rejects(() => m.create({ projectRoot: repo, runId: 'runC' }), /MAX_WORKTREES_EXCEEDED/);
  } finally { rmTree(repo); }
});

test('L. 最终 git worktree list 无测试残留', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'A'); } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => { fs.writeFileSync(path.join(worktreeRoot, 'same.txt'), 'B'); } }
      ]
    });
    for (const r of results) await coord.cleanup(r.worktreeId, { force: true });
    assert.strictEqual(await worktreeCount(repo), 1, 'no test residue in git worktree list');
  } finally { rmTree(repo); }
});

// ===========================================================================
// 主项目保护 + 独立 mutation lock 关系（§4 / §6）
// ===========================================================================

test('主项目保护：worker 只拿到 worktreeRoot，看不到原 projectRoot', async () => {
  const repo = await makeTempRepo();
  try {
    const { canonicalizeRoot } = require('../src/security/pathSecurity/canonicalPath');
    const coord = makeCoord();
    let seenProjectRoot = null;
    let seenWorktreeRoot = null;
    await coord.runPair({
      projectRoot: repo,
      tasks: [{
        runId: 'runA',
        worker: async ({ worktreeRoot, projectRoot }) => {
          seenProjectRoot = projectRoot;
          seenWorktreeRoot = worktreeRoot;
          return true;
        }
      }]
    });
    const canonRepo = canonicalizeRoot(repo);
    const parent = path.dirname(canonRepo);
    assert.strictEqual(seenProjectRoot, seenWorktreeRoot, 'worker projectRoot must equal worktreeRoot');
    assert.notStrictEqual(seenWorktreeRoot, repo, 'worker must NOT receive original projectRoot');
    assert.notStrictEqual(seenWorktreeRoot, canonRepo, 'worker must NOT receive original projectRoot (canonical)');
    // worktree 必须落在 project parent 下、且位于原 project 之外（canonical 比较，规避 Windows 8.3 短路径）
    assert.ok(seenWorktreeRoot.startsWith(parent), 'worktree under project parent (canonical)');
    assert.ok(!seenWorktreeRoot.startsWith(canonRepo + path.sep), 'worktree outside original project');
  } finally { rmTree(repo); }
});

test('独立 mutation lock：A lock root != B lock root，且都不等于原 projectRoot', async () => {
  const repo = await makeTempRepo();
  try {
    const { canonicalizeRoot } = require('../src/security/pathSecurity/canonicalPath');
    const { createProjectMutationLock } = require('../src/security/projectMutationLock');
    const m = createWorktreeManager();
    const a = await m.create({ projectRoot: repo, runId: 'runA' });
    const b = await m.create({ projectRoot: repo, runId: 'runB' });
    const lock = createProjectMutationLock();
    const la = lock.acquireWrite(a.worktreeRoot, 'runA', 'w');
    const lb = lock.acquireWrite(b.worktreeRoot, 'runB', 'w');
    assert.ok(la.ok && lb.ok);
    assert.notStrictEqual(la.lock.projectRoot, lb.lock.projectRoot, 'A/B lock roots differ');
    const canonRepo = canonicalizeRoot(repo);
    assert.notStrictEqual(la.lock.projectRoot, canonRepo, 'A lock root != original project');
    assert.notStrictEqual(lb.lock.projectRoot, canonRepo, 'B lock root != original project');
    lock.release('runA'); lock.release('runB');
  } finally { rmTree(repo); }
});

// ===========================================================================
// §12 Real Git Production Test — 20/20 隔离检查 + 关键输出
// ===========================================================================

test('Real Git Worktree production isolation (>=20 checks)', async () => {
  const repo = await makeTempRepo();
  const passed = [];
  const fail = [];
  const check = (name, cond) => { if (cond) passed.push(name); else fail.push(name); };

  try {
    const coord = makeCoord();
    const baseReadme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');

    check('git-init', fs.existsSync(path.join(repo, '.git')));
    check('baseline-commit', (await execGit(repo, ['rev-parse', 'HEAD'])).code === 0);

    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'runA', worker: async ({ worktreeRoot }) => {
            fs.writeFileSync(path.join(worktreeRoot, 'worker.txt'), 'A');
            fs.appendFileSync(path.join(worktreeRoot, 'README.md'), 'A-edited\n');
            return 'A';
          } },
        { runId: 'runB', worker: async ({ worktreeRoot }) => {
            fs.writeFileSync(path.join(worktreeRoot, 'worker.txt'), 'B');
            fs.appendFileSync(path.join(worktreeRoot, 'README.md'), 'B-edited\n');
            return 'B';
          } }
      ]
    });

    const ra = results.find(r => r.runId === 'runA');
    const rb = results.find(r => r.runId === 'runB');

    check('create-A-ready', ra && ra.status === STATUS.COMPLETED);
    check('create-B-ready', rb && rb.status === STATUS.COMPLETED);
    check('paths-differ', ra.worktreeRoot !== rb.worktreeRoot);
    check('A-not-original', ra.worktreeRoot !== repo);
    check('B-not-original', rb.worktreeRoot !== repo);
    check('A-branch-naming', /^adp-run-/.test(ra.branch));
    check('B-branch-naming', /^adp-run-/.test(rb.branch));

    // 两 worker 并行改同一文件名，内容互不相同 → 隔离
    const aTxt = fs.readFileSync(path.join(ra.worktreeRoot, 'worker.txt'), 'utf8');
    const bTxt = fs.readFileSync(path.join(rb.worktreeRoot, 'worker.txt'), 'utf8');
    check('A-wrote-A', aTxt === 'A');
    check('B-wrote-B', bTxt === 'B');

    // 原项目未被修改（BASE_PROJECT_PARALLEL_MUTATION=0）
    const baseAfter = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    check('base-readme-unchanged', baseAfter === baseReadme);
    check('base-worker-txt-absent', !fs.existsSync(path.join(repo, 'worker.txt')));

    // 交叉污染 = 0：A 的 worktree 不含 B 的内容
    check('A-no-B-content', !aTxt.includes('B'));
    check('B-no-A-content', !bTxt.includes('A'));

    // changedFiles 来自真实 git（不信任 Agent 自报）
    const diffA = await coord.getDiff(ra.worktreeId);
    const diffB = await coord.getDiff(rb.worktreeId);
    check('A-changed-files-from-git', diffA.changedFiles.includes('worker.txt') && diffA.changedFiles.includes('README.md'));
    check('B-changed-files-from-git', diffB.changedFiles.includes('worker.txt') && diffB.changedFiles.includes('README.md'));
    check('A-diff-has-A', diffA.diff.includes('A-edited'));
    check('B-diff-has-B', diffB.diff.includes('B-edited'));

    // 上限执行 maxParallel=2
    check('max-parallel-2', coord.MAX_PARALLEL === 2);

    // 清理：force 删除 COMPLETED 且脏的 worktree，原项目仍不变
    await coord.cleanup(ra.worktreeId, { force: true });
    await coord.cleanup(rb.worktreeId, { force: true });
    check('A-removed', coord.status(ra.worktreeId) === null);
    check('B-removed', coord.status(rb.worktreeId) === null);
    check('base-still-clean-after-cleanup', fs.readFileSync(path.join(repo, 'README.md'), 'utf8') === baseReadme);

    // 残留检查：git worktree list 只剩 main
    const residue = await worktreeCount(repo);
    check('no-worktree-residue', residue === 1);

    const baseMutation = fs.existsSync(path.join(repo, 'worker.txt')) ? 1 : 0;
    const crossContam = (aTxt.includes('B') || bTxt.includes('A')) ? 1 : 0;

    console.log('WORKTREE_ISOLATION=' + passed.length + '/' + (passed.length + fail.length));
    console.log('BASE_PROJECT_PARALLEL_MUTATION=' + baseMutation);
    console.log('CROSS_WORKTREE_CONTAMINATION=' + crossContam);
    console.log('WORKTREE_CLEANUP_RESIDUE=' + (residue - 1));
    console.log('Paid Provider Calls=0');
    console.log('Real External Model Calls=0');

    assert.strictEqual(fail.length, 0, 'failed checks: ' + fail.join(', '));
    assert.ok(passed.length >= 20, 'expected >=20 isolation checks, got ' + passed.length);
    assert.strictEqual(baseMutation, 0);
    assert.strictEqual(crossContam, 0);
    assert.strictEqual(residue - 1, 0);
  } finally {
    rmTree(repo);
  }
});

// ===========================================================================
// P5-A.1 §22 NEW ADVERSARIAL TEST SUITE
// ===========================================================================

const { PermissionEngine } = require('../src/security/permissions');
const { canonicalizeRoot } = require('../src/security/pathSecurity/canonicalPath');

function deferred() { let res; const promise = new Promise(r => { res = r; }); return { promise, resolve: res }; }

test('§22-A Permission project grant 不跨项目 / setProject 清残留 / global 存活', () => {
  // 用默认非 allow 的 scope（filesystem.delete 默认 ask）使继承可观测
  const eng = new PermissionEngine({ projectId: 'A' });
  eng.grant('filesystem.delete', 'project', { persist: false });
  assert.strictEqual(eng.evaluateLocal('filesystem.delete', { projectId: 'A' }), 'allow');
  assert.notStrictEqual(eng.evaluateLocal('filesystem.delete', { projectId: 'B' }), 'allow');
  assert.notStrictEqual(eng.evaluateLocal('filesystem.delete', {}), 'allow');
  // setProject 切换：B 无 grant，不得继承 A（回落到默认 ask）
  eng.setProject('B');
  assert.strictEqual(eng.evaluateLocal('filesystem.delete', { projectId: 'B' }), 'ask');
  // global always 存活切换；project grant 不存活
  const e2 = new PermissionEngine({ projectId: 'A' });
  e2.grant('network', 'always', { persist: false });
  e2.grant('filesystem.delete', 'project', { persist: false });
  e2.grant('git.write', 'deny', { persist: false });
  e2.setProject('B');
  assert.strictEqual(e2.evaluateLocal('network', { projectId: 'B' }), 'allow');
  assert.strictEqual(e2.evaluateLocal('git.write', { projectId: 'B' }), 'deny');
  assert.notStrictEqual(e2.evaluateLocal('filesystem.delete', { projectId: 'B' }), 'allow');
});

test('§22-B repo 子目录 identity：record.projectRoot == 真实 repo 根，owned 不在 repo 内', async () => {
  const repo = await makeTempRepo();
  try {
    fs.mkdirSync(path.join(repo, 'src', 'nested'), { recursive: true });
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: path.join(repo, 'src', 'nested'), runId: 'sub' });
    const canonRepo = canonicalizeRoot(repo);
    assert.strictEqual(rec.projectRoot, canonRepo, 'identity must be true repo root');
    assert.ok(!rec.ownedRoot.startsWith(canonRepo + path.sep), 'ownedRoot outside true repo');
    await m.remove(rec.worktreeId, { force: true });
  } finally { rmTree(repo); }
});

test('§22-C projectId spoof 不能绕过 max=2', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    await m.create({ projectRoot: repo, runId: 'r1', projectId: 'A' });
    await m.create({ projectRoot: repo, runId: 'r2', projectId: 'B' });
    await assert.rejects(() => m.create({ projectRoot: repo, runId: 'r3', projectId: 'C' }), /MAX_WORKTREES_EXCEEDED/);
  } finally { rmTree(repo); }
});

test('§22-D 并发 create 3 个 max=2（20 轮）', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    for (let i = 0; i < 20; i++) {
      const results = await Promise.allSettled([
        m.create({ projectRoot: repo, runId: `cA${i}` }),
        m.create({ projectRoot: repo, runId: `cB${i}` }),
        m.create({ projectRoot: repo, runId: `cC${i}` })
      ]);
      const ok = results.filter(r => r.status === 'fulfilled').length;
      const rej = results.filter(r => r.status === 'rejected');
      assert.strictEqual(ok, 2, `iter ${i}: exactly 2 success`);
      assert.strictEqual(rej.length, 1);
      assert.match(rej[0].reason.message, /MAX_WORKTREES_EXCEEDED/);
      for (const r of results) if (r.status === 'fulfilled') await m.remove(r.value.worktreeId, { force: true });
    }
    assert.strictEqual(m._reservations.size, 0, 'no reservation leak');
  } finally { rmTree(repo); }
});

test('§22-E force remove 失败不得报告 removed=true（metadata 保留）', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'lockme' });
    await execGit(repo, ['worktree', 'lock', rec.worktreeRoot]);
    await assert.rejects(() => m.remove(rec.worktreeId, { force: true }), /WORKTREE_REMOVE_FAILED/);
    assert.ok(m.status(rec.worktreeId), 'metadata retained after failed remove');
    await execGit(repo, ['worktree', 'unlock', rec.worktreeRoot]);
    await m.remove(rec.worktreeId, { force: true });
  } finally { rmTree(repo); }
});

test('§22-F git status 失败 ≠ clean（三态 ERROR）', async () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-bad-'));
  try {
    const m = createWorktreeManager();
    assert.strictEqual(await m.statusState(bad), GIT_STATE.ERROR);
    await assert.rejects(() => m.isDirty(bad), /GIT_STATUS_ERROR/);
  } finally { rmTree(bad); }
});

test('§22-G canonicalization 失败 → cleanup 拒绝（零 mutation）', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'gone' });
    rmTree(rec.worktreeRoot); // 目录消失 → 身份未知 → fail closed（ownership deny 或 status ERROR），零 mutation
    await assert.rejects(() => m.remove(rec.worktreeId, { force: true }), /WORKTREE_OUTSIDE_OWNED_ROOT|WORKTREE_REMOVE_FAILED|GIT_STATUS_ERROR/);
    assert.ok(m.status(rec.worktreeId), 'metadata retained; no cleanup executed');
  } finally { rmTree(repo); }
});

test('§22-H 完整 diff truth（staged/unstaged/untracked/deleted/renamed/binary/committed）+ 真实 index 不变', async () => {
  const repo = await makeTempRepo();
  try {
    // 先在 base repo 提交 setup，使 baseCommit 包含这些文件（删除/改名才可观测）
    fs.writeFileSync(path.join(repo, 'track.txt'), 'v1\n');
    fs.writeFileSync(path.join(repo, 'del.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'ren.txt'), 'r\n');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 250, 251]));
    await execGit(repo, ['add', 'track.txt', 'del.txt', 'ren.txt', 'bin.dat']);
    await execGit(repo, ['commit', '-m', 'setup']);
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'full' });
    const wt = rec.worktreeRoot;
    // unstaged
    fs.appendFileSync(path.join(wt, 'track.txt'), 'v2\n');
    // staged
    fs.writeFileSync(path.join(wt, 'staged.txt'), 's\n');
    await execGit(wt, ['add', 'staged.txt']);
    // untracked
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'u\n');
    // deleted
    fs.rmSync(path.join(wt, 'del.txt'));
    // renamed
    fs.renameSync(path.join(wt, 'ren.txt'), path.join(wt, 'ren2.txt'));
    // binary modified
    fs.writeFileSync(path.join(wt, 'bin.dat'), Buffer.from([0, 1, 2, 250, 251, 9, 9]));
    const beforeStatus = (await execGit(wt, ['status', '--porcelain=v1', '-z'])).out;
    const diff = await m.getDiff(rec.worktreeId);
    const afterStatus = (await execGit(wt, ['status', '--porcelain=v1', '-z'])).out;
    assert.strictEqual(afterStatus, beforeStatus, 'real index/status unchanged by getDiff');
    const cf = diff.changedFiles;
    for (const f of ['track.txt', 'staged.txt', 'untracked.txt', 'del.txt', 'ren2.txt', 'bin.dat']) {
      assert.ok(cf.includes(f), `changedFiles includes ${f} (got: ${cf.join(',')})`);
    }
    assert.ok(diff.diff.includes('v2'), 'unstaged content in diff');
    await m.remove(rec.worktreeId, { force: true });
  } finally { rmTree(repo); }
});

test('§22-I dirty base：A/B 同一 snapshot，worker 见脏内容，用户 HEAD/index/status 不变', async () => {
  const repo = await makeTempRepo();
  try {
    fs.appendFileSync(path.join(repo, 'README.md'), 'user-dirty\n');
    fs.writeFileSync(path.join(repo, 'new-config.js'), 'cfg\n');
    const headBefore = (await execGit(repo, ['rev-parse', 'HEAD'])).out.trim();
    const statusBefore = (await execGit(repo, ['status', '--porcelain=v1', '-z'])).out;
    const coord = makeCoord();
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [
        { runId: 'dA', worker: async ({ worktreeRoot }) => fs.readFileSync(path.join(worktreeRoot, 'README.md'), 'utf8') },
        { runId: 'dB', worker: async ({ worktreeRoot }) => fs.readFileSync(path.join(worktreeRoot, 'README.md'), 'utf8') }
      ]
    });
    const ra = results.find(r => r.runId === 'dA');
    const rb = results.find(r => r.runId === 'dB');
    assert.strictEqual(ra.baseCommit, rb.baseCommit, 'A/B same immutable base');
    assert.notStrictEqual(ra.baseCommit, headBefore, 'dirty base != HEAD');
    assert.ok(ra.result.includes('user-dirty'), 'worker sees tracked dirty content');
    assert.ok(fs.existsSync(path.join(ra.worktreeRoot, 'new-config.js')), 'worker sees untracked');
    const headAfter = (await execGit(repo, ['rev-parse', 'HEAD'])).out.trim();
    const statusAfter = (await execGit(repo, ['status', '--porcelain=v1', '-z'])).out;
    assert.strictEqual(headAfter, headBefore, 'user HEAD unchanged');
    assert.strictEqual(statusAfter, statusBefore, 'user status unchanged');
    // ephemeral ref 无残留
    const refs = await execGit(repo, ['for-each-ref', 'refs/adp-checkpoints/p5wt-']);
    assert.strictEqual(refs.out.trim(), '', 'no ephemeral snapshot ref residue');
    await coord.cleanup(ra.worktreeId, { force: true });
    await coord.cleanup(rb.worktreeId, { force: true });
  } finally { rmTree(repo); }
});

test('§22-J worker context 攻击：authority 不透传', async () => {
  const repo = await makeTempRepo();
  try {
    const coord = makeCoord();
    const dangerous = { fn: () => 1 };
    let seen = null;
    const results = await coord.runPair({
      projectRoot: repo,
      tasks: [{
        runId: 'atk',
        context: { projectRoot: repo, baseProjectRoot: repo, pathSecurity: dangerous, permissionEngine: dangerous, store: dangerous, getTool: dangerous, runManager: dangerous, projectMutationLock: dangerous, taskLabel: 'ok' },
        worker: async (input) => { seen = input; return true; }
      }]
    });
    assert.strictEqual(seen.projectRoot, seen.worktreeRoot);
    assert.strictEqual(seen.metadata.taskLabel, 'ok');
    assert.strictEqual(seen.metadata.pathSecurity, undefined);
    assert.strictEqual(seen.metadata.permissionEngine, undefined);
    assert.strictEqual(seen.metadata.store, undefined);
    assert.strictEqual(seen.context, undefined, 'raw context not passed');
    await coord.cleanup(results[0].worktreeId, { force: true }).catch(() => {});
  } finally { rmTree(repo); }
});

test('§22-K BUSY worktree remove 被拒', async () => {
  const repo = await makeTempRepo();
  try {
    const m = createWorktreeManager();
    const rec = await m.create({ projectRoot: repo, runId: 'busy' });
    m._setStatus(rec.worktreeId, STATUS.BUSY);
    await assert.rejects(() => m.remove(rec.worktreeId, { force: true }), /WORKTREE_BUSY/);
    m._setStatus(rec.worktreeId, STATUS.COMPLETED);
    await m.remove(rec.worktreeId, { force: true });
  } finally { rmTree(repo); }
});

test('§22-L 非协作 cancel：有界返回 + 不提前释放/清理（20 轮）', async () => {
  const repo = await makeTempRepo();
  try {
    for (let i = 0; i < 20; i++) {
      const coord = makeCoord({ cancelQuiescenceTimeoutMs: 150 });
      const d = deferred();
      const runP = coord.runPair({ projectRoot: repo, tasks: [{ runId: `nc${i}`, worker: () => d.promise }] });
      runP.catch(() => {});
      // 轮询等待 worktree 创建并 BUSY（create 为异步）
      let wt = null;
      for (let w = 0; w < 100 && !wt; w++) { wt = coord.list().find(r => r.runId === `nc${i}`) || null; if (!wt) await new Promise(r => setTimeout(r, 20)); }
      assert.ok(wt, 'worktree created');
      const t0 = Date.now();
      const out = await coord.cancel(wt.worktreeId);
      const dt = Date.now() - t0;
      assert.ok(dt < 1500, `bounded return (${dt}ms)`);
      assert.strictEqual(out.quiesced, false, 'non-cooperative not quiesced');
      assert.ok(coord.status(wt.worktreeId), 'worktree retained');
      d.resolve('late');
      await new Promise(r => setTimeout(r, 50));
      // worker terminal 后 lock 释放（可重新 acquire 同 root）
      const lock = createProjectMutationLock();
      const re = lock.acquireWrite(coord.status(wt.worktreeId).worktreeRoot, 'recheck', 'x');
      assert.ok(re.ok, 'lock released after late quiescence');
      lock.release('recheck');
      await coord.cleanup(wt.worktreeId, { force: true }).catch(() => {});
    }
  } finally { rmTree(repo); }
});

test('§15 Coordinator 缺 shared lock → SHARED_MUTATION_LOCK_REQUIRED', () => {
  assert.throws(() => createParallelWorktreeCoordinator({}), /SHARED_MUTATION_LOCK_REQUIRED/);
});
