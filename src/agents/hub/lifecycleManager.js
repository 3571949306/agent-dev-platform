'use strict';
/**
 * LifecycleManager — Agent Run 生命周期状态机。
 *
 * 每个 Run 有明确的状态：idle → starting → running → waiting → ... → 终态
 * 终态一旦确定，后续状态变更被忽略（与 RunManager 的终态门一致）。
 *
 * 状态迁移在 transition() 中校验：非终态之间必须符合 TRANSITIONS 表，
 * 非终态 → 终态始终合法。每次状态变更通过 emit 推送 AGENT_EVENT 事件。
 *
 * Run 对象形状：
 *   { id, agentId, adapterType, taskId, status, startedAt, updatedAt,
 *     terminalAt, goal, result, error, metadata, parentRunId }
 *
 * 生命周期状态（LIFECYCLE）：
 *   idle, starting, running, waiting, completed, failed, cancelled, timeout, unavailable
 *
 * 终态：completed, failed, cancelled, timeout, unavailable
 */
const crypto = require('crypto');
const { LIFECYCLE, AGENT_EVENT } = require('./types');

/** 终态集合 */
const TERMINAL_STATES = [
  LIFECYCLE.COMPLETED,
  LIFECYCLE.FAILED,
  LIFECYCLE.CANCELLED,
  LIFECYCLE.TIMEOUT,
  LIFECYCLE.UNAVAILABLE
];

/**
 * 合法的非终态迁移表。同一状态重复允许；终态只能由 transition 到终态状态进入。
 */
const TRANSITIONS = {
  [LIFECYCLE.IDLE]: [LIFECYCLE.STARTING, LIFECYCLE.UNAVAILABLE],
  [LIFECYCLE.STARTING]: [
    LIFECYCLE.RUNNING, LIFECYCLE.WAITING,
    LIFECYCLE.FAILED, LIFECYCLE.UNAVAILABLE
  ],
  [LIFECYCLE.RUNNING]: [
    LIFECYCLE.WAITING, LIFECYCLE.COMPLETED,
    LIFECYCLE.FAILED, LIFECYCLE.TIMEOUT, LIFECYCLE.UNAVAILABLE
  ],
  [LIFECYCLE.WAITING]: [
    LIFECYCLE.RUNNING, LIFECYCLE.COMPLETED,
    LIFECYCLE.FAILED, LIFECYCLE.TIMEOUT, LIFECYCLE.CANCELLED
  ]
};

/** 判断状态字符串是否为终态。 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/** 安全发射事件 — emit 失败不得中断 Run。 */
function safeEmit(emit, type, payload) {
  if (typeof emit !== 'function') return;
  try { emit(type, payload); } catch { /* telemetry must never break a run */ }
}

/**
 * 创建 LifecycleManager。
 * @param {object} opts
 * @param {Function} [opts.emit] — 事件发射函数 (type, payload) => void
 * @returns {object} lifecycleManager 实例
 */
function createLifecycleManager({ emit } = {}) {
  /** @type {Map<string, object>} runId -> run */
  const runs = new Map();

  /**
   * 创建 Run（status=idle），立即发 RUN_STARTED 事件。
   * @param {object} params
   * @param {string} params.agentId
   * @param {string} [params.taskId]
   * @param {string} [params.goal]
   * @param {string} [params.parentRunId] — 委托子 Run 的父 Run id
   * @param {string} [params.adapterType]
   * @returns {object} run
   */
  function createRun({ agentId, taskId = null, goal = null, parentRunId = null, adapterType = null } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const run = {
      id,
      agentId: agentId || null,
      adapterType: adapterType || null,
      taskId: taskId || null,
      status: LIFECYCLE.IDLE,
      startedAt: now,
      updatedAt: now,
      terminalAt: null,
      goal: goal || null,
      result: null,
      error: null,
      metadata: {},
      parentRunId: parentRunId || null
    };
    runs.set(id, run);
    safeEmit(emit, AGENT_EVENT.RUN_STARTED, {
      runId: id, agentId, taskId, goal, parentRunId, timestamp: now
    });
    return run;
  }

  /**
   * 状态迁移。终态后一律忽略；非终态之间必须符合 TRANSITIONS 表。
   * @param {string} runId
   * @param {string} newState — LIFECYCLE.*
   * @param {*} [detail] — 终态时：completed 存为 result，其他存为 error
   * @returns {object|null} 更新后的 run（不存在返回 null，已终态/非法迁移返回原 run）
   */
  function transition(runId, newState, detail = null) {
    const run = runs.get(runId);
    if (!run) return null;
    if (isTerminalState(run.status)) return run; // 终态后忽略

    // 非终态之间需校验迁移表；非终态 → 终态始终合法
    if (!isTerminalState(newState)) {
      const allowed = TRANSITIONS[run.status] || [];
      if (!allowed.includes(newState)) return run; // 非法非终态迁移
    }

    const previousState = run.status;
    run.status = newState;
    run.updatedAt = Date.now();

    if (isTerminalState(newState)) {
      run.terminalAt = Date.now();
      if (newState === LIFECYCLE.COMPLETED) {
        run.result = detail;
      } else if (detail != null) {
        // v2.8.0 spec §107/§113：非 completed 终态同样保留结构化结果（GUI / 诊断
        // 需要 errorCode / errors），error 保持人类可读字符串，绝不退化成
        // "[object Object]"。
        if (typeof detail === 'object') {
          run.result = detail;
          run.error = detail.message
            || (Array.isArray(detail.errors) && detail.errors.length ? detail.errors.join('; ') : null)
            || (detail.status ? String(detail.status) : 'unknown error');
        } else {
          run.error = String(detail);
        }
      }
    } else if (detail != null) {
      run.metadata.lastDetail = detail;
    }

    safeEmit(emit, AGENT_EVENT.RUN_STATUS, {
      runId,
      agentId: run.agentId,
      state: newState,
      previousState,
      detail: detail != null ? detail : null,
      timestamp: run.updatedAt
    });

    // 终态专用事件
    if (newState === LIFECYCLE.COMPLETED) {
      safeEmit(emit, AGENT_EVENT.RUN_COMPLETED, {
        runId, agentId: run.agentId, result: run.result, timestamp: run.updatedAt
      });
    } else if (newState === LIFECYCLE.FAILED) {
      safeEmit(emit, AGENT_EVENT.RUN_FAILED, {
        runId, agentId: run.agentId, error: run.error, timestamp: run.updatedAt
      });
    } else if (newState === LIFECYCLE.CANCELLED) {
      safeEmit(emit, AGENT_EVENT.RUN_CANCELLED, {
        runId, agentId: run.agentId, timestamp: run.updatedAt
      });
    } else if (newState === LIFECYCLE.TIMEOUT) {
      safeEmit(emit, AGENT_EVENT.RUN_TIMEOUT, {
        runId, agentId: run.agentId, timestamp: run.updatedAt
      });
    }

    return run;
  }

  /**
   * 获取 Run。
   * @param {string} runId
   * @returns {object|null}
   */
  function getRun(runId) {
    return runs.get(runId) || null;
  }

  /**
   * 列出所有非终态 Run。
   * @returns {object[]}
   */
  function listActive() {
    return [...runs.values()].filter(r => !isTerminalState(r.status));
  }

  /**
   * 列出指定 Agent 的所有 Run。
   * @param {string} agentId
   * @returns {object[]}
   */
  function listByAgent(agentId) {
    return [...runs.values()].filter(r => r.agentId === agentId);
  }

  /**
   * 取消 Run（迁移到 cancelled 终态）。
   * @param {string} runId
   * @param {string} [detail] — 取消原因
   * @returns {object|null}
   */
  function cancel(runId, detail = '用户已取消') {
    return transition(runId, LIFECYCLE.CANCELLED, detail);
  }

  /**
   * 检查 Run 是否已终态。
   * @param {string} runId
   * @returns {boolean}
   */
  function isTerminal(runId) {
    const run = runs.get(runId);
    return run ? isTerminalState(run.status) : false;
  }

  return {
    createRun,
    transition,
    getRun,
    listActive,
    listByAgent,
    cancel,
    isTerminal
  };
}

module.exports = { createLifecycleManager, TERMINAL_STATES, TRANSITIONS, isTerminalState };
