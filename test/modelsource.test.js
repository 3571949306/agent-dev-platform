'use strict';
/**
 * v2.3.1 — P1-5/P1-15/P1-16/P1-18 模型来源测试。
 *
 * 验证：
 *  - 旧 string[] 数据读取时自动迁移为对象数组（source='cached'）
 *  - 每模型独立 source：merge 后 remote / manual 共存
 *  - 刷新模型保留手动添加的模型（P1-16）
 *  - 收藏持久化（models_json.favorite，唯一真源）
 *  - External Agent 四态映射（P0-4，mapExternalResult）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const store = require('../src/db/store');
const { mapExternalResult } = require('../src/services/externalAgents');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-model-'));
store.init(USER_DATA);

test('旧 string[] 数据读取时自动迁移为对象数组（source=cached）', () => {
  const c = store.connections.create({ name: '旧连接', provider: 'mock', base_url: 'http://x', models: ['A', 'B'] });
  const got = store.connections.get(c.id);
  assert.ok(Array.isArray(got.models), '应归一化为数组');
  assert.deepStrictEqual(got.models.map(m => m.id), ['A', 'B']);
  assert.strictEqual(got.models[0].source, 'cached', '旧数据来源标记为本地缓存');
  assert.strictEqual(got.models[0].favorite, false);
});

test('mergeModels：远端结果进 remote，手动模型保留（P1-16 核心）', () => {
  const c = store.connections.create({ name: 'merge', provider: 'mock', base_url: 'http://x', models: ['A', 'B'] });
  store.connections.addModel(c.id, 'MY-HIDDEN-MODEL'); // manual
  const updated = store.connections.mergeModels(c.id, ['A', 'C'], 'remote');
  const ids = updated.models.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['A', 'C', 'MY-HIDDEN-MODEL'], '手动模型必须保留');
  const a = updated.models.find(m => m.id === 'A');
  const hidden = updated.models.find(m => m.id === 'MY-HIDDEN-MODEL');
  assert.strictEqual(a.source, 'remote', '刷新返回的模型标记 remote');
  assert.strictEqual(hidden.source, 'manual', '手动添加的来源保持不变');
});

test('addModel 幂等且标记 manual + addedAt', () => {
  const c = store.connections.create({ name: 'add', provider: 'mock', base_url: 'http://x' });
  store.connections.addModel(c.id, 'CUSTOM-X');
  store.connections.addModel(c.id, 'CUSTOM-X'); // 重复添加幂等
  const got = store.connections.get(c.id);
  const custom = got.models.filter(m => m.id === 'CUSTOM-X');
  assert.strictEqual(custom.length, 1, '重复添加不得产生重复项');
  assert.strictEqual(custom[0].source, 'manual');
  assert.ok(custom[0].addedAt, '应有 addedAt 时间');
});

test('收藏持久化到 models_json.favorite（重启可读，唯一真源）', () => {
  const c = store.connections.create({ name: 'fav', provider: 'mock', base_url: 'http://x', models: ['A', 'B'] });
  store.connections.setModelFavorite(c.id, 'A', true);
  const got = store.connections.get(c.id);
  const a = got.models.find(m => m.id === 'A');
  assert.strictEqual(a.favorite, true, '收藏应写入数据库');
  const b = got.models.find(m => m.id === 'B');
  assert.strictEqual(b.favorite, false);
  // 刷新后收藏保留
  const after = store.connections.mergeModels(c.id, ['A', 'C'], 'remote');
  assert.strictEqual(after.models.find(m => m.id === 'A').favorite, true, '刷新后收藏必须保留');
});

test('mapExternalResult：外部四态统一映射为 Run 终态（P0-4）', () => {
  assert.deepStrictEqual(mapExternalResult('{"status":"completed","summary":"ok"}'), { status: 'completed', error: null });
  assert.deepStrictEqual(mapExternalResult('{"status":"failed","errors":["TEST_FAILURE"]}'), { status: 'failed', error: 'TEST_FAILURE' });
  assert.deepStrictEqual(mapExternalResult('{"status":"cancelled"}'), { status: 'cancelled', error: null });
  assert.deepStrictEqual(mapExternalResult('{"status":"timeout","summary":"慢"}'), { status: 'timeout', error: '慢' });
  assert.deepStrictEqual(mapExternalResult('不是JSON'), { status: 'failed', error: null }, '无法解析一律 failed');
  assert.deepStrictEqual(mapExternalResult({ status: 'running' }), { status: 'failed', error: null }, '非终态不直接当完成');
});
