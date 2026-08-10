'use strict';
/**
 * v2.8.0 — test/acpAuthBroker.test.js（spec §29/§30/§31/§32/§33/§79/§80）。
 *
 * 认证状态机的核心约束：
 *   - 只保存状态 + 方式，绝不保存 token / cookie / refresh token
 *   - initialize 握手带 authMethods → AUTH_REQUIRED；无 auth 面 → AUTHENTICATED
 *   - AUTHENTICATED / API_KEY 视为 authenticated；AUTH_REQUIRED 才 requiresLogin
 */
const test = require('node:test');
const assert = require('node:assert');

const { createExternalAgentAuthBroker, AUTH_STATE, AUTH_MODE } = require('../src/agents/protocols/acp/authBroker');

test('初始状态为 UNKNOWN，未认证、无需登录', () => {
  const broker = createExternalAgentAuthBroker();
  const st = broker.getState();
  assert.strictEqual(st.state, AUTH_STATE.UNKNOWN);
  assert.strictEqual(st.authenticated, false);
  assert.strictEqual(broker.isAuthenticated(), false);
  assert.strictEqual(broker.requiresLogin(), false);
});

test('initFromHandshake：有 authMethods → AUTH_REQUIRED（外部登录面）', () => {
  const broker = createExternalAgentAuthBroker();
  const st = broker.initFromHandshake(['oauth-chatgpt', 'api-key']);
  assert.strictEqual(st.state, AUTH_STATE.AUTH_REQUIRED);
  assert.strictEqual(st.method, 'oauth-chatgpt', '取第一个 method 作为展示');
  assert.strictEqual(st.mode, AUTH_MODE.EXTERNAL_LOGIN);
  assert.strictEqual(broker.requiresLogin(), true);
  assert.strictEqual(broker.isAuthenticated(), false);
  assert.strictEqual(st.detail, '需要登录（支持: oauth-chatgpt, api-key）');
});

test('initFromHandshake：无 authMethods → 视为无需登录（AUTHENTICATED / mode=none）', () => {
  const broker = createExternalAgentAuthBroker();
  const st = broker.initFromHandshake([]);
  assert.strictEqual(st.state, AUTH_STATE.AUTHENTICATED);
  assert.strictEqual(st.mode, AUTH_MODE.NONE);
  assert.strictEqual(broker.isAuthenticated(), true);

  const broker2 = createExternalAgentAuthBroker();
  assert.strictEqual(broker2.initFromHandshake(null).state, AUTH_STATE.AUTHENTICATED);
});

test('markRequired / markAuthenticated / markApiKey / markFailed 状态迁移', () => {
  const broker = createExternalAgentAuthBroker();

  broker.markRequired('chatgpt', AUTH_MODE.EXTERNAL_LOGIN);
  assert.strictEqual(broker.getState().state, AUTH_STATE.AUTH_REQUIRED);
  assert.strictEqual(broker.requiresLogin(), true);

  broker.markAuthenticated('chatgpt');
  let st = broker.getState();
  assert.strictEqual(st.state, AUTH_STATE.AUTHENTICATED);
  assert.strictEqual(st.mode, AUTH_MODE.EXTERNAL_LOGIN, '未显式给 mode 时回落 external_login');
  assert.strictEqual(broker.isAuthenticated(), true);
  assert.strictEqual(st.error, null, '认证成功后清空历史错误');

  broker.markApiKey();
  st = broker.getState();
  assert.strictEqual(st.state, AUTH_STATE.API_KEY);
  assert.strictEqual(st.mode, AUTH_MODE.API_KEY);
  assert.strictEqual(broker.isAuthenticated(), true, 'API_KEY 也算已认证');

  broker.markFailed('refresh 失败');
  st = broker.getState();
  assert.strictEqual(st.state, AUTH_STATE.FAILED);
  assert.strictEqual(st.error, 'refresh 失败');
  assert.strictEqual(broker.isAuthenticated(), false);
});

test('reset 回到干净的 UNKNOWN', () => {
  const broker = createExternalAgentAuthBroker();
  broker.markAuthenticated('chatgpt');
  const st = broker.reset();
  assert.strictEqual(st.state, AUTH_STATE.UNKNOWN);
  assert.strictEqual(st.method, null);
  assert.strictEqual(st.mode, AUTH_MODE.NONE);
  assert.strictEqual(st.detail, null);
  assert.strictEqual(st.error, null);
});

test('markFailed 后再 initFromHandshake 会清掉历史错误', () => {
  const broker = createExternalAgentAuthBroker();
  broker.markFailed('旧错误');
  const st = broker.initFromHandshake(['chatgpt']);
  assert.strictEqual(st.error, null);
  assert.strictEqual(st.state, AUTH_STATE.AUTH_REQUIRED);
});

test('状态机全程不持有任何凭据（序列化结果无 token/cookie/secret 值）', () => {
  const broker = createExternalAgentAuthBroker();
  broker.initFromHandshake(['oauth-chatgpt']);
  broker.markAuthenticated('oauth-chatgpt');
  broker.markApiKey();
  const dump = JSON.stringify(broker.getState());
  assert.ok(!/token|cookie|refresh|secret|bearer/i.test(dump), '状态序列化里不允许出现任何凭据词汇');
  // detail 只允许人类可读的状态说明
  assert.ok(typeof broker.getState().detail === 'string');
});
