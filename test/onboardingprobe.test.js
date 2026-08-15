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

const { probe, MAX_TOTAL_PROBES, discardResponse } = require('../src/providers/onboarding/probe');
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

test('Probe response cleanup releases unread status-only bodies', async () => {
  let cancelled = 0;
  await discardResponse({ body: { async cancel() { cancelled++; } } });
  await discardResponse(null);
  assert.strictEqual(cancelled, 1);
});

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
    // v2.4.1: 新结构断言
    assert.strictEqual(report.modelDiscovery.status, 'supported', '模型发现应 supported');
    assert.strictEqual(report.modelDiscovery.models.length, 2, '模型发现应 2 个模型');
    const protoOpenai = report.protocols.find(p => p.protocol === 'openai');
    assert.ok(protoOpenai && protoOpenai.status === 'supported', 'protocols: openai supported');
    const protoResponses = report.protocols.find(p => p.protocol === 'openai-responses');
    assert.ok(protoResponses && protoResponses.status === 'unsupported', 'protocols: responses unsupported');
    assert.strictEqual(report.state, 'completed', 'state 应 completed');
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

// ─── MAX_TOTAL_PROBES 上限 ──────────────────────────────────────────────────

test('Probe: 不会暴力探测超过 MAX_TOTAL_PROBES 个请求（§18/§21）', async () => {
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
    // v2.4.1: MAX_TOTAL_PROBES = 6（不再固定 4），请求数不应超过 6
    assert.ok(srv.state.requests.length <= MAX_TOTAL_PROBES, `请求数应 ≤ ${MAX_TOTAL_PROBES}，实际 ${srv.state.requests.length}`);
  } finally {
    await srv.close();
  }
});

// ═══ v2.4.1: §25-§30 False Positive Fixture Tests ═══════════════════════════

// ─── §25: Responses-only（/models ✓, /chat/completions ✕, /responses ✓）─────

test('§25 Responses-only: /models ✓ + /chat/completions ✕ + /responses ✓ → Responses', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }] } },
    '/chat/completions': 404,
    '/responses': 405
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 5000 });
    assert.strictEqual(report.reachable, true, '应可达');
    assert.strictEqual(report.modelDiscovery.status, 'supported', '模型发现应 supported');
    const chat = report.protocols.find(p => p.protocol === 'openai');
    assert.ok(chat && chat.status === 'unsupported', '§25: Chat 应 unsupported（不能因 /models 200 而误判）');
    const responses = report.protocols.find(p => p.protocol === 'openai-responses');
    assert.ok(responses && responses.status === 'supported', 'Responses 应 supported');
    assert.strictEqual(report.recommendedProtocol, 'openai-responses', '应推荐 Responses');
  } finally {
    await srv.close();
  }
});

// ─── §26: Chat-only（/models ✓, /chat/completions ✓, /responses ✕）──────────

test('§26 Chat-only: /models ✓ + /chat/completions ✓ + /responses ✕ → Chat', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }] } },
    '/chat/completions': 405,
    '/responses': 404
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 5000 });
    const chat = report.protocols.find(p => p.protocol === 'openai');
    assert.ok(chat && chat.status === 'supported', 'Chat 应 supported');
    const responses = report.protocols.find(p => p.protocol === 'openai-responses');
    assert.ok(responses && responses.status === 'unsupported', 'Responses 应 unsupported');
    assert.strictEqual(report.recommendedProtocol, 'openai', '应推荐 Chat');
  } finally {
    await srv.close();
  }
});

// ─── §27: Both（/models ✓, /chat/completions ✓, /responses ✓）───────────────

test('§27 Both: Chat + Responses 都 ✓ → Responses recommended', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }] } },
    '/chat/completions': 405,
    '/responses': 405
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 5000 });
    const chat = report.protocols.find(p => p.protocol === 'openai' && p.status === 'supported');
    const responses = report.protocols.find(p => p.protocol === 'openai-responses' && p.status === 'supported');
    assert.ok(chat, 'Chat 应 supported');
    assert.ok(responses, 'Responses 应 supported');
    assert.strictEqual(report.recommendedProtocol, 'openai-responses', '两者都支持时推荐 Responses');
  } finally {
    await srv.close();
  }
});

// ─── §28: Models-only（/models ✓, 所有协议 ✕）→ 不误判任何协议 ─────────────

test('§28 Models-only: /models ✓ + 所有协议 ✕ → 模型发现可用，无生成协议', async () => {
  const srv = fakeServer({
    '/models': { status: 200, body: { data: [{ id: 'gpt-4o' }] } },
    '/chat/completions': 404,
    '/responses': 404,
    '/v1/messages': 404,
    '/api/tags': 404
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 5000 });
    assert.strictEqual(report.modelDiscovery.status, 'supported', '模型发现应 supported');
    assert.ok(report.modelDiscovery.models.length > 0, '应有模型');
    // §28: 不能因为 /models 200 就说 OpenAI Chat supported
    const chat = report.protocols.find(p => p.protocol === 'openai');
    assert.ok(chat && chat.status === 'unsupported', '§28: Chat 应 unsupported（/models ≠ Chat）');
    const responses = report.protocols.find(p => p.protocol === 'openai-responses');
    assert.ok(responses && responses.status === 'unsupported', 'Responses 应 unsupported');
    assert.strictEqual(report.recommendedProtocol, null, '无可用协议时 recommendedProtocol 应 null');
  } finally {
    await srv.close();
  }
});

// ─── §29: Responses without models（/models ✕, /responses ✓）───────────────

test('§29 Responses no models: /models 404 + /responses ✓ → Responses supported', async () => {
  const srv = fakeServer({
    '/models': 404,
    '/chat/completions': 404,
    '/responses': 405
  });
  const base = await srv.listen();
  try {
    const report = await probe(makeCandidate(base + '/v1', 'openai'), { timeoutMs: 5000 });
    assert.strictEqual(report.reachable, true, '应可达');
    assert.notStrictEqual(report.modelDiscovery.status, 'supported', '/models 404 → 模型发现不可用');
    const responses = report.protocols.find(p => p.protocol === 'openai-responses');
    assert.ok(responses && responses.status === 'supported', '不能因 /models 404 就认为 API 不可用');
    assert.strictEqual(report.recommendedProtocol, 'openai-responses', '应推荐 Responses');
  } finally {
    await srv.close();
  }
});

// ─── §30: Unknown Ollama（无 hint，但 /api/tags 200）────────────────────────

test('§30 Unknown Ollama: 无 hint + /api/tags 200 → 识别 Ollama', async () => {
  const srv = fakeServer({
    '/models': 404,
    '/v1/models': 404,
    '/chat/completions': 404,
    '/responses': 404,
    '/v1/messages': 404,
    '/api/tags': { status: 200, body: { models: [{ name: 'llama3' }, { name: 'mistral' }] } }
  });
  const base = await srv.listen();
  try {
    // 无 ollama hint，baseUrl 也不含 11434 / ollama
    const report = await probe(makeCandidate(base, 'custom'), { timeoutMs: 5000 });
    const ollama = report.protocols.find(p => p.protocol === 'ollama');
    assert.ok(ollama && ollama.status === 'supported', '§30: 应通过 /api/tags 200 识别 Ollama（无 hint 也要探测）');
    assert.strictEqual(report.recommendedProtocol, 'ollama', '应推荐 Ollama');
    assert.ok(report.modelDiscovery.models.length >= 2, '应从 /api/tags 发现模型');
  } finally {
    await srv.close();
  }
});
