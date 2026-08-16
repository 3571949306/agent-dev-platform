'use strict';
/**
 * Data store: CRUD over SQLite + migration from v1 data.json.
 * All entities live here. JSON columns are serialized/deserialized transparently.
 */
const crypto = require('crypto');
const dbm = require('./schema');
const sec = require('../security/secret');
const { sanitizePublic } = require('../models/router/publicData');

function db() { return dbm.getDb(); }
function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function j(v) { return JSON.stringify(v === undefined ? null : v); }
function p(v, def) { try { return JSON.parse(v); } catch { return def; } }

// ---------- projects ----------
const projects = {
  list() { return db().prepare('SELECT * FROM projects ORDER BY last_opened_at DESC').all(); },
  get(id) { return db().prepare('SELECT * FROM projects WHERE id=?').get(id); },
  create({ name, rootPath, settings }) {
    const id = uuid(); const t = now();
    db().prepare(`INSERT INTO projects (id,name,root_path,settings_json,created_at,updated_at,last_opened_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, name, rootPath, j(settings || {}), t, t, t);
    return projects.get(id);
  },
  update(id, patch) {
    const cur = projects.get(id); if (!cur) return null;
    const name = patch.name ?? cur.name;
    const root = patch.rootPath ?? cur.root_path;
    const settings = patch.settings ? j(patch.settings) : cur.settings_json;
    db().prepare('UPDATE projects SET name=?,root_path=?,settings_json=?,updated_at=? WHERE id=?')
      .run(name, root, settings, now(), id);
    return projects.get(id);
  },
  touch(id) { db().prepare('UPDATE projects SET last_opened_at=? WHERE id=?').run(now(), id); },
  remove(id) { db().prepare('DELETE FROM projects WHERE id=?').run(id); return true; }
};

// ---------- api_connections ----------
/**
 * v2.3.1 (P1-5/P1-15/P1-19) — 模型列表统一为「每模型独立元数据」对象数组：
 *   [{ id, source: 'remote'|'manual'|'preset'|'cached', favorite, addedAt }]
 * 旧数据（string[]）读取时自动归一化迁移为 source='cached'，不破坏旧库。
 */
function normalizeModels(models) {
  return (models || []).map(m => {
    if (typeof m === 'string') return { id: m, source: 'cached', favorite: false, addedAt: null };
    if (m && typeof m === 'object' && m.id) {
      return { id: m.id, source: m.source || 'cached', favorite: !!m.favorite, addedAt: m.addedAt || null };
    }
    return null;
  }).filter(Boolean);
}

/* v2.9.9 Phase B Final（B15.3/B15.4）— Custom Header Secret Rules。
 * Header 值与 API Key 同等对待：写入即加密，读取只给掩码，
 * 解密值只在 main 进程 getDecrypted 边界内出现，绝不进入 Renderer。 */
const HEADER_MASK = '••••••••';

/** 写入边界：明文 header 值 → 加密存储（空值直接丢弃，不保留空名条目）。 */
function encryptHeaderValues(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = sec.encrypt(String(v));
  }
  return out;
}

/** 读取边界（存储态 → 掩码）。旧版明文值同样只暴露掩码。 */
function maskHeaderValues(stored = {}) {
  const out = {};
  for (const [k, v] of Object.entries(stored || {})) out[k] = v ? HEADER_MASK : '';
  return out;
}

/** 解密边界（仅 main 进程）。旧版明文值（无 enc:/obf: 前缀）原样可读；空值丢弃。 */
function decryptHeaderValues(stored = {}) {
  const out = {};
  for (const [k, v] of Object.entries(stored || {})) { if (v) out[k] = sec.decrypt(String(v)); }
  return out;
}

/** Renderer-safe 投影：绝不携带 api_key_enc / headers_json / 明文 header 值。 */
function connectionPublic(r) {
  const stored = p(r.headers_json, {});
  const headerNames = Object.keys(stored);
  return {
    id: r.id, name: r.name, provider: r.provider, base_url: r.base_url,
    api_key_masked: r.api_key_masked || '',
    has_key: !!r.api_key_masked,
    headers: maskHeaderValues(stored),
    header_names: headerNames,
    has_custom_headers: headerNames.some(k => stored[k]),
    models: normalizeModels(p(r.models_json, [])),
    tested: r.tested, tested_at: r.tested_at || null,
    test_state: r.test_state || '',
    last_error: r.last_error || '', latency_ms: r.latency_ms ?? null,
    enabled: r.enabled, import_source: r.import_source || '', import_source_path: r.import_source_path || '',
    created_at: r.created_at, updated_at: r.updated_at
  };
}

const connections = {
  list() {
    return db().prepare('SELECT * FROM api_connections ORDER BY created_at').all()
      .map(connectionPublic);
  },
  /** Public, secret-free projection consumed by ModelCatalog. Header values never cross this boundary. */
  listForModelRouting() {
    return db().prepare('SELECT id,name,provider,base_url,api_key_masked,headers_json,models_json,tested,tested_at,latency_ms,enabled,created_at,updated_at FROM api_connections ORDER BY created_at').all()
      .map(r => {
        const headerNames = Object.keys(p(r.headers_json, {}));
        return {
          id: r.id, name: r.name, provider: r.provider, base_url: r.base_url,
          models: normalizeModels(p(r.models_json, [])), tested: r.tested,
          tested_at: r.tested_at, latency_ms: r.latency_ms, enabled: r.enabled,
          created_at: r.created_at, updated_at: r.updated_at,
          has_key: !!r.api_key_masked,
          has_custom_headers: headerNames.length > 0
        };
      });
  },
  get(id) {
    const r = db().prepare('SELECT * FROM api_connections WHERE id=?').get(id);
    if (!r) return null;
    return connectionPublic(r);
  },
  /** returns connection with decrypted key + header values (main process only) */
  getDecrypted(id) {
    const r = db().prepare('SELECT * FROM api_connections WHERE id=?').get(id);
    if (!r) return null;
    return { ...r, api_key: sec.decrypt(r.api_key_enc), headers: decryptHeaderValues(p(r.headers_json, {})), models: normalizeModels(p(r.models_json, [])) };
  },
  create(body) {
    const id = uuid(); const t = now();
    const key = body.api_key || '';
    db().prepare(`INSERT INTO api_connections (id,name,provider,base_url,api_key_enc,api_key_masked,headers_json,models_json,tested,enabled,import_source,import_source_path,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)`)
      .run(id, body.name || '新连接', body.provider || 'openai', body.base_url || 'https://api.openai.com/v1',
        sec.encrypt(key), sec.mask(key), j(encryptHeaderValues(body.headers || {})), j(body.models || []),
        body.enabled === false ? 0 : 1, body.import_source || '', body.import_source_path || '', t, t);
    return connections.get(id);
  },
  update(id, body) {
    const cur = db().prepare('SELECT * FROM api_connections WHERE id=?').get(id); if (!cur) return null;
    const name = body.name ?? cur.name;
    const provider = body.provider ?? cur.provider;
    const baseUrl = body.base_url ?? cur.base_url;
    // B15.4：header 值掩码占位（HEADER_MASK）= 保留已存密文；空值 = 清空；其余 = 新值加密。
    let headersJson = cur.headers_json;
    if (body.headers !== undefined) {
      const stored = p(cur.headers_json, {});
      const next = {};
      for (const [k, v] of Object.entries(body.headers || {})) {
        if (!k) continue;
        if (v === HEADER_MASK) { if (stored[k]) next[k] = stored[k]; }
        else if (v === null || v === undefined || v === '') { /* 空值 = 删除该 header */ }
        else next[k] = sec.encrypt(String(v));
      }
      headersJson = j(next);
    }
    const models = body.models ? j(body.models) : cur.models_json;
    let enc = cur.api_key_enc, masked = cur.api_key_masked;
    if (body.api_key !== undefined) {
      if (body.api_key === '') { enc = ''; masked = ''; }
      else if (body.api_key !== cur.api_key_masked) { enc = sec.encrypt(body.api_key); masked = sec.mask(body.api_key); }
    }
    const tested = body.tested ?? cur.tested;
    const testedAt = body.tested_at ?? cur.tested_at;
    const lastError = body.last_error ?? cur.last_error;
    const latency = body.latency_ms ?? cur.latency_ms;
    const enabled = body.enabled === undefined ? cur.enabled : (body.enabled ? 1 : 0);
    const importSource = body.import_source ?? cur.import_source;
    const importSourcePath = body.import_source_path ?? cur.import_source_path;
    db().prepare(`UPDATE api_connections SET name=?,provider=?,base_url=?,api_key_enc=?,api_key_masked=?,headers_json=?,models_json=?,tested=?,tested_at=?,last_error=?,latency_ms=?,enabled=?,import_source=?,import_source_path=?,updated_at=? WHERE id=?`)
      .run(name, provider, baseUrl, enc, masked, headersJson, models, tested ? 1 : 0, testedAt, lastError, latency, enabled, importSource, importSourcePath, now(), id);
    return connections.get(id);
  },
  /** B15.1/B15.5 — 测试真话：kind 只能是 'ok'|'failed'|'error'，状态词汇由真实结果决定。 */
  setTestResult(id, { ok, error, latency, kind }) {
    const cur = connections.get(id); if (!cur) return null;
    const state = kind === 'error' ? 'error' : (ok ? 'ok' : 'failed');
    db().prepare('UPDATE api_connections SET tested=?,tested_at=?,last_error=?,latency_ms=?,test_state=? WHERE id=?')
      .run(ok ? 1 : 0, ok ? now() : cur.tested_at, error || '', latency ?? null, state, id);
    return connections.get(id);
  },
  setModels(id, models) {
    db().prepare('UPDATE api_connections SET models_json=? WHERE id=?').run(j(normalizeModels(models)), id);
    return connections.get(id);
  },
  /**
   * v2.3.1 (P1-16) — 刷新模型时保留手动添加的模型 + 收藏状态。
   * freshModels 来自 Provider（string[] 或 {id}[]，视为 source 指定的远端结果）。
   * 已有模型里的 source='manual' 且不在 fresh 里的条目保留；fresh 条目的 favorite/addedAt 从旧数据继承。
   */
  mergeModels(id, freshModels, source = 'remote') {
    const cur = connections.get(id);
    const existing = cur ? normalizeModels(cur.models) : [];
    const fresh = normalizeModels(freshModels).map(m => ({ ...m, source }));
    const byId = new Map(existing.map(m => [m.id, m]));
    const merged = fresh.map(m => {
      const old = byId.get(m.id);
      return { ...m, favorite: old ? old.favorite : false, addedAt: old ? old.addedAt : null };
    });
    // 保留手动添加、且远端本次没有返回的模型
    for (const m of existing) {
      if (m.source === 'manual' && !fresh.some(f => f.id === m.id)) merged.push(m);
    }
    // 去重（理论上不会重复，防御一下）
    const seen = new Set(); const dedup = [];
    for (const m of merged) { if (!seen.has(m.id)) { seen.add(m.id); dedup.push(m); } }
    db().prepare('UPDATE api_connections SET models_json=? WHERE id=?').run(j(dedup), id);
    return connections.get(id);
  },
  /** 手动添加模型（source='manual'），重复添加幂等。 */
  addModel(id, modelId) {
    const cur = connections.get(id);
    if (!cur) throw new Error('连接不存在');
    const models = normalizeModels(cur.models);
    if (!models.some(m => m.id === modelId)) {
      models.push({ id: modelId, source: 'manual', favorite: false, addedAt: now() });
      db().prepare('UPDATE api_connections SET models_json=? WHERE id=?').run(j(models), id);
    }
    return connections.get(id);
  },
  /** 收藏/取消收藏（唯一真源：models_json 里的 favorite）。 */
  setModelFavorite(id, modelId, fav) {
    const cur = connections.get(id);
    if (!cur) throw new Error('连接不存在');
    const models = normalizeModels(cur.models).map(m => m.id === modelId ? { ...m, favorite: !!fav } : m);
    db().prepare('UPDATE api_connections SET models_json=? WHERE id=?').run(j(models), id);
    return connections.get(id);
  },
  remove(id) { db().prepare('DELETE FROM api_connections WHERE id=?').run(id); return true; }
};

// ---------- models ----------
const models = {
  listByConnection(connId) { return db().prepare('SELECT * FROM models WHERE connection_id=?').all(connId).map(r => ({ ...r, capabilities: p(r.capabilities_json, {}) })); },
  /** Capabilities recorded by a real probe (Diagnostics), or null if never probed. */
  caps(connId, modelId) {
    const r = db().prepare('SELECT capabilities_json FROM models WHERE connection_id=? AND model_id=?').get(connId, modelId);
    return r ? p(r.capabilities_json, {}) : null;
  },
  upsert(connId, modelId, caps) {
    const ex = db().prepare('SELECT id FROM models WHERE connection_id=? AND model_id=?').get(connId, modelId);
    if (ex) { db().prepare('UPDATE models SET capabilities_json=? WHERE id=?').run(j(caps || {}), ex.id); return ex.id; }
    const id = uuid();
    db().prepare('INSERT INTO models (id,connection_id,model_id,capabilities_json,created_at) VALUES (?,?,?,?,?)')
      .run(id, connId, modelId, j(caps || {}), now());
    return id;
  },
  favorite(id, fav) { db().prepare('UPDATE models SET favorite=? WHERE id=?').run(fav ? 1 : 0, id); }
};

// ---------- prompts ----------
const prompts = {
  list() { return db().prepare('SELECT * FROM prompts ORDER BY created_at').all().map(r => ({ ...r, tags: p(r.tags_json, []) })); },
  get(id) { const r = db().prepare('SELECT * FROM prompts WHERE id=?').get(id); return r ? { ...r, tags: p(r.tags_json, []) } : null; },
  create(body) {
    const id = uuid(); const t = now();
    db().prepare('INSERT INTO prompts (id,name,version,content,description,tags_json,tested,created_at,updated_at) VALUES (?,?,1,?,?,?,0,?,?)')
      .run(id, body.name || '未命名', body.content || '', body.description || '', j(body.tags || []), t, t);
    return prompts.get(id);
  },
  update(id, body) {
    const cur = prompts.get(id); if (!cur) return null;
    const content = body.content ?? cur.content;
    const version = body.content !== undefined ? (cur.version || 1) + 1 : cur.version;
    db().prepare('UPDATE prompts SET name=?,content=?,version=?,description=?,tags_json=?,tested=?,updated_at=? WHERE id=?')
      .run(body.name ?? cur.name, content, version, body.description ?? cur.description, j(body.tags ?? cur.tags), body.tested ?? cur.tested, now(), id);
    return prompts.get(id);
  },
  remove(id) { db().prepare('DELETE FROM prompts WHERE id=?').run(id); return true; }
};

// ---------- skills ----------
const skills = {
  list() { return db().prepare('SELECT * FROM skills ORDER BY created_at').all().map(r => ({ ...r, recommended_tools: p(r.recommended_tools_json, []), capability: p(r.capability_json, []), permission_preset: p(r.permission_preset_json, []) })); },
  get(id) { const r = db().prepare('SELECT * FROM skills WHERE id=?').get(id); return r ? { ...r, recommended_tools: p(r.recommended_tools_json, []), capability: p(r.capability_json, []), permission_preset: p(r.permission_preset_json, []) } : null; },
  create(body) {
    const id = uuid(); const t = now();
    db().prepare('INSERT INTO skills (id,name,description,prompt,recommended_tools_json,capability_json,permission_preset_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, body.name, body.description || '', body.prompt || '', j(body.recommended_tools || []), j(body.capability || []), j(body.permission_preset || []), t, t);
    return skills.get(id);
  },
  remove(id) { db().prepare('DELETE FROM skills WHERE id=?').run(id); return true; }
};

// ---------- agents (native + computer) ----------
function rowToAgent(r) {
  if (!r) return null;
  return { ...r, tools: p(r.tools_json, []), permissions: p(r.permissions_json, []), sub_agent_ids: p(r.sub_agent_ids_json, []), workspace: p(r.workspace_json, {}), is_main: !!r.is_main };
}
const agents = {
  list() {
    const native = db().prepare("SELECT * FROM agents WHERE type IN ('native','computer') ORDER BY created_at").all().map(rowToAgent);
    const ext = externalAgents.list();
    return [...native, ...ext];
  },
  listNative() { return db().prepare("SELECT * FROM agents WHERE type IN ('native','computer') ORDER BY created_at").all().map(rowToAgent); },
  get(id) { return rowToAgent(db().prepare('SELECT * FROM agents WHERE id=?').get(id)); },
  create(body) {
    const id = uuid(); const t = now();
    const type = body.type === 'computer' ? 'computer' : 'native';
    db().prepare(`INSERT INTO agents (id,name,description,type,system_prompt_id,provider,model,api_connection_id,tools_json,permissions_json,max_steps,timeout_ms,temperature,max_tokens,is_main,sub_agent_ids_json,workspace_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, body.name || '新 Agent', body.description || '', type, body.system_prompt_id || null, body.provider || null, body.model || null, body.api_connection_id || null,
        j(body.tools || []), j(body.permissions || []), body.max_steps ?? 40, body.timeout_ms ?? 600000, body.temperature ?? 0.7, body.max_tokens ?? 4096, body.is_main ? 1 : 0, j(body.sub_agent_ids || []), j(body.workspace || {}), t, t);
    return agents.get(id);
  },
  update(id, body) {
    const cur = agents.get(id); if (!cur) return null;
    db().prepare(`UPDATE agents SET name=?,description=?,system_prompt_id=?,provider=?,model=?,api_connection_id=?,tools_json=?,permissions_json=?,max_steps=?,timeout_ms=?,temperature=?,max_tokens=?,is_main=?,sub_agent_ids_json=?,workspace_json=?,updated_at=? WHERE id=?`)
      .run(body.name ?? cur.name, body.description ?? cur.description, body.system_prompt_id ?? cur.system_prompt_id, body.provider ?? cur.provider, body.model ?? cur.model, body.api_connection_id ?? cur.api_connection_id,
        j(body.tools ?? cur.tools), j(body.permissions ?? cur.permissions), body.max_steps ?? cur.max_steps, body.timeout_ms ?? cur.timeout_ms, body.temperature ?? cur.temperature, body.max_tokens ?? cur.max_tokens, body.is_main ? 1 : (cur.is_main ? 1 : 0), j(body.sub_agent_ids ?? cur.sub_agent_ids), j(body.workspace ?? cur.workspace), now(), id);
    return agents.get(id);
  },
  remove(id) { db().prepare('DELETE FROM agents WHERE id=?').run(id); return true; }
};

// ---------- external_agents ----------
function rowToExternal(r) {
  if (!r) return null;
  return { ...r, type: 'external', capabilities: p(r.capabilities_json, []), config: p(r.config_json, {}), online: !!r.online };
}
const externalAgents = {
  list() { return db().prepare('SELECT * FROM external_agents ORDER BY created_at').all().map(rowToExternal); },
  get(id) { return rowToExternal(db().prepare('SELECT * FROM external_agents WHERE id=?').get(id)); },
  create(body) {
    const id = uuid(); const t = now();
    db().prepare(`INSERT INTO external_agents (id,name,description,adapter_type,endpoint,command,config_json,capabilities_json,online,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
      .run(id, body.name || '新外部 Agent', body.description || '', body.adapter_type || 'http', body.endpoint || '', body.command || '', j(body.config || {}), j(body.capabilities || []), t, t);
    return externalAgents.get(id);
  },
  update(id, body) {
    const cur = externalAgents.get(id); if (!cur) return null;
    db().prepare('UPDATE external_agents SET name=?,description=?,adapter_type=?,endpoint=?,command=?,config_json=?,capabilities_json=?,online=?,updated_at=? WHERE id=?')
      .run(body.name ?? cur.name, body.description ?? cur.description, body.adapter_type ?? cur.adapter_type, body.endpoint ?? cur.endpoint, body.command ?? cur.command, j(body.config ?? cur.config), j(body.capabilities ?? cur.capabilities), body.online ? 1 : 0, now(), id);
    return externalAgents.get(id);
  },
  setOnline(id, online) { db().prepare('UPDATE external_agents SET online=? WHERE id=?').run(online ? 1 : 0, id); },
  // v2.1.0: 外部 Agent 统一状态记账。status 为 running/completed/failed/timeout/cancelled 之一。
  // error 为可选文本；online 为可选布尔（不传则不动 online 列）。
  setRunStatus(id, { status, error = null, online = undefined } = {}) {
    const t = now();
    const payload = error ? `${status}: ${String(error).slice(0, 500)}` : status;
    if (typeof online === 'boolean') {
      db().prepare('UPDATE external_agents SET last_status=?, last_run_at=?, online=?, updated_at=? WHERE id=?')
        .run(payload, t, online ? 1 : 0, t, id);
    } else {
      db().prepare('UPDATE external_agents SET last_status=?, last_run_at=?, updated_at=? WHERE id=?')
        .run(payload, t, t, id);
    }
    return externalAgents.get(id);
  },
  remove(id) { db().prepare('DELETE FROM external_agents WHERE id=?').run(id); return true; }
};

// ---------- conversations ----------
const conversations = {
  list(projectId) {
    const sql = projectId ? 'SELECT * FROM conversations WHERE project_id=? ORDER BY updated_at DESC' : 'SELECT * FROM conversations ORDER BY updated_at DESC';
    return db().prepare(sql).all(...(projectId ? [projectId] : [])).map(r => ({ ...r, project_id: r.project_id }));
  },
  get(id) { return db().prepare('SELECT * FROM conversations WHERE id=?').get(id); },
  getWithMessages(id) {
    const conv = conversations.get(id); if (!conv) return null;
    return { ...conv, messages: messages.list(id) };
  },
  create({ projectId, agentId, title }) {
    const id = uuid(); const t = now();
    db().prepare('INSERT INTO conversations (id,project_id,agent_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, projectId || null, agentId || null, title || '新对话', t, t);
    return conversations.get(id);
  },
  update(id, patch) {
    const cur = conversations.get(id); if (!cur) return null;
    db().prepare('UPDATE conversations SET title=?,agent_id=?,updated_at=? WHERE id=?')
      .run(patch.title ?? cur.title, patch.agentId ?? cur.agent_id, now(), id);
    return conversations.get(id);
  },
  remove(id) {
    db().prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    db().prepare('DELETE FROM agent_events WHERE conversation_id=?').run(id);
    db().prepare('DELETE FROM conversations WHERE id=?').run(id);
    return true;
  }
};

// ---------- messages ----------
const messages = {
  list(convId) { return db().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, rowid').all(convId).map(r => ({ ...r, tool_calls: p(r.tool_calls_json, null) })); },
  create({ conversation_id, role, content, tool_calls, tool_call_id, model, tokens, rating }) {
    const id = uuid();
    db().prepare('INSERT INTO messages (id,conversation_id,role,content,tool_calls_json,tool_call_id,model,tokens,rating,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, conversation_id, role, content || '', tool_calls ? j(tool_calls) : null, tool_call_id || null, model || null, tokens ?? null, rating ?? null, now());
    db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), conversation_id);
    return db().prepare('SELECT * FROM messages WHERE id=?').get(id);
  },
  update(id, patch) {
    const cur = db().prepare('SELECT * FROM messages WHERE id=?').get(id); if (!cur) return null;
    db().prepare('UPDATE messages SET content=?,rating=? WHERE id=?').run(patch.content ?? cur.content, patch.rating ?? cur.rating, id);
    return db().prepare('SELECT * FROM messages WHERE id=?').get(id);
  },
  rate(id, rating) { db().prepare('UPDATE messages SET rating=? WHERE id=?').run(rating, id); return true; }
};

// ---------- agent_events ----------
const events = {
  append({ conversation_id, task_id, agent_id, type, payload }) {
    const id = uuid();
    db().prepare('INSERT INTO agent_events (id,conversation_id,task_id,agent_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, conversation_id || null, task_id || null, agent_id || null, type, j(payload || {}), now());
    return id;
  },
  list(convId) { return db().prepare('SELECT * FROM agent_events WHERE conversation_id=? ORDER BY created_at, rowid').all(convId); },
  listByTask(taskId) { return db().prepare('SELECT * FROM agent_events WHERE task_id=? ORDER BY created_at, rowid').all(taskId); }
};

// ---------- tasks ----------
const tasks = {
  list(projectId) {
    const sql = projectId ? 'SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC' : 'SELECT * FROM tasks ORDER BY created_at DESC';
    return db().prepare(sql).all(...(projectId ? [projectId] : []));
  },
  get(id) { return db().prepare('SELECT * FROM tasks WHERE id=?').get(id); },
  create({ projectId, conversationId, agentId, title, status }) {
    const id = uuid(); const t = now();
    db().prepare('INSERT INTO tasks (id,project_id,conversation_id,agent_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, projectId || null, conversationId || null, agentId || null, title || '', status || 'queued', t, t);
    return tasks.get(id);
  },
  update(id, patch) {
    const cur = tasks.get(id); if (!cur) return null;
    db().prepare('UPDATE tasks SET title=?,status=?,summary=?,error=?,updated_at=? WHERE id=?')
      .run(patch.title ?? cur.title, patch.status ?? cur.status, patch.summary ?? cur.summary, patch.error ?? cur.error, now(), id);
    return tasks.get(id);
  },
  addStep(taskId, label) {
    const id = uuid();
    db().prepare('INSERT INTO task_steps (id,task_id,label,status,created_at) VALUES (?,?,?,?,?)').run(id, taskId, label, 'pending', now());
    return id;
  },
  updateStep(stepId, status) { db().prepare('UPDATE task_steps SET status=? WHERE id=?').run(status, stepId); },
  steps(taskId) { return db().prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY created_at').all(taskId); }
};

// ---------- agent_messages (bus) ----------
const agentMessages = {
  send({ projectId, taskId, fromAgentId, toAgentId, fromConversationId, toConversationId, depth, type, content, payload }) {
    const id = uuid();
    db().prepare(`INSERT INTO agent_messages
      (id,project_id,task_id,from_agent_id,to_agent_id,from_conversation_id,to_conversation_id,depth,type,content,payload_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId || null, taskId || null, fromAgentId || null, toAgentId || null,
        fromConversationId || null, toConversationId || null, depth ?? 0,
        type || 'message', content || '', j(payload || {}), 'pending', now());
    return id;
  },
  get(id) { const r = db().prepare('SELECT * FROM agent_messages WHERE id=?').get(id); return r ? { ...r, payload: p(r.payload_json, {}) } : null; },
  list(filter) {
    let sql = 'SELECT * FROM agent_messages';
    const where = []; const params = [];
    if (filter && filter.toAgentId) { where.push('to_agent_id=?'); params.push(filter.toAgentId); }
    if (filter && filter.toConversationId) { where.push('to_conversation_id=?'); params.push(filter.toConversationId); }
    if (filter && filter.fromConversationId) { where.push('from_conversation_id=?'); params.push(filter.fromConversationId); }
    if (filter && filter.status) { where.push('status=?'); params.push(filter.status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at';
    return db().prepare(sql).all(...params).map(r => ({ ...r, payload: p(r.payload_json, {}) }));
  },
  update(id, patch) {
    const cur = db().prepare('SELECT * FROM agent_messages WHERE id=?').get(id); if (!cur) return null;
    db().prepare('UPDATE agent_messages SET status=?,content=?,payload_json=? WHERE id=?')
      .run(patch.status ?? cur.status, patch.content ?? cur.content, patch.payload ? j(patch.payload) : cur.payload_json, id);
    return agentMessages.get(id);
  }
};

// ---------- tools (registry) ----------
const tools = {
  list() { return db().prepare('SELECT * FROM tools ORDER BY created_at').all().map(r => ({ ...r, input_schema: p(r.input_schema_json, {}), config: p(r.config_json, {}) })); },
  get(id) { const r = db().prepare('SELECT * FROM tools WHERE id=?').get(id); return r ? { ...r, input_schema: p(r.input_schema_json, {}), config: p(r.config_json, {}) } : null; },
  create(body) {
    const id = uuid();
    db().prepare('INSERT INTO tools (id,name,description,source,risk_level,input_schema_json,config_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, body.name, body.description || '', body.source || 'builtin', body.risk_level || 'low', j(body.input_schema || {}), j(body.config || {}), now());
    return tools.get(id);
  },
  update(id, body) {
    const cur = tools.get(id); if (!cur) return null;
    db().prepare('UPDATE tools SET name=?,description=?,source=?,risk_level=?,input_schema_json=?,config_json=? WHERE id=?')
      .run(body.name ?? cur.name, body.description ?? cur.description, body.source ?? cur.source, body.risk_level ?? cur.risk_level, j(body.input_schema ?? cur.input_schema), j(body.config ?? cur.config), id);
    return tools.get(id);
  },
  remove(id) { db().prepare('DELETE FROM tools WHERE id=?').run(id); return true; }
};

// ---------- mcp_servers ----------
const mcpServers = {
  list() { return db().prepare('SELECT * FROM mcp_servers ORDER BY created_at').all().map(r => ({ ...r, args: p(r.args_json, []), env: p(r.env_json, {}), tools: p(r.tools_json, []) })); },
  get(id) { const r = db().prepare('SELECT * FROM mcp_servers WHERE id=?').get(id); return r ? { ...r, args: p(r.args_json, []), env: p(r.env_json, {}), tools: p(r.tools_json, []) } : null; },
  create(body) {
    const id = uuid();
    db().prepare('INSERT INTO mcp_servers (id,name,transport,command,args_json,url,env_json,status,tools_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, body.name, body.transport || 'stdio', body.command || '', j(body.args || []), body.url || '', j(body.env || {}), 'disconnected', j(body.tools || []), now());
    return mcpServers.get(id);
  },
  update(id, body) {
    const cur = mcpServers.get(id); if (!cur) return null;
    db().prepare('UPDATE mcp_servers SET name=?,transport=?,command=?,args_json=?,url=?,env_json=?,status=?,tools_json=? WHERE id=?')
      .run(body.name ?? cur.name, body.transport ?? cur.transport, body.command ?? cur.command, j(body.args ?? cur.args), body.url ?? cur.url, j(body.env ?? cur.env), body.status ?? cur.status, j(body.tools ?? cur.tools), id);
    return mcpServers.get(id);
  },
  setStatus(id, status, toolsList) {
    db().prepare('UPDATE mcp_servers SET status=?,tools_json=? WHERE id=?').run(status, j(toolsList || []), id);
    return mcpServers.get(id);
  },
  remove(id) { db().prepare('DELETE FROM mcp_servers WHERE id=?').run(id); return true; }
};

// ---------- memories ----------
const memories = {
  list(layer, projectId) {
    let sql = 'SELECT * FROM memories'; const w = []; const pr = [];
    if (layer) { w.push('layer=?'); pr.push(layer); }
    if (projectId) { w.push('project_id=?'); pr.push(projectId); }
    if (w.length) sql += ' WHERE ' + w.join(' AND ');
    return db().prepare(sql).all(...pr);
  },
  set({ layer, projectId, agentId, conversationId, taskId, key, value }) {
    const ex = db().prepare('SELECT id FROM memories WHERE layer=? AND key=? AND (project_id IS ? OR project_id=?)').get(layer, key, projectId || null, projectId || null);
    if (ex) { db().prepare('UPDATE memories SET value=?,updated_at=? WHERE id=?').run(String(value), now(), ex.id); return ex.id; }
    const id = uuid();
    db().prepare('INSERT INTO memories (id,layer,project_id,agent_id,conversation_id,task_id,key,value,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, layer, projectId || null, agentId || null, conversationId || null, taskId || null, key, String(value), now(), now());
    return id;
  },
  remove(id) { db().prepare('DELETE FROM memories WHERE id=?').run(id); return true; }
};

// ---------- checkpoints / file_changes / usage / audit ----------
const checkpoints = {
  create({ projectId, taskId, kind, ref }) {
    const id = uuid();
    db().prepare('INSERT INTO checkpoints (id,project_id,task_id,kind,ref_json,created_at) VALUES (?,?,?,?,?,?)').run(id, projectId || null, taskId || null, kind || 'snapshot', j(ref || {}), now());
    return id;
  },
  list(projectId) { return db().prepare('SELECT * FROM checkpoints WHERE project_id=? ORDER BY created_at DESC').all(projectId); }
};
const fileChanges = {
  create({ projectId, taskId, agentId, path: fp, before, after, diff }) {
    const id = uuid();
    db().prepare('INSERT INTO file_changes (id,project_id,task_id,agent_id,path,before,after,diff,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId || null, taskId || null, agentId || null, fp, before || null, after || null, diff || '', now());
    return id;
  },
  list(projectId) { return db().prepare('SELECT * FROM file_changes WHERE project_id=? ORDER BY created_at DESC').all(projectId); }
};
const usage = {
  create({ provider, model, inputTokens, outputTokens, totalTokens, latencyMs, estimatedCost, agentId, connectionId, requestedModel, protocol }) {
    const id = uuid();
    // estimated_cost stays NULL when we cannot price the model. Writing 0 would
    // claim "this call was free", which is a lie the cost page then sums up.
    const cost = (estimatedCost === undefined || estimatedCost === null || Number.isNaN(Number(estimatedCost))) ? null : Number(estimatedCost);
    db().prepare('INSERT INTO usage_records (id,provider,model,input_tokens,output_tokens,total_tokens,latency_ms,estimated_cost,created_at,agent_id,connection_id,requested_model,protocol) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, provider || '', model || '', inputTokens || 0, outputTokens || 0, totalTokens || 0, latencyMs || 0, cost, now(),
        agentId || null, connectionId || null, requestedModel || null, protocol || null);
    return id;
  },
  list(limit) { return db().prepare('SELECT * FROM usage_records ORDER BY created_at DESC LIMIT ?').all(limit || 200); },
  summary() {
    const row = db().prepare(`SELECT COALESCE(SUM(total_tokens),0) AS total,
        SUM(estimated_cost) AS cost,
        SUM(CASE WHEN estimated_cost IS NULL THEN 1 ELSE 0 END) AS unpriced,
        COUNT(*) AS calls
      FROM usage_records`).get();
    // cost is NULL when nothing was priced — the UI must render 未知, not ¥0.00
    return { total: row.total, cost: row.cost === null ? null : row.cost, unpriced: row.unpriced, calls: row.calls };
  }
};

// ---------- model_calls (v2.1.0 model routing trace) ----------
const modelCalls = {
  record(r) {
    const id = uuid();
    db().prepare(`INSERT INTO model_calls
      (id,created_at,agent_id,agent_name,conversation_id,task_id,connection_id,connection_name,provider,protocol,endpoint,requested_model,actual_model,model_source,fell_back,image_parts,latency_ms,ok,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, now(), r.agentId || null, r.agentName || null, r.conversationId || null, r.taskId || null,
        r.connectionId || null, r.connectionName || null, r.provider || null, r.protocol || null, r.endpoint || null,
        r.requestedModel || null, r.actualModel || null, r.modelSource || null, r.fellBack ? 1 : 0,
        r.imageParts || 0, r.latencyMs ?? null, r.ok === false ? 0 : 1, r.error || '');
    return id;
  },
  list(limit) { return db().prepare('SELECT * FROM model_calls ORDER BY created_at DESC LIMIT ?').all(limit || 200); },
  /** Rows where the model on the wire was not what the Agent asked for. */
  mismatches(limit) {
    return db().prepare(`SELECT * FROM model_calls
      WHERE requested_model IS NOT NULL AND actual_model IS NOT NULL AND requested_model <> actual_model
      ORDER BY created_at DESC LIMIT ?`).all(limit || 50);
  },
  clear() { db().prepare('DELETE FROM model_calls').run(); return true; }
};

// ---------- permission_grants (persisted project/always decisions) ----------
// v2.9.9 Computer Use 2.0-A — 权限持久化 revision：每次 save/remove/clear 递增，
// PermissionEngine 在 evaluate 前发现 revision 变化即重新同步（live policy refresh，无需重启）。
let permissionRevision = 0;
const bumpPermissionRevision = () => { permissionRevision++; };

const permissionGrants = {
  list(projectId) {
    const rows = projectId
      ? db().prepare('SELECT * FROM permission_grants WHERE project_id IS NULL OR project_id=? ORDER BY created_at').all(projectId)
      : db().prepare('SELECT * FROM permission_grants ORDER BY created_at').all();
    return rows.map(r => ({ id: r.id, scope: r.scope, range: r.grant_range, project_id: r.project_id, created_at: r.created_at }));
  },
  revision() { return permissionRevision; },
  save({ scope, range, projectId }) {
    if (range !== 'project' && range !== 'always' && range !== 'deny') return null;
    const pid = range === 'project' ? (projectId || null) : null;
    const ex = db().prepare('SELECT id FROM permission_grants WHERE scope=? AND (project_id IS ? OR project_id=?)').get(scope, pid, pid);
    if (ex) { db().prepare('UPDATE permission_grants SET grant_range=?,created_at=? WHERE id=?').run(range, now(), ex.id); bumpPermissionRevision(); return ex.id; }
    const id = uuid();
    db().prepare('INSERT INTO permission_grants (id,scope,grant_range,project_id,created_at) VALUES (?,?,?,?,?)').run(id, scope, range, pid, now());
    bumpPermissionRevision();
    return id;
  },
  remove(id) { db().prepare('DELETE FROM permission_grants WHERE id=?').run(id); bumpPermissionRevision(); return true; },
  clear() { db().prepare('DELETE FROM permission_grants').run(); bumpPermissionRevision(); return true; },
  // v2.9.9 CU2-A.1 §6：removeScope 去歧义——只删除该 project 的 project 行，绝不顺带删 global。
  // （deprecated：新代码请用 removeProjectPolicy / removeGlobalPolicy。）
  removeScope(scope, projectId) { return this.removeProjectPolicy(scope, projectId); },
  removeProjectPolicy(scope, projectId) {
    const pid = projectId || null;
    const rows = db().prepare('SELECT id FROM permission_grants WHERE scope=? AND project_id IS ?').all(scope, pid);
    for (const r of rows) db().prepare('DELETE FROM permission_grants WHERE id=?').run(r.id);
    bumpPermissionRevision();
    return rows.length;
  },
  removeGlobalPolicy(scope) {
    const rows = db().prepare('SELECT id FROM permission_grants WHERE scope=? AND project_id IS NULL').all(scope);
    for (const r of rows) db().prepare('DELETE FROM permission_grants WHERE id=?').run(r.id);
    bumpPermissionRevision();
    return rows.length;
  },
  replaceGlobalPolicy(scope, range) {
    this.removeGlobalPolicy(scope);
    if (range === 'always' || range === 'deny') return this.save({ scope, range, projectId: null });
    return null; // ask → 无 global grant
  },
  replaceProjectPolicy(scope, projectId, range) {
    this.removeProjectPolicy(scope, projectId);
    if (range === 'project') return this.save({ scope, range: 'project', projectId });
    return null; // ask → 无 project grant
  },
  // 用单一持久策略替换某 scope（先删旧行再写新行；ASK 等价于删除）。
  replacePolicy(scope, range, projectId) {
    this.removeScope(scope, projectId);
    if (range === 'always' || range === 'deny') return this.save({ scope, range, projectId: null });
    if (range === 'project') return this.save({ scope, range, projectId });
    return null; // ask → 无持久 grant
  },
  // 当前对某 scope 的生效持久策略（global deny > global always > matching project）。
  effectivePolicy(scope, projectId) {
    const rows = this.list(projectId || null);
    const rel = rows.filter(r => r.scope === scope);
    const g = rel.find(r => !r.project_id && r.range === 'deny'); if (g) return 'deny';
    const a = rel.find(r => !r.project_id && r.range === 'always'); if (a) return 'always';
    const p = rel.find(r => r.project_id && r.range === 'project'); if (p) return 'project';
    return 'ask';
  }
};
const audit = {
  record({ agent, task, tool, target, permission, result }) {
    const id = uuid();
    db().prepare('INSERT INTO permissions_audit (id,time,agent,task,tool,target,permission,result) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, now(), agent || '', task || '', tool || '', target || '', permission || '', result || '');
    return id;
  },
  list(limit) { return db().prepare('SELECT * FROM permissions_audit ORDER BY time DESC LIMIT ?').all(limit || 200); }
};
const permissionDecisions = {
  record({ runId, agentId, risk, operation, decision, decisionSource, command } = {}) {
    const id = uuid();
    db().prepare('INSERT INTO permission_decisions (id,time,run_id,agent_id,risk,operation,decision,decision_source,command) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, now(), runId || '', agentId || '', risk || '', operation || '', decision || '', decisionSource || '', command || '');
    return id;
  },
  list(limit) { return db().prepare('SELECT * FROM permission_decisions ORDER BY time DESC LIMIT ?').all(limit || 200); }
};

// ---------- model route decisions (v2.9.2) ----------
function routeDecisionRow(row) {
  return row ? {
    ...row,
    requirements: p(row.requirements_json, {}),
    reasons: p(row.reasons_json, []),
    rejectedCandidates: p(row.rejected_json, [])
  } : null;
}

const modelRouteDecisions = {
  record(input = {}) {
    const value = sanitizePublic(input);
    const id = uuid(); const t = now();
    db().prepare(`INSERT INTO model_route_decisions
      (id,run_id,conversation_id,root_run_id,parent_run_id,agent_id,connection_id,model_id,mode,requirements_json,score,reasons_json,rejected_json,status,latency_ms,input_tokens,output_tokens,error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, value.runId || null, value.conversationId || null, value.rootRunId || null, value.parentRunId || null,
        value.agentId || null, value.connectionId || null, value.modelId || null,
        value.mode || 'auto', j(value.requirements || {}), value.score ?? null, j(value.reasons || []),
        j(value.rejectedCandidates || []), value.status || 'routed', value.latencyMs ?? null,
        value.inputTokens ?? null, value.outputTokens ?? null, value.errorCode || null, t, t);
    return id;
  },
  get(id) { return routeDecisionRow(db().prepare('SELECT * FROM model_route_decisions WHERE id=?').get(id)); },
  list(limit = 100) {
    return db().prepare('SELECT * FROM model_route_decisions ORDER BY created_at DESC LIMIT ?').all(limit).map(routeDecisionRow);
  },
  updateOutcome(id, input = {}) {
    const value = sanitizePublic(input);
    const result = db().prepare(`UPDATE model_route_decisions SET status=?,latency_ms=?,input_tokens=?,output_tokens=?,error_code=?,updated_at=? WHERE id=?`)
      .run(value.status || 'unknown', value.latencyMs ?? null, value.inputTokens ?? null,
        value.outputTokens ?? null, value.errorCode || null, now(), id);
    return result.changes > 0;
  },
  /** B16.3 — Wire Truth：记录请求模型与真实上线模型（selected != wire 由调用方裁决）。 */
  recordWireModel(id, { requested = null, actual = null } = {}) {
    const result = db().prepare('UPDATE model_route_decisions SET requested_model=?,actual_model=?,updated_at=? WHERE id=?')
      .run(requested || null, actual || null, now(), id);
    return result.changes > 0;
  },
  bindRunIdentity(id, identity = {}) {
    if (!identity.runId || typeof identity.runId !== 'string') return false;
    const result = db().prepare(`UPDATE model_route_decisions
      SET run_id=?,conversation_id=COALESCE(?,conversation_id),root_run_id=COALESCE(?,root_run_id),parent_run_id=COALESCE(?,parent_run_id),updated_at=?
      WHERE id=? AND (run_id IS NULL OR run_id=?)`)
      .run(identity.runId, identity.conversationId || null, identity.rootRunId || null,
        identity.parentRunId || null, now(), id, identity.runId);
    return result.changes > 0;
  }
};

// ---------- settings ----------
const settings = {
  get(key, def) { const r = db().prepare('SELECT value_json FROM settings WHERE key=?').get(key); return r ? p(r.value_json, def) : def; },
  set(key, value) { db().prepare('INSERT INTO settings (key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=?').run(key, j(value), j(value)); return value; },
  all() { const rows = db().prepare('SELECT key,value_json FROM settings').all(); const o = {}; rows.forEach(r => o[r.key] = p(r.value_json, null)); return o; }
};

// ---------- problems (v2.9.9 Phase B Final B21) ----------
function problemRow(r) {
  return r ? { ...r, related: p(r.related_json, {}) } : null;
}
const problems = {
  create(input) {
    const id = uuid(); const t = now();
    db().prepare(`INSERT INTO problems (id,stable_key,time,last_seen_at,severity,source,code,message,run_id,project_id,related_json,status,occur_count,resolved_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`)
      .run(id, input.stableKey, t, t, input.severity, input.source, input.code, input.message || '',
        input.runId || null, input.projectId || null, j(input.related || {}), input.status || 'ACTIVE', t, t);
    return problemRow(db().prepare('SELECT * FROM problems WHERE id=?').get(id));
  },
  /** 同一稳定问题的重复上报：只累加计数与刷新 last_seen，绝不新建刷屏条目。 */
  reoccur(id, message) {
    db().prepare('UPDATE problems SET occur_count=occur_count+1,last_seen_at=?,message=?,updated_at=? WHERE id=?')
      .run(now(), message ?? db().prepare('SELECT message FROM problems WHERE id=?').get(id)?.message ?? '', now(), id);
    return problemRow(db().prepare('SELECT * FROM problems WHERE id=?').get(id));
  },
  findOpenByStableKey(stableKey) {
    const r = db().prepare("SELECT * FROM problems WHERE stable_key=? AND status IN ('ACTIVE','DISMISSED') ORDER BY created_at DESC LIMIT 1").get(stableKey);
    return problemRow(r);
  },
  setStatus(id, status) {
    const resolvedAt = status === 'RESOLVED' ? now() : null;
    db().prepare('UPDATE problems SET status=?,resolved_at=?,updated_at=? WHERE id=?').run(status, resolvedAt, now(), id);
    return problemRow(db().prepare('SELECT * FROM problems WHERE id=?').get(id));
  },
  get(id) { return problemRow(db().prepare('SELECT * FROM problems WHERE id=?').get(id)); },
  list({ status = null, limit = 200 } = {}) {
    const rows = status
      ? db().prepare('SELECT * FROM problems WHERE status=? ORDER BY last_seen_at DESC LIMIT ?').all(status, limit)
      : db().prepare("SELECT * FROM problems WHERE status IN ('ACTIVE','DISMISSED') ORDER BY last_seen_at DESC LIMIT ?").all(limit);
    return rows.map(problemRow);
  },
  countActive() {
    return db().prepare("SELECT COUNT(*) AS n FROM problems WHERE status='ACTIVE'").get().n;
  },
  /** 有界保留：RESOLVED 只保留最近 N 条，避免无限增长。 */
  pruneResolved(keep = 200) {
    db().prepare(`DELETE FROM problems WHERE status='RESOLVED' AND id NOT IN (
      SELECT id FROM problems WHERE status='RESOLVED' ORDER BY resolved_at DESC LIMIT ?)`).run(keep);
    return true;
  }
};

// v2.7.0 — Agent Hub preferences（持久化在 settings 表的 agent_hub_prefs 键）
const agentPrefs = {
  get() {
    const row = db().prepare('SELECT value_json FROM settings WHERE key=?').get('agent_hub_prefs');
    return row ? p(row.value_json, {}) : {};
  },
  set(prefs) {
    const t = now();
    const existing = db().prepare('SELECT key FROM settings WHERE key=?').get('agent_hub_prefs');
    if (existing) {
      db().prepare('UPDATE settings SET value_json=? WHERE key=?').run(j(prefs), 'agent_hub_prefs');
    } else {
      db().prepare('INSERT INTO settings (key, value_json) VALUES (?,?)').run('agent_hub_prefs', j(prefs));
    }
    return prefs;
  },
  getRoutingMode() { return agentPrefs.get().routingMode || 'auto'; },
  getPreferredAgent() { return agentPrefs.get().preferredAgent || null; },
  getDisabledAgents() { return agentPrefs.get().disabledAgents || []; },
  setRoutingMode(mode) { const p = agentPrefs.get(); p.routingMode = mode; return agentPrefs.set(p); },
  setPreferredAgent(agentId) { const p = agentPrefs.get(); p.preferredAgent = agentId; return agentPrefs.set(p); },
  toggleAgentDisabled(agentId, disabled) {
    const p = agentPrefs.get();
    p.disabledAgents = p.disabledAgents || [];
    if (disabled && !p.disabledAgents.includes(agentId)) p.disabledAgents.push(agentId);
    if (!disabled) p.disabledAgents = p.disabledAgents.filter(id => id !== agentId);
    return agentPrefs.set(p);
  }
};

// v2.7.1 — External agent configurations（每个外部 Agent 的配置持久化在 settings 表）
const extAgentConfigs = {
  get(agentId) {
    const row = db().prepare('SELECT value_json FROM settings WHERE key=?').get('ext_agent_' + agentId);
    return row ? p(row.value_json, {}) : {};
  },
  set(agentId, config) {
    const existing = db().prepare('SELECT key FROM settings WHERE key=?').get('ext_agent_' + agentId);
    if (existing) {
      db().prepare('UPDATE settings SET value_json=? WHERE key=?').run(j(config), 'ext_agent_' + agentId);
    } else {
      db().prepare('INSERT INTO settings (key, value_json) VALUES (?,?)').run('ext_agent_' + agentId, j(config));
    }
    return config;
  },
  getCline() { return extAgentConfigs.get('cline'); },
  setCline(config) { return extAgentConfigs.set('cline', config); },
  getOpenCode() { return extAgentConfigs.get('opencode'); },
  setOpenCode(config) { return extAgentConfigs.set('opencode', config); },
  getOpenHands() { return extAgentConfigs.get('openhands'); },
  setOpenHands(config) { return extAgentConfigs.set('openhands', config); },
  // v2.8.0 — Claude Code（runtimeMode / model / permissionMode / allowedTools 等）
  getClaudeCode() { return extAgentConfigs.get('claude-code'); },
  setClaudeCode(config) { return extAgentConfigs.set('claude-code', config); }
};

// ---------- runs (v2.3.1: Run 持久化，重启后把非终态标记为 interrupted) ----------
const runs = {
  upsert(run) {
    const ex = db().prepare('SELECT id FROM runs WHERE id=?').get(run.id);
    const t = now();
    // v2.9.0 §116：Run Tree 字段（parent_run_id 已有列但 v2.7 未写入；root_run_id/depth 新增）
    const parentRunId = run.parentRunId || null;
    const rootRunId = run.rootRunId || null;
    const depth = run.depth || 0;
    const adapterId = run.adapterId || run.adapterType || '';
    if (ex) {
      db().prepare(`UPDATE runs SET conversation_id=?,agent_id=?,task_id=?,status=?,stage=?,
        started_at=?,updated_at=?,last_activity_at=?,terminal_at=?,error=?,message=?,
        parent_run_id=?,root_run_id=?,depth=?,adapter_id=? WHERE id=?`)
        .run(run.conversationId || null, run.agentId || null, run.taskId || null, run.status, run.stage,
          run.startedAt ? new Date(run.startedAt).toISOString() : t, t,
          run.lastActivityAt ? new Date(run.lastActivityAt).toISOString() : t,
          run.terminalAt ? new Date(run.terminalAt).toISOString() : null,
          run.error || '', run.message || '',
          parentRunId, rootRunId, depth, adapterId, run.id);
    } else {
      db().prepare(`INSERT INTO runs (id,conversation_id,agent_id,task_id,status,stage,
        started_at,updated_at,last_activity_at,terminal_at,error,message,
        parent_run_id,root_run_id,depth,adapter_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(run.id, run.conversationId || null, run.agentId || null, run.taskId || null, run.status, run.stage,
          new Date(run.startedAt || Date.now()).toISOString(), t, t,
          run.terminalAt ? new Date(run.terminalAt).toISOString() : null,
          run.error || '', run.message || '',
          parentRunId, rootRunId, depth, adapterId);
    }
    return runs.get(run.id);
  },
  get(id) { return db().prepare('SELECT * FROM runs WHERE id=?').get(id); },
  list(limit) { return db().prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit || 100); },
  /** 尚未终态的 Run（应用启动时用于恢复 interrupted）。 */
  listNonTerminal() {
    return db().prepare("SELECT * FROM runs WHERE status NOT IN ('completed','failed','cancelled','timeout','interrupted')").all();
  },
  updateStatus(id, patch) {
    const ex = db().prepare('SELECT id FROM runs WHERE id=?').get(id); if (!ex) return null;
    db().prepare(`UPDATE runs SET status=?,stage=?,terminal_at=?,updated_at=?,error=?,message=? WHERE id=?`)
      .run(patch.status ?? ex.status, patch.stage ?? ex.stage,
        patch.terminalAt ? new Date(patch.terminalAt).toISOString() : ex.terminal_at, now(),
        patch.error ?? ex.error, patch.message ?? ex.message, id);
    return runs.get(id);
  },
  /**
   * v2.9.9 Phase B PART A（A1）— Verification Truth 持久化。
   * 只写验证证据列，绝不触碰 run.status（两个独立事实，互不推导）。
   * 词汇表外的值一律拒绝（fail-closed）。
   */
  setVerification(id, verificationStatus) {
    const v = String(verificationStatus || '').toUpperCase();
    if (!['PASS', 'FAIL', 'NOT_AVAILABLE', 'NOT_VERIFIED', 'RUNNING', 'UNKNOWN'].includes(v)) return null;
    const ex = db().prepare('SELECT id FROM runs WHERE id=?').get(id); if (!ex) return null;
    db().prepare('UPDATE runs SET verification_status=?, updated_at=? WHERE id=?').run(v, now(), id);
    return runs.get(id);
  },
  remove(id) { db().prepare('DELETE FROM runs WHERE id=?').run(id); return true; }
};

// ---------- v2.8.0 external agent sessions（spec §109/§110/§111） ----------
/** 时间戳归一：toPersistable 给的是 epoch ms，这里统一转 ISO 字符串。 */
function iso(v) {
  if (!v) return now();
  if (typeof v === 'string') return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? now() : d.toISOString();
}

const externalAgentSessions = {
  /** 幂等落库（id 为主键，agent_id+external_session_id 唯一）。只接受无凭据字段。 */
  upsert(rec) {
    if (!rec || !rec.id || !rec.agent_id || !rec.external_session_id) return null;
    db().prepare(`INSERT INTO external_agent_sessions
      (id,agent_id,external_session_id,project_id,project_root,transport,resumable,created_at,updated_at,last_status,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id, project_root=excluded.project_root,
        transport=excluded.transport, resumable=excluded.resumable,
        updated_at=excluded.updated_at, last_status=excluded.last_status,
        metadata_json=excluded.metadata_json`)
      .run(rec.id, rec.agent_id, rec.external_session_id, rec.project_id || null, rec.project_root || null,
        rec.transport || '', rec.resumable ? 1 : 0, iso(rec.created_at), iso(rec.updated_at),
        rec.last_status || '', rec.metadata_json || '{}');
    return externalAgentSessions.get(rec.id);
  },
  get(id) {
    const r = db().prepare('SELECT * FROM external_agent_sessions WHERE id=?').get(id);
    return r ? { ...r, resumable: !!r.resumable, metadata: p(r.metadata_json, {}) } : null;
  },
  getByExternal(agentId, externalSessionId) {
    const r = db().prepare('SELECT * FROM external_agent_sessions WHERE agent_id=? AND external_session_id=?')
      .get(agentId, externalSessionId);
    return r ? { ...r, resumable: !!r.resumable, metadata: p(r.metadata_json, {}) } : null;
  },
  list(agentId) {
    const rows = agentId
      ? db().prepare('SELECT * FROM external_agent_sessions WHERE agent_id=? ORDER BY updated_at DESC').all(agentId)
      : db().prepare('SELECT * FROM external_agent_sessions ORDER BY updated_at DESC').all();
    return rows.map(r => ({ ...r, resumable: !!r.resumable, metadata: p(r.metadata_json, {}) }));
  },
  remove(id) { db().prepare('DELETE FROM external_agent_sessions WHERE id=?').run(id); return true; }
};

// ---------- v2.8.0 external agent auth states（spec §110；只存状态，不存凭据） ----------
const externalAgentAuthStates = {
  set(agentId, { state, mode, detail } = {}) {
    if (!agentId) return null;
    db().prepare(`INSERT INTO external_agent_auth_states (agent_id,state,mode,detail,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET state=excluded.state, mode=excluded.mode,
        detail=excluded.detail, updated_at=excluded.updated_at`)
      .run(agentId, state || 'UNKNOWN', mode || '', detail || '', now());
    return externalAgentAuthStates.get(agentId);
  },
  get(agentId) { return db().prepare('SELECT * FROM external_agent_auth_states WHERE agent_id=?').get(agentId) || null; },
  list() { return db().prepare('SELECT * FROM external_agent_auth_states ORDER BY agent_id').all(); }
};

// ---------- P4 external Agent verification evidence (sanitized only) ----------
const externalAgentVerificationEvidence = {
  append(rec) {
    if (!rec || !rec.verificationId || !rec.agentId) return null;
    db().prepare(`INSERT OR IGNORE INTO external_agent_verification_evidence
      (verification_id,agent_id,type,status,project_fingerprint,timestamp,evidence_json)
      VALUES (?,?,?,?,?,?,?)`)
      .run(rec.verificationId, rec.agentId, rec.type || 'unknown', rec.status || 'skipped',
        rec.projectFingerprint || '', rec.timestamp || now(), j(rec));
    return rec;
  },
  list(agentId) {
    const rows = agentId
      ? db().prepare('SELECT evidence_json FROM external_agent_verification_evidence WHERE agent_id=? ORDER BY timestamp').all(agentId)
      : db().prepare('SELECT evidence_json FROM external_agent_verification_evidence ORDER BY timestamp').all();
    return rows.map(row => p(row.evidence_json, null)).filter(Boolean);
  },
  clear(agentId) {
    if (agentId) db().prepare('DELETE FROM external_agent_verification_evidence WHERE agent_id=?').run(agentId);
  }
};

// ---------- v2.9.1 dynamic agent definitions/templates ----------
const agentDefinitions = {
  create(input) {
    const { normalizeAgentDefinition } = require('../agents/dynamic/agentDefinition');
    const definition = normalizeAgentDefinition(input);
    const t = now();
    db().prepare('INSERT INTO agent_definitions (id,definition_json,created_at,updated_at) VALUES (?,?,?,?)')
      .run(definition.id, j(definition), t, t);
    return agentDefinitions.get(definition.id);
  },
  get(id) {
    const row = db().prepare('SELECT * FROM agent_definitions WHERE id=?').get(id);
    return row ? p(row.definition_json, null) : null;
  },
  list() {
    return db().prepare('SELECT * FROM agent_definitions ORDER BY created_at').all()
      .map(row => p(row.definition_json, null)).filter(Boolean);
  },
  update(id, patch) {
    const current = agentDefinitions.get(id);
    if (!current) return null;
    const { normalizeAgentDefinition } = require('../agents/dynamic/agentDefinition');
    const definition = normalizeAgentDefinition(Object.assign({}, current, patch || {}, { id }));
    db().prepare('UPDATE agent_definitions SET definition_json=?,updated_at=? WHERE id=?')
      .run(j(definition), now(), id);
    return agentDefinitions.get(id);
  },
  remove(id, options = {}) {
    if (options.inUse) {
      const error = new Error('AGENT_DEFINITION_IN_USE');
      error.code = 'AGENT_DEFINITION_IN_USE';
      throw error;
    }
    return db().prepare('DELETE FROM agent_definitions WHERE id=?').run(id).changes > 0;
  }
};

const agentTemplates = {
  create(input) {
    const { normalizeAgentTemplate } = require('../agents/dynamic/agentTemplate');
    const template = normalizeAgentTemplate(input);
    const t = now();
    db().prepare('INSERT INTO agent_templates (id,template_json,created_at,updated_at) VALUES (?,?,?,?)')
      .run(template.id, j(template), t, t);
    return agentTemplates.get(template.id);
  },
  get(id) {
    const row = db().prepare('SELECT * FROM agent_templates WHERE id=?').get(id);
    return row ? p(row.template_json, null) : null;
  },
  list() {
    return db().prepare('SELECT * FROM agent_templates ORDER BY created_at').all()
      .map(row => p(row.template_json, null)).filter(Boolean);
  },
  remove(id) { return db().prepare('DELETE FROM agent_templates WHERE id=?').run(id).changes > 0; }
};

// ---------- v2.9.3 skill definitions (persistent SkillDefinition only) ----------
// Runtime Skill Context (instructions/tool/permission/model requirements) is derived
// at resolve time and never persisted; the stored record is the normalized definition.
const skillDefinitions = {
  create(input) {
    const { normalizeSkillDefinition } = require('../skills/skillDefinition');
    const definition = normalizeSkillDefinition(input);
    const t = now();
    db().prepare('INSERT INTO skill_definitions (id,definition_json,enabled,created_at,updated_at) VALUES (?,?,1,?,?)')
      .run(definition.id, j(definition), t, t);
    return skillDefinitions.get(definition.id);
  },
  get(id) {
    const row = db().prepare('SELECT * FROM skill_definitions WHERE id=?').get(id);
    return row ? { ...p(row.definition_json, null), enabled: row.enabled === 1, source: 'user' } : null;
  },
  list() {
    return db().prepare('SELECT * FROM skill_definitions ORDER BY id').all()
      .map(row => ({ ...p(row.definition_json, null), enabled: row.enabled === 1, source: 'user' })).filter(Boolean);
  },
  update(id, patch) {
    const current = skillDefinitions.get(id);
    if (!current) return null;
    const { normalizeSkillDefinition } = require('../skills/skillDefinition');
    const definition = normalizeSkillDefinition(Object.assign({}, current, patch || {}, { id }));
    db().prepare('UPDATE skill_definitions SET definition_json=?,updated_at=? WHERE id=?')
      .run(j(definition), now(), id);
    return skillDefinitions.get(id);
  },
  remove(id) { return db().prepare('DELETE FROM skill_definitions WHERE id=?').run(id).changes > 0; },
  setEnabled(id, enabled) {
    const row = db().prepare('SELECT id FROM skill_definitions WHERE id=?').get(id);
    if (!row) return null;
    db().prepare('UPDATE skill_definitions SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, now(), id);
    return skillDefinitions.get(id);
  }
};

// ---------- v2.9.4 hook definitions + invocation audit ----------
// Only normalized HookDefinition JSON and handlerId persist. Trusted functions
// are registered in-memory by HookHandlerRegistry and intentionally disappear
// across process restarts.
const hookDefinitions = {
  create(input) {
    const { normalizeHookDefinition } = require('../hooks/hookDefinition');
    const definition = normalizeHookDefinition(input);
    const t = now();
    db().prepare('INSERT INTO hook_definitions (id,definition_json,enabled,created_at,updated_at) VALUES (?,?,1,?,?)')
      .run(definition.id, j(definition), t, t);
    return hookDefinitions.get(definition.id);
  },
  get(id) {
    const row = db().prepare('SELECT * FROM hook_definitions WHERE id=?').get(id);
    return row ? { ...p(row.definition_json, null), enabled: row.enabled === 1 } : null;
  },
  list() {
    return db().prepare('SELECT * FROM hook_definitions ORDER BY id').all()
      .map(row => ({ ...p(row.definition_json, null), enabled: row.enabled === 1 })).filter(Boolean);
  },
  update(id, input) {
    if (!hookDefinitions.get(id)) return null;
    const { normalizeHookDefinition } = require('../hooks/hookDefinition');
    const definition = normalizeHookDefinition({ ...(input || {}), id });
    db().prepare('UPDATE hook_definitions SET definition_json=?,updated_at=? WHERE id=?')
      .run(j(definition), now(), id);
    return hookDefinitions.get(id);
  },
  remove(id) { return db().prepare('DELETE FROM hook_definitions WHERE id=?').run(id).changes > 0; },
  setEnabled(id, enabled) {
    if (!hookDefinitions.get(id)) return null;
    db().prepare('UPDATE hook_definitions SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, now(), id);
    return hookDefinitions.get(id);
  }
};

const hookInvocations = {
  create(input) {
    const t = input.createdAt || now();
    db().prepare(`INSERT INTO hook_invocations
      (invocation_id,hook_id,event,run_id,root_run_id,parent_run_id,workflow_run_id,workflow_step_id,agent_id,outcome,error_code,duration_ms,tool_name,action_type,annotations_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.invocationId, input.hookId, input.event, input.runId || null,
        input.rootRunId || input.runId || null, input.parentRunId || null,
        input.workflowRunId || null, input.workflowStepId || null, input.agentId || null,
        input.outcome || 'unknown', input.errorCode || null, input.durationMs || 0,
        input.toolName || null, input.actionType || null, j(input.annotations || {}), t);
    return hookInvocations.get(input.invocationId);
  },
  get(invocationId) {
    const row = db().prepare('SELECT * FROM hook_invocations WHERE invocation_id=?').get(invocationId);
    return row ? { ...row, annotations: p(row.annotations_json, {}) } : null;
  },
  list(limit = 100) {
    return db().prepare('SELECT * FROM hook_invocations ORDER BY created_at DESC LIMIT ?').all(limit)
      .map(row => ({ ...row, annotations: p(row.annotations_json, {}) }));
  },
  listByRun(runId) {
    return db().prepare('SELECT * FROM hook_invocations WHERE run_id=? ORDER BY created_at,invocation_id').all(runId)
      .map(row => ({ ...row, annotations: p(row.annotations_json, {}) }));
  }
};

// ---------- v2.9.5 workflow definitions, executions, steps, and audit ----------
const workflowDefinitions = {
  create(input) {
    const { normalizeWorkflowDefinition } = require('../workflows/workflowDefinition');
    const definition = normalizeWorkflowDefinition(input);
    const t = now();
    db().prepare('INSERT INTO workflow_definitions (id,definition_json,enabled,created_at,updated_at) VALUES (?,?,1,?,?)')
      .run(definition.id, j(definition), t, t);
    return workflowDefinitions.get(definition.id);
  },
  get(id) {
    const row = db().prepare('SELECT * FROM workflow_definitions WHERE id=?').get(id);
    return row ? { ...p(row.definition_json, null), enabled: row.enabled === 1 } : null;
  },
  list() {
    return db().prepare('SELECT * FROM workflow_definitions ORDER BY id').all()
      .map(row => ({ ...p(row.definition_json, null), enabled: row.enabled === 1 })).filter(Boolean);
  },
  update(id, input) {
    if (!workflowDefinitions.get(id)) return null;
    const { normalizeWorkflowDefinition } = require('../workflows/workflowDefinition');
    const definition = normalizeWorkflowDefinition({ ...(input || {}), id });
    db().prepare('UPDATE workflow_definitions SET definition_json=?,updated_at=? WHERE id=?')
      .run(j(definition), now(), id);
    return workflowDefinitions.get(id);
  },
  remove(id) {
    return db().prepare('DELETE FROM workflow_definitions WHERE id=?').run(id).changes > 0;
  },
  setEnabled(id, enabled) {
    if (!workflowDefinitions.get(id)) return null;
    db().prepare('UPDATE workflow_definitions SET enabled=?,updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, now(), id);
    return workflowDefinitions.get(id);
  }
};

function workflowExecutionFromRow(row) {
  return row ? {
    workflowRunId: row.workflow_run_id,
    workflowId: row.workflow_id,
    status: row.status,
    projectId: row.project_id,
    projectRoot: row.project_root,
    conversationId: row.conversation_id,
    currentStepId: row.current_step_id,
    input: p(row.input_json, {}),
    output: p(row.output_json, {}),
    errorCode: row.error_code,
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at
  } : null;
}

const workflowExecutions = {
  create(input) {
    const t = input.startedAt || now();
    db().prepare(
      'INSERT INTO workflow_executions ' +
      '(workflow_run_id,workflow_id,status,project_id,project_root,conversation_id,current_step_id,input_json,output_json,error_code,error,started_at,updated_at,terminal_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(input.workflowRunId, input.workflowId, input.status, input.projectId || null,
      input.projectRoot || null, input.conversationId || null, input.currentStepId || null,
      j(input.input || {}), j(input.output || {}), input.errorCode || null, input.error || null,
      t, input.updatedAt || t, input.terminalAt || null);
    return workflowExecutions.get(input.workflowRunId);
  },
  get(workflowRunId) {
    return workflowExecutionFromRow(
      db().prepare('SELECT * FROM workflow_executions WHERE workflow_run_id=?').get(workflowRunId)
    );
  },
  list(limit = 100) {
    return db().prepare('SELECT * FROM workflow_executions ORDER BY started_at DESC LIMIT ?').all(limit)
      .map(workflowExecutionFromRow);
  },
  update(workflowRunId, patch) {
    const current = workflowExecutions.get(workflowRunId);
    if (!current) return null;
    const next = { ...current, ...(patch || {}), updatedAt: (patch && patch.updatedAt) || now() };
    db().prepare(
      'UPDATE workflow_executions SET status=?,project_id=?,project_root=?,conversation_id=?,' +
      'current_step_id=?,input_json=?,output_json=?,error_code=?,error=?,updated_at=?,terminal_at=? ' +
      'WHERE workflow_run_id=?'
    ).run(next.status, next.projectId || null, next.projectRoot || null, next.conversationId || null,
      next.currentStepId || null, j(next.input || {}), j(next.output || {}), next.errorCode || null,
      next.error || null, next.updatedAt, next.terminalAt || null, workflowRunId);
    return workflowExecutions.get(workflowRunId);
  }
};

function workflowStepFromRow(row) {
  return row ? {
    workflowRunId: row.workflow_run_id,
    stepId: row.step_id,
    stepType: row.step_type,
    status: row.status,
    attempt: row.attempt,
    runId: row.run_id,
    childRunId: row.child_run_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    result: p(row.result_json, {}),
    errorCode: row.error_code,
    error: row.error
  } : null;
}

const workflowStepExecutions = {
  create(input) {
    const t = input.updatedAt || now();
    db().prepare(
      'INSERT INTO workflow_step_executions ' +
      '(workflow_run_id,step_id,step_type,status,attempt,run_id,child_run_id,started_at,updated_at,terminal_at,result_json,error_code,error) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(input.workflowRunId, input.stepId, input.stepType, input.status, input.attempt || 0,
      input.runId || null, input.childRunId || null, input.startedAt || null, t,
      input.terminalAt || null, j(input.result || {}), input.errorCode || null, input.error || null);
    return workflowStepExecutions.get(input.workflowRunId, input.stepId);
  },
  get(workflowRunId, stepId) {
    return workflowStepFromRow(db().prepare(
      'SELECT * FROM workflow_step_executions WHERE workflow_run_id=? AND step_id=?'
    ).get(workflowRunId, stepId));
  },
  listByRun(workflowRunId) {
    return db().prepare('SELECT * FROM workflow_step_executions WHERE workflow_run_id=? ORDER BY step_id')
      .all(workflowRunId).map(workflowStepFromRow);
  },
  update(workflowRunId, stepId, patch) {
    const current = workflowStepExecutions.get(workflowRunId, stepId);
    if (!current) return null;
    const next = { ...current, ...(patch || {}), updatedAt: (patch && patch.updatedAt) || now() };
    db().prepare(
      'UPDATE workflow_step_executions SET status=?,attempt=?,run_id=?,child_run_id=?,' +
      'started_at=?,updated_at=?,terminal_at=?,result_json=?,error_code=?,error=? ' +
      'WHERE workflow_run_id=? AND step_id=?'
    ).run(next.status, next.attempt || 0, next.runId || null, next.childRunId || null,
      next.startedAt || null, next.updatedAt, next.terminalAt || null, j(next.result || {}),
      next.errorCode || null, next.error || null, workflowRunId, stepId);
    return workflowStepExecutions.get(workflowRunId, stepId);
  }
};

const workflowAudit = {
  create(input) {
    db().prepare(
      'INSERT INTO workflow_audit ' +
      '(audit_id,workflow_run_id,workflow_id,step_id,step_type,status,attempt,run_id,child_run_id,error_code,duration_ms,detail_json,created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(input.auditId, input.workflowRunId, input.workflowId, input.stepId || null,
      input.stepType || null, input.status, input.attempt || 0, input.runId || null,
      input.childRunId || null, input.errorCode || null, input.durationMs || 0,
      j(input.detail || {}), input.createdAt || now());
    return workflowAudit.get(input.auditId);
  },
  get(auditId) {
    const row = db().prepare('SELECT * FROM workflow_audit WHERE audit_id=?').get(auditId);
    return row ? { ...row, detail: p(row.detail_json, {}) } : null;
  },
  list(limit = 100) {
    return db().prepare('SELECT * FROM workflow_audit ORDER BY created_at DESC LIMIT ?').all(limit)
      .map(row => ({ ...row, detail: p(row.detail_json, {}) }));
  },
  listByRun(workflowRunId) {
    return db().prepare('SELECT * FROM workflow_audit WHERE workflow_run_id=? ORDER BY created_at,audit_id')
      .all(workflowRunId).map(row => ({ ...row, detail: p(row.detail_json, {}) }));
  }
};

function generatorDraftFromRow(row) {
  return row ? {
    draftId: row.draft_id,
    generationId: row.generation_id,
    artifactType: row.artifact_type,
    status: row.status,
    candidate: p(row.candidate_json, null),
    validation: p(row.validation_json, { valid: false, errors: [], warnings: [] }),
    attempts: row.attempts || 0,
    repairCount: row.repair_count || 0,
    selectedModel: row.selected_connection_id || row.selected_model_id ? {
      connectionId: row.selected_connection_id,
      modelId: row.selected_model_id
    } : null,
    routeDecisionId: row.route_decision_id,
    errorCode: row.error_code,
    error: row.error,
    savedArtifactId: row.saved_artifact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at
  } : null;
}

const generatorDrafts = {
  create(input) {
    const t = input.createdAt || now();
    db().prepare(
      'INSERT INTO generator_drafts ' +
      '(draft_id,generation_id,artifact_type,status,candidate_json,validation_json,attempts,repair_count,selected_connection_id,selected_model_id,route_decision_id,error_code,error,saved_artifact_id,created_at,updated_at,terminal_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(input.draftId, input.generationId, input.artifactType, input.status,
      input.candidate === null || input.candidate === undefined ? null : j(input.candidate),
      j(input.validation || { valid: false, errors: [], warnings: [] }), input.attempts || 0,
      input.repairCount || 0, input.selectedModel && input.selectedModel.connectionId || null,
      input.selectedModel && input.selectedModel.modelId || null, input.routeDecisionId || null,
      input.errorCode || null, input.error || null, input.savedArtifactId || null,
      t, input.updatedAt || t, input.terminalAt || null);
    return generatorDrafts.get(input.draftId);
  },
  get(draftId) {
    return generatorDraftFromRow(db().prepare('SELECT * FROM generator_drafts WHERE draft_id=?').get(draftId));
  },
  list(limit = 100) {
    return db().prepare('SELECT * FROM generator_drafts ORDER BY created_at DESC LIMIT ?').all(limit).map(generatorDraftFromRow);
  },
  update(draftId, patch) {
    const current = generatorDrafts.get(draftId);
    if (!current) return null;
    const next = { ...current, ...(patch || {}), updatedAt: patch && patch.updatedAt || now() };
    db().prepare(
      'UPDATE generator_drafts SET status=?,candidate_json=?,validation_json=?,attempts=?,repair_count=?,' +
      'selected_connection_id=?,selected_model_id=?,route_decision_id=?,error_code=?,error=?,saved_artifact_id=?,updated_at=?,terminal_at=? WHERE draft_id=?'
    ).run(next.status, next.candidate === null || next.candidate === undefined ? null : j(next.candidate),
      j(next.validation || { valid: false, errors: [], warnings: [] }), next.attempts || 0,
      next.repairCount || 0, next.selectedModel && next.selectedModel.connectionId || null,
      next.selectedModel && next.selectedModel.modelId || null, next.routeDecisionId || null,
      next.errorCode || null, next.error || null, next.savedArtifactId || null,
      next.updatedAt, next.terminalAt || null, draftId);
    return generatorDrafts.get(draftId);
  }
};

const generatorAudit = {
  create(input) {
    db().prepare(
      'INSERT INTO generator_audit ' +
      '(audit_id,generation_id,draft_id,artifact_type,status,attempt_count,repair_count,route_decision_id,selected_connection_id,selected_model_id,validation_codes_json,saved_artifact_id,intent_hash,intent_length,duration_ms,created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(input.auditId, input.generationId, input.draftId || null, input.artifactType || null,
      input.status, input.attemptCount || 0, input.repairCount || 0, input.routeDecisionId || null,
      input.selectedConnectionId || null, input.selectedModelId || null,
      j(input.validationCodes || []), input.savedArtifactId || null, input.intentHash || null,
      input.intentLength || 0, input.durationMs || 0, input.createdAt || now());
    return generatorAudit.get(input.auditId);
  },
  get(auditId) {
    const row = db().prepare('SELECT * FROM generator_audit WHERE audit_id=?').get(auditId);
    return row ? { ...row, validation_codes: p(row.validation_codes_json, []) } : null;
  },
  list(limit = 100) {
    return db().prepare('SELECT * FROM generator_audit ORDER BY created_at DESC LIMIT ?').all(limit)
      .map(row => ({ ...row, validation_codes: p(row.validation_codes_json, []) }));
  }
};

// ---------- v1 JSON migration ----------
function migrateFromJson(jsonPath) {
  if (!jsonPath || !require('fs').existsSync(jsonPath)) return false;
  let data;
  try { data = JSON.parse(require('fs').readFileSync(jsonPath, 'utf8')); } catch { return false; }
  const tx = db().transaction(() => {
    // connections
    (data.api_connections || []).forEach(c => {
      const id = uuid(); const t = now();
      db().prepare(`INSERT INTO api_connections (id,name,provider,base_url,api_key_enc,api_key_masked,headers_json,models_json,tested,tested_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, c.name || '连接', c.provider || 'openai', c.base_url || 'https://api.openai.com/v1',
          sec.encrypt(c.api_key || ''), sec.mask(c.api_key || ''), j(encryptHeaderValues(c.headers || {})), j(c.models || []), c.tested ? 1 : 0, c.tested_at || null, t, t);
      c._newId = id;
    });
    // prompts
    (data.prompts || []).forEach(p0 => {
      const id = uuid();
      db().prepare('INSERT INTO prompts (id,name,version,content,description,tags_json,tested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, p0.name || 'Prompt', p0.version || 1, p0.content || '', p0.description || '', j(p0.tags || []), p0.tested ? 1 : 0, now(), now());
    });
    // agents (+ external via type)
    (data.agents || []).forEach(a => {
      const id = uuid(); const t = now();
      const conn = (data.api_connections || []).find(c => c.id === a.api_connection_id);
      const connId = conn ? conn._newId : null;
      const subIds = (a.sub_agent_ids || []).map(oldId => {
        const found = (data.agents || []).find(x => x.id === oldId);
        return found ? found._newId : oldId;
      });
      db().prepare(`INSERT INTO agents (id,name,description,type,system_prompt_id,provider,model,api_connection_id,tools_json,permissions_json,max_steps,timeout_ms,temperature,max_tokens,is_main,sub_agent_ids_json,workspace_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, a.name || 'Agent', a.description || '', 'native', a.system_prompt_id || null, a.provider || null, a.model || null, connId,
          j(a.tool_ids || []), j(a.permissions || []), a.max_steps || 40, a.timeout_ms || 600000, a.temperature ?? 0.7, a.max_tokens || 4096, a.is_main ? 1 : 0, j(subIds), j(a.workspace || {}), t, t);
      a._newId = id;
    });
    // conversations + messages
    (data.conversations || []).forEach(c => {
      const id = uuid(); const agentId = c.agent_id ? ((data.agents || []).find(a => a.id === c.agent_id)?._newId || null) : null;
      db().prepare('INSERT INTO conversations (id,project_id,agent_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, null, agentId, c.title || '新对话', c.created_at || now(), c.updated_at || now());
      c._newId = id;
      (data.messages || []).filter(m => m.conversation_id === c.id).forEach(m => {
        db().prepare('INSERT INTO messages (id,conversation_id,role,content,tool_calls_json,tool_call_id,model,tokens,rating,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), id, m.role, m.content || '', m.tool_calls ? j(m.tool_calls) : null, m.tool_call_id || null, m.model || null, m.tokens ?? null, m.rating ?? null, m.created_at || now());
      });
    });
  });
  tx();
  return true;
}

module.exports = {
  db, init: dbm.initDb, getDb: dbm.getDb,
  projects, connections, models, prompts, skills, agents, externalAgents,
  conversations, messages, events, tasks, runs, agentMessages, tools, mcpServers,
  memories, checkpoints, fileChanges, usage, modelCalls, permissionGrants, audit, permissionDecisions, settings, agentPrefs, extAgentConfigs,
  externalAgentSessions, externalAgentAuthStates, externalAgentVerificationEvidence, agentDefinitions, agentTemplates, modelRouteDecisions, problems,
  skillDefinitions, hookDefinitions, hookInvocations,
  workflowDefinitions, workflowExecutions, workflowStepExecutions, workflowAudit,
  generatorDrafts, generatorAudit,
  migrateFromJson
};
