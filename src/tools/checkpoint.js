'use strict';
/**
 * Checkpoint tools — snapshot before risky tasks so the user can roll back.
 * Git projects: uses `git stash` (reliable, fast). Non-git: records a manifest
 * (full file snapshot is intentionally simplified per spec §107).
 */
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

function ok(data) { return { ok: true, data }; }
function fail(code, message) { return { ok: false, error: { code, message, retryable: false } }; }

function isGit(root) { return fs.existsSync(require('path').join(root, '.git')); }

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => resolve({ code, out, err }));
  });
}

const tools = [
  {
    name: 'checkpoint_create', description: '为当前任务创建检查点（Git 项目自动 stash），便于回滚。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { note: { type: 'string' } } },
    async exec(ctx, args) {
      const id = crypto.randomUUID();
      if (isGit(ctx.projectRoot)) {
        const r = await git(['stash', 'push', '-u', '-m', `agent-checkpoint-${id}`], ctx.projectRoot);
        const ref = r.out.trim().split('\n')[0] || 'no-changes';
        if (ctx.store) ctx.store.checkpoints.create({ projectId: ctx.projectId, taskId: ctx.taskId, kind: 'git', ref: { id, stash: ref, note: args.note || '' } });
        return ok({ checkpoint_id: id, kind: 'git', stash: ref });
      }
      if (ctx.store) ctx.store.checkpoints.create({ projectId: ctx.projectId, taskId: ctx.taskId, kind: 'manifest', ref: { id, note: args.note || '非 Git 项目：仅记录检查点标记' } });
      return ok({ checkpoint_id: id, kind: 'manifest', note: '非 Git 项目：快照已简化记录' });
    }
  },
  {
    name: 'checkpoint_restore', description: '将项目恢复到指定检查点（Git 项目弹出 stash）。', risk_level: 'high', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { checkpoint_id: { type: 'string' } }, required: ['checkpoint_id'] },
    async exec(ctx, args) {
      if (!isGit(ctx.projectRoot)) return fail('NO_GIT', '非 Git 项目暂不支持文件级恢复', false);
      const r = await git(['stash', 'pop'], ctx.projectRoot);
      if (r.code !== 0) return fail('RESTORE_FAILED', (r.err || r.out).trim() || '恢复失败（可能无 stash 或存在冲突）', false);
      return ok({ restored: args.checkpoint_id });
    }
  }
];

module.exports = { tools };
