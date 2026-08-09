'use strict';
/**
 * v2.5.0 External Config Import — Claude Code Importer。
 *
 * §15/§16：识别 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。
 * §17：第三方兼容网关不强制定 provider=Anthropic Official，交给 Probe 验证。
 * §18：claude.ai login / Claude Pro/Max session token 不迁移。
 *
 * 配置来源：
 *   1. ~/.claude/settings.json（公开配置，非凭据）
 *   2. ~/.claude/.env（可选，含 ANTHROPIC_* 环境变量）
 *   3. ~/.claude/credentials.json（claude.ai 登录态，不可迁移）
 *   4. 系统环境变量 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
 */

const { createExternalSource } = require('../externalSource');
const { toCandidates } = require('../importNormalizer');
const { discoverKnownConfigs, readFileSyncSafe } = require('../security/pathPolicy');
const {
  isClaudeSessionLogin,
  detectUnsupportedCredentials,
  isSupportedApiKey
} = require('../security/secretSanitizer');

const ID = 'claude-code';
const NAME = 'Claude Code';
const DESCRIPTION = '从 Claude Code 配置或环境变量导入 ANTHROPIC API 凭据（不迁移 claude.ai 登录态）';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  try {
    const configs = discoverKnownConfigs(ID);
    const envFile = configs.find(c => c.name === '.env');
    const settingsFile = configs.find(c => c.name === 'settings.json');
    const credFile = configs.find(c => c.name === 'credentials.json');

    // 优先级：.env > credentials.json > 环境变量
    if (envFile) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = envFile.path;
      src.lastModified = envFile.lastModified;
      src.configType = 'env';
    } else if (credFile) {
      // §18：credentials.json 存在时无论是否 session 登录态都标记 exists，
      // parse() 会读取并检测：session 登录态 → unsupported_credential 警告 + 0 candidate
      src.exists = true;
      src.readable = true;
      src.sourcePath = credFile.path;
      src.lastModified = credFile.lastModified;
      src.configType = 'json';
    } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = 'env:ANTHROPIC_*';
      src.configType = 'env';
    } else if (settingsFile) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = settingsFile.path;
      src.lastModified = settingsFile.lastModified;
      src.configType = 'json';
      src.warnings.push({
        type: 'info',
        message: 'Claude Code 已安装，但未发现 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 配置'
      });
    } else {
      src.exists = false;
      src.errors.push('未找到 Claude Code 凭据配置');
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

  // §57/测试：用户手动选择文件优先于自动发现
  if (opts.filePath) {
    const policy = { sourceType: ID, userSelected: true };
    const text = readFileSyncSafe(opts.filePath, policy);
    src.sourcePath = opts.filePath;
    src.exists = true;
    src.readable = true;
    if (/\.env$/i.test(opts.filePath)) {
      src.configType = 'env';
      const envVars = parseEnvFile(text);
      const raw = extractFromEnv(envVars);
      if (raw) {
        raw.sourcePath = opts.filePath;
        raw.sourceType = ID;
        raw.confidence = 0.9;
        raw.rawLength = text.length;
        candidates.push(raw);
      }
    } else {
      // JSON credentials（§18：session 登录态拒绝并提示）
      src.configType = 'json';
      try {
        const obj = JSON.parse(text);
        if (isClaudeSessionLogin(obj)) {
          warnings.push({
            type: 'unsupported_credential',
            message: '检测到 Claude Code 登录态（claude.ai login / Pro / Max session）。仅支持 API credential，不迁移账号登录态。'
          });
        } else {
          const raw = extractFromClaudeCredentials(obj);
          if (raw) {
            raw.sourcePath = opts.filePath;
            raw.sourceType = ID;
            raw.confidence = 0.85;
            raw.rawLength = text.length;
            candidates.push(raw);
          }
        }
      } catch (e) {
        warnings.push({ type: 'parse_warning', message: `JSON 解析失败：${e.message}` });
      }
    }
    src.candidates = candidates;
    src.warnings = warnings;
    return { source: src, candidates, warnings };
  }

  // 自动发现
  const discovered = discover();
  Object.assign(src, discovered);
  // 合并 discover 阶段的 warnings（如 settings.json info 提示）
  const discoveredWarnings = (discovered.warnings || []).slice();

  // §15/§16：优先从 .env 文件读取
  if (src.configType === 'env' && src.sourcePath && src.sourcePath !== 'env:ANTHROPIC_*') {
    try {
      const policy = { sourceType: ID, userSelected: false };
      const text = readFileSyncSafe(src.sourcePath, policy);
      const envVars = parseEnvFile(text);
      const raw = extractFromEnv(envVars);
      if (raw) {
        raw.sourcePath = src.sourcePath;
        raw.sourceType = ID;
        raw.confidence = 0.92;
        raw.rawLength = text.length;
        candidates.push(raw);
      }
    } catch (e) {
      warnings.push({ type: 'parse_warning', message: `.env 解析失败：${e.message}` });
    }
  } else if (src.configType === 'json' && src.sourcePath) {
    // credentials.json
    try {
      const policy = { sourceType: ID, userSelected: false };
      const text = readFileSyncSafe(src.sourcePath, policy);
      const obj = JSON.parse(text);
      if (isClaudeSessionLogin(obj)) {
        warnings.push({
          type: 'unsupported_credential',
          message: '检测到 Claude Code 登录态（claude.ai login / Pro / Max session）。仅支持 API credential，不迁移账号登录态。'
        });
      } else {
        const raw = extractFromClaudeCredentials(obj);
        if (raw) {
          raw.sourcePath = src.sourcePath;
          raw.sourceType = ID;
          raw.confidence = 0.85;
          raw.rawLength = text.length;
          candidates.push(raw);
        }
      }
    } catch (e) {
      warnings.push({ type: 'parse_warning', message: `credentials.json 解析失败：${e.message}` });
    }
  }

  // 系统环境变量兜底（§15/§16）
  if (!candidates.length) {
    const env = process.env;
    const raw = extractFromEnv({
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL
    });
    if (raw) {
      raw.sourcePath = 'env:ANTHROPIC_*';
      raw.sourceType = ID;
      raw.confidence = 0.88;
      candidates.push(raw);
    }
  }

  // §18：最终检查 candidate 是否含不可迁移凭据
  for (const c of candidates) {
    if (c.headers) {
      const unsupported = Object.keys(c.headers).filter(k => !isSupportedApiKey(k));
      if (unsupported.length) {
        warnings.push({
          type: 'unsupported_credential',
          message: `已跳过字段：${unsupported.join(', ')}（非 API credential）`
        });
        for (const k of unsupported) delete c.headers[k];
      }
    }
  }

  src.candidates = candidates;
  src.warnings = [...discoveredWarnings, ...warnings];
  return { source: src, candidates, warnings: src.warnings };
}

/** 解析 .env 文件内容为 key=value 对象。 */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // 剥引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** 从 ANTHROPIC_* 环境变量映射提取 candidate raw。 */
function extractFromEnv(env) {
  const apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    protocolHint: 'anthropic',
    providerHint: 'anthropic',
    name: null
  };
}

/** 从 credentials.json 提取 candidate raw（仅 API credential）。 */
function extractFromClaudeCredentials(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const apiKey = obj.ANTHROPIC_API_KEY || obj.anthropicApiKey || obj.api_key;
  if (!apiKey) return null;
  return {
    apiKey: String(apiKey),
    baseUrl: obj.ANTHROPIC_BASE_URL || obj.baseURL || 'https://api.anthropic.com',
    protocolHint: 'anthropic',
    providerHint: 'anthropic',
    name: null
  };
}

/** 检查 credentials.json 是否为 session 登录态文件（含 oauthToken 等字段）。 */
function isSessionCredentialFile(filePath) {
  try {
    const text = readFileSyncSafe(filePath, { sourceType: ID, userSelected: false });
    const obj = JSON.parse(text);
    return isClaudeSessionLogin(obj);
  } catch {
    return false;
  }
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
