'use strict';

/**
 * Thin application-service facade used by IPC and production smoke tests.
 * This is deliberately not an execution runtime: every method delegates to
 * one of the frozen production services.
 */
function createProductEntry({ mainAgentService, workflowRuntime, generatorService } = {}) {
  if (!mainAgentService || typeof mainAgentService.run !== 'function') {
    throw new Error('PRODUCT_ENTRY_MAIN_AGENT_REQUIRED');
  }
  if (!workflowRuntime || typeof workflowRuntime.run !== 'function') {
    throw new Error('PRODUCT_ENTRY_WORKFLOW_REQUIRED');
  }
  if (!generatorService || typeof generatorService.generate !== 'function') {
    throw new Error('PRODUCT_ENTRY_GENERATOR_REQUIRED');
  }

  return Object.freeze({
    mainAgent: Object.freeze({
      run: input => mainAgentService.run(input),
      stop: input => mainAgentService.stop(input)
    }),
    workflow: Object.freeze({
      run: (id, input, runtime) => workflowRuntime.run(id, input, runtime),
      cancel: workflowRunId => workflowRuntime.cancel(workflowRunId),
      approve: workflowRunId => workflowRuntime.approve(workflowRunId),
      reject: workflowRunId => workflowRuntime.reject(workflowRunId)
    }),
    generator: Object.freeze({
      generate: request => generatorService.generate(request),
      validate: draftId => generatorService.validate(draftId),
      save: draftId => generatorService.save(draftId),
      cancel: draftId => generatorService.cancel(draftId)
    })
  });
}

module.exports = { createProductEntry };
