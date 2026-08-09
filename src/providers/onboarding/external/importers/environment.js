'use strict';
/**
 * v2.5.0 External Config Import — Environment Importer。
 *
 * §26/§27/§28：从 process.env 导入，用户主动点击才扫描。
 * §28：不扫描所有 SECRET，只查已知白名单字段。
 */

const { createExternalSource } = require('../externalSource');

const ID = 'environment';
const NAME = '环境变量';
const DESCRIPTION = '从系统环境变量导入已知 API Key（仅白名单字段）';

/**
 * §27/§28：已知 Provider ENV KEY 白名单。
 * 按 provider 分组，每组内 baseUrl/key 互相对应。
 */
const KNOWN_PROVIDER_ENV_KEYS = [
  // OpenAI
  { provider: 'openai', apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', protocolHint: 'openai' },
  // Anthropic
  { provider: 'anthropic', apiKey: 'ANTHROPIC_API_KEY', altKey: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL', protocolHint: 'anthropic' },
  // DeepSeek
  { provider: 'deepseek', apiKey: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL', protocolHint: 'openai' },
  // OpenRouter
  { provider: 'openrouter', apiKey: 'OPENROUTER_API_KEY', baseUrl: null, protocolHint: 'openai' },
  // Gemini
  { provider: 'gemini', apiKey: 'GEMINI_API_KEY', baseUrl: null, protocolHint: 'custom' },
  // GLM / Zhipu
  { provider: 'glm', apiKey: 'GLM_API_KEY', altKey: 'ZHIPU_API_KEY', baseUrl: 'GLM_BASE_URL', protocolHint: 'openai' },
  // Moonshot
  { provider: 'moonshot', apiKey: 'MOONSHOT_API_KEY', baseUrl: null, protocolHint: 'openai' },
  // Qwen / DashScope
  { provider: 'qwen', apiKey: 'QWEN_API_KEY', altKey: 'DASHSCOPE_API_KEY', baseUrl: null, protocolHint: 'openai' },
  // 通用 API_KEY / API_BASE
  { provider: 'custom', apiKey: 'API_KEY', altKey: 'TOKEN', baseUrl: 'API_BASE_URL', altBaseUrl: 'BASE_URL', protocolHint: 'openai' }
];

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  src.sourcePath = 'process.env';
  src.configType = 'env';
  try {
    const found = scan(process.env);
    if (found.length) {
      src.exists = true;
      src.readable = true;
      src.candidates = found.map(f => ({
        name: f.name,
        baseUrl: f.baseUrl,
        apiKey: f.apiKey ? '<detected>' : null,  // 不在 discover 阶段暴露明文
        protocolHint: f.protocolHint,
        providerHint: f.provider,
        sourceType: ID,
        sourcePath: `env:${f.keyName}`,
        confidence: 0.85
      }));
    } else {
      src.exists = false;
      src.errors.push('未在环境变量中检测到已知 API Key');
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

  // §26：用户主动点击才扫描 process.env
  const env = opts.env || process.env;
  const found = scan(env);

  for (const f of found) {
    if (!f.apiKey) continue;
    const raw = {
      name: f.name,
      baseUrl: f.baseUrl,
      apiKey: f.apiKey,
      protocolHint: f.protocolHint,
      providerHint: f.provider,
      sourceType: ID,
      sourcePath: `env:${f.keyName}`,
      confidence: 0.85
    };
    candidates.push(raw);
  }

  src.candidates = candidates;
  src.warnings = warnings;
  return { source: src, candidates, warnings };
}

/** 扫描环境变量白名单（不输出未命中字段，§28）。 */
function scan(env) {
  const results = [];
  for (const spec of KNOWN_PROVIDER_ENV_KEYS) {
    const apiKey = env[spec.apiKey] || (spec.altKey ? env[spec.altKey] : null);
    if (!apiKey) continue;
    const baseUrl = env[spec.baseUrl || ''] || (spec.altBaseUrl ? env[spec.altBaseUrl] : null) || null;
    results.push({
      name: prettifyName(spec.provider, baseUrl),
      provider: spec.provider,
      protocolHint: spec.protocolHint,
      apiKey,
      keyName: spec.apiKey,
      baseUrl
    });
  }
  return results;
}

function prettifyName(provider, baseUrl) {
  if (baseUrl) {
    try { return new URL(baseUrl).hostname; } catch { /* fallthrough */ }
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

module.exports = {
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  requiresFile: false,
  discover,
  parse,
  KNOWN_PROVIDER_ENV_KEYS  // 导出供测试
};
