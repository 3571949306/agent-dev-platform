'use strict';

const { sanitizeValue } = require('./workflowAudit');

const MAX_STEP_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const REFERENCE = /\$\{((?:input|steps)\.[A-Za-z0-9_.-]+)\}/g;

function workflowError(code, message) {
  const error = new Error(code + ': ' + message);
  error.code = code;
  return error;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundStepOutput(value) {
  const sanitized = sanitizeValue(value);
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, 'utf8') <= MAX_STEP_OUTPUT_BYTES) return sanitized;
  return {
    truncated: true,
    preview: json.slice(0, Math.max(0, MAX_STEP_OUTPUT_BYTES - 200))
  };
}

function getReference(context, path) {
  const parts = String(path).split('.');
  let current = context;
  for (const part of parts) {
    if (current === null || current === undefined ||
        !Object.prototype.hasOwnProperty.call(Object(current), part)) {
      throw workflowError('WORKFLOW_REFERENCE_NOT_FOUND', path);
    }
    current = current[part];
  }
  if (current === undefined) throw workflowError('WORKFLOW_REFERENCE_NOT_FOUND', path);
  return current;
}

function resolveTemplates(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(/^\$\{((?:input|steps)\.[A-Za-z0-9_.-]+)\}$/);
    if (exact) return structuredClone(getReference(context, exact[1]));
    return value.replace(REFERENCE, (_match, path) => {
      const resolved = getReference(context, path);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(item => resolveTemplates(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]));
  }
  return value;
}

function addStepResult(context, stepId, status, output) {
  const next = structuredClone(context);
  next.steps[stepId] = {
    status: String(status).toLowerCase(),
    output: boundStepOutput(output)
  };
  if (jsonSize(next) > MAX_CONTEXT_BYTES) {
    throw workflowError('WORKFLOW_CONTEXT_LIMIT_EXCEEDED', 'workflow context exceeds 256KB');
  }
  return next;
}

module.exports = {
  MAX_STEP_OUTPUT_BYTES,
  MAX_CONTEXT_BYTES,
  workflowError,
  jsonSize,
  boundStepOutput,
  getReference,
  resolveTemplates,
  addStepResult
};
