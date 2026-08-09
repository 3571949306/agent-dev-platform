'use strict';
/**
 * v2.5.0 External Config Import — Codex Importer。
 *
 * §11/§12/§13：实际读取 ~/.codex/config.toml，识别 model_providers.* 的 name/base_url/wire_api/env_key/api_key。
 * §13：env_key 时只在用户主动执行导入时读取对应环境变量。
 * §14：Codex 使用 OpenAI 账号登录（auth_mode=chatgpt / OAuth token）时不得迁移，显示提示。
 *
 * 实测本机 Codex config.toml 结构：
 *   model = "gpt-xxx"
 *   model_provider = "cc-switch-official"
 *   [model_providers.cc-switch-official]
 *     name = "OpenAI"
 *     base_url = "http://127.0.0.1:15721/v1"
 *     wire_api = "responses"
 *     requires_openai_auth = true   ← 表示走账号登录，不可迁移
 *
 * auth.json 含 OAuth tokens（access_token/refresh_token/id_token）→ 不可迁移。
 */

const path = require('path');
const { parseToml } = require('../../parsers/toml');
const { createExternalSource } = require('../externalSource');
const { toCandidates } = require('../importNormalizer');
const { discoverKnownConfigs, readFileSyncSafe } = require('../security/pathPolicy');
const {
  isCodexAccountLogin,
  detectUnsupportedCredentials
} = require('../security/secretSanitizer');

const ID = 'codex';
const NAME = 'Codex';
const DESCRIPTION = '从 Codex CLI 配置导入 model_providers（仅迁移用户自配 API Key，不迁移账号登录态）';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  try {
    const configs = discoverKnownConfigs(ID);
    const configToml = configs.find(c => c.name === 'config.toml');
    const authJson = configs.find(c => c.name === 'auth.json');
    if (configToml) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = configToml.path;
      src.lastModified = configToml.lastModified;
      src.configType = 'toml';
    } else {
      src.exists = false;
      src.errors.push('未找到 ~/.codex/config.toml，请手动选择配置文件');
    }
    if (authJson) {
      src.exists = true;
      // auth.json 不直接读取，只在 parse 时检查是否含账号登录态
    }
  } catch (e) {
    src.errors.push(e.message || String(e));
  }
  return src;
}

function parse(opts = {}) {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  const candidates = [];
  const warnings = [];

  // §57/测试：用户手动选择文件优先于自动发现（fixture 与手动导入走此分支）
  if (opts.filePath) {
    const policy = { sourceType: ID, userSelected: true };
    const text = readFileSyncSafe(opts.filePath, policy);
    src.sourcePath = opts.filePath;
    src.exists = true;
    src.readable = true;
    src.configType = 'toml';
    const rawList = parseConfigText(text, opts.filePath, opts.env, warnings);
    candidates.push(...toCandidates(rawList, ID, opts.filePath));
    src.candidates = candidates;
    src.warnings = warnings;
    return { source: src, candidates, warnings };
  }

  // 自动发现 ~/.codex/config.toml
  const discovered = discover();
  Object.assign(src, discovered);

  if (src.sourcePath) {
    try {
      const policy = { sourceType: ID, userSelected: false };
      const text = readFileSyncSafe(src.sourcePath, policy);
      const rawList = parseConfigText(text, src.sourcePath, opts.env, warnings);
      candidates.push(...toCandidates(rawList, ID, src.sourcePath));
    } catch (e) {
      warnings.push({ type: 'parse_warning', message: `config.toml 读取失败：${e.message}` });
    }
  } else {
    src.errors.push('未找到 Codex 配置文件，需用户手动选择');
  }

  // §14：检查 auth.json 是否为 ChatGPT 账号登录态
  const configs = discoverKnownConfigs(ID);
  const authJsonPath = configs.find(c => c.name === 'auth.json');
  if (authJsonPath) {
    try {
      const authText = readFileSyncSafe(authJsonPath.path, { sourceType: ID, userSelected: false });
      const authObj = JSON.parse(authText);
      if (isCodexAccountLogin(authObj)) {
        warnings.push({
          type: 'unsupported_credential',
          message: '检测到 Codex 账号认证（ChatGPT 登录态/OAuth token）。此认证不是标准 API Key，不能导入 Agent Dev Platform。'
        });
      }
      const { hasUnsupported } = detectUnsupportedCredentials(authObj);
      if (hasUnsupported) {
        warnings.push({
          type: 'unsupported_credential',
          message: 'Codex auth.json 含 OAuth/Session/会员凭据，已跳过不导入。仅支持用户自配的第三方 API Key。'
        });
      }
    } catch (e) {
      warnings.push({ type: 'parse_warning', message: `auth.json 解析失败：${e.message}` });
    }
  }

  src.candidates = candidates;
  src.warnings = warnings;
  return { source: src, candidates, warnings };
}

/**
 * 解析 config.toml 文本为 candidate raw 列表。
 * §11/§12：识别 [model_providers.*] 中的 name/base_url/wire_api/env_key/api_key。
 */
function parseConfigText(text, sourcePath, env, warnings) {
  let obj;
  try { obj = parseToml(text); } catch (e) {
    warnings.push({ type: 'parse_warning', message: `config.toml 解析失败：${e.message}` });
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];

  const mp = obj.model_providers || obj.providers || {};
  if (!mp || typeof mp !== 'object') {
    warnings.push({ type: 'parse_warning', message: 'config.toml 未发现 [model_providers.*] 节' });
    return [];
  }

  const topModel = obj.model ? String(obj.model) : null;
  const topProvider = obj.model_provider ? String(obj.model_provider) : null;
  const candidates = [];

  for (const [key, provider] of Object.entries(mp)) {
    if (!provider || typeof provider !== 'object') continue;
    if (!provider.base_url && !provider.api_key) continue;

    const raw = {
      name: provider.name || key,
      baseUrl: provider.base_url || null,
      defaultModel: topModel && topProvider === key ? topModel : (provider.model || null),
      wireApi: provider.wire_api || null,
      providerHint: null,
      sourceType: ID,
      sourcePath,
      confidence: 0.92,
      rawLength: text.length
    };

    // §13：env_key 时尝试读取对应环境变量（仅用户主动执行导入时）
    if (provider.env_key && !provider.api_key) {
      const envValue = env ? env[provider.env_key] : null;
      if (envValue) {
        raw.apiKey = envValue;
        raw.headers = { env_key: provider.env_key };
      } else {
        raw.apiKey = null;
        raw.headers = { env_key: provider.env_key };
        raw._missingSecret = `环境变量 ${provider.env_key} 未设置`;
      }
    } else if (provider.api_key) {
      raw.apiKey = String(provider.api_key);
    }

    // §14：requires_openai_auth=true 表示该 provider 走 Codex 账号登录，不可迁移
    if (provider.requires_openai_auth === true) {
      warnings.push({
        type: 'unsupported_credential',
        message: `provider "${key}" 标记 requires_openai_auth=true，走 Codex 账号登录态，已跳过。请改为自配 api_key / env_key 后再导入。`
      });
      continue;
    }

    candidates.push(raw);
  }

  return candidates;
}

module.exports = {
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  requiresFile: false,
  discover,
  parse
};
