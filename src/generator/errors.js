'use strict';

function generatorError(code, message, details = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function errorRecord(error) {
  return {
    code: error && error.code ? error.code : 'GENERATOR_VALIDATION_FAILED',
    path: error && error.path ? error.path : null,
    message: String(error && error.message || error || 'validation failed').slice(0, 1000)
  };
}

module.exports = { generatorError, errorRecord };
