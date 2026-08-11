'use strict';

const definition = require('./workflowDefinition');
const { compileWorkflow } = require('./workflowCompiler');
const { createWorkflowRegistry } = require('./workflowRegistry');
const { createWorkflowAudit } = require('./workflowAudit');
const { createWorkflowRuntime } = require('./workflowRuntime');
const { createWorkflowEngine } = require('./workflowEngine');
const states = require('./workflowStates');
const context = require('./workflowContext');

module.exports = {
  ...definition,
  ...states,
  ...context,
  compileWorkflow,
  createWorkflowRegistry,
  createWorkflowAudit,
  createWorkflowRuntime,
  createWorkflowEngine
};
