export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_MALFORMED_FRAMES = 5

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

function assertSafeValue(value, depth = 0) {
  if (depth > 32) throw new ProtocolError('CLINE_PROTOCOL_ERROR', 'Protocol value nesting is too deep')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new ProtocolError('CLINE_PROTOCOL_ERROR', `Forbidden protocol key: ${key}`)
    }
    assertSafeValue(child, depth + 1)
  }
}

export function createMessage(type, fields = {}) {
  return { protocol: PROTOCOL_VERSION, type, ...fields }
}

export function encodeMessage(message) {
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB')
  }
  return `${line}\n`
}

export class JsonlDecoder {
  constructor({ onMessage, onWarning, onFatal } = {}) {
    this.buffer = Buffer.alloc(0)
    this.malformed = 0
    this.onMessage = onMessage || (() => {})
    this.onWarning = onWarning || (() => {})
    this.onFatal = onFatal || (() => {})
    this.failed = false
  }

  push(chunk) {
    if (this.failed || !chunk || chunk.length === 0) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buffer = Buffer.concat([this.buffer, next])
    if (this.buffer.length > MAX_FRAME_BYTES && this.buffer.indexOf(0x0a) === -1) {
      this.fail(new ProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB'))
      return
    }
    let newline
    while (!this.failed && (newline = this.buffer.indexOf(0x0a)) !== -1) {
      const frame = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (frame.length > MAX_FRAME_BYTES) {
        this.fail(new ProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB'))
        return
      }
      const line = frame.toString('utf8').replace(/\r$/, '')
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('frame must be an object')
        assertSafeValue(message)
        if (message.protocol !== PROTOCOL_VERSION) throw new ProtocolError('CLINE_PROTOCOL_VERSION_MISMATCH', `Expected protocol ${PROTOCOL_VERSION}`)
        if (typeof message.type !== 'string' || !message.type) throw new Error('message type is required')
        this.onMessage(message)
      } catch (error) {
        this.malformed += 1
        this.onWarning(error, this.malformed)
        if (error && error.code === 'CLINE_PROTOCOL_VERSION_MISMATCH') {
          this.fail(error)
        } else if (this.malformed >= MAX_MALFORMED_FRAMES) {
          this.fail(new ProtocolError('CLINE_PROTOCOL_ERROR', 'Too many malformed protocol frames'))
        }
      }
    }
  }

  end() {
    if (!this.failed && this.buffer.length > 0 && this.buffer.toString('utf8').trim()) {
      this.malformed += 1
      this.onWarning(new Error('unterminated protocol frame'), this.malformed)
    }
    this.buffer = Buffer.alloc(0)
  }

  fail(error) {
    if (this.failed) return
    this.failed = true
    this.onFatal(error)
  }
}
