'use strict';

const { sanitizePublic } = require('./publicData');

function createRouteAudit(decisionStore) {
  function recordSelection(selection, context = {}) {
    if (!decisionStore || typeof decisionStore.record !== 'function') return null;
    return decisionStore.record(sanitizePublic({
      runId: context.runId || null,
      agentId: context.agentId || null,
      connectionId: selection.selected && selection.selected.connectionId,
      modelId: selection.selected && selection.selected.modelId,
      mode: selection.mode,
      requirements: selection.requirements,
      score: selection.score,
      reasons: selection.reasons,
      rejectedCandidates: selection.rejectedCandidates,
      status: 'routed'
    }));
  }

  function recordFailure({ mode, requirements, rejectedCandidates, errorCode }, context = {}) {
    if (!decisionStore || typeof decisionStore.record !== 'function') return null;
    return decisionStore.record(sanitizePublic({
      runId: context.runId || null,
      agentId: context.agentId || null,
      connectionId: null,
      modelId: null,
      mode,
      requirements,
      score: null,
      reasons: [{ code: errorCode }],
      rejectedCandidates,
      status: 'route_failed',
      errorCode
    }));
  }

  function recordOutcome(decisionId, outcome) {
    if (!decisionId || !decisionStore || typeof decisionStore.updateOutcome !== 'function') return false;
    return decisionStore.updateOutcome(decisionId, sanitizePublic(outcome));
  }
  return { recordSelection, recordFailure, recordOutcome };
}

module.exports = { createRouteAudit };
