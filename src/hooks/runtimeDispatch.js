'use strict';

const { getHookRuntime } = require('./runtimeRegistry');

async function dispatchRuntimeHook(ctx, event, extra = {}) {
  const hookIds = ctx && Array.isArray(ctx.hookIds) ? ctx.hookIds : [];
  if (!hookIds.length) return { ok: true, context: '', annotations: [], hooks: [] };
  const engine = (ctx && ctx.hookEngine) || getHookRuntime();
  if (!engine || typeof engine.dispatch !== 'function') {
    return { ok: false, errorCode: 'HOOK_ENGINE_UNAVAILABLE', error: 'Hook Engine is not available', context: '', annotations: [] };
  }
  return engine.dispatch({
    event,
    hookIds,
    context: {
      runId: ctx.runId || null,
      rootRunId: ctx.rootRunId || ctx.runId || null,
      parentRunId: ctx.parentRunId || null,
      agentId: ctx.agentId || null,
      agentType: ctx.agentType || 'native',
      skillIds: ctx.skillIds || [],
      ...extra
    }
  });
}

module.exports = { dispatchRuntimeHook };
