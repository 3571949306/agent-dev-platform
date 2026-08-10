'use strict';
/**
 * v2.8.0 — Claude SDKMessage → 平台统一 AGENT_EVENT（spec §51）。
 *
 * 一份映射同时服务两条运行时（因为二者 schema 相同）：
 *   - Claude Agent SDK：`for await (const msg of query(...))` 产出的 SDKMessage
 *   - Claude Code CLI ：`claude -p --output-format stream-json` 每行 JSON
 *
 * 事件对应关系：
 *   system/init                  → 记录 sessionId / 可用工具（不发用户可见事件）
 *   assistant.content[text]      → agent.message
 *   assistant.content[thinking]  → agent.reasoning（§46：仅官方给出的 thinking 块）
 *   assistant.content[tool_use]  → 按工具语义分流：
 *        Bash        → agent.command.started
 *        Read/Grep.. → agent.file.read
 *        Write/Edit  → agent.file.changed + changedFiles
 *        TodoWrite   → agent.plan.updated
 *        其他        → agent.tool.started
 *   user.content[tool_result]    → agent.command.completed / agent.tool.completed|failed
 *   result                       → 终态（由调用方 settle，本映射只累积用量与错误）
 *
 * 不做的事：
 *   - 不解析自然语言输出猜测意图（spec §44 精神同样适用于 Claude）
 *   - 不读取 / 记录任何凭据字段（spec §70/§127）
 */

const { AGENT_EVENT } = require('../../hub/types');
const {
  MESSAGE_TYPE, SYSTEM_SUBTYPE, RESULT_SUBTYPE, CONTENT_BLOCK,
  TOOL_KIND, classifyTool
} = require('./claudeConstants');

/** 从 tool_use.input 中提取涉及的文件路径（Claude Code 工具的公开入参）。 */
function extractPaths(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string' && input[key]) out.push(input[key]);
  }
  if (Array.isArray(input.edits)) {
    for (const ed of input.edits) {
      if (ed && typeof ed.file_path === 'string') out.push(ed.file_path);
    }
  }
  return out;
}

/**
 * 创建 Claude 事件映射器。
 * @param {object} opts
 * @param {Function} [opts.emit] (type, payload) => void
 */
function createClaudeEventMapper({ emit } = {}) {
  const changedFiles = new Set();
  const readFiles = new Set();
  const messages = [];
  const errors = [];
  let sessionId = null;
  let usage = null;
  let totalCostUsd = null;
  let numTurns = null;
  let plan = null;
  let model = null;
  let availableTools = [];
  let permissionDenials = [];

  /** toolUseId -> { name, kind, paths } —— 用于把 tool_result 关联回发起的 tool_use。 */
  const pendingTools = new Map();

  function e(type, payload) {
    if (typeof emit === 'function') {
      try { emit(type, payload); } catch { /* listener 抛错不得中断映射 */ }
    }
  }

  function mapAssistantContent(blocks, base) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case CONTENT_BLOCK.TEXT:
          if (block.text) {
            messages.push(block.text);
            e(AGENT_EVENT.MESSAGE, { ...base, role: 'assistant', content: block.text });
          }
          break;

        case CONTENT_BLOCK.THINKING:
          // §46：只透传官方 thinking 块，不做任何"隐藏推理还原"
          if (block.thinking) e(AGENT_EVENT.REASONING, { ...base, content: block.thinking });
          break;

        case CONTENT_BLOCK.REDACTED_THINKING:
          // 上游已加密屏蔽 —— 只记录发生过，不尝试解读
          e(AGENT_EVENT.REASONING, { ...base, redacted: true, content: '' });
          break;

        case CONTENT_BLOCK.TOOL_USE: {
          const name = block.name || 'unknown';
          const kind = classifyTool(name);
          const paths = extractPaths(block.input);
          pendingTools.set(block.id, { name, kind, paths });

          if (kind === TOOL_KIND.COMMAND) {
            e(AGENT_EVENT.COMMAND_STARTED, {
              ...base, itemId: block.id, command: (block.input && block.input.command) || name
            });
          } else if (kind === TOOL_KIND.FILE_READ) {
            paths.forEach(p => readFiles.add(p));
            e(AGENT_EVENT.FILE_READ, { ...base, itemId: block.id, tool: name, files: paths });
          } else if (kind === TOOL_KIND.FILE_WRITE) {
            paths.forEach(p => changedFiles.add(p));
            e(AGENT_EVENT.FILE_CHANGED, { ...base, itemId: block.id, tool: name, changedFiles: paths });
          } else if (kind === TOOL_KIND.PLAN) {
            plan = (block.input && block.input.todos) || block.input || null;
            e(AGENT_EVENT.PLAN_UPDATED, { ...base, plan });
          } else {
            e(AGENT_EVENT.TOOL_STARTED, { ...base, toolId: block.id, name });
          }
          break;
        }

        default:
          break;
      }
    }
  }

  function mapUserContent(blocks, base) {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || block.type !== CONTENT_BLOCK.TOOL_RESULT) continue;
      const info = pendingTools.get(block.tool_use_id) || { name: 'unknown', kind: TOOL_KIND.TOOL };
      const failed = block.is_error === true;

      if (info.kind === TOOL_KIND.COMMAND) {
        e(AGENT_EVENT.COMMAND_COMPLETED, {
          ...base, itemId: block.tool_use_id, command: info.name, failed
        });
        if (failed) errors.push(`命令执行失败: ${info.name}`);
      } else if (info.kind === TOOL_KIND.FILE_READ || info.kind === TOOL_KIND.FILE_WRITE || info.kind === TOOL_KIND.PLAN) {
        // 读写/计划的开始事件已足够表达语义，完成态只在失败时上报
        if (failed) {
          errors.push(`${info.name} 失败`);
          e(AGENT_EVENT.TOOL_FAILED, { ...base, toolId: block.tool_use_id, name: info.name });
        }
      } else {
        e(failed ? AGENT_EVENT.TOOL_FAILED : AGENT_EVENT.TOOL_COMPLETED, {
          ...base, toolId: block.tool_use_id, name: info.name
        });
        if (failed) errors.push(`工具执行失败: ${info.name}`);
      }
      pendingTools.delete(block.tool_use_id);
    }
  }

  /**
   * 映射一条 SDKMessage / stream-json 行。
   * @param {object} msg
   * @param {object} ctx { runId, agentId }
   * @returns {{ terminal: string|null, sessionId: string|null }}
   *          terminal ∈ 'completed' | 'failed' | null（result 消息才有）
   */
  function map(msg, ctx = {}) {
    const base = { runId: ctx.runId, agentId: ctx.agentId };
    if (!msg || typeof msg !== 'object') return { terminal: null, sessionId };

    if (msg.session_id && !sessionId) sessionId = msg.session_id;

    switch (msg.type) {
      case MESSAGE_TYPE.SYSTEM:
        if (msg.subtype === SYSTEM_SUBTYPE.INIT) {
          sessionId = msg.session_id || sessionId;
          model = msg.model || null;
          availableTools = Array.isArray(msg.tools) ? msg.tools : [];
          e(AGENT_EVENT.RUN_STATUS, { ...base, status: 'running', sessionId, model });
        } else if (msg.subtype === SYSTEM_SUBTYPE.API_RETRY) {
          e(AGENT_EVENT.RUN_STATUS, {
            ...base, status: 'retrying', attempt: msg.attempt, maxRetries: msg.max_retries
          });
        }
        return { terminal: null, sessionId };

      case MESSAGE_TYPE.ASSISTANT:
        mapAssistantContent(msg.message && msg.message.content, {
          ...base, parentToolUseId: msg.parent_tool_use_id || null
        });
        return { terminal: null, sessionId };

      case MESSAGE_TYPE.USER:
        mapUserContent(msg.message && msg.message.content, {
          ...base, parentToolUseId: msg.parent_tool_use_id || null
        });
        return { terminal: null, sessionId };

      case MESSAGE_TYPE.STREAM_EVENT: {
        // 逐 token 增量（仅当开启 includePartialMessages 时出现）
        const delta = msg.event && msg.event.delta;
        if (delta && delta.type === 'text_delta' && delta.text) {
          e(AGENT_EVENT.MESSAGE, { ...base, role: 'assistant', chunk: true, content: delta.text });
        }
        return { terminal: null, sessionId };
      }

      case MESSAGE_TYPE.RESULT: {
        sessionId = msg.session_id || sessionId;
        usage = msg.usage || null;
        totalCostUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
        numTurns = typeof msg.num_turns === 'number' ? msg.num_turns : null;
        permissionDenials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];

        const ok = msg.subtype === RESULT_SUBTYPE.SUCCESS && msg.is_error !== true;
        if (ok) {
          // success 分支才有 result 字段（错误分支是 errors: string[]）
          if (typeof msg.result === 'string' && msg.result && !messages.includes(msg.result)) {
            messages.push(msg.result);
          }
        } else {
          if (Array.isArray(msg.errors)) msg.errors.forEach(x => errors.push(String(x)));
          errors.push(`Claude 以 ${msg.subtype || 'unknown'} 结束`);
        }
        if (permissionDenials.length) {
          errors.push(`有 ${permissionDenials.length} 个操作因权限被拒绝`);
        }
        return { terminal: ok ? 'completed' : 'failed', sessionId };
      }

      default:
        return { terminal: null, sessionId };
    }
  }

  function finalize() {
    return {
      sessionId,
      summary: messages.join('\n').trim(),
      changedFiles: [...changedFiles],
      readFiles: [...readFiles],
      plan,
      usage,
      totalCostUsd,
      numTurns,
      model,
      availableTools,
      permissionDenials,
      errors: [...errors]
    };
  }

  return { map, finalize, _pendingTools: pendingTools };
}

module.exports = { createClaudeEventMapper, extractPaths };
