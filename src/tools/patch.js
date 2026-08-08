'use strict';
/**
 * Patch tools — apply_patch (unified diff) + diff() helper.
 * Failures return precise location info so the Agent can re-read and retry.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { guard, PathGuardError } = require('../security/pathguard');

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = true) { return { ok: false, error: { code, message, retryable } }; }

// ---------- diff generator (LCS line diff -> unified diff) ----------
function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp;
}
function diff(oldStr, newStr) {
  const a = oldStr.split(/\r?\n/);
  const b = newStr.split(/\r?\n/);
  const dp = lcs(a, b);
  const out = [];
  let i = 0, j = 0;
  const ops = [];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < a.length) { ops.push(['-', a[i]]); i++; }
  while (j < b.length) { ops.push(['+', b[j]]); j++; }
  // build unified hunk
  let oldStart = 1, newStart = 1, oldCount = 0, newCount = 0;
  const body = [];
  for (const [t, line] of ops) {
    if (t === ' ') { oldCount++; newCount++; body.push(' ' + line); }
    else if (t === '-') { oldCount++; body.push('-' + line); }
    else { newCount++; body.push('+' + line); }
  }
  out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  out.push(...body);
  return out.join('\n');
}

// ---------- apply unified diff to a lines array ----------
function parseHunks(patchText) {
  const lines = patchText.split(/\r?\n/);
  const hunks = [];
  let cur = null;
  for (const raw of lines) {
    const h = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      cur = { oldStart: parseInt(h[1], 10), oldCount: parseInt(h[2] || '1', 10), newStart: parseInt(h[3], 10), newCount: parseInt(h[4] || '1', 10), ops: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith(' ')) cur.ops.push({ type: ' ', text: raw.slice(1) });
    else if (raw.startsWith('-')) cur.ops.push({ type: '-', text: raw.slice(1) });
    else if (raw.startsWith('+')) cur.ops.push({ type: '+', text: raw.slice(1) });
  }
  return hunks;
}

function applyToLines(lines, patchText) {
  const hunks = parseHunks(patchText);
  if (!hunks.length) throw new Error('未找到有效 hunk（@@ ... @@）');
  const result = [];
  let li = 0; // 0-based index into lines
  for (const hunk of hunks) {
    // advance to hunk.oldStart (1-based)
    while (li < hunk.oldStart - 1) { result.push(lines[li]); li++; }
    for (const op of hunk.ops) {
      if (op.type === ' ') {
        if (li >= lines.length) throw new Error(`上下文不匹配：第 ${hunk.oldStart} 行之后已无内容（可能文件已变化）`);
        if (lines[li] !== op.text) {
          throw new Error(`上下文不匹配（行 ${li + 1}）：期望「${op.text.slice(0, 40)}」实际「${lines[li].slice(0, 40)}」`);
        }
        result.push(lines[li]); li++;
      } else if (op.type === '-') {
        if (li >= lines.length) throw new Error(`删除失败：第 ${li + 1} 行不存在`);
        if (lines[li] !== op.text) {
          throw new Error(`删除内容不匹配（行 ${li + 1}）：期望「${op.text.slice(0, 40)}」实际「${lines[li].slice(0, 40)}」`);
        }
        li++;
      } else if (op.type === '+') {
        result.push(op.text);
      }
    }
  }
  while (li < lines.length) { result.push(lines[li]); li++; }
  return result;
}

const tools = [
  {
    name: 'apply_patch', description: '用统一 diff（@@ -a,b +c,d @@）修改文件，比整文件覆盖更安全。失败会返回精确位置以便重试。', risk_level: 'high', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径（相对项目根）' }, patch: { type: 'string', description: '统一 diff 文本' }, record_change: { type: 'boolean', default: true } }, required: ['path', 'patch'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        let before = null;
        if (fs.existsSync(abs)) before = await fsp.readFile(abs, 'utf8');
        const beforeLines = (before || '').split(/\r?\n/);
        let newLines;
        try { newLines = applyToLines(beforeLines, args.patch); }
        catch (e) { return fail('PATCH_FAILED', e.message, true); }
        const after = newLines.join('\n');
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, after, 'utf8');
        if (args.record_change !== false && ctx.store) {
          const d = diff(before || '', after);
          ctx.store.fileChanges.create({ projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId, path: args.path, before, after, diff: d });
          if (ctx.emit) ctx.emit('file_changed', { path: args.path, diff: d, taskId: ctx.taskId });
        }
        return ok({ applied: args.path, added: newLines.length - beforeLines.length });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('PATCH_FAILED', e.message, true); }
    }
  }
];

module.exports = { tools, diff, applyToLines, parseHunks };
