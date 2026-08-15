'use strict';

// This command is intentionally outside every default gate. The absence path
// has a byte-stable one-line contract required by P4.
if (process.env.ADP_P4_ALLOW_REAL_AGENT_TASKS !== '1') {
  process.stdout.write('REAL_EXTERNAL_AGENT_TESTS=SKIPPED_USER_OPT_IN_REQUIRED\n');
  process.exit(0);
}

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
const { CodexAgentAdapter } = require('../src/agents/adapters/codexAgentAdapter');
const { ClaudeCodeAgentAdapter } = require('../src/agents/adapters/claudeCodeAgentAdapter');
const { ClineAgentAdapter } = require('../src/agents/adapters/clineAgentAdapter');
const { OpenCodeAgentAdapter } = require('../src/agents/adapters/openCodeAgentAdapter');
const { OpenHandsAgentAdapter } = require('../src/agents/adapters/openHandsAgentAdapter');

async function main() {
  const registry = createAgentRegistry();
  const verificationRegistry = createVerificationRegistry();
  const lifecycleManager = createLifecycleManager();
  const runBridge = createRunBridge({ runManager: new RunManager(), lifecycleManager });
  const healthManager = createHealthManager({ registry, timeoutMs: 10000, cacheTtlMs: 0 });
  const router = createAgentRouter({ registry, verificationRegistry });
  const hub = createAgentHub({
    registry, verificationRegistry, lifecycleManager, runBridge, healthManager, router,
    projectLock: createProjectMutationLock()
  });
  const adapters = [
    new CodexAgentAdapter(),
    new ClaudeCodeAgentAdapter(),
    new ClineAgentAdapter(),
    new OpenCodeAgentAdapter(),
    new OpenHandsAgentAdapter()
  ];
  for (const adapter of adapters) {
    adapter.activeRunCount = 0;
    adapter.maxConcurrency = 1;
    adapter.disabled = false;
    hub.register(adapter);
  }
  const service = createExternalAgentVerificationService({
    agentHub: hub,
    adapterRegistry: registry,
    verificationRegistry
  });

  let modelCalls = 0;
  let paidCalls = 0;
  let modelCallsKnown = true;
  let paidCallsKnown = true;
  try {
    for (const adapter of adapters) {
      const result = await service.realVerify(adapter.id, { explicitConsent: true });
      if (result.externalModelCalls == null && result.taskDispatches > 0) modelCallsKnown = false;
      else modelCalls += Number(result.externalModelCalls || 0);
      if (result.paidCalls == null && result.taskDispatches > 0) paidCallsKnown = false;
      else paidCalls += Number(result.paidCalls || 0);
      const status = result.ok
        ? 'REAL_AGENT_TASK_VERIFIED'
        : (result.errorCode || result.verificationLevel || 'FAILED');
      console.log(`${adapter.id.toUpperCase().replace(/-/g, '_')}_REAL_TASK=${status}`);
    }
  } finally {
    for (const adapter of adapters) {
      if (typeof adapter.dispose === 'function') {
        try { await adapter.dispose(); } catch { /* residue is reflected by individual result */ }
      }
    }
  }
  console.log(`REAL_EXTERNAL_MODEL_CALLS=${modelCallsKnown ? modelCalls : 'UNKNOWN'}`);
  console.log(`PAID_PROVIDER_CALLS=${paidCallsKnown ? paidCalls : 'UNKNOWN'}`);
}

main().catch(error => {
  console.error(`REAL_EXTERNAL_AGENT_TESTS=FAILED ${error.code || error.message}`);
  process.exitCode = 1;
});
