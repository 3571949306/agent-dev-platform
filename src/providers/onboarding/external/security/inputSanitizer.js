'use strict';
/**
 * v2.5.1 External Config Import — Hostile Input Defense。
 *
 * §24/§25/§26：防御畸形 / 恶意外部配置输入。
 *   - §25 Prototype Pollution：过滤 __proto__ / prototype / constructor 字段
 *   - §26 URL Scheme Whitelist：baseUrl 只允许 http/https（含本地 IP / localhost）
 *   - §24 Fuzz：对解析后的对象做深度清洗，never crash / never eval / never require
 *
 * 安全原则：
 *   - 不修改原始输入对象（返回新对象）
 *   - 递归清洗嵌套对象/数组
 *   - 不调用 eval / new Function / require
 *   - 不信任任何外部字段名
 *   - 限制字符串最大长度（防止巨型 payload 内存爆炸）
 */

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** v2.5.1 §24：单字段字符串最大长度（1 MB），防止巨型 payload 内存爆炸。 */
const MAX_STRING_LENGTH = 1024 * 1024;
/** v2.5.1 §24：对象最大嵌套深度，防止畸形嵌套导致栈溢出。 */
const MAX_DEPTH = 32;
/** v2.5.1 §24：对象最大字段数，防止巨型对象内存爆炸。 */
const MAX_KEYS = 1000;

/**
 * v2.5.1 §25：递归过滤 prototype pollution 字段。
 * 输入：
 *   { "__proto__": { "polluted": true }, "a": { "constructor": { "prototype": { "x": 1 } } } }
 * 输出：
 *   { "a": {} }
 *
 * 不修改原始对象，返回新对象。
 * 同时做：
 *   - 字符串长度限制
 *   - 嵌套深度限制
 *   - 字段数限制
 *
 * @param {*} value 任意值（对象/数组/原始值）
 * @param {object} opts { depth, maxStringLength, maxDepth, maxKeys }
 * @returns {*} 清洗后的值
 */
function sanitizeObject(value, opts = {}) {
  const depth = opts.depth || 0;
  const maxDepth = opts.maxDepth || MAX_DEPTH;
  const maxStringLength = opts.maxStringLength || MAX_STRING_LENGTH;
  const maxKeys = opts.maxKeys || MAX_KEYS;

  if (depth > maxDepth) return null;  // 深度超限，截断为 null

  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length && i < maxKeys; i++) {
      const cleaned = sanitizeObject(value[i], { depth: depth + 1, maxStringLength, maxDepth, maxKeys });
      out.push(cleaned);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    const out = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= maxKeys) break;  // 字段数超限，截断
      // §25：过滤 prototype pollution 字段
      if (FORBIDDEN_KEYS.has(key)) continue;
      // 字段名必须是 string 且长度合理
      if (typeof key !== 'string' || key.length > 256) continue;
      const cleaned = sanitizeObject(value[key], { depth: depth + 1, maxStringLength, maxDepth, maxKeys });
      // 不用 out[key] = ... 防止 __proto__ 之类通过 key 重新注入
      // Object.defineProperty 安全赋值（避免 __proto__ setter）
      try {
        Object.defineProperty(out, key, {
          value: cleaned,
          writable: true,
          enumerable: true,
          configurable: true
        });
      } catch {
        // skip unassignable key
      }
      count++;
    }
    return out;
  }

  if (typeof value === 'string') {
    return value.length > maxStringLength ? value.slice(0, maxStringLength) : value;
  }

  // number / boolean / null / undefined 原样返回
  return value;
}

/**
 * v2.5.1 §25：安全 JSON.parse + prototype pollution 过滤。
 * 解析失败返回 null（不抛异常）。
 *
 * @param {string} text JSON 文本
 * @param {object} opts sanitizeObject 选项
 * @returns {object|array|null} 解析并清洗后的对象
 */
function safeJsonParse(text, opts = {}) {
  if (!text || typeof text !== 'string') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  return sanitizeObject(obj, opts);
}

/**
 * v2.5.1 §26：URL Scheme 白名单校验。
 * 只允许 http: / https:，拒绝 file:/javascript:/data:/ftp:/gopher:/ws:/wss:。
 *
 * 本地 AI 服务允许：
 *   http://localhost
 *   http://127.0.0.1
 *   http://192.168.x.x
 *   http://10.x.x.x
 *   http://172.16-31.x.x
 *
 * @param {string} url 待校验 URL
 * @returns {object} { ok: boolean, scheme?: string, reason?: string }
 */
function validateUrlScheme(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, reason: 'URL 为空' };
  }
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: 'URL 为空' };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return { ok: false, reason: `URL 格式无效：${e.message}` };
  }

  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol.toLowerCase())) {
    return { ok: false, scheme: parsed.protocol, reason: `不允许的协议 "${parsed.protocol}"，仅支持 http/https` };
  }

  return { ok: true, scheme: parsed.protocol };
}

/**
 * v2.5.1 §26：检查 URL 是否指向本地地址（用于本地 AI 服务白名单）。
 *
 * @param {string} url 待检查 URL
 * @returns {boolean} true 表示是本地地址
 */
function isLocalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch { return false; }
  // new URL('http://[::1]:8080').hostname 返回 '[::1]'（含方括号），需 strip
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // 私有 IP 段
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  return false;
}

/**
 * v2.5.1 §24：检查字符串是否含 null byte / 控制字符（畸形输入信号）。
 *
 * @param {string} s 待检查字符串
 * @returns {boolean} true 表示含危险控制字符
 */
function hasControlChars(s) {
  if (typeof s !== 'string') return false;
  // null byte 或其他 C0 控制字符（除 \t \r \n）
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/**
 * v2.5.1 §24：清洗字符串 —— 移除 null byte，截断超长字符串。
 *
 * @param {string} s 待清洗字符串
 * @param {number} maxLen 最大长度
 * @returns {string} 清洗后的字符串
 */
function sanitizeString(s, maxLen = MAX_STRING_LENGTH) {
  if (typeof s !== 'string') return '';
  let out = s.replace(/\0/g, '');  // 移除 null byte
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

module.exports = {
  sanitizeObject,
  safeJsonParse,
  validateUrlScheme,
  isLocalUrl,
  hasControlChars,
  sanitizeString,
  ALLOWED_URL_SCHEMES,
  FORBIDDEN_KEYS,
  MAX_STRING_LENGTH,
  MAX_DEPTH,
  MAX_KEYS
};
