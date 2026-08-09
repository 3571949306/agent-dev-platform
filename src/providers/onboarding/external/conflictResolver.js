'use strict';
/**
 * v2.5.0/v2.5.1 External Config Import — Conflict Resolver。
 *
 * §37/§38：复用现有 onboarding findDuplicate 逻辑，扩展为 5 种状态：
 *   NEW              — 无现有连接冲突
 *   DUPLICATE        — baseUrl + provider 完全匹配（§39 提示更新/跳过/另存）
 *   CONFLICT         — 同 name 但 baseUrl/provider 不同 / 同端异钥（§40 提示密钥不同，需用户决策）
 *   MISSING_SECRET   — baseUrl/model 存在但 apiKey 缺失（§36 允许手动补 key）
 *   INVALID          — 候选不 viable（无 baseUrl/apiKey/model）
 *
 * v2.5.1 §14-§18：Same Endpoint + Different Secret Conflict。
 *   - 同 baseUrl + 同 protocol + 不同 apiKey → CONFLICT (SAME_ENDPOINT_DIFFERENT_SECRET)
 *   - 不自动覆盖，需用户明确选择：更新现有 / 保留现有 / 另存为新连接 / 取消
 *   - §15：不通过 Mask 判断 Secret 一定相同
 *   - §16：constant-time compare 解密后的明文 key，立即丢弃
 */

const crypto = require('crypto');
const { normalizeBaseUrl } = require('../urlNormalizer');
const { isViable } = require('../candidate');

const CONFLICT_STATES = ['NEW', 'DUPLICATE', 'CONFLICT', 'MISSING_SECRET', 'UNSUPPORTED', 'INVALID'];

/**
 * v2.6.0 §3.2：Constant-time string comparison using crypto.timingSafeEqual。
 *
 * 长度不同时不得直接把不同长度 Buffer 传给 timingSafeEqual（会抛异常），
 * 先比较长度并返回 false。比较后立即丢弃明文 Buffer。
 * 不把明文 Secret 写日志。
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // 长度不同：仍然消耗固定时间后再返回 false，避免长度泄漏。
    try { crypto.timingSafeEqual(ba, ba); } catch { /* ignore */ }
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 评估单个 ImportCandidate 相对现有连接列表的冲突状态。
 *
 * v2.5.1：DUPLICATE 时额外返回 requiresCredentialCheck: true，
 * 供 IPC handler 解密现有 key 做 constant-time compare。
 *
 * v2.5.1 §32（Case 25）：新增 UNSUPPORTED 状态 —— 候选的凭据值被分类器拒绝
 * （JWT/OAuth/Session/会员令牌）。优先级高于 MISSING_SECRET，因为不是「缺 key」
 * 而是「key 被安全策略拒绝，不应重新输入」。
 *
 * @param {object} candidate ImportCandidate
 * @param {Array} existingConnections store.connections.list() 结果
 * @returns {object} {
 *   state: 'NEW'|'DUPLICATE'|'CONFLICT'|'MISSING_SECRET'|'UNSUPPORTED'|'INVALID',
 *   duplicateId?: string,
 *   duplicateName?: string,
 *   requiresCredentialCheck?: boolean,  // v2.5.1: DUPLICATE 时需进一步检查密钥
 *   conflictId?: string,
 *   conflictName?: string,
 *   reason: string
 * }
 */
function resolveConflict(candidate, existingConnections) {
  if (!candidate) {
    return { state: 'INVALID', reason: '候选为空' };
  }

  // INVALID: 完全不可导入（§38）
  if (!isViable(candidate)) {
    return { state: 'INVALID', reason: '候选缺少 baseUrl / apiKey / model' };
  }

  // v2.5.1 §32（Case 25）：UNSUPPORTED —— 凭据值被分类器拒绝（JWT/OAuth/Session/会员）
  // 优先级高于 MISSING_SECRET：不是「缺 key」而是「key 被安全策略拒绝」
  if (candidate._unsupportedCredential) {
    return {
      state: 'UNSUPPORTED',
      reason: candidate._unsupportedCredential.reason || '检测到不可迁移凭据类型，该凭据不会被导入'
    };
  }

  // MISSING_SECRET: 有 baseUrl 但无 apiKey（§36）
  const hasBaseUrl = candidate.baseUrl && String(candidate.baseUrl).trim();
  const hasApiKey = candidate.apiKey && String(candidate.apiKey).trim();
  const hasModel = (Array.isArray(candidate.models) && candidate.models.length)
    || (candidate.defaultModel && String(candidate.defaultModel).trim());

  if (hasBaseUrl && !hasApiKey && !hasModel) {
    return { state: 'MISSING_SECRET', reason: '检测到 API 配置但缺少密钥，可手动补充' };
  }
  if (hasBaseUrl && hasModel && !hasApiKey) {
    return { state: 'MISSING_SECRET', reason: '检测到模型配置但缺少 API Key，可手动补充' };
  }

  const list = Array.isArray(existingConnections) ? existingConnections : [];

  // DUPLICATE: 同 normalizeBaseUrl + 同 provider（§37/§39）
  // v2.5.1 §14：标记 requiresCredentialCheck 供后续密钥比较
  if (hasBaseUrl && candidate.protocolHint) {
    const norm = normalizeBaseUrl(candidate.baseUrl);
    const dup = list.find(c =>
      normalizeBaseUrl(c.base_url) === norm && c.provider === candidate.protocolHint
    );
    if (dup) {
      return {
        state: 'DUPLICATE',
        duplicateId: dup.id,
        duplicateName: dup.name,
        duplicateMasked: dup.api_key_masked || '',
        requiresCredentialCheck: true,  // v2.5.1: 需要进一步检查密钥是否相同
        reason: `已有连接「${dup.name}」使用相同 baseUrl + 协议，需检查密钥是否相同`
      };
    }
  }

  // CONFLICT: 同 name 但 baseUrl 或 provider 不同（§40 提示密钥可能不同）
  if (candidate.name) {
    const sameName = list.find(c => c.name === candidate.name);
    if (sameName) {
      const sameBaseUrl = hasBaseUrl
        && normalizeBaseUrl(sameName.base_url) === normalizeBaseUrl(candidate.baseUrl);
      const sameProvider = sameName.provider === candidate.protocolHint;
      if (!sameBaseUrl || !sameProvider) {
        return {
          state: 'CONFLICT',
          conflictId: sameName.id,
          conflictName: sameName.name,
          conflictReason: 'NAME_CONFLICT',
          reason: `已有连接「${sameName.name}」同名但 baseUrl 或协议不同，需用户确认是否覆盖`
        };
      }
    }
  }

  // NEW: 无任何冲突
  return { state: 'NEW', reason: '无冲突，可直接导入' };
}

/**
 * 批量评估候选列表的冲突状态。
 * @param {Array} candidates ImportCandidate[]
 * @param {Array} existingConnections
 * @returns {Array} [{ candidate, conflict, ... }]
 */
function resolveBatchConflicts(candidates, existingConnections) {
  return (candidates || []).map(candidate => ({
    candidate,
    conflict: resolveConflict(candidate, existingConnections)
  }));
}

/**
 * v2.5.1 §14-§18：Same Endpoint Different Key 冲突检测。
 *
 * 当 DUPLICATE 被检测到时（同 baseUrl + 同 protocol），需要进一步检查密钥是否相同。
 * §15：不通过 Mask 判断 Secret 一定相同。
 * §16：解密现有 key → constant-time compare → 立即丢弃明文。
 *
 * @param {object} candidate ImportCandidate（含明文 apiKey）
 * @param {object} duplicateConflict resolveConflict 返回的 DUPLICATE conflict 对象
 * @param {object} store db store（用于 getDecrypted）
 * @param {object} sec security module（用于 mask）
 * @returns {object} {
 *   state: 'DUPLICATE'|'CONFLICT',
 *   credentialConflict: boolean,
 *   sameKey: boolean,
 *   importedMasked: string,
 *   existingMasked: string,
 *   requiresConfirmation: boolean,
 *   reason: string,
 *   conflictReason?: 'SAME_ENDPOINT_DIFFERENT_SECRET'
 * }
 */
function checkCredentialConflict(candidate, duplicateConflict, store, sec) {
  const importedKey = candidate && candidate.apiKey ? String(candidate.apiKey) : '';
  const existingMasked = duplicateConflict.duplicateMasked || '';
  const importedMasked = importedKey ? (sec && typeof sec.mask === 'function' ? sec.mask : defaultMask)(importedKey) : '';

  // 如果导入的候选没有 apiKey（例如 MISSING_SECRET），不需要 credential check
  if (!importedKey) {
    return {
      ...duplicateConflict,
      credentialConflict: false,
      sameKey: false,
      importedMasked: '',
      existingMasked,
      requiresConfirmation: false
    };
  }

  // §16：解密现有 key → constant-time compare → 立即丢弃
  let sameKey = false;
  try {
    const existingConn = store && store.connections && store.connections.getDecrypted
      ? store.connections.getDecrypted(duplicateConflict.duplicateId)
      : null;
    if (existingConn && existingConn.api_key) {
      sameKey = constantTimeCompare(importedKey, String(existingConn.api_key));
      // 立即丢弃明文（变量超出作用域即被 GC）
    }
  } catch {
    // 解密失败 → 保守处理，视为 credential conflict
    sameKey = false;
  }

  if (sameKey) {
    // 同端同钥：真正的 DUPLICATE，不需要确认覆盖
    return {
      ...duplicateConflict,
      credentialConflict: false,
      sameKey: true,
      importedMasked,
      existingMasked,
      requiresConfirmation: false,
      reason: `已有连接「${duplicateConflict.duplicateName}」使用相同 baseUrl + 协议 + 密钥，可选择更新 / 跳过 / 另存为新连接`
    };
  }

  // §14/§17：同端异钥 → CONFLICT，不自动覆盖
  return {
    state: 'CONFLICT',
    credentialConflict: true,
    sameKey: false,
    importedMasked,
    existingMasked,
    requiresConfirmation: true,
    duplicateId: duplicateConflict.duplicateId,
    duplicateName: duplicateConflict.duplicateName,
    conflictReason: 'SAME_ENDPOINT_DIFFERENT_SECRET',
    reason: `检测到相同 API 地址和协议，但密钥不同。现有：${existingMasked || '(无)'}，导入：${importedMasked}。需用户确认是否更新现有连接。`
  };
}

/**
 * v2.5.1 §14-§18：批量冲突结果增强 —— 对 DUPLICATE 结果做 credential check。
 *
 * @param {Array} batchResults resolveBatchConflicts 的结果
 * @param {object} store db store
 * @param {object} sec security module
 * @returns {Array} 增强后的结果（DUPLICATE + requiresCredentialCheck → 可能变为 CONFLICT）
 */
function enrichBatchWithCredentialConflicts(batchResults, store, sec) {
  return (batchResults || []).map(item => {
    const { candidate, conflict } = item;
    if (conflict && conflict.state === 'DUPLICATE' && conflict.requiresCredentialCheck) {
      const enriched = checkCredentialConflict(candidate, conflict, store, sec);
      return { candidate, conflict: enriched };
    }
    return item;
  });
}

/**
 * §40/§41：比较现有 key 与导入 key 是否相同，返回 mask 后的对比信息。
 * 不返回任何明文。
 *
 * v2.5.1 §15：警告 — mask 相同不代表 secret 相同，此函数仅用于 UI 显示。
 * 真正的 secret equality 判断应使用 checkCredentialConflict + constantTimeCompare。
 *
 * @param {string} existingMasked 现有连接的 api_key_masked 字段
 * @param {string} importedPlain 导入的明文 key
 * @param {Function} maskFn sec.mask 函数
 * @returns {object} { same: boolean, existingMasked: string, importedMasked: string }
 */
function compareSecrets(existingMasked, importedPlain, maskFn) {
  const importedMasked = importedPlain ? (maskFn || defaultMask)(importedPlain) : '';
  const same = !!existingMasked && !!importedMasked && existingMasked === importedMasked;
  return { same, existingMasked: existingMasked || '', importedMasked };
}

function defaultMask(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 8) return s[0] + '****' + s[s.length - 1];
  return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 8, 12)) + s.slice(-4);
}

module.exports = {
  CONFLICT_STATES,
  resolveConflict,
  resolveBatchConflicts,
  compareSecrets,
  constantTimeCompare,
  checkCredentialConflict,
  enrichBatchWithCredentialConflicts
};
