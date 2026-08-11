'use strict';

const crypto = require('crypto');
const { normalizeAgentDefinition } = require('./agentDefinition');
const { restrictivePolicy } = require('./agentTemplate');
const { DynamicNativeAgentAdapter } = require('./dynamicNativeAgentAdapter');
const { getSkillRuntime } = require('../../skills/runtimeRegistry');

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']);

function skillError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function platformToolNames(options) {
  const provided = typeof options.availableToolNames === 'function'
    ? options.availableToolNames()
    : options.availableToolNames;
  if (Array.isArray(provided) && provided.length) return provided;
  return require('../../tools/registry').listBuiltinDefs().map(def => def.name);
}

function limitError() {
  const error = new Error('DYNAMIC_AGENT_LIMIT_EXCEEDED: maximum dynamic instances for root run reached');
  error.code = 'DYNAMIC_AGENT_LIMIT_EXCEEDED';
  return error;
}

function createAgentFactory(options = {}) {
  const instances = new Map();
  const maxPerRoot = options.maxDynamicInstancesPerRootRun || 8;
  const runMainAgentFn = options.runMainAgentFn || require('../../agent/runtime/mainAgentRuntime').runMainAgent;

  function activeForRoot(rootRunId) {
    return [...instances.values()].filter(instance => instance.rootRunId === rootRunId && instance.status !== 'DISPOSED').length;
  }

  function applyCeilings(definition, context) {
    if (!context.parentPolicy && !context.platformPolicy) return definition;
    const merged = JSON.parse(JSON.stringify(definition));
    for (const ceiling of [context.parentPolicy, context.platformPolicy].filter(Boolean)) {
      merged.toolPolicy = restrictivePolicy(merged.toolPolicy, ceiling.toolPolicy, false);
      merged.permissionPolicy = restrictivePolicy(merged.permissionPolicy, ceiling.permissionPolicy, true);
    }
    return normalizeAgentDefinition(merged, { id: definition.id, templateId: definition.templateId });
  }

  // v2.9.3 Skill Engine（R7）— 在实例创建时解析 Skill 并应用能力边界。
  // 规则：
  //   - required Skills 解析失败（SKILL_*）→ 拒绝创建实例（fail closed）
  //   - optional Skills 解析失败 → 跳过，不影响实例
  //   - Skill deniedTools 合并进定义 toolPolicy.deny（唯一强制点：adapter.getTool）
  //   - Skill ModelRequirements 严格合并进 modelPolicy.requirements（R6）
  //   - Skill Instructions 经 scopedTask.skillInstructions 进入 Prompt 组合（R5）
  function applySkills(definition, context) {
    const required = definition.skills.required || [];
    const optional = definition.skills.optional || [];
    if (!required.length && !optional.length) return { definition, skillInstructions: null };
    const resolver = options.skillResolver || getSkillRuntime().resolver;
    if (!resolver) {
      if (required.length) throw skillError('SKILL_ENGINE_UNAVAILABLE', 'SkillResolver 未注入');
      return { definition, skillInstructions: null };
    }
    const agentContext = {
      toolPolicy: definition.toolPolicy,
      permissionPolicy: definition.permissionPolicy,
      availableTools: platformToolNames(options),
      modelRequirements: definition.modelPolicy.requirements
    };
    const projectContext = context.projectContext || null;
    const resolveSet = ids => resolver.resolve({ requestedSkillIds: ids, agentContext, projectContext });
    const requiredResult = required.length ? resolveSet(required) : null;
    if (requiredResult && !requiredResult.ok) {
      throw skillError(requiredResult.errorCode, requiredResult.error);
    }
    const optionalResult = optional.length ? resolveSet(optional) : null;
    if (!requiredResult && optionalResult && !optionalResult.ok) {
      return { definition, skillInstructions: null };   // optional-only failure → skip
    }
    // required ok + optional failed → 只应用 required（错误技能绝不部分应用）
    const applied = requiredResult && requiredResult.ok ? requiredResult : (optionalResult && optionalResult.ok ? optionalResult : null);
    if (!applied) return { definition, skillInstructions: null };
    const merged = JSON.parse(JSON.stringify(definition));
    merged.toolPolicy.deny = [...new Set([...merged.toolPolicy.deny, ...applied.deniedTools])];
    if (applied.modelRequirements) merged.modelPolicy.requirements = applied.modelRequirements;
    return { definition: merged, skillInstructions: applied.instructions };
  }

  function resolveModel(definition, context) {
    if (typeof options.resolveRuntimeModel === 'function') {
      const result = options.resolveRuntimeModel({
        mode: definition.modelPolicy.mode,
        requirements: definition.modelPolicy.requirements,
        explicit: definition.modelPolicy.mode === 'explicit' ? {
          connectionId: definition.modelPolicy.connectionId,
          modelId: definition.modelPolicy.model
        } : null,
        parentModelAdapter: context.parentModelAdapter || null,
        parentSelection: context.parentModelSelection || null,
        context: {
          ...context,
          runId: null,
          conversationId: context.conversationId || null,
          rootRunId: context.rootRunId || null,
          parentRunId: context.parentRunId || null,
          agentId: context.adapterId || definition.id,
          definition
        }
      });
      if (!result || !result.modelAdapter || typeof result.modelAdapter.decide !== 'function') {
        const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: runtime resolver returned an invalid ModelAdapter');
        error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
        throw error;
      }
      return result;
    }
    if (definition.modelPolicy.mode === 'inherit_parent') {
      if (!context.parentModelAdapter || typeof context.parentModelAdapter.decide !== 'function') {
        const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: parent ModelAdapter is required');
        error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
        throw error;
      }
      return { modelAdapter: context.parentModelAdapter, selection: null };
    }
    if (definition.modelPolicy.mode === 'auto') {
      const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: auto model resolver unavailable');
      error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
      throw error;
    }
    if (typeof options.resolveExplicitModel !== 'function') {
      const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: explicit model resolver unavailable');
      error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
      throw error;
    }
    const adapter = options.resolveExplicitModel(definition.modelPolicy, context);
    if (!adapter || typeof adapter.decide !== 'function') {
      const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: explicit ModelAdapter is invalid');
      error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
      throw error;
    }
    return { modelAdapter: adapter, selection: null };
  }

  function createInstance(input, context = {}) {
    let definition = normalizeAgentDefinition(input);
    definition = applyCeilings(definition, context);
    const skillResult = applySkills(definition, context);
    definition = skillResult.definition;
    const rootRunId = context.rootRunId || context.parentRunId || `standalone-${crypto.randomUUID()}`;
    if (activeForRoot(rootRunId) >= maxPerRoot) throw limitError();

    const instanceId = `dyn-instance-${crypto.randomUUID()}`;
    const adapterId = `dyn-agent-${instanceId.slice('dyn-instance-'.length)}`;
    const actualRootRunId = context.rootRunId || null;
    const modelResolution = resolveModel(definition, { ...context, rootRunId: actualRootRunId, adapterId });
    const instance = {
      instanceId,
      definitionId: definition.id,
      templateId: definition.templateId || null,
      adapterId,
      parentRunId: context.parentRunId || null,
      rootRunId,
      routeRootRunId: actualRootRunId,
      status: 'CREATED',
      lifetime: definition.lifetime,
      createdAt: Date.now(),
      startedAt: null,
      terminalAt: null,
      lifecycleHistory: ['CREATED'],
      adapter: null,
      modelSelection: modelResolution.selection || null,
      definition
    };
    const onState = (status, detail = {}) => {
      if (status === 'RUNNING' && !instance.startedAt) instance.startedAt = Date.now();
      instance.status = status;
      if (instance.lifecycleHistory[instance.lifecycleHistory.length - 1] !== status) instance.lifecycleHistory.push(status);
      if (TERMINAL.has(status)) instance.terminalAt = detail.terminalAt || Date.now();
    };
    instance.adapter = new DynamicNativeAgentAdapter({
      definition,
      instanceId,
      adapterId,
      rootRunId,
      routeRootRunId: actualRootRunId,
      modelAdapter: modelResolution.modelAdapter,
      modelSelection: modelResolution.selection || null,
      bindRouteDecisionToRun: options.bindRouteDecisionToRun || null,
      parentRunId: context.parentRunId || null,
      getTool: context.getTool || options.getTool,
      parentPermissionEngine: context.parentPermissionEngine || null,
      runMainAgentFn,
      emit: context.emit || options.emit,
      skillInstructions: skillResult.skillInstructions,
      onState
    });
    instances.set(instanceId, instance);
    return instance;
  }

  function registerInstance(instanceId, hub) {
    const instance = instances.get(instanceId);
    if (!instance) return null;
    if (!hub || typeof hub.register !== 'function') throw new Error('DYNAMIC_AGENT_HUB_REQUIRED');
    hub.register(instance.adapter);
    instance._hub = hub;
    instance.status = 'REGISTERED';
    instance.lifecycleHistory.push('REGISTERED');
    return instance;
  }

  async function disposeInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) return false;
    try { await instance.adapter.dispose(); } finally {
      if (instance._hub && typeof instance._hub.unregister === 'function') {
        instance._hub.unregister(instance.adapterId);
      }
      instance.status = 'DISPOSED';
      instance.lifecycleHistory.push('DISPOSED');
      instance.terminalAt = instance.terminalAt || Date.now();
      instances.delete(instanceId);
    }
    return true;
  }

  function getInstance(instanceId) {
    return instances.get(instanceId) || null;
  }

  function listInstances() {
    return [...instances.values()];
  }

  function isDefinitionInUse(definitionId) {
    return [...instances.values()].some(instance => instance.definitionId === definitionId && instance.status !== 'DISPOSED');
  }

  function activeTimerCount() {
    return [...instances.values()].reduce((sum, instance) => sum + instance.adapter.activeTimerCount(), 0);
  }

  return { createInstance, registerInstance, disposeInstance, getInstance, listInstances, isDefinitionInUse, activeTimerCount };
}

module.exports = { createAgentFactory };
