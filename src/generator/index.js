'use strict';

const { createGeneratorArtifactAdapterRegistry } = require('./artifactAdapters');
const { createGeneratorCapabilityContext } = require('./capabilityContext');
const { createGeneratorAudit } = require('./generatorAudit');
const { createGeneratorService } = require('./generatorService');

function createGeneratorEngine(options = {}) {
  const adapterRegistry = options.adapterRegistry || createGeneratorArtifactAdapterRegistry({
    agentDefinitionStore: options.agentDefinitionStore,
    skillRegistry: options.skillRegistry,
    hookRegistry: options.hookRegistry || (options.hookEngine && options.hookEngine.registry),
    workflowRegistry: options.workflowRegistry
  });
  const capabilityCatalog = options.capabilityCatalog || createGeneratorCapabilityContext({
    listTools: options.listTools,
    getTool: options.getTool,
    skillRegistry: options.skillRegistry,
    hookEngine: options.hookEngine,
    agentDefinitionStore: options.agentDefinitionStore,
    agentRegistry: options.agentRegistry,
    modelCatalog: options.modelCatalog
  });
  const audit = options.audit || createGeneratorAudit({ store: options.auditStore });
  const service = createGeneratorService({
    adapterRegistry,
    capabilityCatalog,
    resolveRuntimeModel: options.resolveRuntimeModel,
    draftStore: options.draftStore,
    audit,
    requestTimeoutMs: options.requestTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs
  });
  return { service, adapterRegistry, capabilityCatalog, audit };
}

module.exports = {
  ...require('./errors'),
  ...require('./generatorRequest'),
  ...require('./generationProtocol'),
  ...require('./capabilityContext'),
  ...require('./artifactAdapters'),
  ...require('./generatorAudit'),
  ...require('./generatorService'),
  createGeneratorEngine
};
