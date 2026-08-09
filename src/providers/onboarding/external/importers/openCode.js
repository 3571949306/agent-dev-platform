'use strict';
/**
 * v2.5.0 External Config Import — OpenCode Importer。
 *
 * §19/§20/§21：读取 OpenCode 公开配置（opencode.json），识别 provider/model/baseURL/apiKey/headers。
 * §20：一个 OpenCode 配置含多个 Provider，必须一个 Provider → 一个 ImportCandidate，支持 Batch。
 * §21：${ENV_VAR} 引用只在用户明确执行导入时才尝试读取环境变量；不存在则 Credential Missing。
 *
 * OpenCode 公开 schema（参考公开文档）：
 *   {
 *     "provider": "openai|anthropic|openrouter|deepseek|...",
 *     "model": "xxx",
 *     "baseURL": "https://...",
 *     "apiKey": "sk-... 或 ${ENV_VAR}",
 *     "headers": { ... }
 *   }
 *   或数组形态批量：[{...}, {...}]
 */

const { createExternalSource } = require('../externalSource');
const { discoverKnownConfigs, readFileSyncSafe } = require('../security/pathPolicy');
const {
  detectUnsupportedCredentials,
  isSupportedApiKey
} = require('../security/secretSanitizer');

const ID = 'opencode';
const NAME = 'OpenCode';
const DESCRIPTION = '从 OpenCode 配置导入 Provider（支持批量，识别 ${ENV_VAR} 引用）';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  try {
    const configs = discoverKnownConfigs(ID);
    const jsonFile = configs.find(c => /^opencode.*\.json$/i.test(c.name));
    if (jsonFile) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = jsonFile.path;
      src.lastModified = jsonFile.lastModified;
      src.configType = 'json';
    } else {
      src.exists = false;
      src.errors.push('未找到 OpenCode 配置文件，请手动选择 opencode.json');
    }
  } catch (e) {
    src.errors.push(e.message || String(e));
  }
  return src;
}

function parse(opts = {}) {
  const src = discover();
  const candidates = [];
  const warnings = [];

  let filePath = src.sourcePath || opts.filePath;
  if (!filePath) {
    src.errors.push('未找到 OpenCode 配置文件');
    return { source: src, candidates, warnings };
  }

  const policy = { sourceType: ID, userSelected: !src.sourcePath || !!opts.userSelected };
  let text;
  try {
    text = readFileSyncSafe(filePath, policy);
  } catch (e) {
    src.errors.push(`读取失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  let obj;
  try { obj = JSON.parse(text); }
  catch (e) {
    src.errors.push(`JSON 解析失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  // §20：统一转为数组处理
  const providers = Array.isArray(obj) ? obj : [obj];
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const raw = extractProvider(p, opts.env, warnings);
    if (raw) {
      raw.sourcePath = filePath;
      raw.sourceType = ID;
      raw.confidence = 0.88;
      raw.rawLength = text.length;
      candidates.push(raw);
    }
  }

  src.candidates = candidates;
  src.warnings = warnings;
  return { source: src, candidates, warnings };
}

/** 从单个 provider 对象提取 candidate raw。 */
function extractProvider(p, env, warnings) {
  if (!p.baseURL && !p.baseUrl && !p.base_url) {
    // 无 baseURL 视为 INVALID，跳过
    return null;
  }

  // §21：解析 ${ENV_VAR} 引用
  const apiKey = resolveEnvRef(p.apiKey || p.api_key, env);
  const baseURL = p.baseURL || p.baseUrl || p.base_url;
  const model = p.model || p.defaultModel;
  const provider = p.provider || p.providerHint;

  // 推测 protocolHint
  let protocolHint = null;
  if (provider) {
    const lc = String(provider).toLowerCase();
    if (lc === 'anthropic' || lc === 'claude') protocolHint = 'anthropic';
    else if (lc === 'openai') protocolHint = 'openai';
    else if (lc === 'openai-responses' || lc === 'responses') protocolHint = 'openai-responses';
    else if (lc === 'ollama') protocolHint = 'ollama';
    else protocolHint = 'openai';  // 默认 OpenAI 兼容
  }

  // headers 处理（过滤 secret header）
  const headers = {};
  if (p.headers && typeof p.headers === 'object') {
    for (const [k, v] of Object.entries(p.headers)) {
      if (isSupportedApiKey(k)) continue;  // secret 不进 headers
      headers[k] = resolveEnvRef(v, env);
    }
  }

  // 检查不可迁移凭据
  const { hasUnsupported, detectedFields } = detectUnsupportedCredentials(p);
  if (hasUnsupported) {
    warnings.push({
      type: 'unsupported_credential',
      message: `provider "${p.name || ''}" 含不可迁移凭据字段：${detectedFields.join(', ')}，已跳过这些字段`
    });
  }

  const raw = {
    name: p.name || null,
    baseUrl: baseURL,
    apiKey: apiKey || null,
    defaultModel: model || null,
    protocolHint,
    providerHint: provider || null,
    headers,
    notes: p.description || null
  };

  if (!apiKey && baseURL) {
    raw._missingSecret = 'OpenCode 配置中未发现 apiKey 或对应环境变量未设置';
  }

  return raw;
}

/** §21：解析 ${ENV_VAR} 引用，env 不存在时返回 null（让 conflictResolver 标记 MISSING_SECRET）。 */
function resolveEnvRef(value, env) {
  if (!value) return null;
  if (typeof value !== 'string') return String(value);
  const m = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (m) {
    const envName = m[1];
    if (env && env[envName]) return env[envName];
    return null;  // §21：env 不存在 → Credential Missing
  }
  // 也支持 $ENV_VAR 形式
  const m2 = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m2) {
    const envName = m2[1];
    if (env && env[envName]) return env[envName];
    return null;
  }
  return value;
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
