'use strict';
/**
 * v2.7.2 External Agent Runtime Reliability — 统一结果契约 + 凭据脱敏（spec §39 / §40 / §41）。
 *
 * 三个外部适配器（Cline / OpenCode / OpenHands）此前结果结构不完全统一，且 Cline
 * 默认把完整 raw 结果塞进 SQLite / Event / logs，可能携带内部事件、敏感字段与大对象。
 *
 * 本模块提供：
 *   - buildExternalResult(overrides)  统一结果骨架（ok / agentId / runId / status / ...）
 *   - stripSecrets(value)             递归脱敏（apiKey / Authorization / Bearer / token /
 *                                     OAuth / session / cookie / password）
 *   - sanitizeRaw(raw, maxLen)        把大对象压缩为有限长度、已脱敏的字符串摘要
 */

const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|token|oauth|session|cookie|password|secret|private[_-]?key)/i;
const SECRET_VALUE_RE = /(Bearer\s+[A-Za-z0-9._~+\/-]+|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]+)/g;
const REDACTED = '[REDACTED]';
const DEFAULT_RAW_MAX_LEN = 2000;

/**
 * 递归脱敏。对对象：命中敏感 key 的值替换为 [REDACTED]；对字符串：替换常见凭据形态。
 * 不修改入参（字符串不可变，对象做浅拷贝后替换）。
 * @param {*} value
 * @returns {*}
 */
function stripSecrets(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_RE, REDACTED);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (typeof value.toJSON === 'function') {
    try { return stripSecrets(value.toJSON()); } catch { /* fall through */ }
  }
  const out = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (typeof k === 'string' && SECRET_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = stripSecrets(v);
    }
  }
  return out;
}

/**
 * 把原始 SDK / 协议结果压缩为有限长度、已脱敏的字符串摘要。
 * 仅用于 debug / 日志，不进入 SQLite 主结果。
 * @param {*} raw
 * @param {number} [maxLen]
 * @returns {string|null}
 */
function sanitizeRaw(raw, maxLen = DEFAULT_RAW_MAX_LEN) {
  if (raw === null || raw === undefined) return null;
  let text;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(stripSecrets(raw));
  } catch {
    try { text = String(raw); } catch { return null; }
  }
  if (text && text.length > maxLen) {
    text = text.slice(0, maxLen) + `…[truncated ${text.length - maxLen} chars]`;
  }
  return text;
}

/**
 * 统一外部 Agent 结果骨架（spec §39）。
 * @param {object} o
 * @returns {object}
 */
function buildExternalResult(o = {}) {
  const startedAt = (o.startedAt != null) ? o.startedAt : null;
  const finishedAt = (o.finishedAt != null) ? o.finishedAt : Date.now();
  const durationMs = (startedAt != null) ? Math.max(0, finishedAt - startedAt) : null;
  const status = o.status || 'failed';
  return {
    // ok 必须与 status 一致：failed / cancelled / timeout 绝不可上报 ok=true（§39 结果诚实）
    ok: (o.ok !== undefined && o.ok !== null) ? !!o.ok : (status === 'completed'),
    agentId: o.agentId || null,
    runId: o.runId || null,
    status,
    summary: String(stripSecrets(o.summary || '')).slice(0, 4000),
    findings: Array.isArray(o.findings) ? stripSecrets(o.findings.slice(0, 200)) : [],
    changedFiles: Array.isArray(o.changedFiles) ? stripSecrets(o.changedFiles.slice(0, 2000)) : [],
    artifacts: Array.isArray(o.artifacts) ? stripSecrets(o.artifacts.slice(0, 200)) : [],
    diff: Array.isArray(o.diff) ? stripSecrets(o.diff.slice(0, 2000)) : [],
    tests: Array.isArray(o.tests) ? stripSecrets(o.tests.slice(0, 500)) : [],
    usage: stripSecrets(o.usage || null),
    errors: Array.isArray(o.errors) ? stripSecrets(o.errors) : [],
    durationMs,
    provenance: stripSecrets(o.provenance || null)
  };
}

/** Reduce any adapter-specific result to the bounded production contract.
 * Full raw payloads, screenshots, process environment and credentials are
 * intentionally not retained in Hub lifecycle results. */
function sanitizeExternalResult(result, identity = {}) {
  const value = result && typeof result === 'object' ? result : { summary: result };
  const out = buildExternalResult({
    ...value,
    agentId: identity.agentId || value.agentId,
    runId: identity.runId || value.runId
  });
  const optional = [
    'sessionId', 'runtime', 'stopReason', 'exitCode', 'httpStatus',
    'quiesced', 'residual', 'effectObserved', 'verificationStatus',
    'reportedChangedFiles', 'observedChangedFiles', 'beforeFingerprint',
    'afterFingerprint', 'errorCode', 'protocolVersion', 'window',
    'inputVia', 'readVia', 'polls', 'elapsedMs', 'visionCalls',
    'visionModel', 'confidence'
  ];
  for (const key of optional) {
    if (value[key] !== undefined) out[key] = stripSecrets(value[key]);
  }
  if (value.plan !== undefined) out.plan = stripSecrets(value.plan);
  if (value.readFiles !== undefined) out.readFiles = stripSecrets(Array.isArray(value.readFiles) ? value.readFiles.slice(0, 2000) : []);
  if (value.permissionDenials !== undefined) out.permissionDenials = stripSecrets(Array.isArray(value.permissionDenials) ? value.permissionDenials.slice(0, 200) : []);
  if (value.sanitizedRaw !== undefined) out.sanitizedRaw = sanitizeRaw(value.sanitizedRaw);
  return out;
}

/** 对一段错误数组脱敏（供适配器在不走 buildExternalResult 时复用）。 */
function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map(e => {
    if (typeof e === 'string') return stripSecrets(e);
    return stripSecrets(e);
  });
}

module.exports = { buildExternalResult, sanitizeExternalResult, stripSecrets, sanitizeRaw, sanitizeErrors, REDACTED };
