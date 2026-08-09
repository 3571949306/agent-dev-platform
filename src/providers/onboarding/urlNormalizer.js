'use strict';
/**
 * v2.4.0 Smart API Onboarding — URL Normalizer。
 *
 * §26/§27：所有 baseUrl 走统一 helper，避免 /v1/v1/models 这种重复拼接。
 *
 * 归一化规则：
 *   - 去掉首尾空白
 *   - 补全 scheme（无 scheme 时默认 https://）
 *   - 去掉尾斜杠
 *   - 保留 /v1 //v2 等版本段（OpenAI 兼容网关的 /v1 是线协议路径，不能剥）
 *   - 不强制小写 host（避免某些自签名场景区分大小写的问题），仅 scheme 小写
 *
 * Probe / listModels 等需要拼接路径的，使用 joinUrl(baseUrl, '/models')。
 */

const URL_RE = /^(https?:\/\/)?([\w.\-:]+)([^\s]*)$/i;

/** 把任意用户输入归一化为标准 baseUrl（无尾斜杠，含 scheme）。 */
function normalizeBaseUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  // 去除前后引号（用户从代码里复制时常见）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return null;
  // 补 scheme
  if (!/^https?:\/\//i.test(s)) {
    // localhost / 127.0.0.1 / 192.168.* 这种默认 http（本地网关常见）
    if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s)) {
      s = 'http://' + s;
    } else {
      s = 'https://' + s;
    }
  }
  // scheme 小写
  s = s.replace(/^(https?:)/i, m => m.toLowerCase());
  // 去尾斜杠
  s = s.replace(/\/+$/, '');
  return s;
}

/**
 * 安全拼接 baseUrl + path，确保不会产生 //v1//models 或 /v1/v1/models。
 * path 必须以 / 开头；如果 baseUrl 已经以该 path 结尾，则不重复追加。
 *
 *   joinUrl('https://x.com/v1', '/models') → 'https://x.com/v1/models'
 *   joinUrl('https://x.com/v1/', '/models') → 'https://x.com/v1/models'
 *   joinUrl('https://x.com', '/v1/models') → 'https://x.com/v1/models'
 *   joinUrl('https://x.com/v1', '/v1/models') → 'https://x.com/v1/models'（重复 /v1 折叠）
 */
function joinUrl(baseUrl, path) {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return null;
  let p = String(path || '');
  if (!p) return b;
  if (!p.startsWith('/')) p = '/' + p;
  // 折叠重复：如果 baseUrl 已以 path 开头（如 b=.../v1, p=/v1/models），不重复
  // 简单实现：把 b 与 b+p 都算出来，优先用更短且包含完整 path 的
  const direct = b + p;
  // 检测 b 是否已包含 p 的前缀段（避免 /v1/v1）
  const bSegments = b.split('/').filter(Boolean);
  const pSegments = p.split('/').filter(Boolean);
  // 跳过 p 开头与 b 结尾完全重复的段
  let overlap = 0;
  for (let i = 1; i <= Math.min(bSegments.length, pSegments.length); i++) {
    const bTail = bSegments.slice(-i).join('/');
    const pHead = pSegments.slice(0, i).join('/');
    if (bTail.toLowerCase() === pHead.toLowerCase()) overlap = i;
  }
  if (overlap > 0) {
    const merged = b + '/' + pSegments.slice(overlap).join('/');
    return merged.replace(/\/+$/, '');
  }
  // 折叠 path 中间多余斜杠，但保留 scheme 的 //（https://）
  const schemeMatch = direct.match(/^(https?:\/\/)(.*)$/i);
  if (schemeMatch) return schemeMatch[1] + schemeMatch[2].replace(/\/{2,}/g, '/');
  return direct.replace(/\/{2,}/g, '/');
}

/**
 * 推测 OpenAI 兼容端点的 models 路径候选（最多 3 个，按优先级）。
 * §28：最多 MAX_PROBES=4，这里只返回路径候选，由 probe 模块控制总请求数。
 *
 *   candidateModelPaths('https://x.com/v1')     → ['/models']
 *   candidateModelPaths('https://x.com')        → ['/v1/models', '/models']
 *   candidateModelPaths('https://x.com/api/v1') → ['/models', '/v1/models']
 */
function candidateModelPaths(baseUrl) {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return [];
  const paths = [];
  const hasV1 = /\/v\d+(\/|$)/i.test(b);
  if (hasV1) {
    paths.push('/models');
  } else {
    paths.push('/v1/models');
    paths.push('/models');
  }
  return paths;
}

module.exports = { normalizeBaseUrl, joinUrl, candidateModelPaths };
