'use strict';
/**
 * v2.9.9 体验对标 Phase 5 — 真实多轮消息历史测试。
 *
 *  - tool_use/tool_result 严格配对（validatePairing）
 *  - compactHistory 压缩后 role 序列仍合法（不破坏配对）
 *  - adapter：supportsTools 时消费 history（首条 user=任务描述）；文本路径忽略 history
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { makeToolCallId, pushAssistant, pushToolResult, toProviderMessages, compactHistory, validatePairing } = require('../src/agent/runtime/multiturn');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');

test('配对与 role 序列合法', () => {
  const h = [];
  const id = makeToolCallId('r', 1, 0);
  pushAssistant(h, { text: '读文件', toolCalls: [{ id, name: 'read_file', arguments: '{"path":"a.js"}' }] });
  pushToolResult(h, id, 'content');
  const msgs = toProviderMessages(h, '任务：修复构建');
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, '任务：修复构建');
  assert.ok(validatePairing(msgs).ok, '配对应成立');
});

test('孤立 tool_result 被检出', () => {
  const msgs = [{ role: 'user', content: 't' }, { role: 'tool', tool_call_id: 'x', content: 'y' }];
  assert.strictEqual(validatePairing(msgs).ok, false);
});

test('compactHistory 压缩后配对仍合法', () => {
  const h = [];
  for (let i = 0; i < 20; i++) {
    const id = makeToolCallId('r', i, 0);
    pushAssistant(h, { toolCalls: [{ id, name: 'read_file', arguments: '{}' }] });
    pushToolResult(h, id, 'res' + i);
  }
  const { history, summary } = compactHistory(h, 6);
  assert.ok(summary.includes('历史摘要'), '应产出摘要');
  assert.ok(history.length <= 6, '保留区不超 keepRecent');
  const msgs = toProviderMessages(history, 'task');
  assert.ok(validatePairing(msgs).ok, '压缩后配对仍应成立');
  // 保留区不应以孤立 tool 开头
  assert.notStrictEqual(history[0].role, 'tool');
});

test('adapter：supportsTools 消费 history（首条 user=任务描述）', async () => {
  let seen = null;
  const provider = { protocol: 'anthropic', streamResponse: async (o) => { seen = o.messages; return { content: '', toolCalls: null }; } };
  const adapter = createProviderModelAdapter({ buildProvider: async () => provider, agent: { model: 'm' } });
  const inner = [{ role: 'assistant', tool_calls: [{ id: 'a', name: 'read_file', arguments: '{}' }] }, { role: 'tool', tool_call_id: 'a', content: 'x' }];
  const history = toProviderMessages(inner, '任务：修复构建'); // loop 侧负责加首条 user
  await adapter.decide({ system: 's', context: 'CTX', history });
  assert.strictEqual(seen[0].role, 'user', '首条应为任务描述 user');
  assert.ok(seen.length >= 3, '应包含历史 assistant+tool');
  assert.notStrictEqual(seen[0].content, 'CTX', '多轮路径不应退化为单条 context');
});

test('adapter：文本路径忽略 history（回归保护）', async () => {
  let seen = null;
  const provider = { protocol: 'ollama', streamResponse: async (o) => { seen = o.messages; return { content: 'CTX-echo', toolCalls: null }; } };
  const adapter = createProviderModelAdapter({ buildProvider: async () => provider, agent: { model: 'm' } });
  await adapter.decide({ system: 's', context: 'CTX', history: [{ role: 'assistant', tool_calls: [{ id: 'a', name: 'read_file', arguments: '{}' }] }] });
  assert.strictEqual(seen.length, 1, '文本路径应仍为单条 user');
  assert.strictEqual(seen[0].content, 'CTX');
});
