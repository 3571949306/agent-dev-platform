'use strict';
/**
 * v2.4.0 — Protocol Probe Fixture Tests（spec §71 / §72）。
 *
 * 用真实 http.Server 模拟 4 类网关 + 1 类 hang：
 *   Server A: /models ✓, /chat/completions ✓, /responses ✕  → OpenAI Chat
 *   Server B: /models ✓, /chat/completions ✓, /responses ✓  → Responses recommended, Chat also available
 *   Server C: /messages ✓                                    → Anthropic
 *   Server D: /models 404, /chat/completions ✓               → 可用，模型发现不可用
 *   Hang:     永不响应                                         → Cancel < 2s（§72）
 *
 * §29: 复用 v2.2 HTTP Abort 合约（linkSignals）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { probe } = require('../src/providers/onboarding/probe');
const { createCandidate } = require('../src/providers/onboarding/candidate');

/** 构造一个按路由表响应的 fake server。routes: { [path]: status | {status, body} } */
function fakeServer(routes, opts = {}) {
  const state = { requests: [], sockets: [] };
  const server = http.createServer((req, res) => {
    state.requests.push(req.url);
    // hang 模式：永不响应
    if (opts.hang) return;
    const url = req.url;
    // 精确匹配优先；否则按最长后缀匹配（/v1/chat/completions → /chat/completions）
    let rule = routes[url];
    if (!rule) {
      let bestKey = null;
      for (const k of Object.keys(routes)) {
        if (url === k) { bestKey = k; break; }
        if (url.endsWith(k) && (bestKey === null || k.length > bestKey.length)) bestKey = k;
      }
      if (bestKey) rule = routes[bestKey];
    }
    if (!rule) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const status = typeof rule === 'number' ? rule : rule.status;
    const body = typeof rule === 'object' && rule.body !== undefined ? rule.body : null;
    const headers = (typeof rule === 'object' && rule.headers) || { 'Content-Type': 'application/json' };
    res.writeHead(status, headers);
    if (body !== null) res.end(typeof body === 'string' ? body : JSON.stringify(body));
    else res.end();
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

function makeCandidate(baseUrl, protocolHint) {
  const c = createCandidate();
  c.baseUrl = baseUrl;
  c.apiKey = 'sk-test';
  c.protocolHint = protocolHint || 'openai';
  return c;
}

// ─── Server A: OpenAI Chat ──────────────────────────────────────────────────

test('Probe Server A: /models ✓ + /responses ✕ → OpenAI Chat', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } },
    '/chat/completions': 405, // 端点存在（GET 不允许）
    '/responses': 404
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 4000 });
    assert.strictEqual(report.aborted, false, '不应被 abort');
    assert.strictEqual(report.reachable, true, '应可达');
    assert.ok(report.models.length >= 2, '应发现 2 个模型');
    const openai = report.candidates.find(c => c.protocol === 'openai');
    assert.ok(openai && openai.status === 'supported', 'openai chat 应 supported');
    const responses = report.candidates.find(c => c.protocol === 'openai-responses');
    assert.ok(responses && responses.status === 'unsupported', 'responses 应 unsupported');
    assert.strictEqual(report.recommendedProtocol, 'openai', '应推荐 OpenAI Chat');
  } finally {
    await srv.close();
  }
});

// ─── Server B: Responses recommended, Chat also available ───────────────────

test('Probe Server B: Chat + Responses 都 ✓ → Responses recommended', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }] } },
    '/chat/completions': 405,
    '/responses': 405
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 4000 });
    assert.strictEqual(report.reachable, true);
    const openai = report.candidates.find(c => c.protocol === 'openai' && c.status === 'supported');
    const responses = report.candidates.find(c => c.protocol === 'openai-responses' && c.status === 'supported');
    assert.ok(openai, 'Chat 应 supported');
    assert.ok(responses, 'Responses 应 supported');
    assert.strictEqual(report.recommendedProtocol, 'openai-responses', '§31: 两者都支持时推荐 Responses');
  } finally {
    await srv.close();
  }
});

// ─── Server C: Anthropic ────────────────────────────────────────────────────

test('Probe Server C: /messages ✓ → Anthropic', async () => {
  const srv = fakeServer({
    '/v1/messages': 405,
    '/models': 404
  });
  const base = await srv.listen();
  try {
    const c = makeCandidate(base, 'anthropic');
    const report = await probe(c, { timeoutMs: 4000 });
    assert.strictEqual(report.reachable, true);
    const anthropic = report.candidates.find(p => p.protocol === 'anthropic' && p.status === 'supported');
    assert.ok(anthropic, 'anthropic 应 supported');
    assert.strictEqual(report.recommendedProtocol, 'anthropic');
  } finally {
    await srv.close();
  }
});

// ─── Server D: 模型发现不可用，但连接可用 ────────────────────────────────────

test('Probe Server D: /models 404 + /chat/completions ✓ → 可用，无模型', async () => {
  const srv = fakeServer({
    '/models': 404,
    '/chat/completions': 405
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 4000 });
    assert.strictEqual(report.reachable, true, '连接应可用');
    assert.strictEqual(report.models.length, 0, '模型发现不可用，应为空');
    const openai = report.candidates.find(c => c.protocol === 'openai' && c.status === 'supported');
    assert.ok(openai, '通过 /chat/completions 应确认 OpenAI Chat 端点存在');
    assert.strictEqual(report.recommendedProtocol, 'openai');
  } finally {
    await srv.close();
  }
});

// ─── §72 Probe Abort ────────────────────────────────────────────────────────

test('Probe Abort: hang server + cancel < 2s（§72）', async () => {
  const srv = fakeServer({}, { hang: true });
  const base = await srv.listen();
  try {
    const c = makeCandidate(base + '/v1', 'openai');
    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = probe(c, { timeoutMs: 30000, signal: ctrl.signal });
    // 100ms 后取消
    setTimeout(() => ctrl.abort(), 100);
    const report = await p;
    const elapsed = Date.now() - t0;
    assert.ok(report.aborted, '应标记为 aborted');
    assert.ok(elapsed < 2000, `取消应在 2s 内结束，实际 ${elapsed}ms`);
  } finally {
    await srv.close();
  }
});

// ─── 缺少 baseUrl ───────────────────────────────────────────────────────────

test('Probe: 缺少 baseUrl 返回错误，不崩溃', async () => {
  const c = createCandidate();
  c.apiKey = 'sk-x';
  c.baseUrl = null;
  const report = await probe(c, { timeoutMs: 1000 });
  assert.strictEqual(report.reachable, false);
  assert.ok(report.error, '应返回错误说明');
});

// ─── MAX_PROBES 上限 ────────────────────────────────────────────────────────

test('Probe: 不会暴力探测超过 MAX_PROBES 个请求（§28）', async () => {
  const srv = fakeServer({
    '/models': 404,
    '/v1/models': 404,
    '/chat/completions': 405,
    '/responses': 405,
    '/v1/messages': 405,
    '/api/tags': 404
  });
  const base = await srv.listen();
  try {
    // baseUrl 不含 /v1，candidateModelPaths 会返回 ['/v1/models', '/models'] 两个
    const report = await probe(makeCandidate(base, 'openai'), { timeoutMs: 5000 });
    // MAX_PROBES = 4，请求数不应超过 4
    assert.ok(srv.state.requests.length <= 4, `请求数应 ≤ 4，实际 ${srv.state.requests.length}`);
  } finally {
    await srv.close();
  }
});
