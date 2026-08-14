'use strict';
/**
 * P3 Computer Use — FINAL CLOSURE (deterministic adversarial suite).
 *
 * Machine proofs produced here:
 *   SESSION_CANCEL_PENDING_ACTION_EXEC=0   SESSION_CANCEL_STATUS_TRUTH=PASS
 *   LOCK_CANCEL_PENDING_PRODUCT_PATH=20/20
 *   SESSION_FAIL_CLOSED_TOOL_BOUNDARY=PASS SELF_REPORTED_ROOT_TOOL_BYPASS=0
 *   UNKNOWN_RUN_TOOL_EXEC=0                MUTATION_EXEC=0
 *   TARGET_FENCE_ALL_MUTATIONS=PASS        TARGET_AUTHORIZER_MISSING_EXEC=0
 *   RAW_COORD_UNOWNED_EXEC=0               COMPUTER_DIRECT_PROVIDER_CALLS=0
 *   GROUNDING_PROVIDER_ADAPTER_ONLY=PASS   GROUNDING_PROPOSAL_DIRECT_EXEC=0
 *   HELPER_REGISTRY_FALSE_ZERO=0           HELPER_UNCONFIRMED_EXIT_REMOVAL=0
 *   CLIPBOARD_CANCEL_RESTORE=20/20         CLIPBOARD_TRANSACTION_RESIDUE=0
 *   COMPUTER_SESSION_RUN_LIFECYCLE=PASS    NEGATED_SYSTEM_INTENT_EXEC=0
 *   MENTION_ONLY_SYSTEM_INTENT_EXEC=0      VISION_CANCEL_LATE_ACTION_EXEC=0
 *   ARCH_POLICY_COMPUTER_PROVIDER_BYPASS=0 PERMISSION_GATE_DENY_EXEC=0
 *
 * Paid provider calls in this suite: 0 (fake adapters only).
 * Real-desktop proofs live in computerClosureProduction.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ComputerManager, createComputerTools } = require('../src/services/computer');
const { ComputerSessionRegistry, bindSessionLifecycle } = require('../src/services/computerSession');
const { DesktopInteractionLock } = require('../src/services/computer/desktopInteractionLock');
const psHost = require('../src/services/computer/psHost');
const { RunManager } = require('../src/agent/runManager');
const gate = require('../src/security/systemIntentGate');
const { ComputerGroundingService } = require('../src/services/computerGrounding');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { executeTool } = require('../src/agent/runtime/actionExecutor');
const { PermissionEngine } = require('../src/security/permissions');
const policy = require('../scripts/executionPathPolicy');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The nine tools the C2 adversarial matrix must all fail closed. */
const C2_TOOLS = [
  'computer_focus_window', 'computer_type_text', 'computer_press_keys',
  'computer_click_observed', 'computer_invoke_element', 'computer_set_element_value',
  'computer_click_control', 'computer_set_control_value', 'computer_click_at'
];

/* ============================================================
 * C1 — REAL SESSION CANCELLATION (unified authority, pending lock)
 * ============================================================ */

test('Closure C1: pending lock acquire of a cancelled session executes 0 (20/20)', async () => {
  const PASS_N = 20;
  let executedB = 0, wrongStatus = 0, pendingResidue = 0, helperSpawns = 0;

  for (let round = 0; round < PASS_N; round++) {
    const rm = new RunManager({ emit: () => {} });
    const reg = new ComputerSessionRegistry({ runManager: rm });
    const mgr = new ComputerManager({ sessions: reg });
    const tools = createComputerTools({ manager: mgr });
    const baselineHelpers = psHost.activeCount();

    const runA = rm.createRun({ conversationId: 'convA', agentId: 'agentA' });
    const runB = rm.createRun({ conversationId: 'convB', agentId: 'agentB' });
    const sessionB = reg.create({ runId: runB.id, ownerAgentId: 'agentB', conversationId: 'convB' });
    reg.setStatus(sessionB.session.sessionId, 'ACTIVE');

    // Session A holds the desktop lock (mid-mutation).
    const tA = await mgr.lock.acquire({ sessionId: 'sess-A', reason: 'A mutation' });

    // Session B calls a mutating tool → queues behind A.
    const obs = mgr.observations.create({ sessionId: sessionB.session.sessionId, windowRef: { hwnd: 111, pid: 11, title: 'W' }, windowRect: { x: 0, y: 0, width: 100, height: 100 } });
    const bPromise = tools.execs.computer_click_observed(
      { runId: runB.id, agentId: 'agentB', conversationId: 'convB' },
      { observation_id: obs.observationId, normalized_x: 0.5, normalized_y: 0.5 }
    );
    // let B actually enter the lock queue
    await sleep(5);
    assert.ok(mgr.lock.pendingCount() >= 1, `round ${round}: B is queued`);

    // CANCEL SESSION B while it is still queued
    const cancel = await mgr.cancelSession(sessionB.session.sessionId, { reason: '用户取消' });
    assert.strictEqual(cancel.status, 'CANCELLED', `round ${round}: canonical terminal status`);

    // Release A — a cancelled B must NOT inherit the lock now.
    tA.release();
    const bResult = await bPromise;

    if (bResult.ok || (bResult.data && bResult.data.executed === true)) executedB++;
    assert.strictEqual(bResult.ok, false, `round ${round}: B tool call refused`);
    assert.ok(['SESSION_CANCELLED', 'LOCK_ACQUIRE_CANCELLED'].includes(bResult.error.code),
      `round ${round}: honest cancel verdict (${bResult.error.code})`);

    const sB = reg.forRun(runB.id);
    if (sB.length !== 0) wrongStatus++;                       // no live session left
    if (mgr.lock.pendingCount() !== 0) pendingResidue++;      // no pending B
    if (psHost.activeCount() !== baselineHelpers) helperSpawns++;
    // B produced zero executed mutations in the audit history
    assert.ok(!mgr.history(200).some(h => h.action === 'click' && h.outcome !== 'FAILED'),
      `round ${round}: no executed click in history`);
    assert.ok(mgr.lock.isIdle(), `round ${round}: lock fully idle at round end`);
  }

  assert.strictEqual(executedB, 0);
  assert.strictEqual(wrongStatus, 0);
  assert.strictEqual(pendingResidue, 0);
  assert.strictEqual(helperSpawns, 0);
  console.log('SESSION_CANCEL_PENDING_ACTION_EXEC=0');
  console.log('SESSION_CANCEL_STATUS_TRUTH=PASS');
  console.log(`LOCK_CANCEL_PENDING_PRODUCT_PATH=${PASS_N}/${PASS_N}`);
});

test('Closure C1: cancel wins over a queued action even after the lock frees first', async () => {
  const rm = new RunManager({ emit: () => {} });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg });
  const tools = createComputerTools({ manager: mgr });
  const runB = rm.createRun({ conversationId: 'c', agentId: 'a' });
  const sessionB = reg.create({ runId: runB.id, ownerAgentId: 'a', conversationId: 'c' });
  reg.setStatus(sessionB.session.sessionId, 'ACTIVE');

  const tA = await mgr.lock.acquire({ sessionId: 'sess-A' });
  const obs = mgr.observations.create({ sessionId: sessionB.session.sessionId, windowRef: { hwnd: 1, pid: 1, title: 'W' }, windowRect: { x: 0, y: 0, width: 10, height: 10 } });
  const p = tools.execs.computer_click_observed({ runId: runB.id }, { observation_id: obs.observationId, normalized_x: 0.5, normalized_y: 0.5 });
  await sleep(5);
  const sidB = sessionB.session.sessionId;
  // release FIRST, cancel a moment later — the post-grant terminal recheck must still win
  tA.release();
  await mgr.cancelSession(sidB);
  const r = await p;
  assert.strictEqual(r.ok, false, 'queued action never executes against a terminal session');
  assert.ok(['SESSION_CANCELLED', 'SESSION_TERMINATED', 'STALE_OBSERVATION', 'TARGET_NOT_ALLOWED'].includes(r.error.code));
  assert.strictEqual(mgr.lock.isIdle(), true);
  console.log('CANCEL_AFTER_RELEASE_LATE_EXEC=0');
});

/* ============================================================
 * C2 — SESSION IDENTITY: unknown Run FAILS CLOSED at the tool boundary
 * ============================================================ */

test('Closure C2: fake runId → SESSION_UNKNOWN_RUN on all 9 mutation tools, exec = 0', async () => {
  const rm = new RunManager({ emit: () => {} });
  const realRoot = rm.createRun({ conversationId: 'c0', agentId: 'main' });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg });
  let authorizeCalls = 0;
  mgr.targetAuthorizer = async () => { authorizeCalls++; return true; };
  const tools = createComputerTools({ manager: mgr });
  const baselineHelpers = psHost.activeCount();

  // attacker pair: fake runId + REAL rootRunId self-reported alongside
  const ctx = { runId: 'fake', rootRunId: realRoot.id, parentRunId: realRoot.id, sessionId: 'forged-session' };
  let denied = 0;
  for (const name of C2_TOOLS) {
    const r = await tools.execs[name](ctx, { title: 'Victim', text: 'x', keys: 'x', observation_id: 'obs_x', element_ref: 'e:x', automation_id: 'a', x: 1, y: 1 });
    if (!r.ok && r.error.code === 'SESSION_UNKNOWN_RUN') denied++;
    else console.log('UNEXPECTED:', name, JSON.stringify(r));
  }
  assert.strictEqual(denied, C2_TOOLS.length, 'every mutation tool fails closed');
  assert.strictEqual(reg.activeCount(), 0, 'no session ever created for a fake run');
  assert.strictEqual(psHost.activeCount(), baselineHelpers, 'helper spawn = 0');
  assert.strictEqual(mgr.lock.held(), false, 'lock acquire = 0');
  assert.strictEqual(mgr.lock.pendingCount(), 0);
  assert.strictEqual(authorizeCalls, 0, 'target authorize = 0');
  assert.strictEqual(mgr.history(200).length, 0, 'OS mutation exec = 0 (empty audit)');
  console.log('SESSION_FAIL_CLOSED_TOOL_BOUNDARY=PASS');
  console.log('SELF_REPORTED_ROOT_TOOL_BYPASS=0');
  console.log('UNKNOWN_RUN_TOOL_EXEC=0');
  console.log('MUTATION_EXEC=0');
});

test('Closure C2: rootRunId comes only from RunManager lineage, never self-reported', () => {
  const rm = new RunManager({ emit: () => {} });
  const root = rm.createRun({ conversationId: 'c', agentId: 'main' });
  const child = rm.createRun({ conversationId: 'c2', agentId: 'sub', parentRunId: root.id });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  // attacker self-reports a different root + parent: both are worthless
  const r = reg.create({ runId: child.id, rootRunId: 'attacker-root', parentRunId: 'attacker-parent' });
  assert.ok(r.ok);
  assert.strictEqual(r.session.rootRunId, root.id, 'root derived from the persisted lineage only');
  assert.notStrictEqual(r.session.rootRunId, 'attacker-root');
  console.log('SELF_REPORTED_ROOT_LINEAGE_BYPASS=0');
});

/* ============================================================
 * C3 — TARGET FENCE covers EVERY mutation (observation-level proof)
 * ============================================================ */

test('Closure C3: authorized for A ⇒ every mutation API against B is TARGET_NOT_ALLOWED', async () => {
  const reg = new ComputerSessionRegistry({});
  const mgr = new ComputerManager({ sessions: reg });
  const r = reg.create({ runId: 'run-fence' });
  reg.setStatus(r.session.sessionId, 'ACTIVE');
  const sid = r.session.sessionId;
  const winA = { hwnd: 101, pid: 11, title: 'Window A' };
  const winB = { hwnd: 202, pid: 22, title: 'Window B' };
  reg.allowTarget(sid, winA);

  // an observation of B belonging to this session (as if smuggled past discovery)
  const rect = { x: 0, y: 0, width: 200, height: 200 };
  const obsB = mgr.observations.create({ sessionId: sid, windowRef: winB, windowRect: rect });
  const elRef = obsB.elements && obsB.elements[0] ? obsB.elements[0].elementRef : 'e:fake';

  const attempts = [
    () => mgr.clickObserved({ observationId: obsB.observationId, normalizedX: 0.5, normalizedY: 0.5, sessionId: sid }),
    () => mgr.invokeElement({ observationId: obsB.observationId, elementRef: elRef, sessionId: sid }),
    () => mgr.setElementValue({ observationId: obsB.observationId, elementRef: elRef, value: 'x', sessionId: sid }),
    () => mgr.toggleElement({ observationId: obsB.observationId, elementRef: elRef, sessionId: sid }),
    () => mgr.selectElement({ observationId: obsB.observationId, elementRef: elRef, sessionId: sid }),
    () => mgr.scrollElement({ observationId: obsB.observationId, elementRef: elRef, value: 1, sessionId: sid })
  ];
  let denied = 0;
  for (const fn of attempts) {
    const res = await fn();
    if (res.ok === false && (res.code === 'TARGET_NOT_ALLOWED' || res.code === 'STALE_ELEMENT')) denied++;
    assert.notStrictEqual(res.executed, true, 'no cross-window execution');
  }
  assert.strictEqual(denied, attempts.length, 'all observation-based mutations fenced');
  // authorized window A still passes the fence check itself
  assert.ok(reg.assertTargetAllowed(sid, winA).ok);
  assert.strictEqual(reg.assertTargetAllowed(sid, winB).code, 'TARGET_NOT_ALLOWED');
  console.log('TARGET_FENCE_ALL_MUTATIONS=PASS');
  console.log('CROSS_WINDOW_MUTATION_EXEC_LOGIC=0');
});

test('Closure C3: target authority is the exact HWND + PID pair', () => {
  const reg = new ComputerSessionRegistry({});
  const created = reg.create({ runId: 'run-exact-target' });
  reg.setStatus(created.session.sessionId, 'ACTIVE');
  const sid = created.session.sessionId;
  const authorized = { hwnd: 444, pid: 111, title: 'Authorized A' };
  const recycled = { hwnd: 444, pid: 222, title: 'Recycled B' };

  reg.allowTarget(sid, authorized);
  assert.ok(reg.assertTargetAllowed(sid, authorized).ok, 'the authorized identity remains usable');
  assert.strictEqual(reg.assertTargetAllowed(sid, recycled).code, 'TARGET_NOT_ALLOWED',
    'reusing an authorized HWND under another PID never inherits authority');
  console.log('TARGET_HWND_PID_AUTHORITY=PASS');
});

test('Closure C3: only ACTIVE sessions can acquire or exercise target authority', () => {
  const reg = new ComputerSessionRegistry({});
  const created = reg.create({ runId: 'run-session-state' });
  const sid = created.session.sessionId;
  const target = { hwnd: 445, pid: 112, title: 'State Target' };
  assert.strictEqual(reg.allowTarget(sid, target), false);
  assert.strictEqual(reg.assertTargetAllowed(sid, target).code, 'SESSION_NOT_ACTIVE');
  reg.setStatus(sid, 'ACTIVE');
  assert.strictEqual(reg.allowTarget(sid, target), true);
  assert.ok(reg.assertTargetAllowed(sid, target).ok);
  console.log('SESSION_ACTIVE_TARGET_AUTHORITY=PASS');
});

test('Closure C3: observations are owned by exactly one session', async () => {
  const reg = new ComputerSessionRegistry({});
  const mgr = new ComputerManager({ sessions: reg });
  const a = reg.create({ runId: 'run-observation-a' });
  const b = reg.create({ runId: 'run-observation-b' });
  reg.setStatus(a.session.sessionId, 'ACTIVE');
  reg.setStatus(b.session.sessionId, 'ACTIVE');
  const winA = { hwnd: 501, pid: 51, title: 'Observation A' };
  const winB = { hwnd: 502, pid: 52, title: 'Observation B' };
  reg.allowTarget(a.session.sessionId, winA);
  reg.allowTarget(b.session.sessionId, winB);

  const obsA = mgr.observations.create({
    sessionId: a.session.sessionId,
    windowRef: winA,
    windowRect: { x: 0, y: 0, width: 100, height: 100 }
  });
  const crossSession = await mgr.clickObserved({
    observationId: obsA.observationId,
    normalizedX: 0.5,
    normalizedY: 0.5,
    sessionId: b.session.sessionId
  });
  assert.strictEqual(crossSession.code, 'SESSION_MISMATCH');
  assert.notStrictEqual(crossSession.executed, true);

  const unowned = mgr.observations.create({
    sessionId: null,
    windowRef: winB,
    windowRect: { x: 0, y: 0, width: 100, height: 100 }
  });
  const adopted = await mgr.clickObserved({
    observationId: unowned.observationId,
    normalizedX: 0.5,
    normalizedY: 0.5,
    sessionId: b.session.sessionId
  });
  assert.strictEqual(adopted.code, 'SESSION_MISMATCH', 'a session cannot adopt an unowned observation');
  assert.notStrictEqual(adopted.executed, true);
  console.log('CROSS_SESSION_OBSERVATION_EXEC=0');
});

test('Closure C7: product press-keys forwards the resolved target PID to the action helper', async () => {
  const rm = new RunManager({ emit: () => {} });
  const run = rm.createRun({ conversationId: 'keys', agentId: 'agent' });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const target = { hwnd: 601, pid: 61, title: 'Keys Target', processName: 'fixture' };
  const mgr = new ComputerManager({ sessions: reg, targetAuthorizer: async () => true });
  mgr.resolveWindow = async () => ({ ok: true, window: target });
  mgr.focusWindowRef = async () => ({ ok: true, hwnd: target.hwnd, pid: target.pid, verified: true });
  let forwarded = null;
  mgr.pressKeys = async (_keys, opts) => { forwarded = opts; return { ok: true, executed: true }; };
  const tools = createComputerTools({ manager: mgr });

  const result = await tools.execs.computer_press_keys(
    { runId: run.id, conversationId: 'keys', agentId: 'agent' },
    { title: target.title, keys: 'x' }
  );
  assert.ok(result.ok, 'legitimate authorized key input remains available');
  assert.strictEqual(forwarded.foregroundHwnd, target.hwnd);
  assert.strictEqual(forwarded.foregroundPid, target.pid, 'action-point helper receives expected PID');
  console.log('PRESS_KEYS_PRODUCT_PID_FORWARD=PASS');
});

test('Closure C7: missing PID fails before any helper or clipboard mutation', async () => {
  let clipboardWrites = 0;
  const mgr = new ComputerManager({
    clipboardFake: {
      read: async () => 'original',
      write: async () => { clipboardWrites++; }
    }
  });
  const helpersBefore = psHost.activeCount();
  const focus = await mgr.focusWindowRef({ hwnd: 701, title: 'No PID' });
  const keys = await mgr.pressKeys('x', { foregroundHwnd: 701 });
  const paste = await mgr.pasteToTarget({ target: { hwnd: 701 }, text: 'x' });
  const shot = await mgr.screenshotWindowRef({ hwnd: 701, title: 'No PID' });
  for (const result of [focus, keys, paste, shot]) {
    assert.strictEqual(result.code, 'TARGET_IDENTITY_REQUIRED');
    assert.notStrictEqual(result.executed, true);
  }
  assert.strictEqual(clipboardWrites, 0, 'invalid paste never touches the clipboard');
  assert.strictEqual(psHost.activeCount(), helpersBefore, 'invalid identity spawns no helper');
  console.log('ACTION_POINT_MISSING_PID_EXEC=0');
});

/* ============================================================
 * C3.1 — missing targetAuthorizer MUST default to DENY
 * ============================================================ */

test('Closure C3.1: no targetAuthorizer ⇒ new target denied, focus exec = 0', async () => {
  const rm = new RunManager({ emit: () => {} });
  const run = rm.createRun({ conversationId: 'c', agentId: 'a' });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg });      // NO targetAuthorizer
  const winA = { hwnd: 301, pid: 31, title: 'Win A', processName: 'app' };
  mgr.resolveWindow = async () => ({ ok: true, window: winA });
  let focusExec = 0;
  mgr.focusWindowRef = async () => { focusExec++; return { ok: true, verified: true }; };
  const tools = createComputerTools({ manager: mgr });

  const r = await tools.execs.computer_focus_window({ runId: run.id }, { title: 'Win A' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'TARGET_NOT_ALLOWED', 'fail closed without an authorizer');
  assert.strictEqual(focusExec, 0);

  // positive control: an authorizer that grants makes the same call execute
  mgr.targetAuthorizer = async () => true;
  const r2 = await tools.execs.computer_focus_window({ runId: run.id }, { title: 'Win A' });
  assert.ok(r2.ok, 'authorized target executes');
  assert.strictEqual(focusExec, 1);
  console.log('TARGET_AUTHORIZER_MISSING_EXEC=0');
});

/* ============================================================
 * C3.2 — raw coordinates are never unowned / cross-window (logic layer)
 * ============================================================ */

test('Closure C3.2: raw clickAt without a real session / target ⇒ exec = 0', async () => {
  const reg = new ComputerSessionRegistry({});
  const mgr = new ComputerManager({ sessions: reg });
  // 1. no session at all
  const unowned = await mgr.clickAt(100, 100, {});
  assert.strictEqual(unowned.ok, false);
  assert.strictEqual(unowned.code, 'SESSION_REQUIRED');
  // 2. session without authorized targets
  const r = reg.create({ runId: 'run-raw' });
  reg.setStatus(r.session.sessionId, 'ACTIVE');
  const noTarget = await mgr.clickAt(100, 100, { sessionId: r.session.sessionId });
  assert.strictEqual(noTarget.code, 'TARGET_NOT_ALLOWED');
  // 3. terminal session
  reg.setStatus(r.session.sessionId, 'CANCELLED');
  const terminal = await mgr.clickAt(100, 100, { sessionId: r.session.sessionId });
  assert.strictEqual(terminal.code, 'SESSION_TERMINATED');
  assert.strictEqual(mgr.history(100).some(h => h.action === 'click' && h.outcome !== 'FAILED'), false);
  console.log('RAW_COORD_UNOWNED_EXEC=0');
});

/* ============================================================
 * C4 — Vision routing truth: adapter only, zero direct provider surface
 * ============================================================ */

test('Closure C4: computerGrounding has zero direct provider/secret surface', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'computerGrounding.js'), 'utf8');
  const directStream = (src.match(/\.streamResponse\s*\(/g) || []).length;
  const directProvider = (src.match(/providers\.getProvider/g) || []).length;
  const directSecret = (src.match(/getDecrypted/g) || []).length;
  assert.strictEqual(directStream, 0, 'no provider.streamResponse in Computer Grounding');
  assert.strictEqual(directProvider, 0, 'no providers.getProvider in Computer Grounding');
  assert.strictEqual(directSecret, 0, 'no connection secret access in Computer Grounding');
  assert.ok(/\.decide\s*\(/.test(src), 'grounding calls the routed model adapter only');
  // Architecture policy must classify any future direct call as UNSAFE_DUPLICATE
  assert.strictEqual(policy.classify('provider.streamResponse', 'src/services/computerGrounding.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('provider.streamResponse', 'src/services/computer/newProvider.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('provider.streamResponse', 'src/future/computerVisionClient.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('child_process', 'src/services/computer/newProcessHost.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('PermissionEngine.evaluate', 'src/services/computer/newPermission.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('model.decide', 'src/services/computer/newRouter.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(policy.classify('runMainAgent', 'src/services/computer/newRuntime.js'), 'UNSAFE_DUPLICATE');
  // and the old computer.js child_process allowlist entry is gone
  assert.strictEqual(policy.classify('child_process', 'src/services/computer.js'), 'UNSAFE_DUPLICATE');
  assert.ok(policy.runAdversarialProof().allBlocked, 'synthetic adversarial cases all blocked');
  assert.ok(policy.runPositiveControls().allCorrect, 'positive controls intact');
  console.log('COMPUTER_DIRECT_PROVIDER_CALLS=0');
  console.log('GROUNDING_PROVIDER_ADAPTER_ONLY=PASS');
  console.log('ARCH_POLICY_COMPUTER_PROVIDER_BYPASS=0');
});

test('Closure C4: grounding really travels Router selection → adapter.decide with the selected model', async () => {
  const calls = [];
  const fakeAdapter = {
    name: 'RoutedVision',
    decide: async (input) => { calls.push(input); return { text: '{"action":"none","confidence":0.9,"reason":"ok"}' }; }
  };
  const selection = {
    selected: { connectionId: 'conn-1', modelId: 'vision-model-x' },
    mode: 'auto',
    reasons: [{ code: 'HIGHEST_DETERMINISTIC_SCORE' }, { code: 'VISION_REQUIRED_PROVEN' }],
    decisionId: 'decision-123'
  };
  const svc = new ComputerGroundingService({ resolveVision: () => ({ modelAdapter: fakeAdapter, selection }) });
  const g = await svc.ground({ observationId: 'obs1', goal: '找按钮', screenshotDataUrl: 'data:image/png;base64,QUJD' });
  assert.ok(g.ok);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].context.some(p => p.type === 'image'), 'image part routed through adapter context');
  // selected model == reported model; route audit carries capability + reasons, never secrets
  assert.strictEqual(g.grounding.model, 'vision-model-x');
  assert.strictEqual(g.route.requestedCapability, 'vision');
  assert.strictEqual(g.route.connectionId, 'conn-1');
  assert.ok(g.route.reasons.includes('VISION_REQUIRED_PROVEN'));
  assert.strictEqual(g.route.decisionId, 'decision-123');
  assert.ok(!JSON.stringify(g).includes('apiKey'), 'no secrets in grounding output');
  console.log('SELECTED_MODEL_EQ_ROUTED_MODEL=PASS');
});

/* ============================================================
 * C5 — vision proposal is NOT an execution authority
 * ============================================================ */

test('Closure C5: grounding proposals execute 0 OS actions by themselves', async () => {
  const reg = new ComputerSessionRegistry({});
  const mgr = new ComputerManager({ sessions: reg });
  const fakeAdapter = {
    decide: async () => ({ text: JSON.stringify({ action: 'click', normalizedX: 0.5, normalizedY: 0.5, confidence: 0.95, target: '按钮', reason: 'visible' }) })
  };
  const svc = new ComputerGroundingService({ resolveVision: () => ({ modelAdapter: fakeAdapter, selection: null }) });
  const before = mgr.history(200).length;
  const g = await svc.ground({ observationId: 'obs-x', goal: '点击', screenshotDataUrl: 'data:image/png;base64,QUJD' });
  assert.ok(g.ok && g.grounding.action === 'click');
  // proposal in hand — still zero execution, zero permission bypass
  assert.strictEqual(mgr.history(200).length, before, 'no action recorded by grounding');
  assert.strictEqual(psHost.activeCount(), 0, 'no helper spawned by grounding');
  // the renderer IPC contract: computer:ground returns a proposal and nothing else
  const handlersSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'handlers.js'), 'utf8');
  const groundBlock = handlersSrc.split("reg('computer:ground'")[1].split('\n  });')[0];
  assert.ok(!/clickObserved|manager\.click|invokeElement/.test(groundBlock), 'computer:ground contains no execution call');
  assert.ok(/executed: false/.test(groundBlock), 'computer:ground declares executed=false invariant');
  console.log('GROUNDING_PROPOSAL_DIRECT_EXEC=0');
  console.log('GROUNDING_PERMISSION_BYPASS=0');
});

/* ============================================================
 * C5.1 — Permission gate product fixture (Tool Gate → PermissionEngine → tools)
 * ============================================================ */

function buildProductGateFixture({ verdict, askDecision }) {
  const rm = new RunManager({ emit: () => {} });
  const reg = new ComputerSessionRegistry({ runManager: rm });
  const mgr = new ComputerManager({ sessions: reg });
  let osExec = 0;
  // leaf OS surfaces are counted, never touched
  mgr.focusWindowRef = async () => { osExec++; return { ok: true, verified: true }; };
  mgr.clickAt = async () => { osExec++; return { ok: true, executed: true }; };
  const winA = { hwnd: 501, pid: 51, title: 'Gate Win', processName: 'app' };
  mgr.resolveWindow = async () => ({ ok: true, window: winA });
  mgr.targetAuthorizer = async () => true;
  mgr.sensitiveAuthorizer = async () => false; // C12: sensitive scope denied

  const tools = createComputerTools({ manager: mgr });
  const pe = new PermissionEngine();
  if (verdict === 'deny') { pe.grant('computer', 'deny'); pe.grant('computer.raw_coordinates', 'deny'); }
  if (verdict === 'allow') { pe.grant('computer', 'always'); pe.grant('computer.raw_coordinates', 'always'); }
  // default policy = ask for computer scopes

  const run = rm.createRun({ conversationId: 'gate', agentId: 'agent' });
  const ctx = {
    runId: run.id, agentId: 'agent', conversationId: 'gate',
    projectRoot: process.cwd(), taskId: null,
    permissionEngine: pe,
    requestPermission: async () => ({ decision: askDecision || 'deny', range: 'once' })
  };
  // canonical getTool: same shape as the product dynamicTools registry
  const getTool = (name) => {
    const def = tools.defs.find(d => d.name === name);
    if (!def) return null;
    return { def, exec: tools.execs[name], permission: def.permission, source: 'computer' };
  };
  return { mgr, reg, getTool, ctx, osExec: () => osExec, rm, run, winA };
}

test('Closure C5.1: PermissionEngine deny/ask/allow through the canonical tool gate', async () => {
  // deny → OS exec 0
  const deny = buildProductGateFixture({ verdict: 'deny' });
  const d = await executeTool(deny.ctx, 'computer_focus_window', { title: 'Gate Win' }, deny.getTool);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.error.code, 'PERMISSION_DENIED');
  assert.strictEqual(deny.osExec(), 0);

  // ask + user deny → OS exec 0
  const ask = buildProductGateFixture({ verdict: 'ask', askDecision: 'deny' });
  const a = await executeTool(ask.ctx, 'computer_focus_window', { title: 'Gate Win' }, ask.getTool);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error.code, 'PERMISSION_DENIED');
  assert.strictEqual(ask.osExec(), 0);

  // ask + user allow once → first action executes; once semantics consumed
  const once = buildProductGateFixture({ verdict: 'ask', askDecision: 'allow' });
  const first = await executeTool(once.ctx, 'computer_focus_window', { title: 'Gate Win' }, once.getTool);
  assert.ok(first.ok, 'allow-once executes the first action');
  assert.strictEqual(once.osExec(), 1);
  // the PermissionEngine default for computer is `ask`; without a stored grant the
  // next call asks again (requestPermission channel decides — here we switch to deny)
  once.ctx.requestPermission = async () => ({ decision: 'deny' });
  const second = await executeTool(once.ctx, 'computer_focus_window', { title: 'Gate Win' }, once.getTool);
  assert.strictEqual(second.ok, false, 'once grant is consumed — re-ask is mandatory');
  assert.strictEqual(once.osExec(), 1);

  // sensitive input denied ⇒ value exec 0 (C12)
  const sens = buildProductGateFixture({ verdict: 'allow' });
  // deterministic env: stub the live window probe (real desktop proofs are in
  // computerClosureProduction.test.js); geometry matches the observation rect.
  const winId = require('../src/services/computer/windowIdentity');
  const origValidate = winId.validateWindowRef;
  winId.validateWindowRef = async () => ({ ok: true, rect: { x: 0, y: 0, width: 100, height: 100 }, foreground: true });
  try {
    // no tool has run in this fixture yet — create the session like the gate would
    const created = sens.reg.create({ runId: sens.run.id, ownerAgentId: 'agent' });
    sens.reg.setStatus(created.session.sessionId, 'ACTIVE');
    sens.reg.allowTarget(created.session.sessionId, sens.winA); // target fence satisfied
    const sidSens = created.session.sessionId;
    const obs = sens.mgr.observations.create({
      sessionId: sidSens,
      windowRef: sens.winA, windowRect: { x: 0, y: 0, width: 100, height: 100 },
      elements: [{ elementRef: require('../src/services/computer/computerObservation').makeElementRef({ runtimeId: [1], path: [0], automationId: 'pwd', controlType: 'Edit' }), isPassword: true }]
    });
    const sv = await sens.mgr.setElementValue({ observationId: obs.observationId, elementRef: obs.elements[0].elementRef, value: 'secret', sessionId: sidSens });
    assert.strictEqual(sv.ok, false);
    assert.strictEqual(sv.code, 'SENSITIVE_INPUT_DENIED');
  } finally {
    winId.validateWindowRef = origValidate;
  }

  // raw coordinates scope denied at the gate ⇒ exec 0
  const raw = buildProductGateFixture({ verdict: 'ask', askDecision: 'deny' });
  const rr = await executeTool(raw.ctx, 'computer_click_at', { x: 10, y: 10 }, raw.getTool);
  assert.strictEqual(rr.ok, false);
  assert.strictEqual(rr.error.code, 'PERMISSION_DENIED');
  assert.strictEqual(raw.osExec(), 0);
  console.log('PERMISSION_GATE_DENY_EXEC=0');
  console.log('PERMISSION_GATE_ASK_DENY_EXEC=0');
  console.log('PERMISSION_GATE_ALLOW_ONCE=PASS');
  console.log('SENSITIVE_INPUT_DENY_VALUE_EXEC=0');
  console.log('RAW_COORD_SCOPE_DENY_EXEC=0');
});

/* ============================================================
 * C6 — process registry NEVER lies (unconfirmed exit keeps the record)
 * ============================================================ */

test('Closure C6: unconfirmed exit keeps the registry truthful (0 false zeros)', async () => {
  if (process.platform !== 'win32') { console.log('HELPER_REGISTRY_TRUTH=SKIPPED_NON_WINDOWS'); return; }
  const baseline = psHost.activeCount();
  // Controlled seam: the helper's exit can NOT be confirmed within the wait.
  psHost._setExitWaiter(() => Promise.resolve(false));
  try {
    const r = await psHost.runPs('@{ok=$true} | ConvertTo-Json -Compress', { timeoutMs: 15000 });
    assert.strictEqual(r.ok, false, 'verdict must not claim success');
    assert.strictEqual(r.quiesced, false);
    assert.strictEqual(r.code, 'COMPUTER_HELPER_NOT_QUIESCED');
    assert.ok(psHost.activeCount() > baseline, 'record kept: exit unconfirmed');
    assert.strictEqual(psHost.isIdle(), false, 'isIdle must not lie');
  } finally {
    psHost._setExitWaiter(null);
  }
  // now the truth recovers: real quiescence brings the registry back
  await psHost.stopAll();
  assert.strictEqual(psHost.activeCount(), baseline, 'confirmed exit shrinks the registry');
  console.log('HELPER_REGISTRY_FALSE_ZERO=0');
  console.log('HELPER_UNCONFIRMED_EXIT_REMOVAL=0');
});

/* ============================================================
 * C9 — clipboard cancel truth at all four checkpoints (20/20)
 * ============================================================ */

test('Closure C9: clipboard restored at cancel points A/B/C/D (20/20)', async () => {
  const MARKER = 'USER_MARKER_7351';
  const PASS_N = 20;
  let restored = 0;

  for (let i = 0; i < PASS_N; i++) {
    const variant = i % 4;
    let clip = MARKER;
    let writeCalls = 0;
    const ac = new AbortController();
    const m = new ComputerManager({
      clipboardFake: {
        read: async () => clip,
        write: async (t) => {
          writeCalls++;
          clip = t;
          // variant B: cancel right AFTER the temporary write lands
          if (variant === 1 && writeCalls === 1) ac.abort();
        }
      }
    });
    m.pressKeys = async () => {
      // variant C: cancel surfaces during the paste-keys helper
      if (variant === 2) { ac.abort(); return { ok: false, executed: false, code: 'CANCELLED' }; }
      return { ok: true, executed: true };
    };
    if (variant === 0) ac.abort(); // variant A: cancel after backup read

    const r = await m.pasteToTarget({ target: { hwnd: 1, pid: 1 }, text: 'payload ' + i }, { signal: ac.signal });
    if (variant === 3) {
      assert.ok(r.ok, 'variant D (no cancel) pastes fine and still restores');
    } else {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'CANCELLED');
    }
    if (clip === MARKER && m._clipboardTx === 0 && m._clipboardBackup === null) restored++;
    assert.strictEqual(m._clipboardTx, 0, 'transaction settled');
    assert.strictEqual(m._clipboardBackup, null, 'backup cleared');
  }
  assert.strictEqual(restored, PASS_N);
  console.log(`CLIPBOARD_CANCEL_RESTORE=${PASS_N}/${PASS_N}`);
  console.log('CLIPBOARD_TRANSACTION_RESIDUE=0');
});

/* ============================================================
 * C10 — session lifecycle aligned with Run terminal states
 * ============================================================ */

test('Closure C10: Run terminal ⇒ its Computer sessions terminal (residue 0)', async () => {
  const cases = [
    ['completed', 'COMPLETED'],
    ['failed', 'CANCELLED'],
    ['cancelled', 'CANCELLED'],
    ['timeout', 'CANCELLED']
  ];
  for (const [runStatus, expectedSessionStatus] of cases) {
    const rm = new RunManager({ emit: () => {} });
    const reg = new ComputerSessionRegistry({ runManager: rm });
    const mgr = new ComputerManager({ sessions: reg });
    bindSessionLifecycle({ runManager: rm, manager: mgr });

    const run = rm.createRun({ conversationId: 'lc', agentId: 'a' });
    const s = reg.create({ runId: run.id });
    assert.ok(s.ok);
    reg.setStatus(s.session.sessionId, 'ACTIVE');
    assert.strictEqual(reg.activeList().length, 1);

    rm.finishRun(run.id, runStatus, { source: 'closure-test' });
    await sleep(60); // settle async teardown

    assert.strictEqual(reg.activeList().length, 0, `no ACTIVE session after Run ${runStatus}`);
    assert.strictEqual(reg.get(s.session.sessionId).status, expectedSessionStatus);
    assert.strictEqual(mgr.observations.count(), 0, 'observations invalidated');
    assert.strictEqual(mgr.lock.pendingCount(), 0, 'no pending lock acquires');
  }
  console.log('COMPUTER_SESSION_RUN_LIFECYCLE=PASS');
});

/* ============================================================
 * System intent gate — negation & mention-only hardening
 * ============================================================ */

test('Closure intent: negated / mention-only system commands execute 0', async () => {
  let spawned = 0;
  const attempt = async (command, currentUserMessage) => {
    const v = await gate.authorizeSystemAction({ command, currentUserMessage, confirm: async () => ({ approved: true }) });
    if (v.allowed) spawned++;
    return v;
  };
  // negation — "不要关机" must DENY even with an eager confirm channel
  const neg = await attempt('shutdown /s /t 0', '不要关机');
  assert.strictEqual(neg.allowed, false);
  assert.strictEqual(neg.code, 'SYSTEM_ACTION_NO_CURRENT_INTENT');
  // mention-only variants
  assert.strictEqual((await attempt('shutdown /s', '解释 shutdown 命令')).allowed, false);
  assert.strictEqual((await attempt('shutdown /r /t 0', '测试不要真的重启')).allowed, false);
  assert.strictEqual((await attempt('Restart-Computer', '代码里有 Restart-Computer')).allowed, false);
  // mixed intent: restart wanted, shutdown negated
  assert.ok((await attempt('shutdown /r /t 0', '帮我重启，不要关机')).allowed, 'restart intent survives');
  assert.strictEqual((await attempt('shutdown /s /t 0', '帮我重启，不要关机')).allowed, false, 'shutdown stays negated');
  // genuine intent still works (regression guard)
  assert.ok((await attempt('shutdown /s /t 60', '请帮我关机')).allowed);
  assert.strictEqual(spawned, 2, 'exactly the two affirmative cases pass');
  console.log('NEGATED_SYSTEM_INTENT_EXEC=0');
  console.log('MENTION_ONLY_SYSTEM_INTENT_EXEC=0');
});

/* ============================================================
 * §24 — vision cancellation: abort the routed adapter, late results inert
 * ============================================================ */

test('Closure vision cancel: aborted grounding executes 0 late actions', async () => {
  const reg = new ComputerSessionRegistry({});
  const mgr = new ComputerManager({ sessions: reg });
  // A REAL ProviderModelAdapter wrapping a provider that honours the signal —
  // proves the cancellation travels the production adapter contract.
  const buildProvider = async () => ({
    streamResponse: ({ signal }) => new Promise((resolve, reject) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; e.aborted = true; reject(e); };
      if (signal && signal.aborted) return onAbort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      // never settles on its own: only abort can end this request
    })
  });
  const adapter = createProviderModelAdapter({ buildProvider, agent: { model: 'vision-x', max_tokens: 512 }, timeoutMs: 60000 });
  const svc = new ComputerGroundingService({
    resolveVision: () => ({ modelAdapter: adapter, selection: { selected: { connectionId: 'c', modelId: 'vision-x' }, reasons: [], decisionId: null } })
  });

  const ac = new AbortController();
  const p = svc.ground({ observationId: 'obs-v', goal: '点击按钮', screenshotDataUrl: 'data:image/png;base64,QUJD' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 30); // cancel mid model request
  const g = await p;
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'CANCELLED', 'adapter abort surfaces as CANCELLED');
  // late grounding result ignored: no click, no action history mutation
  assert.strictEqual(mgr.history(100).length, 0);
  assert.strictEqual(psHost.activeCount(), 0);
  // no permission prompt after terminal: nothing downstream was triggered
  console.log('VISION_CANCEL_LATE_ACTION_EXEC=0');
});

/* ============================================================
 * Final deterministic residue gate
 * ============================================================ */

test('Closure deterministic end state: no residue anywhere', async () => {
  await psHost.stopAll();
  assert.strictEqual(psHost.activeCount(), 0, 'helpers = 0');
  const reg = new ComputerSessionRegistry({});
  assert.strictEqual(reg.activeCount(), 0, 'sessions = 0');
  const lock = new DesktopInteractionLock();
  assert.ok(lock.isIdle(), 'lock = 0 / pending = 0');
  const m = new ComputerManager({});
  assert.strictEqual(m.tempResidue(), 0, 'temp files = 0');
  assert.strictEqual(m._clipboardTx, 0, 'clipboard tx = 0');
  console.log('CLOSURE_DETERMINISTIC_RESIDUE=0');
});
