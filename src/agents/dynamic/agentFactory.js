'use strict';

const crypto = require('crypto');
const { normalizeAgentDefinition } = require('./agentDefinition');
const { restrictivePolicy } = require('./agentTemplate');
const { DynamicNativeAgentAdapter } = require('./dynamicNativeAgentAdapter');
const { getSkillRuntime } = require('../../skills/runtimeRegistry');
const { normalizePlatform } = require('../../skills/skillResolver');
const { getHookRuntime } = require('../../hooks/runtimeRegistry');

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

  // v2.9.3 Skill Engine（R4/R7）— 在实例创建时解析 Skill 并应用能力边界。
  // 规则：
  //   - required Skills 解析失败（SKILL_*）→ 拒绝创建实例（fail closed）
  //   - optional Skills 解析失败 → 跳过，不影响实例
  //   - Skill deniedTools 合并进定义 toolPolicy.deny（唯一强制点：adapter.getTool）
  //   - Skill ModelRequirements 严格合并进 modelPolicy.requirements（R6）
  //   - Skill Instructions 经 scopedTask.skillInstructions 进入 Prompt 组合（R5）
  //   - R4A: required + optional 合并为同一个最终集合，再次整体解析一次
  //   - R4B: 把 Parent PermissionEngine 的真实授权状态作为 permissionCheck 传入
  //          Resolver；父级 deny/ask 的必需权限 → createInstance 失败（fail fast）
  function applySkills(definition, context) {
    const required = definition.skills.required || [];
    const optional = definition.skills.optional || [];
    if (!required.length && !optional.length) return { definition, skillInstructions: null, skillIds: [] };
    const resolver = options.skillResolver || getSkillRuntime().resolver;
    if (!resolver) {
      if (required.length) throw skillError('SKILL_ENGINE_UNAVAILABLE', 'SkillResolver 未注入');
      return { definition, skillInstructions: null, skillIds: [] };
    }
    const agentContext = {
      toolPolicy: definition.toolPolicy,
      permissionPolicy: definition.permissionPolicy,
      availableTools: platformToolNames(options),
      modelRequirements: definition.modelPolicy.requirements,
      agentType: definition.agentType || 'native',
      // R4B — Parent PermissionEngine 的真实授权状态：必需权限未被父级授予
      // （deny / ask）→ 视为未持有，Factory 阶段即失败（fail fast），而非等到
      // 真正 executeAction 才抛 PermissionDenied。
      permissionCheck: context.parentPermissionEngine
        ? scope => context.parentPermissionEngine.evaluate(scope, context) === 'allow'
        : null
    };
    const projectContext = {
      platform: normalizePlatform(process.platform),
      projectRoot: (context.projectContext && context.projectContext.projectRoot) || null,
      projectId: (context.projectContext && context.projectContext.projectId) || null,
      signals: (context.projectContext && context.projectContext.signals) || null
    };
    // R4A — required + optional 经单次 resolveWithOptions 合并为同一最终集合：
    //   required 失败 → fail closed；optional 失败 → 跳过；最终集合整体再解析一次
    //   （交叉 deny/require 冲突、模型合并、R3 兼容均重新校验）。
    const result = resolver.resolveWithOptions
      ? resolver.resolveWithOptions({ requiredSkillIds: required, optionalSkillIds: optional, agentContext, projectContext })
      : resolver.resolve({ requestedSkillIds: [...required, ...optional], agentContext, projectContext });
    if (!result.ok) {
      throw skillError(result.errorCode, result.error);
    }
    const merged = JSON.parse(JSON.stringify(definition));
    merged.toolPolicy.deny = [...new Set([...merged.toolPolicy.deny, ...result.deniedTools])];
    if (result.modelRequirements) merged.modelPolicy.requirements = result.modelRequirements;
    return { definition: merged, skillInstructions: result.instructions, skillIds: result.skills.map(skill => skill.id) };
  }

  function applyHooks(definition) {
    const required = definition.hooks.required || [];
    const optional = definition.hooks.optional || [];
    if (!required.length && !optional.length) return { hookIds: [], skipped: [] };
    const engine = options.hookEngine || getHookRuntime();
    if (!engine || !engine.resolver) {
      if (required.length) throw skillError('HOOK_ENGINE_UNAVAILABLE', 'required Dynamic Agent hooks cannot be resolved');
      return { hookIds: [], skipped: optional.map(hookId => ({ hookId, reason: 'HOOK_ENGINE_UNAVAILABLE' })) };
    }
    const result = engine.resolver.resolveSelection({ requiredHookIds: required, optionalHookIds: optional });
    if (!result.ok) throw skillError(result.errorCode, result.error);
    return { hookIds: result.hookIds, skipped: result.skipped || [] };
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
    const hookResult = applyHooks(definition);
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
      hookIds: hookResult.hookIds,
      hookSkips: hookResult.skipped,
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
      skillIds: skillResult.skillIds,
      hookIds: hookResult.hookIds,
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
