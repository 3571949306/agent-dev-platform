'use strict';
/**
 * v2.5.0 External Config Import — Conflict Resolver。
 *
 * §37/§38：复用现有 onboarding findDuplicate 逻辑，扩展为 5 种状态：
 *   NEW              — 无现有连接冲突
 *   DUPLICATE        — baseUrl + provider 完全匹配（§39 提示更新/跳过/另存）
 *   CONFLICT         — 同 name 但 baseUrl/provider 不同（§40 提示密钥不同，需用户决策）
 *   MISSING_SECRET   — baseUrl/model 存在但 apiKey 缺失（§36 允许手动补 key）
 *   INVALID          — 候选不 viable（无 baseUrl/apiKey/model）
 *
 * §40：不要无脑覆盖 Key。CONFLICT/DUPLICATE 时显示 mask 后的现有/导入 key。
 * §41：不显示两个完整 key，用 mask 形式比较。
 */

const { normalizeBaseUrl } = require('../urlNormalizer');
const { isViable } = require('../candidate');

const CONFLICT_STATES = ['NEW', 'DUPLICATE', 'CONFLICT', 'MISSING_SECRET', 'INVALID'];

/**
 * 评估单个 ImportCandidate 相对现有连接列表的冲突状态。
 *
 * @param {object} candidate ImportCandidate
 * @param {Array} existingConnections store.connections.list() 结果
 * @returns {object} {
 *   state: 'NEW'|'DUPLICATE'|'CONFLICT'|'MISSING_SECRET'|'INVALID',
 *   duplicateId?: string,        // DUPLICATE 时现有连接 id
 *   duplicateName?: string,
 *   conflictId?: string,         // CONFLICT 时冲突连接 id
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

  // MISSING_SECRET: 有 baseUrl 但无 apiKey（§36）
  // 注意：如果只有 apiKey 没 baseUrl，也算 INVALID，因为没法建连接
  const hasBaseUrl = candidate.baseUrl && String(candidate.baseUrl).trim();
  const hasApiKey = candidate.apiKey && String(candidate.apiKey).trim();
  const hasModel = (Array.isArray(candidate.models) && candidate.models.length)
    || (candidate.defaultModel && String(candidate.defaultModel).trim());

  if (hasBaseUrl && !hasApiKey && !hasModel) {
    return { state: 'MISSING_SECRET', reason: '检测到 API 配置但缺少密钥，可手动补充' };
  }
  // 有 model 没 key 也算 missing secret（需要 key 才能用）
  if (hasBaseUrl && hasModel && !hasApiKey) {
    return { state: 'MISSING_SECRET', reason: '检测到模型配置但缺少 API Key，可手动补充' };
  }

  const list = Array.isArray(existingConnections) ? existingConnections : [];

  // DUPLICATE: 同 normalizeBaseUrl + 同 provider（§37/§39）
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
        reason: `已有连接「${dup.name}」使用相同 baseUrl + 协议，可选择更新现有连接 / 跳过 / 另存为新连接`
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
 * §40/§41：比较现有 key 与导入 key 是否相同，返回 mask 后的对比信息。
 * 不返回任何明文。
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
  compareSecrets
};
