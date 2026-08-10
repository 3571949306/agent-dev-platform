'use strict';
/**
 * PathContainment — 路径 containment 判断（基于 CanonicalPath 原语）。
 *
 * v2.8.2 §25/§30-32：返回结构化 PathContainmentResult，含 lexical 与 canonical
 * 双层信号，供 PermissionRiskClassifier 等策略层决策。
 *
 * 双层信号（§31）：
 *   lexicalOutside  = true  → 立即 HIGH（字符串层已逃逸，如 ../）
 *   canonicalOutside = true  → 立即 HIGH（真实文件系统逃逸）
 *   lexicalInside + canonicalOutside → REPARSE_ESCAPE（路径经 reparse point 逃逸）
 *
 * 结果结构（§25）：
 *   { allowed, root, target, canonicalRoot, canonicalTarget,
 *     deepestExistingAncestor, viaReparsePoint, targetExists,
 *     lexicalInside, canonicalInside, reason, errorCode }
 */

const path = require('path');
const {
  CODE,
  PathSecurityError,
  normalizeForCompare,
  isInsideCanonical,
  canonicalizeRoot,
  canonicalizeTargetPath
} = require('./canonicalPath');

/**
 * Lexical containment：纯字符串 path.resolve + path.relative（§5 旧逻辑，
 * 此处仅作快速信号，不作最终安全决策）。
 * @returns {boolean}
 */
function lexicalInside(root, target) {
  if (!root || !target) return true; // 无 root 时无法判断，宽松返回 true 由上层决定
  const base = path.resolve(root);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 计算 PathContainmentResult。
 *
 * @param {string} root                projectRoot（lexical）
 * @param {string} target             目标路径（lexical）
 * @param {function} [rootCanonicalizer]  可选的 canonicalizeRoot（用于 root cache 注入）
 * @returns {PathContainmentResult}
 */
function checkPathContainment(root, target, rootCanonicalizer) {
  const canonicalizeRootFn = typeof rootCanonicalizer === 'function' ? rootCanonicalizer : canonicalizeRoot;

  // 1. canonicalizeRoot（§14）—— 失败 fail-closed
  let canonicalRoot = null;
  let lexicalIn = true;
  try {
    canonicalRoot = canonicalizeRootFn(root);
    // lexical 信号基于 canonicalRoot（避免 root 大小写差异干扰）
    lexicalIn = lexicalInside(canonicalRoot, target);
  } catch (e) {
    const code = (e && e.code) || CODE.ROOT_INVALID;
    return {
      allowed: false,
      root: root || null,
      target: target || null,
      canonicalRoot: null,
      canonicalTarget: null,
      deepestExistingAncestor: null,
      viaReparsePoint: false,
      targetExists: false,
      lexicalInside: true,
      canonicalInside: false,
      reason: e && e.message ? e.message : String(e),
      errorCode: code
    };
  }

  // 2. target lexical resolve（基于 canonicalRoot）
  const targetAbs = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(canonicalRoot, target);

  // 3. canonicalizeTargetPath（§19-22）—— 失败 fail-closed
  let canonResult;
  try {
    canonResult = canonicalizeTargetPath(targetAbs);
  } catch (e) {
    if (e instanceof PathSecurityError) {
      return {
        allowed: false,
        root: root || null,
        target: target || null,
        canonicalRoot,
        canonicalTarget: null,
        deepestExistingAncestor: null,
        viaReparsePoint: false,
        targetExists: false,
        lexicalInside: lexicalIn,
        canonicalInside: false,
        reason: e.message,
        errorCode: e.code
      };
    }
    // 未知异常 → fail-closed
    return {
      allowed: false,
      root: root || null,
      target: target || null,
      canonicalRoot,
      canonicalTarget: null,
      deepestExistingAncestor: null,
      viaReparsePoint: false,
      targetExists: false,
      lexicalInside: lexicalIn,
      canonicalInside: false,
      reason: `canonicalization 未知错误: ${(e && e.message) || String(e)}`,
      errorCode: CODE.CANONICALIZATION_FAILED
    };
  }

  const canonicalTarget = canonResult.canonicalPath;
  const canonicalIn = isInsideCanonical(canonicalRoot, canonicalTarget);

  // 4. 决策（§31）
  if (canonicalIn) {
    // 在 root 内 → allowed（含 inside→inside symlink，§38）
    return {
      allowed: true,
      root: root || null,
      target: target || null,
      canonicalRoot,
      canonicalTarget,
      deepestExistingAncestor: canonResult.deepestExistingAncestor || null,
      viaReparsePoint: canonResult.viaReparsePoint,
      targetExists: canonResult.targetExists,
      lexicalInside: lexicalIn,
      canonicalInside: true,
      reason: '目标在项目根目录内',
      errorCode: null
    };
  }

  // canonical outside
  let errorCode;
  let reason;
  if (lexicalIn) {
    // §31: lexicalInside + canonicalOutside → REPARSE_ESCAPE
    errorCode = CODE.REPARSE_ESCAPE;
    reason = '路径经 Junction / Symlink / Reparse Point 逃逸到项目根目录之外';
  } else {
    errorCode = CODE.OUTSIDE_ROOT;
    reason = '目标在项目根目录之外';
  }

  return {
    allowed: false,
    root: root || null,
    target: target || null,
    canonicalRoot,
    canonicalTarget,
    deepestExistingAncestor: canonResult.deepestExistingAncestor || null,
    viaReparsePoint: canonResult.viaReparsePoint,
    targetExists: canonResult.targetExists,
    lexicalInside: lexicalIn,
    canonicalInside: false,
    reason,
    errorCode
  };
}

/**
 * 断言 target 在 root 内，否则抛 PathSecurityError。
 * 用于 execution-time recheck（§66）。
 *
 * @param {string} root
 * @param {string} target
 * @param {function} [rootCanonicalizer]
 * @returns {PathContainmentResult} allowed=true 时的完整结果
 * @throws {PathSecurityError} 任何 allowed=false 情形
 */
function assertPathInside(root, target, rootCanonicalizer) {
  const r = checkPathContainment(root, target, rootCanonicalizer);
  if (!r.allowed) {
    throw new PathSecurityError(r.errorCode || CODE.OUTSIDE_ROOT,
      r.reason || '路径不在项目根目录内', {
        canonicalRoot: r.canonicalRoot,
        canonicalTarget: r.canonicalTarget,
        viaReparsePoint: r.viaReparsePoint
      });
  }
  return r;
}

module.exports = {
  checkPathContainment,
  assertPathInside,
  lexicalInside
};
