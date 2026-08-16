'use strict';
/**
 * v2.9.9 体验对标 Phase 5 — 真实多轮消息历史（assistant tool_use → user tool_result）。
 *
 * 之前每轮把全部 context 拼成一条新的 user message，无法利用 Anthropic prompt caching，
 * 也不是模型训练时熟悉的真实工具调用对话结构。本模块维护一个 messages 数组：
 *   第一条 user = 任务描述（目标+计划），其后每轮追加
 *   {role:'assistant', tool_calls:[...]} 与 {role:'tool', tool_call_id, content}。
 *
 * 关键不变量：tool_use 与 tool_result 必须严格配对（否则 Anthropic 报错）。
 * compactHistory 只以「完整 assistant+tool_result 组」为单位丢弃老消息，
 * 并把被丢弃部分替换成一条摘要 user 消息，绝不破坏配对关系。
 *
 * 仅对 supportsTools 的 provider 生效（adapter 内部判断）；纯文本 fallback 路径不变。
 */

/** 生成稳定 tool_call id（loop 与 history 两侧共用，保证配对）。 */
function makeToolCallId(runId, iteration, idx) {
  return `tc_${runId || 'run'}_${iteration || 0}_${idx || 0}`;
}

/** 追加 assistant 消息（含 tool_calls；无工具时仅文本）。 */
function pushAssistant(history, { text, toolCalls }) {
  const m = { role: 'assistant' };
  if (text) m.content = text;
  if (Array.isArray(toolCalls) && toolCalls.length) m.tool_calls = toolCalls;
  history.push(m);
  return m;
}

/** 追加 tool 结果消息（tool_call_id 必须与 assistant tool_calls 配对）。 */
function pushToolResult(history, toolCallId, content) {
  history.push({ role: 'tool', tool_call_id: toolCallId, content: String(content == null ? '' : content) });
}

/** 转成 provider messages：首条 user=任务描述 + 历史。 */
function toProviderMessages(history, taskDescription) {
  const out = [{ role: 'user', content: taskDescription || '' }];
  return out.concat(history);
}

/**
 * 压缩历史：保留最近 keepRecent 条消息；更早的「完整 assistant+tool_result 组」
 * 被丢弃并替换为一条摘要 user 消息。配对关系在保留区内始终成立。
 * @returns {{ history: Array, summary: string }}
 */
function compactHistory(history, keepRecent = 12) {
  if (!Array.isArray(history) || history.length <= keepRecent) return { history: history || [], summary: '' };
  const dropped = history.slice(0, history.length - keepRecent);
  const kept = history.slice(history.length - keepRecent);
  // 若保留区首条是孤立 tool（其 assistant 被丢弃），前移直到保留区以 assistant/user 开头，
  // 保证保留区内每个 tool 都有配对的 assistant tool_use。
  let start = 0;
  while (start < kept.length && kept[start].role === 'tool') start++;
  const finalKept = kept.slice(start);
  const actuallyDropped = dropped.concat(kept.slice(0, start));
  const tools = actuallyDropped.filter(m => m.role === 'tool').length;
  const summary = `[历史摘要] 已压缩 ${actuallyDropped.length} 条早期消息（含 ${tools} 条工具结果）。`;
  return { history: finalKept, summary };
}

/** 校验 role 序列合法：每个 assistant tool_use 都有后续配对 tool_result（用于测试/自检）。 */
function validatePairing(messages) {
  const pending = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) pending.add(tc.id);
    else if (m.role === 'tool') { if (!pending.has(m.tool_call_id)) return { ok: false, error: '孤立 tool_result: ' + m.tool_call_id }; pending.delete(m.tool_call_id); }
  }
  // 允许末尾 assistant 尚未有 result（本轮刚发出），但中间不允许缺 result
  return { ok: true };
}

module.exports = { makeToolCallId, pushAssistant, pushToolResult, toProviderMessages, compactHistory, validatePairing };
