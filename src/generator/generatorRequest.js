'use strict';

const { generatorError } = require('./errors');

const ARTIFACT_TYPES = Object.freeze(['agent', 'skill', 'hook', 'workflow']);
const MODES = Object.freeze(['auto', 'explicit_model']);
const MAX_INTENT_CHARS = 12000;
const MAX_PROJECT_SUMMARY_CHARS = 16000;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:authorization|cookie|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*[^\s,;]{6,})/i;

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw generatorError('GENERATOR_REQUEST_INVALID', `${path}.${key}: unknown field`);
  }
}

function secretDetected(value) {
  return typeof value === 'string' && SECRET_VALUE.test(value);
}

function normalizeGeneratorRequest(input) {
  if (!plain(input)) throw generatorError('GENERATOR_REQUEST_INVALID', 'request must be a plain object');
  exactKeys(input, ['schemaVersion', 'artifactType', 'intent', 'mode', 'explicitModel', 'context'], 'request');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw generatorError('GENERATOR_REQUEST_INVALID', 'unsupported schemaVersion');
  }
  if (!ARTIFACT_TYPES.includes(input.artifactType)) {
    throw generatorError('GENERATOR_REQUEST_INVALID', 'unsupported artifactType');
  }
  const intent = typeof input.intent === 'string' ? input.intent.trim() : '';
  if (!intent) throw generatorError('GENERATOR_REQUEST_INVALID', 'intent is required');
  const context = input.context === undefined ? {} : input.context;
  if (!plain(context)) throw generatorError('GENERATOR_REQUEST_INVALID', 'context must be a plain object');
  exactKeys(context, ['projectId', 'projectSummary'], 'request.context');
  const projectId = context.projectId === undefined ? null : context.projectId;
  const projectSummary = context.projectSummary === undefined ? null : context.projectSummary;
  if (projectId !== null && typeof projectId !== 'string') {
    throw generatorError('GENERATOR_REQUEST_INVALID', 'projectId must be a string or null');
  }
  if (projectSummary !== null && typeof projectSummary !== 'string') {
    throw generatorError('GENERATOR_REQUEST_INVALID', 'projectSummary must be a string or null');
  }
  if (intent.length > MAX_INTENT_CHARS || (projectSummary && projectSummary.length > MAX_PROJECT_SUMMARY_CHARS)) {
    throw generatorError('GENERATOR_INPUT_TOO_LARGE', 'generator input exceeds the bounded prompt budget');
  }
  if (secretDetected(intent) || secretDetected(projectSummary)) {
    throw generatorError('GENERATOR_INPUT_SECRET_DETECTED', 'credential-shaped input is forbidden');
  }
  const mode = input.mode === undefined ? 'auto' : input.mode;
  if (!MODES.includes(mode)) throw generatorError('GENERATOR_REQUEST_INVALID', 'unsupported mode');
  let explicitModel = input.explicitModel === undefined ? null : input.explicitModel;
  if (mode === 'explicit_model') {
    if (!plain(explicitModel)) throw generatorError('GENERATOR_REQUEST_INVALID', 'explicitModel is required');
    exactKeys(explicitModel, ['connectionId', 'modelId'], 'request.explicitModel');
    if (typeof explicitModel.connectionId !== 'string' || !explicitModel.connectionId.trim() ||
        typeof explicitModel.modelId !== 'string' || !explicitModel.modelId.trim()) {
      throw generatorError('GENERATOR_REQUEST_INVALID', 'explicitModel requires connectionId and modelId');
    }
    explicitModel = {
      connectionId: explicitModel.connectionId.trim(),
      modelId: explicitModel.modelId.trim()
    };
  } else {
    if (explicitModel !== null) throw generatorError('GENERATOR_REQUEST_INVALID', 'auto mode forbids explicitModel');
    explicitModel = null;
  }
  return {
    schemaVersion: 1,
    artifactType: input.artifactType,
    intent,
    mode,
    explicitModel,
    context: { projectId: projectId || null, projectSummary: projectSummary || null }
  };
}

module.exports = {
  ARTIFACT_TYPES,
  MODES,
  MAX_INTENT_CHARS,
  MAX_PROJECT_SUMMARY_CHARS,
  SECRET_VALUE,
  secretDetected,
  normalizeGeneratorRequest
};
