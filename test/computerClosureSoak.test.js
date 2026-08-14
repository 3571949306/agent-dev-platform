'use strict';
/**
 * P3 Computer Use — FINAL CLOSURE SOAK.
 *
 * 100 meaningful lifecycle cycles: session create → target bind → observation
 * → fenced mutation attempts (allow + deny mix) → cancel/complete → residue
 * audit. Lock contention and clipboard transactions are exercised inside the
 * cycles. No paid provider calls, no real desktop mutation (deterministic
 * seams); the real-desktop matrix lives in computerClosureProduction.test.js.
 *
 * Proof: CLOSURE_SOAK=100/100 + final residue counters all zero.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { ComputerManager, createComputerTools } = require('../src/services/computer');
const { ComputerSessionRegistry } = require('../src/services/computerSession');
const { DesktopInteractionLock } = require('../src/services/computer/desktopInteractionLock');
const psHost = require('../src/services/computer/psHost');
const { RunManager } = require('../src/agent/runManager');

const CYCLES = 100;

test('Closure soak: 100 meaningful lifecycle cycles with zero residue', async () => {
  const rm = new RunManager({ emit: () => {} });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg });
  const tools = createComputerTools({ manager: mgr });
  const lock = mgr.lock;

  const winA = { hwnd: 9101, pid: 911, title: 'Soak A', processName: 'soak', rect: { x: 0, y: 0, width: 400, height: 300 } };
  const winB = { hwnd: 9202, pid: 922, title: 'Soak B', processName: 'soak', rect: { x: 500, y: 0, width: 400, height: 300 } };

  // deterministic seams: no OS is touched in the soak
  const winId = require('../src/services/computer/windowIdentity');
  const origValidate = winId.validateWindowRef;
  winId.validateWindowRef = async (ref) => ({ ok: true, rect: (ref && ref.rect) || { x: 0, y: 0, width: 400, height: 300 }, foreground: true });
  mgr.listWindows = async () => ({ ok: true, windows: [winA, winB] });
  mgr.focusWindowRef = async () => ({ ok: true, verified: true });
  mgr.clipboardFake = {
    read: async () => 'SOAK_MARKER',
    write: async () => {}
  };
  mgr.pressKeys = async () => ({ ok: true, executed: true });

  let okCycles = 0;
  let crossWindowExec = 0;
  let cancelAfterTerminalExec = 0;

  for (let i = 0; i < CYCLES; i++) {
    const run = rm.createRun({ conversationId: 'soak-' + i, agentId: 'soak-agent' });
    const ctx = { runId: run.id, agentId: 'soak-agent', conversationId: 'soak-' + i };

    // 1) session appears through the tool gate (real lineage)
    const list = await tools.execs.computer_list_windows(ctx, {});
    assert.ok(list.ok, `cycle ${i}: list windows`);
    const sessions = reg.forRun(run.id);
    assert.strictEqual(sessions.length, 1, `cycle ${i}: exactly one session per run`);
    const sid = sessions[0].sessionId;
    assert.strictEqual(reg.get(sid).rootRunId, run.id, `cycle ${i}: root from lineage`);

    // 2) target authorization: A granted, B always denied (no authorizer for B)
    mgr.targetAuthorizer = async (req) => req.windowRef.hwnd === winA.hwnd;
    const focusA = await tools.execs.computer_focus_window(ctx, { title: winA.title });
    assert.ok(focusA.ok, `cycle ${i}: authorized target works`);
    const focusB = await tools.execs.computer_focus_window(ctx, { title: winB.title });
    if (focusB.ok) crossWindowExec++;
    assert.strictEqual(focusB.ok, false, `cycle ${i}: unauthorized target denied`);

    // 3) observation + fenced mutation on A (bounds fence); smuggled B denied
    const obsA = mgr.observations.create({ sessionId: sid, windowRef: winA, windowRect: winA.rect });
    const obsB = mgr.observations.create({ sessionId: sid, windowRef: winB, windowRect: winB.rect });
    const clickA = await mgr.clickObserved({ observationId: obsA.observationId, normalizedX: 1.5, normalizedY: 0.5, sessionId: sid });
    assert.strictEqual(clickA.code, 'INVALID_NORMALIZED', `cycle ${i}: out-of-range point fenced before the OS`);
    assert.notStrictEqual(clickA.executed, true);
    const clickB = await mgr.clickObserved({ observationId: obsB.observationId, normalizedX: 0.5, normalizedY: 0.5, sessionId: sid });
    if (clickB.executed === true) crossWindowExec++;
    assert.strictEqual(clickB.code, 'TARGET_NOT_ALLOWED', `cycle ${i}: smuggled B observation fenced`);

    // 4) lock contention: a rival holder forces this session to queue, then the
    //    session is cancelled — the queued action must never execute.
    const rival = await lock.acquire({ sessionId: 'rival-' + i });
    const queued = tools.execs.computer_click_observed(ctx, { observation_id: obsA.observationId, normalized_x: 0.4, normalized_y: 0.4 });
    await new Promise(r => setImmediate(r));
    await mgr.cancelSession(sid, { reason: 'soak cancel' });
    rival.release();
    const q = await queued;
    if (q.ok || (q.data && q.data.executed)) cancelAfterTerminalExec++;
    assert.strictEqual(q.ok, false, `cycle ${i}: queued action refused after cancel`);
    assert.strictEqual(reg.get(sid).status, 'CANCELLED', `cycle ${i}: terminal truth`);

    // 5) clipboard transaction settles on every cycle
    const clip = await mgr.pasteToTarget({ target: winA, text: 'soak ' + i, sessionId: sid }, {});
    void clip;
    assert.strictEqual(mgr._clipboardTx, 0, `cycle ${i}: clipboard tx settled`);

    // 6) residue audit for this cycle
    assert.strictEqual(lock.pendingCount(), 0, `cycle ${i}: no pending lock waiters`);
    assert.strictEqual(reg.activeList().length, 0, `cycle ${i}: no live sessions`);
    okCycles++;
  }

  assert.strictEqual(okCycles, CYCLES);
  assert.strictEqual(crossWindowExec, 0);
  assert.strictEqual(cancelAfterTerminalExec, 0);

  // global final state
  assert.ok(lock.isIdle(), 'soak end: lock idle');
  assert.strictEqual(reg.activeCount(), 0, 'soak end: sessions = 0');
  assert.strictEqual(mgr.observations.count(), 0, 'soak end: observations = 0 (invalidated on cancel)');
  assert.strictEqual(psHost.activeCount(), 0, 'soak end: helpers = 0');
  assert.strictEqual(mgr._clipboardTx, 0, 'soak end: clipboard tx = 0');
  winId.validateWindowRef = origValidate;
  console.log(`CLOSURE_SOAK=${okCycles}/${CYCLES}`);
  console.log('CLOSURE_SOAK_CROSS_WINDOW_EXEC=0');
  console.log('CLOSURE_SOAK_CANCEL_LATE_EXEC=0');
  console.log('CLOSURE_SOAK_RESIDUE=0');
});
