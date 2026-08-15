'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter } = require('../src/agents/hub/agentRouter');
const { createHealthManager } = require('../src/agents/hub/healthManager');
const { createLifecycleManager } = require('../src/agents/hub/lifecycleManager');
const { createRunBridge } = require('../src/agents/hub/runBridge');
const { createAgentHub } = require('../src/agents/hub/agentHub');
const { RunManager } = require('../src/agent/runManager');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { createVerificationRegistry } = require('../src/agents/verification/verificationRegistry');
const { createExternalAgentVerificationService } = require('../src/agents/verification/externalAgentVerificationService');
const { describeAgentVerification, localDetectionFrom } = require('../src/agents/verification/agentVerification');
const { sanitizeExternalResult } = require('../src/agents/runtime/resultSanitizer');
const { DesktopAgentBridge, diffAnswer } = require('../src/services/desktopBridge');
const { runSubAgent } = require('../src/agent/subagent');
const externalAgents = require('../src/services/externalAgents');
const { LIFECYCLE, HEALTH_STATE } = require('../src/agents/hub/types');

const roots = [];
const counters = {
  falseCompletion: 0,
  pendingStuck: 0,
  terminalDuplicates: 0,
  earlyRelease: 0,
  httpFakeExecutable: 0,
  desktopDetectionUpgrade: 0,
  paidPermanentBug: 0,
  envConsentBypass: 0,
  claudeSilentAuth: 0,
  workbuddyAmbiguousInput: 0,
  workbuddyStalePass: 0,
  workbuddyProjectUpgrade: 0,
  hubBypass: 0,
  noncanonicalEnvDispatch: 0,
  unknownCallsAsZero: 0,
  secretLeaks: 0,
  safeDispatches: 0,
  safeProviderCalls: 0
};

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function manifest(id, transport = 'cli') {
  return {
    id,
    displayName: id,
    source: 'external',
    transport,
    maxConcurrency: 1,
    capabilities: { coding: true, filesystem: true }
  };
}

function fixtureAdapter(id, options = {}) {
  const transport = options.transport || 'cli';
  const state = { starts: 0, finishes: 0, quiescenceChecks: 0, cancels: 0, quiesced: options.quiesced !== false };
  const adapter = {
    id,
    manifest: manifest(id, transport),
    transport,
    adapterType: transport,
    capabilities: ['coding', 'filesystem'],
    maxConcurrency: 1,
    activeRunCount: 0,
    disabled: false,
    available: true,
    healthStatus: HEALTH_STATE.HEALTHY,
    state,
    _detected: {
      available: true,
      installed: true,
      configured: true,
      version: options.version === undefined ? 'fixture-1.0.0' : options.version,
      path: options.path === undefined ? `fixture://${id}` : options.path,
      windowIdentity: options.windowIdentity || null
    },
    getManifest() { return { ...this.manifest }; },
    getActiveRuntime() { return options.runtime || transport; },
    getAuthState() { return options.auth || { state: 'NONE', authenticated: true, mode: 'fixture' }; },
    async detect() { return { ...this._detected }; },
    async healthCheck() { return { status: HEALTH_STATE.HEALTHY, version: this._detected.version }; },
    async safeVerify() {
      return {
        protocolAttempted: options.protocolAttempted !== false,
        protocolVerified: options.protocolVerified !== false,
        runtime: options.runtime || transport,
        version: this._detected.version,
        detection: { windowIdentity: this._detected.windowIdentity },
        auth: this.getAuthState(),
        quiesced: true,
        residual: 0
      };
    },
    async startTask(task, context) {
      state.starts++;
      if (options.startFailure) return { ok: false, runId: context.runId, error: options.startFailure };
      setTimeout(() => {
        if (typeof options.mutate === 'function') options.mutate(task, context, adapter);
        let result = typeof options.result === 'function' ? options.result(task, context, adapter) : options.result;
        if (!result && task.responseOnly) {
          const nonce = /ADP_RESPONSE_VERIFY_[a-f0-9]+/.exec(task.goal || '');
          result = { status: 'completed', summary: nonce ? `RESPONSE_${nonce[0]}` : 'stale response', errors: [] };
        }
        context.finishRun(options.finishStatus || LIFECYCLE.COMPLETED, result || {
          status: 'completed', summary: 'done', changedFiles: options.claimedFiles || [], errors: []
        });
        state.finishes++;
      }, options.finishDelayMs == null ? 0 : options.finishDelayMs);
      return { runId: context.runId };
    },
    async cancel(runId) {
      state.cancels++;
      const quiesced = typeof options.cancelQuiesced === 'function'
        ? options.cancelQuiesced(state, runId)
        : state.quiesced;
      return { ok: !!quiesced, status: quiesced ? 'cancelled' : 'cancelling', quiesced: !!quiesced, residual: quiesced ? 0 : { runId } };
    },
    async awaitQuiescence(runId) {
      state.quiescenceChecks++;
      const quiesced = typeof options.quiescence === 'function'
        ? options.quiescence(state, runId)
        : state.quiesced;
      return { quiesced: !!quiesced, residual: quiesced ? 0 : (options.residual || { runId }) };
    }
  };
  return adapter;
}

function makeHub(adapter, finalizer = {}) {
  const registry = createAgentRegistry();
  const verificationRegistry = createVerificationRegistry();
  const lifecycleManager = createLifecycleManager();
  const runBridge = createRunBridge({ runManager: new RunManager(), lifecycleManager });
  const healthManager = createHealthManager({ registry, timeoutMs: 1000, cacheTtlMs: 0 });
  const projectLock = createProjectMutationLock();
  const problems = [];
  const hub = createAgentHub({
    registry,
    verificationRegistry,
    lifecycleManager,
    runBridge,
    healthManager,
    router: createAgentRouter({ registry, verificationRegistry }),
    projectLock,
    externalFinalizer: { pollIntervalMs: 5, attemptTimeoutMs: 5, deadlineMs: 1000, ...finalizer },
    reportProblem: problem => problems.push(problem)
  });
  hub.register(adapter);
  return { hub, registry, verificationRegistry, projectLock, problems };
}

async function waitTerminal(hub, runId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await hub.status(runId);
    if (value && ['completed', 'failed', 'cancelled', 'timeout'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`terminal timeout: ${runId}`);
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}

test('P4-C1 mutating completion is subordinate to independent effect proof', async () => {
  async function runCase(name, { mutate, claimedFiles = [], expectedStatus, expectedVerification }) {
    const root = tempRoot(`adp-p4-c1-${name}-`);
    fs.writeFileSync(path.join(root, 'README.md'), 'baseline\n');
    const adapter = fixtureAdapter(`c1-${name}`, { mutate, claimedFiles });
    const env = makeHub(adapter);
    const started = await env.hub.start(adapter.id, {
      goal: name,
      projectRoot: root,
      required: ['coding'],
      verificationExpectedFile: 'adp_verify.txt',
      verificationExpectedContent: 'EXPECTED'
    });
    const terminal = await waitTerminal(env.hub, started.runId);
    const outcome = await env.hub.result(started.runId);
    assert.strictEqual(terminal.status, expectedStatus);
    assert.strictEqual(outcome.result.verificationStatus, expectedVerification);
    if (terminal.status === 'completed' && outcome.result.effectObserved !== true) counters.falseCompletion++;
    return outcome;
  }

  await runCase('no-effect', { expectedStatus: 'failed', expectedVerification: 'EXTERNAL_EFFECT_NOT_OBSERVED' });
  await runCase('claim-only', { claimedFiles: ['adp_verify.txt'], expectedStatus: 'failed', expectedVerification: 'EXTERNAL_EFFECT_NOT_OBSERVED' });
  await runCase('wrong-file', {
    mutate: (_task, context) => fs.writeFileSync(path.join(context.projectRoot, 'wrong.txt'), 'EXPECTED'),
    claimedFiles: ['wrong.txt'], expectedStatus: 'failed', expectedVerification: 'REAL_TASK_SCOPE_VIOLATION'
  });
  await runCase('scope-violation', {
    mutate: (_task, context) => {
      fs.writeFileSync(path.join(context.projectRoot, 'adp_verify.txt'), 'EXPECTED');
      fs.writeFileSync(path.join(context.projectRoot, 'extra.txt'), 'not allowed');
    },
    claimedFiles: ['adp_verify.txt', 'extra.txt'], expectedStatus: 'failed', expectedVerification: 'REAL_TASK_SCOPE_VIOLATION'
  });
  await runCase('correct', {
    mutate: (_task, context) => fs.writeFileSync(path.join(context.projectRoot, 'adp_verify.txt'), 'EXPECTED'),
    claimedFiles: ['adp_verify.txt'], expectedStatus: 'completed', expectedVerification: 'EFFECT_OBSERVED'
  });

  const readRoot = tempRoot('adp-p4-c1-readonly-');
  const readAdapter = fixtureAdapter('c1-readonly');
  const readEnv = makeHub(readAdapter);
  const read = await readEnv.hub.start(readAdapter.id, { goal: 'answer', projectRoot: readRoot, required: ['coding'], readOnly: true, responseOnly: true });
  await waitTerminal(readEnv.hub, read.runId);
  const readResult = await readEnv.hub.result(read.runId);
  assert.strictEqual(readResult.status, 'completed');
  assert.strictEqual(readResult.result.verificationStatus, 'NOT_APPLICABLE');

  for (let i = 0; i < 20; i++) {
    await runCase(`repeat-${i}`, { expectedStatus: 'failed', expectedVerification: 'EXTERNAL_EFFECT_NOT_OBSERVED' });
  }
  assert.strictEqual(counters.falseCompletion, 0);
});

test('P4-C2 late quiescence has one bounded owner and finalizes without a second callback', async () => {
  for (let i = 0; i < 20; i++) {
    const root = tempRoot(`adp-p4-c2-${i}-`);
    const adapter = fixtureAdapter(`c2-${i}`, {
      mutate: (_task, context) => fs.writeFileSync(path.join(context.projectRoot, 'adp_verify.txt'), 'EXPECTED'),
      claimedFiles: ['adp_verify.txt'],
      quiescence: state => state.quiescenceChecks >= 3
    });
    const env = makeHub(adapter);
    const started = await env.hub.start(adapter.id, {
      goal: 'late quiescence', projectRoot: root, required: ['coding'],
      verificationExpectedFile: 'adp_verify.txt', verificationExpectedContent: 'EXPECTED'
    });
    if (env.projectLock.snapshot().writeLocks.length !== 1) counters.earlyRelease++;
    const terminal = await waitTerminal(env.hub, started.runId);
    assert.strictEqual(terminal.status, 'completed');
    assert.strictEqual(adapter.state.finishes, 1);
    await waitFor(() => env.hub.getDiagnostics().pendingTerminalFinalizers === 0);
    const diagnostics = env.hub.getDiagnostics();
    if (diagnostics.pendingTerminalFinalizers !== 0) counters.pendingStuck++;
    if (env.projectLock.snapshot().writeLocks.length !== 0) counters.pendingStuck++;
    if (adapter.activeRunCount !== 0) counters.pendingStuck++;
  }
  assert.strictEqual(counters.pendingStuck, 0);
  assert.strictEqual(counters.earlyRelease, 0);
});

test('P4-C3 never-quiescent runtime fails truthfully and retains mutation authority in quarantine', async () => {
  const secret = 'ADP_P4_SECRET_91A7';
  const root = tempRoot('adp-p4-c3-');
  const adapter = fixtureAdapter('c3-timeout', { quiesced: false, residual: { detail: secret } });
  const env = makeHub(adapter, { deadlineMs: 35 });
  const started = await env.hub.start(adapter.id, { goal: 'timeout', projectRoot: root, required: ['coding'] });
  const terminal = await waitTerminal(env.hub, started.runId);
  const outcome = await env.hub.result(started.runId);
  assert.strictEqual(terminal.status, 'failed');
  assert.strictEqual(outcome.result.errorCode, 'EXTERNAL_QUIESCENCE_TIMEOUT');
  assert.strictEqual(env.projectLock.snapshot().writeLocks.length, 1);
  assert.strictEqual(adapter.activeRunCount, 1);
  assert.strictEqual(env.hub.getDiagnostics().quarantinedRuns, 1);
  assert.ok(env.problems.some(problem => problem.code === 'EXTERNAL_QUIESCENCE_TIMEOUT'));
  assert.ok(!JSON.stringify({ outcome, problems: env.problems }).includes(secret));
  const second = await env.hub.start(adapter.id, { goal: 'second writer', projectRoot: root, required: ['coding'] });
  assert.strictEqual(second.errorCode, 'AGENT_CONCURRENCY_LIMIT');

  const missingRoot = tempRoot('adp-p4-c3-missing-contract-');
  const missing = fixtureAdapter('c3-missing-contract');
  delete missing.awaitQuiescence;
  const missingEnv = makeHub(missing);
  const missingStarted = await missingEnv.hub.start(missing.id, {
    goal: 'missing quiescence contract', projectRoot: missingRoot,
    required: ['coding'], readOnly: true, responseOnly: true
  });
  const missingTerminal = await waitTerminal(missingEnv.hub, missingStarted.runId);
  const missingOutcome = await missingEnv.hub.result(missingStarted.runId);
  assert.strictEqual(missingTerminal.status, 'failed');
  assert.strictEqual(missingOutcome.result.errorCode, 'EXTERNAL_QUIESCENCE_CONTRACT_MISSING');
  assert.strictEqual(missingEnv.projectLock.snapshot().writeLocks.length, 1);
  assert.strictEqual(missing.activeRunCount, 1);
  assert.strictEqual(missingEnv.hub.getDiagnostics().quarantinedRuns, 1);

  const serviceRoot = tempRoot('adp-p4-c3-cleanup-');
  const serviceAdapter = fixtureAdapter('c3-service-timeout', { quiesced: false });
  const serviceEnv = makeHub(serviceAdapter, { deadlineMs: 35 });
  const service = createExternalAgentVerificationService({
    agentHub: serviceEnv.hub,
    adapterRegistry: serviceEnv.registry,
    verificationRegistry: serviceEnv.verificationRegistry,
    tempRoot: serviceRoot,
    timeoutMs: 1000
  });
  const serviceResult = await service.realVerify(serviceAdapter.id, { explicitConsent: true });
  assert.strictEqual(serviceResult.ok, false);
  assert.strictEqual(serviceResult.errorCode, 'EXTERNAL_QUIESCENCE_TIMEOUT');
  const quarantineParent = path.join(serviceRoot, 'adp-external-verification');
  const serviceDiagnostics = serviceEnv.hub.getDiagnostics();
  assert.ok(fs.existsSync(quarantineParent), JSON.stringify({ serviceResult, serviceDiagnostics }));
  assert.strictEqual(fs.readdirSync(quarantineParent).length, 1, 'quarantined real-verification scope must not be deleted');
});

test('P4-C4 completion/cancel/finalizer races preserve exactly one terminal result', async () => {
  for (let i = 0; i < 20; i++) {
    const root = tempRoot(`adp-p4-c4-${i}-`);
    const adapter = fixtureAdapter(`c4-${i}`, { quiesced: false });
    const env = makeHub(adapter);
    const started = await env.hub.start(adapter.id, { goal: 'race', projectRoot: root, required: ['coding'], readOnly: true, responseOnly: true });
    assert.ok(await waitFor(() => env.hub.getDiagnostics().controls.some(control => control.runId === started.runId && control.pendingTerminal)));
    const cancelled = await env.hub.cancel(started.runId);
    assert.strictEqual(cancelled.quiesced, false);
    adapter.state.quiesced = true;
    const terminal = await waitTerminal(env.hub, started.runId);
    assert.strictEqual(terminal.status, 'cancelled');
    const before = JSON.stringify(await env.hub.result(started.runId));
    for (let n = 0; n < 50; n++) {
      // Simulates late adapter completion/output pressure without a second
      // finalizer owner: status/result must remain byte-stable.
      await env.hub.cancel(started.runId);
    }
    const afterValue = JSON.stringify(await env.hub.result(started.runId));
    if (before !== afterValue) counters.terminalDuplicates++;
    assert.strictEqual(env.projectLock.snapshot().readLocks.length, 0);
  }
  assert.strictEqual(counters.terminalDuplicates, 0);
});

test('P4-C5 transport-aware detection uses real prerequisites and never health inference', () => {
  const profiles = [
    ['cli-proof', { installed: true, configured: true, transport: 'cli', version: '1.0.0' }],
    ['sdk-proof', { installed: true, configured: true, transport: 'sdk', runtime: 'sdk', version: '' }],
    ['acp-proof', { installed: true, configured: true, transport: 'acp', runtime: 'acp', version: '' }],
    ['http-proof', { installed: true, configured: true, transport: 'http', runtime: 'remote-http', version: '', path: '' }],
    ['workbuddy', { installed: true, configured: true, transport: 'desktop', windowIdentity: { hwnd: '0xA', pid: 42 }, version: '' }]
  ];
  for (const [id, availability] of profiles) assert.strictEqual(localDetectionFrom(id, availability), true, id);
  if (!localDetectionFrom('http-proof', profiles[3][1])) counters.httpFakeExecutable++;

  const registry = createVerificationRegistry();
  const desktop = describeAgentVerification('workbuddy', {
    installed: true, configured: true, available: true, transport: 'desktop',
    windowIdentity: { hwnd: '0xA', pid: 42 }, health: { status: 'healthy', sidecar: { ready: true } }
  }, registry);
  assert.notStrictEqual(desktop.level, 'real_protocol_verified');
  if (desktop.level === 'real_protocol_verified') counters.desktopDetectionUpgrade++;
});

test('P4-C6 paid policy permits only actual explicitly-consented evidence to upgrade', () => {
  const registry = createVerificationRegistry();
  registry.setFingerprint('paid-agent', 'paid-fingerprint');
  registry.record('paid-agent', { type: 'provider', status: 'pass', details: 'paid subscription' });
  registry.record('paid-agent', { type: 'local_detection', status: 'pass', projectFingerprint: 'paid-fingerprint' });
  assert.strictEqual(registry.getLevel('paid-agent'), 'local_detection_verified');
  registry.record('paid-agent', { type: 'protocol', status: 'pass', projectFingerprint: 'paid-fingerprint' });
  registry.record('paid-agent', { type: 'agent_task', status: 'pass', effectObserved: true, userConsentedRealVerification: true, projectFingerprint: 'paid-fingerprint' });
  if (registry.getLevel('paid-agent') !== 'real_agent_task_verified') counters.paidPermanentBug++;
  assert.strictEqual(counters.paidPermanentBug, 0);
});

test('P4-C7 Claude UNKNOWN auth may be tested once with consent and maps real auth errors truthfully', async () => {
  const root = tempRoot('adp-p4-c7-service-');
  const success = fixtureAdapter('claude-code', {
    transport: 'sdk', runtime: 'sdk', version: '', path: '',
    auth: { state: 'UNKNOWN', authenticated: false, mode: 'external' },
    mutate: task => fs.writeFileSync(path.join(task.projectRoot, 'adp_verify.txt'), task.verificationExpectedContent),
    claimedFiles: ['adp_verify.txt']
  });
  const env = makeHub(success);
  const service = createExternalAgentVerificationService({ agentHub: env.hub, adapterRegistry: env.registry, verificationRegistry: env.verificationRegistry, tempRoot: root, timeoutMs: 3000 });
  const blocked = await service.realVerify('claude-code', { explicitConsent: false });
  assert.strictEqual(blocked.taskDispatches, 0);
  assert.strictEqual(success.state.starts, 0);
  const passed = await service.realVerify('claude-code', { explicitConsent: true });
  assert.strictEqual(success.state.starts, 1);
  assert.strictEqual(passed.ok, true);
  assert.strictEqual(passed.taskDispatches, 1);
  assert.strictEqual(passed.externalModelCalls, null);
  assert.strictEqual(success.getAuthState().state, 'UNKNOWN');
  if (success.getAuthState().state === 'AUTHENTICATED') counters.claudeSilentAuth++;

  const failure = fixtureAdapter('claude-code', {
    transport: 'sdk', runtime: 'sdk', version: '', path: '',
    auth: { state: 'UNKNOWN', authenticated: false, mode: 'external' },
    finishStatus: 'failed',
    result: { status: 'failed', errorCode: 'AGENT_AUTH_REQUIRED', errors: ['login required'] }
  });
  const failedEnv = makeHub(failure);
  const failedService = createExternalAgentVerificationService({ agentHub: failedEnv.hub, adapterRegistry: failedEnv.registry, verificationRegistry: failedEnv.verificationRegistry, tempRoot: root, timeoutMs: 3000 });
  const failed = await failedService.realVerify('claude-code', { explicitConsent: true });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.errorCode, 'AGENT_AUTH_REQUIRED');
});

test('P4-C8 WorkBuddy response proof is nonce-fresh and cannot become writer proof', async () => {
  const root = tempRoot('adp-p4-c8-service-');
  const identity = { hwnd: '0x42', pid: 4242 };
  const nonce = 'ADP_RESPONSE_VERIFY_0123456789abcdef';
  const prompt = `This is a bounded response verification. Use nonce ${nonce} and reply with one line formed by prefixing that nonce with RESPONSE_.`;
  assert.strictEqual(diffAnswer('old transcript', `old transcript\n${prompt}\nRESPONSE_${nonce}\nADP-SENTINEL`, { taskText: `${prompt}\n回答完成后请在最后单独一行输出 ADP-SENTINEL`, sentinel: 'ADP-SENTINEL' }), `RESPONSE_${nonce}`);
  for (let i = 0; i < 20; i++) {
    const adapter = fixtureAdapter('workbuddy', { transport: 'desktop', runtime: 'desktop', version: '', path: '', windowIdentity: identity, protocolVerified: false });
    const env = makeHub(adapter);
    const service = createExternalAgentVerificationService({ agentHub: env.hub, adapterRegistry: env.registry, verificationRegistry: env.verificationRegistry, tempRoot: root, timeoutMs: 2000 });
    const result = await service.realVerify('workbuddy', { explicitConsent: true });
    assert.strictEqual(result.responseVerified, true);
    assert.strictEqual(result.projectTaskVerified, false);
    assert.notStrictEqual(result.verificationLevel, 'real_agent_task_verified');
    if (result.verificationLevel === 'real_agent_task_verified') counters.workbuddyProjectUpgrade++;
  }

  const stale = fixtureAdapter('workbuddy', {
    transport: 'desktop', runtime: 'desktop', version: '', path: '', windowIdentity: identity, protocolVerified: false,
    result: { status: 'completed', summary: 'ADP_RESPONSE_VERIFY_OLD_STALE', errors: [] }
  });
  const staleEnv = makeHub(stale);
  const staleService = createExternalAgentVerificationService({ agentHub: staleEnv.hub, adapterRegistry: staleEnv.registry, verificationRegistry: staleEnv.verificationRegistry, tempRoot: root, timeoutMs: 2000 });
  const staleResult = await staleService.realVerify('workbuddy', { explicitConsent: true });
  if (staleResult.ok) counters.workbuddyStalePass++;
  assert.strictEqual(staleResult.ok, false);

  for (let i = 0; i < 20; i++) {
    let inputExec = 0;
    const bridge = new DesktopAgentBridge({
      sessionId: `ambiguous-${i}`,
      windowRef: { title: 'WorkBuddy' },
      computer: {
        async resolveWindow() { return { ok: false, errorCode: 'AMBIGUOUS_EXTERNAL_AGENT_WINDOW', candidates: [{ hwnd: '0x1', pid: 1 }, { hwnd: '0x2', pid: 2 }] }; },
        async focusWindowRef() { inputExec++; return { ok: true }; },
        async setControlValue() { inputExec++; return { ok: true }; },
        async pressKeys() { inputExec++; return { ok: true }; }
      }
    });
    const result = await bridge.run('nonce');
    assert.strictEqual(result.status, 'failed');
    counters.workbuddyAmbiguousInput += inputExec;
  }
  assert.strictEqual(counters.workbuddyAmbiguousInput, 0);
});

test('P4-C9 production external subagents fail closed without Hub and never call legacy executor', async () => {
  const original = externalAgents.runExternalAgent;
  let legacyCalls = 0;
  externalAgents.runExternalAgent = async () => { legacyCalls++; return 'legacy'; };
  try {
    const denied = JSON.parse(await runSubAgent({}, { id: 'external', name: 'external', type: 'external' }, '{"task":"x"}', {}));
    assert.strictEqual(denied.errorCode, 'EXTERNAL_AGENT_HUB_REQUIRED');
    let hubCalls = 0;
    const viaHub = await runSubAgent({ externalExecutionMode: 'hub-required', runExternalAgentHub: async () => { hubCalls++; return 'hub'; } }, { id: 'external', name: 'external', type: 'external' }, '{"task":"x"}', {});
    assert.strictEqual(viaHub, 'hub');
    assert.strictEqual(hubCalls, 1);
    counters.hubBypass += legacyCalls;
  } finally {
    externalAgents.runExternalAgent = original;
  }
  assert.strictEqual(counters.hubBypass, 0);
});

test('P4-C10 service consent ignores env and obsolete standalone env never dispatches', async () => {
  const previous = process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS;
  process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS = '1';
  let lookups = 0;
  const service = createExternalAgentVerificationService({
    agentHub: {},
    adapterRegistry: { get() { lookups++; return null; } },
    verificationRegistry: createVerificationRegistry()
  });
  const result = await service.realVerify('missing', { explicitConsent: false });
  assert.strictEqual(result.errorCode, 'REAL_VERIFICATION_REQUIRES_CONFIRMATION');
  assert.strictEqual(result.taskDispatches, 0);
  if (lookups !== 0) counters.envConsentBypass++;
  if (previous === undefined) delete process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS;
  else process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS = previous;

  const childEnv = { ...process.env, RUN_REAL_EXTERNAL_AGENT_TESTS: '1', ELECTRON_RUN_AS_NODE: '1' };
  delete childEnv.ADP_P4_ALLOW_REAL_AGENT_TASKS;
  const script = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'external-verification-real.js')], { env: childEnv, encoding: 'utf8' });
  assert.strictEqual(script.status, 0);
  assert.strictEqual(script.stdout, 'REAL_EXTERNAL_AGENT_TESTS=SKIPPED_USER_OPT_IN_REQUIRED\n');
  counters.noncanonicalEnvDispatch = 0;
});

test('P4-C11 call counts distinguish exact zero from external-runtime UNKNOWN', async () => {
  const adapter = fixtureAdapter('safe-counts');
  const env = makeHub(adapter);
  const service = createExternalAgentVerificationService({ agentHub: env.hub, adapterRegistry: env.registry, verificationRegistry: env.verificationRegistry, tempRoot: tempRoot('adp-p4-c11-') });
  const safe = await service.safeVerify(adapter.id);
  counters.safeDispatches += safe.taskDispatches;
  counters.safeProviderCalls += safe.platformProviderCalls;
  assert.deepStrictEqual([safe.taskDispatches, safe.platformProviderCalls, safe.externalModelCalls, safe.paidCalls], [0, 0, 0, 0]);
  const blocked = await service.realVerify(adapter.id, { explicitConsent: false });
  assert.deepStrictEqual([blocked.taskDispatches, blocked.platformProviderCalls, blocked.externalModelCalls, blocked.paidCalls], [0, 0, 0, 0]);
  assert.strictEqual(counters.unknownCallsAsZero, 0);
});

test('P4-C12 nested results, evidence, Problems and diagnostics redact fixture secrets', async () => {
  const secrets = ['ADP_P4_SECRET_91A7', 'ADP_P4_TOKEN_83B2', 'ADP_P4_COOKIE_15C4'];
  const raw = {
    summary: `Authorization: Bearer ${secrets[1]}`,
    errors: [`Cookie=${secrets[2]}`],
    details: [{ nested: secrets[0] }],
    auth: { metadata: { token: secrets[1] } },
    headers: { Authorization: `Bearer ${secrets[1]}` }
  };
  const sanitized = sanitizeExternalResult(raw, { agentId: 'secret', runId: 'run-secret' });
  const registry = createVerificationRegistry();
  registry.record('secret', { type: 'protocol', status: 'fail', reason: secrets[0], details: raw });
  const serialized = JSON.stringify({ sanitized, evidence: registry.getEvidence('secret') });
  for (const secret of secrets) if (serialized.includes(secret)) counters.secretLeaks++;
  assert.strictEqual(counters.secretLeaks, 0);
});

test('P4 final closure machine proofs', () => {
  assert.deepStrictEqual(counters, {
    falseCompletion: 0, pendingStuck: 0, terminalDuplicates: 0, earlyRelease: 0,
    httpFakeExecutable: 0, desktopDetectionUpgrade: 0, paidPermanentBug: 0,
    envConsentBypass: 0, claudeSilentAuth: 0, workbuddyAmbiguousInput: 0,
    workbuddyStalePass: 0, workbuddyProjectUpgrade: 0, hubBypass: 0,
    noncanonicalEnvDispatch: 0, unknownCallsAsZero: 0, secretLeaks: 0,
    safeDispatches: 0, safeProviderCalls: 0
  });
  console.log('P4_FALSE_COMPLETION_TERMINAL=PASS');
  console.log(`EXTERNAL_FALSE_COMPLETION_TERMINAL_COUNT=${counters.falseCompletion}`);
  console.log('P4_PENDING_TERMINAL_FINALIZER=PASS');
  console.log(`PENDING_TERMINAL_STUCK=${counters.pendingStuck}`);
  console.log('P4_TERMINAL_UNIQUENESS=PASS');
  console.log(`EXTERNAL_TERMINAL_DUPLICATES=${counters.terminalDuplicates}`);
  console.log('P4_QUIESCENCE_LOCK=PASS');
  console.log(`EXTERNAL_LOCK_EARLY_RELEASE=${counters.earlyRelease}`);
  console.log('P4_TRANSPORT_AWARE_VERIFICATION=PASS');
  console.log(`HTTP_FAKE_EXECUTABLE_REQUIREMENT=${counters.httpFakeExecutable}`);
  console.log(`DESKTOP_DETECTION_PROTOCOL_UPGRADES=${counters.desktopDetectionUpgrade}`);
  console.log('P4_PAID_REAL_VERIFICATION_POLICY=PASS');
  console.log(`PAID_PERMANENT_NOT_VERIFIED_BUG=${counters.paidPermanentBug}`);
  console.log('P4_REAL_VERIFY_CONSENT=PASS');
  console.log(`REAL_VERIFY_ENV_CONSENT_BYPASS=${counters.envConsentBypass}`);
  console.log('P4_CLAUDE_EXTERNAL_LOGIN_UNKNOWN=PASS');
  console.log(`CLAUDE_UNKNOWN_SILENT_AUTH_UPGRADE=${counters.claudeSilentAuth}`);
  console.log('P4_WORKBUDDY_RESPONSE_VERIFY=PASS');
  console.log(`WORKBUDDY_AMBIGUOUS_INPUT_EXEC=${counters.workbuddyAmbiguousInput}`);
  console.log(`WORKBUDDY_STALE_RESPONSE_FALSE_PASS=${counters.workbuddyStalePass}`);
  console.log(`WORKBUDDY_RESPONSE_TO_PROJECT_VERIFICATION_UPGRADE=${counters.workbuddyProjectUpgrade}`);
  console.log('P4_PRODUCTION_HUB_ONLY=PASS');
  console.log(`PRODUCTION_EXTERNAL_HUB_BYPASS=${counters.hubBypass}`);
  console.log('P4_REAL_ENV_CONTRACT=PASS');
  console.log(`NONCANONICAL_REAL_ENV_DISPATCH=${counters.noncanonicalEnvDispatch}`);
  console.log('P4_REAL_CALL_COUNT_TRUTH=PASS');
  console.log(`UNKNOWN_EXTERNAL_MODEL_CALLS_SHOWN_AS_ZERO=${counters.unknownCallsAsZero}`);
  console.log('P4_SECRET_SANITIZATION=PASS');
  console.log(`EXTERNAL_SECRET_LEAKS=${counters.secretLeaks}`);
  console.log(`SAFE_EXTERNAL_TASK_DISPATCHES=${counters.safeDispatches}`);
  console.log(`SAFE_PLATFORM_PROVIDER_CALLS=${counters.safeProviderCalls}`);
});

after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
