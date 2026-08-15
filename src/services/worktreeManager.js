'use strict';
/**
 * P5-A Parallel Worktree Isolation Foundation — WorktreeManager + ParallelWorktreeCoordinator.
 *
 * 这是一个「Git 工作区隔离服务」，不是新的 Framework（§13）：
 *   - 复用 src/agent/runtime/gitHelper.js 的 execGit（argument-array 调用 git，
 *     已在该架构签名的 canonical allowlist 中），本文件不直接派生子进程。
 *   - Worktree 元数据保存在内存 Map（不落盘），本文件不调用任何落盘写文件/重命名类接口，
 *     因此架构冻结策略（DEFAULT DENY）零改动。
 *   - 不引入第二 ProjectMutationLock / RunManager / AgentHub / Git execution framework。
 *     ProjectMutationLock 由 Coordinator 直接复用（每个 worktree 独立 root → 独立锁）。
 *
 * 安全不变量（fail-closed）：
 *   - 只接受真实 Git repository（git rev-parse --show-toplevel / HEAD 必须成功）。
 *   - 每个 project 最多 2 个 worktree（maxWorktreesPerProject）。
 *   - worktree 目录 = <project parent>/.adp-worktrees/<projectId>/<runId>，
 *     canonical realpath 后必须落在 ownedRoot 内且不在原 repo 内。
 *   - 不覆盖已有目录；runId/branch 不唯一则 fail closed。
 *   - cleanup/remove 仅删除平台创建并拥有的 worktree；先验证 metadata 存在 +
 *     canonical 落在 ownedRoot；绝不 rm -rf 任意用户路径。
 *   - 脏 worktree（有未提交 diff）默认保留（WORKTREE_DIRTY_RETAINED），不静默丢失；
 *     COMPLETED 且显式 force 时先 git worktree remove（必要时 --force），分支一并清理。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { execGit } = require('../agent/runtime/gitHelper');
const {
  canonicalizeRoot,
  canonicalizeTargetPath,
  isInsideCanonical,
  isWin
} = require('../security/pathSecurity/canonicalPath');
const { createProjectMutationLock } = require('../security/projectMutationLock');

const MAX_WORKTREES_PER_PROJECT = 2;
const MAX_PARALLEL = 2;
const DEFAULT_DIFF_CAP_BYTES = 200 * 1024;
const OWNED_DIR_NAME = '.adp-worktrees';

const STATUS = Object.freeze({
  CREATING: 'CREATING',
  READY: 'READY',
  BUSY: 'BUSY',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
  REMOVING: 'REMOVING',
  DIRTY_RETAINED: 'WORKTREE_DIRTY_RETAINED'
});

const FAIL_CODES = Object.freeze({
  NOT_A_GIT_REPO: 'NOT_A_GIT_REPO',
  GIT_HEAD_MISSING: 'GIT_HEAD_MISSING',
  MAX_WORKTREES_EXCEEDED: 'MAX_WORKTREES_EXCEEDED',
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  DUPLICATE_WORKTREE_ID: 'DUPLICATE_WORKTREE_ID',
  WORKTREE_PATH_EXISTS: 'WORKTREE_PATH_EXISTS',
  BRANCH_EXISTS: 'BRANCH_EXISTS',
  OWNED_ROOT_ESCAPE: 'OWNED_ROOT_ESCAPE',
  WORKTREE_ESCAPE: 'WORKTREE_ESCAPE',
  WORKTREE_ADD_FAILED: 'WORKTREE_ADD_FAILED',
  WORKTREE_NOT_OWNED: 'WORKTREE_NOT_OWNED',
  WORKTREE_OUTSIDE_OWNED_ROOT: 'WORKTREE_OUTSIDE_OWNED_ROOT',
  MAX_PARALLEL_EXCEEDED: 'MAX_PARALLEL_EXCEEDED'
});

function makeError(code, message) {
  // 把 code 也写进 message，便于 assert.rejects(/CODE/) 匹配（fail-closed 语义不丢 code）
  const e = new Error(message ? `${code}: ${message}` : code);
  e.code = code;
  return e;
}

/** 派生稳定 projectId（canonical repo root 的短哈希，不含路径注入字符）。 */
function deriveProjectId(canonicalRepoRoot) {
  return 'p' + crypto.createHash('sha1').update(canonicalRepoRoot).digest('hex').slice(0, 12);
}

/** 仅允许安全字符进入目录/ID（拒绝 '..' 等逃逸）。 */
function sanitizeToken(token) {
  return String(token == null ? '' : token).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 解析 `git status --porcelain` 得到真实 changedFiles（Git 状态为真相，不信任 Agent 自报）。
 * @param {string} porcelain
 * @returns {string[]}
 */
function parsePorcelain(porcelain) {
  const files = new Set();
  for (const raw of String(porcelain || '').split('\n')) {
    if (!raw) continue;
    // 跳过前缀（XY + 空格/制表）。v1 用空格，v2 用制表。
    const idx = raw[2] === ' ' || raw[2] === '\t' ? 3 : 2;
    let rest = raw.slice(idx).trim();
    if (!rest) continue;
    // 重命名：old -> new（porcelain v1 人类可读形式）
    if (rest.includes(' -> ')) rest = rest.slice(rest.lastIndexOf(' -> ') + 4);
    // 去掉可能的引号（porcelain 对特殊字符加引号）
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) files.add(rest);
  }
  return Array.from(files);
}

/**
 * 创建 WorktreeManager。
 * @param {object} [opts]
 * @param {number} [opts.maxWorktreesPerProject=2]
 * @param {number} [opts.diffCapBytes=204800]
 * @param {string} [opts.ownedDirName='.adp-worktrees']
 */
function createWorktreeManager(opts = {}) {
  const maxWorktreesPerProject = opts.maxWorktreesPerProject || MAX_WORKTREES_PER_PROJECT;
  const diffCapBytes = opts.diffCapBytes || DEFAULT_DIFF_CAP_BYTES;
  const ownedDirName = opts.ownedDirName || OWNED_DIR_NAME;

  /** worktreeId -> record（内存元数据，真实真相由 git 命令读取）。 */
  const worktrees = new Map();

  function recordToView(rec) {
    return {
      worktreeId: rec.worktreeId,
      runId: rec.runId,
      projectId: rec.projectId,
      projectRoot: rec.projectRoot,
      worktreeRoot: rec.worktreeRoot,
      branch: rec.branch,
      baseCommit: rec.baseCommit,
      status: rec.status,
      createdAt: rec.createdAt,
      ownedRoot: rec.ownedRoot
    };
  }

  function _ownedRootFor(canonicalRepoRoot, projectId) {
    return path.join(path.dirname(canonicalRepoRoot), ownedDirName, projectId);
  }

  /** ownedRoot 是否 canonical 包含 candidate（fail-closed）。 */
  function _isInsideOwned(ownedRootCanonical, candidatePath) {
    let cand;
    try {
      cand = canonicalizeTargetPath(candidatePath).canonicalPath;
    } catch {
      cand = path.resolve(candidatePath);
    }
    return isInsideCanonical(ownedRootCanonical, cand);
  }

  /** 公开只读判断：某 worktreeRoot 是否属于该 project 的 owned 区域（用于非法路径拒绝）。 */
  function isOwnedWorktree(worktreeRoot, projectRoot) {
    try {
      const canonicalRepoRoot = canonicalizeRoot(projectRoot);
      const pid = deriveProjectId(canonicalRepoRoot);
      const ownedRoot = _ownedRootFor(canonicalRepoRoot, pid);
      let ownedCanonical;
      try {
        ownedCanonical = canonicalizeRoot(ownedRoot);
      } catch {
        ownedCanonical = canonicalizeTargetPath(ownedRoot).canonicalPath;
      }
      return _isInsideOwned(ownedCanonical, worktreeRoot);
    } catch {
      return false;
    }
  }

  /**
   * 创建 worktree（argument-array git 调用，无用户输入拼 shell）。
   * @param {object} p
   * @param {string} p.projectRoot 原项目（repo）根目录
   * @param {string} p.runId 平台 run id（作为目录/ID 来源，已消毒）
   * @param {string} [p.projectId]
   * @param {string} [p.baseCommit] 默认取 repo HEAD
   * @param {string} [p.branch]
   */
  async function create(p = {}) {
    const { projectRoot, runId } = p;
    if (!projectRoot || !runId) throw makeError('INVALID_ARG', 'projectRoot and runId required');

    // —— 1. 仅真实 Git repository（fail closed）——
    const topRes = await execGit(projectRoot, ['rev-parse', '--show-toplevel']);
    if (topRes.code !== 0) throw makeError(FAIL_CODES.NOT_A_GIT_REPO, topRes.err || 'not a git repo');
    const headRes = await execGit(projectRoot, ['rev-parse', 'HEAD']);
    if (headRes.code !== 0) throw makeError(FAIL_CODES.GIT_HEAD_MISSING, headRes.err || 'no HEAD');

    const canonicalRepoRoot = canonicalizeRoot(projectRoot);
    const projectId = p.projectId || deriveProjectId(canonicalRepoRoot);

    // —— 2. 每 project 最多 2 个 worktree ——
    const count = Array.from(worktrees.values()).filter(r => r.projectId === projectId).length;
    if (count >= maxWorktreesPerProject) {
      throw makeError(FAIL_CODES.MAX_WORKTREES_EXCEEDED,
        `max ${maxWorktreesPerProject} worktrees per project (projectId=${projectId})`);
    }

    // —— 3. ownedRoot 必须落在 project parent 内且不在原 repo 内 ——
    const projectParent = path.dirname(canonicalRepoRoot);
    const ownedRoot = _ownedRootFor(canonicalRepoRoot, projectId);
    if (!isInsideCanonical(projectParent, ownedRoot) || isInsideCanonical(canonicalRepoRoot, ownedRoot)) {
      throw makeError(FAIL_CODES.OWNED_ROOT_ESCAPE, `owned root must be under project parent and outside repo: ${ownedRoot}`);
    }

    // —— 4. runId 消毒 + 唯一 worktreeId ——
    const safeRun = sanitizeToken(runId);
    if (!safeRun) throw makeError(FAIL_CODES.INVALID_RUN_ID, `invalid runId: ${runId}`);
    const worktreeId = 'wt_' + safeRun;
    if (worktrees.has(worktreeId)) throw makeError(FAIL_CODES.DUPLICATE_WORKTREE_ID, `worktreeId already exists: ${worktreeId}`);

    const worktreeRoot = path.join(ownedRoot, safeRun);
    if (fs.existsSync(worktreeRoot)) throw makeError(FAIL_CODES.WORKTREE_PATH_EXISTS, `worktree path exists: ${worktreeRoot}`);

    // —— 5. canonical 逃逸检查（ownedRoot 已创建后）——
    fs.mkdirSync(ownedRoot, { recursive: true });
    const ownedCanonical = canonicalizeRoot(ownedRoot);
    const wtPredicted = path.resolve(worktreeRoot);
    if (!isInsideCanonical(ownedCanonical, wtPredicted)) {
      throw makeError(FAIL_CODES.WORKTREE_ESCAPE, `worktree escapes owned root: ${worktreeRoot}`);
    }

    // —— 6. branch 唯一（fail closed）——
    const shortRun = safeRun.slice(0, 40);
    const branch = p.branch || ('adp-run-' + shortRun);
    const branchCheck = await execGit(projectRoot, ['rev-parse', '--verify', branch]);
    if (branchCheck.code === 0) throw makeError(FAIL_CODES.BRANCH_EXISTS, `branch already exists: ${branch}`);

    const baseCommit = p.baseCommit || headRes.out.trim();

    // —— 7. 创建 worktree（argument-array，无用户输入拼 shell）——
    const addRes = await execGit(projectRoot, ['worktree', 'add', '-b', branch, wtPredicted, baseCommit]);
    if (addRes.code !== 0) {
      // 失败不要留半成品目录
      try { fs.rmdirSync(wtPredicted, { recursive: true }); } catch { /* noop */ }
      throw makeError(FAIL_CODES.WORKTREE_ADD_FAILED, addRes.err || addRes.out || 'git worktree add failed');
    }

    const rec = {
      worktreeId,
      runId,
      projectId,
      projectRoot: canonicalRepoRoot,
      worktreeRoot: wtPredicted,
      branch,
      baseCommit,
      status: STATUS.READY,
      createdAt: Date.now(),
      ownedRoot: ownedCanonical
    };
    worktrees.set(worktreeId, rec);
    return recordToView(rec);
  }

  /** 列出 worktree（可按 projectRoot 过滤）。 */
  function list(filter = {}) {
    let arr = Array.from(worktrees.values()).map(recordToView);
    if (filter.projectRoot) {
      let cr;
      try { cr = canonicalizeRoot(filter.projectRoot); } catch { cr = filter.projectRoot; }
      arr = arr.filter(r => r.projectRoot === cr);
    }
    if (filter.runId) arr = arr.filter(r => r.runId === filter.runId);
    if (filter.status) arr = arr.filter(r => r.status === filter.status);
    return arr;
  }

  /** 取单条记录（视图）。 */
  function status(worktreeId) {
    const rec = worktrees.get(worktreeId);
    return rec ? recordToView(rec) : null;
  }

  function _setStatus(worktreeId, statusVal) {
    const rec = worktrees.get(worktreeId);
    if (rec) { rec.status = statusVal; }
  }

  /** worktree 是否脏（有未提交 diff / untracked）。 */
  async function isDirty(worktreeRoot) {
    const res = await execGit(worktreeRoot, ['status', '--porcelain']);
    return res.code === 0 && res.out.trim().length > 0;
  }

  /**
   * 读取真实 Git 状态作为 diff 真相。
   * @returns {{ worktreeId, runId, branch, baseCommit, changedFiles:string[], diff:string, truncated:boolean, status:string }|null}
   */
  async function getDiff(worktreeId) {
    const rec = worktrees.get(worktreeId);
    if (!rec) return null;
    const statusRes = await execGit(rec.worktreeRoot, ['status', '--porcelain']);
    const changedFiles = statusRes.code === 0 ? parsePorcelain(statusRes.out) : [];
    const diffRes = await execGit(rec.worktreeRoot, ['diff', '--no-ext-diff']);
    let diff = diffRes.out || '';
    let truncated = false;
    if (diff.length > diffCapBytes) {
      diff = diff.slice(0, diffCapBytes);
      truncated = true;
    }
    return {
      worktreeId,
      runId: rec.runId,
      branch: rec.branch,
      baseCommit: rec.baseCommit,
      changedFiles,
      diff,
      truncated,
      status: rec.status
    };
  }

  /**
   * 删除/保留 worktree。cleanup 安全核心：
   *   - 仅删除平台创建并拥有的 worktree（metadata 存在 + canonical 落在 ownedRoot）。
   *   - 脏 worktree 默认保留（WORKTREE_DIRTY_RETAINED），不静默丢失。
   *   - 显式 force 时通过 git worktree remove [--force] 删除（必要时丢弃脏改动），分支一并清理。
   * @param {string} worktreeId
   * @param {object} [o] { force?:boolean, retainDirty?:boolean }
   */
  async function remove(worktreeId, o = {}) {
    const { force = false, retainDirty = true } = o;
    const rec = worktrees.get(worktreeId);
    if (!rec) throw makeError(FAIL_CODES.WORKTREE_NOT_OWNED, `unknown worktreeId: ${worktreeId}`);

    // 所有权验证：canonical 必须落在 ownedRoot；否则拒绝（绝不 rm 任意路径）。
    if (!_isInsideOwned(rec.ownedRoot, rec.worktreeRoot)) {
      throw makeError(FAIL_CODES.WORKTREE_OUTSIDE_OWNED_ROOT, `refuse cleanup outside owned root: ${rec.worktreeRoot}`);
    }

    const dirty = await isDirty(rec.worktreeRoot);
    if (dirty && !force && retainDirty) {
      rec.status = STATUS.DIRTY_RETAINED;
      return { removed: false, retained: true, reason: STATUS.DIRTY_RETAINED, worktreeId };
    }

    rec.status = STATUS.REMOVING;
    const rmArgs = ['worktree', 'remove'];
    if (dirty && force) rmArgs.push('--force');
    rmArgs.push(rec.worktreeRoot);
    const rmRes = await execGit(rec.projectRoot, rmArgs);
    if (rmRes.code !== 0 && !(dirty && force)) {
      // 非 force 且 git 拒绝（理论上是脏但 retainDirty 已拦截，这里做兜底）
      rec.status = rec.status === STATUS.REMOVING ? STATUS.READY : rec.status;
      throw makeError('WORKTREE_REMOVE_FAILED', rmRes.err || rmRes.out || 'git worktree remove failed');
    }
    // best-effort 清理：prune + 删除分支
    await execGit(rec.projectRoot, ['worktree', 'prune']);
    if (force || !dirty) {
      await execGit(rec.projectRoot, ['branch', '-D', rec.branch]).catch(() => { /* 分支可能已不存在 */ });
    }
    // 仅删该 worktree 自身（git 通常已移除）；共享容器 .adp-worktrees/<projectId>
    // 用「非递归」rmdir——若仍含其它 worktree（如 B）会抛错并被吞掉，绝不递归误删兄弟。
    try { if (fs.existsSync(rec.worktreeRoot)) fs.rmdirSync(rec.worktreeRoot); } catch { /* noop */ }
    try { if (fs.existsSync(rec.ownedRoot)) fs.rmdirSync(rec.ownedRoot); } catch { /* noop */ }

    worktrees.delete(worktreeId);
    return { removed: true, retained: false, worktreeId };
  }

  /** cleanup 别名（保留语义：按策略删除或保留）。 */
  async function cleanup(worktreeId, o) {
    return remove(worktreeId, o);
  }

  /** 清理某 runId 下的所有 worktree。 */
  async function cleanupRun(runId, o) {
    const ids = Array.from(worktrees.values()).filter(r => r.runId === runId).map(r => r.worktreeId);
    const results = [];
    for (const id of ids) results.push(await remove(id, o));
    return results;
  }

  function diagnostics() {
    return {
      maxWorktreesPerProject,
      ownedDirName,
      count: worktrees.size,
      worktrees: Array.from(worktrees.values()).map(recordToView)
    };
  }

  return {
    create,
    list,
    status,
    getDiff,
    isDirty,
    remove,
    cleanup,
    cleanupRun,
    isOwnedWorktree,
    diagnostics,
    MAX_WORKTREES_PER_PROJECT: maxWorktreesPerProject,
    // 内部（测试/coordinator 使用）
    _setStatus,
    _worktrees: worktrees
  };
}

/**
 * ParallelWorktreeCoordinator — 极薄协调层（maxParallel=2）。
 * 只负责：为每个 task 创建 worktree → 在 worktree 内运行 worker（worker 只看到 worktreeRoot，
 * 看不到原 projectRoot）→ 收集真实 git diff → 返回结果；cancel 先 quiesce worker 再按策略处理。
 * 复用 ProjectMutationLock：每个 worktree 拥有独立 root → 独立写锁，不破坏原项目锁。
 *
 * @param {object} [opts]
 * @param {object} [opts.worktreeManager] 复用或新建 WorktreeManager
 * @param {object} [opts.mutationLock] 复用或新建 ProjectMutationLock
 * @param {number} [opts.maxParallel=2]
 */
function createParallelWorktreeCoordinator(opts = {}) {
  const manager = opts.worktreeManager || createWorktreeManager(opts.managerOpts);
  const lock = opts.mutationLock || createProjectMutationLock();
  const maxParallel = opts.maxParallel || MAX_PARALLEL;

  /** runId -> { controller, promise, worktreeId } 活跃 worker 跟踪 */
  const active = new Map();

  async function _runOne(task) {
    const rec = await manager.create({ projectRoot: task.projectRoot, runId: task.runId });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const entry = { controller, worktreeId: rec.worktreeId, record: rec, promise: null };
    active.set(rec.worktreeId, entry);

    // 独立写锁：key = worktreeRoot（!= 原 projectRoot）→ A/B 锁 root 不同
    const acquired = lock.acquireWrite(rec.worktreeRoot, task.runId, 'parallel-coordinator');
    if (!acquired.ok) {
      active.delete(rec.worktreeId);
      throw makeError('LOCK_ACQUIRE_FAILED', `mutation lock: ${JSON.stringify(acquired.lockHolder)}`);
    }
    manager._setStatus(rec.worktreeId, STATUS.BUSY);
    try {
      // 先存 promise（供 cancel 在运行中 quiesce），再 await
      entry.promise = task.worker({
        // 主项目保护：worker 只拿到 worktreeRoot，绝拿不到原 projectRoot
        worktreeRoot: rec.worktreeRoot,
        projectRoot: rec.worktreeRoot,
        runId: task.runId,
        signal: controller ? controller.signal : null,
        context: task.context || {}
      });
      const result = await entry.promise;
      const diff = await manager.getDiff(rec.worktreeId);
      manager._setStatus(rec.worktreeId, STATUS.COMPLETED);
      lock.release(task.runId);
      active.delete(rec.worktreeId);
      return {
        worktreeId: rec.worktreeId,
        runId: task.runId,
        branch: rec.branch,
        baseCommit: rec.baseCommit,
        worktreeRoot: rec.worktreeRoot,
        status: STATUS.COMPLETED,
        changedFiles: diff ? diff.changedFiles : [],
        diff: diff ? diff.diff : '',
        result
      };
    } catch (e) {
      manager._setStatus(rec.worktreeId, STATUS.ERROR);
      lock.release(task.runId);
      active.delete(rec.worktreeId);
      throw e;
    }
  }

  /** 并发上限执行（保序返回）。 */
  async function _mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    }
    const pool = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) pool.push(worker());
    await Promise.all(pool);
    return results;
  }

  /**
   * 并行跑一对 task（默认 maxParallel=2）。
   * @param {object} p
   * @param {string} p.projectRoot 原项目根目录（runner 内部使用，不传给 worker）
   * @param {Array<{runId:string, worker:Function, context?:object, projectRoot?:string}>} p.tasks
   */
  async function runPair(p = {}) {
    const tasks = p.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw makeError('INVALID_ARG', 'tasks required');
    if (tasks.length > maxParallel) throw makeError(FAIL_CODES.MAX_PARALLEL_EXCEEDED, `maxParallel=${maxParallel}`);
    // 注入 projectRoot 给每个 task（供 _runOne 创建 worktree）
    const enriched = tasks.map(t => ({ ...t, projectRoot: p.projectRoot }));
    const results = await _mapLimit(enriched, maxParallel, _runOne);
    return results;
  }

  /**
   * 取消某 worktree 的 worker：先 abort（quiesce），再按策略处理 worktree。
   * 默认 dirty 保留（WORKTREE_DIRTY_RETAINED），不 force delete。
   * @param {string} worktreeId
   */
  async function cancel(worktreeId) {
    const a = active.get(worktreeId);
    if (a && a.controller) a.controller.abort();
    if (a && a.promise) { try { await a.promise; } catch { /* 已中断 */ } }
    // worker 已 quiesce，按策略处理 worktree
    const rec = manager.status(worktreeId);
    if (!rec) return { cancelled: false, reason: 'NOT_FOUND', worktreeId };
    const outcome = await manager.remove(worktreeId, { force: false, retainDirty: true });
    return { cancelled: true, worktreeId, ...outcome };
  }

  /** 显式 cleanup（可 force 删除 COMPLETED 且脏的 worktree）。 */
  async function cleanup(worktreeId, o) {
    return manager.remove(worktreeId, o);
  }

  async function cleanupRun(runId, o) {
    return manager.cleanupRun(runId, o);
  }

  function list() { return manager.list(); }
  function status(worktreeId) { return manager.status(worktreeId); }
  function getDiff(worktreeId) { return manager.getDiff(worktreeId); }
  function diagnostics() { return manager.diagnostics(); }

  return {
    runPair,
    cancel,
    cleanup,
    cleanupRun,
    list,
    status,
    getDiff,
    diagnostics,
    manager,
    MAX_PARALLEL: maxParallel
  };
}

module.exports = {
  createWorktreeManager,
  createParallelWorktreeCoordinator,
  STATUS,
  FAIL_CODES,
  MAX_WORKTREES_PER_PROJECT,
  MAX_PARALLEL,
  OWNED_DIR_NAME,
  parsePorcelain,
  deriveProjectId,
  sanitizeToken
};
