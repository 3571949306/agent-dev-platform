'use strict';
/**
 * v2.9.0 Harness Safety Patch — R1 Explicit Connection Fail-Closed（对抗场景 A-D）。
 *
 * 背景：旧行为中传入无效 CLI Connection ID 会继续 fallback（settings → Store 唯一
 * DeepSeek → env），曾真实导致「无效 ID → 意外选中 Store DeepSeek → 真实付费调用」。
 * 本轮语义：EXPLICIT（CLI / REAL_AI_TEST_CONNECTION_ID）无效 → FAIL CLOSED，禁止 fallback；
 * 只有 AUTO（无显式 ID）才允许按优先级自动发现。
 *
 * Provider-call Proof（最重要）：B/C 场景中 Provider spy 必须保持
 * providerCallsStarted === 0 —— 只有「解析失败」还不够，必须证明没有真实
 * Provider 调用机会（runSmoke 在解析失败时根本不构造 provider）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const rt = require('../scripts/lib/real-ai-runtime');
const { runSmoke } = require('../scripts/real-ai-orchestrator-smoke');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r1-failclosed-'));
store.init(USER_DATA);

// Store 中一个可用 DeepSeek 连接（AUTO 发现的目标 / B-C 场景中「不得被选中」的对象）
const dsConn = store.connections.create({
  name: 'DS FailClosed', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-fc-store'
});

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Provider spy：任何真实 Provider 构造/调用都会被计数（B/C 中必须保持 0）。 */
function createProviderSpy() {
  const spy = { constructions: 0, streamCalls: 0 };
  const factory = (conn) => {
    spy.constructions += 1;
    return {
      async streamResponse() { spy.streamCalls += 1; return { content: '{}' }; },
      async testConnection() { return { ok: true }; }
    };
  };
  return { spy, factory };
}

test('R1-A explicit valid ID → 恰好使用该连接（cli-explicit，不选其他）', () => {
  const other = store.connections.create({
    name: 'DS Other', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-fc-other'
  });
  try {
    const r = rt.resolveRealAiConnection(other.id, { store });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'cli-explicit');
    assert.strictEqual(r.connectionId, other.id, '必须恰好是显式给定的连接');
    assert.strictEqual(r.conn.api_key, 'sk-fc-other');
    assert.notStrictEqual(r.connectionId, dsConn.id, '不得选到其他连接');
  } finally {
    store.connections.remove(other.id);
  }
});

test('R1-B explicit invalid ID + Store 存在唯一可用 DeepSeek → EXPLICIT_CONNECTION_NOT_FOUND，Store 连接不得被选中', () => {
  withEnv({ DEEPSEEK_API_KEY: undefined, REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
    const r = rt.resolveRealAiConnection('no-such-connection-id', { store });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'EXPLICIT_CONNECTION_NOT_FOUND');
    assert.ok(!r.conn, 'fail-closed：不得返回任何连接（尤其不得 fallback 到 Store DeepSeek）');
  });
});

test('R1-C explicit invalid ID + DEEPSEEK_API_KEY env exists → 仍然 FAIL，env 不得 fallback', () => {
  withEnv({ DEEPSEEK_API_KEY: 'sk-env-should-not-be-used', REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
    const r = rt.resolveRealAiConnection('no-such-connection-id', { store });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'EXPLICIT_CONNECTION_NOT_FOUND');
    assert.ok(!r.conn, 'fail-closed：env 不得兜底');
  });
});

test('R1-C2 explicit env-id（REAL_AI_TEST_CONNECTION_ID）无效 → 同样 fail-closed', () => {
  withEnv({ DEEPSEEK_API_KEY: 'sk-env-x', REAL_AI_TEST_CONNECTION_ID: 'also-missing-id' }, () => {
    const r = rt.resolveRealAiConnection(null, { store });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'EXPLICIT_CONNECTION_NOT_FOUND');
  });
});

test('R1-D no explicit ID + Store 唯一 DeepSeek → AUTO 自动发现允许', () => {
  // 临时移除其他 DS-like 连接，保证「唯一」
  const others = store.connections.list().filter(c => c.id !== dsConn.id && c.has_key && rt.isDeepSeekLikeConnection(c));
  for (const c of others) store.connections.remove(c.id);
  try {
    withEnv({ DEEPSEEK_API_KEY: 'sk-env-loses-to-store', REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
      const r = rt.resolveRealAiConnection(null, { store });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.source, 'store-single-deepseek');
      assert.strictEqual(r.connectionId, dsConn.id);
      assert.strictEqual(r.conn.api_key, 'sk-fc-store', 'AUTO 模式 Store 优先于 env');
    });
  } finally {
    for (const c of others) {
      store.connections.create({ name: c.name, provider: c.provider, base_url: c.base_url, api_key: 'sk-restored-placeholder' });
    }
  }
});

test('R1 Provider-call Proof（B）：runSmoke 无效 explicit ID → FAIL + providerCallsStarted=0 + Provider spy 零调用', async () => {
  const { spy, factory } = createProviderSpy();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r1-session-'));
  const result = await withEnv({ DEEPSEEK_API_KEY: 'sk-env-present', REAL_AI_TEST_CONNECTION_ID: undefined }, () =>
    runSmoke({
      connectionId: 'invalid-connection-id',
      store,
      sessionDir,
      providerFactory: factory,
      dryRun: false
    })
  );
  assert.strictEqual(result.status, 'FAIL');
  assert.strictEqual(result.reason, 'EXPLICIT_CONNECTION_NOT_FOUND');
  assert.strictEqual(result.exitCode, 1);
  assert.strictEqual(result.providerCallsStarted, 0);
  assert.strictEqual(spy.constructions, 0, 'Provider 从未被构造 —— 没有真实 Provider 调用机会');
  assert.strictEqual(spy.streamCalls, 0);
});

test('R1 Provider-call Proof（C）：无效 explicit ID + env key 存在 → 仍 0 provider call', async () => {
  const { spy, factory } = createProviderSpy();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r1-session-'));
  const result = await withEnv({ DEEPSEEK_API_KEY: 'sk-env-present-2', REAL_AI_TEST_CONNECTION_ID: 'missing-env-id' }, () =>
    runSmoke({ connectionId: null, store, sessionDir, providerFactory: factory, dryRun: false })
  );
  assert.strictEqual(result.status, 'FAIL');
  assert.strictEqual(result.reason, 'EXPLICIT_CONNECTION_NOT_FOUND');
  assert.strictEqual(spy.constructions, 0);
  assert.strictEqual(spy.streamCalls, 0);
  assert.strictEqual(result.providerCallsStarted, 0);
});

test('R1 Dry Run：有效连接 + --dry-run → 0 provider call，不消耗 paid attempt', async () => {
  const { spy, factory } = createProviderSpy();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-r1-session-'));
  const result = await withEnv({ DEEPSEEK_API_KEY: undefined, REAL_AI_TEST_CONNECTION_ID: undefined, REAL_AI_TEST_MODEL: 'dry-model' }, () =>
    runSmoke({ connectionId: null, store, sessionDir, providerFactory: factory, dryRun: true })
  );
  assert.strictEqual(result.status, 'DRY_RUN');
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.providerCallsStarted, 0);
  assert.strictEqual(spy.constructions, 0);
});
