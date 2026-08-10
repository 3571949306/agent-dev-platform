'use strict';
/**
 * PathSecurity — Canonical Path Security 单一真相源入口。
 *
 * v2.8.2 §12/§28/§102-104：
 *   - filesystem-aware 层（canonicalPath）+ containment 判断层（pathContainment）。
 *   - ProjectMutationLock / PermissionRiskClassifier / ToolGateway / External Agents
 *     均应使用本模块，不得各自实现 containment（§12 单一真相源）。
 *
 * 性能（§102-104）：
 *   - canonicalRoot 可在 Run 生命周期缓存（projectRoot 稳定）。
 *   - target path 不缓存：每次 mutation 操作执行前 fresh canonicalization（§104，
 *     否则 TOCTOU recheck 失效）。
 *
 * 用法：
 *   const { createPathSecurity } = require('./pathSecurity');
 *   const ps = createPathSecurity({ cacheRoots: true });
 *   const r = ps.checkPathContainment(projectRoot, targetPath);
 *   if (!r.allowed) { /* deny (§51) *\/ }
 *   // execution-time recheck（§66）:
 *   ps.assertPathInside(projectRoot, targetPath);
 */

const {
  CODE,
  PathSecurityError,
  isWin,
  stripLongPrefix,
  normalizeForCompare,
  isInsideCanonical,
  realpathSafe,
  canonicalizeRoot,
  canonicalizeExistingPath,
  canonicalizeTargetPath,
  canonicalizeNonExistent
} = require('./canonicalPath');

const {
  checkPathContainment,
  assertPathInside,
  lexicalInside
} = require('./pathContainment');

/**
 * 创建 PathSecurity 实例。
 * @param {object} [options]
 * @param {boolean} [options.cacheRoots=false]  启用 canonicalRoot 缓存（Run 生命周期内）。
 *        target path 永不缓存（§104）。
 * @returns {object} PathSecurity 实例
 */
function createPathSecurity(options) {
  const opts = options || {};
  const rootCache = opts.cacheRoots ? new Map() : null;

  /** 带缓存的 canonicalizeRoot。 */
  function cachedCanonicalizeRoot(root) {
    if (!rootCache) return canonicalizeRoot(root);
    const hit = rootCache.get(root);
    if (hit !== undefined) return hit;
    const r = canonicalizeRoot(root);
    rootCache.set(root, r);
    return r;
  }

  return {
    // 原语
    canonicalizeRoot: cachedCanonicalizeRoot,
    canonicalizeExistingPath,
    canonicalizeTargetPath,
    canonicalizeNonExistent,
    normalizeForCompare,
    isInsideCanonical,
    realpathSafe,
    // containment 判断（注入 cached root canonicalizer）
    checkPathContainment: (root, target) => checkPathContainment(root, target, cachedCanonicalizeRoot),
    assertPathInside: (root, target) => assertPathInside(root, target, cachedCanonicalizeRoot),
    lexicalInside,
    // 缓存管理
    clearRootCache: () => { if (rootCache) rootCache.clear(); },
    hasRootCache: () => rootCache !== null
  };
}

/** 默认实例（无 root cache，适合无状态调用）。 */
const defaultPathSecurity = createPathSecurity({ cacheRoots: false });

module.exports = {
  // 工厂
  createPathSecurity,
  // 默认实例
  ...defaultPathSecurity,
  // 常量与类型（始终直接导出，不绑定实例）
  CODE,
  PathSecurityError,
  isWin,
  stripLongPrefix
};
