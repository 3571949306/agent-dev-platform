'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenCode 事件归一化（spec §4.3 / §17-18）。
 *
 * 把 OpenCode server 的 SSE 原生事件映射到统一 AGENT_EVENT：
 *
 *   session.updated / session.created   → agent.run.status
 *   message.updated / message_part.updated → agent.message
 *   tool_call                           → agent.tool.started
 *   tool_call.updated (done)            → agent.tool.completed
 *   session.completed                   → agent.run.completed
 *   session.aborted                     → agent.run.cancelled
 *   error                               → agent.run.failed
 *   file.changed                        → agent.file.changed
 *   command                             → agent.command.started / .completed
 *
 * 归一化后的事件形状：
 *   { type, runId, agentId, data, rawType, rawMetadata, timestamp, terminal }
 *
 * terminal=true 表示这是一个 Run 终态事件（completed / failed / cancelled），
 * 调用方据此停止等待。
 */

const { AGENT_EVENT } = require('../../hub/types');

/** 判断 tool_call / command 事件是否已完成。 */
function isCompletedPart(raw) {
  if (!raw) return false;
  if (raw.done === true || raw.completed === true || raw.finished === true) return true;
  const st = String(raw.status || raw.state || '').toLowerCase();
  return st === 'completed' || st === 'done' || st === 'success' || st === 'finished';
}

/**
 * 把 OpenCode 原生事件映射为统一 AgentEvent。
 *
 * @param {object} rawEvent OpenCode SSE 事件（已 JSON 解析）
 * @param {string} runId
 * @param {string} agentId
 * @returns {object} { type, runId, agentId, data, rawType, rawMetadata, timestamp, terminal }
 */
function mapOpenCodeEvent(rawEvent, runId, agentId) {
  const raw = rawEvent || {};
  // OpenCode 事件类型字段：type / event
  const rawType = raw.type || raw.event || 'unknown';
  const data = raw.data != null ? raw.data : (raw.payload != null ? raw.payload : raw);
  const timestamp = raw.timestamp || raw.ts || Date.now();
  // rawMetadata 保留除 data 外的诊断字段（不含口令，SSE 不下发口令）
  const rawMetadata = {};
  for (const k of Object.keys(raw)) {
    if (k === 'data' || k === 'payload' || k === 'type' || k === 'event') continue;
    rawMetadata[k] = raw[k];
  }

  let type = AGENT_EVENT.MESSAGE;
  let terminal = false;

  switch (rawType) {
    case 'server.connected':
    case 'session.created':
    case 'session.updated':
      type = AGENT_EVENT.RUN_STATUS;
      break;

    case 'message.updated':
    case 'message_part.updated':
    case 'message.created':
      type = AGENT_EVENT.MESSAGE;
      break;

    case 'tool_call':
      type = AGENT_EVENT.TOOL_STARTED;
      break;

    case 'tool_call.updated':
      // 同一事件名既可能表示开始也可能表示完成：按 done/status 区分
      type = isCompletedPart(raw) || isCompletedPart(data)
        ? AGENT_EVENT.TOOL_COMPLETED
        : AGENT_EVENT.TOOL_STARTED;
      break;

    case 'tool_call.completed':
      type = AGENT_EVENT.TOOL_COMPLETED;
      break;

    case 'tool_call.failed':
      type = AGENT_EVENT.TOOL_FAILED;
      break;

    case 'session.completed':
      type = AGENT_EVENT.RUN_COMPLETED;
      terminal = true;
      break;

    case 'session.aborted':
    case 'session.cancelled':
      type = AGENT_EVENT.RUN_CANCELLED;
      terminal = true;
      break;

    case 'error':
    case 'session.failed':
      type = AGENT_EVENT.RUN_FAILED;
      terminal = true;
      break;

    case 'file.changed':
    case 'file.updated':
      type = AGENT_EVENT.FILE_CHANGED;
      break;

    case 'file.read':
      type = AGENT_EVENT.FILE_READ;
      break;

    case 'command':
      type = isCompletedPart(raw) || isCompletedPart(data)
        ? AGENT_EVENT.COMMAND_COMPLETED
        : AGENT_EVENT.COMMAND_STARTED;
      break;

    case 'command.started':
      type = AGENT_EVENT.COMMAND_STARTED;
      break;

    case 'command.completed':
      type = AGENT_EVENT.COMMAND_COMPLETED;
      break;

    case 'test.failed':
      type = AGENT_EVENT.TEST_FAILED;
      break;

    case 'test.passed':
      type = AGENT_EVENT.TEST_PASSED;
      break;

    case 'permission.required':
    case 'permission.request':
      type = AGENT_EVENT.PERMISSION_REQUIRED;
      break;

    default:
      // 未知事件：若名称含 completed/failed/aborted 则视为终态
      if (/completed$/i.test(rawType)) { type = AGENT_EVENT.RUN_COMPLETED; terminal = true; }
      else if (/failed$/i.test(rawType)) { type = AGENT_EVENT.RUN_FAILED; terminal = true; }
      else if (/abort|cancel/i.test(rawType)) { type = AGENT_EVENT.RUN_CANCELLED; terminal = true; }
      else type = AGENT_EVENT.MESSAGE;
      break;
  }

  // 标记无法识别的事件 schema（§25：连续 N 个不可解析事件 -> PROTOCOL_ERROR）
  const recognized = !/^(server\.connected|session\.(created|updated|completed|aborted|cancelled|failed)|message\.(updated|part\.updated|created)|tool_call(\.updated|\.completed|\.failed)?|file\.(changed|updated|read)|command(\.started|\.completed)?|test\.(failed|passed)|permission\.(required|request)|error|unknown)$/i.test(rawType);
  const unrecognized = recognized && type === AGENT_EVENT.MESSAGE && !terminal;

  return { type, runId: runId || null, agentId: agentId || null, data, rawType, rawMetadata, timestamp, terminal, unrecognized };
}

module.exports = { mapOpenCodeEvent, isCompletedPart };
