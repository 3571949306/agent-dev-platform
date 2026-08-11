'use strict';

const PROVEN_STATES = new Set(['tested', 'declared']);

function reason(code, detail = {}) { return { code, ...detail }; }

function isProvenTrue(item) {
  return !!item && item.value === true && PROVEN_STATES.has(item.state);
}

function filterCandidates(requirements, candidates) {
  const eligible = [];
  const rejected = [];
  const c = requirements.constraints;
  for (const candidate of candidates) {
    const reasons = [];
    if (!candidate.enabled) reasons.push(reason('CONNECTION_DISABLED'));
    if (!candidate.authenticated) reasons.push(reason('CONNECTION_UNAUTHENTICATED'));
    if (c.allowedConnectionIds.length && !c.allowedConnectionIds.includes(candidate.connectionId)) reasons.push(reason('CONNECTION_NOT_ALLOWED'));
    if (c.deniedConnectionIds.includes(candidate.connectionId)) reasons.push(reason('CONNECTION_DENIED'));
    if (c.allowedProviders.length && !c.allowedProviders.includes(candidate.provider)) reasons.push(reason('PROVIDER_NOT_ALLOWED'));
    if (c.deniedProviders.includes(candidate.provider)) reasons.push(reason('PROVIDER_DENIED'));
    if (c.allowedModels.length && !c.allowedModels.includes(candidate.modelId)) reasons.push(reason('MODEL_NOT_ALLOWED'));
    if (c.deniedModels.includes(candidate.modelId)) reasons.push(reason('MODEL_DENIED'));

    const capMap = { text: 'TEXT', vision: 'VISION', nativeTools: 'NATIVE_TOOLS', streaming: 'STREAMING' };
    for (const [key, label] of Object.entries(capMap)) {
      if (requirements.required[key] && !isProvenTrue(candidate.capabilities[key])) {
        reasons.push(reason(`${label}_REQUIRED_NOT_PROVEN`, { state: candidate.capabilities[key] ? candidate.capabilities[key].state : 'unknown' }));
      }
    }

    const minContext = requirements.required.minContextWindow;
    if (minContext !== null) {
      const value = candidate.contextWindow && candidate.contextWindow.value;
      if (value === null || value === undefined) reasons.push(reason('CONTEXT_WINDOW_UNKNOWN'));
      else if (value < minContext) reasons.push(reason('CONTEXT_WINDOW_TOO_SMALL', { required: minContext, actual: value }));
    }

    for (const [constraintKey, priceKey] of [['maxInputPrice', 'input'], ['maxOutputPrice', 'output']]) {
      const limit = c[constraintKey];
      if (limit === null) continue;
      const metric = candidate.pricing[priceKey];
      if (!metric || metric.value === null) reasons.push(reason('PRICE_UNKNOWN_FOR_HARD_LIMIT', { metric: priceKey }));
      else if (metric.value > limit) reasons.push(reason('PRICE_EXCEEDS_LIMIT', { metric: priceKey, limit, actual: metric.value }));
    }
    if (c.maxLatencyMs !== null) {
      if (candidate.latency.ms === null) reasons.push(reason('LATENCY_UNKNOWN_FOR_HARD_LIMIT'));
      else if (candidate.latency.ms > c.maxLatencyMs) reasons.push(reason('LATENCY_EXCEEDS_LIMIT', { limit: c.maxLatencyMs, actual: candidate.latency.ms }));
    }

    if (reasons.length) rejected.push({ candidate, reasons });
    else eligible.push(candidate);
  }
  return { eligible, rejected };
}

module.exports = { PROVEN_STATES, isProvenTrue, filterCandidates };
