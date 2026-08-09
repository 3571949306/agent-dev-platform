'use strict';
/**
 * v2.5.0 External Config Import — Importer Registry。
 *
 * §60/§61：每个外部软件独立 Importer，通过 Registry 统一注册。
 * GUI 从 Registry 获取可用 source 列表，按需调用 discover/parse。
 *
 * 每个 Importer 必须实现：
 *   id           — 唯一标识（codex|claude-code|opencode|ccswitch|environment|env-file|json-file|toml-file）
 *   name         — 用户可见名称
 *   description  — 简短描述
 *   supportedPlatforms — ['win32', 'darwin', 'linux']
 *   discover()   — 检查本机是否安装并返回 ExternalSource（candidates 为空数组）
 *   parse(source, opts) — 解析 source 为 ImportCandidate[]（opts: { env? }）
 */

const { createExternalSource } = require('./externalSource');

const REGISTRY = [];

function register(imp) {
  if (!imp || !imp.id) throw new Error('Importer 必须有 id');
  const existing = REGISTRY.findIndex(i => i.id === imp.id);
  if (existing >= 0) REGISTRY[existing] = imp;
  else REGISTRY.push(imp);
}

function listImporters() {
  return REGISTRY.filter(imp => {
    if (!Array.isArray(imp.supportedPlatforms)) return true;
    return imp.supportedPlatforms.includes(process.platform);
  });
}

function getImporter(id) {
  return REGISTRY.find(i => i.id === id) || null;
}

/** §60：列出可用 source（GUI 用此渲染按钮）。 */
function listSources() {
  return listImporters().map(imp => ({
    id: imp.id,
    name: imp.name,
    description: imp.description || '',
    requiresFile: imp.requiresFile || false,
    supportsDiscovery: typeof imp.discover === 'function'
  }));
}

/**
 * §61：discover(sourceType) — 调用 Importer.discover() 检查本机配置。
 * 不解析 candidates，只返回 source 元数据。
 */
function discover(sourceType) {
  const imp = getImporter(sourceType);
  if (!imp || typeof imp.discover !== 'function') {
    return createExternalSource(sourceType);
  }
  return imp.discover();
}

/**
 * §61：parse(sourceType, opts) — 调用 Importer.parse() 解析为 candidates。
 * opts: { filePath?, env?, userSelected? }
 */
function parseSource(sourceType, opts = {}) {
  const imp = getImporter(sourceType);
  if (!imp || typeof imp.parse !== 'function') {
    throw new Error(`未注册的 importer: ${sourceType}`);
  }
  return imp.parse(opts);
}

/**
 * §61：批量 discover 所有已注册 importer（GUI 一次性显示「本机发现 N 个工具」）。
 * 不抛错，单个 importer 失败不影响其他。
 */
function discoverAll() {
  const results = [];
  for (const imp of listImporters()) {
    if (typeof imp.discover !== 'function') continue;
    try {
      const src = imp.discover();
      results.push(src);
    } catch (e) {
      const src = createExternalSource(imp.id);
      src.sourceName = imp.name;
      src.errors.push(e.message || String(e));
      results.push(src);
    }
  }
  return results;
}

module.exports = {
  register,
  listImporters,
  getImporter,
  listSources,
  discover,
  parseSource,
  discoverAll,
  _REGISTRY: REGISTRY
};
