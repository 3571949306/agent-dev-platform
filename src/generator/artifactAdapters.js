'use strict';

const { normalizeAgentDefinition, DEFAULTS: AGENT_DEFAULTS } = require('../agents/dynamic/agentDefinition');
const { normalizeSkillDefinition, expandToolNames } = require('../skills/skillDefinition');
const { normalizeHookDefinition, EVENTS: HOOK_EVENTS, KINDS: HOOK_KINDS } = require('../hooks/hookDefinition');
const { normalizeWorkflowDefinition, STEP_TYPES, CONDITIONS } = require('../workflows/workflowDefinition');
const { generatorError } = require('./errors');

const AUTHORITY_KEYS = new Set([
  'apikey', 'authorization', 'bearer', 'cookie', 'password', 'secret',
  'accesstoken', 'refreshtoken', 'credential', 'credentials', 'rawprovider',
  'provider', 'modeladapter', 'agentadapter', 'permissionengine',
  'grantpermissions', 'bypasspermission', 'toolimplementation', 'abortcontroller',
  'function', 'callback', 'eval', 'javascript', 'webhook'
]);
const SECRET_TEXT = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertGeneratorAuthoritySafe(value, path = 'candidate', seen = new Set()) {
  if (typeof value === 'function') {
    throw generatorError('GENERATOR_AUTHORITY_FORBIDDEN', `${path}: functions are forbidden`);
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && SECRET_TEXT.test(value)) {
      throw generatorError('GENERATOR_AUTHORITY_FORBIDDEN', `${path}: credential-shaped output is forbidden`);
    }
    return;
  }
  if (seen.has(value)) throw generatorError('GENERATOR_AUTHORITY_FORBIDDEN', `${path}: cyclic values are forbidden`);
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(normalizedKey(key))) {
      throw generatorError('GENERATOR_AUTHORITY_FORBIDDEN', `${path}.${key}: authority/runtime field is forbidden`);
    }
    assertGeneratorAuthoritySafe(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function referenceError(type, id, disabled = false) {
  return generatorError(
    disabled ? 'GENERATOR_REFERENCE_DISABLED' : 'GENERATOR_REFERENCE_UNAVAILABLE',
    `${type} reference '${id}' is ${disabled ? 'disabled' : 'unavailable'}`,
    { referenceType: type, id }
  );
}

function requireReference(items, id, type) {
  const found = (items || []).find(item => item.id === id || item.name === id);
  if (!found) throw referenceError(type, id);
  if (found.enabled === false || found.handlerAvailable === false) throw referenceError(type, id, true);
  return found;
}

function assertTargetAvailable(adapter, candidate) {
  if (adapter.exists(candidate.id)) {
    throw generatorError('GENERATOR_TARGET_EXISTS', `${adapter.type} '${candidate.id}' already exists`);
  }
}

function normalizeAgentCandidate(candidate) {
  assertGeneratorAuthoritySafe(candidate);
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw generatorError('DYNAMIC_AGENT_DEFINITION_INVALID', 'definition.id: id is required');
  }
  return normalizeAgentDefinition(candidate);
}

function normalizeSkillCandidate(candidate) {
  assertGeneratorAuthoritySafe(candidate);
  return normalizeSkillDefinition(candidate);
}

function normalizeHookCandidate(candidate) {
  assertGeneratorAuthoritySafe(candidate);
  return normalizeHookDefinition(candidate);
}

function normalizeWorkflowCandidate(candidate) {
  assertGeneratorAuthoritySafe(candidate);
  return normalizeWorkflowDefinition(candidate);
}

function agentContract() {
  return {
    sourceOfTruth: 'normalizeAgentDefinition',
    artifact: 'Dynamic Native Agent Definition only',
    required: ['schemaVersion=1', 'id', 'name'],
    defaults: {
      schemaVersion: AGENT_DEFAULTS.schemaVersion,
      runtime: AGENT_DEFAULTS.runtime,
      modelPolicy: AGENT_DEFAULTS.modelPolicy,
      skills: AGENT_DEFAULTS.skills,
      hooks: AGENT_DEFAULTS.hooks,
      lifetime: AGENT_DEFAULTS.lifetime
    },
    restrictions: ['runtime.kind=native', 'no external adapter configuration', 'no credentials', 'no runtime objects']
  };
}

function skillContract() {
  return {
    sourceOfTruth: 'normalizeSkillDefinition',
    required: ['schemaVersion=1', 'id', 'name', 'instructions'],
    fields: ['description', 'tags', 'toolRequirements', 'permissionRequirements', 'modelRequirements', 'compatibility', 'requiresSkills', 'metadata'],
    invariant: 'requirements do not grant authority'
  };
}

function hookContract() {
  return {
    sourceOfTruth: 'normalizeHookDefinition',
    required: ['schemaVersion=1', 'id', 'name', 'event', 'kind', 'handlerId'],
    events: HOOK_EVENTS,
    kinds: HOOK_KINDS,
    invariant: 'handlerId must already be a trusted registered handler; no handler code'
  };
}

function workflowContract() {
  return {
    sourceOfTruth: 'normalizeWorkflowDefinition',
    required: ['schemaVersion=1', 'id', 'name', 'steps'],
    stepTypes: STEP_TYPES,
    conditionOperators: CONDITIONS,
    invariant: 'serial DAG configuration only; no loop, parallel, nested workflow, script, webhook, or eval'
  };
}

function createAgentAdapter(options) {
  return {
    type: 'agent',
    getGenerationContract: agentContract,
    normalize: normalizeAgentCandidate,
    validate: normalizeAgentCandidate,
    validateReferences(candidate, context) {
      for (const name of [...candidate.toolPolicy.allow, ...candidate.toolPolicy.deny]) {
        if (!context.tools.some(tool => tool.name === name)) throw referenceError('tool', name);
      }
      for (const id of [...candidate.skills.required, ...candidate.skills.optional]) requireReference(context.skills, id, 'skill');
      for (const id of [...candidate.hooks.required, ...candidate.hooks.optional]) requireReference(context.hooks, id, 'hook');
      if (candidate.modelPolicy.mode === 'explicit') {
        const exists = context.models.some(model => model.connectionId === candidate.modelPolicy.connectionId && model.modelId === candidate.modelPolicy.model);
        if (!exists) throw referenceError('model', `${candidate.modelPolicy.connectionId}:${candidate.modelPolicy.model}`);
      }
      return candidate;
    },
    exists(id) { return !!(options.agentDefinitionStore && options.agentDefinitionStore.get(id)); },
    save(candidate) {
      assertTargetAvailable(this, candidate);
      return options.agentDefinitionStore.create(candidate);
    }
  };
}

function createSkillAdapter(options) {
  return {
    type: 'skill',
    getGenerationContract: skillContract,
    normalize: normalizeSkillCandidate,
    validate: normalizeSkillCandidate,
    validateReferences(candidate, context) {
      const tools = expandToolNames([
        ...candidate.toolRequirements.required,
        ...candidate.toolRequirements.optional,
        ...candidate.toolRequirements.denied
      ]);
      for (const name of tools) if (!context.tools.some(tool => tool.name === name)) throw referenceError('tool', name);
      for (const id of candidate.requiresSkills) requireReference(context.skills, id, 'skill');
      return candidate;
    },
    exists(id) { return !!options.skillRegistry.get(id); },
    save(candidate) {
      assertTargetAvailable(this, candidate);
      const saved = options.skillRegistry.create(candidate);
      return options.skillRegistry.disable(saved.id);
    }
  };
}

function createHookAdapter(options) {
  return {
    type: 'hook',
    getGenerationContract: hookContract,
    normalize: normalizeHookCandidate,
    validate: normalizeHookCandidate,
    validateReferences(candidate, context) {
      if (!context.handlers.includes(candidate.handlerId)) throw referenceError('handler', candidate.handlerId);
      return candidate;
    },
    exists(id) { return !!options.hookRegistry.get(id); },
    save(candidate) {
      assertTargetAvailable(this, candidate);
      const saved = options.hookRegistry.create(candidate);
      return options.hookRegistry.disable(saved.id);
    }
  };
}

function createWorkflowAdapter(options) {
  return {
    type: 'workflow',
    getGenerationContract: workflowContract,
    normalize: normalizeWorkflowCandidate,
    validate: normalizeWorkflowCandidate,
    validateReferences(candidate, context) {
      for (const step of candidate.steps) {
        if (step.type === 'tool') {
          if (!context.tools.some(tool => tool.name === step.config.toolName)) throw referenceError('tool', step.config.toolName);
          for (const id of step.config.hookIds || []) requireReference(context.hooks, id, 'hook');
        }
        if (step.type === 'agent') {
          for (const id of step.config.skillIds || []) requireReference(context.skills, id, 'skill');
          for (const id of step.config.hookIds || []) requireReference(context.hooks, id, 'hook');
          const target = step.config.target || { mode: 'main' };
          if (target.mode === 'dynamic') requireReference(
            context.agents.filter(agent => agent.type === 'dynamic'), target.agentDefinitionId, 'dynamic-agent'
          );
          if (target.mode === 'hub' && target.agentId) requireReference(
            context.agents.filter(agent => agent.type === 'hub'), target.agentId, 'hub-agent'
          );
        }
      }
      return candidate;
    },
    exists(id) { return !!options.workflowRegistry.get(id); },
    save(candidate) {
      assertTargetAvailable(this, candidate);
      const saved = options.workflowRegistry.create(candidate);
      return options.workflowRegistry.disable(saved.id);
    }
  };
}

function createGeneratorArtifactAdapterRegistry(options = {}) {
  const adapters = new Map();
  function register(adapter) {
    if (!adapter || typeof adapter.type !== 'string') throw generatorError('GENERATOR_ADAPTER_INVALID', 'adapter type is required');
    for (const method of ['getGenerationContract', 'normalize', 'validate', 'validateReferences', 'save', 'exists']) {
      if (typeof adapter[method] !== 'function') throw generatorError('GENERATOR_ADAPTER_INVALID', `${adapter.type}.${method} is required`);
    }
    adapters.set(adapter.type, adapter);
    return adapter;
  }
  function get(type) {
    const adapter = adapters.get(type);
    if (!adapter) throw generatorError('GENERATOR_ARTIFACT_TYPE_UNSUPPORTED', `no adapter for '${type}'`);
    return adapter;
  }
  function list() { return [...adapters.keys()].sort(); }
  register(createAgentAdapter(options));
  register(createSkillAdapter(options));
  register(createHookAdapter(options));
  register(createWorkflowAdapter(options));
  return { register, get, list };
}

module.exports = {
  createGeneratorArtifactAdapterRegistry,
  createAgentAdapter,
  createSkillAdapter,
  createHookAdapter,
  createWorkflowAdapter,
  referenceError,
  assertGeneratorAuthoritySafe
};
