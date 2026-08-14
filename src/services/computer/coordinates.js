'use strict';
/**
 * P3 Computer Use Hardening — coordinate truth (pure logic, no I/O).
 *
 * Every coordinate the runtime produces or consumes travels through these
 * functions, so DPI scaling and multi-monitor negative origins are handled in
 * ONE tested place instead of being guessed inside PowerShell strings.
 *
 * Coordinate systems (never mixed, never left to the model):
 *   SCREEN_PHYSICAL    — physical pixels in virtual-screen space (negative ok)
 *   WINDOW_PHYSICAL    — physical pixels relative to the window top-left
 *   CLIENT_PHYSICAL    — physical pixels relative to the client area top-left
 *   NORMALIZED_WINDOW  — 0..1 within the window rect (vision models use this)
 *
 * The PowerShell helper process runs PER_MONITOR_AWARE, so every rect it
 * reports is already in physical pixels; normalized → physical is a straight
 * affine map and the DPI scale only matters when a LOGICAL rect was supplied
 * by a DPI-unaware source (flagged via rect.dpiScale).
 */

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate a normalized 0..1 coordinate pair (NaN / Infinity / strings rejected). */
function isValidNormalized(x, y) {
  return isFiniteNumber(x) && isFiniteNumber(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

/** Normalise a rect to { x, y, width, height } (accepts left/top/right/bottom too). */
function normRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  if (isFiniteNumber(rect.width) && isFiniteNumber(rect.height) && isFiniteNumber(rect.x) && isFiniteNumber(rect.y)) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (isFiniteNumber(rect.left) && isFiniteNumber(rect.top) && isFiniteNumber(rect.right) && isFiniteNumber(rect.bottom)) {
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  }
  return null;
}

/**
 * NORMALIZED_WINDOW → SCREEN_PHYSICAL.
 * The window rect must already be in physical pixels (DPI-aware source), or
 * carry `dpiScale` when it came from a DPI-unaware/logical source.
 */
function normalizedToScreenPhysical(normalizedX, normalizedY, windowRect) {
  const r = normRect(windowRect);
  if (!r) return { ok: false, code: 'INVALID_RECT' };
  if (!isValidNormalized(normalizedX, normalizedY)) return { ok: false, code: 'INVALID_NORMALIZED' };
  const scale = (windowRect && isFiniteNumber(windowRect.dpiScale) && windowRect.dpiScale > 0) ? windowRect.dpiScale : 1;
  const x = Math.round((r.x + normalizedX * r.width) * scale);
  const y = Math.round((r.y + normalizedY * r.height) * scale);
  return { ok: true, x, y, scale };
}

/** SCREEN_PHYSICAL → NORMALIZED_WINDOW (inverse; clamps nothing, reports out-of-range). */
function screenPhysicalToNormalized(x, y, windowRect) {
  const r = normRect(windowRect);
  if (!r || !isFiniteNumber(x) || !isFiniteNumber(y)) return { ok: false, code: 'INVALID_INPUT' };
  const scale = (windowRect && isFiniteNumber(windowRect.dpiScale) && windowRect.dpiScale > 0) ? windowRect.dpiScale : 1;
  if (r.width <= 0 || r.height <= 0) return { ok: false, code: 'INVALID_RECT' };
  const nx = (x / scale - r.x) / r.width;
  const ny = (y / scale - r.y) / r.height;
  return { ok: true, normalizedX: nx, normalizedY: ny, within: nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 };
}

/**
 * Target Fence: the final physical point must lie inside the CURRENT target
 * bounds (tolerance absorbs 1px rounding). Negative virtual-screen origins are
 * ordinary numbers here — multi-monitor left/above layouts just work.
 */
function withinBounds(x, y, windowRect, tolerance = 1) {
  const r = normRect(windowRect);
  if (!r || !isFiniteNumber(x) || !isFiniteNumber(y)) return false;
  const scale = (windowRect && isFiniteNumber(windowRect.dpiScale) && windowRect.dpiScale > 0) ? windowRect.dpiScale : 1;
  const left = r.x * scale, top = r.y * scale;
  const right = left + r.width * scale, bottom = top + r.height * scale;
  return x >= left - tolerance && x <= right + tolerance && y >= top - tolerance && y <= bottom + tolerance;
}

/** Logical (DPI-unaware) point/size → physical pixels at the given scale (100% = 1). */
function logicalToPhysical(v, dpiScale) {
  if (!isFiniteNumber(v)) return null;
  const s = isFiniteNumber(dpiScale) && dpiScale > 0 ? dpiScale : 1;
  return Math.round(v * s);
}

/** Physical → logical. */
function physicalToLogical(v, dpiScale) {
  if (!isFiniteNumber(v)) return null;
  const s = isFiniteNumber(dpiScale) && dpiScale > 0 ? dpiScale : 1;
  return v / s;
}

/** DPI scale from a percent (100/125/150/175/200) or a raw factor. */
function scaleFromPercent(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return 1;
  return p > 10 ? p / 100 : p; // 150 → 1.5 ; 1.5 stays 1.5
}

/**
 * Virtual screen containment — the whole desktop including monitors with
 * negative X/Y. `virtualScreen` = { x, y, width, height } (origin can be < 0).
 */
function withinVirtualScreen(rect, virtualScreen) {
  const r = normRect(rect);
  const vs = normRect(virtualScreen);
  if (!r || !vs) return false;
  return r.x >= vs.x && r.y >= vs.y && (r.x + r.width) <= (vs.x + vs.width) && (r.y + r.height) <= (vs.y + vs.height);
}

/**
 * Geometry drift check for stale-observation fencing.
 * Rects are compared in physical space; anything beyond `tolerancePx` movement
 * or resize means the observation's coordinates no longer land where intended.
 */
function geometryChanged(a, b, tolerancePx = 2) {
  const ra = normRect(a);
  const rb = normRect(b);
  if (!ra || !rb) return true; // unknown geometry = treat as changed (fail closed)
  return Math.abs(ra.x - rb.x) > tolerancePx
    || Math.abs(ra.y - rb.y) > tolerancePx
    || Math.abs(ra.width - rb.width) > tolerancePx
    || Math.abs(ra.height - rb.height) > tolerancePx;
}

module.exports = {
  isFiniteNumber,
  isValidNormalized,
  normRect,
  normalizedToScreenPhysical,
  screenPhysicalToNormalized,
  withinBounds,
  logicalToPhysical,
  physicalToLogical,
  scaleFromPercent,
  withinVirtualScreen,
  geometryChanged
};
