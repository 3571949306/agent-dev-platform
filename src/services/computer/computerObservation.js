'use strict';
/**
 * P3 Computer Use Hardening — Observation store (Observe → Act fence).
 *
 * v2.9.9 let the model screenshot, think for seconds, then blind-click stale
 * coordinates. An Observation is the ONLY ticket to act: it captures window
 * identity + geometry + DPI + fingerprints at a moment in time, carries a TTL,
 * and every interactive action must present its observationId. Pre-action
 * validation re-checks HWND/PID/rect live — anything drifted means
 * STALE_OBSERVATION with mouse/key exec = 0.
 *
 * elementRef: stable WITHIN one observation. Encodes the tree path plus the
 * UIA RuntimeId so a reshuffled/replace control is detected as STALE_ELEMENT
 * instead of silently clicking "the most similar" other button.
 */
const crypto = require('crypto');
const { geometryChanged } = require('./coordinates');

const DEFAULT_TTL_MS = 8000;

class ObservationStore {
  /** @param opts.now injectable clock (tests) */
  constructor({ now = () => Date.now() } = {}) {
    this._obs = new Map(); // observationId -> observation
    this.now = now;
  }

  /**
   * @param {object} o { sessionId, windowRef, windowRect, clientRect, dpi,
   *                     screenshotFingerprint, uiFingerprint, elements, ttlMs }
   */
  create(o) {
    const observationId = 'obs_' + crypto.randomBytes(8).toString('hex');
    const obs = {
      observationId,
      sessionId: o.sessionId || null,
      windowRef: o.windowRef || null,            // WindowRef (hwnd/pid/title/...)
      windowRect: o.windowRect || null,          // physical rect at observe time
      clientRect: o.clientRect || null,
      dpi: o.dpi || 96,
      createdAt: this.now(),
      expiresAt: this.now() + (o.ttlMs || DEFAULT_TTL_MS),
      screenshotFingerprint: o.screenshotFingerprint || null,
      uiFingerprint: o.uiFingerprint || null,
      elements: o.elements || [],                // flat element metadata list
      usedFor: []
    };
    this._obs.set(observationId, obs);
    this.prune();
    return obs;
  }

  get(observationId) { return this._obs.get(observationId) || null; }

  /** TTL-only check (no live probe). */
  isExpired(obs) {
    if (!obs) return true;
    return this.now() > obs.expiresAt;
  }

  /**
   * Full pre-action validation.
   * @param {string} observationId
   * @param {object} probe live truth { ok, rect, foreground } from validateWindowRef
   * @param {object} [opts] { requireForeground }
   * @returns {{ok:true, observation:object}|{ok:false, code:string, error?:string}}
   */
  validate(observationId, probe, opts = {}) {
    const obs = this._obs.get(observationId);
    if (!obs) return { ok: false, code: 'OBSERVATION_NOT_FOUND', error: '观察不存在，请重新 observe' };
    if (this.isExpired(obs)) return { ok: false, code: 'STALE_OBSERVATION', error: '观察已过期（TTL），请重新 observe' };
    if (!probe || probe.ok === false) {
      const code = (probe && probe.code) || 'STALE_WINDOW';
      return { ok: false, code, error: (probe && probe.error) || '窗口身份校验失败' };
    }
    if (geometryChanged(obs.windowRect, probe.rect)) {
      return { ok: false, code: 'STALE_OBSERVATION', error: '窗口几何已变化（被移动/缩放），观察作废' };
    }
    if (opts.requireForeground && probe.foreground === false) {
      return { ok: false, code: 'FOREGROUND_CHANGED', error: '目标窗口已不在前台' };
    }
    return { ok: true, observation: obs };
  }

  /** Drop every observation bound to a window (it changed or closed). */
  invalidateForWindow(hwnd) {
    for (const [id, obs] of [...this._obs]) {
      if (obs.windowRef && Number(obs.windowRef.hwnd) === Number(hwnd)) this._obs.delete(id);
    }
  }

  invalidateForSession(sessionId) {
    for (const [id, obs] of [...this._obs]) {
      if (obs.sessionId === sessionId) this._obs.delete(id);
    }
  }

  count() { return this._obs.size; }

  prune() {
    for (const [id, obs] of [...this._obs]) {
      if (this.now() > obs.expiresAt + DEFAULT_TTL_MS) this._obs.delete(id); // keep expired ones briefly for error reporting
    }
  }
}

/**
 * Build a stable elementRef from tree path + RuntimeId (never a bare array
 * index — the tree can reshuffle between observe and act).
 */
function makeElementRef({ runtimeId, path, automationId = '', controlType = '' }) {
  const payload = JSON.stringify({
    r: Array.isArray(runtimeId) ? runtimeId : [],
    p: Array.isArray(path) ? path : [],
    a: String(automationId || ''),
    c: String(controlType || '')
  });
  return 'e:' + crypto.createHash('sha1').update(payload).digest('hex').slice(0, 20) + ':' + Buffer.from(payload).toString('base64url');
}

/** Decode an elementRef back to its identity payload. */
function parseElementRef(elementRef) {
  const m = /^e:[0-9a-f]{20}:(.+)$/.exec(String(elementRef || ''));
  if (!m) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return { runtimeId: p.r || [], path: p.p || [], automationId: p.a || '', controlType: p.c || '' };
  } catch { return null; }
}

/** Verify a decoded elementRef matches a live element (exact runtimeId + path). */
function elementRefMatches(ref, liveElement) {
  if (!ref || !liveElement) return false;
  const a = JSON.stringify(ref.runtimeId || []);
  const b = JSON.stringify(Array.isArray(liveElement.runtimeId) ? liveElement.runtimeId : []);
  if (a !== b) return false; // reshuffled/replaced control → STALE_ELEMENT, no fuzzy match
  const pa = JSON.stringify(ref.path || []);
  const pb = JSON.stringify(Array.isArray(liveElement.path) ? liveElement.path : []);
  return pa === pb;
}

module.exports = { ObservationStore, makeElementRef, parseElementRef, elementRefMatches, DEFAULT_TTL_MS };
