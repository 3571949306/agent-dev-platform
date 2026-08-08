'use strict';
/**
 * P1-5 — capability detection against REAL local HTTP endpoints.
 *
 * Every test starts an actual server, so we assert on the bytes that were put
 * on the wire (did an image part really get sent? did the tool schema really
 * arrive?) rather than on a mock's bookkeeping.
 *
 * The contract being defended:
 *   - a capability is only reported as `tested` when we truly observed it
 *   - an endpoint saying "I don't do images" → vision {value:false, state:'tested'}
 *   - the network dying → {value:false, state:'unknown'}, NEVER 'tested'
 *   - one button per capability: tools failing must not poison vision
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const providers = require('../src/providers');
const caps = require('../src/providers/capabilities');

/* ------------------------------------------------------------------ helper */

async function serve(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not json */ }
      seen.push({ url: req.url, body: parsed, raw: body });
      handler(req, res, parsed);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, seen, url: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() };
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

const textDelta = (t) => ({ choices: [{ delta: { content: t } }] });

function openaiProvider(url) {
  return providers.getProvider({ provider: 'openai', base_url: url, api_key: 'k' });
}

/* ------------------------------------------------------------------- text */

test('capabilities: 文本探测成功记为 tested/true', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('可用')]));
  try {
    const r = await caps.testText(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.text.value, true);
    assert.strictEqual(r.text.state, 'tested');
  } finally { s.close(); }
});

test('capabilities: 端点不可达时文本记为 unknown 而不是 tested/false', async () => {
  const r = await caps.testText(openaiProvider('http://127.0.0.1:1'), 'm1');
  assert.strictEqual(r.text.value, false);
  assert.strictEqual(r.text.state, 'unknown', '网络错误不构成"模型不支持文本"的证据');
});

/* -------------------------------------------------------------- streaming */

test('capabilities: 收到多个分片才认定支持流式', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('1 '), textDelta('2 '), textDelta('3')]));
  try {
    const r = await caps.testStreaming(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.streaming.value, true);
    assert.strictEqual(r.streaming.state, 'tested');
    assert.match(r.streaming.detail, /收到 3 个分片/);
  } finally { s.close(); }
});

test('capabilities: 服务端一次性返回全部内容时判定为"非真流式"', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('1 2 3 4 5 6 7 8')]));
  try {
    const r = await caps.testStreaming(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.streaming.value, false, '只有一个分片说明服务端做了缓冲');
    assert.strictEqual(r.streaming.state, 'tested');
  } finally { s.close(); }
});

/* ------------------------------------------------------------------ tools */

test('capabilities: 工具探测真的把 tool schema 发上线路', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('好的')]));
  try {
    await caps.testTools(openaiProvider(s.url), 'm1');
    const body = s.seen[0].body;
    assert.ok(Array.isArray(body.tools) && body.tools.length === 1, '请求体必须带 tools');
    assert.strictEqual(body.tools[0].function.name, 'get_weather');
    assert.deepStrictEqual(body.tools[0].function.parameters.required, ['city']);
  } finally { s.close(); }
});

test('capabilities: 模型真的发起工具调用时详情标注"成功发起"', async () => {
  const s = await serve((req, res) => sse(res, [{
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] } }]
  }]));
  try {
    const r = await caps.testTools(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.tools.value, true);
    assert.strictEqual(r.tools.state, 'tested');
    assert.match(r.tools.detail, /成功发起工具调用/);
  } finally { s.close(); }
});

test('capabilities: 端点明确拒绝 tools 时记为 tested/false', async () => {
  const s = await serve((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'this model does not support tool calling' } }));
  });
  try {
    const r = await caps.testTools(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.tools.value, false);
    assert.strictEqual(r.tools.state, 'tested');
    assert.match(r.tools.detail, /拒绝工具定义/);
  } finally { s.close(); }
});

/* ----------------------------------------------------------------- vision */

test('capabilities: 视觉探测真的把 base64 图片发上线路', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('透明')]));
  try {
    const r = await caps.testVision(openaiProvider(s.url), 'gpt-4o');
    assert.strictEqual(r.vision.value, true);
    assert.strictEqual(r.vision.state, 'tested');

    const parts = s.seen[0].body.messages[0].content;
    assert.ok(Array.isArray(parts), 'content 必须是多模态数组');
    const img = parts.find(p => p.type === 'image_url');
    assert.ok(img, '必须包含 image_url part');
    assert.match(img.image_url.url, /^data:image\/png;base64,/);
    assert.ok(img.image_url.url.includes(caps.TINY_PNG), '发送的应当就是那张 1x1 PNG');
  } finally { s.close(); }
});

test('capabilities: 端点回复"不支持图片"时记为 tested/false', async () => {
  const s = await serve((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid content type: image is not supported by this model' } }));
  });
  try {
    const r = await caps.testVision(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.vision.value, false);
    assert.strictEqual(r.vision.state, 'tested');
    assert.match(r.vision.detail, /拒绝图片输入/);
  } finally { s.close(); }
});

test('capabilities: 无法归因于图片的报错不得当作"不支持视觉"', async () => {
  const s = await serve((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded, please retry later' } }));
  });
  try {
    const r = await caps.testVision(openaiProvider(s.url), 'm1');
    assert.strictEqual(r.vision.state, 'unknown', '限流不是视觉能力的证据');
  } finally { s.close(); }
});

test('capabilities: Anthropic 协议下图片转成 source.base64 结构', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '透明' } }) + '\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  try {
    const p = providers.getProvider({ provider: 'anthropic', base_url: s.url, api_key: 'k' });
    await caps.testVision(p, 'claude-3-5-sonnet-latest');
    const parts = s.seen[0].body.messages[0].content;
    const img = parts.find(x => x.type === 'image');
    assert.ok(img, 'Anthropic 请求体必须含 image block');
    assert.strictEqual(img.source.type, 'base64');
    assert.strictEqual(img.source.media_type, 'image/png');
    assert.strictEqual(img.source.data, caps.TINY_PNG);
  } finally { s.close(); }
});

test('capabilities: Ollama 协议下图片走 message.images 数组', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: '透明' }, done: false }) + '\n');
    res.write(JSON.stringify({ done: true }) + '\n');
    res.end();
  });
  try {
    const p = providers.getProvider({ provider: 'ollama', base_url: s.url, api_key: '' });
    await caps.testVision(p, 'llava');
    const msg = s.seen[0].body.messages[0];
    assert.ok(Array.isArray(msg.images), 'Ollama 必须用 images 数组带图');
    assert.strictEqual(msg.images[0], caps.TINY_PNG);
  } finally { s.close(); }
});

/* ------------------------------------------------------------ orchestrator */

test('capabilities: detectCapabilities 逐项独立探测，一项失败不污染其它项', async () => {
  const s = await serve((req, res, body) => {
    // 只对带 tools 的请求报错，其它全部正常
    if (body && body.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'tools are not supported' } }));
    }
    sse(res, [textDelta('a'), textDelta('b')]);
  });
  try {
    const r = await caps.detectCapabilities(openaiProvider(s.url), 'gpt-4o');
    assert.strictEqual(r.text.value, true);
    assert.strictEqual(r.streaming.value, true);
    assert.strictEqual(r.tools.value, false, '工具应被判定为不支持');
    assert.strictEqual(r.vision.value, true, '工具失败不得影响视觉结论');
    assert.ok(r.durationMs >= 0 && r.ranAt, '报告应带耗时与时间戳');
  } finally { s.close(); }
});

test('capabilities: 文本探测失败即短路，其余项记 unknown 不浪费额度', async () => {
  let hits = 0;
  const s = await serve((req, res) => {
    hits++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  try {
    const r = await caps.detectCapabilities(openaiProvider(s.url), 'gpt-4o');
    assert.strictEqual(r.text.state, 'tested');
    assert.strictEqual(r.text.value, false);
    assert.strictEqual(r.streaming.state, 'unknown');
    assert.strictEqual(r.vision.state, 'unknown');
    assert.strictEqual(hits, 1, '短路后不应再发请求');
  } finally { s.close(); }
});

test('capabilities: 未指定模型时全部记为 unknown 而不是崩溃', async () => {
  const r = await caps.detectCapabilities(openaiProvider('http://127.0.0.1:1'), '');
  for (const k of ['text', 'streaming', 'tools', 'vision']) {
    assert.strictEqual(r[k].state, 'unknown');
    assert.match(r[k].detail, /未指定模型/);
  }
});

test('capabilities: onProgress 按顺序回报每一项的开始与结束', async () => {
  const s = await serve((req, res) => sse(res, [textDelta('x'), textDelta('y')]));
  const events = [];
  try {
    await caps.detectCapabilities(openaiProvider(s.url), 'gpt-4o', {
      which: ['text', 'vision'],
      onProgress: (name, phase) => events.push(`${name}:${phase}`)
    });
    assert.deepStrictEqual(events, ['text:running', 'text:done', 'vision:running', 'vision:done']);
  } finally { s.close(); }
});

test('capabilities: toFlags 把报告压成布尔字典供运行时快速判断', () => {
  const flags = caps.toFlags({
    text: { value: true, state: 'tested' },
    vision: { value: false, state: 'unknown' },
    tools: { value: true, state: 'inferred' }
  });
  assert.deepStrictEqual(flags, { text: true, tools: true, vision: false });
});

test('capabilities: classify 能区分传输故障、鉴权失败与业务拒绝', () => {
  assert.strictEqual(caps.classify(new Error('fetch failed')), 'transport');
  assert.strictEqual(caps.classify(new Error('ECONNREFUSED 127.0.0.1:1')), 'transport');
  assert.strictEqual(caps.classify(new Error('401 Unauthorized')), 'auth');
  assert.strictEqual(caps.classify(new Error('404 not found')), 'missing');
  assert.strictEqual(caps.classify(new Error('model refused the request')), 'rejected');
});
