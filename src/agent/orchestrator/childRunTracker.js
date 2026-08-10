'use strict';
/**
 * ChildRunTracker — v2.9.0 Parent/Child Run 树管理（spec §23-29）。
 *
 * 内存中维护 Run 树（parent-child），配合 DB 持久化（parent_run_id/root_run_id/depth）。
 *
 * API（§23）：register / getChildren / getParent / wait / cancel / terminal
 *
 * 取消级联（§24）：Parent CANCEL → 所有 owned running children CANCEL →
 * external abort → process cleanup → Parent CANCELLED。
 *
 * Child terminal 不终结 Parent（§27-28）：Child TIMEOUT/FAILED 反馈 Main Agent
 * 决定下一步，不直接让 Parent TIMEOUT/FAILED。
 */

const { EventEmitter } = require('events');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout', 'interrupted', 'unavailable']);

function createChildRunTracker() {
  const parentOf = new Map();       // childRunId -> parentRunId
  const childrenOf = new Map();     // parentRunId -> Set<childRunId>
  const runs = new Map();           // runId -> { status, result, agentId, startedAt, resolve }
  const emitters = new Map();      // runId -> EventEmitter (terminal notify)

  function register(parentRunId, childRunId, agentId) {
    parentOf.set(childRunId, parentRunId || null);
    if (parentRunId) {
      let set = childrenOf.get(parentRunId);
      if (!set) { set = new Set(); childrenOf.set(parentRunId, set); }
      set.add(childRunId);
    }
    runs.set(childRunId, { status: 'running', result: null, agentId: agentId || null, startedAt: Date.now() });
    emitters.set(childRunId, new EventEmitter());
    return childRunId;
  }

  function getChildren(parentRunId) {
    const set = childrenOf.get(parentRunId);
    return set ? Array.from(set) : [];
  }

  function getParent(childRunId) {
    return parentOf.get(childRunId) || null;
  }

  function get(runId) {
    return runs.get(runId) || null;
  }

  function isTerminal(runId) {
    const r = runs.get(runId);
    return !r || TERMINAL_STATUSES.has(r.status);
  }

  /**
   * 设置 Run 终态并唤醒所有 wait 者（§19：平台 await child terminal）。
   */
  function setTerminal(runId, status, result) {
    const r = runs.get(runId);
    if (!r) return;
    r.status = status;
    r.result = result || null;
    const em = emitters.get(runId);
    if (em) {
      em.emit('terminal', { runId, status, result: r.result });
    }
  }

  /**
   * 等待 Run 到达终态（§19）。平台 Runtime await，不轮询 DB。
   * @returns {Promise<{ status, result }>}
   */
  function wait(runId, timeoutMs) {
    const r = runs.get(runId);
    if (!r) return Promise.resolve({ status: 'unknown', result: null });
    if (TERMINAL_STATUSES.has(r.status)) {
      return Promise.resolve({ status: r.status, result: r.result });
    }
    const em = emitters.get(runId);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }   // §119: clear timeout timer，避免 ref'd timer 阻止 process 退出
        resolve(payload);
      };
      if (em) em.once('terminal', done);
      if (timeoutMs) {
        timer = setTimeout(() => done({ status: 'timeout', result: null }), timeoutMs);
      }
    });
  }

  /**
   * 取消级联（§24）：Parent CANCEL → 所有 owned running children CANCEL。
   * @param {string} runId  要取消的 Run
   * @param {function} cancelExternal  async (runId) => 外部 adapter abort
   * @returns {Promise<string[]>} 被取消的 runId 列表
   */
  async function cancel(runId, cancelExternal) {
    const cancelled = [];
    const r = runs.get(runId);
    if (!r || TERMINAL_STATUSES.has(r.status)) return cancelled;

    // 先递归取消所有 children
    const kids = childrenOf.get(runId);
    if (kids) {
      for (const childId of Array.from(kids)) {
        const childCancelled = await cancel(childId, cancelExternal);
        cancelled.push(...childCancelled);
      }
    }
    // 再取消自身（外部 adapter abort）
    if (typeof cancelExternal === 'function') {
      try { await cancelExternal(runId); } catch { /* noop */ }
    }
    setTerminal(runId, 'cancelled', null);
    cancelled.push(runId);
    return cancelled;
  }

  /**
   * 获取 Root Run（沿 parent 链向上）。
   */
  function getRoot(runId) {
    let cur = runId;
    let parent = parentOf.get(cur);
    while (parent) {
      cur = parent;
      parent = parentOf.get(cur);
    }
    return cur;
  }

  /**
   * 计算深度（沿 parent 链向上数）。
   */
  function depth(runId) {
    let d = 0;
    let parent = parentOf.get(runId);
    while (parent) {
      d++;
      parent = parentOf.get(parent);
    }
    return d;
  }

  function snapshot() {
    const out = [];
    for (const [runId, r] of runs) {
      out.push({ runId, ...r, parentRunId: parentOf.get(runId) || null });
    }
    return out;
  }

  function clear() {
    parentOf.clear();
    childrenOf.clear();
    runs.clear();
    emitters.clear();
  }

  /**
   * 释放资源（§81）：唤醒所有 waiters → 清除 maps / emitters。
   * Orchestrator dispose 时调用，确保无僵尸 timer / listener。
   */
  function dispose() {
    for (const [runId, em] of emitters) {
      try { em.emit('terminal', { runId, status: 'interrupted', result: null }); } catch { /* noop */ }
    }
    parentOf.clear();
    childrenOf.clear();
    runs.clear();
    emitters.clear();
  }

  return {
    register, getChildren, getParent, get, getRoot, depth,
    isTerminal, setTerminal, wait, cancel,
    snapshot, clear, dispose, TERMINAL_STATUSES
  };
}

module.exports = { createChildRunTracker, TERMINAL_STATUSES };
