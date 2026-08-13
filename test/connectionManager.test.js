'use strict';
/**
 * v2.9.9 Phase B Final — B15 Connection Manager 3.0 契约测试。
 *
 * 机器证明（B15 Tests）：
 *   CONNECTION_CREATE / CONNECTION_TEST / CONNECTION_FETCH_MODELS /
 *   CONNECTION_MANUAL_MODEL / CONNECTION_FAVORITE_PERSIST /
 *   CONNECTION_SECRET_MASK / CUSTOM_HEADER_SECRET_MASK /
 *   FALLBACK_MODEL_SOURCE_TRUTH
 *
 * 以及 B15.1 状态词汇真话：AVAILABLE / UNAVAILABLE / DEGRADED / UNKNOWN / ERROR
 * 只能来自真实测试结果，绝不猜测。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('../src/db/store');
const providers = require('../src/providers');
const { resolveConnectionStatus, resolveAuthMode, CONNECTION_STATUS } = require('../src/services/connectionStatus');

const FIXTURE_API_KEY = 'SECRET_API_KEY_918273';
const FIXTURE_HEADER_VALUE = 'SECRET_AUTH_HEADER_7821';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-connmgr-'));
store.init(ROOT);

function leakScan(text, secrets) {
  const s = String(text);
  for (const secret of secrets) {
    if (s.includes(secret)) return secret;
  }
  return null;
}

test('B15 create + test + models + manual + favorite (real provider contracts)', async () => {
  // CONNECTION_CREATE — mock provider 连接（无网络）
  const conn = store.connections.create({
    name: 'B15 Mock', provider: 'mock', base_url: 'mock://b15', api_key: '',
    headers: {}, models: []
  });
  assert.ok(conn.id, 'connection created');
  assert.strictEqual(conn.status === undefined, true, 'store 投影不伪造状态字段（状态由统一推导源附加）');
  console.log('CONNECTION_CREATE=PASS');

  // CONNECTION_TEST — 必须真实调用现有 provider test contract
  const decrypted = store.connections.getDecrypted(conn.id);
  const result = await providers.getProvider(decrypted).testConnection();
  assert.strictEqual(result.ok, true, 'mock provider test contract is real');
  store.connections.setTestResult(conn.id, { ok: result.ok, error: '', latency: result.latency, kind: 'ok' });
  const afterTest = store.connections.get(conn.id);
  assert.strictEqual(resolveConnectionStatus(afterTest).status, CONNECTION_STATUS.AVAILABLE);
  console.log('CONNECTION_TEST=PASS');

  // CONNECTION_FETCH_MODELS — mock provider 返回 preset（回退）来源，绝不得冒充 remote
  const detailed = await providers.getProvider(decrypted).listModelsDetailed();
  assert.strictEqual(detailed.source, 'preset', 'mock models are fallback, never remote');
  const merged = store.connections.mergeModels(conn.id, detailed.models, detailed.source);
  const sources = new Set(merged.models.map(m => m.source));
  assert.ok(!sources.has('remote'), 'fallback models must never be recorded as remote');
  assert.ok(sources.has('preset'));
  console.log('CONNECTION_FETCH_MODELS=PASS');
  console.log('FALLBACK_MODEL_SOURCE_TRUTH=PASS');

  // CONNECTION_MANUAL_MODEL — 手动添加 source 必须是 manual（幂等）
  store.connections.addModel(conn.id, 'my-custom-model');
  store.connections.addModel(conn.id, 'my-custom-model');
  const withManual = store.connections.get(conn.id);
  const manualModels = withManual.models.filter(m => m.id === 'my-custom-model');
  assert.strictEqual(manualModels.length, 1, 'manual add is idempotent');
  assert.strictEqual(manualModels[0].source, 'manual');
  console.log('CONNECTION_MANUAL_MODEL=PASS');

  // CONNECTION_FAVORITE_PERSIST — 收藏重启保留（重新 init 同一 DB）
  store.connections.setModelFavorite(conn.id, 'my-custom-model', true);
  store.init(ROOT);
  const reopened = store.connections.get(conn.id);
  const fav = reopened.models.find(m => m.id === 'my-custom-model');
  assert.strictEqual(fav.favorite, true, 'favorite survives restart');
  console.log('CONNECTION_FAVORITE_PERSIST=PASS');
});

test('B15.3/B15.4 secret masking: API key and custom header values never appear in public projections', async () => {
  const conn = store.connections.create({
    name: 'B15 Secrets', provider: 'custom', base_url: 'http://127.0.0.1:9/v1',
    api_key: FIXTURE_API_KEY,
    headers: { 'X-Auth-Token': FIXTURE_HEADER_VALUE, 'X-Plain': 'not-a-secret-but-masked' }
  });

  // 存储层：headers_json 密文不含明文（非空值必须加密）
  const rawRow = store.getDb().prepare('SELECT headers_json, api_key_enc FROM api_connections WHERE id=?').get(conn.id);
  assert.strictEqual(leakScan(rawRow.headers_json, [FIXTURE_HEADER_VALUE, 'not-a-secret-but-masked']), null,
    'stored headers_json must not contain plaintext values');
  assert.ok(!rawRow.api_key_enc.includes(FIXTURE_API_KEY));

  // 公开投影（Renderer 可见面）：绝不出现明文密钥/请求头值，且不含 api_key_enc / headers_json 原始字段
  for (const projection of [store.connections.get(conn.id), store.connections.list().find(c => c.id === conn.id)]) {
    assert.ok(projection, 'projection exists');
    const leaked = leakScan(JSON.stringify(projection), [FIXTURE_API_KEY, FIXTURE_HEADER_VALUE, 'not-a-secret-but-masked']);
    assert.strictEqual(leaked, null, 'public projection must never contain secrets');
    assert.strictEqual(projection.api_key_enc, undefined, 'encrypted key blob must not cross the IPC boundary');
    assert.strictEqual(projection.headers_json, undefined, 'raw headers_json must not cross the IPC boundary');
    assert.ok(projection.api_key_masked && projection.api_key_masked.includes('*'), 'API key shows mask only');
    assert.strictEqual(projection.headers['X-Auth-Token'], '••••••••', 'header value shows mask only');
    assert.deepStrictEqual(projection.header_names.sort(), ['X-Auth-Token', 'X-Plain']);
  }

  // 解密边界（仅 main 进程）仍能还原真实值 —— provider 请求头功能不受影响
  const decrypted = store.connections.getDecrypted(conn.id);
  assert.strictEqual(decrypted.headers['X-Auth-Token'], FIXTURE_HEADER_VALUE);
  assert.strictEqual(decrypted.api_key, FIXTURE_API_KEY);

  // 编辑保留语义：掩码占位 = 保留密文；空值 = 删除；新值 = 替换
  store.connections.update(conn.id, { headers: { 'X-Auth-Token': '••••••••', 'X-New': 'SECOND_SECRET_5533' } });
  const afterUpdate = store.connections.getDecrypted(conn.id);
  assert.strictEqual(afterUpdate.headers['X-Auth-Token'], FIXTURE_HEADER_VALUE, 'mask placeholder keeps stored secret');
  assert.strictEqual(afterUpdate.headers['X-New'], 'SECOND_SECRET_5533');
  assert.strictEqual(afterUpdate.headers['X-Plain'], undefined, 'omitted header is removed');
  assert.strictEqual(leakScan(JSON.stringify(store.connections.get(conn.id)), [FIXTURE_HEADER_VALUE, 'SECOND_SECRET_5533']), null);

  console.log('CONNECTION_SECRET_MASK=PASS');
  console.log('CUSTOM_HEADER_SECRET_MASK=PASS');
  console.log('CONNECTION_SECRET_LEAK=0');
  console.log('CUSTOM_HEADER_SECRET_LEAK=0');
});

test('B15.1 status vocabulary is derived from real test truth only', () => {
  // 从未测试 → UNKNOWN（绝不因为「没报错」显示 READY/AVAILABLE）
  const untested = store.connections.create({ name: 'B15 Untested', provider: 'mock', base_url: 'mock://u' });
  assert.deepStrictEqual(
    { ...resolveConnectionStatus(store.connections.get(untested.id)) },
    { status: 'UNKNOWN', reason: 'NEVER_TESTED', latencyMs: null, lastTestedAt: null });

  // 测试成功 → AVAILABLE + 真实延迟
  store.connections.setTestResult(untested.id, { ok: true, error: '', latency: 42, kind: 'ok' });
  let st = resolveConnectionStatus(store.connections.get(untested.id));
  assert.strictEqual(st.status, 'AVAILABLE');
  assert.strictEqual(st.latencyMs, 42);

  // 真实高延迟 → DEGRADED（来自测量值，不是猜测）
  store.connections.setTestResult(untested.id, { ok: true, error: '', latency: 4500, kind: 'ok' });
  st = resolveConnectionStatus(store.connections.get(untested.id));
  assert.strictEqual(st.status, 'DEGRADED');
  assert.strictEqual(st.reason, 'HIGH_LATENCY');

  // provider 报告失败 → UNAVAILABLE
  store.connections.setTestResult(untested.id, { ok: false, error: 'connection refused', latency: null, kind: 'failed' });
  st = resolveConnectionStatus(store.connections.get(untested.id));
  assert.strictEqual(st.status, 'UNAVAILABLE');
  assert.ok(st.reason.includes('connection refused'));

  // 测试动作本身崩溃 → ERROR
  store.connections.setTestResult(untested.id, { ok: false, error: 'TEST_CRASHED', latency: null, kind: 'error' });
  st = resolveConnectionStatus(store.connections.get(untested.id));
  assert.strictEqual(st.status, 'ERROR');

  // 旧库回退：tested=1 无 test_state → AVAILABLE；有 last_error → UNAVAILABLE；皆无 → UNKNOWN
  assert.strictEqual(resolveConnectionStatus({ tested: 1, latency_ms: 10 }).status, 'AVAILABLE');
  assert.strictEqual(resolveConnectionStatus({ tested: 0, last_error: 'boom' }).status, 'UNAVAILABLE');
  assert.strictEqual(resolveConnectionStatus({ tested: 0 }).status, 'UNKNOWN');
  assert.strictEqual(resolveConnectionStatus(null).status, 'UNKNOWN');

  // Auth Mode 只描述存储形态
  assert.strictEqual(resolveAuthMode({ has_key: true, header_names: [] }), 'API_KEY');
  assert.strictEqual(resolveAuthMode({ has_key: false, header_names: ['X'] }), 'CUSTOM_HEADERS');
  assert.strictEqual(resolveAuthMode({ has_key: true, header_names: ['X'] }), 'API_KEY_HEADERS');
  assert.strictEqual(resolveAuthMode({ has_key: false, header_names: [] }), 'NO_AUTH');

  console.log('CONNECTION_STATUS_VOCABULARY=PASS');
  console.log('DIAGNOSTICS_FALSE_READY=0');
});

test('B15.5 failed test against unreachable endpoint records UNAVAILABLE truth (no network dependency)', async () => {
  // 127.0.0.1:9 环路拒绝 —— 真实 provider test contract，失败是确定性的
  const conn = store.connections.create({ name: 'B15 Refused', provider: 'custom', base_url: 'http://127.0.0.1:9/v1', api_key: 'fixture' });
  const decrypted = store.connections.getDecrypted(conn.id);
  const r = await providers.getProvider(decrypted).testConnection();
  assert.strictEqual(r.ok, false, 'loopback refused must fail');
  store.connections.setTestResult(conn.id, { ok: false, error: r.message, latency: r.latency, kind: 'failed' });
  const st = resolveConnectionStatus(store.connections.get(conn.id));
  assert.strictEqual(st.status, 'UNAVAILABLE');
  assert.ok(st.reason && st.reason.length > 0, 'failure reason preserved');
  console.log('CONNECTION_TEST_FAILED_TRUTH=UNAVAILABLE');
});
