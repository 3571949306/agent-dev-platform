'use strict';
/**
 * v2.4.0 Smart API Onboarding — Plain Text Parser。
 *
 * 处理最通用的两种形式（§8 A/B）：
 *   A. 带标签文本：  接口地址：https://api.example.com/v1\n  API Key：sk-xxx
 *   B. 纯 URL+Key：  https://api.example.com/v1\n  sk-xxx
 *
 * 也处理「Authorization: Bearer xxx」这类 header 行。
 * 不处理 ENV/JSON/curl/code —— 那些由专门 parser 命中。
 */

const { createCandidate, isSecretField } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

const URL_LINE_RE = /^(?:(?:接口地址|API\s*地址|Base\s*URL|base_url|baseURL|endpoint|地址|网址|URL)\s*[:：]\s*)?(https?:\/\/[^\s'"，,；;]+)$/i;
const KEY_LINE_RE = /^(?:(?:API\s*Key|api[_-]?key|apikey|密钥|Token|token|auth[_-]?token|access[_-]?token|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*[:：]\s*)([^\s]+)$/i;
const BEARER_RE = /^Authorization\s*[:：]\s*Bearer\s+([A-Za-z0-9_\-\.]+)$/i;
const XAPIKEY_RE = /^x-api-key\s*[:：]\s*([A-Za-z0-9_\-]+)$/i;
const SK_BARE_RE = /^(sk-[A-Za-z0-9_\-]{8,}|sk-ant-[A-Za-z0-9_\-]{8,})$/; // 裸 sk-xxx 行
const MODEL_LINE_RE = /^(?:模型|model|default[_-]?model)\s*[:：]\s*([^\s]+)$/i;

/**
 * @returns {import('../candidate').ImportCandidate | null}
 */
function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ENV / JSON / curl / code 由专门 parser 处理 —— 这里只处理纯文本/带标签
  if (/^[\s]*\{[\s\S]*\}\s*$/.test(trimmed)) return null; // JSON
  if (/^[\s]*(curl|export|set-env|\$env:)/im.test(trimmed)) return null; // curl / ENV
  if (/[A-Z_]+\s*=\s*[^\n]+\n[A-Z_]+\s*=/m.test(trimmed)) return null; // ENV 多行
  if (/new\s+OpenAI\s*\(|OpenAI\s*\(/m.test(trimmed)) return null; // JS/Python

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const c = createCandidate();
  c.source.type = 'plain-text';
  c.source.parser = 'plainText';
  c.source.confidence = 0.5;
  c.source.rawLength = trimmed.length;

  let urlFound = null;
  let keyFound = null;
  const extraHeaders = {};

  for (const line of lines) {
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // URL 行
    let m = line.match(URL_LINE_RE);
    if (m && !urlFound) {
      urlFound = normalizeBaseUrl(m[1]);
      continue;
    }
    // 裸 URL 行（无标签）
    if (!urlFound && /^https?:\/\/[^\s'"，,；;]+$/i.test(line)) {
      urlFound = normalizeBaseUrl(line);
      continue;
    }

    // Key 行（带标签）
    m = line.match(KEY_LINE_RE);
    if (m && !keyFound) { keyFound = m[1]; continue; }
    // Authorization: Bearer
    m = line.match(BEARER_RE);
    if (m && !keyFound) { keyFound = m[1]; continue; }
    // x-api-key: xxx
    m = line.match(XAPIKEY_RE);
    if (m && !keyFound) { keyFound = m[1]; continue; }
    // 裸 sk-xxx
    if (!keyFound && SK_BARE_RE.test(line)) { keyFound = line; continue; }

    // 模型行
    m = line.match(MODEL_LINE_RE);
    if (m && !c.defaultModel) { c.defaultModel = m[1]; continue; }

    // 其他 header: key: value（非 secret）
    const kvMatch = line.match(/^([A-Za-z][A-Za-z0-9\-_]*)\s*[:：]\s*(.+)$/);
    if (kvMatch && !isSecretField(kvMatch[1]) && !urlFound !== null) {
      // 仅在已找到 URL 后才收集 header，避免误吞随机文本
      if (urlFound) extraHeaders[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  if (!urlFound && !keyFound) return null;

  c.baseUrl = urlFound;
  c.apiKey = keyFound;
  c.headers = extraHeaders;

  // 推测 preset / 协议
  if (urlFound) {
    try {
      const u = new URL(urlFound);
      const preset = detectPreset({ hostname: u.hostname });
      c.providerHint = preset.id;
      c.protocolHint = preset.protocol;
      if (!c.name) c.name = suggestName(urlFound);
    } catch {
      c.providerHint = 'custom';
      c.protocolHint = 'custom';
    }
  }

  // 同时有 URL + Key 提升置信度
  if (urlFound && keyFound) c.source.confidence = 0.92;
  else if (urlFound) c.source.confidence = 0.7;
  else c.source.confidence = 0.4;

  return c;
}

module.exports = { parse, patterns: { URL_LINE_RE, KEY_LINE_RE, BEARER_RE, XAPIKEY_RE, SK_BARE_RE, MODEL_LINE_RE } };
