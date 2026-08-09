'use strict';
/**
 * v2.5.0 External Config Import — ExternalSource 统一结构。
 *
 * §5：所有发现结果先变成 ExternalSource，然后由 Importer 转成 ImportCandidate[]。
 * §6：Importer 不直接写数据库，最终输出 ImportCandidate 交给现有 onboarding 链路。
 *
 * ExternalSource 描述「在某外部工具发现了配置文件」，candidates 为空数组时表示
 * 已发现但尚未解析（GUI 调 externalImport:preview 时才填充 candidates）。
 */

/**
 * 创建空 ExternalSource。
 * @param {string} sourceType codex|claude-code|opencode|ccswitch|environment|env-file|json-file|toml-file
 */
function createExternalSource(sourceType) {
  return {
    sourceType,
    sourceName: null,            // 用户可见名称（Codex / Claude Code / ...）
    sourcePath: null,            // 配置文件或目录绝对路径
    exists: false,               // 是否在本机找到
    readable: false,             // 是否可读
    lastModified: 0,             // 配置文件 mtime（ms）
    configType: null,            // toml|json|env|sqlite|json-array
    candidates: [],              // ImportCandidate[]（解析后填充）
    warnings: [],                // 警告信息（如 unsupported credential）
    errors: []                   // 错误信息（如 parse failed）
  };
}

/** §49 import_source 枚举值（与 schema import_source 列对应）。 */
const IMPORT_SOURCE_VALUES = [
  'manual',
  'smart-paste',
  'codex',
  'claude-code',
  'opencode',
  'ccswitch',
  'ccswitch-local',
  'environment',
  'env-file',
  'json-file',
  'toml-file'
];

/** sourceType → import_source 映射。 */
function sourceTypeToImportSource(sourceType) {
  switch (sourceType) {
    case 'codex': return 'codex';
    case 'claude-code': return 'claude-code';
    case 'opencode': return 'opencode';
    case 'ccswitch': return 'ccswitch-local';
    case 'environment': return 'environment';
    case 'env-file': return 'env-file';
    case 'json-file': return 'json-file';
    case 'toml-file': return 'toml-file';
    default: return 'manual';
  }
}

module.exports = {
  createExternalSource,
  IMPORT_SOURCE_VALUES,
  sourceTypeToImportSource
};
