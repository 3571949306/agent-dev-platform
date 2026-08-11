'use strict';

const ERROR_CODE = 'HOOK_DEFINITION_INVALID';
const EVENTS = Object.freeze([
  'run_start', 'before_model', 'after_model', 'before_tool',
  'after_tool', 'before_delegate', 'after_delegate', 'run_end'
]);
const KINDS = Object.freeze(['observer', 'guard', 'context']);
const FILTER_KEYS = Object.freeze(['agentTypes', 'agentIds', 'toolNames', 'actionTypes', 'skillIds']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'id', 'name', 'description', 'event', 'kind', 'handlerId',
  'priority', 'filters', 'timeoutMs', 'config', 'metadata'
]);
const FORBIDDEN_KEYS = new Set([
  'apikey', 'authorization', 'cookie', 'credential', 'credentials', 'password',
  'secret', 'token', 'accesstoken', 'refreshtoken', 'provider', 'modeladapter',
  'agentadapter', 'adapter', 'function', 'callback', 'eval', 'javascript',
  'shell', 'command', 'webhook', 'url', 'endpoint', 'runtime', 'exec'
]);

function invalid(message, path = 'definition') {
  const error = new Error(`${ERROR_CODE}: ${path}: ${message}`);
  error.code = ERROR_CODE;
  error.path = path;
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
  if (typeof value === 'function') throw invalid('functions are forbidden', path);
  if (['undefined', 'symbol', 'bigint'].includes(typeof value)) {
    throw invalid(`unsupported value type ${typeof value}`, path);
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^\s*(?:javascript:|https?:\/\/)/i.test(value)) {
      throw invalid('executable or remote references are forbidden', path);
    }
    return;
  }
  if (seen.has(value)) throw invalid('cyclic values are forbidden', path);
  if (!Array.isArray(value) && !isPlainObject(value)) throw invalid('runtime objects and class instances are forbidden', path);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableSafe(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(normalizedKey(key))) throw invalid('forbidden runtime, credential, shell, or remote field', `${path}.${key}`);
      assertSerializableSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw invalid('must be an array of non-empty strings', path);
  }
  return [...new Set(value.map(item => item.trim()))].sort();
}

function normalizeHookDefinition(input, options = {}) {
  assertSerializableSafe(input);
  if (!isPlainObject(input)) throw invalid('must be a plain object');
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw invalid('unknown field', `definition.${key}`);
  }

  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : String(options.id || '').trim();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const handlerId = typeof input.handlerId === 'string' ? input.handlerId.trim() : '';
  if (!id) throw invalid('id is required', 'definition.id');
  if (!name) throw invalid('name is required', 'definition.name');
  if (!EVENTS.includes(input.event)) throw invalid('unknown lifecycle event', 'definition.event');
  if (!KINDS.includes(input.kind)) throw invalid('unknown hook kind', 'definition.kind');
  if (!handlerId) throw invalid('handlerId is required', 'definition.handlerId');
  if (input.kind === 'context' && input.event !== 'before_model') {
    throw invalid('context hooks are only allowed at before_model', 'definition.kind');
  }
  if (['after_model', 'after_tool', 'after_delegate', 'run_end'].includes(input.event) && input.kind !== 'observer') {
    throw invalid('after_* and run_end hooks must be observers', 'definition.kind');
  }

  const priority = input.priority === undefined ? 100 : input.priority;
  const timeoutMs = input.timeoutMs === undefined ? 1000 : input.timeoutMs;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
    throw invalid('must be an integer between 0 and 100000', 'definition.priority');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw invalid('must be an integer between 1 and 30000', 'definition.timeoutMs');
  }

  const filters = input.filters === undefined ? {} : input.filters;
  const config = input.config === undefined ? {} : input.config;
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!isPlainObject(filters)) throw invalid('must be a plain object', 'definition.filters');
  if (!isPlainObject(config)) throw invalid('must be a plain object', 'definition.config');
  if (!isPlainObject(metadata)) throw invalid('must be a plain object', 'definition.metadata');
  for (const key of Object.keys(filters)) {
    if (!FILTER_KEYS.includes(key)) throw invalid('unknown filter', `definition.filters.${key}`);
  }

  return {
    schemaVersion: input.schemaVersion === undefined ? 1 : input.schemaVersion,
    id,
    name,
    description: input.description === undefined ? '' : input.description,
    event: input.event,
    kind: input.kind,
    handlerId,
    priority,
    filters: Object.fromEntries(FILTER_KEYS.map(key => [key, stringArray(filters[key] || [], `definition.filters.${key}`)])),
    timeoutMs,
    config,
    metadata
  };
}

function validateHookDefinition(input, options) {
  const definition = normalizeHookDefinition(input, options);
  if (definition.schemaVersion !== 1) throw invalid('unsupported schemaVersion', 'definition.schemaVersion');
  if (typeof definition.description !== 'string') throw invalid('must be a string', 'definition.description');
  return definition;
}

module.exports = {
  ERROR_CODE, EVENTS, KINDS, FILTER_KEYS,
  normalizeHookDefinition: validateHookDefinition,
  validateHookDefinition,
  assertSerializableSafe,
  isPlainObject,
  invalid
};
