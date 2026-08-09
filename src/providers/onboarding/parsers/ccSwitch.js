'use strict';
/**
 * v2.4.0 Smart API Onboarding — CC Switch Importer。
 *
 * 基于 CC Switch commit 413c09e0790c304506888ae24b9be72820aca126（v3.19.2）
 * 实际源码研究实现。CC Switch 是 Tauri 应用，其 Deep Link 协议为：
 *
 *   ccswitch://v1/import?resource=provider&app=claude&name=...&endpoint=...&apiKey=...&model=...
 *
 * 我们借鉴其 Deep Link 格式与 settingsConfig 模板思想，转换为我们的 ImportCandidate。
 * 不照搬 CC Switch 的 settingsConfig 结构（那是 CLI 配置文件格式，我们用 conn.provider 协议）。
 *
 * §41/§43：优先 Deep Link（公开、跨平台），Config（本地存储）作为可选。
 * §42/§44：只读；用户主动点击才读，不启动时扫描。
 * §19：第三方 Deep Link 可能含 secret —— 解析后只在内存，mask 显示，确认后写入 safeStorage。
 *
 * License attribution 见 THIRD_PARTY_NOTICES.md。
 */

const { createCandidate } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

/**
 * 解析 CC Switch Deep Link。
 *   ccswitch://v1/import?resource=provider&app=claude&name=Foo&endpoint=https://...&apiKey=sk-xxx&model=...
 *
 * 支持多 endpoint（逗号分隔）—— 第一个作为 baseUrl，其余作为候选（暂存到 headers）。
 * 支持 config（Base64 编码的 JSON/TOML 配置片段）—— 尝试解出 model/base_url。
 *
 * @returns {ImportCandidate | null}
 */
function parseDeepLink(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^ccswitch:\/\//i.test(trimmed)) return null;

  let url;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== 'ccswitch:') return null;
  if (url.host !== 'v1') return null; // host 必须是版本号
  if (url.pathname !== '/import') return null;

  const params = url.searchParams;
  const resource = params.get('resource');
  if (resource !== 'provider') return null; // prompt/mcp/skill 不在本 parser 范围

  const c = createCandidate();
  c.source.type = 'ccswitch-deeplink';
  c.source.parser = 'ccSwitch';
  c.source.confidence = 0.95;
  c.source.rawLength = trimmed.length;

  const name = params.get('name');
  if (name) c.name = name;

  const endpoints = (params.get('endpoint') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (endpoints.length) {
    c.baseUrl = normalizeBaseUrl(endpoints[0]);
    if (endpoints.length > 1) c.headers['x-endpoint-candidates'] = endpoints.slice(1).join(',');
  }

  const apiKey = params.get('apiKey');
  if (apiKey) c.apiKey = apiKey;

  const model = params.get('model');
  if (model) c.defaultModel = model;

  // config（Base64 编码的 JSON 或 TOML 配置片段）
  const configB64 = params.get('config');
  const configFormat = params.get('configFormat') || 'json';
  if (configB64) {
    try {
      const decoded = Buffer.from(configB64, 'base64').toString('utf8');
      const config = configFormat === 'toml'
        ? parseTomlMinimal(decoded)
        : JSON.parse(decoded);
      if (config && typeof config === 'object') {
        if (!c.baseUrl && config.base_url) c.baseUrl = normalizeBaseUrl(config.base_url);
        if (!c.apiKey && config.api_key) c.apiKey = String(config.api_key);
        if (!c.defaultModel && config.model) c.defaultModel = String(config.model);
      }
    } catch { /* ignore malformed config */ }
  }

  // notes / homepage
  const notes = params.get('notes');
  if (notes) c.notes = notes;
  const homepage = params.get('homepage');
  if (homepage && !c.headers['x-website']) c.headers['x-website'] = homepage;

  // app 字段（claude/codex/gemini/...）—— 映射到我们的 protocolHint
  const app = params.get('app');
  if (app) {
    const proto = mapAppToProtocol(app);
    if (proto) c.protocolHint = proto;
    c.headers['x-ccswitch-app'] = app;
  }

  if (!c.baseUrl && !c.apiKey && !c.defaultModel) return null;

  // 推测 preset（name 优先）
  const preset = (c.baseUrl || c.name)
    ? detectPreset({ hostname: c.baseUrl ? safeHostname(c.baseUrl) : null, name: c.name })
    : null;
  if (preset) {
    c.providerHint = preset.id;
    if (!c.protocolHint) c.protocolHint = preset.protocol;
  } else {
    c.providerHint = 'custom';
    if (!c.protocolHint) c.protocolHint = 'custom';
  }
  if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

  return c;
}

/**
 * 从 CC Switch 配置对象数组批量导入（§45/§46）。
 * CC Switch 的 Provider 对象字段：{ id, name, settingsConfig, websiteUrl, category, ... }
 * settingsConfig 形态因 app 而异（Claude={env:{ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN}}, Codex={auth:{OPENAI_API_KEY},config:toml}）。
 *
 * 我们只抽取通用字段：name / baseUrl / apiKey / model / websiteUrl。
 * secret 抽取后只在内存（mask 显示）。
 *
 * @returns {ImportCandidate[]}
 */
function parseConfigBatch(ccSwitchProviders) {
  if (!Array.isArray(ccSwitchProviders)) return [];
  const out = [];
  for (const p of ccSwitchProviders) {
    if (!p || typeof p !== 'object') continue;
    const c = createCandidate();
    c.source.type = 'ccswitch-config';
    c.source.parser = 'ccSwitch';
    c.source.confidence = 0.85;
    c.name = p.name || null;
    if (p.websiteUrl) c.headers['x-website'] = p.websiteUrl;

    // settingsConfig 形态归一化
    const sc = p.settingsConfig || {};
    // Claude/Anthropic 形态
    if (sc.env) {
      if (sc.env.ANTHROPIC_BASE_URL) c.baseUrl = normalizeBaseUrl(sc.env.ANTHROPIC_BASE_URL);
      if (sc.env.ANTHROPIC_AUTH_TOKEN) c.apiKey = sc.env.ANTHROPIC_AUTH_TOKEN;
      else if (sc.env.ANTHROPIC_API_KEY && !c.apiKey) c.apiKey = sc.env.ANTHROPIC_API_KEY;
      if (sc.env.OPENAI_BASE_URL && !c.baseUrl) c.baseUrl = normalizeBaseUrl(sc.env.OPENAI_BASE_URL);
      if (sc.env.OPENAI_API_KEY && !c.apiKey) c.apiKey = sc.env.OPENAI_API_KEY;
    }
    // Codex 形态
    if (sc.auth && sc.auth.OPENAI_API_KEY && !c.apiKey) c.apiKey = sc.auth.OPENAI_API_KEY;
    if (typeof sc.config === 'string' && sc.config) {
      // Codex 的 config.toml 文本
      try {
        const cfg = parseTomlMinimal(sc.config);
        if (cfg.base_url && !c.baseUrl) c.baseUrl = normalizeBaseUrl(cfg.base_url);
        if (cfg.model && !c.defaultModel) c.defaultModel = String(cfg.model);
      } catch { /* ignore */ }
    }
    // 通用字段
    if (!c.baseUrl && p.base_url) c.baseUrl = normalizeBaseUrl(p.base_url);
    if (!c.apiKey && p.api_key) c.apiKey = String(p.api_key);
    if (!c.defaultModel && p.model) c.defaultModel = String(p.model);

    if (!c.baseUrl && !c.apiKey && !c.defaultModel) continue;

    const preset = (c.baseUrl || c.name)
      ? detectPreset({ hostname: c.baseUrl ? safeHostname(c.baseUrl) : null, name: c.name })
      : null;
    c.providerHint = (preset && preset.id) || 'custom';
    c.protocolHint = (preset && preset.protocol) || 'custom';
    if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

    out.push(c);
  }
  return out;
}

function mapAppToProtocol(app) {
  const s = String(app || '').toLowerCase();
  if (s === 'claude') return 'anthropic';
  if (s === 'codex') return 'openai-responses'; // Codex 默认走 Responses API
  if (s === 'gemini') return 'custom'; // 我们暂无 gemini 原生 provider，归 custom
  return null;
}

function safeHostname(url) { try { return new URL(url).hostname; } catch { return null; } }

/** 极简 TOML 解析（避免循环依赖到ml parser，这里复用一份最小实现）。 */
function parseTomlMinimal(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const m = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

module.exports = { parseDeepLink, parseConfigBatch, mapAppToProtocol };
