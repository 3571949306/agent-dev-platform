'use strict';

const { generatorError } = require('./errors');

const SYSTEM_RULES = Object.freeze([
  'You generate configuration only.',
  'You do not execute tasks.',
  'Output exactly one JSON object.',
  'Use only resources explicitly listed in AVAILABLE_PLATFORM_RESOURCES.',
  'Never invent tool IDs, skill IDs, hook IDs, handler IDs, agents or providers.',
  'Never include credentials.',
  'Never add executable JavaScript, shell code, webhook URLs or runtime objects.',
  'The generated object must satisfy the supplied Definition Contract.'
]);

function strictParseCandidate(output) {
  if (typeof output !== 'string') throw generatorError('GENERATOR_OUTPUT_INVALID_JSON', 'model output must be a JSON string');
  const exact = output.trim();
  let parsed;
  try { parsed = JSON.parse(exact); }
  catch { throw generatorError('GENERATOR_OUTPUT_INVALID_JSON', 'model output is not exactly one JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw generatorError('GENERATOR_OUTPUT_INVALID_JSON', 'model output must be exactly one JSON object');
  }
  return parsed;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function buildGenerationPrompt({ request, contract, capabilityContext }) {
  const system = SYSTEM_RULES.join('\n');
  const context = [
    'ARTIFACT_TYPE\n' + request.artifactType,
    'USER_REQUIREMENT\n' + request.intent,
    request.context.projectSummary ? 'PROJECT_SUMMARY\n' + request.context.projectSummary : null,
    'DEFINITION_CONTRACT\n' + canonicalJson(contract),
    'AVAILABLE_PLATFORM_RESOURCES\n' + canonicalJson(capabilityContext)
  ].filter(Boolean).join('\n\n');
  return { system, context };
}

function safeRepairText(value) {
  return String(value || '')
    .replace(/(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:authorization|cookie|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*[^\s,;]+)/ig, '[REDACTED]')
    .slice(0, 32000);
}

function buildRepairPrompt({ previousOutput, errors, capabilityContext, contract }) {
  const safeErrors = (errors || []).slice(0, 20).map(error => ({
    code: error.code || 'GENERATOR_VALIDATION_FAILED',
    path: error.path || null,
    message: safeRepairText(error.message).slice(0, 500)
  }));
  return {
    system: SYSTEM_RULES.concat(['Repair the candidate using only the supplied validation errors.']).join('\n'),
    context: [
      'PREVIOUS_CANDIDATE\n' + safeRepairText(previousOutput),
      'VALIDATION_ERRORS\n' + canonicalJson(safeErrors),
      'DEFINITION_CONTRACT\n' + canonicalJson(contract),
      'AVAILABLE_PLATFORM_RESOURCES\n' + canonicalJson(capabilityContext)
    ].join('\n\n')
  };
}

module.exports = {
  SYSTEM_RULES,
  strictParseCandidate,
  canonicalJson,
  buildGenerationPrompt,
  buildRepairPrompt
};
