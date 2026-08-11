'use strict';

const crypto = require('crypto');
const { HOOK_HANDLER_NOT_FOUND } = require('./hookHandlerRegistry');

const HOOK_BLOCKED = 'HOOK_BLOCKED';
const HOOK_HANDLER_ERROR = 'HOOK_HANDLER_ERROR';
const HOOK_TIMEOUT = 'HOOK_TIMEOUT';
const MAX_CONTEXT_PER_HOOK = 4000;
const MAX_CONTEXT_TOTAL = 8000;

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function timeoutError(timeoutMs) {
  const error = new Error(`${HOOK_TIMEOUT}: trusted hook handler exceeded ${timeoutMs}ms`);
  error.code = HOOK_TIMEOUT;
  return error;
}

function invokeWithTimeout(handler, payload, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => handler(payload)), timeout])
    .finally(() => clearTimeout(timer));
}

function makePayload(hook, event, context) {
  const allowed = {
    invocationId: crypto.randomUUID(),
    hookId: hook.id,
    handlerId: hook.handlerId,
    event,
    kind: hook.kind,
    config: cloneJson(hook.config || {}),
    runId: context.runId || null,
    rootRunId: context.rootRunId || context.runId || null,
    parentRunId: context.parentRunId || null,
    workflowRunId: context.workflowRunId || null,
    workflowStepId: context.workflowStepId || null,
    agentId: context.agentId || null,
    agentType: context.agentType || null,
    toolName: context.toolName || null,
    actionType: context.actionType || null,
    skillIds: Array.isArray(context.skillIds) ? context.skillIds.slice() : [],
    iteration: Number.isInteger(context.iteration) ? context.iteration : null,
    toolArgs: cloneJson(context.toolArgs || null),
    outcome: cloneJson(context.outcome || null)
  };
  return deepFreeze(allowed);
}

function createHookDispatcher({ resolver, handlerRegistry, audit } = {}) {
  async function dispatch({ event, hookIds = [], requiredHookIds = [], optionalHookIds = [], context = {} } = {}) {
    const resolution = resolver.resolve({ event, hookIds, requiredHookIds, optionalHookIds, context });
    if (!resolution.ok) return { ...resolution, context: '', annotations: [] };
    const annotations = [];
    const contextParts = [];

    for (const hook of resolution.hooks) {
      const startedAt = Date.now();
      const payload = makePayload(hook, event, context);
      const baseAudit = {
        invocationId: payload.invocationId,
        hookId: hook.id,
        event,
        runId: payload.runId,
        rootRunId: payload.rootRunId,
        parentRunId: payload.parentRunId,
        workflowRunId: payload.workflowRunId,
        workflowStepId: payload.workflowStepId,
        agentId: payload.agentId,
        toolName: payload.toolName,
        actionType: payload.actionType
      };
      const handler = handlerRegistry.get(hook.handlerId);
      if (!handler) {
        const result = { ok: false, errorCode: HOOK_HANDLER_NOT_FOUND, error: `trusted handler '${hook.handlerId}' is not registered` };
        audit.record({ ...baseAudit, outcome: 'error', errorCode: result.errorCode, durationMs: Date.now() - startedAt });
        if (hook.kind === 'observer') continue;
        return { ...result, context: contextParts.join('\n'), annotations, hooks: resolution.hooks };
      }
      try {
        const output = await invokeWithTimeout(handler, payload, hook.timeoutMs);
        if (hook.kind === 'observer') {
          const annotation = output && output.annotations !== undefined ? cloneJson(output.annotations) : null;
          if (annotation !== null) annotations.push({ hookId: hook.id, value: annotation });
          audit.record({ ...baseAudit, outcome: 'observed', durationMs: Date.now() - startedAt, annotations: annotation });
          continue;
        }
        if (hook.kind === 'guard') {
          const decision = output && output.decision;
          if (decision !== 'continue' && decision !== 'block') {
            const error = new Error('guard handler must return decision=continue or decision=block');
            error.code = HOOK_HANDLER_ERROR;
            throw error;
          }
          if (decision === 'block') {
            const reason = typeof output.reason === 'string' ? output.reason.slice(0, 1000) : `blocked by hook '${hook.id}'`;
            audit.record({ ...baseAudit, outcome: 'blocked', errorCode: HOOK_BLOCKED, durationMs: Date.now() - startedAt, annotations: { reason } });
            return { ok: false, blocked: true, errorCode: HOOK_BLOCKED, error: reason, hookId: hook.id, context: contextParts.join('\n'), annotations, hooks: resolution.hooks };
          }
          audit.record({ ...baseAudit, outcome: 'continued', durationMs: Date.now() - startedAt });
          continue;
        }
        const addition = output && typeof output.context === 'string' ? output.context.slice(0, MAX_CONTEXT_PER_HOOK) : null;
        if (addition === null) {
          const error = new Error('context handler must return a context string');
          error.code = HOOK_HANDLER_ERROR;
          throw error;
        }
        const remaining = MAX_CONTEXT_TOTAL - contextParts.join('\n').length;
        if (remaining > 0) contextParts.push(addition.slice(0, remaining));
        audit.record({ ...baseAudit, outcome: 'context_appended', durationMs: Date.now() - startedAt, annotations: { chars: addition.length } });
      } catch (error) {
        const errorCode = error && error.code === HOOK_TIMEOUT ? HOOK_TIMEOUT : HOOK_HANDLER_ERROR;
        audit.record({ ...baseAudit, outcome: 'error', errorCode, durationMs: Date.now() - startedAt, annotations: { message: error && error.message } });
        if (hook.kind === 'observer') continue;
        return { ok: false, errorCode, error: error && error.message ? error.message : errorCode, hookId: hook.id, context: contextParts.join('\n'), annotations, hooks: resolution.hooks };
      }
    }
    return { ok: true, context: contextParts.join('\n'), annotations, hooks: resolution.hooks, skipped: resolution.skipped };
  }

  return { dispatch };
}

module.exports = {
  HOOK_BLOCKED, HOOK_HANDLER_ERROR, HOOK_TIMEOUT,
  MAX_CONTEXT_PER_HOOK, MAX_CONTEXT_TOTAL,
  deepFreeze, createHookDispatcher
};
