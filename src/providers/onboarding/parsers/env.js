'use strict';
/**
 * v2.4.0 Smart API Onboarding — ENV Parser。
 *
 * 处理 §8 C/D：
 *   C.  sh ENV:  OPENAI_API_KEY=sk-xxx\nOPENAI_BASE_URL=https://api.example.com/v1
 *                或带 export 前缀：  export OPENAI_API_KEY=sk-xxx
 *   D.  PowerShell ENV:  $env:OPENAI_API_KEY="sk-xxx"\n$env:OPENAI_BASE_URL="https://..."
 *
 * 也处理 OpenRouter / DeepSeek / Anthropic 等命名变体。
 */

const { createCandidate } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

// 已知 key → (candidate 字段, provider hint)
const KEY_MAP = {
  OPENAI_API_KEY: { field: 'apiKey', hint: 'openai' },
  OPENAI_BASE_URL: { field: 'baseUrl', hint: 'openai' },
  OPENAI_API_BASE: { field: 'baseUrl', hint: 'openai' },
  ANTHROPIC_API_KEY: { field: 'apiKey', hint: 'anthropic' },
  ANTHROPIC_AUTH_TOKEN: { field: 'apiKey', hint: 'anthropic' },
  ANTHROPIC_BASE_URL: { field: 'baseUrl', hint: 'anthropic' },
  OPENROUTER_API_KEY: { field: 'apiKey', hint: 'openrouter' },
  DEEPSEEK_API_KEY: { field: 'apiKey', hint: 'deepseek' },
  DEEPSEEK_BASE_URL: { field: 'baseUrl', hint: 'deepseek' },
  API_KEY: { field: 'apiKey', hint: null },
  API_BASE: { field: 'baseUrl', hint: null },
  BASE_URL: { field: 'baseUrl', hint: null }
};

// sh:  KEY=value | export KEY=value | KEY="value" | KEY='value'
const SH_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*))$/;
// ps:  $env:KEY="value"  |  $env:KEY = 'value'
const PS_RE = /^\$env:([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/;

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // 至少有一行匹配 ENV 格式才认为是 ENV
  const matched = lines.filter(l => SH_RE.test(l) || PS_RE.test(l));
  if (matched.length === 0) return null;
  // 至少匹配 1 个已知 key（避免误吞任意 ENV 块）
  const hasKnown = matched.some(l => {
    const m = l.match(SH_RE) || l.match(PS_RE);
    return m && KEY_MAP[m[1]];
  });
  if (!hasKnown) return null;

  const c = createCandidate();
  c.source.type = 'env';
  c.source.parser = 'env';
  c.source.confidence = 0.85;
  c.source.rawLength = trimmed.length;

  let hint = null;
  const extras = {};

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    let m = line.match(SH_RE);
    let key, val;
    if (m) {
      key = m[1];
      val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    } else {
      m = line.match(PS_RE);
      if (!m) continue;
      key = m[1];
      val = m[2] !== undefined ? m[2] : m[3];
    }
    val = String(val || '').trim();

    const mapped = KEY_MAP[key];
    if (mapped) {
      if (mapped.field === 'apiKey' && !c.apiKey) c.apiKey = val;
      else if (mapped.field === 'baseUrl' && !c.baseUrl) c.baseUrl = normalizeBaseUrl(val);
      if (mapped.hint && !hint) hint = mapped.hint;
    } else if (/URL|BASE/i.test(key)) {
      if (!c.baseUrl) c.baseUrl = normalizeBaseUrl(val);
    } else if (/KEY|TOKEN|SECRET/i.test(key)) {
      if (!c.apiKey) c.apiKey = val;
    } else {
      // 其他 ENV 当作自定义 header（非 secret 的）
      extras[key.toLowerCase()] = val;
    }
  }

  if (!c.baseUrl && !c.apiKey) return null;
  c.headers = extras;

  // 推测 preset
  const preset = hint
    ? detectPreset({ alias: hint })
    : (c.baseUrl ? detectPreset({ hostname: (() => { try { return new URL(c.baseUrl).hostname; } catch { return ''; } })() }) : null);
  c.providerHint = (preset && preset.id) || 'custom';
  c.protocolHint = (preset && preset.protocol) || 'custom';
  if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

  return c;
}

module.exports = { parse, KEY_MAP };
