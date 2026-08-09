'use strict';
/**
 * v2.4.0 Smart API Onboarding — TOML Parser（最小实现，不引入 toml 依赖）。
 *
 * 处理 §8 I：常见 Agent / Codex 类 Provider 配置。
 *   [model_providers.foo]
 *   name = "Foo"
 *   base_url = "https://api.foo.com/v1"
 *   env_key = "FOO_API_KEY"
 *
 *   # 顶层
 *   model = "foo-1"
 *   model_provider = "foo"
 *
 * 只支持：字符串/布尔/整数 值、[table] 段、简单键值对。
 * 不支持数组 of table / inline table / 多行字符串（够用即可，不重写 toml 库）。
 *
 * 注意：env_key 只是环境变量名，不是 secret 本身 —— secret 由用户后续填。
 * 这里把 env_key 作为 header 提示，不当作 apiKey。
 */

const { createCandidate } = require('../candidate');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');

// v2.5.1 §25：prototype pollution 防御
const FORBIDDEN_TOML_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // strip inline comment（保守：仅当 # 前有空格且不在引号内时才当注释）
    line = stripInlineComment(line);
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const path = tableMatch[1].split('.').map(s => s.trim());
      cur = root;
      for (const p of path) {
        // v2.5.1 §25：过滤 prototype pollution 字段
        if (FORBIDDEN_TOML_KEYS.has(p)) { cur = {}; break; }
        if (!cur[p] || typeof cur[p] !== 'object') {
          const next = {};
          Object.defineProperty(cur, p, {
            value: next,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
        cur = cur[p];
      }
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const k = m[1];
    // v2.5.1 §25：过滤 prototype pollution 字段
    if (FORBIDDEN_TOML_KEYS.has(k)) continue;
    const v = parseValue(m[2]);
    if (v !== null) {
      // v2.5.1 §25：用 Object.defineProperty 避免 __proto__ setter
      Object.defineProperty(cur, k, {
        value: v,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return root;
}

function stripInlineComment(line) {
  let inStr = false, q = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === q) inStr = false;
    } else {
      if (ch === '"' || ch === "'") { inStr = true; q = ch; }
      else if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s; // bare value
}

function parse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 必须看起来像 TOML：含 [section] 或 key = value 且不含 {（避免误吞 JSON）
  if (!(/^\[[^\]]+\]/m.test(trimmed) || /^[A-Za-z0-9_\-]+\s*=\s*["']?[^"'\n]+["']?$/m.test(trimmed))) return null;
  if (trimmed.startsWith('{')) return null; // JSON

  let obj;
  try { obj = parseToml(trimmed); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const c = createCandidate();
  c.source.type = 'toml';
  c.source.parser = 'toml';
  c.source.confidence = 0.75;
  c.source.rawLength = trimmed.length;

  // 顶层
  if (obj.model) c.defaultModel = String(obj.model);
  if (obj.base_url) c.baseUrl = normalizeBaseUrl(obj.base_url);
  if (obj.name && typeof obj.name === 'string') c.name = obj.name;
  if (obj.api_key) c.apiKey = String(obj.api_key);

  // model_providers.* 子表（Codex 风格）
  const mp = obj.model_providers || obj.providers || {};
  if (mp && typeof mp === 'object') {
    // 优先用 model_provider 指向的那个，否则取第一个
    const wantedKey = obj.model_provider && mp[obj.model_provider] ? obj.model_provider : Object.keys(mp)[0];
    const wanted = wantedKey ? mp[wantedKey] : null;
    if (wanted && typeof wanted === 'object') {
      if (!c.baseUrl && wanted.base_url) c.baseUrl = normalizeBaseUrl(wanted.base_url);
      if (!c.name && wanted.name) c.name = String(wanted.name);
      if (!c.apiKey && wanted.api_key) c.apiKey = String(wanted.api_key);
      if (!c.defaultModel && wanted.model) c.defaultModel = String(wanted.model);
      // env_key 只是变量名，不是 secret；记到 header 提示
      if (wanted.env_key && !c.headers['env_key']) c.headers['env_key'] = wanted.env_key;
    }
  }

  if (!c.baseUrl && !c.apiKey && !c.defaultModel) return null;

  // 推测 preset
  let preset = null;
  if (c.baseUrl) {
    try { preset = detectPreset({ hostname: new URL(c.baseUrl).hostname }); } catch {}
  }
  c.providerHint = (preset && preset.id) || 'custom';
  c.protocolHint = (preset && preset.protocol) || 'custom';
  if (!c.name && c.baseUrl) c.name = suggestName(c.baseUrl);

  return c;
}

module.exports = { parse, parseToml, stripInlineComment, parseValue };
