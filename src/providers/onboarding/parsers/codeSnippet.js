'use strict';
/**
 * v2.4.0 Smart API Onboarding — Code Snippet Parser。
 *
 * 处理 §8 F/G：JavaScript/TypeScript 与 Python 代码片段。
 *   JS:    new OpenAI({ apiKey: "sk-xxx", baseURL: "https://..." })
 *   Py:    OpenAI(api_key="sk-xxx", base_url="https://...")
 *
 * 用极简正则抽 apiKey + baseURL，不做语法分析。
 */

const { createCandidate } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

const KEY_KW_RE = /(?:api[_-]?key|apikey|token|auth[_-]?token|access[_-]?token|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*[:=]\s*['"]([^'"]+)['"]/i;
const URL_KW_RE = /(?:base[_-]?url|baseurl|endpoint|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|api_base)\s*[:=]\s*['"]([^'"]+)['"]/i;
const MODEL_KW_RE = /(?:model|default[_-]?model)\s*[:=]\s*['"]([^'"]+)['"]/i;
// OpenAI(...)/Anthropic(...)/Client(...)/openai.OpenAI(...) 等构造调用
const CTOR_RE = /\b(?:new\s+)?(?:OpenAI|Anthropic|OpenRouter|DeepSeek|Client|AzureOpenAI)\s*\(/i;

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 必须出现构造调用才认
  if (!CTOR_RE.test(trimmed)) return null;

  const c = createCandidate();
  c.source.type = 'code-snippet';
  c.source.parser = 'codeSnippet';
  c.source.confidence = 0.82;
  c.source.rawLength = trimmed.length;

  const km = trimmed.match(KEY_KW_RE);
  const um = trimmed.match(URL_KW_RE);
  const mm = trimmed.match(MODEL_KW_RE);
  if (!km && !um) return null;

  if (km) c.apiKey = km[1].trim();
  if (um) c.baseUrl = normalizeBaseUrl(um[1]);
  if (mm) c.defaultModel = mm[1].trim();

  // 推测 preset（优先从构造函数名）
  const ctorMatch = trimmed.match(CTOR_RE);
  let hint = null;
  if (ctorMatch) {
    const name = ctorMatch[0].replace(/\s*\($/, '').replace(/^new\s+/, '').toLowerCase();
    hint = name;
  }
  const preset = hint
    ? detectPreset({ alias: hint })
    : (c.baseUrl ? (() => { try { return detectPreset({ hostname: new URL(c.baseUrl).hostname }); } catch { return null; } })() : null);
  c.providerHint = (preset && preset.id) || 'custom';
  c.protocolHint = (preset && preset.protocol) || 'custom';
  if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

  return c;
}

module.exports = { parse, CTOR_RE };
