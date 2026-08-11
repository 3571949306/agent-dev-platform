'use strict';

const ERROR_CODE = 'MODEL_REQUIREMENTS_INVALID';
const PREFERENCE_LEVELS = new Set(['low', 'balanced', 'ignore']);
const { normalizeCurrency, normalizePriceUnit, toPerMillion } = require('./pricing');

const DEFAULT_REQUIREMENTS = Object.freeze({
  schemaVersion: 1,
  required: Object.freeze({ text: true, vision: false, nativeTools: false, streaming: false, minContextWindow: null }),
  preferences: Object.freeze({ latency: 'ignore', cost: 'ignore', preferLocal: false, preferredProviders: Object.freeze([]), preferredModels: Object.freeze([]) }),
  constraints: Object.freeze({
    allowedConnectionIds: Object.freeze([]), deniedConnectionIds: Object.freeze([]),
    allowedProviders: Object.freeze([]), deniedProviders: Object.freeze([]),
    allowedModels: Object.freeze([]), deniedModels: Object.freeze([]),
    maxInputPrice: null, maxOutputPrice: null, maxLatencyMs: null, priceBasis: null
  })
});

function invalid(path, message) {
  const error = new Error(`${ERROR_CODE}: ${path}: ${message}`);
  error.code = ERROR_CODE;
  error.path = path;
  return error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stringList(value, path) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw invalid(path, 'must be an array of non-empty strings');
  }
  return [...new Set(value.map(item => item.trim()))];
}

function nullableNonNegative(value, path, integer = false) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw invalid(path, `must be null or a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function rejectUnknownKeys(input, allowed, path) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`${path}.${key}`, 'unknown field');
}

function normalizeModelRequirements(input = {}) {
  if (!plain(input)) throw invalid('requirements', 'must be a plain object');
  rejectUnknownKeys(input, new Set(['schemaVersion', 'required', 'preferences', 'constraints']), 'requirements');
  const schemaVersion = input.schemaVersion === undefined ? 1 : input.schemaVersion;
  if (schemaVersion !== 1) throw invalid('requirements.schemaVersion', 'unsupported schema version');
  const requiredInput = input.required === undefined ? {} : input.required;
  const preferencesInput = input.preferences === undefined ? {} : input.preferences;
  const constraintsInput = input.constraints === undefined ? {} : input.constraints;
  if (!plain(requiredInput)) throw invalid('requirements.required', 'must be a plain object');
  if (!plain(preferencesInput)) throw invalid('requirements.preferences', 'must be a plain object');
  if (!plain(constraintsInput)) throw invalid('requirements.constraints', 'must be a plain object');
  rejectUnknownKeys(requiredInput, new Set(Object.keys(DEFAULT_REQUIREMENTS.required)), 'requirements.required');
  rejectUnknownKeys(preferencesInput, new Set(Object.keys(DEFAULT_REQUIREMENTS.preferences)), 'requirements.preferences');
  rejectUnknownKeys(constraintsInput, new Set(Object.keys(DEFAULT_REQUIREMENTS.constraints)), 'requirements.constraints');

  const required = { ...DEFAULT_REQUIREMENTS.required, ...requiredInput };
  for (const key of ['text', 'vision', 'nativeTools', 'streaming']) {
    if (typeof required[key] !== 'boolean') throw invalid(`requirements.required.${key}`, 'must be boolean');
  }
  required.minContextWindow = nullableNonNegative(required.minContextWindow, 'requirements.required.minContextWindow', true);
  if (required.minContextWindow === 0) required.minContextWindow = null;

  const preferences = { ...DEFAULT_REQUIREMENTS.preferences, ...preferencesInput };
  for (const key of ['latency', 'cost']) {
    if (!PREFERENCE_LEVELS.has(preferences[key])) throw invalid(`requirements.preferences.${key}`, 'invalid preference');
  }
  if (typeof preferences.preferLocal !== 'boolean') throw invalid('requirements.preferences.preferLocal', 'must be boolean');
  preferences.preferredProviders = stringList(preferences.preferredProviders, 'requirements.preferences.preferredProviders');
  preferences.preferredModels = stringList(preferences.preferredModels, 'requirements.preferences.preferredModels');

  const constraints = { ...DEFAULT_REQUIREMENTS.constraints, ...constraintsInput };
  for (const key of ['allowedConnectionIds', 'deniedConnectionIds', 'allowedProviders', 'deniedProviders', 'allowedModels', 'deniedModels']) {
    constraints[key] = stringList(constraints[key], `requirements.constraints.${key}`);
  }
  constraints.maxInputPrice = nullableNonNegative(constraints.maxInputPrice, 'requirements.constraints.maxInputPrice');
  constraints.maxOutputPrice = nullableNonNegative(constraints.maxOutputPrice, 'requirements.constraints.maxOutputPrice');
  constraints.maxLatencyMs = nullableNonNegative(constraints.maxLatencyMs, 'requirements.constraints.maxLatencyMs');
  if (constraints.priceBasis !== null) {
    if (!plain(constraints.priceBasis)) throw invalid('requirements.constraints.priceBasis', 'must be null or a plain object');
    rejectUnknownKeys(constraints.priceBasis, new Set(['currency', 'unit']), 'requirements.constraints.priceBasis');
    const currency = normalizeCurrency(constraints.priceBasis.currency);
    const originalUnit = normalizePriceUnit(constraints.priceBasis.unit);
    if (!currency) throw invalid('requirements.constraints.priceBasis.currency', 'must be a non-empty currency code');
    if (originalUnit === 'unknown') throw invalid('requirements.constraints.priceBasis.unit', 'unsupported price unit');
    if (constraints.maxInputPrice !== null) constraints.maxInputPrice = toPerMillion(constraints.maxInputPrice, originalUnit);
    if (constraints.maxOutputPrice !== null) constraints.maxOutputPrice = toPerMillion(constraints.maxOutputPrice, originalUnit);
    constraints.priceBasis = { currency, unit: 'per_1m_tokens' };
  }
  return { schemaVersion, required, preferences, constraints };
}

module.exports = { ERROR_CODE, DEFAULT_REQUIREMENTS, normalizeModelRequirements };
