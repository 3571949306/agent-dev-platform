'use strict';
/**
 * v2.8.0 — 外部 Agent 认证状态机（spec §29/§30/§31/§32/§33/§79/§80）。
 *
 * ExternalAgentAuthBroker 统一记录认证状态。注意：
 *   - 只保存"状态 + 方式（method/mode）"，绝不保存 token / cookie / refresh token。
 *   - 登录动作由官方 CLI / SDK / ACP auth flow 完成；平台不提取、不复制凭据。
 *   - GUI 只能展示状态，禁止展示完整 Token / Cookie / Refresh Token。
 */

const AUTH_STATE = {
  UNKNOWN: 'UNKNOWN',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTHENTICATED: 'AUTHENTICATED',
  API_KEY: 'API_KEY',
  EXTERNAL_LOGIN: 'EXTERNAL_LOGIN',
  FAILED: 'FAILED'
};

const AUTH_MODE = {
  API_KEY: 'api_key',
  EXTERNAL_LOGIN: 'external_login',
  NONE: 'none'
};

/**
 * 创建认证状态机。
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 */
function createExternalAgentAuthBroker(opts = {}) {
  let state = AUTH_STATE.UNKNOWN;
  let method = null;     // 例如 'chatgpt' / 'claude' / 'api_key'
  let mode = AUTH_MODE.NONE;
  let detail = null;     // 人类可读说明（非凭据）
  let error = null;

  /** 根据 initialize 返回的 authMethods 初始化状态。 */
  function initFromHandshake(authMethods) {
    if (Array.isArray(authMethods) && authMethods.length > 0) {
      state = AUTH_STATE.AUTH_REQUIRED;
      method = authMethods[0];
      mode = AUTH_MODE.EXTERNAL_LOGIN;
      detail = `需要登录（支持: ${authMethods.join(', ')}）`;
    } else {
      // 无 auth 面 → 视为无需登录
      state = AUTH_STATE.AUTHENTICATED;
      mode = AUTH_MODE.NONE;
      detail = '该 Agent 不需要认证';
    }
    error = null;
    return getState();
  }

  function markRequired(m, md) {
    state = AUTH_STATE.AUTH_REQUIRED;
    if (m) method = m;
    if (md) mode = md;
    detail = '需要用户登录';
    return getState();
  }

  function markAuthenticated(m, md) {
    state = AUTH_STATE.AUTHENTICATED;
    if (m) method = m;
    if (md) mode = md || AUTH_MODE.EXTERNAL_LOGIN;
    detail = '已认证';
    error = null;
    return getState();
  }

  function markApiKey() {
    state = AUTH_STATE.API_KEY;
    mode = AUTH_MODE.API_KEY;
    detail = '使用 API Key';
    error = null;
    return getState();
  }

  function markFailed(reason) {
    state = AUTH_STATE.FAILED;
    error = reason || '认证失败';
    detail = error;
    return getState();
  }

  function reset() {
    state = AUTH_STATE.UNKNOWN;
    method = null;
    mode = AUTH_MODE.NONE;
    detail = null;
    error = null;
    return getState();
  }

  function getState() {
    return { state, method, mode, detail, error, authenticated: state === AUTH_STATE.AUTHENTICATED || state === AUTH_STATE.API_KEY };
  }

  function isAuthenticated() {
    return state === AUTH_STATE.AUTHENTICATED || state === AUTH_STATE.API_KEY;
  }

  function requiresLogin() {
    return state === AUTH_STATE.AUTH_REQUIRED;
  }

  return {
    AUTH_STATE,
    AUTH_MODE,
    initFromHandshake,
    markRequired,
    markAuthenticated,
    markApiKey,
    markFailed,
    reset,
    getState,
    isAuthenticated,
    requiresLogin
  };
}

module.exports = { createExternalAgentAuthBroker, AUTH_STATE, AUTH_MODE };
