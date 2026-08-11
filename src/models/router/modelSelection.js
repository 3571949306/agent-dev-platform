'use strict';

const { sanitizePublic } = require('./publicData');

function identity(candidate) {
  return candidate ? {
    connectionId: candidate.connectionId,
    connectionName: candidate.connectionName,
    provider: candidate.provider,
    protocol: candidate.protocol,
    modelId: candidate.modelId,
    displayName: candidate.displayName
  } : null;
}

function createModelSelection({ selected, mode, requirements, score = null, scoreBreakdown = null, reasons = [], rejected = [], routedAt } = {}) {
  return sanitizePublic({
    selected: identity(selected),
    mode,
    requirements,
    score,
    scoreBreakdown,
    reasons,
    rejectedCandidates: rejected.map(item => ({ candidate: identity(item.candidate), reasons: item.reasons })),
    fallback: null,
    routedAt: routedAt || new Date().toISOString()
  });
}

module.exports = { identity, createModelSelection };
