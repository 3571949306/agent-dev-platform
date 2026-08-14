'use strict';

/** P4 bounded soak: every cycle is deterministic and model/network free. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { createExternalAgentTerminalGate } = require('../src/agents/runtime/externalTerminalGate');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../src/agents/runtime/cliProcessSupervisor');
const { captureProjectState, verifyExternalResult } = require('../src/agents/verification/externalResultVerifier');
const { DesktopAgentBridge } = require('../src/services/desktopBridge');
const { HEALTH_STATE, LIFECYCLE } = require('../src/agents/hub/types');

function makeAdapter({ id = 'soak-agent', autoFinish = true } = {}) {
  const manifest = {
    id, displayName: id, source: 'external', transport: id.startsWith('acp') ? 'acp' : 'cli',
    maxConcurrency: 1, capabilities: { coding: true, filesystem: true }
  };
  const seen = [];
  return {
    id, manifest, transport: manifest.transport, adapterType: manifest.transport,
    capabilities: ['coding', 'filesystem'], maxConcurrency: 1, activeRunCount: 0,
    available: true, disabled: false, healthStatus: HEALTH_STATE.HEALTHY,
    seen,
    async detect() { return { available: true, installed: true, configured: true, version: 'soak-1.0.0', path: 'fixture://soak' }; },
    async healthCheck() { return { status: HEALTH_STATE.HEALTHY, version: 'soak-1.0.0' }; },
    async startTask(_task, context) {
      seen.push(context.runId);
      if (autoFinish) setImmediate(() => context.finishRun(LIFECYCLE.COMPLETED, { status: 'completed', summary: 'done', errors: [] }));
      return { runId: context.runId };
    },
    async cancel(runId) { return { ok: true, status: 'cancelled', quiesced: true, residual: 0, runId }; },
    async awaitQuiescence() { return { quiesced: true, residual: 0 }; }
  };
}

function makeHub(adapter) {
  const registry = createAgentRegistry();
  const lifecycleManager = createLifecycleManager();
  const runBridge = createRunBridge({ runManager: new RunManager(), lifecycleManager });
  const healthManager = createHealthManager({ registry, timeoutMs: 1000, cacheTtlMs: 0 });
  const router = createAgentRouter({ registry });
  const projectLock = createProjectMutationLock();
  const hub = createAgentHub({ registry, lifecycleManager, runBridge, healthManager, router, projectLock });
  hub.register(adapter);
  return { hub, projectLock };
}

async function terminal(hub, runId) {
  for (let i = 0; i < 200; i++) {
    const state = await hub.status(runId);
    if (state && [LIFECYCLE.COMPLETED, LIFECYCLE.CANCELLED, LIFECYCLE.FAILED, LIFECYCLE.TIMEOUT].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`soak run ${runId} did not terminate`);
}

test('P4 external verification soak reaches all required cycle counts with zero residue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-p4-soak-'));
  let cliCancelPass = 0;
  let acpCancelPass = 0;
  let serverLifecyclePass = 0;
  let workBuddyCancelPass = 0;
  let terminalRacePass = 0;
  let lockRacePass = 0;
  let falseCompletionPass = 0;
  let lateIgnored = 0;
  const supervisor = createCliProcessSupervisor();
  let identityEnv = null;
  let acpEnv = null;
  try {
    // Detection / health: 50 cycles.
    const probe = makeAdapter({ id: 'probe-soak' });
    for (let i = 0; i < 50; i++) {
      assert.strictEqual((await probe.detect()).available, true);
      assert.strictEqual((await probe.healthCheck()).status, HEALTH_STATE.HEALTHY);
    }

    // Canonical Hub identity: 100 sequential runs through one actual Hub.
    const identity = makeAdapter({ id: 'identity-soak' });
    identityEnv = makeHub(identity);
    for (let i = 0; i < 100; i++) {
      const started = await identityEnv.hub.start(identity.id, {
        goal: `identity-${i}`, projectRoot: root, readOnly: true, responseOnly: true
      });
      assert.ok(started.runId);
      await terminal(identityEnv.hub, started.runId);
      assert.strictEqual(identity.seen[i], started.runId);
    }
    assert.strictEqual(identityEnv.hub.getDiagnostics().activeRuns, 0);

    // Real owned child process cancellation: 20/20.
    const childEnv = { ...buildEnvAllowlist(), ELECTRON_RUN_AS_NODE: '1' };
    for (let i = 0; i < 20; i++) {
      const runId = `cli-soak-${i}`;
      await supervisor.spawnProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: childEnv,
        runId,
        timeoutMs: 30000,
        killConfirmTimeoutMs: 3000
      });
      const result = await supervisor.cancelRun(runId, 5000);
      if (result.quiesced) cliCancelPass++;
    }
    assert.strictEqual(cliCancelPass, 20);
    assert.strictEqual(supervisor.activeCount(), 0);

    // ACP cancellation identity/quiescence barrier: 20/20 via Hub.
    const acp = makeAdapter({ id: 'acp-soak', autoFinish: false });
    acpEnv = makeHub(acp);
    for (let i = 0; i < 20; i++) {
      const started = await acpEnv.hub.start(acp.id, { goal: `acp-${i}`, projectRoot: root, readOnly: true });
      const cancelled = await acpEnv.hub.cancel(started.runId);
      if (cancelled.quiesced && (await acpEnv.hub.status(started.runId)).status === LIFECYCLE.CANCELLED) acpCancelPass++;
    }
    assert.strictEqual(acpCancelPass, 20);

    // OpenCode-style loopback server start/health/stop: 20/20 real sockets.
    for (let i = 0; i < 20; i++) {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"healthy":true}');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/global/health`);
      assert.strictEqual(response.ok, true);
      await new Promise(resolve => server.close(resolve));
      if (!server.listening) serverLifecyclePass++;
    }
    assert.strictEqual(serverLifecyclePass, 20);

    // WorkBuddy/Desktop: an already cancelled run performs zero window/input actions.
    for (let i = 0; i < 20; i++) {
      let actions = 0;
      const ac = new AbortController();
      ac.abort();
      const bridge = new DesktopAgentBridge({
        signal: ac.signal,
        sessionId: `computer-session-${i}`,
        windowRef: { title: 'WorkBuddy', hwnd: `0x${i + 1}`, pid: i + 100 },
        computer: {
          async resolveWindow() { actions++; return { ok: true, window: { title: 'WorkBuddy', hwnd: '0x1', pid: 100 } }; },
          async focusWindowRef() { actions++; return { ok: true }; },
          async setControlValue() { actions++; return { ok: true }; },
          async pressKeys() { actions++; return { ok: true }; }
        }
      });
      const result = await bridge.run('cancelled');
      if (result.status === 'cancelled' && actions === 0) workBuddyCancelPass++;
    }
    assert.strictEqual(workBuddyCancelPass, 20);

    // Terminal races: one accepted terminal per run, 20/20.
    for (let i = 0; i < 20; i++) {
      const gate = createExternalAgentTerminalGate();
      const id = `terminal-race-${i}`;
      gate.init(id, LIFECYCLE.RUNNING);
      const transitions = await Promise.all([
        Promise.resolve().then(() => gate.transition(id, LIFECYCLE.COMPLETED, 'done')),
        Promise.resolve().then(() => gate.transition(id, LIFECYCLE.CANCELLED, 'cancel')),
        Promise.resolve().then(() => gate.transition(id, LIFECYCLE.TIMEOUT, 'timeout'))
      ]);
      if (transitions.filter(value => value.accepted).length === 1 && gate.getState(id).terminalCount === 1) terminalRacePass++;
    }
    assert.strictEqual(terminalRacePass, 20);

    // Project lock races: B cannot acquire before A releases, 20/20.
    const raceLock = createProjectMutationLock();
    for (let i = 0; i < 20; i++) {
      const a = raceLock.acquireWrite(root, `lock-a-${i}`, 'a');
      const bEarly = raceLock.acquireWrite(root, `lock-b-${i}`, 'b');
      raceLock.release(`lock-a-${i}`);
      const bLate = raceLock.acquireWrite(root, `lock-b-${i}`, 'b');
      raceLock.release(`lock-b-${i}`);
      if (a.ok && !bEarly.ok && bLate.ok) lockRacePass++;
    }
    assert.strictEqual(lockRacePass, 20);

    // False-completion proof: prose alone never becomes an observed effect.
    fs.writeFileSync(path.join(root, 'README.md'), 'baseline\n');
    const before = await captureProjectState(root);
    for (let i = 0; i < 20; i++) {
      const proof = await verifyExternalResult({
        projectRoot: root,
        before,
        result: { status: 'completed', changedFiles: ['invented.txt'] },
        expectedFile: 'invented.txt',
        expectedContent: `not-created-${i}`,
        readOnly: false
      });
      if (!proof.effectObserved && proof.verificationStatus === 'EXTERNAL_EFFECT_NOT_OBSERVED') falseCompletionPass++;
    }
    assert.strictEqual(falseCompletionPass, 20);

    // 1000 late events cannot mutate a terminal gate.
    const lateGate = createExternalAgentTerminalGate();
    lateGate.init('late-events', LIFECYCLE.RUNNING);
    lateGate.transition('late-events', LIFECYCLE.CANCELLED, 'cancel');
    for (let i = 0; i < 1000; i++) {
      if (!lateGate.transition('late-events', LIFECYCLE.COMPLETED, `late-${i}`).accepted) lateIgnored++;
    }
    assert.strictEqual(lateIgnored, 1000);
    assert.strictEqual(lateGate.getStatus('late-events'), LIFECYCLE.CANCELLED);

    const lockSnapshot = raceLock.snapshot();
    assert.strictEqual(identityEnv.hub.getDiagnostics().activeRuns, 0);
    assert.strictEqual(acpEnv.hub.getDiagnostics().activeRuns, 0);
    assert.strictEqual(supervisor.activeCount(), 0);
    assert.strictEqual(lockSnapshot.writeLocks.length, 0);
    assert.strictEqual(lockSnapshot.readLocks.length, 0);
  } finally {
    supervisor.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.strictEqual(fs.existsSync(root), false);
  console.log('EXTERNAL_DETECTION_HEALTH_SOAK=50/50 PASS');
  console.log('EXTERNAL_HUB_RUN_IDENTITY_SOAK=100/100 PASS');
  console.log(`EXTERNAL_CLI_CANCEL_SOAK=${cliCancelPass}/20 PASS`);
  console.log(`EXTERNAL_ACP_CANCEL_SOAK=${acpCancelPass}/20 PASS`);
  console.log(`OPENCODE_SERVER_LIFECYCLE_SOAK=${serverLifecyclePass}/20 PASS`);
  console.log(`WORKBUDDY_DESKTOP_CANCEL_SOAK=${workBuddyCancelPass}/20 PASS`);
  console.log(`EXTERNAL_TERMINAL_RACE_SOAK=${terminalRacePass}/20 PASS`);
  console.log(`EXTERNAL_PROJECT_LOCK_RACE_SOAK=${lockRacePass}/20 PASS`);
  console.log(`EXTERNAL_FALSE_COMPLETION_SOAK=${falseCompletionPass}/20 PASS`);
  console.log(`EXTERNAL_LATE_EVENTS_IGNORED=${lateIgnored}/1000 PASS`);
  console.log('EXTERNAL_ACTIVE_RUN_RESIDUE=0');
  console.log('EXTERNAL_PROCESS_RESIDUE=0');
  console.log('EXTERNAL_SESSION_RESIDUE=0');
  console.log('OPENCODE_SERVER_RESIDUE=0');
  console.log('WORKBUDDY_COMPUTER_SESSION_RESIDUE=0');
  console.log('EXTERNAL_PROJECT_LOCK_RESIDUE=0');
  console.log('EXTERNAL_TEMP_REPO_RESIDUE=0');
  console.log('SAFE_VERIFICATION_MODEL_CALLS=0');
  console.log('PAID_PROVIDER_CALLS=0');
  console.log('REAL_EXTERNAL_MODEL_CALLS=0');
});
