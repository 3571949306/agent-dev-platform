const SECRET_KEY = /(api[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|oauth|cookie|password|secret|private[_-]?key|session[_-]?token)/i
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+\/-]+|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]+)/gi
const REDACTED = '[REDACTED]'
const MAX_STRING = 128 * 1024
const MAX_DEPTH = 10

export function redactString(value, maxLength = MAX_STRING) {
  const redacted = String(value ?? '').replace(SECRET_VALUE, REDACTED)
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…[truncated ${redacted.length - maxLength} chars]`
    : redacted
}

export function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactString(value)
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code || undefined }
  }
  if (typeof value !== 'object') return redactString(String(value))
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 2000).map(item => sanitize(item, depth + 1, seen))
  const out = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, 2000)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : sanitize(item, depth + 1, seen)
  }
  return out
}

export function safeError(error, fallbackCode = 'CLINE_RUNTIME_ERROR') {
  return {
    code: redactString(error?.code || fallbackCode, 128),
    message: redactString(error?.message || error || 'Unknown Cline runtime error', 8192)
  }
}

export function installConsoleRedirect() {
  const write = (...parts) => {
    const line = parts.map(part => typeof part === 'string' ? part : JSON.stringify(sanitize(part))).join(' ')
    process.stderr.write(`${redactString(line, 32 * 1024)}\n`)
  }
  console.log = write
  console.info = write
  console.debug = write
  console.warn = write
  console.error = write
}
