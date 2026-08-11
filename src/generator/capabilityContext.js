'use strict';

function sorted(values, key = value => value.id || value.name || '') {
  return values.slice().sort((a, b) => String(key(a)).localeCompare(String(key(b))));
}

function capabilityNames(value) {
  if (Array.isArray(value)) return value.slice().sort();
  if (value && typeof value === 'object') return Object.keys(value).filter(key => value[key]).sort();
  return [];
}

function createGeneratorCapabilityContext(options = {}) {
  function build() {
    const toolInputs = typeof options.listTools === 'function' ? options.listTools() : [];
    const tools = sorted((toolInputs || []).map(item => {
      const name = typeof item === 'string' ? item : item && item.name;
      const runtime = name && typeof options.getTool === 'function' ? options.getTool(name) : null;
      return name ? { name, permission: runtime && runtime.permission ? String(runtime.permission) : null } : null;
    }).filter(Boolean), item => item.name);

    const skills = sorted(options.skillRegistry && typeof options.skillRegistry.list === 'function'
      ? options.skillRegistry.list().map(item => ({ id: item.id, name: item.name, enabled: item.enabled !== false }))
      : []);

    const hookRegistry = options.hookEngine && options.hookEngine.registry;
    const handlerRegistry = options.hookEngine && options.hookEngine.handlerRegistry;
    const hooks = sorted(hookRegistry && typeof hookRegistry.list === 'function'
      ? hookRegistry.list().map(item => ({
        id: item.id,
        event: item.event,
        kind: item.kind,
        enabled: item.enabled !== false,
        handlerAvailable: !!(handlerRegistry && typeof handlerRegistry.has === 'function' && handlerRegistry.has(item.handlerId))
      }))
      : []);
    const handlers = handlerRegistry && typeof handlerRegistry.list === 'function' ? handlerRegistry.list() : [];

    const dynamicAgents = options.agentDefinitionStore && typeof options.agentDefinitionStore.list === 'function'
      ? options.agentDefinitionStore.list().map(item => ({
        id: item.id, name: item.name, type: 'dynamic', enabled: true,
        capabilities: capabilityNames(item.capabilities)
      }))
      : [];
    const hubAgents = options.agentRegistry && typeof options.agentRegistry.getManifests === 'function'
      ? options.agentRegistry.getManifests().map(item => ({
        id: item.id, name: item.displayName || item.name || item.id, type: 'hub',
        enabled: item.disabled !== true, capabilities: capabilityNames(item.capabilities)
      }))
      : [];
    const agentMap = new Map();
    for (const item of [...dynamicAgents, ...hubAgents]) agentMap.set(item.type + ':' + item.id, item);
    const agents = sorted([...agentMap.values()], item => item.type + ':' + item.id);

    const models = sorted(options.modelCatalog && typeof options.modelCatalog.listCandidates === 'function'
      ? options.modelCatalog.listCandidates().map(item => ({
        connectionId: item.connectionId,
        modelId: item.modelId,
        capabilities: {
          text: item.capabilities && item.capabilities.text && item.capabilities.text.value === true,
          vision: item.capabilities && item.capabilities.vision && item.capabilities.vision.value === true
        }
      }))
      : [], item => item.connectionId + ':' + item.modelId);

    return { tools, skills, hooks, handlers: handlers.slice().sort(), agents, models };
  }

  return { build };
}

module.exports = { createGeneratorCapabilityContext };
