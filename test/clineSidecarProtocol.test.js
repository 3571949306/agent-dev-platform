'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  JsonlDecoder,
  ClineProtocolError,
  createMessage,
  encodeMessage,
  MAX_FRAME_BYTES,
  MAX_MALFORMED_FRAMES
} = require('../src/agents/integrations/cline/sidecarProtocol');
const { buildSidecarEnv } = require('../src/agents/integrations/cline/sidecarManager');

test('Cline sidecar protocol decodes fragmented JSONL frames', () => {
  const messages = [];
  const decoder = new JsonlDecoder({ onMessage: message => messages.push(message) });
  const line = encodeMessage(createMessage('runtime.probe', { requestId: 'r1', payload: { ok: true } }));
  decoder.push(line.slice(0, 7));
  decoder.push(line.slice(7));
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].requestId, 'r1');
});

test('Cline sidecar protocol fails after bounded malformed input', () => {
  let fatal = null;
  const decoder = new JsonlDecoder({ onFatal: error => { fatal = error; } });
  for (let i = 0; i < MAX_MALFORMED_FRAMES; i++) decoder.push('{bad json}\n');
  assert.ok(fatal instanceof ClineProtocolError);
  assert.strictEqual(fatal.code, 'CLINE_PROTOCOL_ERROR');
});

test('Cline sidecar protocol rejects oversized frames', () => {
  assert.throws(
    () => encodeMessage(createMessage('run.start', { payload: { prompt: 'x'.repeat(MAX_FRAME_BYTES) } })),
    error => error.code === 'CLINE_PROTOCOL_FRAME_TOO_LARGE'
  );
  let fatal = null;
  const decoder = new JsonlDecoder({ onFatal: error => { fatal = error; } });
  decoder.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78));
  assert.strictEqual(fatal.code, 'CLINE_PROTOCOL_FRAME_TOO_LARGE');
});

test('Cline sidecar protocol rejects prototype-pollution keys', () => {
  let fatal = null;
  const decoder = new JsonlDecoder({ onFatal: error => { fatal = error; } });
  for (let i = 0; i < MAX_MALFORMED_FRAMES; i++) {
    decoder.push('{"protocol":1,"type":"run.start","payload":{"constructor":{"prototype":{"polluted":true}}}}\n');
  }
  assert.strictEqual(fatal.code, 'CLINE_PROTOCOL_ERROR');
  assert.strictEqual({}.polluted, undefined);
});

test('Cline sidecar protocol rejects a protocol version mismatch immediately', () => {
  let fatal = null;
  const decoder = new JsonlDecoder({ onFatal: error => { fatal = error; } });
  decoder.push('{"protocol":99,"type":"hello.ok"}\n');
  assert.strictEqual(fatal.code, 'CLINE_PROTOCOL_VERSION_MISMATCH');
});

test('Cline sidecar environment is allowlisted and contains no ambient credentials', () => {
  const env = buildSidecarEnv({
    PATH: 'safe-path',
    TEMP: 'safe-temp',
    OPENAI_API_KEY: 'sk-test-never-forward',
    ANTHROPIC_API_KEY: 'never-forward',
    AWS_SECRET_ACCESS_KEY: 'never-forward'
  }, 'D:\\runtime-data');
  assert.strictEqual(env.PATH, 'safe-path');
  assert.strictEqual(env.OPENAI_API_KEY, undefined);
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.strictEqual(env.ADP_CLINE_PROTOCOL, '1');
  assert.ok(env.CLINE_DATA_DIR.endsWith('runtime-data'));
});
