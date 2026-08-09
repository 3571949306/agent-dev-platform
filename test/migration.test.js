'use strict';
/**
 * v2.5.1 §29 — Import Source / Persistence Regression 单元测试。
 *
 * 验证：
 *   1. 新数据库：import_source / import_source_path 字段存在
 *   2. v2.4.1 老数据库（无 import_source 列）→ v2.5.1 自动 migration：
 *      - 字段被添加
 *      - 原 connections / models / agents 不丢失
 *      - 老连接 import_source = ''（一致，非 NULL）
 *   3. 导入新连接后 import_source / import_source_path 正确持久化
 *   4. Runtime 不依赖 import_source（见 §30，本测试验证 DB 层不因来源不同走不同路径）
 *
 * 运行环境：Electron Node 运行时（ELECTRON_RUN_AS_NODE=1），因为 better-sqlite3
 * 编译为 Electron ABI。scripts/run-tests.js 已配置好。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const Database = require('better-sqlite3');
const store = require('../src/db/store');

/**
 * v2.4.1 时代的 api_connections schema —— 没有 import_source / import_source_path 列。
 * 这两列是 v2.5.0 才引入的，所以 v2.4.1 老库迁移到 v2.5.1 时需要 ALTER TABLE ADD COLUMN。
 */
const V241_API_CONNECTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT DEFAULT '',
  api_key_masked TEXT DEFAULT '',
  headers_json TEXT DEFAULT '{}',
  models_json TEXT DEFAULT '[]',
  tested INTEGER DEFAULT 0,
  tested_at TEXT,
  last_error TEXT DEFAULT '',
  latency_ms INTEGER,
  created_at TEXT,
  updated_at TEXT
);
`;

const V241_MODELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  model_id TEXT NOT NULL,
  display_name TEXT,
  capabilities_json TEXT DEFAULT '{}',
  favorite INTEGER DEFAULT 0,
  created_at TEXT
);
`;

const V241_AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  type TEXT DEFAULT 'native',
  system_prompt_id TEXT,
  provider TEXT,
  model TEXT,
  api_connection_id TEXT,
  tools_json TEXT DEFAULT '[]',
  permissions_json TEXT DEFAULT '[]',
  max_steps INTEGER DEFAULT 40,
  timeout_ms INTEGER DEFAULT 600000,
  temperature REAL DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 4096,
  is_main INTEGER DEFAULT 0,
  sub_agent_ids_json TEXT DEFAULT '[]',
  workspace_json TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
`;

/** 创建一个 v2.4.1 风格的老数据库（无 import_source 列），并写入若干数据。 */
function createV241Database(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(V241_API_CONNECTIONS_SCHEMA);
  db.exec(V241_MODELS_SCHEMA);
  db.exec(V241_AGENTS_SCHEMA);

  const now = new Date().toISOString();
  // 两个老连接（无 import_source 字段）
  db.prepare(`INSERT INTO api_connections (id,name,provider,base_url,api_key_enc,api_key_masked,headers_json,models_json,tested,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
    .run('conn-old-1', 'OpenAI(v2.4.1)', 'openai', 'https://api.openai.com/v1',
      'enc:old1', 'sk-****-old1', '{}', '["gpt-4","gpt-3.5-turbo"]', now, now);
  db.prepare(`INSERT INTO api_connections (id,name,provider,base_url,api_key_enc,api_key_masked,headers_json,models_json,tested,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
    .run('conn-old-2', 'Anthropic(v2.4.1)', 'anthropic', 'https://api.anthropic.com',
      'enc:old2', 'sk-ant****old2', '{}', '["claude-3-opus"]', now, now);

  // 老模型
  db.prepare(`INSERT INTO models (id,connection_id,model_id,display_name,capabilities_json,favorite,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run('model-old-1', 'conn-old-1', 'gpt-4', 'GPT-4', '{}', 1, now);

  // 老 Agent
  db.prepare(`INSERT INTO agents (id,name,description,type,provider,model,api_connection_id,tools_json,permissions_json,max_steps,timeout_ms,temperature,max_tokens,is_main,sub_agent_ids_json,workspace_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('agent-old-1', '老主Agent', 'v2.4.1 创建的', 'native', 'openai', 'gpt-4', 'conn-old-1',
      '[]', '[]', 40, 600000, 0.7, 4096, 1, '[]', '{}', now, now);

  db.close();
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── §29 Migration Test ─────────────────────────────────────────────────

test('§29 新数据库：import_source / import_source_path 字段存在', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-new-'));
  try {
    store.init(userData);
    const cols = store.getDb().prepare('PRAGMA table_info(api_connections)').all().map(c => c.name);
    assert.ok(cols.includes('import_source'), 'import_source 列必须存在');
    assert.ok(cols.includes('import_source_path'), 'import_source_path 列必须存在');
  } finally {
    rmrf(userData);
  }
});

test('§29 v2.4.1 老库 → v2.5.1：字段被自动添加', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-241-'));
  try {
    // 1. 创建 v2.4.1 老库
    createV241Database(path.join(userData, 'agent.db'));

    // 2. 验证老库确实没有 import_source 列
    {
      const raw = new Database(path.join(userData, 'agent.db'));
      const cols = raw.prepare('PRAGMA table_info(api_connections)').all().map(c => c.name);
      raw.close();
      assert.ok(!cols.includes('import_source'), '前置条件：v2.4.1 老库不应有 import_source 列');
    }

    // 3. 用 v2.5.1 启动（触发 migration）
    store.init(userData);

    // 4. 验证字段已被添加
    const cols = store.getDb().prepare('PRAGMA table_info(api_connections)').all().map(c => c.name);
    assert.ok(cols.includes('import_source'), '迁移后 import_source 列应存在');
    assert.ok(cols.includes('import_source_path'), '迁移后 import_source_path 列应存在');
  } finally {
    rmrf(userData);
  }
});

test('§29 v2.4.1 老库 → v2.5.1：原 connections / models / agents 不丢失', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-data-'));
  try {
    createV241Database(path.join(userData, 'agent.db'));
    store.init(userData);

    // connections 保留
    const conns = store.connections.list();
    assert.strictEqual(conns.length, 2, '两个老连接都应保留');
    const names = conns.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['Anthropic(v2.4.1)', 'OpenAI(v2.4.1)']);

    // models 保留
    const models = store.models.listByConnection('conn-old-1');
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].model_id, 'gpt-4');

    // agents 保留
    const agent = store.agents.get('agent-old-1');
    assert.ok(agent, '老 Agent 应保留');
    assert.strictEqual(agent.name, '老主Agent');
    assert.strictEqual(agent.is_main, true);
  } finally {
    rmrf(userData);
  }
});

test('§29 v2.4.1 老库 → v2.5.1：老连接 import_source = ""（一致，非 NULL）', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-src-'));
  try {
    createV241Database(path.join(userData, 'agent.db'));
    store.init(userData);

    // 直接查底层 SQL，确认 import_source 字段值（不是 NULL，而是 ''）
    const rows = store.getDb().prepare('SELECT id, import_source, import_source_path FROM api_connections ORDER BY id').all();
    assert.strictEqual(rows.length, 2);
    for (const r of rows) {
      assert.strictEqual(r.import_source, '', `老连接 ${r.id} 的 import_source 应为空串（非 NULL）`);
      assert.strictEqual(r.import_source_path, '', `老连接 ${r.id} 的 import_source_path 应为空串（非 NULL）`);
    }

    // 通过 store.connections.list() 读取也应得到 ''
    const conns = store.connections.list();
    for (const c of conns) {
      assert.ok(c.import_source === '' || c.import_source === 'manual',
        `list() 返回的 import_source 应为 '' 或 'manual'，实际：${JSON.stringify(c.import_source)}`);
    }
  } finally {
    rmrf(userData);
  }
});

test('§29 导入新连接后 import_source / import_source_path 正确持久化', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-import-'));
  try {
    store.init(userData);

    // 模拟从 Codex 导入的连接
    const imported = store.connections.create({
      name: 'Codex 导入',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test-codex-abc123',
      import_source: 'codex',
      import_source_path: 'C:\\Users\\test\\.codex\\config.toml'
    });
    assert.strictEqual(imported.import_source, 'codex');
    assert.strictEqual(imported.import_source_path, 'C:\\Users\\test\\.codex\\config.toml');

    // 重新读取验证持久化
    const got = store.connections.get(imported.id);
    assert.strictEqual(got.import_source, 'codex');
    assert.strictEqual(got.import_source_path, 'C:\\Users\\test\\.codex\\config.toml');

    // 未指定 import_source 的新连接默认为 ''
    const manual = store.connections.create({
      name: '手动添加',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test-manual-xyz'
    });
    assert.strictEqual(manual.import_source, '', '未指定来源的连接 import_source 应为 ""');
    assert.strictEqual(manual.import_source_path, '');

    // 更新 import_source
    const updated = store.connections.update(manual.id, { import_source: 'manual' });
    assert.strictEqual(updated.import_source, 'manual');
  } finally {
    rmrf(userData);
  }
});

test('§29 重复 init（schema IF NOT EXISTS）不破坏已迁移的 import_source 数据', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-reinit-'));
  try {
    store.init(userData);
    const c = store.connections.create({
      name: '保持不变',
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test-keep-abc',
      import_source: 'ccswitch-local',
      import_source_path: 'C:\\Users\\test\\AppData\\Roaming\\cc-switch\\config.json'
    });

    // 再次 init（模拟应用重启）
    store.init(userData);

    const got = store.connections.get(c.id);
    assert.ok(got, '重启后连接应仍在');
    assert.strictEqual(got.import_source, 'ccswitch-local', '重启后 import_source 不应丢失');
    assert.strictEqual(got.import_source_path, 'C:\\Users\\test\\AppData\\Roaming\\cc-switch\\config.json');
  } finally {
    rmrf(userData);
  }
});

test('§30 Runtime 不依赖 import_source：connections.list/get 返回值不因来源不同走不同分支', () => {
  // 这是个语义测试：验证 store.connections 的所有读取方法对 import_source 是透明的，
  // 即不论 import_source 是 'codex' / 'manual' / ''，返回的连接对象形状一致。
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-mig-runtime-'));
  try {
    store.init(userData);

    const sources = ['codex', 'claude-code', 'opencode', 'ccswitch-local', 'manual', ''];
    const ids = [];
    for (const src of sources) {
      const c = store.connections.create({
        name: `src-${src || 'empty'}`,
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: `sk-test-${src || 'empty'}-abc123`,
        import_source: src
      });
      ids.push(c.id);
    }

    // list() 返回所有连接，形状一致
    const all = store.connections.list();
    assert.strictEqual(all.length, sources.length);
    for (const c of all) {
      assert.ok(typeof c.id === 'string');
      assert.ok(typeof c.name === 'string');
      assert.ok(typeof c.import_source === 'string');  // 不论来源，都是 string
      assert.ok(c.headers && typeof c.headers === 'object');
      assert.ok(Array.isArray(c.models));
    }

    // get() 对每个来源都返回非 null
    for (const id of ids) {
      const g = store.connections.get(id);
      assert.ok(g, `get(${id}) 不应返回 null`);
      assert.ok(typeof g.import_source === 'string');
    }

    // getDecrypted（Runtime 实际用于发请求的入口）不读 import_source
    for (const id of ids) {
      const d = store.connections.getDecrypted(id);
      assert.ok(d, `getDecrypted(${id}) 不应返回 null`);
      assert.ok(d.api_key, 'getDecrypted 应返回解密后的 api_key');
      // getDecrypted 返回的对象有 import_source 字段（因为 SELECT *），但 Runtime 不应使用它
      // 这里只验证字段存在且不导致读取失败
      assert.ok('import_source' in d);
    }
  } finally {
    rmrf(userData);
  }
});
