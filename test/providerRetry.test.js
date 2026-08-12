'use strict';
/**
 * v2.9.8 Real Project Reliability — R5.
 *
 * Bounded Transient Failure Recovery（Provider Retry Contract）：
 *  - 瞬态错误（connection reset / HTTP 408/429/5xx）自动重试
 *  - 有界：初始尝试 + 最多 1 次重试 = 每个 decision 最多 2 次 provider 尝试
 *  - 请求被取消 / 超时 / 非瞬态错误 → 不重试
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { getProvider } = require('../src/providers');
const { isRetryableNetworkError, MAX_ATTEMPTS, RETRYABLE_STATUS } = require('../src/providers/http');

const SSE_SUCCESS = 'data: {"choices":[{"delta":{"content":"RETRY_OK"}}]}\n\ndata: [DONE]\n\n';

function scriptedServer(handler) {
  const state = { requests: 0, sockets: [] };
  const server = http.createServer((req, res) => {
    state.requests++;
    handler(req, res, state);
  });
  server.on('connection', s => state.sockets.push(s));
  return {
    state,
    async listen() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const s of state.sockets) { try { s.destroy(); } catch { /* noop */ } }
      await new Promise(r => server.close(r));
    }
  };
}

test('R5 contract constants: bounded (initial + max 1 retry)', () => {
  assert.strictEqual(MAX_ATTEMPTS, 2, 'max 2 provider attempts per decision');
  for (const status of [408, 429, 500, 502, 503, 504]) assert.ok(RETRYABLE_STATUS.has(status));
  assert.ok(!RETRYABLE_STATUS.has(404));
  assert.ok(!RETRYABLE_STATUS.has(401));
  // 分类：瞬态网络错误可重试；abort/timeout 永不重试
  assert.strictEqual(isRetryableNetworkError(new TypeError('fetch failed')), true);
  const reset = new Error('socket died');
  reset.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.strictEqual(isRetryableNetworkError(reset), true);
  const aborted = new Error('aborted'); aborted.aborted = true;
  assert.strictEqual(isRetryableNetworkError(aborted), false);
  const timedOut = new Error('请求超时'); timedOut.timeout = true;
  assert.strictEqual(isRetryableNetworkError(timedOut), false);
});

test('R5 transient HTTP 5xx/429: one bounded retry recovers the decision', async () => {
  for (const status of [503, 429]) {
    const srv = scriptedServer((req, res, state) => {
      if (state.requests === 1) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `transient ${status}` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(SSE_SUCCESS);
    });
    const base = await srv.listen();
    try {
      const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
      const out = await provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(out.content.includes('RETRY_OK'), `status ${status}: retry must recover`);
      assert.strictEqual(srv.state.requests, 2, `status ${status}: exactly initial + 1 retry`);
    } finally { await srv.close(); }
  }
});

test('R5 persistent 5xx: bounded at exactly 2 attempts, then fail truthfully', async () => {
  const srv = scriptedServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'gateway down for good' } }));
  });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    await assert.rejects(
      provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
      e => /gateway down|503/.test(e.message)
    );
    assert.strictEqual(srv.state.requests, 2, 'no unbounded retry: exactly 2 attempts');
  } finally { await srv.close(); }
});

test('R5 connection reset: transient transport failure recovers via bounded retry', async () => {
  const srv = scriptedServer((req, res, state) => {
    if (state.requests === 1) {
      req.socket.destroy(); // connection reset before any response
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(SSE_SUCCESS);
  });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const out = await provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(out.content.includes('RETRY_OK'));
    assert.strictEqual(srv.state.requests, 2);
  } finally { await srv.close(); }
});

test('R5 non-retryable 4xx: exactly one attempt, no retry', async () => {
  const srv = scriptedServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no such model' } }));
  });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    await assert.rejects(
      provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
      e => /404/.test(e.message)
    );
    assert.strictEqual(srv.state.requests, 1, 'non-retryable errors must not be retried');
  } finally { await srv.close(); }
});

test('R5 cancelled request: never retried', async () => {
  const srv = scriptedServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(SSE_SUCCESS);
  });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }),
      e => e.aborted === true || e.name === 'AbortError'
    );
    assert.strictEqual(srv.state.requests, 0, 'cancelled request must not reach the wire at all');
  } finally { await srv.close(); }
});
