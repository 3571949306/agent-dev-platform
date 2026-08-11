'use strict';

const EVIDENCE_WEIGHT = Object.freeze({ tested: 8, declared: 5, inferred: 1, unknown: 0 });

function round(value) { return Math.round(value * 1000) / 1000; }

function scoreOne(requirements, candidate) {
  const breakdown = { capabilityEvidence: 0, latency: 0, cost: 0, locality: 0, providerPreference: 0, modelPreference: 0 };
  for (const cap of Object.values(candidate.capabilities)) {
    if (cap && cap.value === true) breakdown.capabilityEvidence += EVIDENCE_WEIGHT[cap.state] || 0;
  }
  if (candidate.contextWindow && candidate.contextWindow.value !== null) {
    breakdown.capabilityEvidence += EVIDENCE_WEIGHT[candidate.contextWindow.state] || 0;
  }

  const latencyPref = requirements.preferences.latency;
  if (latencyPref !== 'ignore') {
    if (candidate.latency.ms === null) breakdown.latency = latencyPref === 'low' ? -6 : -2;
    else breakdown.latency = latencyPref === 'low'
      ? Math.max(-10, 24 - candidate.latency.ms / 10)
      : Math.max(-5, 10 - candidate.latency.ms / 50);
  }

  const costPref = requirements.preferences.cost;
  if (costPref !== 'ignore') {
    const input = candidate.pricing.input && candidate.pricing.input.value;
    const output = candidate.pricing.output && candidate.pricing.output.value;
    if (input === null || input === undefined || output === null || output === undefined) {
      breakdown.cost = costPref === 'low' ? -6 : -2;
    } else {
      const total = input + output;
      breakdown.cost = costPref === 'low' ? Math.max(-10, 20 - total * 4) : Math.max(-5, 8 - total);
    }
  }
  if (requirements.preferences.preferLocal) breakdown.locality = candidate.locality === 'local' ? 15 : (candidate.locality === 'unknown' ? -2 : 0);
  const providerIndex = requirements.preferences.preferredProviders.indexOf(candidate.provider);
  if (providerIndex >= 0) breakdown.providerPreference = Math.max(1, 12 - providerIndex);
  const modelIndex = requirements.preferences.preferredModels.indexOf(candidate.modelId);
  if (modelIndex >= 0) breakdown.modelPreference = Math.max(1, 16 - modelIndex);
  for (const key of Object.keys(breakdown)) breakdown[key] = round(breakdown[key]);
  const totalScore = round(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  return { candidate, totalScore, breakdown };
}

function compareScored(a, b) {
  return (b.totalScore - a.totalScore)
    || a.candidate.provider.localeCompare(b.candidate.provider)
    || a.candidate.connectionId.localeCompare(b.candidate.connectionId)
    || a.candidate.modelId.localeCompare(b.candidate.modelId);
}

function scoreCandidates(requirements, candidates) {
  return candidates.map(candidate => scoreOne(requirements, candidate)).sort(compareScored);
}

module.exports = { EVIDENCE_WEIGHT, scoreOne, scoreCandidates, compareScored };
