'use strict';
/**
 * Patch tools — apply_patch (unified diff) + diff() helper.
 * Failures return precise location info so the Agent can re-read and retry.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const pathSecurityMod = require('../security/pathSecurity');
const { PathSecurityError, CODE } = pathSecurityMod;

/** 获取 ctx 的 PathSecurity 实例（per-run cache 或 default）。 */
function psOf(ctx) {
  return (ctx && ctx.pathSecurity) || pathSecurityMod;
}

/** Canonical guard：返回 canonical-verified 绝对路径，不在 root 内则抛 PathSecurityError。 */
function guardCanonical(ctx, inputPath) {
  const ps = psOf(ctx);
  const r = ps.checkPathContainment(ctx.projectRoot, inputPath);
  if (!r.allowed) {
    throw new PathSecurityError(r.errorCode || CODE.OUTSIDE_ROOT, r.reason || '路径不在项目根目录内');
  }
  return r.canonicalTarget || path.resolve(ctx.projectRoot, inputPath);
}

/** §66 execution-time recheck before mutation. */
function recheckMutationTarget(ctx, inputPath) {
  guardCanonical(ctx, inputPath);
}

/** 向后兼容 pathguard PATH_OUTSIDE_WORKSPACE 码（§119 不破坏现有测试）。 */
function compatCode(code) {
  if (code === CODE.OUTSIDE_ROOT || code === CODE.REPARSE_ESCAPE || code === CODE.TAIL_ESCAPE) {
    return 'PATH_OUTSIDE_WORKSPACE';
  }
  return code;
}

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

function applyToLines(lines, patchText, meta) {
  const hunks = parseHunks(patchText);
  if (!hunks.length) throw new Error('未找到有效 hunk（@@ ... @@）');
  const result = [];
  let li = 0; // 0-based index into lines（已消费到此处）
  for (const hunk of hunks) {
    const match = applyHunk(lines, hunk, li);
    // v2.9.9 Phase 6：记录是否走了空白容忍匹配（供上层质量监控埋点）
    if (meta && match.whitespaceFuzzy) meta.whitespaceFuzzy = true;
    // match.consumedBefore：hunk 之前应原样保留的行数（可能 != oldStart-1，fuzz 时）
    while (li < match.startIdx) { result.push(lines[li]); li++; }
    for (const out of match.applied) result.push(out);
    li = match.startIdx + match.consumed; // 跳过被 hunk 消费的旧行
  }
  while (li < lines.length) { result.push(lines[li]); li++; }
  return result;
}

/**
 * 在 lines 中应用一个 hunk。
 * 1. 先按 hunk 声明的 oldStart 严格匹配；
 * 2. 若失败，做模糊搜索：在剩余文件中找到第一处 context+deletion 全部匹配的位置。
 *    （LLM 经常把行号写错，coding agent 必须容忍。）
 * 3. 模糊也失败时，抛出按声明位置生成的精确错误（保留行号便于 Agent 重读重试）。
 *
 * @returns {{ startIdx, applied: string[], consumed: number }}
 *   startIdx  — 实际匹配到的 0-based 起始行
 *   applied   — 该 hunk 产生的新行（含 context 与 + 行）
 *   consumed  — 该 hunk 消费的旧行数（context + - 行数）
 */
function applyHunk(lines, hunk, fromIdx) {
  const declaredStart = Math.max(0, (hunk.oldStart || 1) - 1);
  // 1. 严格按声明位置尝试
  const strict = tryHunkAt(lines, hunk, declaredStart);
  if (strict) return strict;
  // 2. 模糊搜索：从 fromIdx 起扫描整个文件，找第一处能完整匹配的位置
  for (let i = fromIdx; i <= lines.length; i++) {
    const m = tryHunkAt(lines, hunk, i);
    if (m) return m;
  }
  // 3. v2.9.9 Phase 6 — 空白容忍：忽略首尾空白后再比较（LLM 最常见失败是缩进差异）。
  //    命中时使用文件实际行（保留原缩进），并标记 whitespaceFuzzy。
  for (let i = fromIdx; i <= lines.length; i++) {
    const m = tryHunkAtTrim(lines, hunk, i);
    if (m) return m;
  }
  // 4. 全部失败：按声明位置生成精确错误，并统一说明已尝试三级匹配（帮助模型判断重读/换策略）
  const err = strictApplyError(lines, hunk, declaredStart);
  if (!/空白容忍匹配/.test(err.message)) {
    err.message += '（已尝试精确匹配、全文件扫描匹配、空白容忍匹配均未成功；请重新读取文件确认当前内容后再 patch）';
  }
  throw err;
}

/** 按声明位置逐 op 校验，返回精确的「不匹配」错误（用于 fuzzy 也失败时抛出）。 */
function strictApplyError(lines, hunk, startIdx) {
  let li = startIdx;
  for (const op of hunk.ops) {
    if (op.type === ' ') {
      if (li >= lines.length) return new Error(`上下文不匹配：第 ${startIdx + 1} 行之后已无内容（可能文件已变化）`);
      if (lines[li] !== op.text) return new Error(`上下文不匹配（行 ${li + 1}）：期望「${op.text.slice(0, 40)}」实际「${lines[li].slice(0, 40)}」`);
      li++;
    } else if (op.type === '-') {
      if (li >= lines.length) return new Error(`删除失败：第 ${li + 1} 行不存在`);
      if (lines[li] !== op.text) return new Error(`删除内容不匹配（行 ${li + 1}）：期望「${op.text.slice(0, 40)}」实际「${lines[li].slice(0, 40)}」`);
      li++;
    }
  }
  return new Error('上下文不匹配（已尝试精确匹配、全文件扫描匹配、空白容忍匹配均未成功；请重新读取文件确认当前内容后再 patch）');
}

/**
 * v2.9.9 Phase 6 — 空白容忍匹配：比较时忽略首尾空白（line.trim()===op.text.trim()）。
 * 命中时 context/删除行使用文件中的实际行（保留原有缩进），不破坏代码风格。
 * 成功返回 {startIdx,applied,consumed,whitespaceFuzzy:true}，失败返回 null。
 * 注意：只做空白容忍这一个精确增量，不做语义/AST 级匹配。
 */
function tryHunkAtTrim(lines, hunk, startIdx) {
  if (startIdx < 0) return null;
  const applied = [];
  let li = startIdx;
  let consumed = 0;
  let fuzzy = false;
  for (const op of hunk.ops) {
    if (op.type === ' ' || op.type === '-') {
      if (li >= lines.length) return null;
      const a = lines[li].trim(), b = op.text.trim();
      if (a !== b) return null;
      if (lines[li] !== op.text) fuzzy = true; // 仅空白差异
      if (op.type === ' ') applied.push(lines[li]); // 保留文件实际行
      li++; consumed++;
    } else if (op.type === '+') {
      applied.push(op.text);
    }
  }
  return { startIdx, applied, consumed, whitespaceFuzzy: fuzzy };
}

/** 尝试在 lines[startIdx] 处应用 hunk；成功返回 {startIdx,applied,consumed}，失败返回 null。 */
function tryHunkAt(lines, hunk, startIdx) {
  if (startIdx < 0) return null;
  const applied = [];
  let li = startIdx;
  let consumed = 0;
  for (const op of hunk.ops) {
    if (op.type === ' ') {
      if (li >= lines.length) return null;
      if (lines[li] !== op.text) return null;
      applied.push(lines[li]); li++; consumed++;
    } else if (op.type === '-') {
      if (li >= lines.length) return null;
      if (lines[li] !== op.text) return null;
      li++; consumed++;
    } else if (op.type === '+') {
      applied.push(op.text);
    }
  }
  return { startIdx, applied, consumed };
}

const tools = [
  {
    name: 'apply_patch', description: '用统一 diff（@@ -a,b +c,d @@）修改文件，比整文件覆盖更安全。失败会返回精确位置以便重试。', risk_level: 'high', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径（相对项目根）' }, patch: { type: 'string', description: '统一 diff 文本' }, expected_sha256: { type: 'string', description: '可选：基于本 run 真实读取的观察哈希，不一致则拒绝写入' }, record_change: { type: 'boolean', default: true } }, required: ['path', 'patch'] },
    async exec(ctx, args) {
      try {
        const { atomicWriteFile, observeFile, checkStaleWrite } = require('./filesystem');
        const abs = guardCanonical(ctx, args.path);
        let before = null;
        if (fs.existsSync(abs)) before = await fsp.readFile(abs, 'utf8');
        // v2.9.8 R3：已有文件的 stale-write 保护（外部并发修改 → fail-closed）
        if (before !== null) {
          const stale = checkStaleWrite(ctx, abs, before, args.expected_sha256);
          if (!stale.ok) return stale;
        }
        const beforeLines = (before || '').split(/\r?\n/);
        let newLines;
        const patchMeta = {};
        try { newLines = applyToLines(beforeLines, args.patch, patchMeta); }
        catch (e) { return fail('PATCH_FAILED', e.message, true); }
        const after = newLines.join('\n');
        // v2.9.9 Phase 6：空白容忍匹配成功时向上层暴露标记（质量监控埋点）
        if (patchMeta.whitespaceFuzzy && ctx.emit) {
          try { ctx.emit('timeline', { entry: { type: 'edit', label: `空白容忍匹配应用 ${args.path}` } }); } catch { /* noop */ }
        }
        // §66 execution-time recheck immediately before mutation
        recheckMutationTarget(ctx, args.path);
        // v2.9.8 R3：原子替换（同目录 temp → rename），失败不留下半个文件
        await atomicWriteFile(ctx, abs, after);
        observeFile(ctx, abs, after);
        if (args.record_change !== false && ctx.store) {
          const d = diff(before || '', after);
          ctx.store.fileChanges.create({ projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId, path: args.path, before, after, diff: d });
          if (ctx.emit) ctx.emit('file_changed', { path: args.path, diff: d, taskId: ctx.taskId });
        }
        return ok({ applied: args.path, added: newLines.length - beforeLines.length, whitespaceFuzzy: !!patchMeta.whitespaceFuzzy });
      } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('PATCH_FAILED', e.message, true); }
    }
  }
];

module.exports = { tools, diff, applyToLines, parseHunks, applyHunk, tryHunkAt };
