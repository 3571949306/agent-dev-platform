'use strict';
/**
 * v2.9.3 Skill Engine — R1 SkillDefinition Contract.
 *
 * A Skill is a reusable, declarative Agent capability pack:
 *   Skill != Agent / Skill != Tool / Skill != Workflow / Skill != Hook
 *
 * A Skill can only REQUIRE capabilities (prompt instructions, tools, permissions,
 * model features). It can never GRANT anything: no apiKey/Authorization/Bearer/
 * Cookie/password/accessToken/refreshToken, no Provider/ModelAdapter/AgentAdapter,
 * no functions, no runtime objects.
 *
 * Definitions are strict, versioned (schemaVersion 1) and JSON-serializable.
 * Any violation raises SKILL_DEFINITION_INVALID.
 */

const { normalizeModelRequirements } = require('../models/router/modelRequirements');

const ERROR_CODE = 'SKILL_DEFINITION_INVALID';

const CREDENTIAL_KEYS = new Set([
  'apikey', 'authorization', 'bearer', 'cookie', 'password',
  'refreshtoken', 'accesstoken', 'secret', 'credential', 'credentials',
  'api_key', 'access_key', 'token'
]);

const RUNTIME_KEY_NAMES = new Set([
  'provider', 'modeladapter', 'agentadapter', 'adapter', 'function',
  'runtime', 'instance', 'exec', 'callback'
]);

// Alias expansion for tool names: the platform prompt layer uses short aliases
// (search / patch_file / run_command / run_tests), the built-in tool registry
// uses concrete names. Expansion is deterministic and applied to both
// requirements and denials so a denied alias denies every concrete tool.
const TOOL_ALIASES = Object.freeze({
  search: ['search_files', 'search_text', 'search_symbols'],
  patch_file: ['apply_patch'],
  run_command: ['terminal_run'],
  run_tests: ['terminal_run']
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
      if (RUNTIME_KEY_NAMES.has(normalizedKey(key))) throw invalid('runtime/provider/adapter fields are forbidden', `${path}.${key}`);
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

function plainObject(value, path) {
  if (!isPlainObject(value)) throw invalid('must be a plain object', path);
  return value;
}

/**
 * Normalize + validate a SkillDefinition input.
 * @returns {object} normalized, serializable SkillDefinition
 */
function normalizeSkillDefinition(input, options = {}) {
  assertSerializableSafe(input);
  if (!isPlainObject(input)) throw invalid('must be a plain object', 'definition');

  const id = typeof input.id === 'string' && input.id.trim()
    ? input.id.trim()
    : (options.id && typeof options.id === 'string' ? options.id : '');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!id) throw invalid('id is required', 'definition.id');
  if (!name) throw invalid('name is required', 'definition.name');
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) {
    throw invalid('instructions must be a non-empty string', 'definition.instructions');
  }

  const toolInput = plainObject(input.toolRequirements || {}, 'definition.toolRequirements');
  const permissionInput = plainObject(input.permissionRequirements || {}, 'definition.permissionRequirements');
  const modelInput = plainObject(input.modelRequirements || {}, 'definition.modelRequirements');
  const compatInput = plainObject(input.compatibility || {}, 'definition.compatibility');
  const metadataInput = plainObject(input.metadata || {}, 'definition.metadata');

  let modelRequirements;
  try { modelRequirements = normalizeModelRequirements(modelInput); }
  catch (error) { throw invalid(error.message, `definition.modelRequirements.${error.path || ''}`.replace(/\.$/, '')); }

  const definition = {
    schemaVersion: input.schemaVersion === undefined ? 1 : input.schemaVersion,
    id,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    instructions: input.instructions.trim(),
    tags: stringArray(input.tags || [], 'definition.tags'),
    toolRequirements: {
      required: stringArray(toolInput.required || [], 'definition.toolRequirements.required'),
      optional: stringArray(toolInput.optional || [], 'definition.toolRequirements.optional'),
      denied: stringArray(toolInput.denied || [], 'definition.toolRequirements.denied')
    },
    permissionRequirements: {
      required: stringArray(permissionInput.required || [], 'definition.permissionRequirements.required')
    },
    modelRequirements,
    compatibility: {
      agentTypes: stringArray(compatInput.agentTypes || ['native'], 'definition.compatibility.agentTypes'),
      platforms: stringArray(compatInput.platforms || ['windows'], 'definition.compatibility.platforms'),
      projectSignals: stringArray(compatInput.projectSignals || [], 'definition.compatibility.projectSignals')
    },
    requiresSkills: stringArray(input.requiresSkills || [], 'definition.requiresSkills'),
    metadata: metadataInput
  };

  if (definition.schemaVersion !== 1) throw invalid('unsupported schemaVersion', 'definition.schemaVersion');
  if (typeof definition.description !== 'string') throw invalid('must be a string', 'definition.description');

  // A skill that both requires and denies the same tool is self-contradictory.
  const reqSet = new Set(definition.toolRequirements.required);
  for (const denied of definition.toolRequirements.denied) {
    if (reqSet.has(denied)) throw invalid(`tool cannot be both required and denied: ${denied}`, 'definition.toolRequirements');
  }
  return definition;
}

function validateSkillDefinition(input, options) {
  return normalizeSkillDefinition(input, options);
}

/** Expand alias names to concrete platform tool names (deterministic, sorted, deduped). */
function expandToolNames(names) {
  const out = new Set();
  for (const name of names || []) {
    if (TOOL_ALIASES[name]) for (const concrete of TOOL_ALIASES[name]) out.add(concrete);
    else out.add(name);
  }
  return [...out].sort();
}

module.exports = {
  ERROR_CODE,
  TOOL_ALIASES,
  normalizeSkillDefinition,
  validateSkillDefinition,
  assertSerializableSafe,
  expandToolNames,
  invalid
};
