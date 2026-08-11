'use strict';

const SENSITIVE_KEY = /(api.?key|authorization|bearer|cookie|password|access.?token|refresh.?token|secret|credential|decrypt|provider.?object|model.?adapter)/i;
const SENSITIVE_VALUE = /(bearer\s+[a-z0-9._-]+|\bsk-[a-z0-9_-]{8,}|cookie\s*=)/i;

function sanitizePublic(value, seen = new Set()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value) ? '[REDACTED]' : value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(item => sanitizePublic(item, seen));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SENSITIVE_KEY.test(key)) result[key] = sanitizePublic(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

module.exports = { sanitizePublic, SENSITIVE_KEY, SENSITIVE_VALUE };
