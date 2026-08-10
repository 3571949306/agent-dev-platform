'use strict';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_MALFORMED_FRAMES = 5;

class ClineProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClineProtocolError';
    this.code = code;
  }
}

function assertSafeObject(value, depth = 0) {
  if (value == null || typeof value !== 'object') return;
  if (depth > 20) throw new ClineProtocolError('CLINE_PROTOCOL_ERROR', 'Protocol object nesting exceeds limit');
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new ClineProtocolError('CLINE_PROTOCOL_ERROR', `Forbidden protocol key: ${key}`);
    }
    assertSafeObject(value[key], depth + 1);
  }
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new ClineProtocolError('CLINE_PROTOCOL_ERROR', 'Protocol frame must be an object');
  }
  assertSafeObject(message);
  if (message.protocol !== PROTOCOL_VERSION) {
    throw new ClineProtocolError('CLINE_PROTOCOL_VERSION_MISMATCH', `Expected protocol ${PROTOCOL_VERSION}, received ${message.protocol}`);
  }
  if (typeof message.type !== 'string' || !message.type) {
    throw new ClineProtocolError('CLINE_PROTOCOL_ERROR', 'Protocol message type is required');
  }
  return message;
}

function createMessage(type, fields = {}) {
  return validateMessage({ protocol: PROTOCOL_VERSION, type, ...fields });
}

function encodeMessage(message) {
  const line = JSON.stringify(validateMessage(message));
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new ClineProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB');
  }
  return `${line}\n`;
}

class JsonlDecoder {
  constructor({ onMessage, onWarning, onFatal } = {}) {
    this.buffer = Buffer.alloc(0);
    this.malformed = 0;
    this.failed = false;
    this.onMessage = onMessage || (() => {});
    this.onWarning = onWarning || (() => {});
    this.onFatal = onFatal || (() => {});
  }

  push(chunk) {
    if (this.failed || !chunk || chunk.length === 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > MAX_FRAME_BYTES && this.buffer.indexOf(0x0a) === -1) {
      this._fatal(new ClineProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB'));
      return;
    }
    let newline;
    while (!this.failed && (newline = this.buffer.indexOf(0x0a)) !== -1) {
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        this._fatal(new ClineProtocolError('CLINE_PROTOCOL_FRAME_TOO_LARGE', 'Protocol frame exceeds 2 MiB'));
        return;
      }
      const line = frame.toString('utf8').replace(/\r$/, '');
      if (!line.trim()) continue;
      try {
        this.onMessage(validateMessage(JSON.parse(line)));
      } catch (error) {
        this.malformed += 1;
        this.onWarning(error, this.malformed);
        if (error && error.code === 'CLINE_PROTOCOL_VERSION_MISMATCH') {
          this._fatal(error);
        } else if (this.malformed >= MAX_MALFORMED_FRAMES) {
          this._fatal(new ClineProtocolError('CLINE_PROTOCOL_ERROR', 'Too many malformed protocol frames'));
        }
      }
    }
  }

  end() {
    if (!this.failed && this.buffer.length && this.buffer.toString('utf8').trim()) {
      this.malformed += 1;
      this.onWarning(new ClineProtocolError('CLINE_PROTOCOL_ERROR', 'Unterminated protocol frame'), this.malformed);
    }
    this.buffer = Buffer.alloc(0);
  }

  _fatal(error) {
    if (this.failed) return;
    this.failed = true;
    this.onFatal(error);
  }
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_MALFORMED_FRAMES,
  ClineProtocolError,
  createMessage,
  encodeMessage,
  validateMessage,
  JsonlDecoder
};
