'use strict';
const { AGENT_EVENT } = require('../../hub/types');

/**
 * Cline SDK 事件 → 统一 AgentEvent 映射。
 */
function mapClineEvent(rawEvent, runId, agentId) {
  if (!rawEvent || !rawEvent.type) return null;

  const base = { runId, agentId, timestamp: Date.now() };

  switch (rawEvent.type) {
    case 'content_start':
      if (rawEvent.contentType === 'tool') {
        return { ...base, type: AGENT_EVENT.TOOL_STARTED, data: { toolName: rawEvent.toolName } };
      }
      return null; // text content start — not a separate event

    case 'content_update':
      if (rawEvent.contentType === 'text') {
        return { ...base, type: AGENT_EVENT.MESSAGE, data: { text: rawEvent.text, delta: true } };
      }
      return null;

    case 'usage':
      return { ...base, type: AGENT_EVENT.RUN_STATUS, data: { usage: rawEvent, status: 'running' } };

    // ACP events (from ClineAgent)
    case 'agent_message_chunk':
      return { ...base, type: AGENT_EVENT.MESSAGE, data: { text: rawEvent.text || rawEvent.chunk, delta: true } };
    case 'agent_thought_chunk':
      return { ...base, type: AGENT_EVENT.MESSAGE, data: { text: rawEvent.text || rawEvent.chunk, thought: true, delta: true } };
    case 'tool_call':
      return { ...base, type: AGENT_EVENT.TOOL_STARTED, data: { toolName: rawEvent.toolName, input: rawEvent.input } };
    case 'tool_call_update':
      return { ...base, type: AGENT_EVENT.TOOL_COMPLETED, data: { toolName: rawEvent.toolName, output: rawEvent.output } };
    case 'plan':
      return { ...base, type: AGENT_EVENT.PLAN_UPDATED, data: { plan: rawEvent.plan } };
    case 'error':
      return { ...base, type: AGENT_EVENT.RUN_FAILED, data: { error: rawEvent.error || rawEvent.message } };

    default:
      return { ...base, type: AGENT_EVENT.MESSAGE, data: { raw: rawEvent }, rawType: rawEvent.type };
  }
}

module.exports = { mapClineEvent };
