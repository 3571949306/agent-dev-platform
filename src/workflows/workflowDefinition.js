'use strict';

const ERROR_CODE = 'WORKFLOW_DEFINITION_INVALID';
const STEP_TYPES = Object.freeze(['agent', 'tool', 'condition', 'approval']);
const CONDITIONS = Object.freeze(['eq', 'neq', 'exists', 'truthy', 'falsy']);
const FAILURES = Object.freeze(['fail', 'continue']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'id', 'name', 'description', 'inputs', 'steps',
  'outputs', 'limits', 'metadata'
]);
const STEP_KEYS = new Set([
  'id', 'type', 'dependsOn', 'config', 'timeoutMs', 'retry', 'onFailure'
]);
const FORBIDDEN_KEYS = new Set([
  'apikey', 'authorization', 'bearer', 'cookie', 'credential', 'credentials',
  'password', 'secret', 'accesstoken', 'refreshtoken', 'providerid', 'provider',
  'modeladapter', 'agentadapter', 'permissionengine', 'abortcontroller',
  'hookengine', 'function', 'callback', 'eval', 'javascript', 'script', 'code',
  'webhook', 'endpoint', 'runtime'
]);

function invalid(message, path = 'definition') {
  const error = new Error(ERROR_CODE + ': ' + path + ': ' + message);
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
    throw invalid('unsupported value type ' + typeof value, path);
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' &&
        /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(value)) {
      throw invalid('secret-bearing values are forbidden', path);
    }
    return;
  }
  if (seen.has(value)) throw invalid('cyclic values are forbidden', path);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw invalid('runtime objects and class instances are forbidden', path);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableSafe(item, path + '[' + index + ']', seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
        throw invalid('forbidden runtime or credential field', path + '.' + key);
      }
      assertSerializableSafe(item, path + '.' + key, seen);
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

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid('unknown config field', path + '.' + key);
  }
}

function validateResultKey(value, path) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ||
      ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw invalid('resultKey must be a safe non-empty key', path + '.resultKey');
  }
}

function normalizeAgentConfig(config, path) {
  assertKnownKeys(config, ['goal', 'target', 'skillIds', 'hookIds', 'resultKey', 'readOnly'], path);
  validateResultKey(config.resultKey, path);
  if (typeof config.goal !== 'string' || !config.goal.trim()) {
    throw invalid('agent goal is required', path + '.goal');
  }
  const target = config.target === undefined ? { mode: 'main' } : config.target;
  if (!isPlainObject(target)) throw invalid('target must be a plain object', path + '.target');
  assertKnownKeys(target, ['mode', 'agentDefinitionId', 'agentId'], path + '.target');
  const mode = target.mode || 'main';
  if (!['main', 'native', 'dynamic', 'hub'].includes(mode)) {
    throw invalid('unknown agent target mode', path + '.target.mode');
  }
  if (mode === 'dynamic' && (typeof target.agentDefinitionId !== 'string' || !target.agentDefinitionId.trim())) {
    throw invalid('agentDefinitionId is required for dynamic target', path + '.target.agentDefinitionId');
  }
  if (mode === 'hub' && target.agentId !== undefined &&
      (typeof target.agentId !== 'string' || !target.agentId.trim())) {
    throw invalid('agentId must be a non-empty string', path + '.target.agentId');
  }
  if (config.readOnly !== undefined && typeof config.readOnly !== 'boolean') {
    throw invalid('readOnly must be boolean', path + '.readOnly');
  }
  return {
    ...config,
    goal: config.goal.trim(),
    target: { ...target, mode },
    skillIds: stringArray(config.skillIds || [], path + '.skillIds'),
    hookIds: stringArray(config.hookIds || [], path + '.hookIds')
  };
}

function normalizeToolConfig(config, path) {
  assertKnownKeys(config, ['toolName', 'args', 'hookIds', 'resultKey'], path);
  validateResultKey(config.resultKey, path);
  if (typeof config.toolName !== 'string' || !config.toolName.trim()) {
    throw invalid('toolName is required', path + '.toolName');
  }
  if (config.args !== undefined && !isPlainObject(config.args)) {
    throw invalid('args must be a plain object', path + '.args');
  }
  return {
    ...config,
    toolName: config.toolName.trim(),
    args: config.args || {},
    hookIds: stringArray(config.hookIds || [], path + '.hookIds')
  };
}

function normalizeConditionConfig(config, path) {
  assertKnownKeys(config, ['source', 'operator', 'value', 'resultKey'], path);
  validateResultKey(config.resultKey, path);
  if (typeof config.source !== 'string' || !/^(?:input|steps)\.[A-Za-z0-9_.-]+$/.test(config.source)) {
    throw invalid('source must be a deterministic input/steps path', path + '.source');
  }
  if (!CONDITIONS.includes(config.operator)) {
    throw invalid('unknown condition operator', path + '.operator');
  }
  return { ...config };
}

function normalizeApprovalConfig(config, path) {
  assertKnownKeys(config, ['message', 'resultKey'], path);
  validateResultKey(config.resultKey, path);
  if (typeof config.message !== 'string' || !config.message.trim()) {
    throw invalid('approval message is required', path + '.message');
  }
  return { ...config, message: config.message.trim() };
}

function normalizeStep(input, index) {
  const path = 'definition.steps[' + index + ']';
  if (!isPlainObject(input)) throw invalid('step must be a plain object', path);
  for (const key of Object.keys(input)) {
    if (!STEP_KEYS.has(key)) throw invalid('unknown step field', path + '.' + key);
  }
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw invalid('invalid step id', path + '.id');
  }
  if (!STEP_TYPES.includes(input.type)) throw invalid('unknown step type', path + '.type');
  const dependsOn = stringArray(input.dependsOn || [], path + '.dependsOn');
  const timeoutMs = input.timeoutMs === undefined ? 60000 : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) {
    throw invalid('timeoutMs must be an integer between 1 and 1800000', path + '.timeoutMs');
  }
  const retry = input.retry === undefined ? {} : input.retry;
  if (!isPlainObject(retry) || Object.keys(retry).some(key => key !== 'maxAttempts')) {
    throw invalid('retry only supports maxAttempts', path + '.retry');
  }
  const maxAttempts = retry.maxAttempts === undefined ? 1 : retry.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw invalid('maxAttempts must be an integer between 1 and 3', path + '.retry.maxAttempts');
  }
  const onFailure = input.onFailure === undefined ? 'fail' : input.onFailure;
  if (!FAILURES.includes(onFailure)) throw invalid('unknown onFailure policy', path + '.onFailure');
  const config = input.config === undefined ? {} : input.config;
  if (!isPlainObject(config)) throw invalid('config must be a plain object', path + '.config');
  const normalizedConfig = input.type === 'agent'
    ? normalizeAgentConfig(config, path + '.config')
    : input.type === 'tool'
      ? normalizeToolConfig(config, path + '.config')
      : input.type === 'condition'
        ? normalizeConditionConfig(config, path + '.config')
        : normalizeApprovalConfig(config, path + '.config');
  return { id, type: input.type, dependsOn, config: normalizedConfig, timeoutMs, retry: { maxAttempts }, onFailure };
}

function validateDependencies(steps) {
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) throw invalid('duplicate step id', 'definition.steps.' + step.id);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) throw invalid('self dependency', 'definition.steps.' + step.id + '.dependsOn');
      if (!ids.has(dependency)) throw invalid('unknown dependency ' + dependency, 'definition.steps.' + step.id + '.dependsOn');
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(steps.map(step => [step.id, step]));
  function visit(id) {
    if (visiting.has(id)) throw invalid('workflow contains a cycle', 'definition.steps.' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const step of steps) visit(step.id);
}

function normalizeWorkflowDefinition(input, options = {}) {
  assertSerializableSafe(input);
  if (!isPlainObject(input)) throw invalid('must be a plain object');
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw invalid('unknown field', 'definition.' + key);
  }
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : String(options.id || '').trim();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!id) throw invalid('id is required', 'definition.id');
  if (!name) throw invalid('name is required', 'definition.name');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw invalid('unsupported schemaVersion', 'definition.schemaVersion');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw invalid('description must be a string', 'definition.description');
  }
  const inputs = input.inputs === undefined ? {} : input.inputs;
  const outputs = input.outputs === undefined ? {} : input.outputs;
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!isPlainObject(inputs)) throw invalid('inputs must be a plain object', 'definition.inputs');
  if (!isPlainObject(outputs)) throw invalid('outputs must be a plain object', 'definition.outputs');
  if (!isPlainObject(metadata)) throw invalid('metadata must be a plain object', 'definition.metadata');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw invalid('steps must be a non-empty array', 'definition.steps');
  }
  const limits = input.limits === undefined ? {} : input.limits;
  if (!isPlainObject(limits) || Object.keys(limits).some(key => !['maxSteps', 'maxRuntimeMs'].includes(key))) {
    throw invalid('invalid limits', 'definition.limits');
  }
  const maxSteps = limits.maxSteps === undefined ? 32 : limits.maxSteps;
  const maxRuntimeMs = limits.maxRuntimeMs === undefined ? 1800000 : limits.maxRuntimeMs;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) {
    throw invalid('maxSteps must be an integer between 1 and 32', 'definition.limits.maxSteps');
  }
  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 1800000) {
    throw invalid('maxRuntimeMs must be an integer between 1 and 1800000', 'definition.limits.maxRuntimeMs');
  }
  if (input.steps.length > maxSteps) throw invalid('maxSteps exceeded', 'definition.steps');
  const steps = input.steps.map(normalizeStep);
  validateDependencies(steps);
  return {
    schemaVersion: 1,
    id,
    name,
    description: input.description || '',
    inputs,
    steps,
    outputs,
    limits: { maxSteps, maxRuntimeMs },
    metadata
  };
}

module.exports = {
  ERROR_CODE,
  STEP_TYPES,
  CONDITIONS,
  FAILURES,
  isPlainObject,
  assertSerializableSafe,
  normalizeWorkflowDefinition,
  validateWorkflowDefinition: normalizeWorkflowDefinition,
  invalid
};
