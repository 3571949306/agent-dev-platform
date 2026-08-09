'use strict';
/**
 * v2.4.0 Smart API Onboarding — 模块入口。
 *
 * 对外暴露：
 *   - parseInput(text)              → { candidate?, batch?, matchedParser? }
 *   - probe(candidate, opts)        → 检测报告 + 模型发现
 *   - importCandidate(candidate, { store, sec, assignToMain, agentId }) → Connection row
 *   - sanitizeCandidate(c, sec)     → mask 后的预览副本
 *   - listPresets() / detectPreset()
 *   - normalizeBaseUrl() / joinUrl()
 */

const { parseInput } = require('./smartImport');
const { probe } = require('./probe');
const { ProbeManager } = require('./probeManager');
const { createCandidate, sanitizeCandidate, isViable } = require('./candidate');
const { normalizeBaseUrl, joinUrl, candidateModelPaths } = require('./urlNormalizer');
const { listPresets, detectPreset, getPreset, suggestName } = require('./presets');
const external = require('./external');

/**
 * 把 ImportCandidate 写入数据库（用户确认后调用）。
 * §11：用户确认后才写库；secret 走 sec.encrypt。
 *
 * @param {object} candidate ImportCandidate（含明文 apiKey）
 * @param {object} ctx { store, sec, assignToMain?, agentId?, modelsOverride? }
 * @returns {object} { connection, assigned }
 */
function importCandidate(candidate, ctx) {
  const { store, sec } = ctx;
  if (!store || !sec) throw new Error('importCandidate 需要 store + sec 上下文');
  if (!isViable(candidate)) throw new Error('候选不可导入：缺少 baseUrl / apiKey / model');
  if (!candidate.baseUrl || !String(candidate.baseUrl).trim()) {
    throw new Error('候选不可导入：连接必须包含 baseUrl');
  }

  // v2.5.0 §49/§50/§52：保存 import_source 元数据（不持久化原始配置内容）
  const importSource = (candidate.source && candidate.source.type) || 'manual';
  const importSourcePath = (candidate.source && candidate.source.path) || '';

  const body = {
    name: candidate.name || suggestName(candidate.baseUrl) || '新连接',
    provider: candidate.protocolHint || 'custom',
    base_url: candidate.baseUrl || '',
    api_key: candidate.apiKey || '',
    headers: candidate.headers || {},
    models: (candidate.models || []).map(id => ({ id, source: 'remote', favorite: false, addedAt: null })),
    import_source: importSource,
    import_source_path: importSourcePath
  };

  // §47/§48：重复检测 —— 同 baseUrl + 同 provider 视为重复，返回 existing 让 GUI 决定
  const existing = findDuplicate(store, body.base_url, body.provider);
  if (existing && !ctx.forceOverwrite) {
    return { connection: existing, assigned: false, duplicate: true };
  }

  let connection;
  if (existing && ctx.forceOverwrite) {
    connection = store.connections.update(existing.id, body);
  } else {
    connection = store.connections.create(body);
  }

  // 如果有模型列表，写入 models_json
  if (Array.isArray(candidate.models) && candidate.models.length) {
    store.connections.setModels(connection.id, candidate.models.map(id => ({ id, source: 'remote' })));
  }

  // §35: 无远端模型列表时，如果用户手动输入了 defaultModel，写入为 manual 模型
  // 这样连接本身也有模型可查（不分配主智能体也不丢失）
  if ((!Array.isArray(candidate.models) || !candidate.models.length) && candidate.defaultModel) {
    store.connections.setModels(connection.id, [{ id: candidate.defaultModel, source: 'manual' }]);
  }

  // §39/§40：可选一键分配给主智能体
  let assigned = false;
  if (ctx.assignToMain) {
    const mainAgent = findMainAgent(store);
    if (mainAgent) {
      const model = candidate.defaultModel || (candidate.models && candidate.models[0]) || null;
      store.agents.update(mainAgent.id, {
        api_connection_id: connection.id,
        model: model || mainAgent.model
      });
      assigned = true;
    }
  } else if (ctx.agentId) {
    // 指定 agent
    const a = store.agents.get(ctx.agentId);
    if (a) {
      const model = candidate.defaultModel || (candidate.models && candidate.models[0]) || null;
      store.agents.update(a.id, {
        api_connection_id: connection.id,
        model: model || a.model
      });
      assigned = true;
    }
  }

  return { connection, assigned, duplicate: false };
}

/** §47：同 baseUrl + 同 provider 视为重复。不用 secret hash（§48）。 */
function findDuplicate(store, baseUrl, provider) {
  if (!baseUrl || !provider) return null;
  const list = store.connections.list();
  const norm = normalizeBaseUrl(baseUrl);
  return list.find(c => normalizeBaseUrl(c.base_url) === norm && c.provider === provider) || null;
}

function findMainAgent(store) {
  const list = store.agents.list();
  return list.find(a => a.is_main) || null;
}

module.exports = {
  parseInput,
  probe,
  ProbeManager,
  importCandidate,
  sanitizeCandidate,
  createCandidate,
  isViable,
  normalizeBaseUrl,
  joinUrl,
  candidateModelPaths,
  listPresets,
  detectPreset,
  getPreset,
  suggestName,
  external
};
