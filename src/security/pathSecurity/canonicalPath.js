'use strict';
/**
 * CanonicalPath — 文件系统对象级别的路径规范化原语（单一真相源）。
 *
 * v2.8.2 Canonical Path Security Hardening（spec §5/§6/§12-26/§40-50/§74-77）。
 *
 * 解决核心问题：字符串路径看似在 projectRoot 内，但通过 Junction / Symlink /
 * Reparse Point 真实文件系统目标跳到项目外。lexical 判断（path.resolve +
 * path.relative）只能证明"字符串路径在 root 下"，不能证明"真实文件系统对象
 * 也在 root 下"。
 *
 * 本模块是 filesystem-aware 层（§28），只做规范化与判断，不含业务策略。
 * PermissionRiskClassifier 等策略层应基于本模块的结果决策。
 *
 * 上游依据（§7-10）：
 *   - Node.js fs.realpathSync.native() 调用 OS 原生 realpath / GetFinalPathNameByHandle，
 *     可靠解析 symlink / junction / reparse point 到真实路径。
 *   - 目标不存在时抛 ENOENT → 触发 deepest-existing-ancestor 算法（§20-22）。
 *   - Windows Symbolic Link 可指向不存在目标（broken symlink），此时 realpath
 *     失败 → 必须 fail-closed（§23/§50），禁止 fallback 回 lexical 判断。
 *   - Windows Reparse Point（Junction / Symbolic Link / Volume Mount Point）单路径
 *     最多 63 个。
 *
 * 错误码（§24）：
 *   PATH_ROOT_INVALID             projectRoot 不存在 / 不是目录 / realpath 失败
 *   PATH_CANONICALIZATION_FAILED   realpath 失败（非 ENOENT）或 broken symlink
 *   PATH_OUTSIDE_ROOT              canonical target 在 canonical root 之外
 *   PATH_REPARSE_ESCAPE            lexical 内但 canonical 外（reparse 逃逸）
 *   PATH_UNC_UNSUPPORTED            UNC 路径且策略不支持
 *   PATH_TAIL_ESCAPE                不存在 tail 含 .. 或最深祖先非目录
 */

const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const SEP = path.sep;

/** 错误码常量（§24）。 */
const CODE = Object.freeze({
  ROOT_INVALID: 'PATH_ROOT_INVALID',
  CANONICALIZATION_FAILED: 'PATH_CANONICALIZATION_FAILED',
  OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  REPARSE_ESCAPE: 'PATH_REPARSE_ESCAPE',
  UNC_UNSUPPORTED: 'PATH_UNC_UNSUPPORTED',
  TAIL_ESCAPE: 'PATH_TAIL_ESCAPE'
});

/**
 * 路径安全错误。fail-closed 语义：调用方捕获后应拒绝操作，不得回退到 lexical。
 */
class PathSecurityError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.retryable = false;
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (k !== 'code' && k !== 'message') this[k] = extra[k];
      }
    }
  }
}

/**
 * 剥离 Windows extended-length path 前缀（§18）。
 *   \\?\C:\a\b  → C:\a\b
 *   \\?\UNC\s\s\p → \\s\s\p
 * 以 Node realpath 返回的 canonical result 为准（§18）。
 */
function stripLongPrefix(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\')) {
    const rest = p.slice(4);
    if (rest.length >= 4 && rest.slice(0, 4).toLowerCase() === 'unc\\') {
      return '\\\\' + rest.slice(4);
    }
    return rest;
  }
  return p;
}

/**
 * 为 containment 比较归一化路径：
 *   - strip extended-length 前缀（§18）；
 *   - Windows case-insensitive：稳定 toLowerCase（§15，非 localeLowerCase）；
 *   - 去除尾部 separator（§16，避免 D:\proj\ 与 D:\proj 误判）。
 */
function normalizeForCompare(p) {
  if (!p || typeof p !== 'string') return p;
  let n = stripLongPrefix(p);
  if (isWin) n = n.toLowerCase();
  // 去除尾部 separator（保留 root 的，如 D:\ 或 /）
  // Windows 同时处理 \ 和 /
  n = n.replace(/[\\/]+$/, '');
  if (n === '') n = p.replace(/[\\/]+$/, ''); // 防止 root 被清空
  // Windows 单字母 root 如 d: 保留
  if (isWin && /^[a-z]:$/.test(n)) n = n + '\\';
  return n;
}

/**
 * 判断 canonicalChild 是否在 canonicalParent 内（含 parent 自身）。
 * prefix-collision-safe（§45）：D:\project 不会误判 D:\project-old 为内部。
 * case-insensitive（Windows，§46）。
 * @returns boolean
 */
function isInsideCanonical(canonicalParent, canonicalChild) {
  if (!canonicalParent || !canonicalChild) return false;
  const a = normalizeForCompare(canonicalParent);
  const b = normalizeForCompare(canonicalChild);
  if (!a || !b) return false;
  if (a === b) return true;
  // b 必须以 a + separator 开头（Windows 同时接受 / 与 \）
  if (isWin) {
    return b.startsWith(a + '\\') || b.startsWith(a + '/');
  }
  return b.startsWith(a + SEP);
}

/**
 * 安全 realpath：返回 canonical 路径或 null（不抛）。仅供锁 key 等非安全
 * enforcement 场景使用（如 ProjectMutationLock 对尚未 clone 的 root）。
 * 安全边界判断必须用 canonicalizeRoot / canonicalizeExistingPath（fail-closed）。
 */
function realpathSafe(p) {
  if (!p) return null;
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Canonicalize projectRoot（§14）。
 *   1. statSync（跟随 symlink/junction）确认存在且为目录；
 *   2. realpathSync.native 解析到真实路径（§39：root 本身是 junction 时
 *      canonicalize 到真实 root，不拒绝）；
 *   3. 任何失败 → PATH_ROOT_INVALID fail-closed（不 fallback 到 path.resolve，
 *      修正 ProjectMutationLock.canonical 的 §23 违规）。
 * @param {string} projectRoot
 * @returns {string} canonicalRoot
 */
function canonicalizeRoot(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new PathSecurityError(CODE.ROOT_INVALID, 'projectRoot 为空或非字符串');
  }
  let st;
  try {
    // statSync 跟随 symlink：root 若为 junction 指向真实目录，stat 成功且 isDirectory
    st = fs.statSync(projectRoot);
  } catch (e) {
    throw new PathSecurityError(CODE.ROOT_INVALID,
      `projectRoot 不存在或不可访问: ${e.message}`, { cause: e.code });
  }
  if (!st.isDirectory()) {
    throw new PathSecurityError(CODE.ROOT_INVALID, 'projectRoot 不是目录');
  }
  let real;
  try {
    real = fs.realpathSync.native(projectRoot);
  } catch (e) {
    throw new PathSecurityError(CODE.ROOT_INVALID,
      `projectRoot realpath 失败: ${e.message}`, { cause: e.code });
  }
  return real;
}

/**
 * Canonicalize 已存在的目标路径（§19）。
 * 目标存在（lstat 成功）→ realpathSync.native 解析到真实路径。
 * Broken symlink（lstat 成功但 realpath ENOENT）→ CANONICALIZATION_FAILED（§50）。
 * 其他 realpath 错误（EACCES/EPERM/ELOOP）→ CANONICALIZATION_FAILED（§23 fail-closed）。
 *
 * @returns {{ canonicalPath: string, targetExists: true, viaReparsePoint: boolean,
 *            deepestExistingAncestor: string }}
 * @throws {PathSecurityError} canonicalization 失败
 */
function canonicalizeExistingPath(target) {
  const targetAbs = path.resolve(target);
  // lstat 不跟随 symlink：检测目标本身是否为 reparse point
  let lstat;
  try {
    lstat = fs.lstatSync(targetAbs);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
        `目标不存在: ${targetAbs}`, { cause: 'ENOENT', targetExists: false });
    }
    throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
      `lstat 失败: ${e.message}`, { cause: e.code });
  }
  let real;
  try {
    real = fs.realpathSync.native(targetAbs);
  } catch (e) {
    // broken symlink：lstat 成功但 realpath 失败（目标不存在）→ fail-closed（§50）
    throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
      `realpath 失败（可能为断链 symlink）: ${e.message}`,
      { cause: e.code, brokenSymlink: e.code === 'ENOENT' });
  }
  const viaReparse = normalizeForCompare(real) !== normalizeForCompare(targetAbs);
  return {
    canonicalPath: real,
    targetExists: true,
    viaReparsePoint: viaReparse,
    deepestExistingAncestor: targetAbs
  };
}

/**
 * Canonicalize 可能不存在的目标路径（§20-22/§40-42）。
 *
 * 算法（§21）：
 *   targetAbsolute
 *     ↓ 不断 dirname() 找到 deepestExistingAncestor（lstat 成功）
 *     ↓ realpathSync.native(deepestExistingAncestor) → canonicalExistingAncestor
 *     ↓ 保存不存在的 tail segments
 *     ↓ 把 tail lexical append 到 canonicalExistingAncestor
 *     ↓ 得到 predictedCanonicalTarget
 *
 * 规则：
 *   - target 存在 → 直接 realpath（含 broken symlink 检测）
 *   - target 不存在（lstat ENOENT）→ deepest-existing-ancestor
 *   - 最深祖先必须是目录（§77：是文件但有 tail → TAIL_ESCAPE）
 *   - tail 不得含 ..（§76 invariant）
 *   - 祖先 realpath 失败（如祖先本身是 broken symlink）→ CANONICALIZATION_FAILED（§23）
 *   - 到 volume root 仍找不到祖先 → CANONICALIZATION_FAILED（§75）
 *
 * @returns {{ canonicalPath: string, targetExists: boolean, viaReparsePoint: boolean,
 *            deepestExistingAncestor: string, canonicalAncestor: string|null, tail: string[] }}
 * @throws {PathSecurityError}
 */
function canonicalizeTargetPath(target) {
  const targetAbs = path.resolve(target);

  // 先探测 target 是否存在
  let lstat;
  try {
    lstat = fs.lstatSync(targetAbs);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
        `lstat 失败: ${e.message}`, { cause: e.code });
    }
    // ENOENT → 进入 deepest-existing-ancestor 算法
    return canonicalizeNonExistent(targetAbs);
  }

  // target 存在（文件/目录/symlink/junction）→ realpath 解析
  let real;
  try {
    real = fs.realpathSync.native(targetAbs);
  } catch (e) {
    // broken symlink：lstat 成功但 realpath 失败 → fail-closed（§50）
    throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
      `realpath 失败（可能为断链 symlink）: ${e.message}`,
      { cause: e.code, brokenSymlink: e.code === 'ENOENT' });
  }
  const viaReparse = normalizeForCompare(real) !== normalizeForCompare(targetAbs);
  return {
    canonicalPath: real,
    targetExists: true,
    viaReparsePoint: viaReparse,
    deepestExistingAncestor: targetAbs,
    canonicalAncestor: real,
    tail: []
  };
}

/**
 * Deepest Existing Ancestor 算法（§21/§22/§75-77）。
 * 目标不存在时，找到最深的已存在祖先目录，realpath 它，再把不存在的 tail
 * 词汇拼接回去，得到 predicted canonical target。
 *
 * @param {string} targetAbs 已 path.resolve 的绝对路径
 * @returns {{ canonicalPath, targetExists:false, viaReparsePoint, deepestExistingAncestor, canonicalAncestor, tail }}
 * @throws {PathSecurityError}
 */
function canonicalizeNonExistent(targetAbs) {
  const tail = [];
  let cur = targetAbs;
  // §75: 停止条件 dirname(path) === path（到 volume root）
  while (true) {
    try {
      // lstat：仅探测 cur 是否存在（不跟随 reparse point；存在性判断）。
      // cur 是否为目录由下方 realpath 后的 statSync(realAncestor) 决定，
      // 因为 lstatSync(junction).isDirectory() 在 Windows 上返回 false。
      fs.lstatSync(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
          `lstat 失败: ${e.message}`, { cause: e.code });
      }
      // cur 不存在，向上走
      const parent = path.dirname(cur);
      if (parent === cur) {
        // §75: 到 volume root 仍找不到已存在祖先
        throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
          `无法找到已存在祖先: ${targetAbs}`);
      }
      // 把 cur 的最后一段加入 tail 头部
      tail.unshift(path.basename(cur));
      cur = parent;
      continue;
    }

    // cur 存在（文件/目录/symlink/junction/reparse point）。
    // 先 realpath 解析 reparse point（junction/symlink）到真实目标。
    let realAncestor;
    try {
      realAncestor = fs.realpathSync.native(cur);
    } catch (e) {
      // 祖先是 broken symlink 等 → fail-closed（§23/§50）
      throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
        `祖先 realpath 失败: ${e.message}`,
        { cause: e.code, brokenSymlink: e.code === 'ENOENT' });
    }

    // §77: 如果还有 tail，最深祖先必须是目录。
    // 注意：Windows 上 lstatSync(junction).isDirectory() 返回 false（reparse point
    // 不设目录位），必须用 realpath 后的真实目标 statSync 判断，否则目录-junction
    // 会被误判为文件导致 TAIL_ESCAPE。
    if (tail.length > 0) {
      let realStat;
      try {
        realStat = fs.statSync(realAncestor);
      } catch (e) {
        throw new PathSecurityError(CODE.CANONICALIZATION_FAILED,
          `祖先真实目标 stat 失败: ${e.message}`, { cause: e.code });
      }
      if (!realStat.isDirectory()) {
        throw new PathSecurityError(CODE.TAIL_ESCAPE,
          `最深已存在祖先是文件而非目录: ${realAncestor}`);
      }
    }

    // §76: tail 不得含 .. （invariant；path.resolve 已解析 ..，此处双重防御）
    if (tail.some((seg) => seg === '..')) {
      throw new PathSecurityError(CODE.TAIL_ESCAPE,
        `不存在 tail 含 .. 逃逸段: ${tail.join(SEP)}`);
    }

    const viaReparse = normalizeForCompare(realAncestor) !== normalizeForCompare(cur);
    // 把 tail 词汇拼接（path.join 会用正确 separator）
    const predicted = tail.length === 0 ? realAncestor : path.join(realAncestor, ...tail);
    return {
      canonicalPath: predicted,
      targetExists: false,
      viaReparsePoint: viaReparse,
      deepestExistingAncestor: cur,
      canonicalAncestor: realAncestor,
      tail
    };
  }
}

module.exports = {
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
};
