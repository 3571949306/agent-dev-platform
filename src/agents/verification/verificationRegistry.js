'use strict';
/**
 * VerificationRegistry — Agent 验证证据注册表（spec §65）。
 *
 * 职责：
 *   - 按 agentId 累积验证证据记录（evidence）
 *   - 基于累积证据计算 Agent 的最高可声明验证等级（使用 isClaimAllowed）
 *   - 序列化为 GUI / DB / 报告消费的结构
 *
 * 安全（spec §65）：
 *   evidence 记录的任何字段（type / status / timestamp / version /
 *   source / details）均不得携带凭据。record() 在写入前对所有字符串
 *   字段执行 stripSecrets 扫描，命中敏感模式（token / key / auth /
 *   secret / password / bearer / session / credential）的字段值会被
 *   替换为 '[REDACTED]'，防止凭据泄漏到证据流 / 日志 / GUI。
 *
 * 存储：内存 Map（agentId → evidence[]），不持久化。重新探测时
 * 调用 clear(agentId) 清空旧证据。
 */

const crypto = require('crypto');
const {
  isClaimAllowed,
  VERIFICATION_LEVEL,
  VERIFICATION_LEVEL_ORDER
} = require('./verificationLevel');

/**
 * 匹配敏感字段名的正则（不区分大小写）。与 EventNormalizer.SECRET_KEY_PATTERN 对齐。
 * @type {RegExp}
 */
const SECRET_KEY_PATTERN = /token|key|auth|secret|password|bearer|session|credential|cookie/i;

/**
 * 匹配疑似密钥 / 凭据值的正则（全局、不锚定，与 permissionAudit.js 对齐 —— §78）。
 * 覆盖常见格式：API key（sk-）、GitHub token（ghp_/gho_/ghu_/ghs_）、
 * AWS（AKIA）、Slack（xoxb-）、Bearer、PEM 私钥头、Cookie=、refresh_token。
 * 采用全局匹配（非 ^ 锚定），确保凭据嵌在句子中间也会被脱敏片段替换。
 * @type {RegExp}
 */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9]|gh[pous]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|xox[bpoa]-[A-Za-z0-9-]+|-----BEGIN[\s\S]*?END [A-Z ]+-----|Cookie=[^;\s]+|refresh_token[=:]\S+)/gi;

/**
 * 对单个字符串字段执行凭据脱敏。
 *   - 字段名命中敏感模式 → 值替换为 '[REDACTED]'
 *   - 值本身疑似密钥片段（无论是否整值） → 片段替换为 '[REDACTED]'
 *   - 否则原样返回
 * @param {string} value
 * @param {string} fieldName
 * @returns {string}
 */
function redactField(value, fieldName) {
  if (typeof value !== 'string') return value;
  if (SECRET_KEY_PATTERN.test(fieldName)) return '[REDACTED]';
  const redacted = value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  return redacted === value ? value : redacted;
}

/**
 * 对 evidence 记录的所有字段执行凭据脱敏。
 * 不修改原对象，返回清理后的副本（spec §65）。
 * @param {object} record
 * @returns {object}
 */
function sanitizeEvidence(record, parentKey = '') {
  if (record == null) return record;
  if (typeof record === 'string') return redactField(record, parentKey);
  if (Array.isArray(record)) return record.slice(0, 100).map(v => sanitizeEvidence(v, parentKey));
  if (typeof record !== 'object') return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = SECRET_KEY_PATTERN.test(k)
      ? '[REDACTED]'
      : sanitizeEvidence(v, k);
  }
  return out;
}

const RUNTIME_EVIDENCE_TYPES = new Set(['local_detection', 'protocol', 'agent_task', 'task']);

function createVerificationFingerprint(input = {}) {
  const safe = sanitizeEvidence({
    agentId: input.agentId || '',
    transport: input.transport || '',
    runtime: input.runtime || '',
    version: input.version || '',
    executableIdentity: input.executableIdentity || '',
    configurationIdentity: input.configurationIdentity || ''
  });
  return crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}

/**
 * 从累积证据记录中提取摘要，供 isClaimAllowed 判断。
 *
 * 只有 status === 'pass' 的记录才贡献正向证据。
 * evidence.type → 摘要字段映射：
 *   'provider'         → paidProvider（从 details 推断是否付费）
 *   'implementation'   → hasImplementation
 *   'fixture'          → hasFixture
 *   'packaged'         → hasPackaged
 *   'local_detection'  → executableFound + versionSucceeded
 *   'protocol'         → protocolInitialized
 *   'agent_task'/'task' → agentTaskCompleted
 *
 * @param {object[]} records
 * @returns {object} 证据摘要
 */
function summarizeEvidence(records) {
  const summary = {
    paidProvider: false,
    hasImplementation: false,
    hasFixture: false,
    hasPackaged: false,
    executableFound: false,
    versionSucceeded: false,
    protocolInitialized: false,
    agentTaskCompleted: false
  };

  for (const r of records) {
    if (!r || r.status !== 'pass') continue;
    switch (r.type) {
      case 'provider':
        if (r.details && /paid|subscription|billing/i.test(r.details)) {
          summary.paidProvider = true;
        }
        break;
      case 'implementation':
        summary.hasImplementation = true;
        break;
      case 'fixture':
        summary.hasFixture = true;
        break;
      case 'packaged':
        summary.hasPackaged = true;
        break;
      case 'local_detection':
        summary.executableFound = true;
        summary.versionSucceeded = true;
        break;
      case 'protocol':
        summary.protocolInitialized = true;
        break;
      case 'agent_task':
      case 'task':
        summary.agentTaskCompleted = true;
        break;
      default:
        break;
    }
  }

  return summary;
}

/**
 * 创建 VerificationRegistry。
 * @param {object} [opts] — 预留扩展（当前无必填项）
 * @returns {object} registry 实例
 */
function createVerificationRegistry(opts = {}) {
  /** @type {Map<string, object[]>} agentId → evidence 记录数组 */
  const store = new Map();
  const persistence = opts.persistence || null;
  const loaded = new Set();
  const fingerprints = new Map();

  function ensureLoaded(agentId) {
    if (loaded.has(agentId)) return;
    loaded.add(agentId);
    if (!persistence || typeof persistence.list !== 'function') return;
    let records = [];
    try { records = persistence.list(agentId) || []; } catch { records = []; }
    store.set(agentId, records.map(sanitizeEvidence));
  }

  function validRecords(agentId) {
    ensureLoaded(agentId);
    const current = fingerprints.get(agentId) || null;
    return (store.get(agentId) || []).filter(r => {
      if (!RUNTIME_EVIDENCE_TYPES.has(r.type)) return true;
      if (!current) return true;
      return !!r.projectFingerprint && r.projectFingerprint === current;
    });
  }

  /**
   * 追加一条验证证据记录（spec §65）。
   * 自动对凭据字段脱敏。失败 / skipped 记录也会追加（用于审计），但不提升等级。
   * @param {string} agentId
   * @param {object} evidence — 证据记录
   * @param {string} evidence.type — 'local_detection' | 'fixture' | 'protocol' | 'packaged' | 'implementation' | 'agent_task' | 'provider'
   * @param {string} evidence.status — 'pass' | 'fail' | 'skipped'
   * @param {string} [evidence.timestamp] — ISO 8601，缺省取当前时间
   * @param {string} [evidence.version] — 工具/SDK 版本
   * @param {string} [evidence.source] — 证据来源（如 'claude --version'）
   * @param {string} [evidence.details] — 附加上下文（不含凭据）
   * @returns {object} 实际存入的（脱敏后的）证据记录
   */
  function record(agentId, evidence) {
    if (!agentId) throw new Error('record: agentId 必填');
    if (!evidence || typeof evidence !== 'object') {
      throw new Error('record: evidence 必须为对象');
    }

    ensureLoaded(agentId);
    const sanitized = sanitizeEvidence({
      verificationId: evidence.verificationId || crypto.randomUUID(),
      agentId,
      adapterRuntime: evidence.adapterRuntime || evidence.runtime || '',
      type: String(evidence.type || 'unknown'),
      status: String(evidence.status || 'skipped'),
      timestamp: evidence.timestamp || new Date().toISOString(),
      version: evidence.version || '',
      source: evidence.source || '',
      runId: evidence.runId || null,
      projectFingerprint: evidence.projectFingerprint || fingerprints.get(agentId) || '',
      effectObserved: evidence.effectObserved === true,
      reason: evidence.reason || '',
      details: evidence.details || ''
    });

    if (!store.has(agentId)) store.set(agentId, []);
    const duplicate = store.get(agentId).find(r =>
      r.type === sanitized.type && r.status === sanitized.status &&
      r.version === sanitized.version && r.source === sanitized.source &&
      r.projectFingerprint === sanitized.projectFingerprint &&
      r.runId === sanitized.runId && r.reason === sanitized.reason);
    if (duplicate) return { ...duplicate };
    store.get(agentId).push(sanitized);
    if (persistence && typeof persistence.append === 'function') {
      try { persistence.append(sanitized); } catch { /* persistence failure cannot forge evidence */ }
    }
    return sanitized;
  }

  /**
   * 计算指定 Agent 当前可声明的最高验证等级（spec §39-§43）。
   * 遍历从高到低的等级，返回第一个 isClaimAllowed 通过的等级。
   * 无证据时返回 NOT_VERIFIED。
   * @param {string} agentId
   * @returns {string} VERIFICATION_LEVEL.*
   */
  function getLevel(agentId) {
    const records = validRecords(agentId);
    if (!records || records.length === 0) {
      return VERIFICATION_LEVEL.NOT_VERIFIED;
    }
    const summary = summarizeEvidence(records);
    // 从高到低找第一个 isClaimAllowed 通过的等级
    for (let i = VERIFICATION_LEVEL_ORDER.length - 1; i >= 0; i--) {
      if (isClaimAllowed(VERIFICATION_LEVEL_ORDER[i], summary)) {
        return VERIFICATION_LEVEL_ORDER[i];
      }
    }
    return VERIFICATION_LEVEL.NOT_VERIFIED;
  }

  /**
   * 返回指定 Agent 的全部证据记录（深拷贝副本，防止外部修改）。
   * @param {string} agentId
   * @returns {object[]}
   */
  function getEvidence(agentId) {
    const records = validRecords(agentId);
    return records ? records.map(r => ({ ...r })) : [];
  }

  /**
   * 序列化 Agent 的验证状态，供 GUI / DB / 报告消费。
   * @param {string} agentId
   * @returns {{ level: string, evidence: object[] }}
   */
  function serialize(agentId) {
    return {
      level: getLevel(agentId),
      evidence: getEvidence(agentId)
    };
  }

  /**
   * 清除指定 Agent 的全部证据（用于重新探测）。
   * @param {string} agentId
   */
  function clear(agentId) {
    store.delete(agentId);
    loaded.delete(agentId);
    if (persistence && typeof persistence.clear === 'function') {
      try { persistence.clear(agentId); } catch { /* noop */ }
    }
  }

  function setFingerprint(agentId, fingerprint) {
    if (!agentId) throw new Error('setFingerprint: agentId 必填');
    fingerprints.set(agentId, String(fingerprint || ''));
    ensureLoaded(agentId);
    return fingerprints.get(agentId);
  }

  function getFingerprint(agentId) { return fingerprints.get(agentId) || null; }

  return {
    record,
    getLevel,
    getEvidence,
    serialize,
    clear,
    setFingerprint,
    getFingerprint
  };
}

module.exports = {
  createVerificationRegistry,
  createVerificationFingerprint,
  sanitizeEvidence,
  summarizeEvidence
};
