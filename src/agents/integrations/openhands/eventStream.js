'use strict';

const { AGENT_EVENT } = require('../../hub/types');

function isFileEditEvent(raw) {
  if (!raw) return false;
  const action = String(raw.action || raw.observation || raw.tool || '').toLowerCase();
  return action === 'edit' || action === 'fileedit' || action === 'write' || action === 'file_write';
}

function isCommandEvent(raw) {
  if (!raw) return false;
  const action = String(raw.action || raw.observation || raw.tool || '').toLowerCase();
  return action === 'run' || action === 'run_ipython' || action === 'command' || action === 'cmd';
}

function isConversationEnd(raw) {
  if (!raw) return false;
  if (raw.conversation_ended === true || raw.ended === true) return true;
  const t = String(raw.type || raw.event || '').toLowerCase();
  return t === 'conversation_ended' || t === 'end' || t === 'conversation.end';
}

function mapOpenHandsEvent(rawEvent, runId, agentId) {
  const raw = rawEvent || {};
  const rawType = raw.type || raw.event || raw.action || raw.observation || 'unknown';
  const data = raw.data != null ? raw.data : (raw.content != null ? raw.content : (raw.args != null ? raw.args : raw));
  const timestamp = raw.timestamp || raw.ts || raw.created_at || Date.now();
  const rawMetadata = {};
  for (const k of Object.keys(raw)) {
    if (k === 'data' || k === 'content' || k === 'args' || k === 'type' || k === 'event') continue;
    rawMetadata[k] = raw[k];
  }

  let type = AGENT_EVENT.MESSAGE;
  let terminal = false;

  if (isConversationEnd(raw)) {
    type = AGENT_EVENT.RUN_COMPLETED;
    terminal = true;
    return { type, runId: runId || null, agentId: agentId || null, data, rawType, rawMetadata, timestamp, terminal };
  }

  const lowerType = String(rawType).toLowerCase();

  switch (lowerType) {
    case 'action': {
      if (isFileEditEvent(raw)) {
        type = AGENT_EVENT.FILE_CHANGED;
      } else if (isCommandEvent(raw)) {
        type = AGENT_EVENT.COMMAND_STARTED;
      } else {
        type = AGENT_EVENT.TOOL_STARTED;
      }
      break;
    }
    case 'observation': {
      if (isFileEditEvent(raw)) {
        type = AGENT_EVENT.FILE_CHANGED;
      } else if (isCommandEvent(raw)) {
        type = AGENT_EVENT.COMMAND_COMPLETED;
      } else {
        type = AGENT_EVENT.TOOL_COMPLETED;
      }
      break;
    }
    case 'message':
    case 'assistant':
    case 'text':
    case 'user':
      type = AGENT_EVENT.MESSAGE;
      break;
    case 'error':
    case 'exception':
      type = AGENT_EVENT.RUN_FAILED;
      terminal = true;
      break;
    case 'agent_state_changed':
    case 'state_changed':
    case 'status': {
      type = AGENT_EVENT.RUN_STATUS;
      const st = String(raw.agent_state || raw.state || raw.status || '').toLowerCase();
      if (st === 'finished' || st === 'completed' || st === 'stopped' || st === 'error') {
        type = (st === 'error') ? AGENT_EVENT.RUN_FAILED : AGENT_EVENT.RUN_COMPLETED;
        terminal = true;
      }
      break;
    }
    case 'condensation':
    case 'summary':
      type = AGENT_EVENT.MESSAGE;
      break;
    default:
      if (isFileEditEvent(raw)) {
        type = AGENT_EVENT.FILE_CHANGED;
      } else if (lowerType.includes('error') || lowerType.includes('fail')) {
        type = AGENT_EVENT.RUN_FAILED;
        terminal = true;
      } else if (lowerType.includes('complet') || lowerType.includes('finish') || lowerType.includes('end')) {
        type = AGENT_EVENT.RUN_COMPLETED;
        terminal = true;
      } else {
        type = AGENT_EVENT.MESSAGE;
      }
      break;
  }

  return { type, runId: runId || null, agentId: agentId || null, data, rawType, rawMetadata, timestamp, terminal };
}

module.exports = { mapOpenHandsEvent, isFileEditEvent, isCommandEvent, isConversationEnd };