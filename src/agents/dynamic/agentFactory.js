'use strict';

const crypto = require('crypto');
const { normalizeAgentDefinition } = require('./agentDefinition');
const { restrictivePolicy } = require('./agentTemplate');
const { DynamicNativeAgentAdapter } = require('./dynamicNativeAgentAdapter');

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']);

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

  function resolveModelAdapter(definition, context) {
    if (definition.modelPolicy.mode === 'inherit_parent') {
      if (!context.parentModelAdapter || typeof context.parentModelAdapter.decide !== 'function') {
        const error = new Error('DYNAMIC_AGENT_MODEL_UNRESOLVED: parent ModelAdapter is required');
        error.code = 'DYNAMIC_AGENT_MODEL_UNRESOLVED';
        throw error;
      }
      return context.parentModelAdapter;
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
    return adapter;
  }

  function createInstance(input, context = {}) {
    let definition = normalizeAgentDefinition(input);
    definition = applyCeilings(definition, context);
    const rootRunId = context.rootRunId || context.parentRunId || `standalone-${crypto.randomUUID()}`;
    if (activeForRoot(rootRunId) >= maxPerRoot) throw limitError();

    const instanceId = `dyn-instance-${crypto.randomUUID()}`;
    const adapterId = `dyn-agent-${instanceId.slice('dyn-instance-'.length)}`;
    const instance = {
      instanceId,
      definitionId: definition.id,
      templateId: definition.templateId || null,
      adapterId,
      parentRunId: context.parentRunId || null,
      rootRunId,
      status: 'CREATED',
      lifetime: definition.lifetime,
      createdAt: Date.now(),
      startedAt: null,
      terminalAt: null,
      lifecycleHistory: ['CREATED'],
      adapter: null,
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
      modelAdapter: resolveModelAdapter(definition, context),
      getTool: context.getTool || options.getTool,
      parentPermissionEngine: context.parentPermissionEngine || null,
      runMainAgentFn,
      emit: context.emit || options.emit,
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
