'use strict';
/**
 * v2.5.0/v2.5.1 External Config Import — CC Switch Local Config Import。
 *
 * §22/§23/§24/§25：基于已研究的 CC Switch commit 413c09e，读取其本地 SQLite/JSON 配置。
 * §23：只在用户点击「从 CC Switch 导入」后才寻找其默认配置目录，不在 App 启动时扫描。
 * §24：SQLite 只读打开或复制到 temp 后读 copy，禁止 UPDATE/INSERT/DELETE。
 * §25：不依赖 CC Switch 正在运行，Importer 独立工作。
 *
 * v2.5.1 §20/§21/§22：SQLite Reader 重构。
 *   - §20：安全 identifier quoting（quoteIdentifier），不直接拼表名进 SQL
 *   - §21：LIMIT 1000 + 最大表数量 + 最大候选数量 + 最大单字段字符串长度
 *   - §22：文件大小限制（<= 100 MB）+ canonical path + regular file
 *   - PRAGMA query_only = ON（禁止写入）
 *   - 禁止 ATTACH DATABASE / PRAGMA writable_schema / load_extension
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
const { discoverKnownConfigs, readFileSyncSafe, verifyPath, realpathSafe } = require('../security/pathPolicy');
const { sanitizeObject, safeJsonParse } = require('../security/inputSanitizer');
const { parseConfigBatch } = require('../../parsers/ccSwitch');

const ID = 'ccswitch';
const NAME = 'CC Switch';
const DESCRIPTION = '从本地 CC Switch 配置导入 Provider（只读，不修改 CC Switch 数据）';

/** v2.5.1 §21：SQLite 读取限制 */
const MAX_DB_SIZE = 100 * 1024 * 1024;  // §22: 100 MB
const MAX_ROW_LIMIT = 1000;              // §21: 每表最多 1000 行
const MAX_TABLES = 50;                   // §21: 最多检查 50 个表
const MAX_CANDIDATES = 200;              // §21: 最多 200 个候选
const MAX_FIELD_LENGTH = 65536;          // §21: 单字段最大 64 KB

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

  // v2.5.1 §25：safeJsonParse 过滤 prototype pollution
  const obj = safeJsonParse(text);
  if (obj === null) {
    src.errors.push('JSON 解析失败：格式无效');
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

/**
 * v2.5.1 §20：安全 identifier quoting。
 * 严格转义双引号，防止 SQL 注入。
 */
function quoteIdentifier(name) {
  if (!name || typeof name !== 'string') return '""';
  // 只允许字母、数字、下划线、$（SQLite 标识符字符）
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    // 非标准标识符：用双引号包裹并转义内部双引号
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return '"' + name + '"';
}

/**
 * v2.5.1 §22：SQLite 文件安全检查。
 * - canonical path
 * - regular file
 * - 合理大小限制（<= 100 MB）
 */
function verifySqliteFile(filePath) {
  const real = realpathSafe(filePath);
  if (!real) return { ok: false, reason: 'SQLite 文件不存在或路径无法解析' };
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: '无法获取 SQLite 文件状态' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'SQLite 路径不是普通文件' };
  if (stat.size > MAX_DB_SIZE) {
    return { ok: false, reason: `SQLite 文件过大（${Math.round(stat.size / 1024 / 1024)} MB），最大允许 ${MAX_DB_SIZE / 1024 / 1024} MB` };
  }
  if (stat.size === 0) return { ok: false, reason: 'SQLite 文件为空' };
  return { ok: true, real };
}

/** §24/v2.5.1 §20-§22：SQLite 读取 —— 复制到 temp 后用 better-sqlite3 只读打开 + query_only。 */
function parseSqlite(filePath, src, candidates, warnings) {
  try {
    // v2.5.1 §22：文件安全检查
    const fcheck = verifySqliteFile(filePath);
    if (!fcheck.ok) {
      src.errors.push(`SQLite 文件检查失败：${fcheck.reason}`);
      src.candidates = candidates;
      return { source: src, candidates, warnings };
    }

    // §24：复制到 temp 避免锁冲突
    const tmpPath = path.join(os.tmpdir(), `ccswitch-readonly-${Date.now()}.db`);
    fs.copyFileSync(fcheck.real, tmpPath);
    try {
      const Database = require('better-sqlite3');
      const db = new Database(tmpPath, { readonly: true, fileMustExist: true });
      try {
        // v2.5.1 §22：PRAGMA query_only = ON（禁止任何写入）
        db.pragma('query_only = ON');

        // v2.5.1 §20：从 sqlite_master 读取表名（安全 identifier quoting）
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
          .map(r => r.name)
          .slice(0, MAX_TABLES);  // §21: 限制表数量

        if (!tables.length) {
          warnings.push({ type: 'parse_warning', message: 'SQLite 数据库中无任何用户表' });
          src.candidates = candidates;
          return { source: src, candidates, warnings };
        }

        // v2.5.1 §20：优先查已知表名，安全 quote
        let rows = [];
        const knownTables = ['providers', 'settings', 'configs', 'connections'];
        const targetTable = knownTables.find(t => tables.includes(t));

        if (targetTable) {
          const quotedTable = quoteIdentifier(targetTable);
          rows = db.prepare(`SELECT * FROM ${quotedTable} LIMIT ${MAX_ROW_LIMIT}`).all();
        } else {
          // 尝试所有表，找到含 provider 数据的
          for (const t of tables) {
            if (candidates.length >= MAX_CANDIDATES) break;  // §21
            try {
              const quotedT = quoteIdentifier(t);
              const r = db.prepare(`SELECT * FROM ${quotedT} LIMIT ${MAX_ROW_LIMIT}`).all();
              if (r.length && r.some(row => row.name || row.settings_config || row.settingsConfig || row.value)) {
                rows = r;
                break;
              }
            } catch { /* skip unreadable table */ }
          }
        }

        const providerList = [];
        for (const row of rows) {
          if (providerList.length >= MAX_CANDIDATES) break;  // §21
          // v2.5.1 §21：限制单字段字符串长度
          const safeRow = {};
          for (const [k, v] of Object.entries(row)) {
            if (typeof v === 'string' && v.length > MAX_FIELD_LENGTH) {
              safeRow[k] = v.slice(0, MAX_FIELD_LENGTH);
            } else {
              safeRow[k] = v;
            }
          }
          if (safeRow.settings_config && typeof safeRow.settings_config === 'string') {
            // v2.5.1 §25：safeJsonParse 过滤 prototype pollution
            const sc = safeJsonParse(safeRow.settings_config);
            if (sc && typeof sc === 'object') {
              providerList.push({ name: safeRow.name || safeRow.id, settingsConfig: sc, ...sanitizeObject(safeRow) });
            }
          } else if (safeRow.settingsConfig) {
            providerList.push({ name: safeRow.name || safeRow.id, settingsConfig: sanitizeObject(safeRow.settingsConfig), ...sanitizeObject(safeRow) });
          } else if (safeRow.value && typeof safeRow.value === 'string') {
            // v2.5.1 §25：safeJsonParse 过滤 prototype pollution
            const v = safeJsonParse(safeRow.value);
            if (v && (v.name || v.settingsConfig)) providerList.push(v);
          }
        }

        if (providerList.length) {
          const importedCandidates = parseConfigBatch(providerList);
          for (const c of importedCandidates) {
            if (candidates.length >= MAX_CANDIDATES) break;  // §21
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
