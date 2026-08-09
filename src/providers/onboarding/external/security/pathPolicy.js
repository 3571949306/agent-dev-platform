'use strict';
/**
 * v2.5.0/v2.5.1 External Config Import — Path Security Policy。
 *
 * §55/§56：External Importer 读取任何外部配置前必须经过 pathPolicy 验证。
 * §58：Windows 优先，跨平台路径用 os.homedir() 不硬编码 Administrator。
 * §59：禁止硬编码 C:\Users\Administrator\，必须用 os.homedir() / app.getPath('home')。
 *
 * v2.5.1 §9/§10/§11：Canonical Path 验证 + symlink/junction escape 防御。
 *   - fs.realpathSync.native() 解析符号链接 / Windows Junction 到真实路径
 *   - canonical containment check：realpath(target) 必须在 realpath(allowedDir) 内
 *   - 用户主动选择文件仍需：canonical realpath + regular file + 扩展名白名单 + 大小限制
 *
 * 只允许两类路径：
 *   1. 明确支持的外部工具配置目录（known locations，在 REGISTRY 中声明）
 *   2. 用户主动通过 dialog.showOpenDialog 选择的文件（userSelected=true 标记）
 *
 * §9/§56：禁止递归扫描 C:\Users、禁止任意路径自动发现。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * 已知外部工具默认配置目录（相对 home / APPDATA / LOCALAPPDATA）。
 * 每项返回绝对路径（若环境变量缺失则跳过）。
 * §57：如果路径不存在，Importer 应允许用户手动选择配置文件。
 */
function knownLocations(sourceType) {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppdata = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  switch (sourceType) {
    case 'codex':
      // Codex CLI 公开配置目录 ~/.codex/
      return [path.join(home, '.codex')];
    case 'claude-code':
      // Claude Code 公开配置目录 ~/.claude/
      return [path.join(home, '.claude')];
    case 'opencode':
      // OpenCode 公开配置目录 ~/.opencode/ 或 %LOCALAPPDATA%\opencode\
      return [path.join(home, '.opencode'), path.join(localAppdata, 'opencode')];
    case 'ccswitch':
      // CC Switch 公开配置目录 %APPDATA%\cc-switch\
      return [path.join(appdata, 'cc-switch')];
    default:
      return [];
  }
}

/** v2.5.1 §11：用户主动选择文件的最大允许大小（5 MB）。 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** v2.5.1 §11：用户主动选择文件的扩展名白名单。 */
const USER_FILE_EXTENSIONS = new Set(['.env', '.json', '.toml']);

/**
 * v2.5.1 §9：Canonical Path 解析 —— fs.realpathSync.native() 解析 symlink/junction。
 * 如果路径不存在，返回 null（调用方自行处理）。
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
 * v2.5.1 §9/§10：Canonical containment check。
 * 用 realpath 解析 target 和 allowedDir 后比较，防止 symlink/junction 逃逸。
 */
function isWithinCanonical(target, dir) {
  const realTarget = realpathSafe(target);
  const realDir = realpathSafe(dir);
  if (!realTarget || !realDir) return false;
  const rel = path.relative(realDir, realTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * §55：路径策略校验。
 *
 * v2.5.1 §9/§10/§11：增强为 canonical realpath 验证 + symlink/junction escape 防御。
 *
 * @param {string} filePath 待读取文件绝对路径
 * @param {object} opts { sourceType, userSelected }
 *   - sourceType: codex|claude-code|opencode|ccswitch|null（文件导入用 null）
 *   - userSelected: boolean，true 表示用户通过 dialog 主动选择
 * @returns {object} { ok: boolean, reason?: string }
 */
function verifyPath(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, reason: '路径为空' };
  }
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // 用户主动选择的文件：仍需 canonical realpath + regular file + 扩展名白名单 + 大小限制（§11）
  if (opts.userSelected) {
    return verifyUserSelectedFile(abs);
  }

  // 自动发现：必须在已知配置目录内（§55/§56），且 canonical containment check（§9/§10）
  const sourceType = opts.sourceType;
  if (!sourceType) {
    return { ok: false, reason: '非用户选择文件必须指定 sourceType' };
  }
  const allowed = knownLocations(sourceType);
  for (const dir of allowed) {
    // v2.5.1 §9：先检查字符串路径（快速拒绝 ../ escape）
    if (!isWithin(abs, dir)) continue;
    // v2.5.1 §9/§10：再检查 canonical realpath（防 symlink/junction 逃逸）
    if (isWithinCanonical(abs, dir)) return { ok: true };
  }
  return {
    ok: false,
    reason: `路径 ${abs} 不在 ${sourceType} 已知配置目录内或含 symlink/junction 逃逸`
  };
}

/**
 * v2.5.1 §11：验证用户主动选择的文件。
 * 仍然允许读取任意用户明确选择的 .env/.json/.toml 文件，但需通过安全检查：
 *   - canonical realpath
 *   - 文件必须真实存在
 *   - 必须是 regular file（非目录 / 非设备文件）
 *   - 扩展名白名单
 *   - 限制合理最大文件大小（5 MB）
 */
function verifyUserSelectedFile(absPath) {
  // canonical realpath
  const real = realpathSafe(absPath);
  if (!real) {
    return { ok: false, reason: '文件不存在或路径无法解析（含断链 symlink）' };
  }

  // 必须是 regular file
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: '无法获取文件状态' };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: '路径不是普通文件（可能是目录或设备文件）' };
  }

  // 扩展名白名单
  const ext = path.extname(real).toLowerCase();
  if (!USER_FILE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `不支持的文件扩展名 "${ext}"，仅支持 .env / .json / .toml` };
  }

  // 文件大小限制
  if (stat.size > MAX_FILE_SIZE) {
    return { ok: false, reason: `文件过大（${Math.round(stat.size / 1024 / 1024)} MB），最大允许 ${MAX_FILE_SIZE / 1024 / 1024} MB` };
  }

  return { ok: true };
}

/** 判断 target 是否在 dir 内（含 dir 自身）。字符串路径比较（快速检查）。 */
function isWithin(target, dir) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 安全读取文件（先 verifyPath，再 fs.readFileSync）。
 * §53：本函数不输出文件内容到日志。
 */
function readFileSyncSafe(filePath, opts = {}) {
  const v = verifyPath(filePath, opts);
  if (!v.ok) {
    const err = new Error('PathPolicy 拒绝读取：' + v.reason);
    err.code = 'EPATH';
    throw err;
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** §57：检查已知配置路径是否存在并返回可读路径列表。 */
function discoverKnownConfigs(sourceType) {
  const dirs = knownLocations(sourceType);
  const results = [];
  for (const dir of dirs) {
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    // 列出 dir 下第一层配置文件（不递归，§56）
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) {
          results.push({
            path: full,
            name: entry,
            size: st.size,
            lastModified: st.mtimeMs
          });
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

module.exports = {
  knownLocations,
  verifyPath,
  verifyUserSelectedFile,
  isWithin,
  isWithinCanonical,
  realpathSafe,
  readFileSyncSafe,
  discoverKnownConfigs,
  MAX_FILE_SIZE,
  USER_FILE_EXTENSIONS
};
