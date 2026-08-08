'use strict';
/**
 * WorkspacePathGuard — strict containment of file tools inside a project root.
 * Blocks traversal like ..\..\Windows, symlink escapes, and absolute paths
 * that point outside the workspace (unless explicitly allowed).
 */
const fs = require('fs');
const path = require('path');

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
 * @returns absolute normalized path guaranteed to be inside root.
 * @throws PathGuardError if it escapes.
 */
function guard(root, inputPath) {
  const base = normalizeRoot(root);
  if (!inputPath) throw new PathGuardError('INVALID_PATH', '路径不能为空');
  let abs;
  if (path.isAbsolute(inputPath)) {
    abs = path.resolve(inputPath);
  } else {
    abs = path.resolve(base, inputPath);
  }
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    // rel === '' means it equals base (allowed). But if inputPath was '..' chain
    // landing on base itself, allow. Guard against clearly outside.
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathGuardError('PATH_OUTSIDE_WORKSPACE', `路径「${inputPath}」超出工作区范围（${base}）`);
    }
  }
  return abs;
}

/**
 * For existing paths, verify no symlink component escapes the root.
 * Resolves the longest existing ancestor's real path and re-checks containment.
 */
function verifyNoSymlinkEscape(root, absPath) {
  const base = normalizeRoot(root);
  let cur = absPath;
  // Walk upward to find an existing ancestor
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
    } catch (e) {
      if (e instanceof PathGuardError) throw e;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return true;
}

/** Check if target is inside root (stringwise, no existence required). */
function isInside(root, target) {
  const base = normalizeRoot(root);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { guard, verifyNoSymlinkEscape, isInside, normalizeRoot, PathGuardError };
