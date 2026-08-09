'use strict';
/**
 * v2.5.0 External Config Import — CC Switch Local Config Import。
 *
 * §22/§23/§24/§25：基于已研究的 CC Switch commit 413c09e，读取其本地 SQLite/JSON 配置。
 * §23：只在用户点击「从 CC Switch 导入」后才寻找其默认配置目录，不在 App 启动时扫描。
 * §24：SQLite 只读打开或复制到 temp 后读 copy，禁止 UPDATE/INSERT/DELETE。
 * §25：不依赖 CC Switch 正在运行，Importer 独立工作。
 *
 * CC Switch 配置目录：通常位于 %APPDATA%\cc-switch\，可能含：
 *   - config.json（主配置 + provider 列表）
 *   - providers.json（独立 provider 列表）
 *   - data.db / cc-switch.db（SQLite 数据库）
 *   - settings.json
 *
 * 复用现有 parsers/ccSwitch.js 的 parseConfigBatch 解析 settingsConfig 结构。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExternalSource } = require('../externalSource');
const { discoverKnownConfigs, readFileSyncSafe, verifyPath } = require('../security/pathPolicy');
const { parseConfigBatch } = require('../../parsers/ccSwitch');

const ID = 'ccswitch';
const NAME = 'CC Switch';
const DESCRIPTION = '从本地 CC Switch 配置导入 Provider（只读，不修改 CC Switch 数据）';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  try {
    const configs = discoverKnownConfigs(ID);
    // 优先 JSON 文件（避免 SQLite 锁问题）
    const jsonFile = configs.find(c => /config\.json$|providers\.json$|settings\.json$/i.test(c.name));
    const dbFile = configs.find(c => /\.db$|\.sqlite$|cc-switch\.db$/i.test(c.name));

    if (jsonFile) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = jsonFile.path;
      src.lastModified = jsonFile.lastModified;
      src.configType = 'json';
    } else if (dbFile) {
      src.exists = true;
      src.readable = true;
      src.sourcePath = dbFile.path;
      src.lastModified = dbFile.lastModified;
      src.configType = 'sqlite';
      src.warnings.push({
        type: 'info',
        message: 'CC Switch 使用 SQLite 数据库，将只读打开或复制到 temp 后读取'
      });
    } else {
      src.exists = false;
      src.errors.push('未找到 CC Switch 配置目录或配置文件，请手动选择');
    }
  } catch (e) {
    src.errors.push(e.message || String(e));
  }
  return src;
}

function parse(opts = {}) {
  const src = discover();
  const candidates = [];
  const warnings = [];

  let filePath = src.sourcePath || opts.filePath;
  if (!filePath) {
    src.errors.push('未找到 CC Switch 配置文件');
    return { source: src, candidates, warnings };
  }

  // §24：SQLite 单独处理
  if (/\.db$|\.sqlite$/i.test(filePath)) {
    return parseSqlite(filePath, src, candidates, warnings);
  }

  // JSON 文件
  const policy = { sourceType: ID, userSelected: !src.sourcePath || !!opts.userSelected };
  let text;
  try {
    text = readFileSyncSafe(filePath, policy);
  } catch (e) {
    src.errors.push(`读取失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  let obj;
  try { obj = JSON.parse(text); }
  catch (e) {
    src.errors.push(`JSON 解析失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  // CC Switch Config JSON 形态：
  //   1. 顶层 [{name, settingsConfig:{env:{...}}}, ...]  → 直接 parseConfigBatch
  //   2. 顶层 { providers: [...] }                       → 取 providers
  //   3. 顶层 { currentProvider: "...", providers: {...}} → 转 array
  const providerList = normalizeProviderList(obj);
  if (!providerList.length) {
    src.warnings.push({ type: 'parse_warning', message: 'CC Switch 配置中未发现 Provider 列表' });
    src.candidates = [];
    return { source: src, candidates, warnings };
  }

  // §24/§22：复用现有 ccSwitch.parseConfigBatch
  const importedCandidates = parseConfigBatch(providerList);
  for (const c of importedCandidates) {
    // 覆盖 source.type 为 'ccswitch-local'（区分于 ccswitch-config 粘贴）
    c.source.type = 'ccswitch-local';
    c.source.parser = ID;
    c.source.path = filePath;
    c.source.confidence = 0.9;
    candidates.push(c);
  }

  src.candidates = candidates;
  src.warnings = warnings;
  return { source: src, candidates, warnings };
}

/** §24：SQLite 读取 —— 复制到 temp 后用 better-sqlite3 只读打开。 */
function parseSqlite(filePath, src, candidates, warnings) {
  try {
    // §24：复制到 temp 避免锁冲突
    const tmpPath = path.join(os.tmpdir(), `ccswitch-readonly-${Date.now()}.db`);
    fs.copyFileSync(filePath, tmpPath);
    try {
      const Database = require('better-sqlite3');
      const db = new Database(tmpPath, { readonly: true, fileMustExist: true });
      try {
        // CC Switch 实际表结构因版本而异，这里做防御性尝试
        // 已知 commit 413c09e 的 schema（从研究中推断）：
        //   - providers 表：含 name / settings_config（JSON 文本）
        //   - 或 key-value 形式的 settings 表
        let rows = [];
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

        if (tables.includes('providers')) {
          rows = db.prepare('SELECT * FROM providers').all();
        } else if (tables.includes('settings')) {
          rows = db.prepare('SELECT * FROM settings').all();
        } else {
          // 尝试所有可能的表名
          for (const t of tables) {
            try {
              const r = db.prepare(`SELECT * FROM ${t}`).all();
              if (r.length && r.some(row => row.name || row.settings_config || row.settingsConfig)) {
                rows = r;
                break;
              }
            } catch { /* skip */ }
          }
        }

        const providerList = [];
        for (const row of rows) {
          if (row.settings_config && typeof row.settings_config === 'string') {
            try {
              const sc = JSON.parse(row.settings_config);
              providerList.push({ name: row.name || row.id, settingsConfig: sc, ...row });
            } catch { /* skip malformed */ }
          } else if (row.settingsConfig) {
            providerList.push({ name: row.name || row.id, settingsConfig: row.settingsConfig, ...row });
          } else if (row.value && typeof row.value === 'string') {
            try {
              const v = JSON.parse(row.value);
              if (v && (v.name || v.settingsConfig)) providerList.push(v);
            } catch { /* skip */ }
          }
        }

        if (providerList.length) {
          const importedCandidates = parseConfigBatch(providerList);
          for (const c of importedCandidates) {
            c.source.type = 'ccswitch-local';
            c.source.parser = ID;
            c.source.path = filePath;
            c.source.confidence = 0.88;
            candidates.push(c);
          }
        } else {
          warnings.push({ type: 'parse_warning', message: 'SQLite 数据库中未发现可识别的 Provider 数据' });
        }
      } finally {
        db.close();
      }
    } finally {
      // 清理 temp 文件
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (e) {
    src.errors.push(`SQLite 读取失败：${e.message}`);
  }

  src.candidates = candidates;
  return { source: src, candidates, warnings };
}

/** 把各种 JSON 形态归一化为 provider 数组。 */
function normalizeProviderList(obj) {
  if (Array.isArray(obj)) return obj.filter(o => o && typeof o === 'object');
  if (obj && typeof obj !== 'object') return [];
  if (Array.isArray(obj.providers)) return obj.providers;
  if (obj.providers && typeof obj.providers === 'object') {
    // providers 可能是 { name: {...} } 字典
    return Object.entries(obj.providers).map(([k, v]) => ({
      name: v.name || k,
      ...v
    }));
  }
  if (obj.name && obj.settingsConfig) return [obj];
  return [];
}

module.exports = {
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  requiresFile: false,
  discover,
  parse
};
