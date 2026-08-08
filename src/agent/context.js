'use strict';
/**
 * Context building helpers: assemble the tool-definition list for an agent
 * (built-in + MCP + sub-agent tools), and compress long histories.
 *
 * v2.1.0 — compression produces a real SUMMARY instead of silently dropping
 * messages. The old behaviour ("前面 N 条已省略") threw away which files were
 * touched and which commands were run, so the model kept re-reading the same
 * files after every compaction.
 */
const registry = require('../tools/registry');
const { plainText } = require('../providers/content');

/**
 * @param agent agent record (has tools[], sub_agent_ids[])
 * @param opts { mcpDefs: [{name,description,input_schema}], subAgents: [{id,name,description}] }
 */
function buildToolDefs(agent, opts = {}) {
  const defs = [];
  const reg = registry.registry;
  for (const name of (agent.tools || [])) {
    const b = reg.get(name);
    if (b) defs.push({ name: b.def.name, description: b.def.description, parameters: b.def.input_schema });
  }
  for (const m of (opts.mcpDefs || [])) {
    defs.push({ name: m.name, description: m.description, parameters: m.input_schema || { type: 'object', properties: {} } });
  }
  for (const sub of (opts.subAgents || [])) {
    defs.push({
      name: 'agent_' + sub.id.replace(/-/g, '_'),
      description: `调用子 Agent「${sub.name}」：${sub.description || '专用 Agent'}。把要交给它处理的具体任务描述传给它，它会返回结构化结果。`,
      parameters: { type: 'object', properties: { task: { type: 'string', description: `交给「${sub.name}」的具体任务或问题` } }, required: ['task'] }
    });
  }
  return defs;
}

/** Map a sub-agent tool name back to its sub-agent id. */
function subAgentIdFromToolName(toolName) {
  if (!toolName.startsWith('agent_')) return null;
  return toolName.slice(6).replace(/_/g, '-');
}

const PATH_KEYS = ['path', 'file', 'file_path', 'filepath', 'target'];

function argOf(tc, keys) {
  let a = {};
  try { a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || '{}') : (tc.arguments || {}); } catch { a = {}; }
  for (const k of keys) if (a[k]) return String(a[k]);
  return null;
}

function trim(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Build a factual digest of the messages that are about to leave the window.
 * Purely local (no extra model call): fast, free, and it cannot fail mid-turn.
 *
 * @param older  the messages being dropped
 * @returns {string} summary text (always contains 「已压缩省略」 so the UI/tests
 *                   can recognise a compaction marker)
 */
function summarizeHistory(older) {
  const goals = [];
  const readFiles = new Set();
  const wroteFiles = new Set();
  const commands = [];
  const subAgents = new Set();
  const conclusions = [];
  let toolCallCount = 0;
  let failures = 0;

  for (const m of older) {
    if (m.role === 'user') {
      const t = trim(plainText(m.content), 160);
      if (t) goals.push(t);
    } else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          toolCallCount++;
          const name = tc.name || '';
          if (name.startsWith('agent_')) { subAgents.add(name); continue; }
          if (/^(terminal_run|run_command|shell)/.test(name)) {
            const cmd = argOf(tc, ['command', 'cmd']);
            if (cmd) commands.push(trim(cmd, 90));
          } else if (/write|patch|edit|create|delete|move/.test(name)) {
            const p = argOf(tc, PATH_KEYS); if (p) wroteFiles.add(p);
          } else if (/read|open|cat|search|grep|list/.test(name)) {
            const p = argOf(tc, PATH_KEYS); if (p) readFiles.add(p);
          }
        }
      }
      const txt = trim(plainText(m.content), 200);
      if (txt) conclusions.push(txt);
    } else if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? m.content : plainText(m.content);
      if (/"ok"\s*:\s*false/.test(c)) failures++;
    }
  }

  const lines = [`【历史摘要】早期 ${older.length} 条对话已压缩省略，以下是其中的事实摘要，请据此继续，不要重复已完成的步骤。`];
  if (goals.length) lines.push('· 用户目标：' + goals.slice(0, 3).join(' / '));
  if (wroteFiles.size) lines.push('· 已修改文件：' + [...wroteFiles].slice(0, 12).join('、'));
  if (readFiles.size) lines.push('· 已读取/检索：' + [...readFiles].slice(0, 12).join('、'));
  if (commands.length) lines.push('· 已执行命令：' + commands.slice(-6).join(' ; '));
  if (subAgents.size) lines.push('· 已委派子 Agent：' + [...subAgents].join('、'));
  lines.push(`· 统计：工具调用 ${toolCallCount} 次，其中失败 ${failures} 次。`);
  if (conclusions.length) lines.push('· 最近结论：' + conclusions.slice(-2).join(' | '));
  return lines.join('\n');
}

/**
 * Keep the last `window` messages verbatim, replace everything before them with
 * a summary. Returns a NEW array; the input is not mutated.
 *
 * Care is taken not to start the retained window with an orphan `tool` message
 * (a tool result whose assistant.tool_calls got cut away) — OpenAI and Anthropic
 * both reject that with a 400.
 */
function compressHistory(messages, window = 18, trigger = window + 4) {
  if (!Array.isArray(messages) || messages.length <= trigger) return messages.slice();
  let cut = messages.length - window;
  while (cut < messages.length && messages[cut].role === 'tool') cut++;
  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  return [{ role: 'system', content: summarizeHistory(older), _summary: true }, ...recent];
}

module.exports = { buildToolDefs, subAgentIdFromToolName, summarizeHistory, compressHistory };
