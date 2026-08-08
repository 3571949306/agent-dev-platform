'use strict';
/**
 * SQLite schema + migration for Agent Dev Platform v2.
 * Uses better-sqlite3 (synchronous, fast, reliable for personal-scale data).
 * All tables use CREATE TABLE IF NOT EXISTS so upgrades are non-destructive.
 */
const path = require('path');
const fs = require('fs');

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  settings_json TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT,
  last_opened_at TEXT
);

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

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  model_id TEXT NOT NULL,
  display_name TEXT,
  capabilities_json TEXT DEFAULT '{}',
  favorite INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  content TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  tested INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  recommended_tools_json TEXT DEFAULT '[]',
  capability_json TEXT DEFAULT '[]',
  permission_preset_json TEXT DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT
);

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

CREATE TABLE IF NOT EXISTS external_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  adapter_type TEXT NOT NULL,
  endpoint TEXT DEFAULT '',
  command TEXT DEFAULT '',
  config_json TEXT DEFAULT '{}',
  capabilities_json TEXT DEFAULT '[]',
  online INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_permissions (
  agent_id TEXT,
  scope TEXT,
  level TEXT,
  PRIMARY KEY (agent_id, scope)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_id TEXT,
  title TEXT DEFAULT '新对话',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,
  content TEXT DEFAULT '',
  tool_calls_json TEXT,
  tool_call_id TEXT,
  model TEXT,
  tokens INTEGER,
  rating INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  type TEXT,
  payload_json TEXT DEFAULT '{}',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  conversation_id TEXT,
  agent_id TEXT,
  title TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  summary TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  label TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  from_agent_id TEXT,
  to_agent_id TEXT,
  type TEXT,
  content TEXT DEFAULT '',
  payload_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  source TEXT DEFAULT 'builtin',
  risk_level TEXT DEFAULT 'low',
  input_schema_json TEXT DEFAULT '{}',
  config_json TEXT DEFAULT '{}',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT DEFAULT 'stdio',
  command TEXT DEFAULT '',
  args_json TEXT DEFAULT '[]',
  url TEXT DEFAULT '',
  env_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'disconnected',
  tools_json TEXT DEFAULT '[]',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  layer TEXT DEFAULT 'global',
  project_id TEXT,
  agent_id TEXT,
  conversation_id TEXT,
  task_id TEXT,
  key TEXT,
  value TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  kind TEXT DEFAULT 'snapshot',
  ref_json TEXT DEFAULT '{}',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  path TEXT,
  before TEXT,
  after TEXT,
  diff TEXT DEFAULT '',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  agent_id TEXT,
  agent_name TEXT,
  conversation_id TEXT,
  task_id TEXT,
  connection_id TEXT,
  connection_name TEXT,
  provider TEXT,
  protocol TEXT,
  endpoint TEXT,
  requested_model TEXT,
  actual_model TEXT,
  model_source TEXT,
  fell_back INTEGER DEFAULT 0,
  image_parts INTEGER DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER DEFAULT 1,
  error TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  grant_range TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions_audit (
  id TEXT PRIMARY KEY,
  time TEXT,
  agent TEXT,
  task TEXT,
  tool TEXT,
  target TEXT,
  permission TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  status TEXT DEFAULT 'preparing',
  stage TEXT DEFAULT 'preparing',
  started_at TEXT,
  updated_at TEXT,
  last_activity_at TEXT,
  terminal_at TEXT,
  error TEXT DEFAULT '',
  message TEXT DEFAULT ''
);
`;

/**
 * Additive column migrations for databases created by an earlier build.
 * CREATE TABLE IF NOT EXISTS never adds columns to an existing table, so any
 * column introduced after the first release must be listed here.
 */
const COLUMN_MIGRATIONS = [
  ['memories', 'updated_at', 'TEXT'],
  // v2.1.0 — model routing telemetry on every usage record
  ['usage_records', 'agent_id', 'TEXT'],
  ['usage_records', 'connection_id', 'TEXT'],
  ['usage_records', 'requested_model', 'TEXT'],
  ['usage_records', 'protocol', 'TEXT'],
  // v2.1.0 — cross-chat delegation bookkeeping
  ['agent_messages', 'from_conversation_id', 'TEXT'],
  ['agent_messages', 'to_conversation_id', 'TEXT'],
  ['agent_messages', 'depth', 'INTEGER'],
  // v2.1.0 — external agent run state
  ['external_agents', 'last_status', 'TEXT'],
  ['external_agents', 'last_run_at', 'TEXT']
];

function ensureColumns(db) {
  for (const [table, col, type] of COLUMN_MIGRATIONS) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
    catch { continue; }
    if (cols.length && !cols.includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
}

function initDb(userDataPath) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(userDataPath, 'agent.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumns(db);
  _db = db;
  return db;
}

function getDb() {
  if (!_db) throw new Error('数据库未初始化');
  return _db;
}

function dbPath(userDataPath) {
  return path.join(userDataPath, 'agent.db');
}

module.exports = { initDb, getDb, dbPath, SCHEMA };
