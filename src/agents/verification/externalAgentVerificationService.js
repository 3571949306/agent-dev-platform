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
const { buildVerificationFingerprint } = require('./agentVerification');
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
      mode: adapter.runtimeMode || ''
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
      adapter._verifiedRuntime = runtimeOf(adapter, probe) || null;
      adapter._verifiedVersion = detection.version || (probe && probe.version) || (health && health.version) || null;
      verificationRegistry.setFingerprint(agentId, fingerprint);
      const version = detection.version || (probe && probe.version) || (health && health.version) || '';
      if (detection.available && version) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:detection`,
          type: 'local_detection', status: 'pass', version: String(version),
          source: 'ExternalAgentVerificationService.safeVerify/detect',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          effectObserved: false
        });
      } else {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:detection`,
          type: 'local_detection', status: 'fail', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/detect',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          effectObserved: false,
          reason: detection.available ? 'VERSION_UNKNOWN' : 'NOT_INSTALLED'
        });
      }

      if (probe && probe.protocolVerified === true) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:protocol`,
          type: 'protocol', status: 'pass', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/initialize',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          effectObserved: false
        });
      } else if (probe && probe.protocolAttempted === true) {
        verificationRegistry.record(agentId, {
          verificationId: `${verificationId}:protocol`,
          type: 'protocol', status: 'fail', version: version ? String(version) : '',
          source: 'ExternalAgentVerificationService.safeVerify/initialize',
          adapterRuntime: runtimeOf(adapter, probe), projectFingerprint: fingerprint,
          effectObserved: false,
          reason: probe.reason || (failure && (failure.code || failure.message)) || 'PROTOCOL_NOT_VERIFIED'
        });
      }

      return {
        verificationId,
        agentId,
        detection: {
          installed: detection.installed != null ? detection.installed === true : detection.available === true,
          configured: detection.configured != null ? detection.configured === true : detection.available === true,
          available: detection.available === true,
          path: detection.path || null,
          detail: detection.detail || detection.error || null
        },
        health: health || { status: 'unknown' },
        runtime: runtimeOf(adapter, probe),
        version: version || null,
        auth: (probe && probe.auth) || authStateOf(adapter),
        protocolAttempted: !!(probe && probe.protocolAttempted),
        protocolVerified: !!(probe && probe.protocolVerified),
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        paidCalls: 0,
        modelCalls: 0
      };
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

  async function realVerify(agentId, options = {}) {
    const consent = options.explicitConsent === true || process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS === '1';
    if (!consent) {
      return {
        ok: false, agentId, error: 'REAL_VERIFICATION_REQUIRES_CONFIRMATION',
        errorCode: 'REAL_VERIFICATION_REQUIRES_CONFIRMATION', paidCalls: 0, modelCalls: 0
      };
    }

    const adapter = adapterFor(agentId);
    if (adapter.transport === 'desktop' || adapter.adapterType === 'desktop') {
      return {
        ok: false, agentId, error: 'REAL_VERIFICATION_WORKSPACE_BINDING_UNAVAILABLE',
        errorCode: 'REAL_VERIFICATION_WORKSPACE_BINDING_UNAVAILABLE', paidCalls: 0, modelCalls: 0
      };
    }

    const safe = await safeVerify(agentId, options);
    if (!safe.detection.available || !safe.detection.configured) {
      return {
        ok: false, agentId, error: safe.detection.installed ? 'INSTALLED_UNCONFIGURED' : 'NOT_INSTALLED',
        errorCode: safe.detection.installed ? 'INSTALLED_UNCONFIGURED' : 'NOT_INSTALLED',
        paidCalls: 0, modelCalls: 0, safe
      };
    }
    const authState = safe.auth && String(safe.auth.state || 'UNKNOWN');
    const authUsable = safe.auth && (safe.auth.authenticated === true || ['NONE', 'LOCAL_EPHEMERAL', 'API_KEY', 'AUTHENTICATED'].includes(authState));
    if (!authUsable) {
      const code = /REQUIRED|FAILED/.test(authState) ? 'AGENT_AUTH_REQUIRED' : 'AGENT_AUTH_UNVERIFIED';
      return { ok: false, agentId, error: code, errorCode: code, paidCalls: 0, modelCalls: 0, safe };
    }

    const verificationId = crypto.randomUUID();
    const nonce = crypto.randomBytes(12).toString('hex');
    const expectedContent = `ADP_VERIFY_${nonce}`;
    const parent = path.join(path.resolve(tempRoot), REAL_ROOT_NAME);
    const repoRoot = path.join(parent, verificationId);
    fs.mkdirSync(repoRoot, { recursive: true });
    let runId = null;
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
      if (!started || !started.runId || started.error) {
        throw Object.assign(new Error(started && started.error || 'AgentHub start failed'), { code: started && started.errorCode || 'AGENT_START_FAILED' });
      }
      runId = started.runId;
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
      failureReason = passed ? '' : (effect.verificationStatus || terminal.status || 'REAL_TASK_FAILED');
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_task', status: passed ? 'pass' : 'fail',
        source: 'ExternalAgentVerificationService.realVerify/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: effect.effectObserved === true,
        reason: failureReason,
        details: { terminalStatus: terminal.status, observedChangedFiles: effect.observedChangedFiles }
      });
      return {
        ok: passed,
        verificationId,
        agentId,
        runId,
        terminalStatus: terminal.status,
        effectObserved: effect.effectObserved === true,
        observedChangedFiles: effect.observedChangedFiles,
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        error: passed ? null : failureReason,
        errorCode: passed ? null : failureReason,
        paidCalls: 1,
        modelCalls: 1
      };
    } catch (error) {
      failureReason = error.code || error.message || 'REAL_TASK_FAILED';
      verificationRegistry.record(agentId, {
        verificationId,
        type: 'agent_task', status: 'fail',
        source: 'ExternalAgentVerificationService.realVerify/AgentHub',
        adapterRuntime: safe.runtime,
        version: safe.version || '',
        runId,
        projectFingerprint: verificationRegistry.getFingerprint(agentId) || '',
        effectObserved: false,
        reason: failureReason
      });
      return {
        ok: false, verificationId, agentId, runId,
        terminalStatus: terminal && terminal.status || null,
        effectObserved: false,
        verificationLevel: verificationRegistry.getLevel(agentId),
        evidence: verificationRegistry.getEvidence(agentId),
        error: failureReason,
        errorCode: failureReason,
        paidCalls: runId ? 1 : 0,
        modelCalls: runId ? 1 : 0
      };
    } finally {
      safeRemove(repoRoot, parent);
    }
  }

  return { safeVerify, realVerify };
}

module.exports = {
  createExternalAgentVerificationService,
  SAFE_ROOT_NAME,
  REAL_ROOT_NAME,
  safeRemove
};
