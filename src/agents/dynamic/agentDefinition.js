'use strict';

const crypto = require('crypto');
const { normalizeModelRequirements } = require('../../models/router/modelRequirements');

const ERROR_CODE = 'DYNAMIC_AGENT_DEFINITION_INVALID';
const RUNTIME_KINDS = new Set(['native']);
const LIFETIMES = new Set(['run', 'session', 'manual']);
const MODEL_MODES = new Set(['inherit_parent', 'explicit', 'auto']);
const CREDENTIAL_KEYS = new Set([
  'apikey', 'authorization', 'bearer', 'cookie', 'password',
  'refreshtoken', 'accesstoken', 'secret', 'credential', 'credentials'
]);

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  description: '',
  role: 'specialist',
  systemPrompt: '',
  runtime: Object.freeze({ kind: 'native' }),
  capabilities: Object.freeze([]),
  toolPolicy: Object.freeze({ allow: Object.freeze([]), deny: Object.freeze([]) }),
  permissionPolicy: Object.freeze({ readOnly: false, allow: Object.freeze([]), deny: Object.freeze([]) }),
  modelPolicy: Object.freeze({ mode: 'inherit_parent', connectionId: null, model: null, requirements: Object.freeze({}), fallback: 'fail' }),
  lifetime: 'run',
  budgets: Object.freeze({ maxIterations: 10, maxToolCalls: 30, maxRuntimeMs: 300000 }),
  canDelegate: false,
  tags: Object.freeze([]),
  metadata: Object.freeze({})
});

function invalid(message, path) {
  const error = new Error(`${ERROR_CODE}: ${path ? `${path}: ` : ''}${message}`);
  error.code = ERROR_CODE;
  error.path = path || null;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertSerializableSafe(value, path = 'definition', seen = new Set()) {
  if (typeof value === 'function') throw invalid('functions are not serializable', path);
  if (typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined') {
    throw invalid(`unsupported value type ${typeof value}`, path);
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw invalid('cyclic values are not serializable', path);
  if (!Array.isArray(value) && !isPlainObject(value)) throw invalid('runtime objects and class instances are forbidden', path);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableSafe(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (CREDENTIAL_KEYS.has(normalizedKey(key))) throw invalid('credential-like fields are forbidden', `${path}.${key}`);
      assertSerializableSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw invalid('must be an array of non-empty strings', path);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function finiteInteger(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`must be an integer between ${min} and ${max}`, path);
  }
  return value;
}

function normalizeAgentDefinition(input, options = {}) {
  assertSerializableSafe(input);
  if (!isPlainObject(input)) throw invalid('must be a plain object');

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw invalid('name is required', 'definition.name');
  if (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') {
    throw invalid('must be a string', 'definition.systemPrompt');
  }

  const runtime = input.runtime === undefined ? DEFAULTS.runtime : input.runtime;
  if (!isPlainObject(runtime) || !RUNTIME_KINDS.has(runtime.kind)) {
    throw invalid('runtime.kind must be native', 'definition.runtime.kind');
  }

  const lifetime = input.lifetime === undefined ? DEFAULTS.lifetime : input.lifetime;
  if (!LIFETIMES.has(lifetime)) throw invalid('unknown lifetime', 'definition.lifetime');

  const model = Object.assign({}, DEFAULTS.modelPolicy, input.modelPolicy || {});
  if (!isPlainObject(input.modelPolicy || {})) throw invalid('must be an object', 'definition.modelPolicy');
  if (!MODEL_MODES.has(model.mode)) throw invalid('unknown model mode', 'definition.modelPolicy.mode');
  if (model.connectionId !== null && typeof model.connectionId !== 'string') {
    throw invalid('must be a string or null', 'definition.modelPolicy.connectionId');
  }
  if (model.model !== null && typeof model.model !== 'string') {
    throw invalid('must be a string or null', 'definition.modelPolicy.model');
  }
  if (model.mode === 'explicit' && (!model.connectionId || !model.model)) {
    throw invalid('explicit mode requires connectionId and model', 'definition.modelPolicy');
  }
  if (model.mode === 'inherit_parent') {
    model.connectionId = null;
    model.model = null;
  }
  if (model.mode === 'auto') {
    model.connectionId = null;
    model.model = null;
  }
  if (model.fallback !== 'fail') throw invalid('only fail fallback is supported', 'definition.modelPolicy.fallback');
  let modelRequirements;
  try { modelRequirements = normalizeModelRequirements(model.requirements || {}); }
  catch (error) { throw invalid(error.message, `definition.modelPolicy.${error.path || 'requirements'}`); }

  const toolPolicy = Object.assign({}, DEFAULTS.toolPolicy, input.toolPolicy || {});
  const permissionPolicy = Object.assign({}, DEFAULTS.permissionPolicy, input.permissionPolicy || {});
  if (!isPlainObject(input.toolPolicy || {})) throw invalid('must be an object', 'definition.toolPolicy');
  if (!isPlainObject(input.permissionPolicy || {})) throw invalid('must be an object', 'definition.permissionPolicy');
  if (typeof permissionPolicy.readOnly !== 'boolean') throw invalid('must be boolean', 'definition.permissionPolicy.readOnly');

  const budgets = Object.assign({}, DEFAULTS.budgets, input.budgets || {});
  if (!isPlainObject(input.budgets || {})) throw invalid('must be an object', 'definition.budgets');

  const definition = {
    schemaVersion: input.schemaVersion === undefined ? 1 : input.schemaVersion,
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : (options.id || `dyn-def-${crypto.randomUUID()}`),
    templateId: typeof input.templateId === 'string' && input.templateId.trim() ? input.templateId.trim() : (options.templateId || null),
    name,
    description: typeof input.description === 'string' ? input.description : DEFAULTS.description,
    role: typeof input.role === 'string' && input.role.trim() ? input.role.trim() : DEFAULTS.role,
    systemPrompt: input.systemPrompt === undefined ? DEFAULTS.systemPrompt : input.systemPrompt,
    runtime: { kind: runtime.kind },
    capabilities: stringArray(input.capabilities || [], 'definition.capabilities'),
    toolPolicy: {
      allow: stringArray(toolPolicy.allow || [], 'definition.toolPolicy.allow'),
      deny: stringArray(toolPolicy.deny || [], 'definition.toolPolicy.deny')
    },
    permissionPolicy: {
      readOnly: permissionPolicy.readOnly,
      allow: stringArray(permissionPolicy.allow || [], 'definition.permissionPolicy.allow'),
      deny: stringArray(permissionPolicy.deny || [], 'definition.permissionPolicy.deny')
    },
    modelPolicy: {
      mode: model.mode,
      connectionId: model.connectionId || null,
      model: model.model || null,
      requirements: modelRequirements,
      fallback: 'fail'
    },
    lifetime,
    budgets: {
      maxIterations: finiteInteger(budgets.maxIterations, 'definition.budgets.maxIterations', 1, 1000),
      maxToolCalls: finiteInteger(budgets.maxToolCalls, 'definition.budgets.maxToolCalls', 0, 10000),
      maxRuntimeMs: finiteInteger(budgets.maxRuntimeMs, 'definition.budgets.maxRuntimeMs', 1, 86400000)
    },
    canDelegate: input.canDelegate === true,
    tags: stringArray(input.tags || [], 'definition.tags'),
    metadata: input.metadata === undefined ? {} : input.metadata
  };

  if (definition.schemaVersion !== 1) throw invalid('unsupported schemaVersion', 'definition.schemaVersion');
  if (!definition.id) throw invalid('id is required', 'definition.id');
  if (typeof definition.description !== 'string') throw invalid('must be a string', 'definition.description');
  if (typeof definition.role !== 'string' || !definition.role) throw invalid('must be a non-empty string', 'definition.role');
  if (!isPlainObject(definition.metadata)) throw invalid('must be a plain object', 'definition.metadata');

  definition.toolPolicy.deny = [...new Set(definition.toolPolicy.deny)];
  definition.toolPolicy.allow = definition.toolPolicy.allow.filter(name => !definition.toolPolicy.deny.includes(name));
  definition.permissionPolicy.deny = [...new Set(definition.permissionPolicy.deny)];
  definition.permissionPolicy.allow = definition.permissionPolicy.allow.filter(scope => !definition.permissionPolicy.deny.includes(scope));
  return definition;
}

function validateAgentDefinition(input, options) {
  return normalizeAgentDefinition(input, options);
}

module.exports = {
  ERROR_CODE,
  DEFAULTS,
  validateAgentDefinition,
  normalizeAgentDefinition,
  assertSerializableSafe,
  invalid
};
