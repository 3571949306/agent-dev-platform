'use strict';

const crypto = require('crypto');

const MAX_JSON = 8192;
const SENSITIVE_KEY = /api.?key|authorization|bearer|cookie|credential|password|secret|token|provider|adapter|prompt|file.?content/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,}|cookie\s*=)/ig;

function sanitizeValue(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]').slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value).slice(0, 200);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1);
  }
  return out;
}

function bounded(value, max = MAX_JSON) {
  const sanitized = sanitizeValue(value || {});
  const json = JSON.stringify(sanitized);
  if (json.length <= max) return sanitized;
  return { truncated: true, preview: json.slice(0, Math.max(0, max - 100)) };
}

function createWorkflowAudit({ store } = {}) {
  function record(input) {
    const row = {
      auditId: input.auditId || crypto.randomUUID(),
      workflowRunId: input.workflowRunId,
      workflowId: input.workflowId,
      stepId: input.stepId || null,
      stepType: input.stepType || null,
      status: input.status,
      attempt: Math.max(0, Number(input.attempt) || 0),
      runId: input.runId || null,
      childRunId: input.childRunId || null,
      errorCode: input.errorCode || null,
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      detail: bounded(input.detail),
      createdAt: input.createdAt || new Date().toISOString()
    };
    return store && typeof store.create === 'function' ? store.create(row) : row;
  }
  function list(limit) {
    return store && typeof store.list === 'function' ? store.list(limit) : [];
  }
  return { record, list };
}

module.exports = { MAX_JSON, sanitizeValue, bounded, createWorkflowAudit };
