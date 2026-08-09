'use strict';
/**
 * EventNormalizer — 将不同 adapter 类型的原始事件归一化为统一的 AgentEvent 格式。
 *
 * 各 adapter 类型的事件来源不同：
 *   - NATIVE:  Main Agent Runtime 事件（mainAgent:stateChanged 等）
 *   - CLI:     stdout 行 / 退出码
 *   - DESKTOP: UI 状态变更
 *   - HTTP:    HTTP 响应负载
 *
 * 归一化后的事件统一为：
 *   { type, runId, agentId, data, rawType, rawMetadata, timestamp }
 *
 * 安全：rawMetadata 中的敏感字段（token / key / auth / secret / password /
 * bearer / session）会被自动移除，防止凭据泄漏到事件流 / 日志。
 */
const { TRANSPORT, AGENT_EVENT } = require('./types');

/** 匹配敏感字段名的正则（不区分大小写）。 */
const SECRET_KEY_PATTERN = /token|key|auth|secret|password|bearer|session/i;

/**
 * 从对象中移除敏感字段（浅层扫描）。
 * 不修改原对象，返回一个清理后的副本。
 * @param {object} obj
 * @returns {object}
 */
function stripSecrets(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * NATIVE adapter 事件类型映射：Main Agent Runtime 事件名 → AGENT_EVENT。
 */
const NATIVE_MAP = {
  'mainAgent:runStarted': AGENT_EVENT.RUN_STARTED,
  'mainAgent:stateChanged': AGENT_EVENT.RUN_STATUS,
  'mainAgent:toolResult': AGENT_EVENT.TOOL_COMPLETED,
  'mainAgent:action': AGENT_EVENT.MESSAGE,
  'mainAgent:assistantText': AGENT_EVENT.MESSAGE,
  'mainAgent:timeline': AGENT_EVENT.MESSAGE,
  'mainAgent:runCompleted': AGENT_EVENT.RUN_COMPLETED,
  'mainAgent:runFailed': AGENT_EVENT.RUN_FAILED,
  'mainAgent:runCancelled': AGENT_EVENT.RUN_CANCELLED,
  'mainAgent:runTimeout': AGENT_EVENT.RUN_TIMEOUT
};

/** CLI adapter 事件类型映射。 */
const CLI_MAP = {
  stdout: AGENT_EVENT.MESSAGE,
  stderr: AGENT_EVENT.MESSAGE,
  exit: AGENT_EVENT.RUN_COMPLETED,
  error: AGENT_EVENT.RUN_FAILED
};

/** DESKTOP adapter 事件类型映射。 */
const DESKTOP_MAP = {
  state: AGENT_EVENT.RUN_STATUS,
  completed: AGENT_EVENT.RUN_COMPLETED,
  failed: AGENT_EVENT.RUN_FAILED,
  cancelled: AGENT_EVENT.RUN_CANCELLED,
  timeout: AGENT_EVENT.RUN_TIMEOUT
};

/** HTTP adapter 事件类型映射。 */
const HTTP_MAP = {
  response: AGENT_EVENT.MESSAGE,
  completed: AGENT_EVENT.RUN_COMPLETED,
  failed: AGENT_EVENT.RUN_FAILED,
  timeout: AGENT_EVENT.RUN_TIMEOUT,
  cancelled: AGENT_EVENT.RUN_CANCELLED
};

/** adapter 类型 → 映射表 */
const TRANSPORT_MAPS = {
  [TRANSPORT.NATIVE]: NATIVE_MAP,
  [TRANSPORT.CLI]: CLI_MAP,
  [TRANSPORT.DESKTOP]: DESKTOP_MAP,
  [TRANSPORT.HTTP]: HTTP_MAP
};

/**
 * 创建 EventNormalizer。
 * @param {object} opts
 * @param {Function} [opts.emit] — 事件发射函数 (type, payload) => void
 * @returns {{ normalize: Function, emit: Function }}
 */
function createEventNormalizer({ emit: emitFn } = {}) {
  /**
   * 将原始事件归一化为 AgentEvent。
   * @param {object|string} rawEvent — 原始事件（字符串视为 stdout 行）
   * @param {string} adapterType — adapter 类型（TRANSPORT.*）
   * @param {string} runId
   * @param {string} agentId
   * @returns {object} AgentEvent
   *   { type, runId, agentId, data, rawType, rawMetadata, timestamp }
   */
  function normalize(rawEvent, adapterType, runId, agentId) {
    const raw = typeof rawEvent === 'string'
      ? { type: 'stdout', data: rawEvent }
      : (rawEvent || {});

    const rawType = raw.type || raw.event || 'unknown';
    const map = TRANSPORT_MAPS[adapterType] || {};
    const type = map[rawType] || AGENT_EVENT.MESSAGE || 'agent.message';

    // data: 优先取 raw.data，其次 raw.payload，最后整个 raw 对象
    const data = raw.data != null
      ? raw.data
      : (raw.payload != null ? raw.payload : raw);

    // rawMetadata: 移除敏感字段
    const rawMetadata = stripSecrets(raw.metadata || raw.meta || {});

    return {
      type,
      runId: runId || null,
      agentId: agentId || null,
      data,
      rawType,
      rawMetadata,
      timestamp: raw.timestamp || Date.now()
    };
  }

  /**
   * 发射已归一化的 AgentEvent。
   * @param {object} agentEvent — normalize() 的返回值
   */
  function emit(agentEvent) {
    if (!agentEvent || typeof emitFn !== 'function') return;
    try {
      emitFn(agentEvent.type, agentEvent);
    } catch { /* telemetry must never break a run */ }
  }

  return { normalize, emit };
}

module.exports = { createEventNormalizer, stripSecrets, SECRET_KEY_PATTERN };
