'use strict';
/**
 * v2.5.0 External Config Import — Normalizer。
 *
 * 把各 Importer 输出的原始字段归一化为符合现有 ImportCandidate 形状的对象。
 * 复用 urlNormalizer / presets.detectPreset / suggestName，不重新发明轮子。
 *
 * §12 wire_api 映射：responses → openai-responses，chat → openai
 * §17 Claude 第三方网关不强制定 provider=Anthropic Official
 */

const { normalizeBaseUrl } = require('../urlNormalizer');
const { detectPreset, suggestName } = require('../presets');
const { createCandidate } = require('../candidate');
const { sourceTypeToImportSource } = require('./externalSource');

/**
 * 把外部 Importer 提取的原始字段构造为 ImportCandidate。
 *
 * @param {object} raw {
 *   name, baseUrl, apiKey, defaultModel, models,
 *   protocolHint, providerHint, headers, notes,
 *   wireApi,        // 'responses' | 'chat' | null（Codex 专用）
 *   sourceType,     // codex | claude-code | opencode | ccswitch | environment | env-file | json-file | toml-file
 *   sourcePath,     // 配置文件路径
 *   confidence
 * }
 */
function normalizeCandidate(raw) {
  const c = createCandidate();
  if (!raw) return c;

  // baseUrl 归一化（§16/§15 避免 /v1/v1）
  if (raw.baseUrl) {
    c.baseUrl = normalizeBaseUrl(raw.baseUrl);
  }

  // wireApi → protocolHint（§12）
  // responses → openai-responses，chat → openai
  if (raw.protocolHint) {
    c.protocolHint = raw.protocolHint;
  } else if (raw.wireApi === 'responses') {
    c.protocolHint = 'openai-responses';
  } else if (raw.wireApi === 'chat') {
    c.protocolHint = 'openai';
  }

  // 通过 preset 推测 providerHint 和兜底 protocolHint
  if (c.baseUrl) {
    const preset = detectPreset(c.baseUrl, raw.providerHint);
    if (preset) {
      if (!c.providerHint) c.providerHint = preset.id;
      // §17：第三方网关不强制定 provider=Anthropic Official
      // detectPreset 已按 hostname 推测，保留其结果
    }
  }
  if (raw.providerHint && !c.providerHint) {
    c.providerHint = raw.providerHint;
  }

  c.apiKey = raw.apiKey || null;
  c.defaultModel = raw.defaultModel || null;
  c.models = Array.isArray(raw.models) ? raw.models.slice() : [];
  c.headers = (raw.headers && typeof raw.headers === 'object') ? { ...raw.headers } : {};
  c.notes = raw.notes || null;

  // name：优先 raw.name，其次 suggestName(baseUrl)，最后 null（GUI 兜底）
  c.name = raw.name || (c.baseUrl ? suggestName(c.baseUrl) : null);

  // source 元数据
  const importSource = sourceTypeToImportSource(raw.sourceType);
  c.source.type = importSource;          // 'codex' / 'claude-code' / ...
  c.source.parser = raw.sourceType;      // 保留原始 sourceType 作为 parser 标识
  c.source.confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.8;
  c.source.rawLength = raw.rawLength || 0;
  // v2.5.0 新增：sourcePath（仅供 audit / diagnostic，不持久化原文）
  c.source.path = raw.sourcePath || null;

  // 保留 _missingSecret 标记（§36：env_key 未设置时供 GUI 提示手动补 key）
  if (raw._missingSecret) c._missingSecret = raw._missingSecret;

  return c;
}

/**
 * 合并 Importer 输出为 ExternalSource.candidates。
 * 过滤掉完全 INVALID 的候选（连 baseUrl 都没有）。
 */
function toCandidates(rawList, sourceType, sourcePath) {
  return (rawList || [])
    .map(raw => normalizeCandidate({ ...raw, sourceType, sourcePath }))
    .filter(c => c.baseUrl || c.apiKey || (c.models && c.models.length));
}

module.exports = {
  normalizeCandidate,
  toCandidates
};
