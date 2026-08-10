'use strict';
/**
 * v2.8.0 — 外部 Agent 会话管理器（spec §39/§40/§107/§109/§111）。
 *
 * ExternalAgentSessionManager 统一维护：
 *   AgentHub Run  ↔  外部 Agent Session
 *
 * 关键约束（spec §109）：Session 不等同于 Run。一个 Session 可包含多个 Run/Turn。
 * 数据库里 sessionId 与 runId 不得硬绑定为同一值。
 *
 * 本实现为内存 + 可选 DB 持久化（spec §110/§111）：传入 persistence
 * （{ upsert(record), remove(id) }）后，create / setStatus / touch / deleteByRun
 * 会同步写 external_agent_sessions 表；不传则为纯内存（单测 / 无 DB 环境）。
 * 持久化只写 toPersistable() 输出，保证不写入任何凭据；DB 异常不影响 Run。
 */

const crypto = require('crypto');

/**
 * 创建会话管理器。
 * @param {object} [opts]
 * @param {object} [opts.persistence] 可选持久化后端：{ upsert(persistable), remove(id) }
 */
function createExternalAgentSessionManager({ persistence } = {}) {
  /** key: `${agentId}:${externalSessionId}` -> record */
  const sessions = new Map();
  /** runId -> sessionKey */
  const byRun = new Map();

  /** 持久化失败不得影响 Run（DB 只是展示/恢复用）。 */
  function persist(record) {
    if (!persistence || typeof persistence.upsert !== 'function') return;
    try { persistence.upsert(toPersistable(record)); } catch { /* ignore */ }
  }
  function unpersist(record) {
    if (!persistence || typeof persistence.remove !== 'function' || !record) return;
    try { persistence.remove(record.id); } catch { /* ignore */ }
  }

  function keyOf(agentId, externalSessionId) {
    return `${agentId}::${externalSessionId}`;
  }

  /**
   * 创建一个会话记录。
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {string} opts.externalSessionId 外部 Agent 分配的 sessionId
   * @param {string} [opts.projectId]
   * @param {string} [opts.projectRoot]
   * @param {string} [opts.parentRunId] 首次创建时关联的 Run
   * @param {boolean} [opts.resumable]
   * @param {string} [opts.transport]
   * @returns {object} record
   */
  function create(opts = {}) {
    const key = keyOf(opts.agentId, opts.externalSessionId);
    const record = {
      id: crypto.randomUUID(),
      agentId: opts.agentId,
      externalSessionId: opts.externalSessionId,
      projectId: opts.projectId || null,
      projectRoot: opts.projectRoot || null,
      parentRunId: opts.parentRunId || null,
      transport: opts.transport || 'acp',
      resumable: !!opts.resumable,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lastStatus: 'created',
      metadata: {}
    };
    sessions.set(key, record);
    if (opts.parentRunId) byRun.set(opts.parentRunId, key);
    persist(record);
    return record;
  }

  /** 把一个 Run 关联到已有 session。 */
  function linkRun(runId, agentId, externalSessionId) {
    byRun.set(runId, keyOf(agentId, externalSessionId));
  }

  function getByExternal(agentId, externalSessionId) {
    return sessions.get(keyOf(agentId, externalSessionId)) || null;
  }

  function getByRun(runId) {
    const key = byRun.get(runId);
    return key ? sessions.get(key) || null : null;
  }

  function touch(runId) {
    const rec = getByRun(runId);
    if (rec) { rec.lastUsedAt = Date.now(); persist(rec); }
    return rec;
  }

  function setStatus(runId, status) {
    const rec = getByRun(runId);
    if (rec) { rec.lastStatus = status; rec.lastUsedAt = Date.now(); persist(rec); }
    return rec;
  }

  function deleteByRun(runId) {
    const key = byRun.get(runId);
    if (key) {
      const rec = sessions.get(key);
      sessions.delete(key);
      byRun.delete(runId);
      unpersist(rec);
      return true;
    }
    return false;
  }

  /** 仅保留可持久化、不含凭据的字段（spec §111）。 */
  function toPersistable(record) {
    if (!record) return null;
    return {
      id: record.id,
      agent_id: record.agentId,
      external_session_id: record.externalSessionId,
      project_id: record.projectId,
      project_root: record.projectRoot,
      transport: record.transport,
      resumable: record.resumable,
      created_at: record.createdAt,
      updated_at: record.lastUsedAt,
      last_status: record.lastStatus,
      metadata_json: JSON.stringify(record.metadata || {})
    };
  }

  function list() { return [...sessions.values()]; }

  function clear() { sessions.clear(); byRun.clear(); }

  return {
    create,
    linkRun,
    getByExternal,
    getByRun,
    touch,
    setStatus,
    deleteByRun,
    toPersistable,
    list,
    clear
  };
}

module.exports = { createExternalAgentSessionManager };

/**
 * 基于 store.externalAgentSessions 构造持久化后端（供主进程注入 Adapter）。
 * store 未就绪（如隔离单测）时调用方才不会传 persistence，保持纯内存。
 */
module.exports.createDbSessionPersistence = function createDbSessionPersistence(repo) {
  if (!repo || typeof repo.upsert !== 'function') return null;
  return {
    upsert(rec) { repo.upsert(rec); },
    remove(id) { repo.remove(id); }
  };
};
