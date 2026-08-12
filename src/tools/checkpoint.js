'use strict';
/**
 * Checkpoint tools — snapshot before risky tasks so the user can roll back.
 *
 * v2.9.8 R2 — Checkpoint Truthfulness:
 *  - Git projects: NON-MUTATING object snapshot via the shared runtime engine
 *    (temporary index + write-tree + commit-tree + refs/adp-checkpoints/<id>).
 *    `git stash push` is never used; HEAD / real index / worktree / status stay
 *    byte-identical during checkpoint create.
 *  - Restore is EXACT by checkpoint_id (never "pop latest stash") and creates an
 *    emergency checkpoint first, so the pre-restore state stays recoverable.
 *  - Non-git projects: CHECKPOINT_UNSUPPORTED — no fake "snapshot created".
 */
const crypto = require('crypto');
const { snapshotGitProject, restoreGitProject, isGitRepo } = require('../agent/runtime/checkpoint');

function ok(data) { return { ok: true, data }; }
function fail(code, message) { return { ok: false, error: { code, message, retryable: false } }; }

const tools = [
  {
    name: 'checkpoint_create', description: '为当前任务创建检查点（Git 项目：非变异对象快照，不改动工作区/index/HEAD），便于回滚。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { note: { type: 'string' } } },
    async exec(ctx, args) {
      if (!isGitRepo(ctx.projectRoot)) {
        return fail('CHECKPOINT_UNSUPPORTED', '非 Git 项目：无法创建真实文件快照（不伪造 snapshot-created）');
      }
      const id = crypto.randomUUID();
      const snap = await snapshotGitProject(ctx.projectRoot, id);
      if (!snap.ok) return fail(snap.code, snap.message || '快照创建失败');
      if (ctx.store) ctx.store.checkpoints.create({ projectId: ctx.projectId, taskId: ctx.taskId, kind: 'git', ref: { id, ref: snap.ref, commit: snap.commit, note: args.note || '' } });
      return ok({ checkpoint_id: id, kind: 'git', ref: snap.ref, non_mutating: true });
    }
  },
  {
    name: 'checkpoint_restore', description: '将项目精确恢复到指定 checkpoint_id 的状态（破坏性：执行前自动创建 emergency checkpoint）。', risk_level: 'high', permission: 'git.write',
    input_schema: { type: 'object', properties: { checkpoint_id: { type: 'string' } }, required: ['checkpoint_id'] },
    async exec(ctx, args) {
      if (!isGitRepo(ctx.projectRoot)) return fail('CHECKPOINT_UNSUPPORTED', '非 Git 项目：不支持文件级恢复');
      const r = await restoreGitProject(ctx.projectRoot, args.checkpoint_id);
      if (!r.ok) return fail(r.code, r.message || '恢复失败', false);
      return ok({ restored: r.restored, emergency_checkpoint_id: r.emergencyCheckpointId });
    }
  }
];

module.exports = { tools };
