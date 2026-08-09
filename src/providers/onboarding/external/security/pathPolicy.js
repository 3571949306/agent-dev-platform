'use strict';
/**
 * v2.5.0 External Config Import — Path Security Policy。
 *
 * §55/§56：External Importer 读取任何外部配置前必须经过 pathPolicy 验证。
 * §58：Windows 优先，跨平台路径用 os.homedir() 不硬编码 Administrator。
 * §59：禁止硬编码 C:\Users\Administrator\，必须用 os.homedir() / app.getPath('home')。
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

/**
 * §55：路径策略校验。
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

  // 用户主动选择的文件直接放行（§29/§31）
  if (opts.userSelected) {
    return { ok: true };
  }

  // 自动发现：必须在已知配置目录内（§55/§56）
  const sourceType = opts.sourceType;
  if (!sourceType) {
    return { ok: false, reason: '非用户选择文件必须指定 sourceType' };
  }
  const allowed = knownLocations(sourceType);
  for (const dir of allowed) {
    if (isWithin(abs, dir)) return { ok: true };
  }
  return {
    ok: false,
    reason: `路径 ${abs} 不在 ${sourceType} 已知配置目录内（${allowed.join('; ')}）`
  };
}

/** 判断 target 是否在 dir 内（含 dir 自身）。 */
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
  isWithin,
  readFileSyncSafe,
  discoverKnownConfigs
};
