'use strict';
/**
 * v2.9.8 Real Project Reliability — Checkpoint Truthfulness（R2）。
 *
 * Observable contract:
 *  - Checkpoint CREATE is NON-MUTATING: HEAD unchanged, real Git index unchanged,
 *    worktree bytes unchanged, `git status` unchanged, untracked files unchanged.
 *    Implementation: temporary GIT_INDEX_FILE + `git add -A` + `git write-tree` +
 *    `git commit-tree` + a namespaced ref `refs/adp-checkpoints/<id>`. Only
 *    additive object and ref writes happen; `git stash push` is never used.
 *  - Checkpoint RESTORE is EXACT: restore(checkpoint_id) restores that
 *    checkpoint's snapshot (never "pop latest stash"). Restore is destructive,
 *    so an emergency checkpoint is created first and the original state stays
 *    recoverable even if the restore fails halfway.
 *  - Non-Git projects get CHECKPOINT_UNSUPPORTED — no fake "snapshot created".
 *
 * trackFileChange / listChangedFiles / changedFilesSummary 保持 v2.6.0 语义不变。
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

function hashContent(content) {
  if (!content) return '';
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

function isGitRepo(root) {
  try { return root && fs.existsSync(path.join(root, '.git')); } catch { return false; }
}

function checkpointRef(id) {
  return `refs/adp-checkpoints/${id}`;
}

/**
 * 非变异快照：把当前工作区（含未跟踪、非 ignore 文件）固化成一个 Git 对象树 +
 * 命名空间 ref。不触碰 HEAD / 真实 index / 工作区字节 / git status。
 * @param {string} projectRoot
 * @param {string} id checkpoint id
 * @returns {Promise<{ok:boolean, ref?, commit?, code?, message?}>}
 */
async function snapshotGitProject(projectRoot, id) {
  const { execGit } = require('./gitHelper');
  const tmpIndex = path.join(os.tmpdir(), `adp-checkpoint-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // 1. 临时 index 里暂存全部（含 untracked 非 ignore）内容——只写 blob 对象与临时 index
    const add = await execGit(projectRoot, ['add', '-A'], { env });
    if (add.code !== 0) return { ok: false, code: 'CHECKPOINT_SNAPSHOT_FAILED', message: (add.err || '').trim() || `git add failed (${add.code})` };
    // 2. 写树（仍是纯对象写入）
    const tree = await execGit(projectRoot, ['write-tree'], { env });
    if (tree.code !== 0 || !tree.out.trim()) return { ok: false, code: 'CHECKPOINT_SNAPSHOT_FAILED', message: (tree.err || '').trim() || 'git write-tree failed' };
    const treeSha = tree.out.trim();
    // 3. commit-tree：有 HEAD 则挂为 parent（仅对象，不移动任何分支/HEAD）
    const head = await execGit(projectRoot, ['rev-parse', '--verify', 'HEAD']);
    const commitArgs = ['commit-tree', treeSha, '-m', `agent-checkpoint ${id}`];
    if (head.code === 0 && head.out.trim()) commitArgs.splice(1, 0, '-p', head.out.trim());
    const commit = await execGit(projectRoot, commitArgs);
    if (commit.code !== 0 || !commit.out.trim()) return { ok: false, code: 'CHECKPOINT_SNAPSHOT_FAILED', message: (commit.err || '').trim() || 'git commit-tree failed' };
    const commitSha = commit.out.trim();
    // 4. 命名空间 ref（不影响 HEAD / 分支 / status）——restore 用它精确定位
    const ref = checkpointRef(id);
    const updateRef = await execGit(projectRoot, ['update-ref', ref, commitSha]);
    if (updateRef.code !== 0) return { ok: false, code: 'CHECKPOINT_SNAPSHOT_FAILED', message: (updateRef.err || '').trim() || 'git update-ref failed' };
    return { ok: true, ref, commit: commitSha };
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * 精确恢复某个 checkpoint：内容 == 快照时刻状态。
 * 先创建 emergency checkpoint（原状态可恢复），再落盘。
 * @returns {Promise<{ok:boolean, restored?, emergencyCheckpointId?, code?, message?}>}
 */
async function restoreGitProject(projectRoot, checkpointId) {
  const { execGit } = require('./gitHelper');
  if (!checkpointId || typeof checkpointId !== 'string') {
    return { ok: false, code: 'CHECKPOINT_ID_REQUIRED', message: 'checkpoint_id 必填（禁止忽略 id 弹最新 stash）' };
  }
  const ref = checkpointRef(checkpointId);
  const verify = await execGit(projectRoot, ['rev-parse', '--verify', ref]);
  if (verify.code !== 0 || !verify.out.trim()) {
    return { ok: false, code: 'CHECKPOINT_NOT_FOUND', message: `检查点不存在: ${checkpointId}` };
  }
  const commitSha = verify.out.trim();

  // Restore 是破坏性动作：先固化当前状态，失败中途也能恢复原状。
  const emergencyId = `emergency-${crypto.randomUUID()}`;
  const emergency = await snapshotGitProject(projectRoot, emergencyId);
  if (!emergency.ok) {
    return { ok: false, code: 'RESTORE_ABORTED_NO_EMERGENCY', message: '无法创建 emergency checkpoint，restore 拒绝执行（fail-closed）' };
  }

  const tmpIndex = path.join(os.tmpdir(), `adp-checkpoint-restore-index-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // 1. 快照文件清单（-z：NUL 分隔，安全处理任意文件名）
    const ls = await execGit(projectRoot, ['ls-tree', '-r', '--name-only', '-z', commitSha]);
    if (ls.code !== 0) return { ok: false, code: 'RESTORE_FAILED', message: (ls.err || '').trim() || 'git ls-tree failed', emergencyCheckpointId: emergencyId };
    const snapshotFiles = new Set(ls.out.split('\0').map(s => s.trim()).filter(Boolean));

    // 2. 把快照内容写回工作区（临时 index read-tree + checkout-index）
    const readTree = await execGit(projectRoot, ['read-tree', commitSha], { env });
    if (readTree.code !== 0) return { ok: false, code: 'RESTORE_FAILED', message: (readTree.err || '').trim() || 'git read-tree failed', emergencyCheckpointId: emergencyId };
    const checkout = await execGit(projectRoot, ['checkout-index', '-a', '-f'], { env });
    if (checkout.code !== 0) return { ok: false, code: 'RESTORE_FAILED', message: (checkout.err || '').trim() || 'git checkout-index failed', emergencyCheckpointId: emergencyId };

    // 3. 删除「快照之后新增、且不在快照内」的非 ignore 文件（ignored 文件不动）
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, out);
        else out.push(path.relative(projectRoot, abs).replace(/\\/g, '/'));
      }
      return out;
    };
    for (const rel of walk(projectRoot)) {
      if (snapshotFiles.has(rel)) continue;
      const ignore = await execGit(projectRoot, ['check-ignore', '-q', '--', rel]);
      if (ignore.code === 0) continue; // ignored 文件不属于快照语义，保留
      try { await fsp.unlink(path.join(projectRoot, rel)); } catch { /* already gone */ }
    }

    // 4. 真实 index 同步为恢复后的工作区状态（restore 的正当变异）
    const resync = await execGit(projectRoot, ['add', '-A']);
    if (resync.code !== 0) return { ok: false, code: 'RESTORE_FAILED', message: (resync.err || '').trim() || 'index resync failed', emergencyCheckpointId: emergencyId };

    return { ok: true, restored: checkpointId, emergencyCheckpointId: emergencyId };
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * 创建一个 Run 级 Checkpoint（NON-MUTATING）。
 * @param {object} ctx runCtx（projectRoot, projectId, taskId, store, emit）
 * @param {object} opts { note, runId }
 * @returns {Promise<{ checkpointId, kind, ref?, unsupported?, reason? }>}
 */
async function createCheckpoint(ctx, opts = {}) {
  const id = (opts.runId || 'run') + '-' + Date.now().toString(36);
  const root = ctx.projectRoot;

  if (isGitRepo(root)) {
    const snap = await snapshotGitProject(root, id);
    if (!snap.ok) {
      // 快照失败绝不假装成功，也不允许退化为 stash（stash 会变异用户工作区）
      return { checkpointId: null, kind: 'failed', unsupported: false, reason: snap.code, message: snap.message };
    }
    if (ctx.store && ctx.store.checkpoints) {
      try {
        ctx.store.checkpoints.create({
          projectId: ctx.projectId, taskId: ctx.taskId,
          kind: 'git', ref: { id, ref: snap.ref, commit: snap.commit, note: opts.note || '', runId: opts.runId || '' }
        });
      } catch { /* non-fatal */ }
    }
    return { checkpointId: id, kind: 'git', ref: snap.ref };
  }

  // 非 Git：没有真实快照能力 → 明确 CHECKPOINT_UNSUPPORTED，不返回“快照已创建”
  if (ctx.store && ctx.store.checkpoints) {
    try {
      ctx.store.checkpoints.create({
        projectId: ctx.projectId, taskId: ctx.taskId,
        kind: 'unsupported', ref: { id, note: opts.note || '非 Git 项目：不支持真实快照', runId: opts.runId || '' }
      });
    } catch { /* non-fatal */ }
  }
  return { checkpointId: null, kind: 'unsupported', unsupported: true, reason: 'CHECKPOINT_UNSUPPORTED' };
}

/**
 * 记录一次文件修改（用于 diff viewer / completion / undo）。
 * before/after 任一可为 null（新建 / 删除）。
 *
 * 始终写入 ctx._changedFiles 内存追踪（store 可选——测试 / 轻量运行没有 store，
 * 此时 completion policy 与 changedFiles 报告仍需可用）。store 存在时额外落库。
 */
function trackFileChange(ctx, filePath, before, after, diff, runId) {
  if (!filePath) return null;
  // 内存追踪：按路径去重，保留最新 after/diff
  if (!Array.isArray(ctx._changedFiles)) ctx._changedFiles = [];
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
  const existing = ctx._changedFiles.find(f => String(f.path).replace(/\\/g, '/').toLowerCase() === norm);
  if (existing) {
    existing.after = after;
    if (diff) existing.diff = diff;
    existing.runId = runId || existing.runId;
  } else {
    ctx._changedFiles.push({ path: filePath, before, after, diff, runId: runId || '' });
  }
  if (!ctx.store || !ctx.store.fileChanges) return null;
  try {
    return ctx.store.fileChanges.create({
      projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId,
      path: filePath, before, after, diff,
      // 额外字段在 file_changes 表的扩展列（若不存在会被忽略）
      beforeHash: hashContent(before),
      afterHash: hashContent(after),
      runId: runId || ''
    });
  } catch {
    // 兼容：file_changes 表可能没有 beforeHash/afterHash/runId 列，回退到基础字段
    try {
      return ctx.store.fileChanges.create({
        projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId,
        path: filePath, before, after, diff
      });
    } catch { return null; }
  }
}

/**
 * 列出本次 Run 修改的文件。
 * 优先从 store（按 taskId 查 file_changes）；store 不存在时回退到 ctx._changedFiles 内存追踪。
 * @returns {Array<{ path, before, after, diff }>}
 */
function listChangedFiles(ctx) {
  if (ctx.store && ctx.store.fileChanges) {
    try {
      const all = ctx.store.fileChanges.list(ctx.taskId);
      if (all && all.length) return all;
    } catch { /* fall through to in-memory */ }
  }
  return Array.isArray(ctx._changedFiles) ? ctx._changedFiles.slice() : [];
}

/** 统计修改文件数（用于完成报告 + GUI diff viewer）。 */
function changedFilesSummary(ctx) {
  const files = listChangedFiles(ctx);
  const summary = {};
  for (const f of files) {
    const p = f.path;
    if (!summary[p]) summary[p] = { path: p, added: 0, removed: 0 };
    if (f.diff) {
      for (const line of String(f.diff).split(/\r?\n/)) {
        if (line.startsWith('+') && !line.startsWith('+++')) summary[p].added++;
        if (line.startsWith('-') && !line.startsWith('---')) summary[p].removed++;
      }
    }
  }
  return Object.values(summary);
}

/** 读取文件当前内容（用于 diff viewer 的 after）。 */
async function readFile(root, relPath) {
  try {
    const { guard } = require('../../security/pathguard');
    const abs = guard(root, relPath);
    return await fsp.readFile(abs, 'utf8');
  } catch { return null; }
}

module.exports = {
  createCheckpoint, trackFileChange, listChangedFiles, changedFilesSummary,
  readFile, hashContent,
  snapshotGitProject, restoreGitProject, isGitRepo, checkpointRef
};
