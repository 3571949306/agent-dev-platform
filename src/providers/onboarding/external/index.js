'use strict';
/**
 * v2.5.0 External Config Import — 模块入口。
 *
 * §1：外部配置 → External Config Importer → ImportCandidate → Normalize
 *      → Security Preview → Probe → Connection → 现有 Provider Runtime。
 *
 * 对外暴露：
 *   - listSources()                      → GUI 渲染按钮
 *   - discover(sourceType)               → 检查本机是否安装
 *   - discoverAll()                      → 批量 discover
 *   - parseSource(sourceType, opts)      → 解析为 candidates
 *   - resolveConflicts(candidates, list) → 冲突检测
 *   - importBatch(candidates, ctx)       → 批量导入
 *
 * §61 IPC 通道（由 handlers.js 注册）：
 *   externalImport:listSources
 *   externalImport:discover
 *   externalImport:discoverAll
 *   externalImport:parse
 *   externalImport:resolveConflicts
 *   externalImport:importBatch
 *   externalImport:readFile（用户手动选择文件）
 */

const registry = require('./registry');
const { resolveConflict, resolveBatchConflicts, compareSecrets } = require('./conflictResolver');
const { normalizeCandidate, toCandidates } = require('./importNormalizer');
const {
  createExternalSource,
  IMPORT_SOURCE_VALUES,
  sourceTypeToImportSource
} = require('./externalSource');

// 注册所有 Importer（§60）
const codexImporter = require('./importers/codex');
const claudeCodeImporter = require('./importers/claudeCode');
const openCodeImporter = require('./importers/openCode');
const ccSwitchLocalImporter = require('./importers/ccSwitchLocal');
const environmentImporter = require('./importers/environment');
const envFileImporter = require('./importers/envFile');
const jsonFileImporter = require('./importers/jsonFile');
const tomlFileImporter = require('./importers/tomlFile');

registry.register(codexImporter);
registry.register(claudeCodeImporter);
registry.register(openCodeImporter);
registry.register(ccSwitchLocalImporter);
registry.register(environmentImporter);
registry.register(envFileImporter);
registry.register(jsonFileImporter);
registry.register(tomlFileImporter);

/**
 * §42/§43：批量导入。
 * 每个 candidate 独立处理，一个失败不影响其他。
 *
 * @param {Array} items [{ candidate, action: 'import'|'skip'|'overwrite', manualKey? }]
 * @param {object} ctx { store, sec, onProgress?, maxConcurrency? }
 * @returns {Array} [{ candidate, result: { ok, connection?, error? }, action }]
 */
async function importBatch(items, ctx = {}) {
  const { store, sec } = ctx;
  if (!store || !sec) throw new Error('importBatch 需要 store + sec 上下文');

  const maxConcurrency = Math.min(Math.max(ctx.maxConcurrency || 3, 1), 5);  // §45: 2~3 默认
  const { importCandidate } = require('../index');

  const results = [];
  const queue = items.slice();
  const running = [];

  async function runOne(item) {
    const { candidate, action } = item;
    if (action === 'skip') {
      return { candidate, result: { ok: true, skipped: true }, action };
    }
    try {
      // §36：手动补 key
      if (item.manualKey && !candidate.apiKey) {
        candidate.apiKey = item.manualKey;
      }
      const opts = {
        store,
        sec,
        forceOverwrite: action === 'overwrite',
        assignToMain: false  // §48 不自动分配，单独 step
      };
      const r = importCandidate(candidate, opts);
      return {
        candidate,
        result: { ok: true, connection: r.connection, duplicate: r.duplicate },
        action
      };
    } catch (e) {
      return { candidate, result: { ok: false, error: e.message }, action };
    }
  }

  // 简单的并发池
  while (queue.length || running.length) {
    while (running.length < maxConcurrency && queue.length) {
      const item = queue.shift();
      const p = runOne(item).then(r => {
        running.splice(running.indexOf(p), 1);
        return r;
      });
      running.push(p);
      results.push(await p);
    }
    if (running.length) {
      await Promise.race(running);
    }
  }

  return results;
}

module.exports = {
  listSources: registry.listSources,
  discover: registry.discover,
  discoverAll: registry.discoverAll,
  parseSource: registry.parseSource,
  getImporter: registry.getImporter,
  resolveConflict,
  resolveBatchConflicts,
  compareSecrets,
  normalizeCandidate,
  toCandidates,
  createExternalSource,
  IMPORT_SOURCE_VALUES,
  sourceTypeToImportSource,
  importBatch
};
