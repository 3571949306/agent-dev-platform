'use strict';
/**
 * v2.6.0 Main Agent Runtime — Context Builder（spec §21/§22）。
 *
 * 不能每一轮把整个项目塞给模型。按需构建 context：
 *   用户目标 / 当前计划 / 当前任务 / 最近工具结果 / 最近修改文件 / 当前 diff /
 *   blackboard 摘要 / 项目概览。
 *
 * Context Compaction（§22）：当 loop 很长，把老 Tool Result 压缩成 Run Summary，
 * 不无限增加 prompt。
 */

const MAX_TOOL_RESULTS = 12;       // 保留最近 N 条完整工具结果
const MAX_CHANGED_FILES = 15;
const MAX_PROJECT_SUMMARY_FILES = 40;
const DEFAULT_MAX_CONTEXT_TOKENS = 24000;

/**
 * v2.9.9 体验对标 Phase 4 — 轻量近似 token 计数（不引入 tokenizer 依赖）。
 * ASCII 按 4 字符/token，非 ASCII（中文等）按 1.5 字符/token，两者相加取上界。
 */
function approxTokens(s) {
  if (!s) return 0;
  let ascii = 0, other = 0;
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) <= 127) ascii++; else other++; }
  return Math.ceil(ascii / 4 + other / 1.5);
}

/**
 * 构建 model context。
 * @param {object} ctx {
 *   goal, plan, blackboard, currentTask,
 *   toolResults: [{ action, ok, summary, ... }],
 *   changedFiles: string[],
 *   currentDiff: string,
 *   projectSummary: string,
 *   iteration, repairRounds
 * }
 * @returns {string} 给模型的 context 文本
 */
function buildContext(ctx) {
  const maxTokens = ctx.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS;
  // —— 必须完整保留：目标 / 计划 / 当前任务 ——
  const must = [];
  must.push('# 任务');
  must.push(`用户目标：${ctx.goal || '(未指定)'}`);
  if (ctx.plan) { must.push('\n# 执行计划'); must.push(planToText(ctx.plan)); }
  if (ctx.currentTask) { must.push('\n# 当前任务'); must.push(`- ${ctx.currentTask.title}（${ctx.currentTask.status}）`); }

  // —— 可动态裁剪：最近工具结果（从最老开始丢）——
  let toolTexts = (ctx.toolResults || []).slice(-MAX_TOOL_RESULTS).map(toolResultToText);

  // —— 可压缩：项目概览 / blackboard ——
  let bbText = '';
  if (ctx.blackboard) { const { summarize } = require('./blackboard'); bbText = summarize(ctx.blackboard) || ''; }
  let projText = ctx.projectSummary || '';

  const tail = [];
  if (ctx.changedFiles && ctx.changedFiles.length) { tail.push('\n# 已修改文件'); tail.push(ctx.changedFiles.slice(-MAX_CHANGED_FILES).join(', ')); }
  if (ctx.currentDiff) { tail.push('\n# 当前未提交 Diff（摘要）'); tail.push(truncate(ctx.currentDiff, 4000)); }
  tail.push('\n# 进度'); tail.push(`迭代: ${ctx.iteration || 0}，修复轮: ${ctx.repairRounds || 0}`);

  const assemble = () => {
    const parts = must.slice();
    if (bbText) { parts.push('\n# Blackboard（共享状态）'); parts.push(bbText); }
    if (toolTexts.length) { parts.push('\n# 最近工具结果'); parts.push(...toolTexts); }
    if (projText) { parts.push('\n# 项目概览'); parts.push(projText); }
    parts.push(...tail);
    return parts.join('\n');
  };

  // Phase 4：token 预算第二道防线。优先级：目标/计划 > 工具结果 > 项目概览 > blackboard。
  let text = assemble();
  let tokens = approxTokens(text);
  while (tokens > maxTokens && toolTexts.length > 1) { toolTexts = toolTexts.slice(1); text = assemble(); tokens = approxTokens(text); }
  if (tokens > maxTokens && projText) { projText = ''; text = assemble(); tokens = approxTokens(text); }
  if (tokens > maxTokens && bbText) { bbText = ''; text = assemble(); tokens = approxTokens(text); }

  // 暴露估算 token 数（debug 观测是否经常触顶）
  if (typeof ctx.onTokens === 'function') { try { ctx.onTokens(tokens, maxTokens); } catch { /* 观测不影响主链路 */ } }
  return text;
}

function planToText(plan) {
  if (!plan || !plan.tasks || !plan.tasks.length) return '(尚无任务)';
  const icons = { pending: '○', in_progress: '●', completed: '✓', failed: '✕', cancelled: '–', skipped: '–' };
  return plan.tasks.map(t => `${icons[t.status] || '○'} ${t.title}`).join('\n');
}

function toolResultToText(r) {
  if (!r) return '';
  const status = r.ok ? '✓' : '✕';
  const tool = r.tool || r.action && r.action.type || '?';
  if (!r.ok && r.error) {
    const code = r.error.code ? `[${r.error.code}] ` : '';
    return `- ${status} ${tool}: ${code}${r.error.message || 'failed'}`;
  }
  if (r.command) {
    const errs = r.errors && r.errors.length ? `\n  错误: ${r.errors.slice(0, 3).join(' | ')}` : '';
    return `- ${status} ${tool}: \`${r.command}\` exit=${r.exitCode}${errs}`;
  }
  if (r.path) {
    const content = tool === 'read_file' && typeof r.content === 'string'
      ? `\n\`\`\`text\n${truncate(r.content, 4000)}\n\`\`\``
      : '';
    return `- ${status} ${tool}: ${r.path}${content}`;
  }
  return `- ${status} ${tool}: ${r.summary || (r.ok ? '成功' : '失败')}`;
}

/**
 * Context Compaction（§22）：把老 Tool Result 压缩成 Run Summary。
 * 保留最近 MAX_TOOL_RESULTS 条完整结果，更早的压成一行摘要。
 * @param {Array} toolResults 完整工具结果列表
 * @returns {{ recent: Array, summary: string }}
 */
function compact(toolResults) {
  if (!Array.isArray(toolResults) || toolResults.length <= MAX_TOOL_RESULTS) {
    return { recent: toolResults || [], summary: '' };
  }
  const recent = toolResults.slice(-MAX_TOOL_RESULTS);
  const old = toolResults.slice(0, -MAX_TOOL_RESULTS);
  const summary = old.map(r => {
    const tool = r.tool || (r.action && r.action.type) || '?';
    return `${r.ok ? '✓' : '✕'} ${tool}`;
  }).join(', ');
  return { recent, summary: `已压缩的早期操作: ${summary}` };
}

/**
 * Run Summary（§22）：用于 crash recovery / context 压缩时的结构化摘要。
 */
function runSummary(ctx) {
  return {
    goal: ctx.goal,
    completedTasks: (ctx.plan && ctx.plan.tasks || []).filter(t => t.status === 'completed').map(t => t.title),
    pendingTasks: (ctx.plan && ctx.plan.tasks || []).filter(t => t.status === 'pending' || t.status === 'in_progress').map(t => t.title),
    importantFiles: ctx.blackboard ? ctx.blackboard.importantFiles : [],
    currentErrors: ctx.blackboard ? ctx.blackboard.problems : [],
    decisions: [],
    latestTestStatus: ctx.blackboard ? ctx.blackboard.latestTestStatus : null
  };
}

/** 生成项目概览（目录树前两层，跳过 node_modules/.git）。 */
function projectSummary(projectRoot, listDirFn) {
  if (!listDirFn) return '';
  try {
    const items = listDirFn(projectRoot, 2);
    if (!items || !items.length) return '(空项目)';
    return items.slice(0, MAX_PROJECT_SUMMARY_FILES).join('\n');
  } catch {
    return '(无法读取项目结构)';
  }
}

function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n...[截断]';
}

module.exports = {
  buildContext, compact, runSummary, projectSummary, approxTokens,
  MAX_TOOL_RESULTS, DEFAULT_MAX_CONTEXT_TOKENS
};
