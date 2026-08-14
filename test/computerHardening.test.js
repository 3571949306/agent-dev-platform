'use strict';
/**
 * P3 Computer Use Production Hardening — deterministic hardening suite.
 *
 * Machine proofs produced here:
 *   DPI_TRANSFORM_100/125/150/200=PASS   NEGATIVE_MONITOR_COORDS=PASS
 *   AMBIGUOUS_TITLE_FAIL_CLOSED=PASS     STALE_WINDOW_FAIL_CLOSED=PASS
 *   STALE_OBSERVATION_LOGIC=PASS         ELEMENT_REF_STALE_LOGIC=PASS
 *   DESKTOP_INTERACTION_INTERLEAVE=0     LOCK_CANCEL_PENDING=PASS
 *   SESSION_ROOT_LINEAGE=PASS            SESSION_SELF_REPORTED_ROOT_DENIED=PASS
 *   TARGET_FENCE=PASS                    UNSOLICITED_SHUTDOWN_EXEC=0
 *   STALE_SHUTDOWN_INTENT_EXEC=0         SYSTEM_ACTION_REQUIRES_CURRENT_INTENT=PASS
 *   VISION_LOW_CONFIDENCE_EXEC=0         VISION_GROUNDING_VALIDATE=PASS
 *   COMPUTER_SECRET_HISTORY_LEAK=0       CLIPBOARD_RESTORE=PASS
 *   COMPUTER_PROCESS_TREE_RESIDUE=0      COMPUTER_CANCEL_RACE=20/20
 *   COMPUTER_TEMP_RESIDUE=0
 *
 * Real-desktop interaction proofs live in computerHardeningProduction.test.js.
 * Paid provider calls in this suite: 0 (fake vision provider only).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coords = require('../src/services/computer/coordinates');
const { resolveFromList } = require('../src/services/computer/windowIdentity');
const { ObservationStore, makeElementRef, parseElementRef, elementRefMatches } = require('../src/services/computer/computerObservation');
const { DesktopInteractionLock } = require('../src/services/computer/desktopInteractionLock');
const { ComputerSessionRegistry } = require('../src/services/computerSession');
const { RunManager } = require('../src/agent/runManager');
const gate = require('../src/security/systemIntentGate');
const { validateGroundingResponse } = require('../src/services/computerGrounding');
const { ComputerManager } = require('../src/services/computer');
const psHost = require('../src/services/computer/psHost');

/* ------------------------------------------------------------- coordinates */

test('P3 DPI transform: normalized → physical is exact at 100/125/150/200%', () => {
  // A 400x300 window at (100,50). The helper process is DPI-aware, so the rect
  // arrives in PHYSICAL pixels; a logical (DPI-unaware) rect carries dpiScale.
  const cases = [
    { percent: 100, token: 'DPI_TRANSFORM_100' },
    { percent: 125, token: 'DPI_TRANSFORM_125' },
    { percent: 150, token: 'DPI_TRANSFORM_150' },
    { percent: 200, token: 'DPI_TRANSFORM_200' }
  ];
  for (const c of cases) {
    const scale = coords.scaleFromPercent(c.percent);
    // logical rect from a DPI-unaware source → physical truth via dpiScale
    const logicalRect = { x: 100, y: 50, width: 400, height: 300, dpiScale: scale };
    const center = coords.normalizedToScreenPhysical(0.5, 0.5, logicalRect);
    assert.ok(center.ok, `${c.percent}%: transform succeeds`);
    assert.strictEqual(center.x, Math.round((100 + 200) * scale), `${c.percent}%: x exact`);
    assert.strictEqual(center.y, Math.round((50 + 150) * scale), `${c.percent}%: y exact`);
    // fence must accept the produced point and reject one window-width away
    assert.ok(coords.withinBounds(center.x, center.y, logicalRect), `${c.percent}%: inside bounds`);
    assert.ok(!coords.withinBounds(center.x + Math.round(500 * scale), center.y, logicalRect), `${c.percent}%: outside bounds rejected`);
    // round-trip: physical back to normalized
    const back = coords.screenPhysicalToNormalized(center.x, center.y, logicalRect);
    assert.ok(back.ok && Math.abs(back.normalizedX - 0.5) < 0.01 && Math.abs(back.normalizedY - 0.5) < 0.01, `${c.percent}%: round trip`);
    console.log(`${c.token}=PASS`);
  }
  // NaN / Infinity / string injection refused
  assert.strictEqual(coords.isValidNormalized(Number.NaN, 0.5), false);
  assert.strictEqual(coords.isValidNormalized(Infinity, 0.5), false);
  assert.strictEqual(coords.isValidNormalized('0.5', 0.5), false);
  assert.ok(!coords.normalizedToScreenPhysical(Number.NaN, 0.5, { x: 0, y: 0, width: 100, height: 100 }).ok);
});

test('P3 multi-monitor: negative virtual-screen coordinates work', () => {
  // monitor LEFT of primary: virtual origin x = -1920
  const virtualScreen = { x: -1920, y: -1080, width: 1920 + 2560, height: 1080 + 1440 };
  const leftMonitorWindow = { x: -1800, y: -900, width: 800, height: 600 };
  const p = coords.normalizedToScreenPhysical(0.25, 0.25, leftMonitorWindow);
  assert.ok(p.ok);
  assert.strictEqual(p.x, -1800 + 200);
  assert.strictEqual(p.y, -900 + 150);
  assert.ok(coords.withinBounds(p.x, p.y, leftMonitorWindow), 'negative-coord point inside its window');
  assert.ok(coords.withinVirtualScreen(leftMonitorWindow, virtualScreen), 'window inside virtual screen');
  assert.ok(!coords.withinVirtualScreen({ x: -5000, y: 0, width: 100, height: 100 }, virtualScreen), 'outside virtual screen rejected');
  // monitor ABOVE primary: negative Y
  const aboveWindow = { x: 300, y: -700, width: 640, height: 480 };
  const p2 = coords.normalizedToScreenPhysical(0.5, 0.5, aboveWindow);
  assert.strictEqual(p2.y, -700 + 240);
  assert.ok(p2.y < 0, 'negative Y preserved');
  console.log('NEGATIVE_MONITOR_COORDS=PASS');
});

/* -------------------------------------------------------- window identity */

const FAKE_WINDOWS = [
  { hwnd: 101, pid: 11, title: 'Untitled - Notepad', processName: 'notepad', rect: { x: 0, y: 0, width: 800, height: 600 } },
  { hwnd: 102, pid: 12, title: 'Untitled - Notepad', processName: 'notepad', rect: { x: 100, y: 100, width: 800, height: 600 } },
  { hwnd: 201, pid: 21, title: 'WorkBuddy — Chat', processName: 'workbuddy', rect: { x: 0, y: 0, width: 1000, height: 700 } }
];

test('P3 window identity: ambiguous titles fail closed, hwnd is exact', () => {
  const amb = resolveFromList(FAKE_WINDOWS, { title: 'Untitled - Notepad' });
  assert.strictEqual(amb.ok, false);
  assert.strictEqual(amb.code, 'AMBIGUOUS_WINDOW');
  assert.strictEqual(amb.candidates, 2);
  // two same-title windows must NEVER be resolved by picking the first
  const sub = resolveFromList(FAKE_WINDOWS, { title: 'Notepad' });
  assert.strictEqual(sub.code, 'AMBIGUOUS_WINDOW');
  // unique substring resolves
  const wb = resolveFromList(FAKE_WINDOWS, { title: 'WorkBuddy' });
  assert.ok(wb.ok && wb.window.hwnd === 201);
  // exact title beats substring
  const exact = resolveFromList(FAKE_WINDOWS, { title: 'WorkBuddy — Chat' });
  assert.ok(exact.ok && exact.window.hwnd === 201);
  // hwnd + pid guard
  const byHwnd = resolveFromList(FAKE_WINDOWS, { hwnd: 101 });
  assert.ok(byHwnd.ok && byHwnd.window.hwnd === 101);
  const pidMismatch = resolveFromList(FAKE_WINDOWS, { hwnd: 101, pid: 999 });
  assert.strictEqual(pidMismatch.code, 'STALE_WINDOW', 'recycled HWND with wrong PID is stale');
  const missing = resolveFromList(FAKE_WINDOWS, { hwnd: 404 });
  assert.strictEqual(missing.code, 'STALE_WINDOW');
  const none = resolveFromList(FAKE_WINDOWS, { title: 'Does Not Exist' });
  assert.strictEqual(none.code, 'WINDOW_NOT_FOUND');
  console.log('AMBIGUOUS_TITLE_FAIL_CLOSED=PASS');
  console.log('STALE_WINDOW_FAIL_CLOSED=PASS');
  console.log('WINDOW_STABLE_HWND=PASS');
});

/* ----------------------------------------------------------- observations */

test('P3 observation fence: TTL, geometry drift, session mismatch all reject', () => {
  let now = 1_000_000;
  const store = new ObservationStore({ now: () => now });
  const ref = { hwnd: 101, pid: 11, title: 'Untitled - Notepad' };
  const rect = { x: 100, y: 100, width: 800, height: 600 };
  const obs = store.create({ sessionId: 's1', windowRef: ref, windowRect: rect, ttlMs: 5000 });

  // fresh + unchanged geometry → ok
  assert.ok(store.validate(obs.observationId, { ok: true, rect, foreground: true }).ok);
  // window moved 300px → STALE_OBSERVATION, exec must be 0
  const moved = store.validate(obs.observationId, { ok: true, rect: { ...rect, x: rect.x + 300 }, foreground: true });
  assert.strictEqual(moved.code, 'STALE_OBSERVATION');
  // window closed → STALE_WINDOW propagated
  const closed = store.validate(obs.observationId, { ok: false, code: 'STALE_WINDOW' });
  assert.strictEqual(closed.code, 'STALE_WINDOW');
  // foreground stolen when foreground required
  const fg = store.validate(obs.observationId, { ok: true, rect, foreground: false }, { requireForeground: true });
  assert.strictEqual(fg.code, 'FOREGROUND_CHANGED');
  // TTL expiry
  now += 5001;
  assert.strictEqual(store.validate(obs.observationId, { ok: true, rect, foreground: true }).code, 'STALE_OBSERVATION');
  // unknown observation id
  assert.strictEqual(store.validate('obs_missing', { ok: true, rect }).code, 'OBSERVATION_NOT_FOUND');
  // session isolation
  now = 1_000_000;
  const obs2 = store.create({ sessionId: 's2', windowRef: ref, windowRect: rect });
  assert.ok(store.get(obs2.observationId));
  store.invalidateForSession('s2');
  assert.strictEqual(store.get(obs2.observationId), null);
  console.log('STALE_OBSERVATION_LOGIC=PASS');
  console.log('FOREGROUND_FENCE_LOGIC=PASS');
});

test('P3 elementRef: stable encode/decode, stale detection is exact (no fuzzy match)', () => {
  const refA = makeElementRef({ runtimeId: [42, 7], path: [0, 2, 1], automationId: 'okBtn', controlType: 'Button' });
  const parsed = parseElementRef(refA);
  assert.ok(parsed, 'elementRef round-trips');
  assert.deepStrictEqual(parsed.runtimeId, [42, 7]);
  assert.deepStrictEqual(parsed.path, [0, 2, 1]);
  assert.strictEqual(parsed.automationId, 'okBtn');
  // same element → matches
  assert.ok(elementRefMatches(parsed, { runtimeId: [42, 7], path: [0, 2, 1] }));
  // control replaced (new RuntimeId) → STALE_ELEMENT, never "most similar"
  assert.ok(!elementRefMatches(parsed, { runtimeId: [43, 7], path: [0, 2, 1] }));
  // tree reshuffled (different path) → stale
  assert.ok(!elementRefMatches(parsed, { runtimeId: [42, 7], path: [0, 3, 1] }));
  // garbage ref → null
  assert.strictEqual(parseElementRef('e:not-valid'), null);
  console.log('ELEMENT_REF_STALE_LOGIC=PASS');
});

/* ------------------------------------------------------------- desktop lock */

test('P3 desktop lock: two sessions NEVER interleave mutations (20/20)', async () => {
  for (let round = 0; round < 20; round++) {
    const lock = new DesktopInteractionLock();
    const events = [];
    const worker = async (sessionId, n) => {
      for (let i = 0; i < 3; i++) {
        const token = await lock.acquire({ sessionId, reason: 'mutation' });
        events.push(`enter:${sessionId}:${i}`);
        assert.strictEqual(lock.holder().sessionId, sessionId, 'holder is me while inside');
        await new Promise(r => setTimeout(r, 1)); // overlap window
        events.push(`leave:${sessionId}:${i}`);
        token.release();
      }
    };
    await Promise.all([worker('A', round), worker('B', round)]);
    // interleave = an enter:B between enter:A and leave:A (or vice versa)
    let open = null;
    for (const ev of events) {
      const [kind, id] = ev.split(':');
      if (kind === 'enter') {
        assert.strictEqual(open, null, `round ${round}: mutation interleave detected at ${ev}`);
        open = id;
      } else {
        assert.strictEqual(open, id, 'release matches holder');
        open = null;
      }
    }
    assert.ok(lock.isIdle(), 'lock idle after round');
  }
  console.log('DESKTOP_INTERACTION_INTERLEAVE=0');
});

test('P3 desktop lock: cancelled session never inherits the lock', async () => {
  const lock = new DesktopInteractionLock();
  const tA = await lock.acquire({ sessionId: 'A' });
  let bRejected = false;
  const bPromise = lock.acquire({ sessionId: 'B' }).catch(e => { bRejected = e.code === 'LOCK_ACQUIRE_CANCELLED'; });
  lock.cancelPending('B');
  await bPromise;
  assert.ok(bRejected, 'pending acquire of cancelled session rejects');
  assert.strictEqual(lock.holder().sessionId, 'A', 'A still holds the lock');
  tA.release();
  // next waiter (C) still gets served in order
  const tC = await lock.acquire({ sessionId: 'C' });
  assert.strictEqual(lock.holder().sessionId, 'C');
  tC.release();
  assert.ok(lock.isIdle());
  console.log('LOCK_CANCEL_PENDING=PASS');
});

/* --------------------------------------------------------------- sessions */

test('P3 session identity: rootRunId comes from REAL RunManager lineage only', () => {
  const rm = new RunManager({ emit: () => {} });
  const root = rm.createRun({ conversationId: 'c1', agentId: 'main' });
  const child = rm.createRun({ conversationId: 'c2', agentId: 'sub', parentRunId: root.id });
  const reg = new ComputerSessionRegistry({ runManager: rm });

  const r1 = reg.create({ runId: child.id, ownerAgentId: 'sub-agent' });
  assert.ok(r1.ok, 'session created for a real run');
  assert.strictEqual(r1.session.rootRunId, root.id, 'root derived from lineage, not self-reported');

  // model/renderer self-reported a runId that does not exist → DENIED
  const fake = reg.create({ runId: 'self-reported-run-id' });
  assert.strictEqual(fake.ok, false);
  assert.strictEqual(fake.code, 'SESSION_UNKNOWN_RUN');

  // no run at all with a runManager present → DENIED
  const noRun = reg.create({});
  assert.strictEqual(noRun.code, 'SESSION_RUN_REQUIRED');
  console.log('SESSION_ROOT_LINEAGE=PASS');
  console.log('SESSION_SELF_REPORTED_ROOT_DENIED=PASS');
});

test('P3 target fence: specialist bound to Notepad cannot drive Chrome', () => {
  const reg = new ComputerSessionRegistry({});
  const r = reg.create({ runId: 'run-x' });
  const sid = r.session.sessionId;
  const notepad = { hwnd: 101, pid: 11, title: 'Untitled - Notepad' };
  const chrome = { hwnd: 301, pid: 31, title: 'Google Chrome' };

  // nothing authorized yet → denied
  assert.strictEqual(reg.assertTargetAllowed(sid, notepad).code, 'TARGET_NOT_ALLOWED');
  reg.allowTarget(sid, notepad);
  assert.ok(reg.assertTargetAllowed(sid, notepad).ok, 'bound window allowed');
  const cross = reg.assertTargetAllowed(sid, chrome);
  assert.strictEqual(cross.code, 'TARGET_NOT_ALLOWED', 'cross-window attempt denied');
  // terminal sessions refuse everything
  reg.setStatus(sid, 'CANCELLED');
  assert.strictEqual(reg.assertTargetAllowed(sid, notepad).code, 'SESSION_TERMINATED');
  console.log('TARGET_FENCE=PASS');
});

/* -------------------------------------------------------- system intent gate */

test('P3 system intent: unsolicited shutdown executes 0, stale intent executes 0', async () => {
  let spawned = 0;
  const runIfAllowed = async (command, currentUserMessage, confirm) => {
    const v = await gate.authorizeSystemAction({ command, currentUserMessage, confirm });
    if (v.allowed) spawned++;
    return v;
  };

  // adversarial: current goal is "finish tests and report", model wants shutdown
  const un = await runIfAllowed('shutdown /s /t 30', '完成测试并给出结果', async () => ({ approved: true }));
  assert.strictEqual(un.allowed, false);
  assert.strictEqual(un.code, 'SYSTEM_ACTION_NO_CURRENT_INTENT');

  // stale: history once mentioned 关机, current request does not
  const stale = await runIfAllowed('shutdown /r /t 0', '帮我检查这个项目的代码', async () => ({ approved: true }));
  assert.strictEqual(stale.allowed, false);

  // no confirm channel at all → fail closed even with matching intent
  const noChan = await runIfAllowed('shutdown /s', '请帮我关机', null);
  assert.strictEqual(noChan.allowed, false);
  assert.strictEqual(noChan.code, 'SYSTEM_ACTION_CONFIRM_UNAVAILABLE');

  // user declined the destructive confirmation
  const denied = await runIfAllowed('shutdown /s', '请帮我关机', async () => ({ approved: false }));
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.code, 'SYSTEM_ACTION_USER_DENIED');

  // the ONLY allowed path: current intent + explicit confirmation
  const ok = await runIfAllowed('shutdown /s /t 60', '帮我关机', async () => ({ approved: true }));
  assert.ok(ok.allowed);

  assert.strictEqual(spawned, 1, 'exactly the fully-authorized case spawns');
  // restart / format / diskpart detected too
  assert.ok(gate.detectSystemAction('shutdown /r').isSystem);
  assert.ok(gate.detectSystemAction('Restart-Computer').isSystem);
  assert.ok(gate.detectSystemAction('format D: /fs:ntfs').isSystem);
  assert.ok(gate.detectSystemAction('diskpart').isSystem);
  assert.ok(gate.detectSystemAction('rundll32 powrprof.dll,SetSuspendState').isSystem);
  assert.ok(!gate.detectSystemAction('npm test').isSystem);
  assert.ok(!gate.detectSystemAction('git status').isSystem);
  console.log('UNSOLICITED_SHUTDOWN_EXEC=0');
  console.log('STALE_SHUTDOWN_INTENT_EXEC=0');
  console.log('SYSTEM_ACTION_REQUIRES_CURRENT_INTENT=PASS');
});

/* --------------------------------------------------------------- grounding */

test('P3 vision grounding: low confidence executes 0; strict validation', () => {
  // low confidence → refused (blind clicks forbidden)
  const low = validateGroundingResponse({ action: 'click', normalizedX: 0.5, normalizedY: 0.5, confidence: 0.3, target: 'button' });
  assert.strictEqual(low.ok, false);
  assert.strictEqual(low.code, 'COMPUTER_GROUNDING_LOW_CONFIDENCE');
  // malformed model output → refused
  assert.strictEqual(validateGroundingResponse(null).code, 'GROUNDING_BAD_OUTPUT');
  assert.strictEqual(validateGroundingResponse({ action: 'explode', confidence: 1 }).code, 'GROUNDING_BAD_OUTPUT');
  assert.strictEqual(validateGroundingResponse({ action: 'click', normalizedX: 1.5, normalizedY: 0.5, confidence: 0.9 }).code, 'GROUNDING_BAD_OUTPUT');
  assert.strictEqual(validateGroundingResponse({ action: 'click', normalizedX: Number.NaN, normalizedY: 0.5, confidence: 0.9 }).code, 'GROUNDING_BAD_OUTPUT');
  // valid grounding passes
  const good = validateGroundingResponse({ action: 'click', normalizedX: 0.4, normalizedY: 0.6, confidence: 0.9, target: '提交按钮', reason: 'visible' });
  assert.ok(good.ok);
  assert.strictEqual(good.grounding.action, 'click');
  // action=none never carries coordinates
  const none = validateGroundingResponse({ action: 'none', confidence: 0.9 });
  assert.ok(none.ok && none.grounding.normalizedX === null);
  console.log('VISION_LOW_CONFIDENCE_EXEC=0');
  console.log('VISION_GROUNDING_VALIDATE=PASS');
});

/* ------------------------------------------------------------ redaction */

test('P3 audit redaction: typed secrets never reach history/audit (0 leaks)', () => {
  const SECRET = 'COMPUTER_SECRET_918273';
  const m = new ComputerManager();
  m.recordAction('input_text', { method: 'uia-value', textLength: SECRET.length, valueLength: SECRET.length, raw: SECRET, text: SECRET }, true);
  m.recordAction('paste', { method: 'clipboard', textLength: SECRET.length, clipboard: SECRET }, true);
  m.recordAction('key', { method: 'sendkeys', keysLength: 12, keys: SECRET }, false, 'FOREGROUND_CHANGED');
  const dump = JSON.stringify(m.history(100));
  assert.ok(!dump.includes(SECRET), 'secret must not leak into computer action audit');
  assert.ok(dump.includes('textLength'), 'length metadata is allowed');
  assert.ok(dump.includes('method'), 'method metadata is allowed');
  console.log('COMPUTER_SECRET_HISTORY_LEAK=0');
});

/* -------------------------------------------------------- clipboard chain */

test('P3 clipboard transaction: original content restored even on failure/cancel', async () => {
  const MARKER = 'USER_CLIPBOARD_MARKER_4821';
  let clip = MARKER;
  const writes = [];
  const m = new ComputerManager({
    clipboardFake: {
      read: async () => clip,
      write: async (t) => { clip = t; writes.push(t); }
    }
  });
  // pressKeys would spawn PowerShell; stub the foreground-fenced send path
  m.pressKeys = async () => ({ ok: true, executed: true });

  const r = await m.pasteToTarget({ target: { hwnd: 1 }, text: 'agent payload' });
  assert.ok(r.ok);
  assert.strictEqual(clip, MARKER, 'user clipboard restored after paste');
  assert.ok(writes.includes('agent payload'), 'temp text was set');
  assert.strictEqual(m._clipboardTx, 0, 'transaction closed');

  // failure mid-way (paste refused) → still restored
  m.pressKeys = async () => ({ ok: false, executed: false, code: 'FOREGROUND_CHANGED' });
  const r2 = await m.pasteToTarget({ target: { hwnd: 1 }, text: 'x' });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(clip, MARKER, 'restored on failure');

  // exception mid-way → finally still restores
  m.pressKeys = async () => { throw new Error('boom'); };
  await assert.rejects(m.pasteToTarget({ target: { hwnd: 1 }, text: 'x' }));
  assert.strictEqual(clip, MARKER, 'restored on exception (cancel path)');
  assert.strictEqual(m._clipboardTx, 0);
  console.log('CLIPBOARD_RESTORE=PASS');
});

/* ----------------------------------------------- process tree (real, win) */

test('P3 process tree: nested PowerShell child dies with parent, 20/20 cancel race', async () => {
  if (process.platform !== 'win32') { console.log('COMPUTER_PROCESS_TREE=SKIPPED_NON_WINDOWS'); return; }
  const PASS_N = 20;
  let childResidue = 0, activeResidue = 0;

  const pidAlive = async (pid) => {
    const r = await psHost.runPs(`Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`, { timeoutMs: 8000 });
    if (!r.ok) return false;
    return String(r.data || '').trim().length > 0;
  };

  for (let i = 0; i < PASS_N; i++) {
    const baseline = psHost.activeCount();
    const pidFile = path.join(os.tmpdir(), `adp_p3_tree_${Date.now()}_${i}.pid`);
    const ac = new AbortController();
    // parent powershell spawns a NESTED powershell (grandchild of our runtime)
    // and records the nested pid so the test can verify its death.
    const p = psHost.runPs(
      `$proc = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 45' -PassThru -WindowStyle Hidden; Set-Content -Path '${pidFile.replace(/'/g, "''")}' -Value $proc.Id; Start-Sleep -Seconds 45`,
      { timeoutMs: 60000, signal: ac.signal }
    );
    // wait until the helper is registered AND the nested pid is known
    let nestedPid = 0;
    for (let k = 0; k < 400; k++) {
      await new Promise(r => setTimeout(r, 50));
      if (fs.existsSync(pidFile)) {
        nestedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (nestedPid > 0) break;
      }
    }
    assert.ok(psHost.activeCount() > baseline, `round ${i}: helper is live`);
    assert.ok(nestedPid > 0, `round ${i}: nested child pid discovered`);
    assert.ok(await pidAlive(nestedPid), `round ${i}: nested child alive before cancel`);

    const t0 = Date.now();
    ac.abort(); // cancel → taskkill /PID <parent> /T /F must take the tree down
    const verdict = await p;
    assert.ok(verdict.cancelled || verdict.ok === false, `round ${i}: cancel settles with a verdict`);
    assert.ok(Date.now() - t0 < 15000, `round ${i}: settles promptly, never runs the full 45s`);
    assert.strictEqual(psHost.activeCount(), baseline, `round ${i}: registry reflects confirmed exit`);

    if (await pidAlive(nestedPid)) childResidue++;
    if (psHost.activeCount() !== baseline) activeResidue++;
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
  }

  assert.strictEqual(childResidue, 0, 'descendant residue must be 0');
  assert.strictEqual(activeResidue, 0, 'active registry residue must be 0');
  console.log('COMPUTER_PROCESS_TREE_RESIDUE=0');
  console.log(`COMPUTER_CANCEL_RACE=${PASS_N}/${PASS_N}`);
});

test('P3 timeout path: hung helper killed with confirmed quiescence', async () => {
  if (process.platform !== 'win32') { console.log('COMPUTER_TIMEOUT=SKIPPED_NON_WINDOWS'); return; }
  const baseline = psHost.activeCount();
  const t0 = Date.now();
  const r = await psHost.runPs('Start-Sleep -Seconds 120', { timeoutMs: 1500 });
  assert.ok(!r.ok && r.timedOut, 'timeout verdict is honest');
  assert.ok(Date.now() - t0 < 10000, 'does not run the full 120s');
  assert.strictEqual(psHost.activeCount(), baseline, 'registry back to baseline after confirmed kill');
  console.log('COMPUTER_TIMEOUT=PASS');
});

/* ----------------------------------------------------------- temp residue */

test('P3 temp screenshots: residue tracking and cleanup leave 0 files', () => {
  const m = new ComputerManager();
  const f1 = path.join(os.tmpdir(), 'adp_test_residue_' + Date.now() + '_1.png');
  const f2 = path.join(os.tmpdir(), 'adp_test_residue_' + Date.now() + '_2.png');
  fs.writeFileSync(f1, 'x'); fs.writeFileSync(f2, 'y');
  m._trackTemp(f1); m._trackTemp(f2);
  assert.strictEqual(m.tempResidue(), 2, 'both tracked files counted');
  assert.strictEqual(m.cleanupTemp(), 0, 'cleanup removes everything');
  assert.ok(!fs.existsSync(f1) && !fs.existsSync(f2), 'files really gone');
  console.log('COMPUTER_TEMP_RESIDUE=0');
});

/* -------------------------------------------------- manager fence behavior */

test('P3 clickObserved rejects without observation (mouse exec = 0)', async () => {
  const m = new ComputerManager();
  const r = await m.clickObserved({ observationId: null, normalizedX: 0.5, normalizedY: 0.5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.executed, false);
  assert.strictEqual(r.code, 'STALE_OBSERVATION');
  // bounds violation path (pure check before any OS call)
  const store = m.observations;
  const obs = store.create({ windowRef: { hwnd: 12345, pid: 999999, title: 'ghost' }, windowRect: { x: 0, y: 0, width: 100, height: 100 } });
  // invalid normalized coordinates never reach the OS
  const bad = await m.clickObserved({ observationId: obs.observationId, normalizedX: Number.NaN, normalizedY: 0.5 });
  assert.ok(!bad.ok && bad.executed !== true, 'NaN coordinates rejected');
  console.log('RAW_CLICK_WITHOUT_OBSERVATION_EXEC=0');
});
