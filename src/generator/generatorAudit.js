'use strict';

const crypto = require('crypto');

function intentEvidence(intent) {
  const value = String(intent || '');
  return {
    intentHash: crypto.createHash('sha256').update(value).digest('hex'),
    intentLength: value.length
  };
}

function createGeneratorAudit({ store } = {}) {
  const memory = [];
  function record(input) {
    const entry = {
      auditId: input.auditId || crypto.randomUUID(),
      generationId: input.generationId,
      draftId: input.draftId || null,
      artifactType: input.artifactType || null,
      status: input.status,
      attemptCount: Math.max(0, Number(input.attemptCount) || 0),
      repairCount: Math.max(0, Number(input.repairCount) || 0),
      routeDecisionId: input.routeDecisionId || null,
      selectedConnectionId: input.selectedConnectionId || null,
      selectedModelId: input.selectedModelId || null,
      validationCodes: [...new Set((input.validationCodes || []).map(String))].sort().slice(0, 50),
      savedArtifactId: input.savedArtifactId || null,
      intentHash: input.intentHash || null,
      intentLength: Math.max(0, Number(input.intentLength) || 0),
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      createdAt: input.createdAt || new Date().toISOString()
    };
    if (store && typeof store.create === 'function') return store.create(entry);
    memory.push(structuredClone(entry));
    return structuredClone(entry);
  }
  function list(limit = 100) {
    if (store && typeof store.list === 'function') return store.list(limit);
    return memory.slice(-limit).reverse().map(value => structuredClone(value));
  }
  return { record, list };
}

module.exports = { intentEvidence, createGeneratorAudit };
