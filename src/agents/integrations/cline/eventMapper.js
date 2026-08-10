'use strict';

const { AGENT_EVENT } = require('../../hub/types');
const { stripSecrets } = require('../../runtime/resultSanitizer');

const READ_TOOLS = new Set(['read_files', 'search_codebase']);
const WRITE_TOOLS = new Set(['editor', 'apply_patch']);
const COMMAND_TOOLS = new Set(['run_commands']);

function unwrapCoreEvent(rawEvent) {
  if (rawEvent?.type === 'agent_event') return rawEvent.payload?.event || null;
  return rawEvent || null;
}

function cleanError(value) {
  if (!value) return 'Cline reported an error';
  if (typeof value === 'string') return value;
  return value.message || String(value);
}

/** Map one official ClineCore/AgentEvent to zero or more platform events. */
function mapClineEvents(rawEvent, runId, agentId) {
  const event = unwrapCoreEvent(rawEvent);
  if (!event || !event.type) return [];
  const base = { runId, agentId, timestamp: Date.now() };

  if (rawEvent?.type === 'status') {
    return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: rawEvent.payload?.status || 'running' } }];
  }
  if (rawEvent?.type === 'ended') {
    return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: 'ended', reason: rawEvent.payload?.reason || null } }];
  }
  if (rawEvent?.type === 'chunk') {
    const text = rawEvent.payload?.chunk;
    return typeof text === 'string' && text
      ? [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text, stream: rawEvent.payload?.stream || 'agent', delta: true } }]
      : [];
  }

  switch (event.type) {
    case 'content_start': {
      if (event.contentType === 'text' && typeof event.text === 'string' && event.text) {
        return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.text, delta: true } }];
      }
      if (event.contentType === 'reasoning' && typeof event.reasoning === 'string' && event.reasoning) {
        return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.reasoning, thought: true, delta: true } }];
      }
      if (event.contentType !== 'tool') return [];
      const data = { toolName: event.toolName || 'unknown', toolCallId: event.toolCallId || null, input: stripSecrets(event.input) };
      if (READ_TOOLS.has(event.toolName)) return [{ ...base, type: AGENT_EVENT.FILE_READ, data }, { ...base, type: AGENT_EVENT.TOOL_STARTED, data }];
      if (COMMAND_TOOLS.has(event.toolName)) return [{ ...base, type: AGENT_EVENT.COMMAND_STARTED, data }, { ...base, type: AGENT_EVENT.TOOL_STARTED, data }];
      return [{ ...base, type: AGENT_EVENT.TOOL_STARTED, data }];
    }
    case 'content_update':
      // Current @cline/sdk emits content_update only for tool progress. Keep the
      // legacy text branch for injected test SDKs used by older projects.
      if (event.contentType === 'text' && typeof event.text === 'string') {
        return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.text, delta: true } }];
      }
      return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: 'running', toolName: event.toolName, toolCallId: event.toolCallId, update: stripSecrets(event.update) } }];
    case 'content_end': {
      if (event.contentType !== 'tool') return [];
      const data = {
        toolName: event.toolName || 'unknown',
        toolCallId: event.toolCallId || null,
        output: stripSecrets(event.output),
        durationMs: event.durationMs || null,
        ...(event.error ? { error: cleanError(event.error) } : {})
      };
      if (event.error) return [{ ...base, type: AGENT_EVENT.TOOL_FAILED, data }];
      if (COMMAND_TOOLS.has(event.toolName)) return [{ ...base, type: AGENT_EVENT.COMMAND_COMPLETED, data }, { ...base, type: AGENT_EVENT.TOOL_COMPLETED, data }];
      return [{ ...base, type: AGENT_EVENT.TOOL_COMPLETED, data }];
    }
    case 'iteration_start':
      return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: 'running', iteration: event.iteration } }];
    case 'iteration_end':
      return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: 'running', iteration: event.iteration, toolCallCount: event.toolCallCount } }];
    case 'usage':
      return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { usage: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        cost: event.cost,
        totalInputTokens: event.totalInputTokens,
        totalOutputTokens: event.totalOutputTokens,
        totalCacheReadTokens: event.totalCacheReadTokens,
        totalCacheWriteTokens: event.totalCacheWriteTokens,
        totalCost: event.totalCost
      }, status: 'running' } }];
    case 'notice':
      return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.message || '', noticeType: event.noticeType || 'status' } }];
    case 'done':
      return [{ ...base, type: AGENT_EVENT.RUN_STATUS, data: { status: 'done', reason: event.reason, iterations: event.iterations, usage: stripSecrets(event.usage) } }];
    case 'error':
      return [{ ...base, type: AGENT_EVENT.RUN_FAILED, data: { error: cleanError(event.error), recoverable: !!event.recoverable, iteration: event.iteration } }];

    // Legacy injected Agent/ACP fixtures stay explicit and test-only.
    case 'agent_message_chunk':
      return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.text || event.chunk, delta: true } }];
    case 'agent_thought_chunk':
      return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { text: event.text || event.chunk, thought: true, delta: true } }];
    case 'tool_call':
      return [{ ...base, type: AGENT_EVENT.TOOL_STARTED, data: { toolName: event.toolName, input: stripSecrets(event.input) } }];
    case 'tool_call_update':
      return [{ ...base, type: AGENT_EVENT.TOOL_COMPLETED, data: { toolName: event.toolName, output: stripSecrets(event.output) } }];
    case 'plan':
      return [{ ...base, type: AGENT_EVENT.PLAN_UPDATED, data: { plan: stripSecrets(event.plan) } }];
    default:
      return [{ ...base, type: AGENT_EVENT.MESSAGE, data: { notice: 'Unsupported Cline event', rawType: event.type }, rawType: event.type }];
  }
}

function mapClineEvent(rawEvent, runId, agentId) {
  return mapClineEvents(rawEvent, runId, agentId)[0] || null;
}

module.exports = { mapClineEvent, mapClineEvents, unwrapCoreEvent, READ_TOOLS, WRITE_TOOLS, COMMAND_TOOLS };
