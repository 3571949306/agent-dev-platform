'use strict';
/**
 * v2.4.0 Smart API Onboarding — ImportCandidate 统一结构。
 *
 * 所有 Parser 最终输出同一个形状，便于预览/检测/导入链路统一处理。
 * ImportCandidate 只是「内存中的候选」，不写库；用户确认后才转为 Connection。
 *
 * 协议标识沿用现有 providers/index.js 的 conn.provider 取值：
 *   openai | openai-responses | anthropic | ollama | local | custom | mock
 *
 * §10/§22: providerHint（厂商）/ protocolHint（线协议）严格分离，不把厂商当协议。
 */

/** 创建空候选；Parser 用 Object.assign 填充字段。 */
function createCandidate() {
  return {
    name: null,                  // 用户可见连接名（可由 preset/hostname 推断，可被用户改）
    providerHint: null,          // 厂商 hint：openai/anthropic/deepseek/openrouter/ollama/lmstudio/custom/...
    protocolHint: null,          // 线协议 hint：openai/openai-responses/anthropic/ollama/local/custom
    baseUrl: null,               // 归一化后的 base URL（无尾斜杠；保留 /v1 等版本段）
    apiKey: null,                // 明文 key（仅在内存，预览时必须 mask）
    defaultModel: null,          // 用户/导入源指定的默认模型
    models: [],                  // 已知模型 id 列表（来自导入源；远端探测结果在 probe 阶段填回）
    headers: {},                 // 自定义 header（非 secret）
    notes: null,                 // 备注
    source: {                    // 解析来源元数据
      type: null,                // plain-text/env/json/toml/curl/js/python/powershell-env/ccswitch-deeplink/ccswitch-config/unknown
      parser: null,              // 实际命中的 parser 名
      confidence: 0,             // 0~1
      rawLength: 0               // 原始输入长度（仅元数据，不含原文）
    }
  };
}

/** 字段名集合，用于 sanitize 与重复检测。 */
const SECRET_FIELDS = new Set([
  'api_key', 'apikey', 'apiKey', 'token', 'auth_token', 'access_token',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'authorization', 'x-api-key', 'secret'
]);

/** 判断字段名是否疑似 secret（用于把 headers 里的 Authorization 抽到 apiKey）。 */
function isSecretField(name) {
  if (!name) return false;
  const lc = String(name).toLowerCase();
  if (SECRET_FIELDS.has(name) || SECRET_FIELDS.has(lc)) return true;
  return /(api[_-]?key|auth[_-]?token|access[_-]?token|^token$|secret|authorization|x-api-key)/i.test(name);
}

/**
 * 用现有 sec.mask() 把 candidate 的 apiKey mask 掉，返回可安全打印/序列化的副本。
 * §17：Parser debug、事件、预览都只能用 sanitize 后的版本。
 *
 * @param {object} sec require('../security/secret') 注入，避免本模块强依赖 electron
 */
function sanitizeCandidate(candidate, sec) {
  if (!candidate) return null;
  const m = (sec && typeof sec.mask === 'function') ? sec.mask : defaultMask;
  const safe = JSON.parse(JSON.stringify(candidate));
  if (safe.apiKey) safe.apiKey = m(safe.apiKey);
  if (safe.headers && typeof safe.headers === 'object') {
    safe.headers = {};
    for (const [k, v] of Object.entries(candidate.headers || {})) {
      safe.headers[k] = isSecretField(k) ? m(String(v)) : v;
    }
  }
  return safe;
}

function defaultMask(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 8) return s[0] + '****' + s[s.length - 1];
  return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 8, 12)) + s.slice(-4);
}

/** 校验候选是否包含最小可导入信息（至少有 baseUrl 或 apiKey 之一）。 */
function isViable(c) {
  if (!c) return false;
  if (c.baseUrl && String(c.baseUrl).trim()) return true;
  if (c.apiKey && String(c.apiKey).trim()) return true;
  if (Array.isArray(c.models) && c.models.length) return true;
  return false;
}

module.exports = {
  createCandidate,
  sanitizeCandidate,
  isSecretField,
  isViable,
  SECRET_FIELDS
};
