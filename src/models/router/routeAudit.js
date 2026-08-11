'use strict';

const { sanitizePublic } = require('./publicData');

function routeIdentity(context = {}) {
  return {
    runId: context.runId || null,
    conversationId: context.conversationId || null,
    rootRunId: context.rootRunId || null,
    parentRunId: context.parentRunId || null,
    agentId: context.agentId || null
  };
}

function createRouteAudit(decisionStore) {
  function recordSelection(selection, context = {}) {
    if (!decisionStore || typeof decisionStore.record !== 'function') return null;
    return decisionStore.record(sanitizePublic({
      ...routeIdentity(context),
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
      ...routeIdentity(context),
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
  function bindRunIdentity(decisionId, identity) {
    if (!decisionId || !decisionStore || typeof decisionStore.bindRunIdentity !== 'function') return false;
    const ok = decisionStore.bindRunIdentity(decisionId, sanitizePublic(identity || {}));
    if (!ok) {
      const error = new Error('MODEL_ROUTE_RUN_BINDING_FAILED');
      error.code = 'MODEL_ROUTE_RUN_BINDING_FAILED';
      throw error;
    }
    return true;
  }
  return { recordSelection, recordFailure, recordOutcome, bindRunIdentity };
}

module.exports = { createRouteAudit, routeIdentity };
