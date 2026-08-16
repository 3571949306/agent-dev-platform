'use strict';
/**
 * v2.9.9 体验对标 Phase 1 — 原生 Tool Calling 适配测试。
 *
 * 覆盖：
 *  - provider 返回 toolCalls 时 adapter 正确转出 action（且 tools 定义真实下发）
 *  - provider 不支持 tools（protocol 不在白名单）时不盲发 tools，行为与现状一致（回归保护）
 *  - tool_calls.arguments 为非法 JSON 时不产出 action，回退文本路径（AGENT_RESPONSE_INVALID 语义由 Loop 兜底）
 *  - buildActionTools 与 ACTION_TYPES 对齐（16 个，name 即 type）
 *
 * 全部使用 fake provider，不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { buildActionTools } = require('../src/agent/runtime/actionToolSchema');
const { ACTION_TYPES } = require('../src/agent/runtime/actionSchema');

function makeAdapter(provider, agent = { model: 'm', max_tokens: 100 }) {
  return createProviderModelAdapter({ buildProvider: async () => provider, agent });
}

test('buildActionTools 与 ACTION_TYPES 对齐（16 个，name 即 type）', () => {
  const tools = buildActionTools();
  assert.strictEqual(tools.length, ACTION_TYPES.length, 'tool 数量应等于 action 类型数');
  assert.strictEqual(ACTION_TYPES.length, 16, 'ACTION_TYPES 应为 16 个');
  for (const t of tools) {
    assert.ok(ACTION_TYPES.includes(t.name), `tool name ${t.name} 必须是合法 action type`);
    assert.strictEqual(t.parameters.type, 'object');
    assert.ok(Array.isArray(t.parameters.required));
  }
});

test('provider 返回 toolCalls → adapter 转出 action 且真实下发 tools', async () => {
  let seenTools = null;
  const provider = {
    protocol: 'anthropic',
    streamResponse: async (opts) => {
      seenTools = opts.tools;
      return { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) }] };
    }
  };
  const adapter = makeAdapter(provider);
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.ok(Array.isArray(seenTools) && seenTools.length === 16, '应向支持 tools 的 provider 下发 16 个 tool 定义');
  assert.ok(d.action, '应带出结构化 action');
  assert.strictEqual(d.action.type, 'read_file');
  assert.deepStrictEqual(d.action.args, { path: 'a.js' });
});

test('provider 不支持 tools → 不盲发 tools，行为与现状一致（回归保护）', async () => {
  let seenTools = 'unset';
  const provider = {
    protocol: 'ollama', // 不在白名单
    streamResponse: async (opts) => { seenTools = opts.tools; return { content: '{"type":"read_file","args":{"path":"a.js"}}', toolCalls: null }; }
  };
  const adapter = makeAdapter(provider);
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(seenTools, undefined, '不支持 tools 的 provider 不应收到 tools 字段');
  assert.strictEqual(d.action, undefined, '文本路径不产出 action，交由 Loop parseAndValidate');
  assert.ok(d.text.includes('read_file'), '文本原样返回');
});

test('toolCalls.arguments 非法 JSON → 不产出 action，回退文本路径', async () => {
  const provider = {
    protocol: 'openai-chat',
    streamResponse: async () => ({ content: 'fallback-text', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{not-json' }] })
  };
  const adapter = makeAdapter(provider);
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(d.action, undefined, '非法 arguments 不得产出 action');
  assert.strictEqual(d.text, 'fallback-text');
});

test('toolCalls 未知 action type → validateAction 拒绝，回退文本路径', async () => {
  const provider = {
    protocol: 'anthropic',
    streamResponse: async () => ({ content: '', toolCalls: [{ id: 'c1', name: 'hack_the_planet', arguments: '{}' }] })
  };
  const adapter = makeAdapter(provider);
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(d.action, undefined, '未知 type 必须被拒绝');
});

test('agent.workspace.toolCalling=false → 显式关闭原生 tool calling', async () => {
  let seenTools = 'unset';
  const provider = {
    protocol: 'anthropic',
    streamResponse: async (opts) => { seenTools = opts.tools; return { content: 'x', toolCalls: null }; }
  };
  const adapter = makeAdapter(provider, { model: 'm', workspace: { toolCalling: false } });
  await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(seenTools, undefined, '显式关闭后不得下发 tools');
});
