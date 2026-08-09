'use strict';
/**
 * v2.4.0 Smart API Onboarding — curl Parser。
 *
 * 处理 §8 H：curl 命令。
 *   curl https://api.example.com/v1/chat/completions -H "Authorization: Bearer sk-xxx"
 *   curl -X POST https://api.example.com/v1/chat/completions -H "x-api-key: xxx" -d '{"model":"gpt-4o"}'
 *
 * 只抽取 URL + Authorization/x-api-key + 可选 model（来自 -d body）。
 */

const { createCandidate, isSecretField } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 必须以 curl 开头（允许前导空白）
  if (!/^curl\s+/i.test(trimmed)) return null;

  // 把 curl 命令拆成 token（简化处理：支持双引号、单引号）
  const tokens = tokenize(trimmed);
  if (!tokens.length) return null;

  const c = createCandidate();
  c.source.type = 'curl';
  c.source.parser = 'curl';
  c.source.confidence = 0.9;
  c.source.rawLength = trimmed.length;

  let url = null;
  const headers = {};
  let body = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-H' || t === '--header') {
      const hv = tokens[i + 1];
      if (hv) {
        const idx = hv.indexOf(':');
        if (idx > 0) {
          const k = hv.slice(0, idx).trim();
          const v = hv.slice(idx + 1).trim();
          if (isSecretField(k) && !c.apiKey) {
            // Authorization: Bearer xxx → 取 Bearer 后的 token
            c.apiKey = /^Bearer\s+/i.test(v) ? v.replace(/^Bearer\s+/i, '').trim() : v;
          } else {
            headers[k] = v;
          }
        }
        i++;
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      body = tokens[i + 1];
      i++;
    } else if (t === '-X' || t === '--request') {
      i++; // 跳过 method
    } else if (t === '-A' || t === '--user-agent') {
      i++;
    } else if (t.startsWith('-')) {
      // 其他 flag，跳过（可能带参数，保守不吞下一个 token）
    } else if (!url && /^https?:\/\//i.test(t)) {
      url = t;
    }
  }

  if (!url && !c.apiKey) return null;

  if (url) {
    c.baseUrl = normalizeBaseUrl(stripApiPath(url));
  }
  c.headers = headers;

  // 从 body 抽 model
  if (body) {
    try {
      const o = JSON.parse(body);
      if (o && o.model && !c.defaultModel) c.defaultModel = String(o.model);
    } catch { /* ignore */ }
  }

  // 推测 preset
  if (c.baseUrl) {
    try {
      const preset = detectPreset({ hostname: new URL(c.baseUrl).hostname });
      c.providerHint = preset.id;
      c.protocolHint = preset.protocol;
      if (!c.name) c.name = suggestName(c.baseUrl);
    } catch {
      c.providerHint = 'custom';
      c.protocolHint = 'custom';
    }
  } else {
    c.providerHint = 'custom';
    c.protocolHint = 'custom';
  }

  return c;
}

/** 把 /v1/chat/completions / /v1/responses / /v1/messages 等线协议路径剥掉，保留 base。 */
function stripApiPath(url) {
  return url
    .replace(/\/chat\/completions(\/.*)?$/i, '')
    .replace(/\/completions(\/.*)?$/i, '')
    .replace(/\/responses(\/.*)?$/i, '')
    .replace(/\/messages(\/.*)?$/i, '')
    .replace(/\/embeddings(\/.*)?$/i, '');
}

/** 简化 tokenizer：支持双引号、单引号、反斜杠转义、行尾反斜杠续行。 */
function tokenize(cmd) {
  const out = [];
  let i = 0;
  const s = cmd.replace(/\\\n/g, ' '); // 行尾续行
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let buf = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; }
          else { buf += s[i]; i++; }
        }
        i++; // 跳过闭合引号
      } else if (ch === '\\' && i + 1 < s.length) {
        buf += s[i + 1]; i += 2;
      } else {
        buf += ch; i++;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

module.exports = { parse, tokenize, stripApiPath };
