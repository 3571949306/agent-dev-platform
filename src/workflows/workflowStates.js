'use strict';

const STEP_STATES = Object.freeze([
  'PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL',
  'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'
]);
const STEP_TERMINAL = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED']);
const STEP_TRANSITIONS = Object.freeze({
  PENDING: ['READY', 'SKIPPED', 'CANCELLED'],
  READY: ['RUNNING', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELLED: []
});

function canTransition(from, to) {
  return from === to || (STEP_TRANSITIONS[from] || []).includes(to);
}

function transitionStep(store, workflowRunId, stepId, to, patch = {}) {
  if (!STEP_STATES.includes(to)) throw new Error('WORKFLOW_STEP_STATE_INVALID: ' + to);
  const current = store.get(workflowRunId, stepId);
  if (!current) throw new Error('WORKFLOW_STEP_NOT_FOUND: ' + stepId);
  if (!canTransition(current.status, to)) {
    const error = new Error('WORKFLOW_STEP_TRANSITION_INVALID: ' + current.status + ' -> ' + to);
    error.code = 'WORKFLOW_STEP_TRANSITION_INVALID';
    throw error;
  }
  if (STEP_TERMINAL.has(current.status) && current.status !== to) return current;
  return store.update(workflowRunId, stepId, { ...patch, status: to });
}

module.exports = { STEP_STATES, STEP_TERMINAL, STEP_TRANSITIONS, canTransition, transitionStep };
