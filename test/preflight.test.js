'use strict';
/**
 * v2.3.1 — P0-1 回归测试：Agent Preflight 的 models 作用域。
 *
 * 旧 Bug：`const models` 定义在第一个 if 块内，agent.model 已设置时第二个 if 访问
 * `models` 抛 ReferenceError（选模型→输入消息→点发送的最核心路径）。
 * 新实现：preflightCheck 是纯函数，models 作用域收敛在 preflight.js 内。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function loadPreflight() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'preflight.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), 'preflight-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(tmp, src);
  try {
    return await import('file://' + tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

test('Case A: agent.model 为空 + conn.models 有模型 → no_model，不抛 ReferenceError', async () => {
  const { preflightCheck } = await loadPreflight();
  const agent = { api_connection_id: 'c1', model: '' };
  const conn = { id: 'c1', models: ['A'] };
  const r = preflightCheck(agent, conn);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'no_model');
  assert.deepStrictEqual(r.modelIds, ['A']);
});

test('Case B: agent.model 有值 + conn.models 空 → no_models_in_conn', async () => {
  const { preflightCheck } = await loadPreflight();
  const agent = { api_connection_id: 'c1', model: 'A' };
  const conn = { id: 'c1', models: [] };
  const r = preflightCheck(agent, conn);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'no_models_in_conn');
});

test('Case C: agent.model 在列表中 → PASS（不抛 ReferenceError）', async () => {
  const { preflightCheck } = await loadPreflight();
  const agent = { api_connection_id: 'c1', model: 'A' };
  const conn = { id: 'c1', models: ['A'] };
  const r = preflightCheck(agent, conn);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hint, undefined);
});

test('Case D: agent.model 不在最新列表 → 允许继续 + hint，不阻断', async () => {
  const { preflightCheck } = await loadPreflight();
  const agent = { api_connection_id: 'c1', model: 'hidden-model' };
  const conn = { id: 'c1', models: ['A'] };
  const r = preflightCheck(agent, conn);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hint, 'model_not_in_list');
});

test('Case E: 无连接 / 无 api_connection_id → no_conn', async () => {
  const { preflightCheck } = await loadPreflight();
  assert.strictEqual(preflightCheck({ model: 'A' }, null).code, 'no_conn');
  assert.strictEqual(preflightCheck({ api_connection_id: 'x', model: 'A' }, undefined).code, 'no_conn');
});

test('模型列表兼容两种形态：string[] 与对象数组 [{id,source}]', async () => {
  const { preflightCheck, modelIdsOf } = await loadPreflight();
  assert.deepStrictEqual(modelIdsOf(['A', 'B']), ['A', 'B']);
  assert.deepStrictEqual(modelIdsOf([{ id: 'A', source: 'remote' }, { id: 'B', source: 'manual' }]), ['A', 'B']);
  const agent = { api_connection_id: 'c1', model: 'B' };
  const conn = { id: 'c1', models: [{ id: 'A', source: 'remote' }, { id: 'B', source: 'manual', favorite: true }] };
  assert.strictEqual(preflightCheck(agent, conn).ok, true);
});
