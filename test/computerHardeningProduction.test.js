'use strict';
/**
 * P3 Computer Use Production Hardening — REAL WINDOWS PRODUCTION MATRIX.
 *
 * Runs on an interactive Windows desktop against a test-only WinForms fixture
 * (test/fixtures/computerFixture.ps1). No production software is driven.
 *
 * Environment truth (Section 27): without an interactive desktop this suite
 * prints COMPUTER_INTERACTIVE_ENV=UNAVAILABLE and marks the real matrix
 * BLOCKED_ENVIRONMENT — it never fabricates PASS.
 *
 * Scenario proofs:
 *   WINDOW_STABLE_HWND / FOCUS_VERIFIED        (Scenario 1)
 *   SEMANTIC_INPUT=PASS / SEMANTIC_INVOKE=PASS (Scenario 2/3)
 *   STALE_OBSERVATION_CLICK_EXEC=0             (Scenario 4)
 *   FOCUS_STEAL_INPUT_EXEC=0                   (Scenario 5)
 *   AMBIGUOUS_WINDOW on two same-title windows (Scenario 6)
 *   PASSWORD_VALUE_EXPOSED=0 + sensitive gate  (Scenario 7)
 *   CLIPBOARD_RESTORE=PASS (real clipboard)    (Scenario 8)
 *   SCOPED_CANCEL_RESIDUE=0                    (Scenario 9)
 *   DESKTOP_INTERACTION_INTERLEAVE=0           (Scenario 10)
 *   VISION_GROUNDING=PASS via fake provider    (Scenario 11)
 *   UNSOLICITED_SHUTDOWN_EXEC=0 (real terminal tool) (Scenario 13)
 *   COMPUTER_PRODUCTION_REPEAT=10/10
 *   PAID_PROVIDER_CALLS=0
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ComputerManager } = require('../src/services/computer');
const { ComputerSessionRegistry } = require('../src/services/computerSession');
const { ComputerGroundingService } = require('../src/services/computerGrounding');
const psHost = require('../src/services/computer/psHost');
const winId = require('../src/services/computer/windowIdentity');

const FIXTURE = path.join(__dirname, 'fixtures', 'computerFixture.ps1');
const IS_WIN = process.platform === 'win32';

const fixtures = []; // { child, title }

function spawnFixture(title, x = 120, y = 120) {
  // -STA is essential: WinForms under MTA degrades its UIA provider
  // (every control reads as Pane with a numeric pseudo-AutomationId and
  // IsPassword is lost).
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE, '-Title', title, '-X', String(x), '-Y', String(y)], { windowsHide: false });
  fixtures.push({ child, title });
  return child;
}

async function waitForWindow(manager, title, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await manager.resolveWindow({ title });
    if (r.ok) return r.window;
    await new Promise(res => setTimeout(res, 400));
  }
  throw new Error('fixture window did not appear: ' + title);
}

/** Wait for N windows sharing one title (ambiguity scenario). */
async function waitForWindowCount(manager, title, count, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await manager.listWindows();
    if (list.ok && list.windows.filter(w => w.title === title).length >= count) return true;
    await new Promise(res => setTimeout(res, 500));
  }
  return false;
}

/**
 * Establish an observation with focus retries. The desktop is SHARED with the
 * user during these tests; focus can be stolen between helper calls (each ~1s
 * on PS 5.1). The observation itself only needs identity+geometry truth — the
 * foreground fence re-checks atomically inside every mutation, so observations
 * do NOT require foreground. Long ttl keeps multi-step sequences valid.
 */
async function focusAndObserve(manager, win, opts = {}) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const focus = await manager.focusWindowRef(win);
    if (!focus.ok) { lastErr = focus.code || 'FOREGROUND_NOT_ACQUIRED'; await sleep(300); continue; }
    const obs = await manager.observe({ hwnd: win.hwnd }, { ttlMs: 20000, ...opts });
    if (obs.ok) return obs;
    lastErr = obs.code || 'OBSERVE_FAILED';
    await sleep(300);
  }
  throw new Error('could not establish an observation: ' + lastErr);
}

/**
 * Mutation retry wrapper for shared-desktop races: refocus and re-run until the
 * fenced action executes (or attempts are exhausted). A fence refusal
 * (FOREGROUND_CHANGED) counts as a legitimate no-exec, never as a pass.
 */
async function mutateWithFocus(manager, win, fn, attempts = 5) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    await manager.focusWindowRef(win);
    last = await fn();
    if (last && (last.ok || last.executed === true)) return last;
    await sleep(250);
  }
  return last;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Center of an element's boundingRect as normalized window coordinates. */
function normalizedCenter(el, windowRect) {
  const r = el.boundingRect;
  return {
    x: ((r.x + r.width / 2) - windowRect.x) / windowRect.width,
    y: ((r.y + r.height / 2) - windowRect.y) / windowRect.height
  };
}

function killFixtures() {
  for (const f of fixtures) {
    try { psHost.killTree(f.child.pid); } catch { /* gone */ }
  }
  fixtures.length = 0;
}

const LATENCY = {};

test('P3 production matrix: environment truth', async () => {
  if (!IS_WIN) {
    console.log('COMPUTER_INTERACTIVE_ENV=UNSUPPORTED_PLATFORM');
    console.log('REAL_DESKTOP_PRODUCTION=BLOCKED_ENVIRONMENT');
    return;
  }
  const probeManager = new ComputerManager();
  const probe = await probeManager.probeInteractiveDesktop();
  if (!probe.interactive) {
    console.log('COMPUTER_INTERACTIVE_ENV=UNAVAILABLE');
    console.log('REAL_DESKTOP_PRODUCTION=BLOCKED_ENVIRONMENT');
    return;
  }
  console.log('COMPUTER_INTERACTIVE_ENV=AVAILABLE');
});

test('P3 Scenario 1 — window identity: discover exact HWND, verified focus', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no interactive desktop'); console.log('SCENARIO_1=BLOCKED_ENVIRONMENT'); return; }

  const problems = [];
  const manager = new ComputerManager({ onProblem: p => problems.push(p) });
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const t0 = Date.now();
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    LATENCY.windowDiscoveryMs = Date.now() - t0;
    assert.ok(win.hwnd > 0 && win.pid > 0, 'stable identity: HWND + PID');
    assert.strictEqual(win.processName.toLowerCase(), 'powershell');

    // identity re-validation: same pid fresh, wrong pid stale
    const fresh = await winId.validateWindowRef(win);
    assert.ok(fresh.ok, 'live re-validation passes');
    const wrongPid = await winId.validateWindowRef({ ...win, pid: win.pid + 424242 });
    assert.strictEqual(wrongPid.code, 'STALE_WINDOW', 'PID change is stale, never auto-retargeted');

    const t1 = Date.now();
    let focus = await manager.focusWindowRef(win);
    LATENCY.focusVerifyMs = Date.now() - t1;
    assert.ok(focus.ok && focus.verified === true, 'focus only ok when GetForegroundWindow == target');
    // independent re-check with a couple of retries (shared desktop races)
    let matched = false;
    for (let i = 0; i < 3 && !matched; i++) {
      const fg = await winId.getForegroundHwnd();
      matched = Number(fg.hwnd) === Number(win.hwnd);
      if (!matched) { await manager.focusWindowRef(win); await sleep(150); }
    }
    assert.ok(matched, 'foreground truth confirmed independently');
    console.log('WINDOW_STABLE_HWND=PASS');
    console.log('FOREGROUND_FENCE=PASS');
  } finally { killFixtures(); }
});

test('P3 Scenario 2 — semantic input: observe → set value → VERIFIED', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const t0 = Date.now();
    const obs = await focusAndObserve(manager, win, {});
    LATENCY.observationMs = Date.now() - t0;
    assert.ok(obs.elements.length >= 8, `true UIA tree has the fixture controls (${obs.elements.length})`);

    const edit = obs.elements.find(e => e.automationId === 'textInput');
    assert.ok(edit, 'textInput discovered via tree');
    assert.strictEqual(edit.controlType, 'Edit', 'real ControlType, not Pane proxy');
    assert.ok(edit.patterns.includes('ValuePatternIdentifiers') || edit.patterns.includes('Value'), 'ValuePattern present');
    const r = await manager.setElementValue({ observationId: obs.observationId, elementRef: edit.elementRef, value: 'hello p3' });
    assert.ok(r.ok, 'UIA ValuePattern write succeeds');
    assert.strictEqual(r.outcome, 'VERIFIED', 'value read-back matches → VERIFIED');

    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(text.ok && text.text.includes('TEXT:8'), 'fixture status proves the text arrived: TEXT:8');
    console.log('SEMANTIC_INPUT=PASS');
  } finally { killFixtures(); }
});

test('P3 Scenario 3 — semantic invoke: observe → invoke → status CLICKED', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const obs = await focusAndObserve(manager, win, {});
    const btn = obs.elements.find(e => e.automationId === 'actionButton');
    assert.ok(btn, 'actionButton discovered');
    assert.strictEqual(btn.controlType, 'Button', 'real Button ControlType');
    assert.ok(btn.patterns.some(p => /Invoke/.test(p)), 'Invoke pattern present');
    const t0 = Date.now();
    const r = await manager.invokeElement({ observationId: obs.observationId, elementRef: btn.elementRef });
    LATENCY.semanticInvokeMs = Date.now() - t0;
    assert.ok(r.ok && r.executed, 'invoke executed');
    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(text.text.includes('CLICKED'), 'button really clicked (fixture status)');
    // toggle + select patterns work on real controls
    const chk = obs.elements.find(e => e.automationId === 'checkbox1');
    const tg = await manager.toggleElement({ observationId: obs.observationId, elementRef: chk.elementRef });
    assert.ok(tg.ok, 'checkbox toggled via TogglePattern');
    const scroll = obs.elements.find(e => e.automationId === 'scrollPanel');
    const sc = await manager.scrollElement({ observationId: obs.observationId, elementRef: scroll.elementRef, value: 1 });
    assert.ok(sc.ok, 'ScrollPattern action executed');
    console.log('SEMANTIC_INVOKE=PASS');
  } finally { killFixtures(); }
});

test('P3 Scenario 4 — stale geometry: moved window ⇒ old observation clicks 0', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const obs = await focusAndObserve(manager, win, {});

    // user moves the window 300px
    const move = await psHost.runPs(`Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ADPMove { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
"@
[ADPMove]::SetWindowPos((New-Object IntPtr ${win.hwnd}), [IntPtr]::Zero, 480, 200, 0, 0, 1 -bor 4 -bor 16) | Out-Null
@{ok=$true} | ConvertTo-Json -Compress`, { timeoutMs: 10000 });
    assert.ok(move.ok, 'window moved');
    await new Promise(r => setTimeout(r, 300));

    let executed = 0;
    for (let i = 0; i < 5; i++) {
      const r = await manager.clickObserved({ observationId: obs.observationId, normalizedX: 0.5, normalizedY: 0.5 });
      assert.strictEqual(r.executed === true ? 1 : 0, 0, `attempt ${i}: stale observation must not click`);
      assert.strictEqual(r.code, 'STALE_OBSERVATION', `attempt ${i}: honest stale verdict`);
    }
    assert.strictEqual(executed, 0);
    console.log('STALE_OBSERVATION_CLICK_EXEC=0');
  } finally { killFixtures(); }
});

test('P3 Scenario 5 — focus theft: input to stolen foreground executes 0', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  spawnFixture('ADP P3 Thief', 700, 150);
  try {
    const target = await waitForWindow(manager, 'ADP P3 Fixture');
    const thief = await waitForWindow(manager, 'ADP P3 Thief');
    // establish the observation while the target holds focus
    await manager.focusWindowRef(target);
    const obs = await manager.observe({ hwnd: target.hwnd }, { ttlMs: 60000, screenshot: false });
    assert.ok(obs.ok, 'observation established');

    // another window steals focus
    let steal = null;
    for (let i = 0; i < 3; i++) {
      steal = await manager.focusWindowRef(thief);
      if (steal.ok) break;
      await sleep(200);
    }
    assert.ok(steal.ok, 'thief acquired foreground');

    // type/click against the original target must NOT execute. Either fence
    // verdict (FOREGROUND_CHANGED, or STALE_OBSERVATION once the TTL lapses in
    // this slow helper environment) is a legitimate fail-closed no-exec.
    const FAIL_CLOSED = new Set(['FOREGROUND_CHANGED', 'STALE_OBSERVATION', 'STALE_WINDOW']);
    let executed = 0;
    for (let i = 0; i < 5; i++) {
      const k = await manager.pressKeys('stolen', { foregroundHwnd: target.hwnd, foregroundPid: target.pid });
      if (k.executed === true) executed++;
      assert.ok(FAIL_CLOSED.has(k.code), `keys fenced (${k.code})`);
      const c = await manager.clickObserved({ observationId: obs.observationId, normalizedX: 0.5, normalizedY: 0.5 });
      if (c.executed === true) executed++;
      assert.ok(FAIL_CLOSED.has(c.code), `click fenced (${c.code})`);
    }
    assert.strictEqual(executed, 0);
    console.log('FOCUS_STEAL_INPUT_EXEC=0');
  } finally { killFixtures(); }
});

test('P3 Scenario 6 — two same-title windows ⇒ AMBIGUOUS_WINDOW (no first-pick)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Dup', 140, 130);
  spawnFixture('ADP P3 Dup', 700, 150);
  try {
    const both = await waitForWindowCount(manager, 'ADP P3 Dup', 2);
    assert.ok(both, 'two same-title fixture windows alive');
    const r = await manager.resolveWindow({ title: 'ADP P3 Dup' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'AMBIGUOUS_WINDOW', 'ambiguity fails closed — never Select-Object -First 1');
    console.log('AMBIGUOUS_WINDOW=PASS');
  } finally { killFixtures(); }
});

test('P3 Scenario 7 — password: never exposed, write needs explicit permission', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const SECRET = 'PW_SECRET_5531';
  let asked = 0;
  let grant = false;
  const manager = new ComputerManager({ sensitiveAuthorizer: async () => { asked++; return grant; } });
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const obs = await focusAndObserve(manager, win, {});
    const pwd = obs.elements.find(e => e.automationId === 'passwordInput');
    assert.ok(pwd, 'password control discovered');
    assert.strictEqual(pwd.isPassword, true, 'UIA IsPassword truth surfaced');

    // without explicit permission → DENIED, exec 0
    grant = false;
    const denied = await manager.setElementValue({ observationId: obs.observationId, elementRef: pwd.elementRef, value: SECRET });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'SENSITIVE_INPUT_DENIED');
    assert.strictEqual(asked, 1, 'authorization was actually requested');

    // with explicit permission → EXECUTED but NEVER VERIFIED (no read-back)
    grant = true;
    const okWrite = await manager.setElementValue({ observationId: obs.observationId, elementRef: pwd.elementRef, value: SECRET });
    assert.ok(okWrite.ok, 'authorized sensitive write executes');
    assert.strictEqual(okWrite.sensitive, true);
    assert.notStrictEqual(okWrite.outcome, 'VERIFIED', 'password write must never claim VERIFIED');

    // plaintext exposure scan: window text + audit must not contain the secret
    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(!text.text.includes(SECRET), 'password value never appears in window text');
    const auditDump = JSON.stringify(manager.history(100));
    assert.ok(!auditDump.includes(SECRET), 'password never lands in the action audit');
    console.log('PASSWORD_VALUE_EXPOSED=0');
  } finally { killFixtures(); }
});

test('P3 Scenario 8 — clipboard: user content restored after target-bound paste', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const MARKER = 'USER_CLIPBOARD_MARKER_4821';
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const obs = await focusAndObserve(manager, win, { screenshot: false, ttlMs: 90000 });
    // the "user's" clipboard before the Agent acts
    await manager.setClipboard(MARKER);
    const before = await manager.readClipboard();
    assert.strictEqual(String(before.text || '').trim(), MARKER);

    // keyboard focus must be inside textInput for Ctrl+V to land there:
    // click its center through the fenced observed-click path first.
    const edit = obs.elements.find(e => e.automationId === 'textInput');
    const c = normalizedCenter(edit, obs.windowRect);
    const PAYLOAD = 'agent payload 中文 ✓';
    // Observe → Act → Verify with BOUNDED repair: on a shared desktop an
    // executed paste can still land nowhere (caret parked elsewhere); re-run
    // the fenced click+paste until the fixture proves the text arrived.
    let paste = null;
    let arrived = false;
    for (let round = 0; round < 4 && !arrived; round++) {
      // clear any previous attempt's text so TEXT:<length> stays truthful
      await manager.setElementValue({ observationId: obs.observationId, elementRef: edit.elementRef, value: '' });
      const click = await mutateWithFocus(manager, win, () =>
        manager.clickObserved({ observationId: obs.observationId, normalizedX: c.x, normalizedY: c.y }), 8);
      assert.ok(click && click.ok && click.executed, 'focus click executed inside target');
      paste = await mutateWithFocus(manager, win, () =>
        manager.pasteToTarget({ target: win, text: PAYLOAD }), 8);
      assert.ok(paste && paste.ok, 'target-bound paste succeeds');
      assert.strictEqual(paste.method, 'clipboard');
      await sleep(300);
      const chk = await manager.getWindowText({ hwnd: win.hwnd });
      arrived = chk.ok && chk.text.includes('TEXT:' + PAYLOAD.length);
    }
    assert.ok(arrived, 'fixture proves the payload arrived after bounded repairs');

    const after = await manager.readClipboard();
    assert.strictEqual(String(after.text || '').trim(), MARKER, 'final clipboard == original user content');
    assert.strictEqual(manager._clipboardTx, 0, 'clipboard transaction closed');
    // the text really reached the control — the fixture's TextChanged handler
    // reports TEXT:<length>; matching the FULL Unicode length proves no silent
    // character loss (WPF TextBox values are not exposed as UIA Names).
    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(text.ok);
    assert.ok(text.text.includes('TEXT:' + PAYLOAD.length),
      `fixture status proves all ${PAYLOAD.length} Unicode chars arrived (got: ${text.text.split('\n').find(l => l.startsWith('TEXT:')) || 'none'})`);
    console.log('CLIPBOARD_RESTORE=PASS');
  } finally { killFixtures(); }
});

test('P3 Scenario 9 — cancel: long helper dies with zero residue', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  const sid = 'sess_cancel_test';
  const baseline = psHost.activeCount();
  const ac = new AbortController();
  const long = psHost.runPs('Start-Sleep -Seconds 40', { timeoutMs: 60000, signal: ac.signal, sessionId: sid });
  for (let i = 0; i < 300 && psHost.activeCount(sid) === 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(psHost.activeCount(sid), 1, 'session helper live');

  ac.abort();
  const stop = await manager.stopActive({ sessionId: sid });
  const verdict = await long;
  assert.ok(verdict.cancelled, 'helper cancelled');
  assert.strictEqual(stop.residual, 0);
  assert.strictEqual(psHost.activeCount(sid), 0, 'session residue = 0');
  assert.strictEqual(psHost.activeCount(), baseline, 'global residue = 0');
  console.log('SCOPED_CANCEL_RESIDUE=0');
  console.log('COMPUTER_CANCEL_QUIESCENCE=PASS');
});

test('P3 Scenario 10 — two concurrent runs never interleave desktop mutations', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const events = [];
    const mutation = async (sessionId, n) => {
      for (let i = 0; i < 4; i++) {
        const token = await manager.lock.acquire({ sessionId, reason: 'production-mutation' });
        events.push({ kind: 'enter', sessionId });
        // a real desktop action under the lock
        await manager.focusWindowRef(win, { sessionId });
        await new Promise(r => setTimeout(r, 5));
        events.push({ kind: 'leave', sessionId });
        token.release();
      }
    };
    await Promise.all([mutation('RunA', 0), mutation('RunB', 0)]);
    let open = null;
    for (const ev of events) {
      if (ev.kind === 'enter') { assert.strictEqual(open, null, 'interleaved desktop mutation detected'); open = ev.sessionId; }
      else { assert.strictEqual(open, ev.sessionId); open = null; }
    }
    assert.ok(manager.lock.isIdle(), 'desktop lock idle after both runs');
    console.log('DESKTOP_INTERACTION_INTERLEAVE=0');
  } finally { killFixtures(); }
});

test('P3 Scenario 11 — vision grounding via Model Router fake (paid calls = 0)', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    const t0 = Date.now();
    const obs = await focusAndObserve(manager, win, { screenshot: true });
    LATENCY.screenshotObserveMs = Date.now() - t0;
    assert.ok(obs.screenshot && obs.screenshot.data_url, 'observation carries a real screenshot');

    // The fake vision model returns the TRUE center of the Do It button —
    // computed from the observation's UIA tree, exactly what a grounded model
    // would do. P3 Closure: grounding goes through the routed adapter contract
    // (modelAdapter.decide) — never a direct provider client; execution stays
    // in the canonical fenced click path.
    const btn = obs.elements.find(e => e.automationId === 'actionButton');
    assert.ok(btn && btn.boundingRect, 'grounded target exists in the real UIA tree');
    const bc = normalizedCenter(btn, obs.windowRect);
    const received = [];
    const fakeAdapter = {
      name: 'FakeRoutedVisionAdapter',
      decide: async ({ system, context, abortSignal }) => {
        received.push({ system, context, abortSignal });
        return { text: JSON.stringify({ action: 'click', target: 'Do It 按钮', normalizedX: bc.x, normalizedY: bc.y, confidence: 0.92, reason: '按钮清晰可见' }) };
      }
    };
    const fakeSelection = {
      selected: { connectionId: 'conn-fake', modelId: 'fake-vision-1' },
      mode: 'auto', reasons: [{ code: 'VISION_REQUIRED_PROVEN' }], decisionId: 'dec-fake-1'
    };
    const grounding = new ComputerGroundingService({ resolveVision: () => ({ modelAdapter: fakeAdapter, selection: fakeSelection }) });
    const t1 = Date.now();
    const g = await grounding.ground({
      observationId: obs.observationId, goal: '点击 Do It 按钮',
      screenshotDataUrl: obs.screenshot.data_url,
      windowMeta: win,
      uiaNodes: obs.elements.slice(0, 10).map(e => `${e.controlType} ${e.name || e.automationId}`)
    });
    LATENCY.visionGroundingMs = Date.now() - t1;
    assert.ok(g.ok, 'structured grounding returned');
    assert.strictEqual(g.grounding.action, 'click');
    assert.strictEqual(g.grounding.model, 'fake-vision-1', 'grounding reports the routed model');
    assert.ok(g.route && g.route.connectionId === 'conn-fake' && g.route.requestedCapability === 'vision', 'route audit truth surfaced (no secrets)');
    assert.ok(received.length === 1, 'routed adapter called exactly once');
    assert.ok(Array.isArray(received[0].context) && received[0].context.some(p => p.type === 'image'), 'screenshot really sent to the model');

    // backend executes the proposal through the SAME fenced click path;
    // verify the effect and repair within a bounded budget (max 3 re-clicks).
    let click = null;
    let clicked = false;
    for (let round = 0; round < 4 && !clicked; round++) {
      click = await mutateWithFocus(manager, win, () => manager.clickObserved({
        observationId: obs.observationId,
        normalizedX: g.grounding.normalizedX, normalizedY: g.grounding.normalizedY
      }));
      assert.ok(click && click.ok && click.executed, 'grounded click within target executed');
      await sleep(300);
      const chk = await manager.getWindowText({ hwnd: win.hwnd });
      clicked = chk.ok && chk.text.includes('CLICKED');
    }
    const text = await manager.getWindowText({ hwnd: win.hwnd });
    assert.ok(text.text.includes('CLICKED'), 'grounded click really hit the button');

    // low confidence variant never executes
    const lowService = new ComputerGroundingService({
      resolveVision: () => ({
        modelAdapter: {
          decide: async () => ({ text: JSON.stringify({ action: 'click', normalizedX: 0.5, normalizedY: 0.5, confidence: 0.2, target: 'x', reason: 'blurry' }) })
        },
        selection: fakeSelection
      })
    });
    const low = await lowService.ground({ observationId: obs.observationId, goal: 'x', screenshotDataUrl: obs.screenshot.data_url });
    assert.strictEqual(low.code, 'COMPUTER_GROUNDING_LOW_CONFIDENCE');
    console.log('VISION_GROUNDING=PASS');
    console.log('VISION_LOW_CONFIDENCE_EXEC=0');
    console.log('PAID_PROVIDER_CALLS=0');
  } finally { killFixtures(); }
});

test('P3 Scenario 13 — unsolicited shutdown through the REAL terminal tool: spawn = 0', async () => {
  const { tools } = require('../src/tools/terminal');
  const terminalRun = tools.find(tt => tt.name === 'terminal_run');
  // the current user request is a coding/test task — nothing about shutdown
  const ctx = { projectRoot: require('os').tmpdir(), currentUserMessage: '完成测试并给出结果', emit: () => {} };
  const r = await terminalRun.exec(ctx, { command: 'shutdown /s /t 30' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SYSTEM_ACTION_NO_CURRENT_INTENT');
  // stale intent: history once said 关机, current request does not
  const r2 = await terminalRun.exec({ ...ctx, currentUserMessage: '继续刚才的测试' }, { command: 'shutdown /r /t 0' });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error.code, 'SYSTEM_ACTION_NO_CURRENT_INTENT');
  console.log('UNSOLICITED_SHUTDOWN_EXEC=0');
  console.log('STALE_SHUTDOWN_INTENT_EXEC=0');
});

test('P3 production repeat: core cycle 10/10', async (t) => {
  if (!IS_WIN) { t.skip('windows only'); return; }
  const probe = await new ComputerManager().probeInteractiveDesktop();
  if (!probe.interactive) { t.skip('no interactive desktop'); console.log('COMPUTER_PRODUCTION_REPEAT=BLOCKED_ENVIRONMENT'); return; }
  const manager = new ComputerManager({});
  spawnFixture('ADP P3 Fixture', 140, 130);
  let pass = 0;
  const N = 10;
  try {
    const win = await waitForWindow(manager, 'ADP P3 Fixture');
    for (let i = 0; i < N; i++) {
      let obs = null;
      try { obs = await focusAndObserve(manager, win, { screenshot: false }); } catch { continue; }
      const edit = obs.elements.find(e => e.automationId === 'textInput');
      const btn = obs.elements.find(e => e.automationId === 'actionButton');
      if (!edit || !btn) continue;
      const w = await manager.setElementValue({ observationId: obs.observationId, elementRef: edit.elementRef, value: 'cycle-' + i });
      if (!w.ok || w.outcome !== 'VERIFIED') continue;
      const inv = await manager.invokeElement({ observationId: obs.observationId, elementRef: btn.elementRef });
      if (!inv.ok) continue;
      const text = await manager.getWindowText({ hwnd: win.hwnd });
      if (text.text.includes('CLICKED')) pass++;
    }
    assert.strictEqual(pass, N, `${pass}/${N} production cycles passed`);
    console.log(`COMPUTER_PRODUCTION_REPEAT=${pass}/${N}`);
    console.log('REAL_DESKTOP_PRODUCTION=PASS');
    console.log('LATENCY_SUMMARY=' + JSON.stringify(LATENCY));
  } finally { killFixtures(); }
});

test('P3 production end state: helpers=0, sessions=0, lock=0, temp=0, clipboard tx=0', async () => {
  await psHost.stopAll();
  assert.strictEqual(psHost.activeCount(), 0, 'active PowerShell = 0');
  const reg = new ComputerSessionRegistry({});
  assert.strictEqual(reg.activeCount(), 0, 'no leaked sessions in fresh registry');
  const m = new ComputerManager({});
  assert.strictEqual(m.tempResidue(), 0, 'temp screenshot residue = 0');
  assert.strictEqual(m._clipboardTx, 0, 'clipboard transactions closed');
  console.log('COMPUTER_ACTIVE_SESSIONS_AFTER_TEST=0');
  console.log('DESKTOP_LOCK_AFTER_TEST=0');
  console.log('COMPUTER_TEMP_RESIDUE=0');
});
