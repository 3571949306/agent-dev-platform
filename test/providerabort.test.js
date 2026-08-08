'use strict';
/**
 * P0-1 / P1-8 — Provider Abort Contract.
 *
 * These tests deliberately use a REAL http.Server. A mock provider that checks
 * `signal.aborted` between chunks will pass any fake test and still hang in
 * production, because the failure mode we are guarding against is exactly the
 * case where no chunk ever arrives.
 *
 * The server therefore behaves like a stalled gateway: it accepts the request,
 * writes the SSE headers, and then goes silent forever. The only way out is a
 * transport-level abort — and we assert the server actually observed the socket
 * close, which is impossible to fake from the client side.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { getProvider } = require('../src/providers');
const { runHttpAgent } = require('../src/services/externalAgents');

/** A server that answers headers then stalls. Records every closed socket. */
function stalledServer(opts = {}) {
  const state = { closed: 0, requests: 0, sockets: [], headersSent: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    req.on('close', () => { state.closed++; });
    if (opts.silentHeaders) return;           // never respond at all
    res.writeHead(200, {
      'Content-Type': opts.ndjson ? 'application/x-ndjson' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    state.headersSent++;
    if (opts.preamble) res.write(opts.preamble);
    // ...and then nothing. Ever.
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

/** Wait until `fn()` is truthy, or throw after `ms`. */
async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`超时等待：${label}`);
}

function isAbort(err) {
  return !!err && (err.aborted === true || err.name === 'AbortError' || /abort/i.test(err.message || ''));
}

// ---------------------------------------------------------------- OpenAI Chat
test('P0-1 OpenAI Chat: 服务端挂起不发任何 chunk 时，abort 仍能在 2 秒内中断', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k', models: ['m1'] });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal });

    await waitFor(() => srv.state.headersSent > 0, 3000, '服务端收到请求');
    ac.abort();

    await assert.rejects(p, e => isAbort(e), '中断应抛出 AbortError');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `abort 应在 2 秒内返回，实际 ${elapsed}ms`);

    // The decisive assertion: the socket really went away on the server side.
    await waitFor(() => srv.state.closed > 0, 2000, '服务端观察到连接关闭');
  } finally { await srv.close(); }
});

test('P0-1 OpenAI Chat: 已发部分 SSE 后 abort，同样立即中断', async () => {
  const srv = stalledServer({ preamble: 'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n' });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    let got = '';
    const p = provider.streamResponse({
      model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal,
      onChunk: t => { got += t; }
    });
    await waitFor(() => got.length > 0, 3000, '收到首个 chunk');
    const t0 = Date.now();
    ac.abort();
    await assert.rejects(p, e => isAbort(e));
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(got, '部分');
  } finally { await srv.close(); }
});

test('P0-1 OpenAI Chat: 连响应头都不返回时，abort 也能中断', async () => {
  const srv = stalledServer({ silentHeaders: true });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    const p = provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal });
    await waitFor(() => srv.state.requests > 0, 3000, '服务端收到请求');
    const t0 = Date.now();
    ac.abort();
    await assert.rejects(p, e => isAbort(e));
    assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
});

test('P0-1 OpenAI Chat: 请求发出前信号已 abort 则立即失败，不发起连接', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }),
      e => isAbort(e)
    );
    assert.strictEqual(srv.state.requests, 0, '不应该发出任何请求');
  } finally { await srv.close(); }
});

// ----------------------------------------------------------- OpenAI Responses
test('P0-1 OpenAI Responses: 挂起的 /responses 可被 abort 中断', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai-responses', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal });
    await waitFor(() => srv.state.headersSent > 0, 3000, '服务端收到请求');
    ac.abort();
    await assert.rejects(p, e => isAbort(e));
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(() => srv.state.closed > 0, 2000, '服务端观察到连接关闭');
  } finally { await srv.close(); }
});

// ------------------------------------------------------------------ Anthropic
test('P0-1 Anthropic: 挂起的 /messages 可被 abort 中断', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'anthropic', base_url: base + '/v1', api_key: 'k' });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = provider.streamResponse({ model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal });
    await waitFor(() => srv.state.headersSent > 0, 3000, '服务端收到请求');
    ac.abort();
    await assert.rejects(p, e => isAbort(e));
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(() => srv.state.closed > 0, 2000, '服务端观察到连接关闭');
  } finally { await srv.close(); }
});

// --------------------------------------------------------------------- Ollama
test('P0-1 Ollama: 挂起的 /api/chat（NDJSON）可被 abort 中断', async () => {
  const srv = stalledServer({ ndjson: true });
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'ollama', base_url: base });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = provider.streamResponse({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal });
    await waitFor(() => srv.state.headersSent > 0, 3000, '服务端收到请求');
    ac.abort();
    await assert.rejects(p, e => isAbort(e));
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(() => srv.state.closed > 0, 2000, '服务端观察到连接关闭');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------- External HTTP agent
test('P0-3 HTTP External Agent: abort 返回 cancelled 而不是 failed', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runHttpAgent(
      { name: 'HTTP Agent', adapter_type: 'http', config: { endpoint: base + '/run', timeoutMs: 60000 } },
      '干活', { signal: ac.signal }
    );
    await waitFor(() => srv.state.headersSent > 0, 3000, '服务端收到请求');
    ac.abort();
    const raw = await p;
    assert.ok(Date.now() - t0 < 2000);
    const res = JSON.parse(raw);
    assert.strictEqual(res.status, 'cancelled');
    assert.ok(res.errors.join('').includes('停止'));
  } finally { await srv.close(); }
});

// -------------------------------------------------------------------- Timeout
test('P1-8 超时与用户中断可区分：超时报 timeout 而不是 aborted', async () => {
  const srv = stalledServer();
  const base = await srv.listen();
  try {
    const provider = getProvider({ provider: 'openai', base_url: base + '/v1', api_key: 'k' });
    const t0 = Date.now();
    await assert.rejects(
      provider.streamResponse({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 300 }),
      e => e.timeout === true || /超时/.test(e.message)
    );
    assert.ok(Date.now() - t0 < 2500);
  } finally { await srv.close(); }
});

test('P1-8 linkSignals：外部 abort 与超时合并后互不干扰', async () => {
  const { linkSignals } = require('../src/providers/http');
  const ac = new AbortController();
  const link = linkSignals(5000, ac.signal);
  assert.strictEqual(link.signal.aborted, false);
  ac.abort();
  assert.strictEqual(link.signal.aborted, true);
  assert.strictEqual(link.timedOut, false, '这是用户中断，不该被记成超时');
  link.dispose();

  const link2 = linkSignals(30, null);
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(link2.signal.aborted, true);
  assert.strictEqual(link2.timedOut, true);
  link2.dispose();

  // Already-aborted external signal must abort the link immediately.
  const ac3 = new AbortController();
  ac3.abort();
  const link3 = linkSignals(5000, ac3.signal);
  assert.strictEqual(link3.signal.aborted, true);
  link3.dispose();
});
