'use strict';
/**
 * P3 Computer Use Hardening — DesktopInteractionLock.
 *
 * ProjectMutationLock protects a project tree; it cannot protect the desktop.
 * Two Runs (Project A / Project B) share exactly one mouse, one keyboard, one
 * clipboard and one foreground window. Every MUTATING computer action
 * (focus / click / type / keys / paste / UIA value / invoke / scroll / drag)
 * therefore passes through this tiny serial lock. Read-only observations stay
 * outside it.
 *
 * Contract:
 *  - acquire() resolves FIFO in request order → mutations NEVER interleave.
 *  - a cancelled session's pending acquire rejects instead of later inheriting
 *    the lock (LOCK_ACQUIRE_CANCELLED).
 *  - each grant returns a unique token; only that token can release its grant.
 *  - the Computer cancel path releases ONLY after helper quiescence — the lock
 *    must never free while a dying session can still emit input.
 */

let TOKEN_SEQ = 1;

class DesktopInteractionLock {
  constructor() {
    this._holder = null;   // { token, sessionId, reason, at }
    this._queue = [];      // FIFO waiters { sessionId, reason, cancelled, resolve, reject }
  }

  /**
   * @param {object} meta { sessionId, reason }
   * @returns {Promise<{token:number, sessionId:string, release:Function}>}
   */
  acquire(meta = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { sessionId: meta.sessionId || null, reason: meta.reason || '', cancelled: false, resolve, reject };
      waiter.cancelFn = () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        reject(Object.assign(new Error('LOCK_ACQUIRE_CANCELLED'), { code: 'LOCK_ACQUIRE_CANCELLED' }));
      };
      this._queue.push(waiter);
      setImmediate(() => this._drain());
    });
  }

  /** Cancel a session's pending (not yet granted) acquire attempts. */
  cancelPending(sessionId) {
    for (const w of this._queue) {
      if (w.sessionId === sessionId && !w.cancelled && typeof w.cancelFn === 'function') w.cancelFn();
    }
    this._queue = this._queue.filter(w => !w.cancelled);
    this._drain();
  }

  _drain() {
    if (this._holder) return;
    const idx = this._queue.findIndex(w => !w.cancelled);
    if (idx === -1) return;
    const w = this._queue.splice(idx, 1)[0];
    const token = TOKEN_SEQ++;
    this._holder = { token, sessionId: w.sessionId, reason: w.reason, at: Date.now() };
    w.resolve({ token, sessionId: w.sessionId, release: () => this.release(token) });
  }

  /** Release by token — a stale/wrong token cannot drop the current holder. */
  release(token) {
    if (!this._holder || this._holder.token !== token) return false;
    this._holder = null;
    this._drain();
    return true;
  }

  holder() { return this._holder ? { ...this._holder } : null; }
  held() { return !!this._holder; }
  pendingCount() { return this._queue.filter(w => !w.cancelled).length; }

  /** Post-soak proof: no holder, no pending. */
  isIdle() { return !this._holder && this.pendingCount() === 0; }
}

module.exports = { DesktopInteractionLock };
