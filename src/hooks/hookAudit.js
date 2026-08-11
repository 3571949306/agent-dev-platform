'use strict';

const crypto = require('crypto');

const MAX_ANNOTATIONS_JSON = 8192;
const SENSITIVE_KEY = /api.?key|authorization|cookie|credential|password|secret|token|provider|adapter|prompt|file.?content/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,}|cookie\s*=)/ig;

function sanitizeAuditValue(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]').slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeAuditValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value).slice(0, 200);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeAuditValue(item, depth + 1);
  }
  return out;
}

function boundedAnnotations(value) {
  const sanitized = sanitizeAuditValue(value || {});
  const json = JSON.stringify(sanitized);
  if (json.length <= MAX_ANNOTATIONS_JSON) return sanitized;
  return { truncated: true, preview: json.slice(0, MAX_ANNOTATIONS_JSON - 100) };
}

function createHookAudit({ store } = {}) {
  function record(input) {
    const invocation = {
      invocationId: input.invocationId || crypto.randomUUID(),
      hookId: input.hookId,
      event: input.event,
      runId: input.runId || null,
      rootRunId: input.rootRunId || input.runId || null,
      parentRunId: input.parentRunId || null,
      agentId: input.agentId || null,
      outcome: input.outcome || 'unknown',
      errorCode: input.errorCode || null,
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      toolName: input.toolName || null,
      actionType: input.actionType || null,
      annotations: boundedAnnotations(input.annotations),
      createdAt: input.createdAt || new Date().toISOString()
    };
    if (store && typeof store.create === 'function') return store.create(invocation);
    return invocation;
  }
  function list(limit) { return store && typeof store.list === 'function' ? store.list(limit) : []; }
  return { record, list };
}

module.exports = { MAX_ANNOTATIONS_JSON, sanitizeAuditValue, boundedAnnotations, createHookAudit };
