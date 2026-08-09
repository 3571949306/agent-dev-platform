'use strict';
/**
 * v2.7.2 External Agent Runtime Reliability — 共享终态闸门（spec §14 / §15 / §19 / §23）。
 *
 * 问题背景：v2.7.1 中 OpenCode / OpenHands 各自维护独立的终态判断，且存在
 *   `if (!run.terminal) run.status = COMPLETED`
 * 这类脆弱逻辑——SSE / WebSocket 在收到显式终态事件前意外断开会被误判为
 * 成功完成。Cline 的取消 / 超时共用一个 AbortController，导致超时也被标记成
 * CANCELLED。晚期结果（timeout 后 2 秒才返回的 completed）会覆盖终态。
 *
 * 本模块提供唯一的「终态一次」仲裁器，所有外部 Agent 适配器复用：
 *   - 终态集合：COMPLETED / FAILED / CANCELLED / TIMEOUT
 *   - terminal once：达到终态后，任何晚期 event / promise / SSE / WebSocket /
 *     callback 都无法覆盖；terminalCount 恒为 1
 *   - 统一的 transition(runId, nextState, reason) 入口，reason 携带错误码
 *
 * 用法：
 *   const gate = createExternalAgentTerminalGate();
 *   gate.init(runId);
 *   gate.transition(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE');
 *   // 晚期重复 / 覆盖尝试：
 *   gate.transition(runId, LIFECYCLE.FAILED, '...'); // => { accepted:false }，状态不变
 */

const { LIFECYCLE } = require('../hub/types');

/** 终态集合（达到其一即不可再变）。 */
const TERMINAL_STATES = new Set([
  LIFECYCLE.COMPLETED,
  LIFECYCLE.FAILED,
  LIFECYCLE.CANCELLED,
  LIFECYCLE.TIMEOUT
]);

/** 判断一个生命周期状态是否为终态。 */
function isTerminalState(status) {
  return TERMINAL_STATES.has(status);
}

/**
 * 创建终态闸门实例。
 * @param {object} [opts]
 * @param {function} [opts.onTerminal] (runId, status, reason) => void —— 首次进入终态时回调一次
 */
function createExternalAgentTerminalGate(opts = {}) {
  /** @type {Map<string, object>} runId -> { status, terminal, terminalCount, terminalReason, transitions[], lastTransitionAt } */
  const _runs = new Map();
  const onTerminal = (typeof opts.onTerminal === 'function') ? opts.onTerminal : null;

  /** 注册一个 Run 为起始状态（幂等）。 */
  function init(runId, initialStatus = LIFECYCLE.STARTING) {
    if (!_runs.has(runId)) {
      _runs.set(runId, {
        runId,
        status: initialStatus,
        terminal: false,
        terminalCount: 0,
        terminalReason: null,
        lastTransitionAt: Date.now(),
        transitions: []
      });
    }
    return getState(runId);
  }

  /**
   * 尝试一次状态转移。
   * @param {string} runId
   * @param {string} nextStatus LIFECYCLE.* 目标状态
   * @param {string} [reason]   错误码 / 原因（ERROR_CODE.*）
   * @returns {{ status:string, terminal:boolean, terminalCount:number, accepted:boolean, late:boolean, reason:?string }}
   */
  function transition(runId, nextStatus, reason) {
    let r = _runs.get(runId);
    if (!r) {
      r = {
        runId,
        status: LIFECYCLE.STARTING,
        terminal: false,
        terminalCount: 0,
        terminalReason: null,
        lastTransitionAt: Date.now(),
        transitions: []
      };
      _runs.set(runId, r);
    }

    const wasTerminal = r.terminal;
    r.transitions.push({
      from: r.status,
      to: nextStatus,
      reason: reason || null,
      at: Date.now(),
      accepted: false
    });

    // 已达终态：晚期转移一律忽略，原终态不变，terminalCount 保持 1。
    if (wasTerminal) {
      const last = r.transitions[r.transitions.length - 1];
      last.accepted = false;
      last.late = true;
      return {
        status: r.status,
        terminal: true,
        terminalCount: r.terminalCount,
        accepted: false,
        late: true,
        reason: r.terminalReason
      };
    }

    r.status = nextStatus;
    r.lastTransitionAt = Date.now();
    const rec = r.transitions[r.transitions.length - 1];
    rec.accepted = true;
    rec.late = false;

    if (isTerminalState(nextStatus)) {
      r.terminal = true;
      r.terminalCount = 1;
      r.terminalReason = reason || null;
      if (onTerminal) {
        try { onTerminal(runId, nextStatus, reason || null); } catch { /* 回调不可影响闸门 */ }
      }
    }
    return {
      status: r.status,
      terminal: r.terminal,
      terminalCount: r.terminalCount,
      accepted: true,
      late: false,
      reason: r.terminalReason
    };
  }

  /** 安全快照（不暴露内部引用）。 */
  function getState(runId) {
    const r = _runs.get(runId);
    if (!r) return null;
    return {
      status: r.status,
      terminal: r.terminal,
      terminalCount: r.terminalCount,
      terminalReason: r.terminalReason,
      lastTransitionAt: r.lastTransitionAt,
      transitions: r.transitions.map(t => ({ ...t }))
    };
  }

  function getStatus(runId) {
    const r = _runs.get(runId);
    return r ? r.status : null;
  }

  function isTerminal(runId) {
    const r = _runs.get(runId);
    return !!(r && r.terminal);
  }

  function terminalCount(runId) {
    const r = _runs.get(runId);
    return r ? r.terminalCount : 0;
  }

  /** 移除一个 Run 的闸门记录。 */
  function remove(runId) {
    return _runs.delete(runId);
  }

  function clear() { _runs.clear(); }

  return {
    init,
    transition,
    getState,
    getStatus,
    isTerminal,
    terminalCount,
    remove,
    clear
  };
}

module.exports = { createExternalAgentTerminalGate, isTerminalState, TERMINAL_STATES };
