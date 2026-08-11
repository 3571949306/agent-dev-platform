'use strict';
/**
 * v2.9.3 Skill Engine — R6 Model Requirements Merge Semantics.
 *
 * A Skill can propose ModelRequirements, but never selects a model directly:
 *   Skill → Model Requirements → existing Model Router
 *
 * Multiple sources (Agent + Skill A + Skill B) merge safely and strictly:
 *   - hard required booleans:  OR        (stricter: any source needs it → needed)
 *   - minContextWindow:        max
 *   - allowed sets:            intersection (empty = unrestricted; disjoint → no candidate, fail closed)
 *   - denied sets:             union
 *   - max price / latency:     min (stricter); comparable price basis only,
 *                              otherwise SKILL_MODEL_REQUIREMENTS_CONFLICT
 *   - preferences:             strongest wins, never loosens hard constraints
 *
 * A Skill can never relax an Agent constraint: the Agent's denied set is always
 * preserved by union, and the Agent's allowed set is always preserved by
 * intersection.
 */

const { normalizeModelRequirements, DEFAULT_REQUIREMENTS } = require('../models/router/modelRequirements');

const ERROR_CODE = 'SKILL_MODEL_REQUIREMENTS_CONFLICT';

function conflict(message, path) {
  const error = new Error(`${ERROR_CODE}: ${path ? `${path}: ` : ''}${message}`);
  error.code = ERROR_CODE;
  error.path = path || null;
  return error;
}

const PREFERENCE_LEVEL = { ignore: 0, balanced: 1, low: 2 };

function normalizeAll(sources) {
  return (sources || []).filter(Boolean).map(source => {
    try { return normalizeModelRequirements(source); }
    catch (error) { throw conflict(error.message, error.path || 'requirements'); }
  });
}

/**
 * Merge one skill requirements object into an accumulated result (strict merge).
 * @param {object} acc  accumulated normalized requirements (mutated)
 * @param {object} next normalized requirements to merge in
 * @param {string} path path prefix for conflict messages (skill id)
 */
function mergeInto(acc, next, path = 'skill') {
  const r = acc.required;
  const nr = next.required;
  for (const key of ['text', 'vision', 'nativeTools', 'streaming']) {
    if (nr[key]) r[key] = true;
  }
  if (nr.minContextWindow !== null) {
    r.minContextWindow = r.minContextWindow === null
      ? nr.minContextWindow
      : Math.max(r.minContextWindow, nr.minContextWindow);
  }

  const p = acc.preferences;
  const np = next.preferences;
  for (const key of ['latency', 'cost']) {
    const level = PREFERENCE_LEVEL[np[key]] || 0;
    const current = PREFERENCE_LEVEL[p[key]] || 0;
    if (level > current) p[key] = np[key];
  }
  if (np.preferLocal) p.preferLocal = true;
  p.preferredProviders = [...new Set([...p.preferredProviders, ...np.preferredProviders])].sort();
  p.preferredModels = [...new Set([...p.preferredModels, ...np.preferredModels])].sort();

  const c = acc.constraints;
  const nc = next.constraints;
  for (const key of ['allowedConnectionIds', 'allowedProviders', 'allowedModels']) {
    if (!c[key].length) c[key] = [...nc[key]].sort();
    else if (nc[key].length) c[key] = c[key].filter(item => nc[key].includes(item)).sort();
  }
  for (const key of ['deniedConnectionIds', 'deniedProviders', 'deniedModels']) {
    c[key] = [...new Set([...c[key], ...nc[key]])].sort();
  }

  for (const key of ['maxInputPrice', 'maxOutputPrice']) {
    const a = c[key];
    const b = nc[key];
    if (a === null) {
      c[key] = b;
      if (b !== null && !c.priceBasis) c.priceBasis = nc.priceBasis ? { ...nc.priceBasis } : null;
    } else if (b !== null) {
      if (c.priceBasis && nc.priceBasis && c.priceBasis.currency !== nc.priceBasis.currency) {
        throw conflict(`price basis mismatch on ${key}: ${c.priceBasis.currency} vs ${nc.priceBasis.currency}`, path);
      }
      c[key] = Math.min(a, b);
      if (!c.priceBasis && nc.priceBasis) c.priceBasis = { ...nc.priceBasis };
    }
  }
  if (nc.maxLatencyMs !== null) {
    c.maxLatencyMs = c.maxLatencyMs === null ? nc.maxLatencyMs : Math.min(c.maxLatencyMs, nc.maxLatencyMs);
  }
  return acc;
}

/**
 * Strictly merge any number of ModelRequirements sources.
 * Order of sources does not affect the result (all merges are commutative).
 * @returns {object} normalized merged requirements
 * @throws SKILL_MODEL_REQUIREMENTS_CONFLICT on incomparable hard limits
 */
function mergeModelRequirements(...sources) {
  const normalized = normalizeAll(sources);
  const acc = normalizeModelRequirements(DEFAULT_REQUIREMENTS);
  for (const [index, next] of normalized.entries()) {
    mergeInto(acc, next, `source[${index}]`);
  }
  return acc;
}

module.exports = { ERROR_CODE, mergeModelRequirements, mergeInto };
