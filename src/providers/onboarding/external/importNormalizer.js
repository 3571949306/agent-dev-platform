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
const { classifyCredentialValue, classifyAuthorizationHeader } = require('./security/credentialClassifier');
const { sanitizeObject, validateUrlScheme } = require('./security/inputSanitizer');

/**
 * 把外部 Importer 提取的原始字段构造为 ImportCandidate。
 *
 * v2.5.1 §25/§26：Hostile Input 防御
 *   - headers / models 经过 sanitizeObject 过滤 prototype pollution 字段
 *   - baseUrl 经过 validateUrlScheme 白名单校验（仅 http/https）
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

  // v2.5.1 §26：baseUrl 协议白名单校验（仅 http/https）
  if (raw.baseUrl) {
    const schemeCheck = validateUrlScheme(raw.baseUrl);
    if (!schemeCheck.ok) {
      // 非法协议：不写入 baseUrl，标记为无效（GUI 显示原因）
      c._invalidBaseUrl = schemeCheck.reason || 'baseUrl 协议非法';
    } else {
      c.baseUrl = normalizeBaseUrl(raw.baseUrl);
    }
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
  // v2.5.1 §25：models / headers 经过 sanitizeObject 过滤 prototype pollution 字段
  c.models = Array.isArray(raw.models) ? sanitizeObject(raw.models.slice()) : [];
  c.headers = (raw.headers && typeof raw.headers === 'object') ? sanitizeObject(raw.headers) : {};
  c.notes = raw.notes || null;

  // v2.5.1 §3-§7：值级凭据分类 —— 即使字段名是 apiKey，值可能是 JWT/OAuth/Session
  // 不可迁移的值标记为 _unsupportedCredential，GUI 显示提示且不导入
  if (c.apiKey) {
    const cls = classifyCredentialValue(c.apiKey, { fieldName: 'api_key' });
    if (!cls.allowed) {
      c._unsupportedCredential = {
        reason: cls.classification === 'jwt_unknown'
          ? '检测到疑似登录 / OAuth Token，该凭据不会自动迁移。如这是服务商提供的正式 API Key，请手动填写。'
          : `检测到不可迁移凭据类型：${cls.classification}。仅支持普通 API Key，不迁移 OAuth/Session/会员凭据。`,
        classification: cls.classification
      };
      // 丢弃明文 apiKey，不保留到内存
      c.apiKey = null;
    }
  }

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
