'use strict';
/**
 * v2.4.0 Smart API Onboarding — Provider Preset Registry。
 *
 * §20/§21/§22：Preset 只是帮助用户快速配置，不是新的运行时协议。
 * 仍然复用现有 providers/index.js 的 conn.provider 取值（openai/openai-responses/anthropic/ollama/local/custom）。
 *
 * 不为了增加 logo 列表硬编码几十个不验证的供应商（§20）。
 * 不做 Remote Marketplace（§58），只做本地 preset。
 *
 * Preset 数据结构（§21）：
 *   { id, name, protocol, defaultBaseUrl, supportsModelDiscovery, credentialFields, aliases, websiteUrl }
 *
 * CC Switch 借鉴：apiFormat 显式声明 + settingsConfig 模板（不照搬其 8 份 preset 文件）。
 */

const PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsModelDiscovery: true,
    credentialFields: ['apiKey'],
    aliases: ['openai', 'openai-official'],
    websiteUrl: 'https://platform.openai.com'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    supportsModelDiscovery: false, // Anthropic /v1/models 早期不公开，保守 false；probe 仍可尝试
    credentialFields: ['apiKey'],
    aliases: ['anthropic', 'claude'],
    websiteUrl: 'https://www.anthropic.com'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsModelDiscovery: true,
    credentialFields: ['apiKey'],
    aliases: ['openrouter'],
    websiteUrl: 'https://openrouter.ai'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    supportsModelDiscovery: true,
    credentialFields: ['apiKey'],
    aliases: ['deepseek'],
    websiteUrl: 'https://platform.deepseek.com'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    supportsModelDiscovery: true,
    credentialFields: [], // 本地无需 key
    aliases: ['ollama'],
    websiteUrl: 'https://ollama.com'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    protocol: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    supportsModelDiscovery: true,
    credentialFields: [], // 本地默认无 key
    aliases: ['lmstudio', 'lm-studio', 'lm studio'],
    websiteUrl: 'https://lmstudio.ai'
  },
  {
    id: 'custom',
    name: '自定义 API',
    protocol: 'custom',
    defaultBaseUrl: null,
    supportsModelDiscovery: true, // 尝试探测
    credentialFields: ['apiKey'],
    aliases: ['custom', '其他', 'other'],
    websiteUrl: null
  }
];

const PRESET_BY_ID = new Map(PRESETS.map(p => [p.id, p]));

/** 根据 alias / hostname / name 推测 preset。 */
function detectPreset({ alias, hostname, name } = {}) {
  // 1) alias 精确匹配
  if (alias) {
    const lc = String(alias).toLowerCase().trim();
    for (const p of PRESETS) {
      if (p.aliases.includes(lc) || p.id === lc) return p;
    }
  }
  // 2) hostname 子串匹配（api.deepseek.com → deepseek）
  if (hostname) {
    const h = String(hostname).toLowerCase();
    for (const p of PRESETS) {
      if (p.id === 'custom') continue;
      if (h.includes(p.id)) return p;
    }
    // claude / anthropic 特殊处理
    if (h.includes('claude') || h.includes('anthropic')) return PRESET_BY_ID.get('anthropic');
  }
  // 3) name 子串匹配
  if (name) {
    const n = String(name).toLowerCase();
    for (const p of PRESETS) {
      if (p.id === 'custom') continue;
      if (n.includes(p.id)) return p;
    }
    if (n.includes('claude') || n.includes('anthropic')) return PRESET_BY_ID.get('anthropic');
  }
  return PRESET_BY_ID.get('custom');
}

/** 列表（GUI「常用服务」按钮用）。 */
function listPresets() {
  return PRESETS.map(p => ({ ...p }));
}

function getPreset(id) {
  return PRESET_BY_ID.get(id) || null;
}

/**
 * 根据 baseUrl 自动生成连接名（§49）。
 *   https://api.deepseek.com/v1 → "DeepSeek"
 *   https://api.example.com/v1  → "example"
 *   http://localhost:11434      → "Ollama"
 */
function suggestName(baseUrl) {
  if (!baseUrl) return '新连接';
  try {
    const u = new URL(baseUrl);
    const preset = detectPreset({ hostname: u.hostname });
    if (preset && preset.id !== 'custom') return preset.name;
    // 本地端口特征：11434 → Ollama，1234 → LM Studio
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      if (u.port === '11434') return 'Ollama';
      if (u.port === '1234') return 'LM Studio';
    }
    // 取 hostname 的主域（example.com → example）
    const parts = u.hostname.split('.');
    const main = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return main || u.hostname;
  } catch {
    return '新连接';
  }
}

module.exports = { PRESETS, detectPreset, listPresets, getPreset, suggestName };
