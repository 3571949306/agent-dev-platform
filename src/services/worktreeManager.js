'use strict';
/**
 * P5-A.1 Worktree Truth & Permission Scope Closure — WorktreeManager + ParallelWorktreeCoordinator.
 *
 * 这是一个「Git 工作区隔离服务」，不是新的 Framework（§2/§35）：
 *   - 复用 src/agent/runtime/gitHelper.js 的 execGit（argument-array 调用 git），本文件不直接派生子进程。
 *   - 复用 src/security/pathSecurity/canonicalPath 的 canonical containment（fail-closed）。
 *   - 复用 src/agent/runtime/checkpoint.js 的 non-mutating snapshot（dirty base，绝不 stash）。
 *   - ProjectMutationLock 必须由调用方显式注入（§15），Coordinator 绝不自己创建第二把锁。
 *
 * P5-A.1 修复的不变量（fail-closed）：
 *   - §4  真实 Git root identity 唯一来自 `git rev-parse --show-toplevel`，caller projectRoot 仅作 requested path。
 *   - §5  storage projectId 只能从 canonical repo root 派生；caller projectId 仅作 metadata，不能绕过 max=2。
 *   - §6  cleanup ownership：canonicalization 失败 → DENY（不 fallback path.resolve）。
 *   - §7  git status 失败 → UNKNOWN/ERROR，绝不是 CLEAN；remove/getDiff 遇 ERROR 拒绝/报错。
 *   - §8  git worktree remove 失败 → 永远 removed!=true，metadata 保留，不删 branch。
 *   - §9  原子 max=2 reservation（同步 check+increment，finally 释放，防并发交错）。
 *   - §10 create 失败零残留（partial dir / reservation / ephemeral ref 全清理）。
 *   - §11 完整 diff truth：temporary GIT_INDEX_FILE + add -A + diff --cached --binary <base>，
 *         覆盖 staged/unstaged/untracked/deleted/renamed/binary/committed；真实 index 不变。
 *   - §12 NUL-safe（-z）解析 git 路径，不依赖 split('\n')/人类可读 rename 格式。
 *   - §13 dirty base：默认从用户当前真实状态创建 non-mutating snapshot；A/B 同一 immutable base。
 *   - §14 caller baseCommit 必须 cat-file 校验，否则 INVALID_BASE_COMMIT。
 *   - §16 worker 只拿 worktree authority；task.context 不透传，仅 allowlist metadata。
 *   - §17 BUSY/CREATING/REMOVING 禁止普通 cleanup（WORKTREE_BUSY）。
 *   - §18 bounded cancel：有界返回；non-quiescent 不 cleanup/不释放锁/不删 active。
 *   - §19 lock release 在 finally，exactly-once，terminal 之后。
 *   - §20 temp index/ref 由当前 operation 拥有，finally 删除，命名 crypto.randomUUID()。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { execGit } = require('../agent/runtime/gitHelper');
const { snapshotGitProject } = require('../agent/runtime/checkpoint');
const {
  canonicalizeRoot,
  canonicalizeTargetPath,
  isInsideCanonical
} = require('../security/pathSecurity/canonicalPath');

const MAX_WORKTREES_PER_PROJECT = 2;
const MAX_PARALLEL = 2;
const DEFAULT_DIFF_CAP_BYTES = 200 * 1024;
const OWNED_DIR_NAME = '.adp-worktrees';
const EPHEMERAL_REF_PREFIX = 'p5wt-'; // P5 临时 snapshot ref 的可识别 ownership 前缀
const DEFAULT_CANCEL_QUIESCENCE_TIMEOUT_MS = 3000;

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

const GIT_STATE = Object.freeze({ CLEAN: 'CLEAN', DIRTY: 'DIRTY', ERROR: 'ERROR' });

const FAIL_CODES = Object.freeze({
  NOT_A_GIT_REPO: 'NOT_A_GIT_REPO',
  GIT_HEAD_MISSING: 'GIT_HEAD_MISSING',
  MAX_WORKTREES_EXCEEDED: 'MAX_WORKTREES_EXCEEDED',
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  DUPLICATE_WORKTREE_ID: 'DUPLICATE_WORKTREE_ID',
  WORKTREE_PATH_EXISTS: 'WORKTREE_PATH_EXISTS',
  BRANCH_EXISTS: 'BRANCH_EXISTS',
  INVALID_BRANCH: 'INVALID_BRANCH',
  INVALID_BASE_COMMIT: 'INVALID_BASE_COMMIT',
  OWNED_ROOT_ESCAPE: 'OWNED_ROOT_ESCAPE',
  WORKTREE_ESCAPE: 'WORKTREE_ESCAPE',
  WORKTREE_ADD_FAILED: 'WORKTREE_ADD_FAILED',
  WORKTREE_NOT_OWNED: 'WORKTREE_NOT_OWNED',
  WORKTREE_OUTSIDE_OWNED_ROOT: 'WORKTREE_OUTSIDE_OWNED_ROOT',
  WORKTREE_REMOVE_FAILED: 'WORKTREE_REMOVE_FAILED',
  WORKTREE_BUSY: 'WORKTREE_BUSY',
  GIT_STATUS_ERROR: 'GIT_STATUS_ERROR',
  DIFF_FAILED: 'DIFF_FAILED',
  MAX_PARALLEL_EXCEEDED: 'MAX_PARALLEL_EXCEEDED',
  SHARED_MUTATION_LOCK_REQUIRED: 'SHARED_MUTATION_LOCK_REQUIRED',
  WORKER_QUIESCENCE_TIMEOUT: 'WORKER_QUIESCENCE_TIMEOUT'
});

function makeError(code, message) {
  const e = new Error(message ? `${code}: ${message}` : code);
  e.code = code;
  return e;
}

/** 派生稳定 storage projectId（canonical repo root 的短哈希）。§5：唯一权威来源。 */
function deriveProjectId(canonicalRepoRoot) {
  return 'p' + crypto.createHash('sha1').update(canonicalRepoRoot).digest('hex').slice(0, 12);
}

/** 仅允许安全字符进入目录/ID（拒绝 '..' 等逃逸）。 */
function sanitizeToken(token) {
  return String(token == null ? '' : token).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * NUL-safe 解析 `git status --porcelain=v1 -z` / `diff --name-only -z`。§12
 * 不依赖 split('\n')、trim、人类可读 rename 格式或引号剥离。
 * @param {string} z NUL 分隔输出
 * @returns {string[]}
 */
function parsePorcelainZ(z) {
  const files = new Set();
  const tokens = String(z == null ? '' : z).split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 3) continue;
    // status --porcelain=v1 -z: "XY path"（XY 两字符 + 空格）；rename/copy 额外跟一个 original path
    const xy = t.slice(0, 2);
    const p = t.slice(3);
    if (p) files.add(p);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++; // 跳过 original path token
    }
  }
  return Array.from(files);
}

/** 兼容旧接口：解析人类可读 porcelain（仅用于非安全展示路径）。 */
function parsePorcelain(porcelain) {
  const files = new Set();
  for (const raw of String(porcelain || '').split('\n')) {
    if (!raw) continue;
    const idx = raw[2] === ' ' || raw[2] === '\t' ? 3 : 2;
    let rest = raw.slice(idx).trim();
    if (!rest) continue;
    if (rest.includes(' -> ')) rest = rest.slice(rest.lastIndexOf(' -> ') + 4);
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) files.add(rest);
  }
  return Array.from(files);
}

/** byte-accurate 截断（不截坏多字节字符）。§11 */
function capByBytes(str, capBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= capBytes) return { out: str, truncated: false, bytes: buf.length };
  let end = capBytes;
  // 回退到 UTF-8 字符边界（跳过 continuation bytes 10xxxxxx）
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { out: buf.slice(0, end).toString('utf8'), truncated: true, bytes: buf.length };
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
  /** §9 canonicalRepoRoot -> 进行中的 CREATING reservation 计数。 */
  const reservations = new Map();

  function recordToView(rec) {
    return {
      worktreeId: rec.worktreeId,
      runId: rec.runId,
      projectId: rec.projectId,
      callerProjectId: rec.callerProjectId || null,
      projectRoot: rec.projectRoot,
      worktreeRoot: rec.worktreeRoot,
      branch: rec.branch,
      baseCommit: rec.baseCommit,
      status: rec.status,
      createdAt: rec.createdAt,
      ownedRoot: rec.ownedRoot
    };
  }

  function _ownedRootFor(canonicalRepoRoot, storageProjectId) {
    return path.join(path.dirname(canonicalRepoRoot), ownedDirName, storageProjectId);
  }

  /**
   * §4 真实 Git root identity：唯一真相来自 show-toplevel；caller projectRoot 仅 requested。
   * @returns {Promise<{canonicalRepoRoot:string, requestedCanonical:string}>}
   */
  async function resolveTrueRepoRoot(projectRoot) {
    const topRes = await execGit(projectRoot, ['rev-parse', '--show-toplevel']);
    if (topRes.code !== 0 || !topRes.out.trim()) throw makeError(FAIL_CODES.NOT_A_GIT_REPO, topRes.err || 'not a git repo');
    const reportedRoot = topRes.out.trim();
    const canonicalRepoRoot = canonicalizeRoot(reportedRoot);
    // requested path 必须位于真实 repo root 内（允许 repo/sub/dir）
    let requestedCanonical;
    try { requestedCanonical = canonicalizeRoot(projectRoot); }
    catch { requestedCanonical = canonicalizeTargetPath(projectRoot).canonicalPath; }
    if (requestedCanonical !== canonicalRepoRoot && !isInsideCanonical(canonicalRepoRoot, requestedCanonical)) {
      throw makeError(FAIL_CODES.NOT_A_GIT_REPO, `requested path outside true repo root: ${projectRoot}`);
    }
    return { canonicalRepoRoot, requestedCanonical };
  }

  /** §6 ownership：canonical 包含 candidate；canonicalization 失败 → false（DENY，不 fallback）。 */
  function _isInsideOwned(ownedRootCanonical, candidatePath) {
    let cand;
    try {
      cand = canonicalizeTargetPath(candidatePath).canonicalPath;
    } catch {
      return false; // fail closed：身份未知绝不授权删除
    }
    return isInsideCanonical(ownedRootCanonical, cand);
  }

  function isOwnedWorktree(worktreeRoot, projectRoot) {
    try {
      const { canonicalRepoRoot } = { canonicalRepoRoot: canonicalizeRoot(projectRoot) };
      const pid = deriveProjectId(canonicalRepoRoot);
      const ownedRoot = _ownedRootFor(canonicalRepoRoot, pid);
      let ownedCanonical;
      try { ownedCanonical = canonicalizeRoot(ownedRoot); }
      catch { return false; }
      return _isInsideOwned(ownedCanonical, worktreeRoot);
    } catch {
      return false;
    }
  }

  /** §7 git status 三态：CLEAN / DIRTY / ERROR（失败绝不是 CLEAN）。NUL-safe。 */
  async function statusState(root) {
    const res = await execGit(root, ['status', '--porcelain=v1', '-z']);
    if (res.code !== 0) return GIT_STATE.ERROR;
    const records = String(res.out || '').split('\0').filter(t => t && t.trim().length > 0);
    return records.length > 0 ? GIT_STATE.DIRTY : GIT_STATE.CLEAN;
  }

  async function isDirty(worktreeRoot) {
    const s = await statusState(worktreeRoot);
    if (s === GIT_STATE.ERROR) throw makeError(FAIL_CODES.GIT_STATUS_ERROR, `git status failed for ${worktreeRoot}`);
    return s === GIT_STATE.DIRTY;
  }

  /** §14 校验 caller baseCommit 为可解析 commit object。 */
  async function validateBaseCommit(repoRoot, baseCommit) {
    const r = await execGit(repoRoot, ['cat-file', '-e', `${baseCommit}^{commit}`]);
    if (r.code !== 0) throw makeError(FAIL_CODES.INVALID_BASE_COMMIT, `unresolvable baseCommit: ${baseCommit}`);
    return baseCommit;
  }

  /** 创建 P5 临时 non-mutating snapshot（dirty/error base）。返回 {commit, ref}。§13 */
  async function _createEphemeralSnapshot(repoRoot) {
    const id = EPHEMERAL_REF_PREFIX + crypto.randomUUID();
    const snap = await snapshotGitProject(repoRoot, id);
    if (!snap.ok) throw makeError('SNAPSHOT_FAILED', snap.message || 'ephemeral snapshot failed');
    return { commit: snap.commit, ref: snap.ref };
  }

  /** 仅删除 P5 自己拥有的 ephemeral ref（前缀守卫，绝不删用户/checkpoint ref）。§20 */
  async function _deleteEphemeralRef(repoRoot, ref) {
    if (!ref || !ref.includes('/' + EPHEMERAL_REF_PREFIX)) return;
    try { await execGit(repoRoot, ['update-ref', '-d', ref]); } catch { /* best effort */ }
  }

  /**
   * §13 coordinator 用：一次性解析 shared base（true root / HEAD / dirty / snapshot），
   * 保证 A/B 使用同一 immutable baseCommit。ref 由调用方负责删除。
   */
  async function prepareSharedBase(projectRoot, callerBaseCommit) {
    const { canonicalRepoRoot } = await resolveTrueRepoRoot(projectRoot);
    const headRes = await execGit(canonicalRepoRoot, ['rev-parse', 'HEAD']);
    if (headRes.code !== 0) throw makeError(FAIL_CODES.GIT_HEAD_MISSING, headRes.err || 'no HEAD');
    const headCommit = headRes.out.trim();
    if (callerBaseCommit) {
      return { canonicalRepoRoot, headCommit, baseCommit: await validateBaseCommit(canonicalRepoRoot, callerBaseCommit), snapshotRef: null, statusState: GIT_STATE.CLEAN };
    }
    const st = await statusState(canonicalRepoRoot);
    if (st === GIT_STATE.CLEAN) return { canonicalRepoRoot, headCommit, baseCommit: headCommit, snapshotRef: null, statusState: st };
    // DIRTY 或 ERROR：不假设 clean，创建 non-mutating snapshot 作为 base
    const snap = await _createEphemeralSnapshot(canonicalRepoRoot);
    return { canonicalRepoRoot, headCommit, baseCommit: snap.commit, snapshotRef: snap.ref, statusState: st };
  }

  /** §9 同步原子保留 slot（check+increment 之间无 await）。返回释放函数。 */
  function _reserveSlot(canonicalRepoRoot) {
    const activeCount = Array.from(worktrees.values()).filter(r => r.projectRoot === canonicalRepoRoot).length;
    const creating = reservations.get(canonicalRepoRoot) || 0;
    if (activeCount + creating >= maxWorktreesPerProject) {
      throw makeError(FAIL_CODES.MAX_WORKTREES_EXCEEDED, `max ${maxWorktreesPerProject} worktrees per true repo`);
    }
    reservations.set(canonicalRepoRoot, creating + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = reservations.get(canonicalRepoRoot) || 0;
      if (cur <= 1) reservations.delete(canonicalRepoRoot);
      else reservations.set(canonicalRepoRoot, cur - 1);
    };
  }

  /**
   * 创建 worktree（argument-array git 调用，无用户输入拼 shell）。
   * @param {object} p
   * @param {string} p.projectRoot 原项目（repo 或子目录）
   * @param {string} p.runId 平台 run id
   * @param {string} [p.projectId] 仅作 metadata，不参与 storage/limit（§5）
   * @param {string} [p.baseCommit] 可选，必须可解析（§14）；缺省按 dirty/clean 自动解析（§13）
   * @param {string} [p.branch]
   */
  async function create(p = {}) {
    const { projectRoot, runId } = p;
    if (!projectRoot || !runId) throw makeError('INVALID_ARG', 'projectRoot and runId required');

    // —— §4 真实 Git root ——
    const { canonicalRepoRoot } = await resolveTrueRepoRoot(projectRoot);
    const headRes = await execGit(canonicalRepoRoot, ['rev-parse', 'HEAD']);
    if (headRes.code !== 0) throw makeError(FAIL_CODES.GIT_HEAD_MISSING, headRes.err || 'no HEAD');

    // —— §5 storage identity 只从真实 root 派生 ——
    const storageProjectId = deriveProjectId(canonicalRepoRoot);

    // —— §9 原子 reservation（同步，防并发交错）——
    const releaseReservation = _reserveSlot(canonicalRepoRoot);

    let ephemeralRef = null;
    try {
      // —— §3 ownedRoot 必须在 project parent 内且不在真实 repo 内 ——
      const projectParent = path.dirname(canonicalRepoRoot);
      const ownedRoot = _ownedRootFor(canonicalRepoRoot, storageProjectId);
      if (!isInsideCanonical(projectParent, ownedRoot) || isInsideCanonical(canonicalRepoRoot, ownedRoot)) {
        throw makeError(FAIL_CODES.OWNED_ROOT_ESCAPE, `owned root must be outside true repo: ${ownedRoot}`);
      }

      // —— §27 runId 消毒 + 唯一 worktreeId（collision fail closed）——
      const safeRun = sanitizeToken(runId);
      if (!safeRun) throw makeError(FAIL_CODES.INVALID_RUN_ID, `invalid runId: ${runId}`);
      const worktreeId = 'wt_' + safeRun;
      if (worktrees.has(worktreeId)) throw makeError(FAIL_CODES.DUPLICATE_WORKTREE_ID, `worktreeId already exists: ${worktreeId}`);

      const worktreeRoot = path.join(ownedRoot, safeRun);
      if (fs.existsSync(worktreeRoot)) throw makeError(FAIL_CODES.WORKTREE_PATH_EXISTS, `worktree path exists: ${worktreeRoot}`);

      fs.mkdirSync(ownedRoot, { recursive: true });
      const ownedCanonical = canonicalizeRoot(ownedRoot);
      const wtPredicted = path.resolve(worktreeRoot);
      if (!_isInsideOwned(ownedCanonical, wtPredicted)) {
        throw makeError(FAIL_CODES.WORKTREE_ESCAPE, `worktree escapes owned root: ${worktreeRoot}`);
      }

      // —— §27 branch 合法性 + 唯一性 ——
      const shortRun = safeRun.slice(0, 40);
      const branch = p.branch || ('adp-run-' + shortRun);
      const refFmt = await execGit(canonicalRepoRoot, ['check-ref-format', '--branch', branch]);
      if (refFmt.code !== 0) throw makeError(FAIL_CODES.INVALID_BRANCH, `invalid branch: ${branch}`);
      const branchCheck = await execGit(canonicalRepoRoot, ['rev-parse', '--verify', branch]);
      if (branchCheck.code === 0) throw makeError(FAIL_CODES.BRANCH_EXISTS, `branch already exists: ${branch}`);

      // —— §13/§14 baseCommit 解析 ——
      let baseCommit;
      if (p.baseCommit) {
        baseCommit = await validateBaseCommit(canonicalRepoRoot, p.baseCommit);
      } else {
        const st = await statusState(canonicalRepoRoot);
        if (st === GIT_STATE.CLEAN) baseCommit = headRes.out.trim();
        else { const snap = await _createEphemeralSnapshot(canonicalRepoRoot); baseCommit = snap.commit; ephemeralRef = snap.ref; }
      }

      // —— 创建 worktree ——
      const addRes = await execGit(canonicalRepoRoot, ['worktree', 'add', '-b', branch, wtPredicted, baseCommit]);
      if (addRes.code !== 0) {
        try { fs.rmdirSync(wtPredicted, { recursive: true }); } catch { /* noop */ }
        throw makeError(FAIL_CODES.WORKTREE_ADD_FAILED, addRes.err || addRes.out || 'git worktree add failed');
      }

      const rec = {
        worktreeId,
        runId,
        projectId: storageProjectId,
        callerProjectId: p.projectId || null,
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
    } finally {
      // §10/§20 失败零残留：释放 reservation；删除 ephemeral ref（branch 已持有 commit 或失败回滚）
      releaseReservation();
      if (ephemeralRef) await _deleteEphemeralRef(canonicalRepoRoot, ephemeralRef);
    }
  }

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

  function status(worktreeId) {
    const rec = worktrees.get(worktreeId);
    return rec ? recordToView(rec) : null;
  }

  function _setStatus(worktreeId, statusVal) {
    const rec = worktrees.get(worktreeId);
    if (rec) rec.status = statusVal;
  }

  /**
   * §11 完整 diff truth：temporary index + add -A + diff --cached --binary <base>。
   * 覆盖 staged/unstaged/untracked/deleted/renamed/binary/committed。真实 index 不变。
   */
  async function getDiff(worktreeId) {
    const rec = worktrees.get(worktreeId);
    if (!rec) return null;
    const tmpIndex = path.join(os.tmpdir(), `adp-wt-diff-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      const add = await execGit(rec.worktreeRoot, ['add', '-A'], { env });
      if (add.code !== 0) throw makeError(FAIL_CODES.DIFF_FAILED, add.err || 'temp index add failed');
      const diffRes = await execGit(rec.worktreeRoot, ['diff', '--cached', '--binary', '--no-ext-diff', rec.baseCommit], { env });
      if (diffRes.code !== 0) throw makeError(FAIL_CODES.DIFF_FAILED, diffRes.err || 'snapshot diff failed');
      const nameRes = await execGit(rec.worktreeRoot, ['diff', '--cached', '--name-only', '-z', rec.baseCommit], { env });
      if (nameRes.code !== 0) throw makeError(FAIL_CODES.DIFF_FAILED, nameRes.err || 'snapshot name-status failed');
      const changedFiles = String(nameRes.out || '').split('\0').map(s => s.trim()).filter(Boolean);
      const capped = capByBytes(diffRes.out || '', diffCapBytes);
      return {
        worktreeId,
        runId: rec.runId,
        branch: rec.branch,
        baseCommit: rec.baseCommit,
        headCommit: rec.baseCommit,
        changedFiles,
        diff: capped.out,
        diffBytes: capped.bytes,
        truncated: capped.truncated,
        status: rec.status
      };
    } finally {
      try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * §6/§7/§8/§17 删除/保留 worktree（fail-closed cleanup truth）。
   */
  async function remove(worktreeId, o = {}) {
    const { force = false, retainDirty = true } = o;
    const rec = worktrees.get(worktreeId);
    if (!rec) throw makeError(FAIL_CODES.WORKTREE_NOT_OWNED, `unknown worktreeId: ${worktreeId}`);

    // §17 BUSY/CREATING/REMOVING 禁止普通 cleanup
    if (rec.status === STATUS.BUSY || rec.status === STATUS.CREATING || rec.status === STATUS.REMOVING) {
      throw makeError(FAIL_CODES.WORKTREE_BUSY, `worktree is ${rec.status}; cleanup denied until quiescent`);
    }

    // §6 所有权：canonical 失败 → DENY
    if (!_isInsideOwned(rec.ownedRoot, rec.worktreeRoot)) {
      throw makeError(FAIL_CODES.WORKTREE_OUTSIDE_OWNED_ROOT, `refuse cleanup outside owned root: ${rec.worktreeRoot}`);
    }

    // §7 status 三态；ERROR 拒绝删除
    const st = await statusState(rec.worktreeRoot);
    if (st === GIT_STATE.ERROR) throw makeError(FAIL_CODES.GIT_STATUS_ERROR, `cannot confirm cleanliness: ${rec.worktreeRoot}`);
    const dirty = st === GIT_STATE.DIRTY;

    if (dirty && !force && retainDirty) {
      rec.status = STATUS.DIRTY_RETAINED;
      return { removed: false, retained: true, reason: STATUS.DIRTY_RETAINED, worktreeId };
    }

    const prevStatus = rec.status;
    rec.status = STATUS.REMOVING;
    const rmArgs = ['worktree', 'remove'];
    if (dirty && force) rmArgs.push('--force');
    rmArgs.push(rec.worktreeRoot);
    const rmRes = await execGit(rec.projectRoot, rmArgs);
    if (rmRes.code !== 0) {
      // §8 失败：绝不 removed=true，metadata 保留，不 prune/不删 branch
      rec.status = prevStatus;
      throw makeError(FAIL_CODES.WORKTREE_REMOVE_FAILED, rmRes.err || rmRes.out || 'git worktree remove failed');
    }

    // worktree 已真实移除；branch 清理诚实报告（失败不伪装整体失败）
    await execGit(rec.projectRoot, ['worktree', 'prune']);
    let branchRemoved = false;
    let branchCleanupError = null;
    if (force || !dirty) {
      const br = await execGit(rec.projectRoot, ['branch', '-D', rec.branch]);
      if (br.code === 0) branchRemoved = true;
      else branchCleanupError = (br.err || br.out || 'branch delete failed').trim();
    }
    try { if (fs.existsSync(rec.worktreeRoot)) fs.rmdirSync(rec.worktreeRoot); } catch { /* noop */ }
    try { if (fs.existsSync(rec.ownedRoot)) fs.rmdirSync(rec.ownedRoot); } catch { /* noop */ }

    worktrees.delete(worktreeId);
    return { removed: true, retained: false, worktreeId, branchRemoved, branchCleanupError };
  }

  async function cleanup(worktreeId, o) { return remove(worktreeId, o); }

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
      reservations: Array.from(reservations.entries()),
      worktrees: Array.from(worktrees.values()).map(recordToView)
    };
  }

  return {
    create, list, status, getDiff, isDirty, statusState, remove, cleanup, cleanupRun,
    isOwnedWorktree, diagnostics, prepareSharedBase, resolveTrueRepoRoot,
    MAX_WORKTREES_PER_PROJECT: maxWorktreesPerProject,
    _setStatus, _worktrees: worktrees, _reservations: reservations
  };
}

/** §16 worker context allowlist：仅纯数据 metadata，绝不透传 caller authority。 */
function sanitizeWorkerMetadata(context) {
  if (!context || typeof context !== 'object') return {};
  const allow = ['taskLabel', 'requestedCapabilities', 'parentRunId', 'traceId', 'spanId'];
  const out = {};
  for (const k of allow) {
    const v = context[k];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string');
  }
  return out;
}

/**
 * ParallelWorktreeCoordinator — 极薄协调层（maxParallel=2）。
 * §15 mutationLock 必须显式注入；缺失 → SHARED_MUTATION_LOCK_REQUIRED（绝不自建第二把锁）。
 *
 * @param {object} opts
 * @param {object} opts.mutationLock 必填：平台唯一共享 ProjectMutationLock
 * @param {object} [opts.worktreeManager]
 * @param {number} [opts.maxParallel=2]
 * @param {number} [opts.cancelQuiescenceTimeoutMs=3000]
 */
function createParallelWorktreeCoordinator(opts = {}) {
  if (!opts.mutationLock) throw makeError(FAIL_CODES.SHARED_MUTATION_LOCK_REQUIRED, 'Coordinator requires an injected shared ProjectMutationLock');
  const manager = opts.worktreeManager || createWorktreeManager(opts.managerOpts);
  const lock = opts.mutationLock;
  const maxParallel = opts.maxParallel || MAX_PARALLEL;
  const cancelQuiescenceTimeoutMs = opts.cancelQuiescenceTimeoutMs || DEFAULT_CANCEL_QUIESCENCE_TIMEOUT_MS;

  /** runId/worktreeId -> { controller, promise, worktreeId, lockReleased } */
  const active = new Map();

  async function _runOne(task, sharedBase) {
    const rec = await manager.create({ projectRoot: task.projectRoot, runId: task.runId, baseCommit: sharedBase ? sharedBase.baseCommit : undefined });
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const entry = { controller, worktreeId: rec.worktreeId, record: rec, promise: null, lockReleased: false };
    active.set(rec.worktreeId, entry);

    const acquired = lock.acquireWrite(rec.worktreeRoot, task.runId, 'parallel-coordinator');
    if (!acquired.ok) {
      active.delete(rec.worktreeId);
      throw makeError('LOCK_ACQUIRE_FAILED', `mutation lock: ${JSON.stringify(acquired.lockHolder)}`);
    }
    const releaseOnce = () => {
      if (entry.lockReleased) return; // §19 exactly-once
      entry.lockReleased = true;
      try { lock.release(task.runId); } catch { /* noop */ }
    };
    manager._setStatus(rec.worktreeId, STATUS.BUSY);
    try {
      entry.promise = task.worker({
        worktreeRoot: rec.worktreeRoot,
        projectRoot: rec.worktreeRoot, // §16 worker 只拿 worktree authority
        runId: task.runId,
        signal: controller ? controller.signal : null,
        metadata: sanitizeWorkerMetadata(task.context) // §16 不透传 caller context
      });
      const result = await entry.promise;
      const diff = await manager.getDiff(rec.worktreeId);
      manager._setStatus(rec.worktreeId, STATUS.COMPLETED);
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
      throw e;
    } finally {
      // §19 lock release 在 finally，terminal 之后，exactly-once
      releaseOnce();
      active.delete(rec.worktreeId);
    }
  }

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
   * §13 并行跑一对 task：先一次性解析 shared base（A/B 同一 baseCommit），再并发 create+run。
   */
  async function runPair(p = {}) {
    const tasks = p.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw makeError('INVALID_ARG', 'tasks required');
    if (tasks.length > maxParallel) throw makeError(FAIL_CODES.MAX_PARALLEL_EXCEEDED, `maxParallel=${maxParallel}`);
    // §13 coordinator semantic：一次解析 true root / HEAD / dirty / snapshot
    const sharedBase = await manager.prepareSharedBase(p.projectRoot, p.baseCommit);
    const enriched = tasks.map(t => ({ ...t, projectRoot: sharedBase.canonicalRepoRoot }));
    try {
      return await _mapLimit(enriched, maxParallel, t => _runOne(t, sharedBase));
    } finally {
      // §20 删除 P5 临时 snapshot ref（branch 已持有 commit）
      if (sharedBase.snapshotRef) await _deleteRefSafe(sharedBase);
    }
  }
  async function _deleteRefSafe(sharedBase) {
    try { await execGit(sharedBase.canonicalRepoRoot, ['update-ref', '-d', sharedBase.snapshotRef]); } catch { /* best effort */ }
  }

  /**
   * §18 bounded cancel：abort → 有界等待 quiescence → 按策略处理。
   * non-quiescent 不 cleanup/不释放锁/不删 active（_runOne finally 会在真正 terminal 时释放）。
   */
  async function cancel(worktreeId) {
    const a = active.get(worktreeId);
    if (a && a.controller) a.controller.abort();
    if (a && a.promise) {
      const bounded = await Promise.race([
        a.promise.then(() => true, () => true),
        new Promise(resolve => setTimeout(() => resolve(false), cancelQuiescenceTimeoutMs))
      ]);
      if (!bounded) {
        // worker 未在 deadline 前 terminal：保留 worktree/lock/active，诚实返回
        return { cancelled: false, quiesced: false, reason: FAIL_CODES.WORKER_QUIESCENCE_TIMEOUT, worktreeId };
      }
    }
    const rec = manager.status(worktreeId);
    if (!rec) return { cancelled: false, quiesced: true, reason: 'NOT_FOUND', worktreeId };
    const outcome = await manager.remove(worktreeId, { force: false, retainDirty: true });
    return { cancelled: true, quiesced: true, worktreeId, ...outcome };
  }

  async function cleanup(worktreeId, o) { return manager.remove(worktreeId, o); }
  async function cleanupRun(runId, o) { return manager.cleanupRun(runId, o); }
  function list() { return manager.list(); }
  function status(worktreeId) { return manager.status(worktreeId); }
  function getDiff(worktreeId) { return manager.getDiff(worktreeId); }
  function diagnostics() { return manager.diagnostics(); }

  return {
    runPair, cancel, cleanup, cleanupRun, list, status, getDiff, diagnostics,
    manager, MAX_PARALLEL: maxParallel
  };
}

module.exports = {
  createWorktreeManager,
  createParallelWorktreeCoordinator,
  sanitizeWorkerMetadata,
  STATUS,
  FAIL_CODES,
  GIT_STATE,
  MAX_WORKTREES_PER_PROJECT,
  MAX_PARALLEL,
  OWNED_DIR_NAME,
  parsePorcelain,
  parsePorcelainZ,
  capByBytes,
  deriveProjectId,
  sanitizeToken
};
