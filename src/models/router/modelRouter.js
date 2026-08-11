'use strict';

const { normalizeModelRequirements } = require('./modelRequirements');
const { normalizeModelCandidate } = require('./modelCandidate');
const { filterCandidates } = require('./modelFilter');
const { scoreCandidates } = require('./modelScorer');
const { createModelSelection } = require('./modelSelection');

function routeError(code, message, rejectedCandidates) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.rejectedCandidates = rejectedCandidates || [];
  return error;
}

function createModelRouter({ catalog, audit } = {}) {
  if (!catalog || typeof catalog.listCandidates !== 'function') throw new Error('MODEL_ROUTER_CATALOG_REQUIRED');

  function select({ mode = 'auto', requirements: inputRequirements = {}, explicit = null, context = {} } = {}) {
    if (!['auto', 'explicit'].includes(mode)) throw routeError('MODEL_ROUTE_MODE_INVALID', `unsupported mode ${mode}`);
    const requirements = normalizeModelRequirements(inputRequirements);
    const candidates = catalog.listCandidates().map(normalizeModelCandidate);
    let pool = candidates;
    if (mode === 'explicit') {
      if (!explicit || typeof explicit.connectionId !== 'string' || typeof explicit.modelId !== 'string') {
        throw routeError('MODEL_ROUTE_EXPLICIT_INVALID', 'connectionId and modelId are required');
      }
      pool = candidates.filter(candidate => candidate.connectionId === explicit.connectionId && candidate.modelId === explicit.modelId);
      if (!pool.length) {
        const error = routeError('MODEL_ROUTE_EXPLICIT_NOT_FOUND', 'explicit candidate does not exist');
        if (audit) error.decisionId = audit.recordFailure({ mode, requirements, rejectedCandidates: [], errorCode: error.code }, context);
        throw error;
      }
    }
    const filtered = filterCandidates(requirements, pool);
    if (!filtered.eligible.length) {
      const rejectedCandidates = filtered.rejected.map(item => ({
        candidate: { connectionId: item.candidate.connectionId, provider: item.candidate.provider, modelId: item.candidate.modelId },
        reasons: item.reasons
      }));
      const error = routeError('MODEL_ROUTE_NO_CANDIDATE', 'all candidates failed hard constraints', rejectedCandidates);
      if (audit) error.decisionId = audit.recordFailure({ mode, requirements, rejectedCandidates, errorCode: error.code }, context);
      throw error;
    }
    const scored = scoreCandidates(requirements, filtered.eligible);
    const winner = scored[0];
    const selection = createModelSelection({
      selected: winner.candidate,
      mode,
      requirements,
      score: winner.totalScore,
      scoreBreakdown: winner.breakdown,
      reasons: [
        { code: mode === 'explicit' ? 'EXPLICIT_EXACT_MATCH' : 'HIGHEST_DETERMINISTIC_SCORE' },
        { code: 'HARD_CONSTRAINTS_SATISFIED' },
        ...(winner.reasons || [])
      ],
      rejected: filtered.rejected
    });
    if (audit) selection.decisionId = audit.recordSelection(selection, context);
    return selection;
  }

  return { select };
}

module.exports = { createModelRouter, routeError };
