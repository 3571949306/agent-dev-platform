'use strict';
/**
 * v2.5.0 External Config Import — Secret Sanitizer / Credential Classifier。
 *
 * §7/§8：只允许迁移「用户明确选择的 API Provider Credential」。
 * §8：绝对禁止窃取会员凭据（ChatGPT Plus / Codex membership / Claude Pro/Max / WorkBuddy / OpenCode hosted）。
 * §9：不读取外部软件内部网络流量、不抓包、不解密内部 Token。
 *
 * 不可迁移凭据类型：
 *   - oauth_access_token / oauth_refresh_token
 *   - session_token / session_credential
 *   - claude.ai login / Claude Pro/Max token
 *   - ChatGPT subscription / Codex membership token
 *   - id_token（OAuth JWT，含会员信息）
 *   - 任何含 plan_type / subscription_active_until 的 JWT
 *   - GitHub Token / 浏览器 Cookie / 系统登录凭据
 *   - WorkBuddy 会员 Token
 *
 * 可迁移凭据：
 *   - OPENAI_API_KEY（用户自配第三方 key，非账号登录态）
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（用户自配 API credential）
 *   - DEEPSEEK_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY 等第三方 API Key
 *   - 各 model_providers 中的 api_key / env_key 字段（用户自配 provider）
 */

/** 已知「不可迁移凭据」字段名（大小写不敏感）。 */
const UNSUPPORTED_CREDENTIAL_FIELDS = new Set([
  // OAuth / token 系列
  'oauth_access_token', 'oauthaccesstoken', 'oauth_token',
  'oauth_refresh_token', 'oauthrefreshtoken', 'refresh_token', 'refreshtoken',
  'id_token', 'idtoken',
  // Session 系列
  'session_token', 'sessiontoken', 'session_credential', 'sessioncredential',
  'session_key', 'sessionkey',
  // Claude.ai 登录态
  'claude_session', 'claude_session_token', 'claudesessiontoken',
  'claude_login_token', 'claudelogintoken',
  // Codex / ChatGPT 会员
  'chatgpt_token', 'chatgpt_access_token',
  'codex_membership_token', 'codex_token',
  'openai_account_token', 'openai_login_token',
  // 其他系统凭据
  'github_token', 'githubtoken', 'gh_token',
  'cookie', 'cookies',
  'workbuddy_token', 'workbuddy_membership',
  'opencode_hosted_token', 'opencode_membership'
]);

/** 已知「可迁移 API Key」字段名（大小写不敏感，含环境变量名）。 */
const SUPPORTED_API_KEY_FIELDS = new Set([
  'api_key', 'apikey', 'api-key',
  'openai_api_key', 'openaiapikey',
  'anthropic_api_key', 'anthropicapikey',
  'anthropic_auth_token', 'anthropicauthtoken',
  'deepseek_api_key', 'deepseekapikey',
  'openrouter_api_key', 'openrouterapikey',
  'gemini_api_key', 'geminiapikey',
  'glm_api_key', 'glmapikey',
  'moonshot_api_key', 'moonshotapikey',
  'qwen_api_key', 'qwenapikey',
  'zhipu_api_key', 'zhipuapikey',
  'x-api-key', 'x_api_key', 'xapikey',
  'authorization'  // Bearer sk-... 形式的 API Key，会剥前缀
]);

/**
 * 判断字段名是否为「不可迁移凭据」。
 * §8/§14/§18：检测到此类字段时返回 true，调用方应标记为 Unsupported Secret。
 */
function isUnsupportedCredential(fieldName) {
  if (!fieldName) return false;
  const lc = String(fieldName).toLowerCase();
  if (UNSUPPORTED_CREDENTIAL_FIELDS.has(lc)) return true;
  // 启发式匹配
  return /(oauth|refresh_token|session_token|id_token|membership|subscription|claude_login|chatgpt_login|account_token)/i.test(fieldName);
}

/** 判断字段名是否为「可迁移 API Key」（用户自配第三方 credential）。 */
function isSupportedApiKey(fieldName) {
  if (!fieldName) return false;
  const lc = String(fieldName).toLowerCase();
  if (SUPPORTED_API_KEY_FIELDS.has(lc)) return true;
  return /(api[_-]?key|auth[_-]?token|^token$)/i.test(fieldName) && !isUnsupportedCredential(fieldName);
}

/**
 * 分类一个字段：返回 'supported' / 'unsupported' / 'neutral'。
 * supported：可迁移的第三方 API Key
 * unsupported：不可迁移的 OAuth/Session/会员凭据
 * neutral：非凭据字段（如 base_url / model / headers）
 */
function classifyField(fieldName) {
  if (isUnsupportedCredential(fieldName)) return 'unsupported';
  if (isSupportedApiKey(fieldName)) return 'supported';
  return 'neutral';
}

/**
 * §14/§18/§23：检查一个 auth/credentials 对象是否包含不可迁移凭据。
 * 返回 { hasUnsupported: boolean, detectedFields: string[], reason: string }。
 *
 * @param {object} obj 配置对象（如 Codex auth.json、Claude credentials.json）
 * @returns {object} 不含 value，只列字段名
 */
function detectUnsupportedCredentials(obj) {
  const detected = [];
  if (!obj || typeof obj !== 'object') {
    return { hasUnsupported: false, detectedFields: [], reason: '' };
  }
  const stack = [{ prefix: '', val: obj }];
  while (stack.length) {
    const { prefix, val } = stack.pop();
    if (Array.isArray(val)) continue;
    if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        const name = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') {
          stack.push({ prefix: name, val: v });
        } else if (v !== null && v !== '' && isUnsupportedCredential(k)) {
          detected.push(name);
        }
      }
    }
  }
  const hasUnsupported = detected.length > 0;
  const reason = hasUnsupported
    ? `检测到不可迁移的凭据字段：${detected.join(', ')}。仅支持用户自配的第三方 API Key，不迁移账号登录/OAuth/会员凭据。`
    : '';
  return { hasUnsupported, detectedFields: detected, reason };
}

/**
 * §14/§18：检查 Codex auth.json 风格对象是否为「ChatGPT 账号登录态」。
 * 不可迁移条件之一：auth_mode === 'chatgpt' 或 tokens.access_token / tokens.refresh_token / tokens.id_token 存在。
 */
function isCodexAccountLogin(authObj) {
  if (!authObj || typeof authObj !== 'object') return false;
  if (authObj.auth_mode === 'chatgpt') return true;
  if (authObj.tokens && typeof authObj.tokens === 'object') {
    const t = authObj.tokens;
    if (t.access_token || t.refresh_token || t.id_token) return true;
  }
  return false;
}

/**
 * §18：检查 Claude Code 凭据对象是否为「claude.ai 登录态 / Pro/Max session」。
 */
function isClaudeSessionLogin(credObj) {
  if (!credObj || typeof credObj !== 'object') return false;
  // 常见 session 字段
  if (credObj.claude_session || credObj.sessionToken || credObj.session_token) return true;
  if (credObj.claudeAccount && typeof credObj.claudeAccount === 'object') return true;
  if (credObj.oauthToken && !credObj.apiKey) return true;
  return false;
}

/**
 * 检测 JWT 是否含会员信息（plan_type / subscription_active_until）。
 * 不解密 token 内容，只看明文 payload 部分。
 */
function jwtLooksLikeMembership(jwt) {
  if (!jwt || typeof jwt !== 'string') return false;
  const parts = jwt.split('.');
  if (parts.length < 2) return false;
  try {
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    if (!payload) return false;
    return /chatgpt_plan_type|subscription_active_until|subscription_plan|plan_type/i.test(payload);
  } catch {
    return false;
  }
}

module.exports = {
  UNSUPPORTED_CREDENTIAL_FIELDS,
  SUPPORTED_API_KEY_FIELDS,
  isUnsupportedCredential,
  isSupportedApiKey,
  classifyField,
  detectUnsupportedCredentials,
  isCodexAccountLogin,
  isClaudeSessionLogin,
  jwtLooksLikeMembership
};
