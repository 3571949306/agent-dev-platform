'use strict';
/**
 * P0-1 — the model the Agent selected must be the model on the wire.
 *
 * These are NOT mocks of our own code: a real HTTP server is started, the real
 * provider adapters send real requests to it, and we assert on the JSON body
 * that actually crossed the socket.
 *
 * Regression under test: v2.0.0 providers used `conn.model || conn.models[0]`
 * and the runtime never passed a model at all, so picking a model in the Agent
 * editor silently did nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { getProvider, resolveModel, inferVision } = require('../src/providers');

// ---------------------------------------------------------------- fake gateway
/**
 * One server speaking all four wire protocols, recording every request body.
 * @returns {Promise<{url:string, bodies:Array, close:Function}>}
 */
async function startGateway() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(raw || '{}'); } catch { json = { _unparsed: raw }; }
      bodies.push({ path: req.url, method: req.method, body: json, headers: req.headers });

      if (req.url.endsWith('/api/chat')) {
        // Ollama NDJSON
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'ok' }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (req.url.endsWith('/responses')) {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok', response: { model: json.model } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { model: json.model, usage: { total_tokens: 3 } } })}\n\n`);
      } else if (req.url.endsWith('/messages')) {
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { model: json.model } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ model: json.model, choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    rootUrl: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise(r => server.close(r))
  };
}

// ------------------------------------------------------------- resolveModel()
test('resolveModel: Agent 指定的模型优先于连接里的一切', () => {
  const r = resolveModel({
    agent: { model: 'model-B' },
    conn: { default_model: 'model-D', models: ['model-A', 'model-B'] }
  });
  assert.strictEqual(r.model, 'model-B');
  assert.strictEqual(r.requested, 'model-B');
  assert.strictEqual(r.source, 'agent');
  assert.strictEqual(r.fellBack, false);
});

test('resolveModel: Agent 未指定才回落 connection.default_model，并如实标记 fellBack', () => {
  const r = resolveModel({ agent: { model: '' }, conn: { default_model: 'model-D', models: ['model-A'] } });
  assert.strictEqual(r.model, 'model-D');
  assert.strictEqual(r.requested, null);
  assert.strictEqual(r.source, 'connection.default_model');
  assert.strictEqual(r.fellBack, true);
});

test('resolveModel: 连接也没有默认值时才用 models[0]，绝不越过 Agent 的选择', () => {
  const r = resolveModel({ agent: {}, conn: { models: ['model-A', 'model-B'] } });
  assert.strictEqual(r.model, 'model-A');
  assert.strictEqual(r.source, 'connection.models[0]');
  assert.strictEqual(r.fellBack, true);
});

test('resolveModel: override（如“用这个模型重跑”）压过 Agent 设置', () => {
  const r = resolveModel({ agent: { model: 'model-B' }, conn: {}, override: 'model-X' });
  assert.strictEqual(r.model, 'model-X');
  assert.strictEqual(r.source, 'agent');
});

test('resolveModel: 什么都没有时返回 null 而不是瞎猜一个模型名', () => {
  const r = resolveModel({ agent: {}, conn: { provider: 'openai' } });
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.source, 'none');
});

// -------------------------------------------------- real wire assertions ×4
test('OpenAI Chat: 真实请求体里的 model 是 Agent 选的 model-B（不是 models[0]）', async () => {
  const gw = await startGateway();
  try {
    const conn = { provider: 'openai', base_url: gw.url, api_key: 'sk-test', models: ['model-A', 'model-B'] };
    const p = getProvider(conn);
    const r = await p.streamResponse({ model: 'model-B', system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const sent = gw.bodies.find(b => b.path.endsWith('/chat/completions'));
    assert.ok(sent, '应当命中 /chat/completions');
    assert.strictEqual(sent.body.model, 'model-B');
    assert.strictEqual(r.model, 'model-B');
    assert.strictEqual(r.responseModel, 'model-B');
  } finally { await gw.close(); }
});

test('OpenAI Responses: 真实请求体里的 model 是 Agent 选的 model-B', async () => {
  const gw = await startGateway();
  try {
    const conn = { provider: 'openai-responses', base_url: gw.url, api_key: 'sk-test', models: ['model-A', 'model-B'] };
    const r = await getProvider(conn).streamResponse({ model: 'model-B', system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const sent = gw.bodies.find(b => b.path.endsWith('/responses'));
    assert.ok(sent, '应当命中 /responses');
    assert.strictEqual(sent.body.model, 'model-B');
    assert.strictEqual(r.responseModel, 'model-B');
  } finally { await gw.close(); }
});

test('Anthropic: 真实请求体里的 model 是 Agent 选的 model-B', async () => {
  const gw = await startGateway();
  try {
    const conn = { provider: 'anthropic', base_url: gw.url, api_key: 'sk-ant', models: ['claude-A', 'model-B'] };
    const r = await getProvider(conn).streamResponse({ model: 'model-B', system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const sent = gw.bodies.find(b => b.path.endsWith('/messages'));
    assert.ok(sent, '应当命中 /messages');
    assert.strictEqual(sent.body.model, 'model-B');
    assert.strictEqual(r.responseModel, 'model-B');
  } finally { await gw.close(); }
});

test('Ollama: 真实请求体里的 model 是 Agent 选的 model-B', async () => {
  const gw = await startGateway();
  try {
    const conn = { provider: 'ollama', base_url: gw.rootUrl, models: ['qwen2.5:7b', 'model-B'] };
    const r = await getProvider(conn).streamResponse({ model: 'model-B', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const sent = gw.bodies.find(b => b.path.endsWith('/api/chat'));
    assert.ok(sent, '应当命中 /api/chat');
    assert.strictEqual(sent.body.model, 'model-B');
    assert.strictEqual(r.model, 'model-B');
  } finally { await gw.close(); }
});

test('四种协议：不传 model 时才允许回落连接配置（回落行为本身仍然保留）', async () => {
  const gw = await startGateway();
  try {
    await getProvider({ provider: 'openai', base_url: gw.url, api_key: 'k', models: ['fallback-A'] })
      .streamResponse({ messages: [{ role: 'user', content: 'hi' }] });
    const sent = gw.bodies.find(b => b.path.endsWith('/chat/completions'));
    assert.strictEqual(sent.body.model, 'fallback-A');
  } finally { await gw.close(); }
});

test('OpenAI Chat: 完全没有模型信息时抛出可读错误，而不是发一个空 model 上去', async () => {
  const p = getProvider({ provider: 'openai', base_url: 'http://127.0.0.1:1/v1', api_key: 'k', models: [] });
  await assert.rejects(
    () => p.streamResponse({ messages: [{ role: 'user', content: 'hi' }] }),
    /未指定模型/
  );
});

// ------------------------------------------------------------ vision 能力推断
test('inferVision: 已知视觉模型标 true，普通文本模型标 false，空值为 unknown', () => {
  assert.strictEqual(inferVision('gpt-4o').value, true);
  assert.strictEqual(inferVision('gpt-4o').state, 'inferred');
  assert.strictEqual(inferVision('claude-3-5-sonnet-latest').value, true);
  assert.strictEqual(inferVision('qwen2.5-vl-7b').value, true);
  assert.strictEqual(inferVision('llava:13b').value, true);
  assert.strictEqual(inferVision('deepseek-r1').value, false);
  assert.strictEqual(inferVision('').state, 'unknown');
});
