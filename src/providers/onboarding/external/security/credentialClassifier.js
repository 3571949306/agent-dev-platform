'use strict';
/**
 * v2.5.1 External Import Security — Value-Level Credential Classifier。
 *
 * v2.5.0 的 secretSanitizer.js 主要靠「字段名」判断凭据类型，但字段名不足：
 *   Authorization: Bearer eyJxxx.yyy.zzz   （看起来是 apiKey 字段，实际是 OAuth JWT）
 *   apiKey = eyJxxxxx.yyyyy.zzzzz          （看起来是 apiKey，实际是 JWT 登录态）
 *
 * 本模块补充「值形状」判断，与字段名 + 来源上下文共同决定是否允许导入。
 *
 * §3/§4/§5/§6/§7：
 *   - 标准 JWT 结构 xxxxx.yyyyy.zzzzz 本地解析 payload（不验证签名、不发网络、不刷新 token）
 *   - payload 含 chatgpt_plan_type / subscription_active_until → membership_token，allowed=false
 *   - payload 含 oauth / scope / session → oauth_token / session_token，allowed=false
 *   - 字段名是 apiKey/Authorization 但 value 是 JWT 且无法证明是普通 API Key → jwt_unknown，allowed=false
 *   - sk-xxx / sk-ant-xxx / sk-proj-xxx / AIza... / 普通随机 token → api_key，allowed=true
 *   - Bearer 前缀剥离后再判断：Bearer sk-xxx → api_key；Bearer eyJ.x.y → jwt_unknown
 *
 * §4 安全约束：不把 payload 写日志、不把完整 JWT 放错误信息。
 */

const { isUnsupportedCredential, isSupportedApiKey } = require('./secretSanitizer');

/**
 * 识别标准 JWT 结构：三段 base64url，用 '.' 分隔。
 * 不验证签名，只做结构判断。
 */
function isJwtLike(value) {
  if (!value || typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 16) return false;
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  // 每段至少 1 字符，且符合 base64url 字符集
  const b64url = /^[A-Za-z0-9_-]+$/;
  return parts.every(p => p.length > 0 && b64url.test(p));
}

/**
 * §4：安全解析 JWT payload（仅本地，不验证签名，不发网络）。
 * 返回解析后的对象或 null。不把 payload 写日志。
 * payload 字段名命中以下视为不可迁移凭据：
 *   chatgpt_plan_type, subscription_active_until, subscription_plan, plan_type, membership
 *   oauth, scope, account_id, auth_time, session
 */
function parseJwtPayload(jwt) {
  if (!isJwtLike(jwt)) return null;
  try {
    const parts = jwt.split('.');
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // padding
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** JWT payload 中暗示「会员 / 订阅」的字段名。 */
const MEMBERSHIP_PAYLOAD_FIELDS = new Set([
  'chatgpt_plan_type',
  'subscription_active_until',
  'subscription_plan',
  'plan_type',
  'membership',
  'membership_type',
  'membership_status'
]);

/** JWT payload 中暗示「OAuth / Session」的字段名。 */
const OAUTH_PAYLOAD_FIELDS = new Set([
  'oauth',
  'scope',
  'account_id',
  'auth_time',
  'session',
  'session_id',
  'iss',      // OAuth issuer
  'aud',      // OAuth audience
  'azp',      // OAuth authorized party
  'grant_type'
]);

/**
 * 检测 JWT payload 是否含会员 / OAuth / Session 字段。
 * 返回 { type: 'membership'|'oauth'|'session'|null, matchedFields: string[] }
 */
function inspectJwtPayload(payload) {
  if (!payload || typeof payload !== 'object') return { type: null, matchedFields: [] };
  const matched = [];
  let type = null;
  for (const key of Object.keys(payload)) {
    const lk = String(key).toLowerCase();
    if (MEMBERSHIP_PAYLOAD_FIELDS.has(lk)) {
      matched.push(key);
      if (type !== 'membership') type = 'membership'; // membership 优先级最高
    } else if (OAUTH_PAYLOAD_FIELDS.has(lk)) {
      matched.push(key);
      if (!type) type = 'oauth';
    }
  }
  return { type, matchedFields: matched };
}

/** 剥离 Bearer / token 前缀，返回实际 value。 */
function stripAuthPrefix(value) {
  if (!value || typeof value !== 'string') return value;
  const s = value.trim();
  // Bearer / Token / Basic 前缀（不区分大小写）
  const m = s.match(/^(bearer|token|basic)\s+(.+)$/i);
  if (m) return m[2].trim();
  return s;
}

/** 已知 API Key 前缀形状（值形状判断）。 */
const API_KEY_PREFIX_PATTERNS = [
  /^sk-[a-zA-Z0-9_-]{8,}$/,           // OpenAI sk-xxx
  /^sk-ant-[a-zA-Z0-9_-]{8,}$/,       // Anthropic sk-ant-xxx
  /^sk-proj-[a-zA-Z0-9_-]{8,}$/,      // OpenAI project key
  /^sk-or-[a-zA-Z0-9_-]{8,}$/,        // OpenRouter sk-or-xxx
  /^AIza[0-9A-Za-z_-]{16,}$/,         // Google AIza...
  /^sk-[a-zA-Z0-9]{16,}$/             // Deepseek / 其他 sk- 前缀
];

/**
 * 判断 value 是否符合已知 API Key 形状（§6 不误伤正常 key）。
 */
function looksLikeApiKey(value) {
  if (!value || typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 8) return false;
  return API_KEY_PREFIX_PATTERNS.some(re => re.test(s));
}

/**
 * §3：Value-Level Credential Classification。
 *
 * @param {string} value 凭据值（可能是裸 key、Bearer xxx、JWT）
 * @param {object} context? { fieldName?: string }
 * @returns {object} {
 *   classification: 'api_key'|'oauth_token'|'session_token'|'membership_token'|'jwt_unknown'|'unknown',
 *   allowed: boolean,
 *   confidence: number 0~1,
 *   reasons: string[]
 * }
 */
function classifyCredentialValue(value, context = {}) {
  const reasons = [];
  if (!value || (typeof value !== 'string') || !value.trim()) {
    return { classification: 'unknown', allowed: false, confidence: 1, reasons: ['值为空'] };
  }

  const fieldName = context.fieldName || '';

  // v2.6.0 §3.1 — Basic Authorization 不得自动作为 API Key。
  // Bearer / Token 剥离后继续 classification；Basic 默认 unsupported。
  // 必须在 stripAuthPrefix 之前检测，否则 Basic 前缀会被剥掉变成裸 base64。
  if (/^basic\s+/i.test(value.trim())) {
    return {
      classification: 'basic_auth',
      allowed: false,
      confidence: 1,
      reasons: ['检测到 Basic Authentication Credential。当前版本不会自动迁移用户名/密码凭据，请手动配置。']
    };
  }

  const stripped = stripAuthPrefix(value);

  // 1. 字段名优先：如果是已知不可迁移字段名 → 直接拒绝
  if (fieldName && isUnsupportedCredential(fieldName)) {
    reasons.push(`字段名 "${fieldName}" 命中不可迁移凭据黑名单`);
    return {
      classification: 'oauth_token',
      allowed: false,
      confidence: 0.95,
      reasons
    };
  }

  // 2. 检测 JWT 结构
  if (isJwtLike(stripped)) {
    const payload = parseJwtPayload(stripped);
    if (payload) {
      const ins = inspectJwtPayload(payload);
      if (ins.type === 'membership') {
        // §4：含 chatgpt_plan_type / subscription_active_until → membership_token
        reasons.push('JWT payload 含会员/订阅字段（不显示具体内容）');
        return {
          classification: 'membership_token',
          allowed: false,
          confidence: 0.98,
          reasons
        };
      }
      if (ins.type === 'oauth') {
        reasons.push('JWT payload 含 OAuth/Session 字段（不显示具体内容）');
        return {
          classification: 'oauth_token',
          allowed: false,
          confidence: 0.9,
          reasons
        };
      }
    }
    // §5：JWT 但无法明确证明是普通 API Key → jwt_unknown，保守拒绝
    // 但如果字段名是已知 API Key 字段且 value 有已知 API Key 前缀（极少见 JWT 同时匹配 sk-），放行
    if (looksLikeApiKey(stripped)) {
      reasons.push('值虽含点号但匹配已知 API Key 前缀形状');
      return { classification: 'api_key', allowed: true, confidence: 0.7, reasons };
    }
    reasons.push('值形似 JWT 但无法确认为普通 API Key，保守拒绝');
    return {
      classification: 'jwt_unknown',
      allowed: false,
      confidence: 0.8,
      reasons
    };
  }

  // 3. 非 JWT：检查是否为已知 API Key 形状
  if (looksLikeApiKey(stripped)) {
    reasons.push('值匹配已知 API Key 前缀形状');
    return { classification: 'api_key', allowed: true, confidence: 0.85, reasons };
  }

  // 4. 字段名是已知 API Key 字段，且值不像 JWT
  if (fieldName && isSupportedApiKey(fieldName)) {
    // 普通随机 token（非 sk- 前缀）也允许，因为字段名确认是 API Key
    // 但需排除明显是 session/oauth 的值
    if (/^(eyJ|eyJhbGci)/.test(stripped)) {
      // 以 eyJ 开头但没被 isJwtLike 识别（可能结构不完整）→ 保守拒绝
      reasons.push('值以 eyJ 开头疑似 JWT 片段，保守拒绝');
      return { classification: 'jwt_unknown', allowed: false, confidence: 0.7, reasons };
    }
    reasons.push(`字段名 "${fieldName}" 命中可迁移 API Key 字段名`);
    return { classification: 'api_key', allowed: true, confidence: 0.7, reasons };
  }

  // 5. 无法分类
  reasons.push('值不符合任何已知凭据形状');
  return { classification: 'unknown', allowed: false, confidence: 0.5, reasons };
}

/**
 * §7：处理 Authorization header 值，剥离 Bearer 后再分类。
 * 返回 classifyCredentialValue 的结果，并在 reasons 中标注 Bearer 处理。
 */
function classifyAuthorizationHeader(headerValue) {
  if (!headerValue) {
    return { classification: 'unknown', allowed: false, confidence: 1, reasons: ['Authorization 值为空'] };
  }
  // v2.6.0 §3.1 — Basic Auth 直接拒绝，不剥离前缀继续分类。
  if (/^basic\s+/i.test(headerValue.trim())) {
    return {
      classification: 'basic_auth',
      allowed: false,
      confidence: 1,
      reasons: ['检测到 Basic Authentication Credential。当前版本不会自动迁移用户名/密码凭据，请手动配置。']
    };
  }
  const stripped = stripAuthPrefix(headerValue);
  const result = classifyCredentialValue(stripped, { fieldName: 'authorization' });
  if (headerValue.trim() !== stripped) {
    result.reasons.unshift('已剥离 Bearer/Token 前缀');
  }
  return result;
}

module.exports = {
  isJwtLike,
  parseJwtPayload,
  inspectJwtPayload,
  stripAuthPrefix,
  looksLikeApiKey,
  classifyCredentialValue,
  classifyAuthorizationHeader,
  MEMBERSHIP_PAYLOAD_FIELDS,
  OAUTH_PAYLOAD_FIELDS
};
