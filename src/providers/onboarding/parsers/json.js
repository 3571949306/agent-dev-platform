'use strict';
/**
 * v2.4.0 Smart API Onboarding — JSON Parser。
 *
 * 处理 §8 E：JSON 配置对象。
 * 支持字段：apiKey/api_key/key、baseURL/base_url/url/endpoint、model/defaultModel、
 *          headers、name、provider/protocol。
 *
 * 也处理 OpenAI SDK 风格的 { apiKey, baseURL }。
 */

const { createCandidate, isSecretField } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

function pick(obj, names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && String(obj[n]).trim() !== '') return obj[n];
  }
  return null;
}

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let obj;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  // 数组：交给 ccSwitch parser 处理（多 provider 批量）
  if (Array.isArray(obj)) return null;

  const c = createCandidate();
  c.source.type = 'json';
  c.source.parser = 'json';
  c.source.confidence = 0.9;
  c.source.rawLength = trimmed.length;

  const key = pick(obj, ['apiKey', 'api_key', 'key', 'token', 'auth_token', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  const url = pick(obj, ['baseURL', 'base_url', 'baseUrl', 'url', 'endpoint', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']);
  const model = pick(obj, ['model', 'defaultModel', 'default_model', 'defaultModelId']);
  const name = pick(obj, ['name', 'title', 'label']);
  const provider = pick(obj, ['provider', 'providerHint', 'vendor']);
  const protocol = pick(obj, ['protocol', 'protocolHint', 'apiFormat']);
  const headers = pick(obj, ['headers', 'extraHeaders', 'extra_headers', 'customHeaders']);

  if (key) c.apiKey = String(key).trim();
  if (url) c.baseUrl = normalizeBaseUrl(url);
  if (model) c.defaultModel = String(model).trim();
  if (name) c.name = String(name).trim();
  if (headers && typeof headers === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(headers)) {
      // secret header 抽到 apiKey，不重复存在（§52）；剥掉 Bearer 前缀
      if (isSecretField(k) && !c.apiKey) {
        const raw = String(v).trim();
        c.apiKey = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, '').trim() : raw;
      } else {
        clean[k] = v;
      }
    }
    c.headers = clean;
  }

  if (!c.baseUrl && !c.apiKey && !c.defaultModel) return null;

  // 推测 preset
  let preset = null;
  if (provider) preset = detectPreset({ alias: String(provider) });
  else if (c.baseUrl) {
    try { preset = detectPreset({ hostname: new URL(c.baseUrl).hostname }); } catch {}
  }
  c.providerHint = (preset && preset.id) || (provider ? String(provider) : 'custom');
  c.protocolHint = protocol ? mapProtocolHint(protocol) : ((preset && preset.protocol) || 'custom');
  if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

  return c;
}

function mapProtocolHint(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'openai' || s === 'openai_chat' || s === 'openai-chat' || s === 'chat') return 'openai';
  if (s === 'openai-responses' || s === 'openai_responses' || s === 'responses') return 'openai-responses';
  if (s === 'anthropic') return 'anthropic';
  if (s === 'ollama') return 'ollama';
  if (s === 'local' || s === 'lmstudio') return 'local';
  return 'custom';
}

module.exports = { parse, mapProtocolHint };
