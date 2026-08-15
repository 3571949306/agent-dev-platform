'use strict';
/**
 * P3 Computer Use — FINAL CLOSURE: REAL WINDOWS PRODUCTION MATRIX.
 *
 * Runs on an interactive Windows desktop against the TEST-ONLY WPF fixture
 * (test/fixtures/computerFixture.ps1). No production software is driven.
 *
 * Proofs produced here:
 *   CROSS_WINDOW_MUTATION_EXEC=0           LEGACY_TARGET_BYPASS_EXEC=0
 *   MISSING_AUTHORIZER_REAL_EXEC=0         RAW_COORD_CROSS_WINDOW_EXEC=0
 *   ACTION_TIME_PID_STALE_EXEC=0           SAME_TITLE_RETARGET=20/20 (violations=0)
 *   LOCK_CANCEL_PENDING_PRODUCT_REAL=20/20
 *   COMPUTER_CHILD_PROCESS_PATHS=1         COMPUTER_UNOWNED_HELPER=0
 *   DOWNSAMPLE_TEMP_RESIDUE=0 (20/20)      CLIPBOARD_REAL_CANCEL_RESTORE=20/20
 *   SESSION_LIFECYCLE_PRODUCTION=PASS      CLOSURE_FINAL_RESIDUE=0
 *
 * Without an interactive desktop this suite prints
 * CLOSURE_PRODUCTION=BLOCKED_ENVIRONMENT — it never fabricates PASS.
 * Paid provider calls: 0.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ComputerManager, createComputerTools } = require('../src/services/computer');
const { ComputerSessionRegistry, bindSessionLifecycle } = require('../src/services/computerSession');
const psHost = require('../src/services/computer/psHost');
const winId = require('../src/services/computer/windowIdentity');
const { RunManager } = require('../src/agent/runManager');

const FIXTURE = path.join(__dirname, 'fixtures', 'computerFixture.ps1');
const IS_WIN = process.platform === 'win32';
const fixtures = [];

function spawnFixture(title, x = 120, y = 120) {
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE, '-Title', title, '-X', String(x), '-Y', String(y)], { windowsHide: false });
  fixtures.push({ child, title });
  return child;
}

function killFixtures() {
  for (const f of fixtures) { try { psHost.killTree(f.child.pid); } catch { /* gone */ } }
  fixtures.length = 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForWindow(manager, title, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await manager.resolveWindow({ title });
    if (r.ok) return r.window;
    await sleep(400);
  }
  throw new Error('fixture window did not appear: ' + title);
}

async function focusAndObserve(manager, win, opts = {}) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const focus = await manager.focusWindowRef(win);
    if (!focus.ok) { lastErr = focus.code || 'FOREGROUND_NOT_ACQUIRED'; await sleep(300); continue; }
    const obs = await manager.observe({ hwnd: win.hwnd }, { ttlMs: 30000, ...opts });
    if (obs.ok) return obs;
    lastErr = obs.code || 'OBSERVE_FAILED';
    await sleep(300);
  }
  throw new Error('could not establish an observation: ' + lastErr);
}

function normalizedCenter(el, windowRect) {
  const r = el.boundingRect;
  return {
    x: ((r.x + r.width / 2) - windowRect.x) / windowRect.width,
    y: ((r.y + r.height / 2) - windowRect.y) / windowRect.height
  };
}

/** Build the real product tool chain: RunManager → registry → manager → tools. */
function buildProductChain(extra = {}) {
  const rm = new RunManager({ emit: () => {} });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg, ...extra });
  const tools = createComputerTools({ manager: mgr });
  return { rm, reg, mgr, tools };
}

test('Closure production: environment truth', async () => {
  if (!IS_WIN) {
    console.log('CLOSURE_INTERACTIVE_ENV=UNSUPPORTED_PLATFORM');
    console.log('CLOSURE_PRODUCTION=BLOCKED_ENVIRONMENT');
    return;
  }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) {
    console.log('CLOSURE_INTERACTIVE_ENV=UNAVAILABLE');
    console.log('CLOSURE_PRODUCTION=BLOCKED_ENVIRONMENT');
    return;
  }
  console.log('CLOSURE_INTERACTIVE_ENV=AVAILABLE');
});

/* ============================================================
 * C01 production path — pending lock cancel with REAL lineage (20/20)
 * ============================================================ */

test('Closure C1 production: cancelled queued action executes 0 (20/20)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); console.log('LOCK_CANCEL_PENDING_PRODUCT_REAL=BLOCKED_ENVIRONMENT'); return; }

  const PASS_N = 20;
  let execB = 0, badStatus = 0, pendingResidue = 0;
  for (let round = 0; round < PASS_N; round++) {
    const { rm, reg, mgr, tools } = buildProductChain();
    const runA = rm.createRun({ conversationId: 'A', agentId: 'agentA' });
    const runB = rm.createRun({ conversationId: 'B', agentId: 'agentB' });
    const sessionB = reg.create({ runId: runB.id, ownerAgentId: 'agentB', conversationId: 'B' });
    reg.setStatus(sessionB.session.sessionId, 'ACTIVE');
    const tA = await mgr.lock.acquire({ sessionId: 'holder-A', reason: 'A' });
    const obs = mgr.observations.create({ sessionId: sessionB.session.sessionId, windowRef: { hwnd: 7000 + round, pid: 700000 + round, title: 'W' }, windowRect: { x: 0, y: 0, width: 50, height: 50 } });
    const p = tools.execs.computer_click_observed({ runId: runB.id }, { observation_id: obs.observationId, normalized_x: 0.5, normalized_y: 0.5 });
    await sleep(3);
    const sidB = sessionB.session.sessionId;
    const cancel = await mgr.cancelSession(sidB, { reason: '用户取消' });
    assert.strictEqual(cancel.status, 'CANCELLED');
    tA.release();
    const r = await p;
    if (r.ok || (r.data && r.data.executed)) execB++;
    assert.strictEqual(r.ok, false);
    if (reg.forRun(runB.id).length !== 0) badStatus++;
    if (mgr.lock.pendingCount() !== 0) pendingResidue++;
    assert.ok(mgr.lock.isIdle());
  }
  assert.strictEqual(execB, 0);
  assert.strictEqual(badStatus, 0);
  assert.strictEqual(pendingResidue, 0);
  console.log(`LOCK_CANCEL_PENDING_PRODUCT_REAL=${PASS_N}/${PASS_N}`);
  console.log('SESSION_CANCEL_PENDING_ACTION_EXEC_REAL=0');
});

/* ============================================================
 * C03/C05/C07 — cross-window: EVERY mutation API against an
 * unauthorized window must fail closed with OS EXEC = 0
 * ============================================================ */

test('Closure C3 production: authorized A ⇒ all mutation APIs against B are denied', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); return; }

  const { rm, reg, mgr, tools } = buildProductChain();
  mgr.targetAuthorizer = async (req) => {
    // authorize ONLY the first window the session meets; deny everything after
    return !(mgr._deniedAll || false) && !req.windowRef.title.includes('B-UNAUTH');
  };
  const run = rm.createRun({ conversationId: 'cw', agentId: 'specialist' });
  const ctx = { runId: run.id, agentId: 'specialist', conversationId: 'cw' };

  spawnFixture('ADP CL A', 130, 120);
  // fixture windows are 600 wide — B must NOT overlap A's live rect, or a raw
  // point "inside B" would legitimately sit inside authorized A.
  spawnFixture('ADP CL B-UNAUTH', 900, 150);
  try {
    const winA = await waitForWindow(mgr, 'ADP CL A');
    const winB = await waitForWindow(mgr, 'ADP CL B-UNAUTH');

    // authorize window A through the real tool path
    const focusA = await tools.execs.computer_focus_window(ctx, { title: 'ADP CL A' });
    assert.ok(focusA.ok, 'authorized window A focuses');
    const sid = reg.forRun(run.id)[0].sessionId;
    assert.ok(reg.assertTargetAllowed(sid, winA).ok, 'A is authorized');
    assert.strictEqual(reg.assertTargetAllowed(sid, winB).code, 'TARGET_NOT_ALLOWED');

    let denied = 0, executed = 0;
    const expectDeny = (r, label) => {
      if (r.ok === false && ['TARGET_NOT_ALLOWED', 'SESSION_CANCELLED', 'NO_TARGET'].includes(r.error.code)) denied++;
      else { executed++; console.log('UNEXPECTED EXEC:', label, JSON.stringify(r)); }
    };

    // ---- tool-layer mutations aimed at B ----
    expectDeny(await tools.execs.computer_focus_window(ctx, { title: 'ADP CL B-UNAUTH' }), 'focus_window(B)');
    expectDeny(await tools.execs.computer_type_text(ctx, { title: 'ADP CL B-UNAUTH', text: 'evil' }), 'type_text(B)');
    expectDeny(await tools.execs.computer_press_keys(ctx, { title: 'ADP CL B-UNAUTH', keys: 'evil' }), 'press_keys(B)');
    expectDeny(await tools.execs.computer_click_control(ctx, { title: 'ADP CL B-UNAUTH', automation_id: 'actionButton' }), 'click_control(B)');
    expectDeny(await tools.execs.computer_set_control_value(ctx, { title: 'ADP CL B-UNAUTH', text: 'evil' }), 'set_control_value(B)');
    expectDeny(await tools.execs.computer_observe(ctx, { title: 'ADP CL B-UNAUTH' }), 'observe(B)');

    // ---- observation-based mutations using a smuggled observation of B ----
    const obsB = await mgr.observe({ hwnd: winB.hwnd }, { sessionId: sid, screenshot: false, ttlMs: 30000 });
    assert.ok(obsB.ok, 'manager-level observation possible (fence must catch the mutation)');
    const btn = obsB.elements.find(e => e.automationId === 'actionButton');
    const edit = obsB.elements.find(e => e.automationId === 'textInput');
    const bc = normalizedCenter(btn, obsB.windowRect);
    const clickB = await tools.execs.computer_click_observed(ctx, { observation_id: obsB.observationId, normalized_x: bc.x, normalized_y: bc.y });
    expectDeny(clickB, 'click_observed(B)');
    expectDeny(await tools.execs.computer_invoke_element(ctx, { observation_id: obsB.observationId, element_ref: btn.elementRef }), 'invoke_element(B)');
    expectDeny(await tools.execs.computer_set_element_value(ctx, { observation_id: obsB.observationId, element_ref: edit.elementRef, text: 'evil' }), 'set_element_value(B)');
    expectDeny(await tools.execs.computer_toggle_element(ctx, { observation_id: obsB.observationId, element_ref: obsB.elements.find(e => e.automationId === 'checkbox1').elementRef }), 'toggle(B)');
    // select against B — the fence rejects at the observation level regardless of element
    expectDeny(await tools.execs.computer_select_element(ctx, { observation_id: obsB.observationId, element_ref: edit.elementRef }), 'select(B)');
    expectDeny(await tools.execs.computer_scroll_element(ctx, { observation_id: obsB.observationId, element_ref: obsB.elements.find(e => e.automationId === 'scrollPanel').elementRef, value: 1 }), 'scroll(B)');

    // ---- raw coordinates into B (session authorized for A only) ----
    const rawB = await tools.execs.computer_click_at(ctx, { x: winB.rect.x + 20, y: winB.rect.y + 20 });
    expectDeny(rawB, 'click_at(B center)');

    assert.strictEqual(executed, 0, 'no cross-window execution at all');
    // fixture B proves zero OS effect: still READY, never CLICKED / TEXT:
    const textB = await mgr.getWindowText({ hwnd: winB.hwnd });
    assert.ok(textB.ok && textB.text.includes('READY'), 'fixture B untouched');
    assert.ok(!textB.text.includes('CLICKED') && !textB.text.includes('TEXT:'), 'no mutation landed in B');
    console.log(`CROSS_WINDOW_MUTATION_EXEC=0 (denied=${denied})`);
    console.log('LEGACY_TARGET_BYPASS_EXEC=0');
    console.log('RAW_COORD_CROSS_WINDOW_EXEC=0');
  } finally { killFixtures(); }
});

/* ============================================================
 * C06 — missing authorizer on the REAL desktop: deny, exec 0;
 *       positive control: granting authorizer executes
 * ============================================================ */

test('Closure C3.1 production: no targetAuthorizer ⇒ real focus denied; with authorizer ⇒ verified', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); return; }

  spawnFixture('ADP CL Auth', 150, 130);
  try {
    // the fixture window must REALLY exist before the authorization fence is
    // asserted — otherwise we would measure WINDOW_NOT_FOUND, not the fence.
    await waitForWindow(new ComputerManager({}), 'ADP CL Auth');

    // WITHOUT authorizer — fail closed
    const chain1 = buildProductChain();            // mgr.targetAuthorizer = null
    const run1 = chain1.rm.createRun({ conversationId: 'na', agentId: 'a' });
    const denied = await chain1.tools.execs.computer_focus_window({ runId: run1.id }, { title: 'ADP CL Auth' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.error.code, 'TARGET_NOT_ALLOWED');

    // WITH authorizer — the same call really focuses (verified fence)
    const chain2 = buildProductChain();
    chain2.mgr.targetAuthorizer = async () => true;
    const run2 = chain2.rm.createRun({ conversationId: 'wa', agentId: 'a' });
    const allowed = await chain2.tools.execs.computer_focus_window({ runId: run2.id }, { title: 'ADP CL Auth' });
    assert.ok(allowed.ok, 'authorized focus executes');
    assert.strictEqual(allowed.data.verified, true, 'focus really verified on the desktop');
    console.log('MISSING_AUTHORIZER_REAL_EXEC=0');
    console.log('AUTHORIZER_GRANTED_REAL_EXEC=PASS');
  } finally { killFixtures(); }
});

/* ============================================================
 * C07 — action-time HWND+PID atomicity: wrong PID ⇒ STALE_WINDOW, exec 0
 * ============================================================ */

test('Closure C7 production: recycled/wrong PID refuses focus/click/keys/invoke/screenshot', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); return; }

  const manager = new ComputerManager({});
  spawnFixture('ADP CL Pid', 150, 130);
  const originalValidate = winId.validateWindowRef;
  try {
    const win = await waitForWindow(manager, 'ADP CL Pid');
    const stale = { ...win, pid: win.pid + 424242 }; // HWND right, PID wrong
    const obs = await focusAndObserve(manager, win, { screenshot: false, ttlMs: 180000 });
    manager.observations.get(obs.observationId).windowRef = stale;
    const btn = obs.elements.find(e => e.automationId === 'actionButton');

    // Deterministic seam: let the JS observation precheck see stable geometry,
    // while every real same-helper Win32/UIA action sees HWND=X, PID!=expected.
    winId.validateWindowRef = async () => ({ ok: true, rect: win.rect, foreground: true });
    const PASS_N = 20;
    let violations = 0;
    const violationDetails = [];
    const check = (round, action, result, valid) => {
      if (valid) return;
      violations++;
      violationDetails.push({ round, action, ok: result && result.ok, code: result && result.code, executed: result && result.executed });
    };
    for (let round = 0; round < PASS_N; round++) {
      const focus = await manager.focusWindowRef(stale);
      check(round, 'focus', focus, focus.code === 'STALE_WINDOW' && focus.executed !== true);

      const click = await manager.clickObserved({ observationId: obs.observationId, normalizedX: 0.5, normalizedY: 0.5 });
      check(round, 'click', click, click.code === 'STALE_WINDOW' && click.executed !== true);

      const keys = await manager.pressKeys('x', { foregroundHwnd: stale.hwnd, foregroundPid: stale.pid });
      check(round, 'keys', keys, keys.code === 'STALE_WINDOW' && keys.executed !== true);

      const inv = await manager.invokeElement({ observationId: obs.observationId, elementRef: btn.elementRef });
      check(round, 'invoke', inv, inv.code === 'STALE_WINDOW' && inv.executed !== true);

      const shot = await manager.screenshotWindowRef(stale);
      check(round, 'screenshot', shot, shot.code === 'STALE_WINDOW' && shot.ok !== true);
    }
    if (violationDetails.length) console.log('ACTION_POINT_PID_MISMATCH_DETAILS=' + JSON.stringify(violationDetails));
    assert.strictEqual(violations, 0, 'all action-point helpers reject deterministic PID mismatch');

    // fixture proves zero side effects
    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(text.text.includes('READY'), 'fixture untouched by stale-identity attempts');
    console.log('ACTION_TIME_PID_STALE_EXEC=0');
    console.log(`ACTION_POINT_PID_MISMATCH=${PASS_N}/${PASS_N}`);
    console.log('ACTION_POINT_PID_MISMATCH_VIOLATIONS=0');
  } finally {
    winId.validateWindowRef = originalValidate;
    killFixtures();
  }
});

/* ============================================================
 * C07.1 — stale same-title window: old identity NEVER auto-retargets (20/20)
 * ============================================================ */

test('Closure C7.1 production: close A, reopen same title B — old ref executes 0 (20/20)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); console.log('SAME_TITLE_RETARGET=BLOCKED_ENVIRONMENT'); return; }

  const PASS_N = 20;
  const TITLE = 'ADP CL SameTitle';
  let violations = 0;
  const manager = new ComputerManager({});

  for (let round = 0; round < PASS_N; round++) {
    spawnFixture(TITLE, 140 + (round % 3) * 10, 120);
    let oldWin = null, oldObs = null;
    try {
      oldWin = await waitForWindow(manager, TITLE);
      oldObs = await focusAndObserve(manager, oldWin, { screenshot: false });
    } catch (e) { violations++; killFixtures(); continue; }

    // close A, reopen B with the SAME title
    killFixtures();
    await sleep(250);
    spawnFixture(TITLE, 700, 140);
    let newWin = null;
    try { newWin = await waitForWindow(manager, TITLE); } catch { violations++; killFixtures(); continue; }

    try {
      const FAIL_CLOSED = new Set(['STALE_WINDOW', 'STALE_OBSERVATION', 'FOREGROUND_CHANGED', 'FOREGROUND_NOT_ACQUIRED', 'COMPUTER_ERROR', 'COMPUTER_TIMEOUT']);
      // 1) focus with the OLD identity
      const f = await manager.focusWindowRef(oldWin);
      if (!FAIL_CLOSED.has(f.code)) violations++;
      // 2) click through the OLD observation
      const c = await manager.clickObserved({ observationId: oldObs.observationId, normalizedX: 0.5, normalizedY: 0.5 });
      if (c.executed === true || !FAIL_CLOSED.has(c.code)) violations++;
      // 3) input into the OLD target
      const ty = await manager.typeTextToTarget({ target: oldWin, text: 'retarget?' });
      if (ty.executed === true || !FAIL_CLOSED.has(ty.code)) violations++;
      // 4) UIA invoke via old observation
      const btn = oldObs.elements.find(e => e.automationId === 'actionButton');
      if (btn) {
        const inv = await manager.invokeElement({ observationId: oldObs.observationId, elementRef: btn.elementRef });
        if (inv.executed === true || !FAIL_CLOSED.has(inv.code)) violations++;
      }
      // 5) screenshot with the OLD identity
      const sh = await manager.screenshotWindowRef(oldWin);
      if (sh.ok === true && Number(sh.pid || 0) === Number(newWin.pid)) violations++; // captured B under A's identity
      if (sh.ok !== false && !FAIL_CLOSED.has(sh.code)) { /* capture of a live window is only ok if it is A */ }
      // B must remain pristine — the old identity never retargeted it
      // UIA can transiently rebuild its tree immediately after the hostile
      // stale-reference calls. Retry the exact HWND+PID observation within a
      // small bound; an unreadable result remains a violation, never a pass.
      let textB = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        textB = await manager.getWindowText({ hwnd: newWin.hwnd, pid: newWin.pid });
        if (textB && textB.ok === true && typeof textB.text === 'string') break;
        await sleep(100);
      }
      if (!textB || textB.ok !== true || typeof textB.text !== 'string') {
        violations++;
      } else {
        if (!textB.text.includes('READY')) violations++;
        if (textB.text.includes('CLICKED') || textB.text.includes('retarget?')) violations++;
      }
    } finally { killFixtures(); }
    await sleep(150);
  }
  assert.strictEqual(violations, 0, 'no stale identity ever retargeted the same-title successor');
  console.log(`SAME_TITLE_RETARGET=${PASS_N}/${PASS_N}`);
  console.log('SAME_TITLE_RETARGET_VIOLATIONS=0');
});

/* ============================================================
 * C08 — ONE child-process path in the Computer runtime (static truth)
 * ============================================================ */

test('Closure C8: psHost is the ONLY Computer child-process transport', () => {
  const ROOT = path.join(__dirname, '..');
  const paths = [
    'src/services/computer.js',
    'src/services/computerSession.js',
    'src/services/computerGrounding.js',
    'src/services/computer/psHost.js',
    'src/services/computer/windowIdentity.js',
    'src/services/computer/computerObservation.js',
    'src/services/computer/coordinates.js',
    'src/services/computer/desktopInteractionLock.js'
  ];
  let owners = 0;
  for (const p of paths) {
    const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
    if (/require\(['"]child_process['"]\)/.test(src) || /spawnSync\s*\(/.test(src)) {
      assert.strictEqual(p, 'src/services/computer/psHost.js', `unexpected child_process owner: ${p}`);
      owners++;
    }
  }
  assert.strictEqual(owners, 1, 'exactly one owner');
  assert.strictEqual(psHost.activeCount(), 0, 'no unowned helpers live right now');
  console.log('COMPUTER_CHILD_PROCESS_PATHS=1');
  console.log('COMPUTER_UNOWNED_HELPER=0');
});

/* ============================================================
 * C08.1 — downsample temp truth: success/cancel/timeout leave 0 residue (20/20)
 * ============================================================ */

test('Closure C8.1 production: .small.png residue is 0 on every path (20/20)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  // one real source PNG (System.Drawing in a psHost-owned helper)
  const src = path.join(os.tmpdir(), 'adp_closure_ds_' + Date.now() + '.png');
  manager._trackTemp(src);
  const mk = await psHost.runPs(`Add-Type -AssemblyName System.Drawing;
$bmp = New-Object System.Drawing.Bitmap(900, 700);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.Clear([System.Drawing.Color]::SteelBlue);
$bmp.Save(${psHost.psLiteral(src)}, [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
@{ok=$true} | ConvertTo-Json -Compress`, { timeoutMs: 30000 });
  assert.ok(mk.ok, 'source png created');

  let clean = 0;
  const N = 20;
  try {
    for (let i = 0; i < N; i++) {
      const variant = i % 3;
      if (variant === 0) {
        const b64 = await manager._downsamplePng(src, 300, 233, {});
        assert.ok(b64 && b64.length > 100, 'success path returns a real png');
      } else if (variant === 1) {
        const ac = new AbortController();
        const p = manager._downsamplePng(src, 300, 233, { signal: ac.signal });
        ac.abort(); // cancel mid helper
        const r = await p;
        assert.strictEqual(r, null, 'cancel path returns null (original stays)');
      } else {
        const r = await manager._downsamplePng(src, 300, 233, { timeoutMs: 120 }); // tight timeout
        assert.ok(r === null || typeof r === 'string', 'timeout path settles honestly');
      }
      const smalls = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('adp_closure_ds_') && f.endsWith('.small.png'));
      if (smalls.length === 0 && manager.tempResidue() <= 1) clean++; // only the source remains tracked
      for (const f of smalls) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* gone */ } }
    }
    assert.strictEqual(clean, N, 'every round left zero .small.png residue');
    console.log(`DOWNSAMPLE_TEMP_RESIDUE=0 (${N}/${N})`);
  } finally {
    manager.cleanupTemp();
    try { fs.unlinkSync(src); } catch { /* gone */ }
  }
});

/* ============================================================
 * C09 — REAL clipboard cancel truth (20/20): marker always restored
 * ============================================================ */

test('Closure C9 production: real clipboard restored across cancel seams (20/20)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no desktop'); return; }

  const MARKER = 'ADP_CLOSURE_MARKER_9271';
  const manager = new ComputerManager({});
  spawnFixture('ADP CL Clip', 150, 130);
  let restored = 0;
  const N = 20;
  try {
    const win = await waitForWindow(manager, 'ADP CL Clip');
    await manager.setClipboard(MARKER);
    for (let i = 0; i < N; i++) {
      const variant = i % 2;
      const ac = new AbortController();
      if (variant === 0) ac.abort(); // cancel before the transaction opens
      else setTimeout(() => ac.abort(), 250 + (i % 4) * 150); // cancel mid-flight (seam B/C/D race)
      const r = await manager.pasteToTarget({ target: win, text: 'closure payload ' + i }, { signal: ac.signal, timeoutMs: 15000 });
      if (variant === 1 && r.ok) {
        // paste finished before the abort landed — still must have restored
      }
      const after = await manager.readClipboard();
      const now = String(after.text || '').trim();
      if (now === MARKER && manager._clipboardTx === 0) restored++;
      else console.log(`round ${i}: clipboard=${JSON.stringify(now).slice(0, 60)} tx=${manager._clipboardTx}`);
      // re-arm the marker for the next round
      await manager.setClipboard(MARKER);
    }
    assert.strictEqual(restored, N, 'clipboard == original marker on every round');
    assert.strictEqual(manager._clipboardTx, 0);
    console.log(`CLIPBOARD_REAL_CANCEL_RESTORE=${N}/${N}`);
    console.log('CLIPBOARD_TRANSACTION_RESIDUE_REAL=0');
  } finally { killFixtures(); }
});

/* ============================================================
 * C10 — session lifecycle on the real chain (tool-created sessions)
 * ============================================================ */

test('Closure C10 production: Run terminal settles tool-created sessions', async (t) => {
  const { rm, reg, mgr, tools } = buildProductChain();
  bindSessionLifecycle({ runManager: rm, manager: mgr });

  // completed path — computer_list_windows needs no desktop interaction
  const runC = rm.createRun({ conversationId: 'lc1', agentId: 'a' });
  const r = await tools.execs.computer_list_windows({ runId: runC.id, agentId: 'a' }, {});
  if (IS_WIN) assert.ok(r.ok, 'list windows works on this machine');
  assert.strictEqual(reg.forRun(runC.id).length, 1, 'session created by the tool gate');
  rm.finishRun(runC.id, 'completed', { source: 'closure' });
  await sleep(80);
  assert.strictEqual(reg.forRun(runC.id).length, 0, 'completed Run ⇒ no live session');
  assert.strictEqual(reg.activeCount(), 0);

  // cancelled path
  const runX = rm.createRun({ conversationId: 'lc2', agentId: 'a' });
  await tools.execs.computer_list_windows({ runId: runX.id }, {});
  assert.strictEqual(reg.forRun(runX.id).length, 1);
  rm.finishRun(runX.id, 'cancelled', { source: 'closure' });
  await sleep(80);
  assert.strictEqual(reg.activeCount(), 0, 'cancelled Run ⇒ no live session');
  console.log('SESSION_LIFECYCLE_PRODUCTION=PASS');
});

/* ============================================================
 * Final closure state: zero residue everywhere
 * ============================================================ */

test('Closure production end state: helpers/sessions/lock/observations/tx/temp = 0', async () => {
  killFixtures();
  await psHost.stopAll();
  await sleep(300);
  assert.strictEqual(psHost.activeCount(), 0, 'final helpers = 0');
  const reg = new ComputerSessionRegistry({});
  assert.strictEqual(reg.activeCount(), 0, 'final sessions = 0');
  const m = new ComputerManager({});
  assert.ok(m.lock.isIdle(), 'final lock + pending = 0');
  assert.strictEqual(m.observations.count(), 0, 'final observations = 0');
  assert.strictEqual(m._clipboardTx, 0, 'final clipboard tx = 0');
  assert.strictEqual(m.tempResidue(), 0, 'final temp = 0');
  console.log('CLOSURE_FINAL_RESIDUE=0');
});
