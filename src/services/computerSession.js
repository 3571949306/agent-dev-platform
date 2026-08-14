'use strict';
/**
 * P3 Computer Use Hardening — ComputerSession.
 *
 * Lightweight identity for "one agent run driving the desktop": who owns it,
 * which Run tree it belongs to, and which windows it may touch. It is NOT a
 * framework and it grants NO authority — every action still clears the
 * PermissionEngine; the session only provides traceability + target fencing.
 *
 * Root identity comes from the REAL RunManager lineage (`getRootRunId` walks
 * the persisted parent chain). A Model/Renderer that self-reports a rootRunId
 * gets nothing: unknown runId → session creation fails closed.
 */
const crypto = require('crypto');

const STATUS = Object.freeze({
  CREATED: 'CREATED', ACTIVE: 'ACTIVE', WAITING: 'WAITING',
  CANCELLED: 'CANCELLED', COMPLETED: 'COMPLETED', FAILED: 'FAILED'
});

const TERMINAL = new Set([STATUS.CANCELLED, STATUS.COMPLETED, STATUS.FAILED]);

function hasExactWindowIdentity(target) {
  return !!target && Number.isSafeInteger(Number(target.hwnd)) && Number(target.hwnd) > 0 &&
    Number.isSafeInteger(Number(target.pid)) && Number(target.pid) > 0;
}

function copyExactWindowIdentity(target) {
  if (!hasExactWindowIdentity(target)) return null;
  return { ...target, hwnd: Number(target.hwnd), pid: Number(target.pid) };
}

class ComputerSessionRegistry {
  /**
   * @param opts.runManager   real RunManager (lineage truth). Optional only in
   *                          pure unit tests — production wiring always has it.
   * @param opts.onProblem    (problem) => void — Problems Center reporter.
   */
  constructor({ runManager = null, onProblem = null } = {}) {
    this.runManager = runManager;
    this.onProblem = onProblem || (() => {});
    this._sessions = new Map(); // sessionId -> session
  }

  /**
   * @param {object} o { runId, ownerAgentId, conversationId, allowedTargets }
   * @returns {{ok:true, session}|{ok:false, code, error}}
   */
  create(o = {}) {
    const { runId = null, ownerAgentId = null, conversationId = null, allowedTargets = [] } = o;
    // One live session per Run — a Run never drives the desktop twice in parallel.
    if (runId) {
      for (const s of this._sessions.values()) {
        if (s.runId === runId && !TERMINAL.has(s.status)) return { ok: true, session: s };
      }
    }
    let rootRunId = runId; // no RunManager (unit tests) → identity stays what the caller proved
    if (this.runManager) {
      if (!runId) return { ok: false, code: 'SESSION_RUN_REQUIRED', error: 'Computer 会话必须绑定真实 Run' };
      const derived = this.runManager.getRootRunId ? this.runManager.getRootRunId(runId) : null;
      if (!derived) {
        // Unknown runId = self-reported identity → fail closed.
        return { ok: false, code: 'SESSION_UNKNOWN_RUN', error: '无法从 RunManager 推导 Run 血统，拒绝创建 Computer 会话' };
      }
      rootRunId = derived;
    }
    const session = {
      sessionId: 'csess_' + crypto.randomBytes(8).toString('hex'),
      runId: runId || null,
      rootRunId,
      ownerAgentId: ownerAgentId || null,
      conversationId: conversationId || null,
      createdAt: Date.now(),
      status: STATUS.CREATED,
      // Authority is always an exact HWND + PID pair. Title-only/PID-only
      // compatibility selectors are discovery inputs, never durable grants.
      allowedTargets: Array.isArray(allowedTargets) ? allowedTargets.map(copyExactWindowIdentity).filter(Boolean) : [],
      activeTarget: null,          // WindowRef currently being driven
      mode: 'UIA',                 // UIA | VISION | COORDINATE_FALLBACK
      observationCount: 0,
      actionCount: 0,
      lastAction: null,            // { type, at, outcome, errorCode }
      lastErrorCode: null,
      cancelHooks: []              // async fns run (in order) on cancel
    };
    this._sessions.set(session.sessionId, session);
    return { ok: true, session };
  }

  get(sessionId) { return this._sessions.get(sessionId) || null; }

  forRun(runId) {
    return [...this._sessions.values()].filter(s => s.runId === runId && !TERMINAL.has(s.status));
  }

  forConversation(conversationId) {
    return [...this._sessions.values()].filter(s => s.conversationId === conversationId && !TERMINAL.has(s.status));
  }

  activeList() { return [...this._sessions.values()].filter(s => !TERMINAL.has(s.status)); }

  setStatus(sessionId, status) {
    const s = this._sessions.get(sessionId);
    if (!s || !STATUS[status]) return null;
    if (TERMINAL.has(s.status)) return s; // terminal is terminal
    s.status = status;
    return s;
  }

  bindTarget(sessionId, windowRef) {
    const s = this._sessions.get(sessionId);
    if (!s) return false;
    s.activeTarget = windowRef;
    return true;
  }

  allowTarget(sessionId, target) {
    const s = this._sessions.get(sessionId);
    const exact = copyExactWindowIdentity(target);
    if (!s || !exact || s.status !== STATUS.ACTIVE) return false;
    const dup = s.allowedTargets.some(t =>
      Number(t.hwnd) === exact.hwnd && Number(t.pid) === exact.pid);
    if (!dup) s.allowedTargets.push(exact);
    return true;
  }

  /**
   * Target fence: the session may only drive windows it was authorized for.
   * A Specialist pointed at Notepad must get TARGET_NOT_ALLOWED on Chrome.
   */
  assertTargetAllowed(sessionId, windowRef) {
    const s = this._sessions.get(sessionId);
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND', error: 'Computer 会话不存在' };
    if (TERMINAL.has(s.status)) return { ok: false, code: 'SESSION_TERMINATED', error: `Computer 会话已终态（${s.status}）` };
    if (s.status !== STATUS.ACTIVE) return { ok: false, code: 'SESSION_NOT_ACTIVE', error: `Computer 会话未激活（${s.status}）` };
    if (!s.allowedTargets.length) {
      // First bind happens with the user's computer permission fresh — caller
      // must allowTarget() after the permission gate, then re-check.
      return { ok: false, code: 'TARGET_NOT_ALLOWED', error: '该 Computer 会话尚未绑定任何允许的目标窗口' };
    }
    // A recycled HWND belongs to a different authority domain. Both values
    // must match the grant; titles and process names are audit metadata only.
    const candidate = copyExactWindowIdentity(windowRef);
    const ok = !!candidate && s.allowedTargets.some(t =>
      Number(t.hwnd) === candidate.hwnd && Number(t.pid) === candidate.pid);
    if (!ok) {
      try {
        this.onProblem({
          severity: 'WARNING', source: 'Computer', code: 'TARGET_NOT_ALLOWED',
          message: `Computer 会话尝试操作未授权窗口「${(windowRef && windowRef.title) || '?'}」`,
          runId: s.runId, relatedKey: `target:${s.sessionId}`
        });
      } catch { /* problems must never break the fence */ }
      return { ok: false, code: 'TARGET_NOT_ALLOWED', error: '目标窗口不在该会话的授权列表内' };
    }
    return { ok: true };
  }

  /**
   * Cancel one session. Hooks run in order (abort grounding → stop helpers →
   * restore clipboard → quiesce), and the desktop lock release hook MUST be
   * registered LAST by the runtime so the lock frees only after quiescence.
   */
  async cancel(sessionId, { reason = '用户取消' } = {}) {
    const s = this._sessions.get(sessionId);
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (TERMINAL.has(s.status)) return { ok: true, session: s, alreadyTerminal: true };
    s.status = STATUS.CANCELLED;
    s.cancelReason = reason;
    const errors = [];
    for (const hook of s.cancelHooks) {
      try { await hook({ sessionId, reason }); } catch (e) { errors.push(e && e.message || String(e)); }
    }
    return { ok: errors.length === 0, session: s, errors };
  }

  /** Cancel every live session of a conversation (agent:stop path). */
  async cancelForConversation(conversationId) {
    const list = this.forConversation(conversationId);
    const results = [];
    for (const s of list) results.push(await this.cancel(s.sessionId));
    return results;
  }

  complete(sessionId) { return this.setStatus(sessionId, STATUS.COMPLETED); }
  fail(sessionId) { return this.setStatus(sessionId, STATUS.FAILED); }

  /** Post-soak proof: no live sessions. */
  activeCount() { return this.activeList().length; }

  summary() {
    return this.activeList().map(s => ({
      sessionId: s.sessionId, status: s.status, runId: s.runId, rootRunId: s.rootRunId,
      ownerAgentId: s.ownerAgentId, conversationId: s.conversationId, createdAt: s.createdAt,
      durationMs: Date.now() - s.createdAt, mode: s.mode,
      target: s.activeTarget ? {
        hwnd: s.activeTarget.hwnd, pid: s.activeTarget.pid,
        title: s.activeTarget.title, process: s.activeTarget.processName
      } : null,
      allowedTargets: s.allowedTargets.length,
      observationCount: s.observationCount, actionCount: s.actionCount,
      lastAction: s.lastAction, lastErrorCode: s.lastErrorCode
    }));
  }
}

module.exports = { ComputerSessionRegistry, COMPUTER_SESSION_STATUS: STATUS, bindSessionLifecycle };

/**
 * P3 Closure (C10) — the SINGLE wiring truth aligning ComputerSession
 * lifecycle with the real Run state machine. A terminal Run always settles
 * its Computer sessions into a real terminal state (never "Run completed but
 * ComputerSession ACTIVE"). It observes the existing RunManager terminal
 * entry — this is NOT a second Run listener framework.
 *
 * @param {object} deps { runManager, manager: ComputerManager }
 * @returns {Function} unsubscribe
 */
function bindSessionLifecycle({ runManager, manager } = {}) {
  if (!runManager || typeof runManager.onTerminal !== 'function' || !manager) return () => {};
  return runManager.onTerminal(({ runId, status }) => {
    try {
      const sessions = manager.sessions ? manager.sessions.forRun(runId) : [];
      for (const s of sessions) {
        if (status === 'completed') {
          void manager.completeSession(s.sessionId, { reason: 'Run completed' });
        } else {
          void manager.cancelSession(s.sessionId, { reason: `Run ${status}` });
        }
      }
    } catch { /* lifecycle hooks must never break the Run state machine */ }
  });
}
