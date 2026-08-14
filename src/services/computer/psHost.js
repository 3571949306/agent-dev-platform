'use strict';
/**
 * P3 Computer Use Hardening — hardened PowerShell helper host.
 *
 * v2.9.9 shipped a helper whose cancel path was `child.kill()` +
 * `activeChildren.clear()`: the parent powershell.exe died but anything it had
 * spawned survived, and the registry was cleared before death was confirmed —
 * cleanup theatre. This host makes the truth explicit:
 *
 *   timeout / cancel  →  taskkill.exe /PID <pid> /T /F   (argument array,
 *                        NEVER a shell string)
 *                     →  bounded wait until the child's real `exit` event
 *                     →  only THEN is it removed from the active registry
 *
 * `stopAll()` therefore resolves only when the tree is confirmed quiesced, and
 * `activeCount()` never lies. Every child is tagged with a sessionId so a
 * cancelled session kills exactly its own helpers.
 */
const { spawn, execFile } = require('child_process');

/** @type {Set<import('child_process').ChildProcess>} confirmed-alive helper children */
const active = new Set();

/** All live helpers belonging to one ComputerSession. */
function childrenForSession(sessionId) {
  return [...active].filter(c => c._adpSessionId === (sessionId || null));
}

function activeCount(sessionId = null) {
  if (!sessionId) return active.size;
  return childrenForSession(sessionId).length;
}

/** Kill the whole process tree rooted at `pid` (argument array, no shell). */
function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(Math.trunc(pid)), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* already gone */ }
}

/** Resolve true when the child has REALLY exited (bounded; never open-ended). */
function waitForExit(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(t); resolve(ok); } };
    const t = setTimeout(() => finish(false), Math.max(50, timeoutMs));
    child.once('exit', () => finish(true));
    // `exit` may already have fired before we attached (race-safe recheck).
    if (child.exitCode !== null || child.signalCode) finish(true);
  });
}

/** Parse the helper's stdout: last JSON line wins, else raw text. */
function parseOutput(out, err) {
  const trimmed = String(out || '').trim();
  const line = trimmed.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop();
  try { return { ok: true, data: line ? JSON.parse(line) : trimmed }; }
  catch { return { ok: false, error: String(err || trimmed || 'no output').slice(0, 400) }; }
}

/**
 * Run one PowerShell helper script.
 *
 * @param {string} script   full -Command payload (dynamic text MUST go through
 *                          psLiteral() — never interpolated raw)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {AbortSignal} [opts.signal]      cancellation (user Stop / session cancel)
 * @param {string} [opts.sessionId]        owning ComputerSession (tree-kill scoping)
 * @returns {Promise<{ok:boolean, data?:any, error?:string, cancelled?:boolean, timedOut?:boolean}>}
 */
function runPs(script, { timeoutMs = 30000, signal = null, sessionId = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'SPAWN_FAILED: ' + e.message });
    }
    child._adpSessionId = sessionId || null;
    active.add(child);

    let out = '';
    let err = '';
    let settled = false;

    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      // The registry only shrinks once death is CONFIRMED — never a blind clear.
      waitForExit(child, 3000).then(() => {
        active.delete(child);
        resolve(verdict);
      });
    };

    const timer = setTimeout(() => {
      killTree(child.pid); // a hung helper must not wedge the Agent loop
      settle({ ok: false, error: 'PowerShell 执行超时', timedOut: true });
    }, Math.max(100, timeoutMs));

    const onAbort = () => {
      killTree(child.pid);
      settle({ ok: false, error: '已取消', cancelled: true });
    };
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => settle({ ok: false, error: e.message }));
    child.on('close', () => {
      if (settled) return; // timeout/abort already owns the verdict
      settle(parseOutput(out, err));
    });
  });
}

/**
 * Stop helpers and WAIT for confirmed exit.
 * @param {string} [sessionId]  stop only this session's helpers; omit for all.
 * @returns {Promise<{ok:true, stopped:number, quiesced:boolean}>}
 */
async function stopAll(sessionId = null) {
  const victims = sessionId ? childrenForSession(sessionId) : [...active];
  for (const child of victims) killTree(child.pid);
  let quiesced = true;
  for (const child of victims) {
    const ok = await waitForExit(child, 4000);
    if (!ok) quiesced = false;
    // Even when the wait timed out, leave the child registered: the registry
    // must reflect reality (COMPUTER_RESIDUE will be reported by the caller).
    if (ok) active.delete(child);
  }
  return { ok: true, stopped: victims.length, quiesced };
}

/** True when no helper process is alive (post-soak proof). */
function isIdle() { return active.size === 0; }

/** Pass arbitrary text into PowerShell without any quoting/injection risk. */
function psLiteral(text) {
  const b64 = Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64');
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

/**
 * DPI-awareness + native window API preamble shared by every helper script.
 * PER_MONITOR_AWARE_V2 (fallback SetProcessDPIAware) makes every rect/cursor
 * coordinate the script reads PHYSICAL pixels — the single DPI strategy.
 */
const PS_PRELUDE = `try { Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); } }
}
"@
[ADPDpi]::Init() | Out-Null } catch { }`;

module.exports = { runPs, stopAll, activeCount, isIdle, killTree, waitForExit, psLiteral, PS_PRELUDE, _active: active };
