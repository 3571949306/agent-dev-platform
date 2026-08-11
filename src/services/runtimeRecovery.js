'use strict';

const ACTIVE_WORKFLOW = new Set(['PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL']);
const ACTIVE_WORKFLOW_STEP = new Set(['PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL']);
const ACTIVE_GENERATOR = new Set(['GENERATING', 'VALIDATING', 'REPAIRING']);

/**
 * Reconcile durable records with a freshly started process. In-memory
 * controllers and child processes cannot survive restart, so persisted active
 * states must never continue to look live.
 */
function recoverInterruptedRuntime({ store, runManager, now = () => new Date().toISOString() } = {}) {
  const recovered = { runs: 0, workflows: 0, workflowSteps: 0, generatorDrafts: 0 };
  if (runManager && typeof runManager.interruptStale === 'function') {
    recovered.runs = runManager.interruptStale();
  }

  const terminalAt = now();
  if (store && store.workflowExecutions) {
    for (const execution of store.workflowExecutions.list(10000)) {
      if (!ACTIVE_WORKFLOW.has(execution.status)) continue;
      if (store.workflowStepExecutions) {
        for (const step of store.workflowStepExecutions.listByRun(execution.workflowRunId)) {
          if (!ACTIVE_WORKFLOW_STEP.has(step.status)) continue;
          store.workflowStepExecutions.update(execution.workflowRunId, step.stepId, {
            status: 'CANCELLED',
            errorCode: 'WORKFLOW_INTERRUPTED',
            error: 'Application restarted while this workflow step was active.',
            terminalAt
          });
          recovered.workflowSteps++;
        }
      }
      store.workflowExecutions.update(execution.workflowRunId, {
        status: 'FAILED',
        errorCode: 'WORKFLOW_INTERRUPTED',
        error: 'Application restarted while this workflow was active.',
        terminalAt
      });
      recovered.workflows++;
    }
  }

  if (store && store.generatorDrafts) {
    for (const draft of store.generatorDrafts.list(10000)) {
      if (!ACTIVE_GENERATOR.has(draft.status)) continue;
      store.generatorDrafts.update(draft.draftId, {
        status: 'FAILED',
        errorCode: 'GENERATOR_INTERRUPTED',
        error: 'Application restarted while this generator draft was active.',
        terminalAt
      });
      recovered.generatorDrafts++;
    }
  }
  return recovered;
}

module.exports = { recoverInterruptedRuntime, ACTIVE_WORKFLOW, ACTIVE_GENERATOR };
