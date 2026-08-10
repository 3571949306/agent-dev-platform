'use strict';
/**
 * WorkspacePathGuard — strict containment of file tools inside a project root.
 *
 * v2.8.2：内部委托统一 PathSecurity（canonical containment），保持旧接口不变。
 * terminal.js / search.js 等仍 require 本模块的调用方自动获得 canonical 安全
 * （§60/§119 Native tools 统一 PathSecurity），无需逐个改造。
 *
 * 返回值仍为 lexical absolute path（path.resolve，兼容旧行为）；canonical 验证
 * 由 PathSecurity.checkPathContainment 完成（fail-closed）。projectRoot 无效
 * （不存在）时回退 lexical（兼容旧锁 key 等场景）。
 */
const fs = require('fs');
const path = require('path');
const pathSecurity = require('./pathSecurity');
const { PathSecurityError, CODE } = pathSecurity;

class PathGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.retryable = false;
  }
}

function normalizeRoot(root) {
  return path.resolve(root);
}

/**
 * Resolve a user-supplied path against the workspace root.
 * v2.8.2：内部用 PathSecurity.checkPathContainment 做 canonical 验证（§5 修复）。
 * @returns absolute normalized path guaranteed to be inside root (canonical-verified).
 * @throws PathGuardError if it escapes (PATH_OUTSIDE_WORKSPACE) or is invalid.
 */
function guard(root, inputPath) {
  const base = normalizeRoot(root);
  if (!inputPath) throw new PathGuardError('INVALID_PATH', '路径不能为空');
  const abs = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);

  // v2.8.2: canonical containment（PathSecurity，§5 修复 lexical 不足）
  try {
    const r = pathSecurity.checkPathContainment(root, inputPath);
    if (!r.allowed) {
      throw new PathGuardError('PATH_OUTSIDE_WORKSPACE', `路径「${inputPath}」超出工作区范围（${base}）`);
    }
    return abs;
  } catch (e) {
    if (e instanceof PathGuardError) throw e;
    // ROOT_INVALID（projectRoot 不存在/无效）→ fallback lexical（兼容旧行为）
    const rel = path.relative(base, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathGuardError('PATH_OUTSIDE_WORKSPACE', `路径「${inputPath}」超出工作区范围（${base}）`);
    }
    return abs;
  }
}

/**
 * For existing paths, verify no symlink component escapes the root.
 * v2.8.2：PathSecurity.checkPathContainment 已含 canonical symlink/junction 检测，
 * 本函数委托之；ROOT_INVALID 时回退旧向上遍历逻辑。
 */
function verifyNoSymlinkEscape(root, absPath) {
  const base = normalizeRoot(root);
  try {
    const r = pathSecurity.checkPathContainment(root, absPath);
    if (!r.allowed && (r.viaReparsePoint || r.errorCode === CODE.REPARSE_ESCAPE)) {
      throw new PathGuardError('SYMLINK_ESCAPE', `符号链接 / junction「${absPath}」指向工作区之外`);
    }
    return true;
  } catch (e) {
    if (e instanceof PathGuardError) throw e;
    // ROOT_INVALID → 旧逻辑（向上遍历检查 symlink）
    let cur = absPath;
    const parts = [];
    while (true) {
      try {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) {
          const real = fs.realpathSync(cur);
          const rrel = path.relative(base, real);
          if (rrel.startsWith('..') || path.isAbsolute(rrel)) {
            throw new PathGuardError('SYMLINK_ESCAPE', `符号链接「${cur}」指向工作区之外（${real}）`);
          }
        }
        break;
      } catch (err) {
        if (err instanceof PathGuardError) throw err;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    return true;
  }
}

/** Check if target is inside root (stringwise, no existence required). */
function isInside(root, target) {
  const base = normalizeRoot(root);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { guard, verifyNoSymlinkEscape, isInside, normalizeRoot, PathGuardError };
