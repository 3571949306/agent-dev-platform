'use strict';
/**
 * v2.9.0 Framework Closure Patch — Gap 1 Native Runtime Model Resolution（spec §5-17）。
 *
 * 验证 NativeModelContextResolver 的真实优先级（§9）：
 *   modelOverride → context.model → agent.api_connection_id/model → parentModelContext → 明确失败。
 * 关键点：resolved.model 必须是真实带 decide() 的 ProviderModelAdapter，
 * 而不是 ModelInfo 元数据；且缺省时明确抛 NATIVE_MODEL_CONTEXT_UNRESOLVED（禁止静默 fallback）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createNativeModelContextResolver } = require('../src/agent/orchestrator/nativeModelContextResolver');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');

// 一个真实的「Model Adapter」——带 decide()，模拟 ProviderModelAdapter 接口。
function makeModelAdapter(name) {
  return {
    name: name || 'MockProviderModelAdapter',
    async decide() { return { action: { type: 'complete', args: {} } }; }
  };
}

// 最小 buildProvider / resolveModel（production 由 handlers.js 注入）。
function fakeBuildProvider() {
  return { id: 'fp', streamResponse: async () => ({ content: '' }) };
}
function fakeResolveModel(agent) {
  return { model: (agent && agent.model) || 'deepseek-chat', provider: 'deepseek', connectionId: 'conn-1' };
}

test('resolver 要求 buildProvider 必填', () => {
  assert.throws(() => createNativeModelContextResolver({}), /buildProvider/);
});

test('§9-1 modelOverride 是 ModelAdapter → 直接复用（最高优先级）', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  const override = makeModelAdapter('override');
  const res = r.resolveNativeModelContext({ id: 'native-main' }, { modelOverride: override });
  assert.strictEqual(res.providerModelAdapter, override);
  assert.strictEqual(typeof res.providerModelAdapter.decide, 'function');
});

test('§9-2 context.model（task.context.model）是 ModelAdapter → 继承', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  const inherited = makeModelAdapter('inherited');
  const res = r.resolveNativeModelContext({ id: 'native-main' }, { contextModel: inherited });
  assert.strictEqual(res.providerModelAdapter, inherited);
});

test('§9-3 agent.api_connection_id → 走 createProviderModelAdapter 产出真实 decide()', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  const agent = { id: 'native-main', api_connection_id: 'conn-1', model: 'deepseek-chat' };
  const res = r.resolveNativeModelContext(agent, {});
  assert.ok(res.providerModelAdapter, '应产出 ProviderModelAdapter');
  assert.strictEqual(typeof res.providerModelAdapter.decide, 'function', '必须是带 decide 的真实 adapter，而非 ModelInfo');
  assert.strictEqual(res.modelInfo.model, 'deepseek-chat');
  assert.strictEqual(res.connection, 'conn-1');
});

test('§9-4 agent.model（无 api_connection_id）→ 同样产出真实 adapter', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  const agent = { id: 'native-main', model: 'deepseek-chat' };
  const res = r.resolveNativeModelContext(agent, {});
  assert.strictEqual(typeof res.providerModelAdapter.decide, 'function');
});

test('§9-5 parentModelContext 是 ModelAdapter → 作为兜底（Main Agent 当前 model）', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  const parent = makeModelAdapter('parent');
  // agent 没有任何 model 字段 → 退到 parentModelContext
  const res = r.resolveNativeModelContext({ id: 'native-main' }, { parentModelContext: parent });
  assert.strictEqual(res.providerModelAdapter, parent);
});

test('§9-6 无任何来源 → 明确抛 NATIVE_MODEL_CONTEXT_UNRESOLVED（禁止静默 fallback）', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  assert.throws(
    () => r.resolveNativeModelContext({ id: 'native-main' }, {}),
    /NATIVE_MODEL_CONTEXT_UNRESOLVED/
  );
});

test('isModelAdapter 仅认 decide 函数', () => {
  const r = createNativeModelContextResolver({ buildProvider: fakeBuildProvider, resolveModel: fakeResolveModel });
  // FakeCodingModel 是合法 Model Adapter（带 decide）
  const fc = createFakeCodingModel([{ type: 'complete', args: {} }]);
  const res = r.resolveNativeModelContext({ id: 'native-main' }, { parentModelContext: fc });
  assert.strictEqual(res.providerModelAdapter, fc);
  // ModelInfo 元数据（无 decide）不算 adapter
  assert.throws(
    () => r.resolveNativeModelContext({ id: 'native-main' }, { parentModelContext: { model: 'x' } }),
    /NATIVE_MODEL_CONTEXT_UNRESOLVED/
  );
});
