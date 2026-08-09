'use strict';
/**
 * v2.6.0 Main Agent Runtime — Checkpoint Manager（spec §16）。
 *
 * 每次主要文件修改前建立 Checkpoint（基于 Git stash，不强制自动 commit）。
 * 至少保存：changed files / original content hash / new content hash / timestamp / runId。
 * 用户可撤销本次 Agent 修改。
 *
 * 复用现有 src/tools/checkpoint.js 的 git stash 能力与 file_changes 表，
 * 不重复造第二套 checkpoint。
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function hashContent(content) {
  if (!content) return '';
  return crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

/**
 * 创建一个 Run 级 Checkpoint。
 * @param {object} ctx runCtx（projectRoot, projectId, taskId, store, emit）
 * @param {object} opts { note, runId }
 * @returns {Promise<{ checkpointId, kind, stash? }>}
 */
async function createCheckpoint(ctx, opts = {}) {
  const id = (opts.runId || 'run') + '-' + Date.now().toString(36);
  const root = ctx.projectRoot;
  const isGit = fs.existsSync(path.join(root, '.git'));

  if (isGit) {
    // 复用 git stash（与 src/tools/checkpoint.js 一致）
    const { execGit } = require('./gitHelper');
    const ref = await execGit(root, ['stash', 'push', '-u', '-m', `agent-checkpoint-${id}`]);
    if (ctx.store && ctx.store.checkpoints) {
      try {
        ctx.store.checkpoints.create({
          projectId: ctx.projectId, taskId: ctx.taskId,
          kind: 'git', ref: { id, stash: (ref.out || '').trim().split('\n')[0], note: opts.note || '', runId: opts.runId || '' }
        });
      } catch { /* non-fatal */ }
    }
    return { checkpointId: id, kind: 'git', stash: (ref.out || '').trim().split('\n')[0] };
  }

  // 非 Git：记录 manifest（仅标记，不做全量快照）
  if (ctx.store && ctx.store.checkpoints) {
    try {
      ctx.store.checkpoints.create({
        projectId: ctx.projectId, taskId: ctx.taskId,
        kind: 'manifest', ref: { id, note: opts.note || '非 Git 项目：仅记录检查点标记', runId: opts.runId || '' }
      });
    } catch { /* non-fatal */ }
  }
  return { checkpointId: id, kind: 'manifest' };
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
  readFile, hashContent
};
