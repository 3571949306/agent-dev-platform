'use strict';

const { createWorkflowRegistry } = require('./workflowRegistry');
const { createWorkflowAudit } = require('./workflowAudit');
const { createWorkflowRuntime } = require('./workflowRuntime');

function createWorkflowEngine(options = {}) {
  const registry = options.registry || createWorkflowRegistry({ store: options.definitionStore });
  const audit = options.audit || createWorkflowAudit({ store: options.auditStore });
  const runtime = options.runtime || createWorkflowRuntime({
    ...options,
    registry,
    audit,
    executionStore: options.executionStore,
    stepStore: options.stepStore
  });
  return { registry, audit, runtime };
}

module.exports = { createWorkflowEngine };
