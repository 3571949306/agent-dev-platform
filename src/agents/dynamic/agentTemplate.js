'use strict';

const crypto = require('crypto');
const { normalizeAgentDefinition, assertSerializableSafe, invalid } = require('./agentDefinition');

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function intersect(left, right) {
  if (!left.length) return right.slice();
  if (!right.length) return left.slice();
  const allowed = new Set(right);
  return left.filter(value => allowed.has(value));
}

function restrictivePolicy(base, override, readOnly) {
  const a = isObject(base) ? base : {};
  const b = isObject(override) ? override : {};
  const deny = unique([...(a.deny || []), ...(b.deny || [])]);
  const allow = intersect(unique(a.allow || []), unique(b.allow || [])).filter(value => !deny.includes(value));
  return Object.assign({}, a, b, { allow, deny }, readOnly ? { readOnly: a.readOnly === true || b.readOnly === true } : {});
}

function normalizeAgentTemplate(input) {
  assertSerializableSafe(input, 'template');
  if (!isObject(input)) throw invalid('template must be a plain object', 'template');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw invalid('template.name is required', 'template.name');
  if (!isObject(input.defaults || {})) throw invalid('template.defaults must be an object', 'template.defaults');
  return {
    schemaVersion: input.schemaVersion === undefined ? 1 : input.schemaVersion,
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `dyn-template-${crypto.randomUUID()}`,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    defaults: JSON.parse(JSON.stringify(input.defaults || {})),
    tags: unique(input.tags || []),
    metadata: isObject(input.metadata) ? JSON.parse(JSON.stringify(input.metadata)) : {}
  };
}

function compileAgentDefinition(templateInput, overrides = {}, context = {}) {
  const template = normalizeAgentTemplate(templateInput);
  assertSerializableSafe(overrides, 'overrides');
  if (!isObject(overrides)) throw invalid('overrides must be an object', 'overrides');

  const defaults = template.defaults;
  const merged = Object.assign({}, defaults, overrides, {
    templateId: template.id,
    name: overrides.name || defaults.name || template.name,
    runtime: Object.assign({ kind: 'native' }, defaults.runtime || {}, overrides.runtime || {}),
    toolPolicy: restrictivePolicy(defaults.toolPolicy, overrides.toolPolicy, false),
    permissionPolicy: restrictivePolicy(defaults.permissionPolicy, overrides.permissionPolicy, true),
    modelPolicy: Object.assign({}, defaults.modelPolicy || {}, overrides.modelPolicy || {}),
    budgets: Object.assign({}, defaults.budgets || {}, overrides.budgets || {}),
    metadata: Object.assign({}, defaults.metadata || {}, overrides.metadata || {})
  });
  if (overrides.id) merged.id = overrides.id;

  if (context.parentPolicy) {
    merged.toolPolicy = restrictivePolicy(merged.toolPolicy, context.parentPolicy.toolPolicy, false);
    merged.permissionPolicy = restrictivePolicy(merged.permissionPolicy, context.parentPolicy.permissionPolicy, true);
  }
  if (context.platformPolicy) {
    merged.toolPolicy = restrictivePolicy(merged.toolPolicy, context.platformPolicy.toolPolicy, false);
    merged.permissionPolicy = restrictivePolicy(merged.permissionPolicy, context.platformPolicy.permissionPolicy, true);
  }
  return normalizeAgentDefinition(merged, { id: overrides.id, templateId: template.id });
}

module.exports = { normalizeAgentTemplate, compileAgentDefinition, restrictivePolicy };
