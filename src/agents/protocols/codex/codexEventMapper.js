'use strict';
/**
 * v2.8.0 — Codex → 平台统一事件映射（spec §45/§46/§47/§51）。
 *
 * Codex 有两套 **不同** 的结构化 schema，本文件把它们都归一到同一套 AGENT_EVENT：
 *
 *   A) App Server 通知（primary）
 *      判别值 camelCase：agentMessage / reasoning / commandExecution / fileChange ...
 *      来源：codex-rs/app-server-protocol/src/protocol/v2/item.rs:222-226
 *            （`#[serde(tag="type", rename_all="camelCase")]`）
 *
 *   B) `codex exec --json` 的 ThreadEvent（fallback）
 *      判别值 snake_case：agent_message / command_execution / file_change ...
 *      来源：codex-rs/exec/src/exec_events.rs:9-37 / 105-133
 *
 * 两套 schema 的 item 语义相同但**命名风格不同**，混用会静默丢事件，
 * 所以这里显式分成两个 mapper，共享同一份状态累积逻辑。
 *
 * spec §46：reasoning 只透传上游主动给出的 summary/content，不尝试提取隐藏思维链。
 * spec §47：file change → agent.file.changed + AgentResult.changedFiles / diff。
 */

const { AGENT_EVENT } = require('../../hub/types');
const { ITEM_TYPE, EXEC_ITEM_TYPE, EXEC_EVENT, NOTIFICATION, TURN_STATUS } = require('./appServerConstants');

/** 共享的累积状态：Run 结束时汇总成 AgentResult 的 changedFiles / diff / usage。 */
function createAccumulator() {
  const changedFiles = new Set();
  const messages = [];
  const errors = [];
  let diff = '';
  let usage = null;
  let plan = null;

  return {
    changedFiles, messages, errors,
    getDiff: () => diff,
    setDiff: (d) => { diff = d || ''; },
    getUsage: () => usage,
    setUsage: (u) => { usage = u || null; },
    getPlan: () => plan,
    setPlan: (p) => { plan = p; },
    finalize() {
      return {
        changedFiles: [...changedFiles],
        diff,
        usage,
        plan,
        summary: messages.join('\n').trim(),
        errors: [...errors]
      };
    }
  };
}

/**
 * A) App Server 事件映射器。
 * @param {object} opts
 * @param {Function} opts.emit (type, payload) => void
 */
function createCodexAppServerEventMapper({ emit } = {}) {
  const acc = createAccumulator();
  const commands = new Map(); // itemId -> { command }

  function e(type, payload) {
    if (typeof emit === 'function') {
      try { emit(type, payload); } catch { /* listener 抛错不得中断映射 */ }
    }
  }

  /** 映射一个 ThreadItem（item/started 与 item/completed 共用）。 */
  function mapItem(item, phase, base) {
    if (!item || typeof item !== 'object') return;
    switch (item.type) {
      case ITEM_TYPE.AGENT_MESSAGE:
        if (phase === 'completed' && item.text) {
          acc.messages.push(item.text);
          e(AGENT_EVENT.MESSAGE, { ...base, role: 'assistant', messageId: item.id, content: item.text });
        }
        break;

      case ITEM_TYPE.REASONING: {
        // §46：只用官方 summary/content，不做任何"内部推理还原"
        if (phase !== 'completed') break;
        const text = []
          .concat(Array.isArray(item.summary) ? item.summary : [])
          .concat(Array.isArray(item.content) ? item.content : [])
          .filter(Boolean)
          .join('\n');
        if (text) e(AGENT_EVENT.REASONING, { ...base, messageId: item.id, content: text });
        break;
      }

      case ITEM_TYPE.COMMAND_EXECUTION: {
        if (phase === 'started') {
          commands.set(item.id, { command: item.command });
          e(AGENT_EVENT.COMMAND_STARTED, { ...base, itemId: item.id, command: item.command, cwd: item.cwd });
        } else {
          const failed = item.status === 'failed' || item.status === 'declined';
          e(AGENT_EVENT.COMMAND_COMPLETED, {
            ...base, itemId: item.id,
            command: item.command || (commands.get(item.id) || {}).command,
            exitCode: item.exitCode != null ? item.exitCode : undefined,
            failed
          });
          if (failed) acc.errors.push(`命令执行${item.status === 'declined' ? '被拒绝' : '失败'}: ${item.command || item.id}`);
          commands.delete(item.id);
        }
        break;
      }

      case ITEM_TYPE.FILE_CHANGE: {
        // §47：changes: Vec<FileUpdateChange { path, kind, diff }>（v2/item.rs:1056-1060）
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map(c => c && c.path).filter(Boolean);
        paths.forEach(p => acc.changedFiles.add(p));
        if (paths.length) {
          e(AGENT_EVENT.FILE_CHANGED, { ...base, itemId: item.id, changedFiles: paths, status: item.status });
        }
        break;
      }

      case ITEM_TYPE.MCP_TOOL_CALL:
        if (phase === 'started') {
          e(AGENT_EVENT.TOOL_STARTED, { ...base, toolId: item.id, name: `${item.server}/${item.tool}` });
        } else {
          const ok = item.status === 'completed' || item.status === 'success';
          e(ok ? AGENT_EVENT.TOOL_COMPLETED : AGENT_EVENT.TOOL_FAILED,
            { ...base, toolId: item.id, name: `${item.server}/${item.tool}` });
        }
        break;

      case ITEM_TYPE.WEB_SEARCH:
        if (phase === 'started') e(AGENT_EVENT.TOOL_STARTED, { ...base, toolId: item.id, name: 'web_search' });
        else e(AGENT_EVENT.TOOL_COMPLETED, { ...base, toolId: item.id, name: 'web_search' });
        break;

      case ITEM_TYPE.TODO_LIST:
        if (phase === 'completed') {
          acc.setPlan(item.items || item);
          e(AGENT_EVENT.PLAN_UPDATED, { ...base, plan: item.items || item });
        }
        break;

      case ITEM_TYPE.ERROR:
        if (item.message) acc.errors.push(String(item.message));
        break;

      default:
        break;
    }
  }

  /**
   * 映射一条 App Server 通知。
   * @param {string} method 通知方法名
   * @param {object} params 通知参数
   * @param {object} ctx { runId, agentId }
   */
  function map(method, params, ctx = {}) {
    const base = { runId: ctx.runId, agentId: ctx.agentId };
    const p = params || {};

    switch (method) {
      case NOTIFICATION.AGENT_MESSAGE_DELTA:
        // item/agentMessage/delta { threadId, turnId, itemId, delta }（v2/item.rs:1341-1346）
        e(AGENT_EVENT.MESSAGE, { ...base, role: 'assistant', messageId: p.itemId, chunk: true, content: p.delta });
        break;

      case NOTIFICATION.COMMAND_OUTPUT_DELTA:
        e(AGENT_EVENT.COMMAND_OUTPUT, { ...base, itemId: p.itemId, chunk: p.delta || p.chunk });
        break;

      case NOTIFICATION.TURN_PLAN_UPDATED:
        // { threadId, turnId, explanation, plan: [{ step, status }] }（v2/turn.rs:426-431）
        acc.setPlan(p.plan);
        e(AGENT_EVENT.PLAN_UPDATED, { ...base, plan: p.plan, explanation: p.explanation });
        break;

      case NOTIFICATION.TURN_DIFF_UPDATED:
        // { threadId, turnId, diff }（v2/turn.rs:417-421）—— 累积的 turn 级 unified diff
        acc.setDiff(p.diff);
        break;

      case NOTIFICATION.ITEM_STARTED:
        mapItem(p.item, 'started', base);
        break;

      case NOTIFICATION.ITEM_COMPLETED:
        mapItem(p.item, 'completed', base);
        break;

      case NOTIFICATION.TURN_COMPLETED: {
        const turn = p.turn || {};
        if (turn.usage) acc.setUsage(turn.usage);
        e(AGENT_EVENT.RUN_STATUS, { ...base, status: turn.status || TURN_STATUS.COMPLETED });
        break;
      }

      case NOTIFICATION.TURN_STARTED:
        e(AGENT_EVENT.RUN_STATUS, { ...base, status: TURN_STATUS.IN_PROGRESS });
        break;

      default:
        break;
    }
  }

  return { map, mapItem, finalize: () => acc.finalize(), _acc: acc };
}

/**
 * B) `codex exec --json` ThreadEvent 映射器（fallback 路径）。
 * 判别值是 snake_case，与 App Server 不同 —— 见文件头说明。
 */
function createCodexExecEventMapper({ emit } = {}) {
  const acc = createAccumulator();

  function e(type, payload) {
    if (typeof emit === 'function') {
      try { emit(type, payload); } catch { /* noop */ }
    }
  }

  function mapItem(item, phase, base) {
    if (!item || typeof item !== 'object') return;
    switch (item.item_type || item.type) {
      case EXEC_ITEM_TYPE.AGENT_MESSAGE:
        if (phase === 'completed' && item.text) {
          acc.messages.push(item.text);
          e(AGENT_EVENT.MESSAGE, { ...base, role: 'assistant', messageId: item.id, content: item.text });
        }
        break;
      case EXEC_ITEM_TYPE.REASONING:
        if (phase === 'completed' && item.text) {
          e(AGENT_EVENT.REASONING, { ...base, messageId: item.id, content: item.text });
        }
        break;
      case EXEC_ITEM_TYPE.COMMAND_EXECUTION:
        if (phase === 'started') {
          e(AGENT_EVENT.COMMAND_STARTED, { ...base, itemId: item.id, command: item.command });
        } else if (phase === 'completed') {
          const failed = item.status === 'failed';
          e(AGENT_EVENT.COMMAND_COMPLETED, { ...base, itemId: item.id, command: item.command, exitCode: item.exit_code, failed });
          if (failed) acc.errors.push(`命令执行失败: ${item.command || item.id}`);
        }
        break;
      case EXEC_ITEM_TYPE.FILE_CHANGE: {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map(c => c && (c.path || c.file)).filter(Boolean);
        paths.forEach(p => acc.changedFiles.add(p));
        if (paths.length) e(AGENT_EVENT.FILE_CHANGED, { ...base, itemId: item.id, changedFiles: paths, status: item.status });
        break;
      }
      case EXEC_ITEM_TYPE.MCP_TOOL_CALL:
        if (phase === 'started') e(AGENT_EVENT.TOOL_STARTED, { ...base, toolId: item.id, name: `${item.server}/${item.tool}` });
        else if (phase === 'completed') {
          e(item.status === 'failed' ? AGENT_EVENT.TOOL_FAILED : AGENT_EVENT.TOOL_COMPLETED,
            { ...base, toolId: item.id, name: `${item.server}/${item.tool}` });
        }
        break;
      case EXEC_ITEM_TYPE.WEB_SEARCH:
        if (phase === 'completed') e(AGENT_EVENT.TOOL_COMPLETED, { ...base, toolId: item.id, name: 'web_search', query: item.query });
        break;
      case EXEC_ITEM_TYPE.TODO_LIST:
        if (phase === 'completed') {
          acc.setPlan(item.items || item);
          e(AGENT_EVENT.PLAN_UPDATED, { ...base, plan: item.items || item });
        }
        break;
      case EXEC_ITEM_TYPE.ERROR:
        if (item.message) acc.errors.push(String(item.message));
        break;
      default:
        break;
    }
  }

  /**
   * 映射一条 ThreadEvent。
   * @param {object} evt 已解析的 JSON 事件（含 type 字段）
   * @param {object} ctx { runId, agentId }
   * @returns {{ terminal: string|null, threadId: string|null }} 终态提示（供适配器判定 Run 结束）
   */
  function map(evt, ctx = {}) {
    const base = { runId: ctx.runId, agentId: ctx.agentId };
    if (!evt || typeof evt !== 'object') return { terminal: null, threadId: null };

    switch (evt.type) {
      case EXEC_EVENT.THREAD_STARTED:
        return { terminal: null, threadId: evt.thread_id || null };
      case EXEC_EVENT.TURN_STARTED:
        e(AGENT_EVENT.RUN_STATUS, { ...base, status: 'running' });
        return { terminal: null, threadId: null };
      case EXEC_EVENT.ITEM_STARTED:
        mapItem(evt.item, 'started', base);
        return { terminal: null, threadId: null };
      case EXEC_EVENT.ITEM_UPDATED:
        mapItem(evt.item, 'updated', base);
        return { terminal: null, threadId: null };
      case EXEC_EVENT.ITEM_COMPLETED:
        mapItem(evt.item, 'completed', base);
        return { terminal: null, threadId: null };
      case EXEC_EVENT.TURN_COMPLETED:
        if (evt.usage) acc.setUsage(evt.usage);
        return { terminal: 'completed', threadId: null };
      case EXEC_EVENT.TURN_FAILED:
        if (evt.error && evt.error.message) acc.errors.push(String(evt.error.message));
        return { terminal: 'failed', threadId: null };
      case EXEC_EVENT.ERROR:
        if (evt.message) acc.errors.push(String(evt.message));
        return { terminal: 'failed', threadId: null };
      default:
        return { terminal: null, threadId: null };
    }
  }

  return { map, mapItem, finalize: () => acc.finalize(), _acc: acc };
}

module.exports = {
  createCodexAppServerEventMapper,
  createCodexExecEventMapper,
  createAccumulator
};
