'use strict';
/**
 * v2.8.0 — ACP → 平台统一事件映射（spec §69/§109）。
 *
 * 把 ACP `session/update` 通知（判别字段 sessionUpdate）映射到平台统一
 * AGENT_EVENT（src/agents/hub/types.js）。保持 Platform 内部一致：
 * 所有外部 Agent 都归一到同一套事件，GUI 不必逐 Adapter 适配。
 *
 * ── ACP v1 SessionUpdate 真实变体（取证自 schema/v1/schema.json）────────
 *   user_message_chunk / agent_message_chunk / agent_thought_chunk → ContentChunk {content, messageId?}
 *   tool_call                → ToolCall       {toolCallId, title, kind?, status?, content?, locations?, rawInput?}
 *   tool_call_update         → ToolCallUpdate {toolCallId, kind?, status?, title?, content?, locations?, rawInput?, rawOutput?}
 *   plan                     → Plan           {entries[]}
 *   available_commands_update / current_mode_update / config_option_update
 *   session_info_update      → {title?, updatedAt?}
 *   usage_update             → {used, size, cost?}
 *
 * v1 **没有** agent_message / plan_update / state_update / terminal_* / tool_call_content_chunk，
 * 也**没有** tool call 上的 `id`/`name`/`input`（那是 v2 alpha + 早期猜测的形状）。
 * 工具调用的分类以官方 ToolKind 枚举为准，不再用工具名正则猜。
 *
 * 维护工具调用状态，以便在 Run 结束时汇总 changedFiles / usage / toolCalls。
 */

const { AGENT_EVENT } = require('../../hub/types');
const { SESSION_UPDATE, TOOL_KIND, TOOL_CALL_STATUS } = require('./constants');

/** 会写入文件的 ToolKind。 */
const WRITE_KINDS = new Set([TOOL_KIND.EDIT, TOOL_KIND.DELETE, TOOL_KIND.MOVE]);

function isExecuteKind(kind) {
  return kind === TOOL_KIND.EXECUTE;
}
function isWriteKind(kind) {
  return WRITE_KINDS.has(kind);
}

/**
 * ContentBlock → 纯文本。仅提取上游明确给出的文本，不做任何推断。
 * @param {object} block ACP ContentBlock
 * @returns {string}
 */
function contentBlockToText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return typeof block.uri === 'string' ? block.uri : (block.name || '');
    case 'resource': {
      const res = block.resource;
      if (res && typeof res.text === 'string') return res.text;
      return res && typeof res.uri === 'string' ? res.uri : '';
    }
    // image / audio 无文本表示，返回空串（调用方仍能拿到原始 block）
    default:
      return typeof block.text === 'string' ? block.text : '';
  }
}

/** 从 ToolCall/ToolCallUpdate 的 locations[] 抽路径。 */
function locationPaths(locations) {
  if (!Array.isArray(locations)) return [];
  const out = [];
  for (const loc of locations) {
    if (loc && typeof loc.path === 'string' && loc.path) out.push(loc.path);
  }
  return out;
}

/**
 * 创建 ACP 事件映射器。
 * @param {object} opts
 * @param {Function} opts.emit (type, payload) => void  —— 已归一化的事件发射（带 runId/agentId）
 */
function createAcpEventMapper({ emit } = {}) {
  const toolCalls = new Map();
  const terminals = new Set();
  const changedFiles = new Set();
  const readFiles = new Set();
  // v1 PromptResponse 只有 stopReason，没有任何文本字段；助手正文只能从
  // agent_message_chunk 流里累积（AgentResult.summary 的唯一来源）。
  const assistantChunks = [];
  let usage = null;
  let plan = null;
  let sessionInfo = null;
  let currentModeId = null;
  let availableCommands = null;
  let configOptions = null;

  function e(type, payload) {
    if (typeof emit === 'function') {
      try { emit(type, payload); } catch { /* listener must not break mapping */ }
    }
  }

  function getEntry(toolCallId) {
    let entry = toolCalls.get(toolCallId);
    if (!entry) {
      entry = {
        toolCallId,
        title: '',
        kind: TOOL_KIND.OTHER,
        status: TOOL_CALL_STATUS.PENDING,
        locations: [],
        rawInput: null,
        startedEmitted: false,
        settled: false
      };
      toolCalls.set(toolCallId, entry);
    }
    return entry;
  }

  /** 处理 ToolCallContent[]（content / diff / terminal 三个变体）。 */
  function handleToolCallContent(entry, content, base) {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      switch (item.type) {
        case 'diff': {
          if (typeof item.path === 'string' && item.path) {
            changedFiles.add(item.path);
            e(AGENT_EVENT.FILE_CHANGED, {
              ...base,
              toolId: entry.toolCallId,
              changedFiles: [item.path],
              diff: { path: item.path, oldText: item.oldText ?? null, newText: item.newText ?? null }
            });
          }
          break;
        }
        case 'terminal': {
          const tid = item.terminalId;
          if (tid && !terminals.has(tid)) {
            terminals.add(tid);
            entry.terminalId = tid;
            e(AGENT_EVENT.COMMAND_STARTED, { ...base, toolId: entry.toolCallId, terminalId: tid });
          }
          break;
        }
        case 'content': {
          const text = contentBlockToText(item.content);
          if (isExecuteKind(entry.kind) && text) {
            e(AGENT_EVENT.COMMAND_OUTPUT, { ...base, toolId: entry.toolCallId, chunk: text });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** 处理 locations[]：写类工具记 changedFiles，读类记 readFiles。 */
  function handleLocations(entry, locations, base) {
    const paths = locationPaths(locations);
    if (!paths.length) return;
    entry.locations = [...new Set([...entry.locations, ...paths])];
    if (isWriteKind(entry.kind)) {
      paths.forEach(p => changedFiles.add(p));
      e(AGENT_EVENT.FILE_CHANGED, { ...base, toolId: entry.toolCallId, changedFiles: paths });
    } else if (entry.kind === TOOL_KIND.READ) {
      paths.forEach(p => readFiles.add(p));
      e(AGENT_EVENT.FILE_READ, { ...base, toolId: entry.toolCallId, files: paths });
    }
  }

  function emitStarted(entry, base) {
    if (entry.startedEmitted) return;
    entry.startedEmitted = true;
    e(AGENT_EVENT.TOOL_STARTED, {
      ...base,
      toolId: entry.toolCallId,
      name: entry.title,
      kind: entry.kind
    });
    if (isExecuteKind(entry.kind)) {
      const cmd = (entry.rawInput && (entry.rawInput.command || entry.rawInput.cmd)) || entry.title;
      e(AGENT_EVENT.COMMAND_STARTED, { ...base, toolId: entry.toolCallId, command: cmd });
    }
  }

  function emitSettled(entry, base, rawOutput) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.status === TOOL_CALL_STATUS.COMPLETED) {
      e(AGENT_EVENT.TOOL_COMPLETED, { ...base, toolId: entry.toolCallId, name: entry.title, kind: entry.kind });
      if (isExecuteKind(entry.kind)) {
        const exitCode = rawOutput && typeof rawOutput.exitCode === 'number' ? rawOutput.exitCode : 0;
        e(AGENT_EVENT.COMMAND_COMPLETED, { ...base, toolId: entry.toolCallId, exitCode });
      }
    } else if (entry.status === TOOL_CALL_STATUS.FAILED) {
      const error = (rawOutput && (rawOutput.error || rawOutput.message)) || null;
      e(AGENT_EVENT.TOOL_FAILED, { ...base, toolId: entry.toolCallId, name: entry.title, kind: entry.kind, error });
      if (isExecuteKind(entry.kind)) {
        e(AGENT_EVENT.COMMAND_COMPLETED, { ...base, toolId: entry.toolCallId, failed: true, error });
      }
    }
  }

  /**
   * 合并 ToolCall（首报）/ ToolCallUpdate（增量）到状态机并发事件。
   * ToolCallUpdate 语义：除 toolCallId 外全部可选，只有出现的字段才更新。
   */
  function applyToolCall(update, base, isFirstReport) {
    const toolCallId = update.toolCallId;
    if (typeof toolCallId !== 'string' || !toolCallId) return;
    const entry = getEntry(toolCallId);

    if (typeof update.title === 'string') entry.title = update.title;
    if (typeof update.kind === 'string') entry.kind = update.kind;
    if (update.rawInput !== undefined && update.rawInput !== null) entry.rawInput = update.rawInput;
    if (typeof update.status === 'string') entry.status = update.status;
    else if (isFirstReport) entry.status = TOOL_CALL_STATUS.PENDING;

    // 首报或进入 in_progress 都视为"开始"（pending 表示等待审批，尚未执行）。
    if (entry.status === TOOL_CALL_STATUS.IN_PROGRESS || (isFirstReport && entry.status !== TOOL_CALL_STATUS.PENDING)) {
      emitStarted(entry, base);
    }

    handleLocations(entry, update.locations, base);
    handleToolCallContent(entry, update.content, base);

    if (entry.status === TOOL_CALL_STATUS.COMPLETED || entry.status === TOOL_CALL_STATUS.FAILED) {
      // 极短的工具调用可能直接从 pending 跳到 completed，补一个 started 保证事件成对。
      emitStarted(entry, base);
      emitSettled(entry, base, update.rawOutput);
    }
  }

  /**
   * 映射单个 sessionUpdate。
   * @param {object} update ACP SessionNotification.update 对象
   * @param {object} ctx { runId, agentId, sessionId }
   */
  function map(update, ctx = {}) {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    const { runId, agentId } = ctx;
    const base = { runId, agentId };

    switch (kind) {
      case SESSION_UPDATE.AGENT_MESSAGE_CHUNK: {
        const text = contentBlockToText(update.content);
        if (text) assistantChunks.push(text);
        e(AGENT_EVENT.MESSAGE, {
          ...base,
          role: 'assistant',
          chunk: true,
          messageId: update.messageId ?? null,
          content: update.content,
          text
        });
        break;
      }
      case SESSION_UPDATE.USER_MESSAGE_CHUNK:
        e(AGENT_EVENT.MESSAGE, {
          ...base,
          role: 'user',
          chunk: true,
          messageId: update.messageId ?? null,
          content: update.content,
          text: contentBlockToText(update.content)
        });
        break;
      // spec §46：只映射上游主动给出的 thought chunk，绝不尝试提取隐藏思维链。
      case SESSION_UPDATE.AGENT_THOUGHT_CHUNK:
        e(AGENT_EVENT.REASONING, {
          ...base,
          chunk: true,
          messageId: update.messageId ?? null,
          content: update.content,
          text: contentBlockToText(update.content)
        });
        break;
      case SESSION_UPDATE.TOOL_CALL:
        applyToolCall(update, base, true);
        break;
      case SESSION_UPDATE.TOOL_CALL_UPDATE:
        applyToolCall(update, base, false);
        break;
      case SESSION_UPDATE.PLAN:
        plan = { entries: Array.isArray(update.entries) ? update.entries : [] };
        e(AGENT_EVENT.PLAN_UPDATED, { ...base, plan });
        break;
      case SESSION_UPDATE.USAGE_UPDATE:
        usage = {
          used: typeof update.used === 'number' ? update.used : null,
          size: typeof update.size === 'number' ? update.size : null,
          cost: update.cost ?? null
        };
        break;
      case SESSION_UPDATE.SESSION_INFO_UPDATE:
        sessionInfo = { title: update.title ?? null, updatedAt: update.updatedAt ?? null };
        break;
      case SESSION_UPDATE.CURRENT_MODE_UPDATE:
        currentModeId = update.currentModeId ?? null;
        e(AGENT_EVENT.RUN_STATUS, { ...base, currentModeId });
        break;
      case SESSION_UPDATE.AVAILABLE_COMMANDS_UPDATE:
        availableCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        break;
      case SESSION_UPDATE.CONFIG_OPTION_UPDATE:
        configOptions = Array.isArray(update.configOptions) ? update.configOptions : [];
        break;
      default:
        // 未知变体：静默忽略，绝不猜测语义（上游可能新增变体）。
        break;
    }
  }

  /** 汇总 Run 结束时的产物（供 AgentResult 构造）。 */
  function finalize() {
    return {
      usage,
      assistantText: assistantChunks.join(''),
      plan,
      sessionInfo,
      currentModeId,
      availableCommands,
      configOptions,
      changedFiles: [...changedFiles],
      readFiles: [...readFiles],
      toolCalls: [...toolCalls.values()].map(t => ({
        toolCallId: t.toolCallId,
        title: t.title,
        kind: t.kind,
        status: t.status,
        locations: t.locations
      }))
    };
  }

  function getUsage() { return usage; }

  function reset() {
    toolCalls.clear();
    terminals.clear();
    changedFiles.clear();
    readFiles.clear();
    assistantChunks.length = 0;
    usage = null;
    plan = null;
    sessionInfo = null;
    currentModeId = null;
    availableCommands = null;
    configOptions = null;
  }

  return { map, finalize, getUsage, reset };
}

module.exports = {
  createAcpEventMapper,
  contentBlockToText,
  isExecuteKind,
  isWriteKind
};
