'use strict';

const { HOOK_HANDLER_NOT_FOUND } = require('./hookHandlerRegistry');

const HOOK_UNKNOWN = 'HOOK_UNKNOWN';
const HOOK_DISABLED = 'HOOK_DISABLED';

function fail(errorCode, error) { return { ok: false, errorCode, error }; }

function uniqueSorted(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].sort();
}

function hookOrder(a, b) {
  return (a.priority - b.priority) || String(a.id).localeCompare(String(b.id));
}

function matchesFilter(hook, context = {}) {
  const filters = hook.filters || {};
  const single = {
    agentTypes: context.agentType,
    agentIds: context.agentId,
    toolNames: context.toolName,
    actionTypes: context.actionType
  };
  for (const [key, value] of Object.entries(single)) {
    const expected = filters[key] || [];
    if (expected.length && !expected.includes(value)) return false;
  }
  const expectedSkills = filters.skillIds || [];
  if (expectedSkills.length) {
    const actualSkills = new Set(Array.isArray(context.skillIds) ? context.skillIds : []);
    if (!expectedSkills.some(id => actualSkills.has(id))) return false;
  }
  return true;
}

function createHookResolver({ registry, handlerRegistry } = {}) {
  function resolveSelection({ requiredHookIds = [], optionalHookIds = [], hookIds = [] } = {}) {
    const required = uniqueSorted([...hookIds, ...requiredHookIds]);
    const optional = uniqueSorted(optionalHookIds).filter(id => !required.includes(id));
    const hooks = [];
    const skipped = [];

    for (const id of required) {
      const hook = registry && registry.get(id);
      if (!hook) return fail(HOOK_UNKNOWN, `required hook '${id}' is unknown`);
      if (hook.enabled === false) return fail(HOOK_DISABLED, `required hook '${id}' is disabled`);
      if (handlerRegistry && !handlerRegistry.has(hook.handlerId)) {
        return fail(HOOK_HANDLER_NOT_FOUND, `trusted handler '${hook.handlerId}' is not registered`);
      }
      hooks.push(hook);
    }
    for (const id of optional) {
      const hook = registry && registry.get(id);
      if (!hook) { skipped.push({ hookId: id, reason: HOOK_UNKNOWN }); continue; }
      if (hook.enabled === false) { skipped.push({ hookId: id, reason: HOOK_DISABLED }); continue; }
      if (handlerRegistry && !handlerRegistry.has(hook.handlerId)) {
        skipped.push({ hookId: id, reason: HOOK_HANDLER_NOT_FOUND });
        continue;
      }
      hooks.push(hook);
    }
    hooks.sort(hookOrder);
    return { ok: true, hooks, hookIds: hooks.map(hook => hook.id), skipped };
  }

  function resolve({ event, context = {}, hookIds = [], requiredHookIds = [], optionalHookIds = [] } = {}) {
    const selection = resolveSelection({ hookIds, requiredHookIds, optionalHookIds });
    if (!selection.ok) return selection;
    const hooks = selection.hooks
      .filter(hook => hook.event === event && matchesFilter(hook, context))
      .sort(hookOrder);
    return { ...selection, hooks, hookIds: hooks.map(hook => hook.id) };
  }

  return { resolve, resolveSelection, matchesFilter, hookOrder };
}

module.exports = { HOOK_UNKNOWN, HOOK_DISABLED, hookOrder, matchesFilter, createHookResolver };
