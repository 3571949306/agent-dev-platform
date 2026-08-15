'use strict';

/**
 * Thin P4 verification orchestrator. Verification levels remain owned by the
 * existing VerificationRegistry; this service only gathers safe runtime
 * evidence or executes one explicitly consented, isolated task through Hub.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const { stripSecrets } = require('../runtime/resultSanitizer');
const { buildVerificationFingerprint, transportProfileFrom, localDetectionFrom } = require('./agentVerification');
const { captureProjectState, verifyExternalResult } = require('./externalResultVerifier');

const SAFE_ROOT_NAME = 'adp-external-safe-verification';
const REAL_ROOT_NAME = 'adp-external-verification';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'unavailable']);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function authStateOf(adapter) {
  if (!adapter || typeof adapter.getAuthState !== 'function') return { state: 'UNKNOWN', authenticated: false };
  try {
    const value = adapter.getAuthState();
    return value && typeof value === 'object'
      ? { state: value.state || 'UNKNOWN', mode: value.mode || '', authenticated: value.authenticated === true, detail: value.detail || '' }
      : { state: 'UNKNOWN', authenticated: false };
  } catch {
    return { state: 'UNKNOWN', authenticated: false };
  }
}

function runtimeOf(adapter, probe) {
  if (probe && probe.runtime) return probe.runtime;
  if (adapter && typeof adapter.getActiveRuntime === 'function') return adapter.getActiveRuntime();
  return adapter && (adapter.transport || adapter.adapterType) || 'unknown';
}

function exactZeroCalls(extra = {}) {
  return {
    taskDispatches: 0,
    platformProviderCalls: 0,
    externalModelCalls: 0,
    modelCalls: 0,
    paidCalls: 0,
    callCountEvidence: 'EXACT',
    ...extra
  };
}

function unobservableExternalCalls(extra = {}) {
  return {
    taskDispatches: 1,
    platformProviderCalls: 0,
    externalModelCalls: null,
    modelCalls: null,
    paidCalls: null,
    callCountEvidence: 'UNOBSERVABLE_EXTERNAL_RUNTIME',
    ...extra
  };
}

function authAttemptPolicy(adapter, safe) {
  const auth = safe && safe.auth || { state: 'UNKNOWN', authenticated: false };
  const state = String(auth.state || 'UNKNOWN').toUpperCase();
  if (auth.authenticated === true || ['NONE', 'LOCAL_EPHEMERAL', 'API_KEY', 'AUTHENTICATED'].includes(state)) {
    return { allowed: true, reason: 'AUTH_CONFIRMED' };
  }
  if (['AUTH_REQUIRED', 'AUTH_FAILED', 'FAILED', 'CONFIGURATION_REQUIRED', 'NOT_CONFIGURED'].includes(state)) {
    return { allowed: false, reason: state.includes('FAILED') ? 'AGENT_AUTH_FAILED' : 'AGENT_AUTH_REQUIRED' };
  }
  const mode = String(auth.mode || '').toLowerCase();
  const externallyManaged = mode.includes('external') || ['claude-code', 'codex'].includes(adapter && adapter.id);
  if (state === 'UNKNOWN' && externallyManaged && safe && safe.detection.available && safe.detection.configured) {
    return { allowed: true, reason: 'EXTERNAL_LOGIN_UNKNOWN_MAY_BE_TESTED' };
  }
  return { allowed: false, reason: 'AGENT_AUTH_UNVERIFIED' };
}

function authFailureCode(value) {
  const explicit = value && typeof value === 'object' && String(value.errorCode || value.code || '').toUpperCase();
  if (explicit === 'AGENT_AUTH_REQUIRED' || explicit === 'AUTH_REQUIRED') return 'AGENT_AUTH_REQUIRED';
  if (explicit === 'AGENT_AUTH_FAILED' || explicit === 'AUTH_FAILED') return 'AGENT_AUTH_FAILED';
  const text = JSON.stringify(value || '');
  if (/401|403|auth(?:entication)?[_ -]?(?:required|failed)|unauthori[sz]ed|login required/i.test(text)) {
    return /auth(?:entication)?[_ -]?failed|401|403|unauthori[sz]ed/i.test(text) ? 'AGENT_AUTH_FAILED' : 'AGENT_AUTH_REQUIRED';
  }
  return null;
}

function safeReason(error, fallback) {
  const authCode = authFailureCode(error);
  if (authCode) return authCode;
  const code = error && typeof error.code === 'string' ? error.code : '';
  return code || fallback;
}

function safeRemove(createdPath, parentPath) {
  const target = path.resolve(createdPath);
  const parent = path.resolve(parentPath);
  if (target === parent || !target.startsWith(parent + path.sep)) {
    throw new Error('verification cleanup target escaped the owned temp root');
  }
  fs.rmSync(target, { recursive: true, force: true });
  try {
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch { /* another concurrent verification may own a sibling */ }
}

function createExternalAgentVerificationService({
  agentHub,
  adapterRegistry,
  verificationRegistry,
  tempRoot = os.tmpdir(),
  timeoutMs = 180000
} = {}) {
  if (!agentHub) throw new Error('ExternalAgentVerificationService: agentHub required');
  if (!adapterRegistry) throw new Error('ExternalAgentVerificationService: adapterRegistry required');
  if (!verificationRegistry) throw new Error('ExternalAgentVerificationService: verificationRegistry required');

  const supervisor = createCliProcessSupervisor();

  function adapterFor(agentId) {
    const adapter = adapterRegistry.get(agentId);
    if (!adapter) throw Object.assign(new Error(`Agent ${agentId} is not registered`), { code: 'AGENT_NOT_FOUND' });
    return adapter;
  }

  function fingerprintFor(agentId, adapter, detection, probe) {
    return buildVerificationFingerprint(agentId, {
      transport: adapter.transport || adapter.adapterType || '',
      runtime: runtimeOf(adapter, probe) || '',
      version: detection.version || (probe && probe.version) || '',
      path: detection.path || '',
      configured: detection.configured != null ? detection.configured === true : detection.available === true,
      mode: adapter.runtimeMode || '',
      windowIdentity: (probe && probe.detection && probe.detection.windowIdentity) || detection.windowIdentity || null
    });
  }

  async function safeVerify(agentId, options = {}) {
    const adapter = adapterFor(agentId);
    const verificationId = crypto.randomUUID();
    const parent = path.join(path.resolve(tempRoot), SAFE_ROOT_NAME);
    const safeRoot = path.join(parent, verificationId);
    fs.mkdirSync(safeRoot, { recursive: true });
    let detection = {};
    let health = null;
    let probe = null;
    let failure = null;
    try {
      detection = typeof adapter.detect === 'function' ? (await adapter.detect() || {}) : {};
      if (typeof adapter.healthCheck === 'function') {
        try { health = await adapter.healthCheck({ projectRoot: options.projectRoot || safeRoot }); }
        catch (error) { health = { status: 'unavailable', detail: error.message }; }
      }
      if (detection.available && typeof adapter.safeVerify === 'function') {
        try { probe = await adapter.safeVerify({ projectRoot: safeRoot, verificationId }); }
        catch (error) {
          failure = error;
          probe = { protocolAttempted: true, protocolVerified: false, reason: error.code || error.message };
        }
      }

      const fingerprint = fingerprintFor(agentId, adapter, detection, probe);
      const availability = {
        installed: detection.installed != null ? detection.installed === true : detection.available === true,
        configured: detection.configured != null ? detection.configured === true : detection.available === true,
        available: detection.available === true,
        transport: adapter.transport || adapter.adapterType || '',
        runtime: runtimeOf(adapter, probe),
        version: detection.version || (probe && probe.version) || (health && health.version) || '',
        windowIdentity: (probe && probe.detection && probe.detection.windowIdentity) || detection.windowIdentity || null
      };
      const transportProfile = transportProfileFrom(agentId, availability);
      const localDetectionVerified = localDetectionFrom(agentId, availability);
      adapter._verifiedRuntime = runtimeOf(adapter, probe) || null;
      adapter._verifiedVersion = detection.version || (probe && probe.version) || (health && health.version) || null;
      verificationRegistry.setFingerprint(agentId, fingerprint);
      const version = detection.version || (probe && probe.version) || (health && health.version) || '';
      if (localDetectionVerified) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:detection`,
          type: 'local_detection', status: 'pass', version: String(version),
          source: 'ExternalAgentVerificationService.safeVerify/detect',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          transportProfile,
          ...exactZeroCalls(),
          effectObserved: false
        });
      } else {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:detection`,
          type: 'local_detection', status: 'fail', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/detect',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          transportProfile,
          ...exactZeroCalls(),
          effectObserved: false,
          reason: detection.available ? 'TRANSPORT_DETECTION_INCOMPLETE' : 'NOT_INSTALLED'
        });
      }

      if (probe && probe.protocolVerified === true) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:protocol`,
          type: 'protocol', status: 'pass', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/initialize',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          transportProfile,
          ...exactZeroCalls(),
          effectObserved: false
        });
      } else if (probe && probe.protocolAttempted === true) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:protocol`,
          type: 'protocol', status: 'fail', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/initialize',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          transportProfile,
          ...exactZeroCalls(),
          effectObserved: false,
          reason: probe.reason || safeReason(failure, 'PROTOCOL_NOT_VERIFIED')
        });
      }

      return exactZeroCalls({
        verificationId,
        agentId,
        detection: stripSecrets({
          installed: detection.installed != null ? detection.installed === true : detection.available === true,
          configured: detection.configured != null ? detection.configured === true : detection.available === true,
          available: detection.available === true,
          path: detection.path || null,
          detail: detection.detail || detection.error || null
        }),
        health: stripSecrets(health || { status: 'unknown' }),
        runtime: runtimeOf(adapter, probe),
        version: version || null,
        auth: (() => {
          const auth = (probe && probe.auth) || authStateOf(adapter);
          return {
            state: auth && auth.state || 'UNKNOWN',
            mode: auth && auth.mode || '',
            authenticated: auth && auth.authenticated === true,
            detail: stripSecrets(String(auth && auth.detail || ''))
          };
        })(),
        protocolAttempted: !!(probe && probe.protocolAttempted),
        protocolVerified: !!(probe && probe.protocolVerified),
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId)
      });
    } finally {
      safeRemove(safeRoot, parent);
    }
  }

  async function runGitInit(repoRoot) {
    const git = await supervisor.detect('git');
    if (!git.available) throw Object.assign(new Error('git is required for real verification'), { code: 'GIT_NOT_AVAILABLE' });
    const handle = await supervisor.spawnProcess({
      command: git.path,
      args: ['init', '--quiet'],
      cwd: repoRoot,
      env: buildEnvAllowlist(),
      timeoutMs: 10000,
      runId: `verification-git:${crypto.randomUUID()}`
    });
    const result = await handle.done;
    if (result.code !== 0 || !result.quiesced) throw new Error('git init failed');
  }

  async function waitForTerminal(runId, limitMs) {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const state = await agentHub.status(runId);
      if (state && TERMINAL.has(state.status)) return state;
      await delay(50);
    }
    const cancelled = await agentHub.cancel(runId);
    throw Object.assign(new Error('real verification timed out'), {
      code: 'REAL_VERIFICATION_TIMEOUT',
      cancellationQuiesced: cancelled && cancelled.quiesced === true
    });
  }

  function runScopeCleanupConfirmed(runId, dispatched) {
    if (!dispatched) return true;
    if (!runId || typeof agentHub.getDiagnostics !== 'function') return false;
    const diagnostics = agentHub.getDiagnostics();
    const control = (diagnostics.controls || []).find(item => item.runId === runId);
    return !!control
      && control.terminal === true
      && control.quarantined !== true
      && control.lockHeld !== true
      && control.counted !== true
      && control.finalizerActive !== true
      && control.pendingTerminal !== true;
  }

  async function realVerifyResponse(agentId, adapter, safe, options = {}) {
    const verificationId = crypto.randomUUID();
    const nonce = `ADP_RESPONSE_VERIFY_${crypto.randomBytes(12).toString('hex')}`;
    const expectedResponse = `RESPONSE_${nonce}`;
    const parent = path.join(path.resolve(tempRoot), REAL_ROOT_NAME);
    const repoRoot = path.join(parent, verificationId);
    fs.mkdirSync(repoRoot, { recursive: true });
    let runId = null;
    let dispatched = false;
    let terminal = null;
    try {
      const started = await agentHub.start(agentId, {
        // Keep the exact expected line out of the prompt: DesktopAgentBridge
        // removes echoed prompt lines before returning the new response.
        goal: `This is a bounded response verification. Use nonce ${nonce} and reply with one line formed by prefixing that nonce with RESPONSE_.`,
        projectRoot: repoRoot,
        required: [],
        readOnly: true,
        responseOnly: true,
        allowedScopes: ['computer.observe', 'computer.focus', 'computer.input'],
        timeoutMs: Number(options.timeoutMs) || timeoutMs
      });
      runId = started && started.runId || null;
      dispatched = !!(started && started.executionStarted === true);
      if (!started || !started.runId || started.error) {
        const code = authFailureCode(started) || (started && started.errorCode) || 'AGENT_START_FAILED';
        const calls = dispatched ? unobservableExternalCalls() : exactZeroCalls();
        return { ok: false, agentId, verificationId, error: code, errorCode: code, safe, verificationKind: 'response', ...calls };
      }
      terminal = await waitForTerminal(runId, Number(options.timeoutMs) || timeoutMs);
      const hubResult = await agentHub.result(runId);
      const value = hubResult && hubResult.result || {};
      const lines = String(value.summary || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const responseObserved = terminal.status === 'completed' && lines.includes(expectedResponse);
      const diagnostics = typeof agentHub.getDiagnostics === 'function' ? agentHub.getDiagnostics() : { controls: [] };
      const active = (diagnostics.controls || []).some(control => control.runId === runId && !control.terminal);
      const passed = responseObserved && !active;
      const reason = passed
        ? ''
        : ((value && value.errorCode) || authFailureCode(value) || (responseObserved ? 'WORKBUDDY_RUNTIME_NOT_QUIESCED' : 'WORKBUDDY_NEW_NONCE_RESPONSE_NOT_OBSERVED'));
      const calls = unobservableExternalCalls();
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_response',
        status: passed ? 'pass' : 'fail',
        verificationKind: 'response',
        source: 'ExternalAgentVerificationService.realVerifyResponse/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: false,
        userConsentedRealVerification: true,
        ...calls,
        reason,
        details: {
          terminalStatus: terminal.status,
          responseObserved,
          projectTaskStatus: 'WORKSPACE_BINDING_UNAVAILABLE'
        }
      });
      return {
        ok: passed,
        verificationId,
        verificationKind: 'response',
        agentId,
        runId,
        terminalStatus: terminal.status,
        responseVerified: passed,
        projectTaskVerified: false,
        projectTaskStatus: 'WORKSPACE_BINDING_UNAVAILABLE',
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        error: passed ? null : reason,
        errorCode: passed ? null : reason,
        ...calls
      };
    } catch (error) {
      const reason = safeReason(error, 'REAL_RESPONSE_FAILED');
      const calls = dispatched ? unobservableExternalCalls() : exactZeroCalls();
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_response',
        status: 'fail',
        verificationKind: 'response',
        source: 'ExternalAgentVerificationService.realVerifyResponse/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: false,
        userConsentedRealVerification: true,
        ...calls,
        reason
      });
      return {
        ok: false, verificationId, verificationKind: 'response', agentId, runId,
        terminalStatus: terminal && terminal.status || null,
        responseVerified: false,
        projectTaskVerified: false,
        projectTaskStatus: 'WORKSPACE_BINDING_UNAVAILABLE',
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        error: reason,
        errorCode: reason,
        ...calls
      };
    } finally {
      // A real-verification scope is disposable only after AgentHub proves the
      // external runtime quiescent and releases all mutation authority. If that
      // proof is unavailable, preserve the scope for quarantine/diagnosis.
      if (runScopeCleanupConfirmed(runId, dispatched)) safeRemove(repoRoot, parent);
    }
  }

  async function realVerify(agentId, options = {}) {
    if (options.explicitConsent !== true) {
      return exactZeroCalls({
        ok: false, agentId, error: 'REAL_VERIFICATION_REQUIRES_CONFIRMATION',
        errorCode: 'REAL_VERIFICATION_REQUIRES_CONFIRMATION'
      });
    }

    const adapter = adapterFor(agentId);
    const safe = await safeVerify(agentId, options);
    if (!safe.detection.available || !safe.detection.configured) {
      return exactZeroCalls({
        ok: false, agentId, error: safe.detection.installed ? 'INSTALLED_UNCONFIGURED' : 'NOT_INSTALLED',
        errorCode: safe.detection.installed ? 'INSTALLED_UNCONFIGURED' : 'NOT_INSTALLED',
        safe
      });
    }

    if (adapter.transport === 'desktop' || adapter.adapterType === 'desktop') {
      return realVerifyResponse(agentId, adapter, safe, options);
    }

    const authPolicy = authAttemptPolicy(adapter, safe);
    if (!authPolicy.allowed) {
      return exactZeroCalls({ ok: false, agentId, error: authPolicy.reason, errorCode: authPolicy.reason, safe });
    }

    const verificationId = crypto.randomUUID();
    const nonce = crypto.randomBytes(12).toString('hex');
    const expectedContent = `ADP_VERIFY_${nonce}`;
    const parent = path.join(path.resolve(tempRoot), REAL_ROOT_NAME);
    const repoRoot = path.join(parent, verificationId);
    fs.mkdirSync(repoRoot, { recursive: true });
    let runId = null;
    let dispatched = false;
    let terminal = null;
    let effect = null;
    let passed = false;
    let failureReason = null;
    try {
      await runGitInit(repoRoot);
      fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Agent Dev Platform external verification\n', 'utf8');
      const before = await captureProjectState(repoRoot);
      const started = await agentHub.start(agentId, {
        goal: `在当前项目根目录创建 adp_verify.txt，内容严格为 ${expectedContent}。不要修改其他文件。完成后只回复 done。`,
        projectRoot: repoRoot,
        required: ['coding', 'filesystem'],
        readOnly: false,
        allowedScopes: ['filesystem.read', 'filesystem.write'],
        verificationExpectedFile: 'adp_verify.txt',
        verificationExpectedContent: expectedContent,
        timeoutMs: Number(options.timeoutMs) || timeoutMs
      });
      runId = started && started.runId || null;
      dispatched = !!(started && started.executionStarted === true);
      if (!started || !started.runId || started.error) {
        throw Object.assign(new Error(started && started.error || 'AgentHub start failed'), { code: started && started.errorCode || 'AGENT_START_FAILED' });
      }
      terminal = await waitForTerminal(runId, Number(options.timeoutMs) || timeoutMs);
      const hubResult = await agentHub.result(runId);
      effect = await verifyExternalResult({
        projectRoot: repoRoot,
        before,
        result: hubResult && hubResult.result,
        expectedFile: 'adp_verify.txt',
        expectedContent,
        readOnly: false
      });
      const diagnostics = typeof agentHub.getDiagnostics === 'function' ? agentHub.getDiagnostics() : { controls: [] };
      const active = (diagnostics.controls || []).some(c => c.runId === runId && !c.terminal);
      passed = terminal.status === 'completed' && effect.effectObserved === true && !active;
      failureReason = passed ? '' : (
        (hubResult && hubResult.result && (hubResult.result.errorCode || hubResult.result.verificationStatus))
        || authFailureCode(hubResult && hubResult.result)
        || effect.verificationStatus
        || terminal.status
        || 'REAL_TASK_FAILED'
      );
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_task', status: passed ? 'pass' : 'fail',
        source: 'ExternalAgentVerificationService.realVerify/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: effect.effectObserved === true,
        verificationKind: 'project_mutation',
        userConsentedRealVerification: true,
        ...unobservableExternalCalls(),
        reason: failureReason,
        details: { terminalStatus: terminal.status, observedChangedFiles: effect.observedChangedFiles }
      });
      return unobservableExternalCalls({
        ok: passed,
        verificationId,
        agentId,
        runId,
        terminalStatus: terminal.status,
        effectObserved: effect.effectObserved === true,
        observedChangedFiles: effect.observedChangedFiles,
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        verificationKind: 'project_mutation',
        error: passed ? null : failureReason,
        errorCode: passed ? null : failureReason
      });
    } catch (error) {
      failureReason = safeReason(error, 'REAL_TASK_FAILED');
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_task', status: 'fail',
        source: 'ExternalAgentVerificationService.realVerify/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: false,
        verificationKind: 'project_mutation',
        userConsentedRealVerification: true,
        ...(dispatched ? unobservableExternalCalls() : exactZeroCalls()),
        reason: failureReason
      });
      const calls = dispatched ? unobservableExternalCalls() : exactZeroCalls();
      return {
        ok: false, verificationId, agentId, runId,
        terminalStatus: terminal && terminal.status || null,
        effectObserved: false,
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        verificationKind: 'project_mutation',
        error: failureReason,
        errorCode: failureReason,
        ...calls
      };
    } finally {
      if (runScopeCleanupConfirmed(runId, dispatched)) safeRemove(repoRoot, parent);
    }
  }

  return { safeVerify, realVerify, realVerifyResponse };
}

module.exports = {
  createExternalAgentVerificationService,
  SAFE_ROOT_NAME,
  REAL_ROOT_NAME,
  safeRemove,
  exactZeroCalls,
  unobservableExternalCalls,
  authAttemptPolicy
};
