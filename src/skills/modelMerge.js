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
 *   - allowed sets:            intersection of NON-EMPTY allow-lists; an empty allow-set
 *                              means UNRESTRICTED (does NOT further restrict). Two NON-EMPTY
 *                              allow-lists whose intersection is empty → SKILL_MODEL_REQUIREMENTS_CONFLICT
 *                              (NEVER collapses to [] which the router treats as unrestricted —
 *                              that would be a constraint-reversal fail-open).
 *   - denied sets:             union
 *   - max price / latency:     min (stricter); ALL active hard price constraints
 *                              (maxInputPrice AND maxOutputPrice, across every source) must share
 *                              ONE canonical price basis (currency + unit): cross-field or
 *                              cross-source currency mismatch → SKILL_MODEL_REQUIREMENTS_CONFLICT;
 *                              unknown basis → fail closed.
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
  // R1 — allowed sets: intersection of NON-EMPTY allow-lists only.
  //   - one side empty (UNRESTRICTED) → keep the other (does not further restrict);
  //   - both non-empty → intersect; EMPTY intersection is a hard conflict and is
  //     NEVER collapsed to [] (the router would treat [] as "unrestricted").
  for (const key of ['allowedConnectionIds', 'allowedProviders', 'allowedModels']) {
    const next = nc[key];
    if (!next.length) continue; // this source is unrestricted on this axis → keep current
    if (!c[key].length) {
      // first non-empty restrictor seeds the accumulator (narrows from unrestricted)
      c[key] = [...next].sort();
    } else {
      const intersection = c[key].filter(item => next.includes(item));
      if (!intersection.length) {
        throw conflict(`allowed set '${key}' has empty intersection (incompatible allow-lists): ${c[key].join(',')} ∩ ${next.join(',')}`, path);
      }
      c[key] = intersection.sort();
    }
  }
  for (const key of ['deniedConnectionIds', 'deniedProviders', 'deniedModels']) {
    c[key] = [...new Set([...c[key], ...nc[key]])].sort();
  }

  // R2 — hard price constraints: every active hard price (maxInputPrice OR maxOutputPrice)
  // must belong to a single canonical price basis (currency + unit). Cross-field and
  // cross-source mismatches are a conflict; an undefined basis is fail-closed. The last
  // source never silently overrides the established basis.
  for (const key of ['maxInputPrice', 'maxOutputPrice']) {
    const b = nc[key];
    if (b === null) continue; // this source does not constrain this price field
    if (!nc.priceBasis) {
      throw conflict(`hard price constraint '${key}' has no price basis (unknown basis → fail closed)`, path);
    }
    if (c.priceBasis) {
      if (c.priceBasis.currency !== nc.priceBasis.currency || c.priceBasis.unit !== nc.priceBasis.unit) {
        throw conflict(`price basis mismatch on '${key}': ${c.priceBasis.currency}/${c.priceBasis.unit} vs ${nc.priceBasis.currency}/${nc.priceBasis.unit}`, path);
      }
    } else {
      // adopt the first established canonical basis; later sources must be compatible
      c.priceBasis = { ...nc.priceBasis };
    }
    c[key] = (c[key] === null) ? b : Math.min(c[key], b);
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
