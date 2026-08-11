'use strict';

const { sanitizePublic } = require('./publicData');

const EVIDENCE_STATES = new Set(['tested', 'declared', 'inferred', 'unknown']);

function evidence(input, options = {}) {
  const numeric = options.numeric === true;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const state = EVIDENCE_STATES.has(input.state) ? input.state : 'unknown';
    const validValue = numeric
      ? (typeof input.value === 'number' && Number.isFinite(input.value) && input.value >= 0)
      : (typeof input.value === 'boolean');
    return { value: validValue ? input.value : null, state: validValue ? state : 'unknown', source: typeof input.source === 'string' ? input.source : null };
  }
  // Legacy booleans/numbers have a value but no proof; preserve them as inferred.
  if ((!numeric && typeof input === 'boolean') || (numeric && typeof input === 'number' && Number.isFinite(input) && input >= 0)) {
    return { value: input, state: 'inferred', source: 'legacy-unstructured' };
  }
  return { value: null, state: 'unknown', source: null };
}

function metricValue(input) {
  const ev = evidence(input, { numeric: true });
  return ev.value === null ? null : ev;
}

function normalizeModelCandidate(input) {
  if (!input || typeof input !== 'object') throw new Error('MODEL_CANDIDATE_INVALID');
  const connectionId = typeof input.connectionId === 'string' ? input.connectionId.trim() : '';
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!connectionId || !modelId || !provider) throw new Error('MODEL_CANDIDATE_INVALID: connectionId, provider and modelId are required');
  const caps = input.capabilities || {};
  const pricing = input.pricing || {};
  const latency = input.latency || {};
  const contextWindow = metricValue(input.contextWindow);
  return sanitizePublic({
    connectionId,
    connectionName: typeof input.connectionName === 'string' ? input.connectionName : connectionId,
    provider,
    protocol: typeof input.protocol === 'string' && input.protocol ? input.protocol : provider,
    modelId,
    displayName: typeof input.displayName === 'string' && input.displayName ? input.displayName : modelId,
    enabled: input.enabled !== false && input.enabled !== 0,
    authenticated: input.authenticated === true,
    capabilities: {
      text: evidence(caps.text),
      vision: evidence(caps.vision),
      nativeTools: evidence(caps.nativeTools === undefined ? caps.tools : caps.nativeTools),
      streaming: evidence(caps.streaming)
    },
    contextWindow: contextWindow || { value: null, state: 'unknown', source: null },
    pricing: {
      input: metricValue(pricing.input),
      output: metricValue(pricing.output),
      currency: typeof pricing.currency === 'string' ? pricing.currency : null,
      source: typeof pricing.source === 'string' ? pricing.source : null
    },
    latency: {
      ms: typeof latency.ms === 'number' && Number.isFinite(latency.ms) && latency.ms >= 0 ? latency.ms : null,
      source: typeof latency.source === 'string' ? latency.source : null,
      measuredAt: typeof latency.measuredAt === 'string' ? latency.measuredAt : null
    },
    locality: ['local', 'remote', 'unknown'].includes(input.locality) ? input.locality : 'unknown',
    metadata: sanitizePublic(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
  });
}

module.exports = { EVIDENCE_STATES, evidence, normalizeModelCandidate };
