'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getProvider, guessCapabilities } = require('../src/providers');
const { authHeaders, baseUrlOf, interpretError, streamSSE } = require('../src/providers/http');
const { toChatMessages, toOpenAITools } = require('../src/providers/openai');

test('协议路由：每种 provider 映射到正确的适配器', () => {
  const mk = (provider) => getProvider({ provider, base_url: 'http://x/v1' });
  assert.strictEqual(mk('openai').protocol, 'openai-chat');
  assert.strictEqual(mk('openai-responses').protocol, 'openai-responses');
  assert.strictEqual(mk('anthropic').protocol, 'anthropic');
  assert.strictEqual(mk('ollama').protocol, 'ollama');
  assert.strictEqual(mk('local').protocol, 'openai-chat');
  assert.strictEqual(mk('mock').protocol, 'mock');
  assert.strictEqual(mk('custom').protocol, 'openai-chat');
});

test('无连接时 getProvider 抛错', () => {
  assert.throws(() => getProvider(null), /未提供 API 连接/);
});

test('baseUrlOf 去掉尾部斜杠', () => {
  assert.strictEqual(baseUrlOf({ base_url: 'https://api.openai.com/v1///' }), 'https://api.openai.com/v1');
});

test('authHeaders 带上 Bearer，本地/ollama 不带', () => {
  assert.strictEqual(authHeaders({ provider: 'openai', api_key: 'sk-abc' }).Authorization, 'Bearer sk-abc');
  assert.strictEqual(authHeaders({ provider: 'local', api_key: 'sk-abc' }).Authorization, undefined);
  assert.strictEqual(authHeaders({ provider: 'ollama', api_key: 'sk-abc' }).Authorization, undefined);
  assert.strictEqual(authHeaders({ provider: 'openai', api_key: '   ' }).Authorization, undefined);
});

test('authHeaders 合并自定义 headers', () => {
  const h = authHeaders({ provider: 'custom', api_key: 'k', headers: { 'X-Trace': '1' } });
  assert.strictEqual(h['X-Trace'], '1');
  assert.strictEqual(h['Content-Type'], 'application/json');
});

test('interpretError 把状态码翻成人话', () => {
  assert.match(interpretError(401, '{}'), /API Key 无效/);
  assert.match(interpretError(429, '{}'), /过于频繁|额度/);
  assert.match(interpretError(404, '{}'), /模型不存在|接口地址/);
  assert.strictEqual(interpretError(500, '{"error":{"message":"boom"}}'), 'boom');
});

test('toChatMessages 正确编码 tool_calls 与 tool 结果', () => {
  const out = toChatMessages('SYS', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }
  ]);
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[2].tool_calls[0].type, 'function');
  assert.strictEqual(out[2].tool_calls[0].function.name, 'read_file');
  assert.strictEqual(out[3].role, 'tool');
  assert.strictEqual(out[3].tool_call_id, 'c1');
});

test('toOpenAITools 生成 function schema', () => {
  const t = toOpenAITools([{ name: 'x', description: 'd' }]);
  assert.strictEqual(t[0].type, 'function');
  assert.strictEqual(t[0].function.name, 'x');
  assert.deepStrictEqual(t[0].function.parameters, { type: 'object', properties: {} });
});

test('streamSSE 正确解析分片 SSE 并忽略 [DONE] 与坏行', async () => {
  const chunks = [
    'data: {"a":1}\n\ndata: {"a":',
    '2}\n\ndata: garbage\n\ndata: [DONE]\n\n'
  ];
  const body = {
    getReader() {
      let i = 0;
      return { read: async () => (i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true }) };
    }
  };
  const got = [];
  for await (const o of streamSSE({ body })) got.push(o);
  assert.deepStrictEqual(got, [{ a: 1 }, { a: 2 }]);
});

test('Mock provider 流式输出文本', async () => {
  const p = getProvider({ provider: 'mock', mockText: 'hello world' });
  const parts = [];
  const r = await p.streamResponse({ messages: [], tools: [], onChunk: c => parts.push(c) });
  assert.strictEqual(r.content, 'hello world');
  assert.strictEqual(parts.join(''), 'hello world');
});

test('Mock provider 脚本模式按步返回 tool_call 后返回文本', async () => {
  const p = getProvider({
    provider: 'mock',
    mockScript: [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { text: '完成' }
    ]
  });
  const r1 = await p.streamResponse({ messages: [], tools: [] });
  assert.strictEqual(r1.toolCalls[0].name, 'read_file');
  assert.strictEqual(JSON.parse(r1.toolCalls[0].arguments).path, 'a.txt');
  const r2 = await p.streamResponse({ messages: [], tools: [] });
  assert.strictEqual(r2.content, '完成');
  assert.strictEqual(r2.toolCalls, null);
});

test('abort 信号会让 Mock 立即抛出', async () => {
  const p = getProvider({ provider: 'mock' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => p.streamResponse({ messages: [], tools: [], signal: ac.signal }), /aborted/);
});

test('guessCapabilities 对推理模型标记 reasoning', () => {
  assert.strictEqual(guessCapabilities('deepseek-r1').reasoning, true);
  assert.strictEqual(guessCapabilities('gpt-4o').vision, true);
  assert.strictEqual(guessCapabilities('some-random-model').reasoning, false);
});

/* ----------------------------------------------------------- P1-7 模型列表 */

test('P1-7: Anthropic 内置推荐模型都是完整合法 id（不再有 claude-opus-4- 这种截断 id）', async () => {
  const p = getProvider({ provider: 'anthropic', base_url: 'http://127.0.0.1:9/v1' }); // 不可达 → 走内置
  const r = await p.listModelsDetailed();
  assert.strictEqual(r.source, 'preset', '无法取远程列表时应诚实标记为 preset');
  assert.ok(Array.isArray(r.models) && r.models.length >= 5);
  for (const id of r.models) {
    assert.ok(id && typeof id === 'string', '模型 id 必须是非空字符串');
    assert.ok(!id.endsWith('-'), `模型 id 不允许以连字符结尾（旧的截断 bug）: ${id}`);
    assert.ok(!id.endsWith('_'), `模型 id 不允许以下划线结尾: ${id}`);
  }
  assert.match(r.note, /内置|推荐/);
  // 旧版会返回的非法 id 绝不应出现
  assert.ok(!r.models.includes('claude-opus-4-'));
  assert.ok(!r.models.includes('claude-sonnet-4-'));
});

test('P1-7: Anthropic listModels 与 listModelsDetailed 的模型数组一致', async () => {
  const p = getProvider({ provider: 'anthropic', base_url: 'http://127.0.0.1:9/v1' });
  const d = await p.listModelsDetailed();
  const l = await p.listModels();
  assert.deepStrictEqual(l, d.models);
});

test('P1-7: 所有 provider 都暴露 listModelsDetailed 且形状统一', async () => {
  // 仅校验方法存在性；openai/ollama 的详细实现会真实请求 /models，
  // 在无网环境下会抛错，不在此断言其远程结果。
  for (const provider of ['openai', 'openai-responses', 'ollama', 'anthropic', 'mock']) {
    const p = getProvider({ provider, base_url: 'http://127.0.0.1:9/v1' });
    assert.strictEqual(typeof p.listModelsDetailed, 'function', `${provider} 应暴露 listModelsDetailed`);
  }
  // mock 不联网，可确定性地校验返回形状与 source 标签
  const m = getProvider({ provider: 'mock' });
  const r = await m.listModelsDetailed();
  assert.ok(Array.isArray(r.models));
  assert.strictEqual(r.source, 'preset');
  assert.match(r.note, /内置|测试/);
});

