'use strict';

const ACTIVE_WORKFLOW = new Set(['PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL']);
const ACTIVE_WORKFLOW_STEP = new Set(['PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL']);
const ACTIVE_GENERATOR = new Set(['GENERATING', 'VALIDATING', 'REPAIRING']);

/**
 * Reconcile durable records with a freshly started process. In-memory
 * controllers and child processes cannot survive restart, so persisted active
 * states must never continue to look live.
 *
 * v2.9.9 Phase B Final（B22）— 在标记终态之前先收集 Recovery 快照：
 * 被中断的 Run / Workflow / Generator 的真实身份与阶段，供 Recovery Center
 * 呈现。快照只用于展示与「新建任务草稿」，绝不用于复活旧 Run。
 */
function recoverInterruptedRuntime({ store, runManager, now = () => new Date().toISOString() } = {}) {
  const recovered = { runs: 0, workflows: 0, workflowSteps: 0, generatorDrafts: 0 };
  const snapshot = { interruptedRuns: [], interruptedWorkflows: [], interruptedDrafts: [] };

  // 先采集再标记：快照必须反映中断前的真实阶段
  if (store && store.runs && typeof store.runs.listNonTerminal === 'function') {
    try {
      for (const r of store.runs.listNonTerminal()) {
        snapshot.interruptedRuns.push({
          runId: r.id,
          conversationId: r.conversation_id || r.conversationId || null,
          agentId: r.agent_id || r.agentId || null,
          status: r.status || 'unknown',
          lastStage: r.stage || 'unknown',
          message: r.message || null,
          lastActivityAt: r.last_activity_at || r.lastActivityAt || null,
          verification: r.verification_status || null
        });
      }
    } catch { /* snapshot stays partial */ }
  }

  if (runManager && typeof runManager.interruptStale === 'function') {
    recovered.runs = runManager.interruptStale();
  }

  const terminalAt = now();
  if (store && store.workflowExecutions) {
    for (const execution of store.workflowExecutions.list(10000)) {
      if (!ACTIVE_WORKFLOW.has(execution.status)) continue;
      snapshot.interruptedWorkflows.push({
        workflowRunId: execution.workflowRunId,
        workflowId: execution.workflowId,
        lastStatus: execution.status,
        currentStepId: execution.currentStepId || null,
        projectId: execution.projectId || null
      });
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
      snapshot.interruptedDrafts.push({
        draftId: draft.draftId,
        artifactType: draft.artifactType,
        lastStatus: draft.status
      });
      store.generatorDrafts.update(draft.draftId, {
        status: 'FAILED',
        errorCode: 'GENERATOR_INTERRUPTED',
        error: 'Application restarted while this generator draft was active.',
        terminalAt
      });
      recovered.generatorDrafts++;
    }
  }
  return { ...recovered, snapshot };
}

module.exports = { recoverInterruptedRuntime, ACTIVE_WORKFLOW, ACTIVE_GENERATOR };
