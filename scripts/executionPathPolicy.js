'use strict';
/**
 * v2.9.7 Architecture Freeze Final Closure — Execution Path Policy.
 *
 * The Architecture Gate is DEFAULT DENY: a monitored execution signature may only
 * appear in production source paths that are explicitly allowlisted below. Any
 * unknown src/** occurrence classifies as UNSAFE_DUPLICATE and fails the gate.
 *
 * The allowlist was built from a full repository scan at HEAD
 * ebf1f8f01b134630368bdc83268ab9adece7e368 (version 2.9.7). Paths are exact
 * normalized repository paths — no prefix matching, so a second runtime hiding
 * under e.g. src/agent/ or src/foo/ is still rejected.
 */

/** Monitored execution signatures (superset of the frozen gate signatures). */
const SIGNATURE_PATTERNS = Object.freeze([
  ['provider.streamResponse', /\.streamResponse\s*\(/g],
  ['model.decide', /\.decide\s*\(/g],
  ['tool.exec', /\btool\.exec\s*\(/g],
  ['child_process', /require\(['"]child_process['"]\)/g],
  ['fs.write', /\b(?:fs|fsp)(?:\.promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync)\s*\(/g],
  ['AgentHub.start', /\bagentHub\.start(?:Auto)?\s*\(/g],
  ['runMainAgent', /\brunMainAgent\s*\(/g],
  ['PermissionEngine.evaluate', /\bpermissionEngine\.evaluate\s*\(/g]
]);

/**
 * Explicit production allowlist per signature.
 * canonical = frozen production truth; legacy = compatibility paths only.
 */
const EXECUTION_PATH_POLICY = Object.freeze({
  'provider.streamResponse': Object.freeze({
    canonical: [
      // The single native Agent-to-model wire.
      'src/agent/runtime/providerModelAdapter.js',
      // Production provider capability probes.
      'src/providers/capabilities.js'
    ],
    legacy: [
      // Legacy chat compatibility loop.
      'src/agent/runtime.js',
      // External-Agent compatibility transport.
      'src/services/externalAgents.js',
      // Vision fallback path.
      'src/services/visionReader.js'
    ]
  }),

  'model.decide': Object.freeze({
    canonical: [
      // The single native loop (Main and Dynamic native runs share it).
      'src/agent/runtime/agentLoop.js',
      // RuntimeModelResolver drives the routed adapter.
      'src/models/router/runtimeModelResolver.js',
      // Generator configuration generation.
      'src/generator/generatorService.js'
    ],
    legacy: []
  }),

  'tool.exec': Object.freeze({
    canonical: [
      // The single production tool gate (PermissionEngine + PathSecurity).
      'src/agent/runtime/actionExecutor.js'
    ],
    legacy: [
      // Legacy chat compatibility gate.
      'src/agent/runtime.js'
    ]
  }),

  child_process: Object.freeze({
    canonical: [
      // Owned terminal/Git/checkpoint transports.
      'src/tools/terminal.js',
      'src/tools/git.js',
      'src/tools/checkpoint.js',
      'src/agent/runtime/gitHelper.js',
      // Owned MCP / Computer / external-Agent transports.
      'src/services/mcp.js',
      'src/services/computer.js',
      'src/services/externalAgents.js',
      // Owned CLI adapter + supervisor transports.
      'src/agents/adapters/cliAgentAdapter.js',
      'src/agents/adapters/codexAgentAdapter.js',
      'src/agents/adapters/openHandsAgentAdapter.js',
      'src/agents/runtime/cliProcessSupervisor.js',
      // Owned sidecar transports.
      'src/agents/integrations/cline/sidecarManager.js',
      'src/agents/integrations/opencode/serverManager.js'
    ],
    legacy: []
  }),

  'fs.write': Object.freeze({
    canonical: [
      // Tool providers guarded by PathSecurity.
      'src/tools/filesystem.js',
      'src/tools/patch.js'
    ],
    legacy: [
      // Legacy artifact persistence in the chat compatibility loop.
      'src/agent/runtime.js'
    ]
    // Generator, Skill, and Hook directories must never mutate the filesystem;
    // they are absent on purpose so any occurrence fails closed.
  }),

  'AgentHub.start': Object.freeze({
    canonical: [
      // Delegation / Workflow Agent step entry wired by the application.
      'src/ipc/handlers.js',
      // Documentation occurrence describing the start integration contract.
      'src/security/projectMutationLock.js'
    ],
    legacy: []
  }),

  runMainAgent: Object.freeze({
    canonical: [
      // Application Main service entry.
      'src/ipc/mainAgent.js',
      // Canonical loop definition (including its usage documentation).
      'src/agent/runtime/mainAgentRuntime.js'
    ],
    legacy: []
  }),

  'PermissionEngine.evaluate': Object.freeze({
    canonical: [
      // Shared tool gate.
      'src/agent/runtime/actionExecutor.js',
      // Skill resolution permission intersection.
      'src/agent/runtime/mainAgentRuntime.js'
    ],
    legacy: [
      // Legacy chat compatibility gate.
      'src/agent/runtime.js'
    ]
  })
});

/**
 * Fail-closed classifier.
 *
 *   test/** or scripts/**        -> TEST_ONLY
 *   exact path in policy.legacy  -> LEGACY_COMPATIBILITY
 *   exact path in policy.canonical -> CANONICAL
 *   any other src/** occurrence  -> UNSAFE_DUPLICATE   (DEFAULT DENY)
 *   anything else                -> null (no classification needed)
 *
 * @param {string} signature  one of SIGNATURE_PATTERNS names
 * @param {string} filePath   normalized repository-relative path
 * @returns {'CANONICAL'|'LEGACY_COMPATIBILITY'|'TEST_ONLY'|'UNSAFE_DUPLICATE'|null}
 */
function classify(signature, filePath) {
  const file = String(filePath || '').replace(/\\/g, '/');
  if (file.startsWith('test/') || file.startsWith('scripts/')) return 'TEST_ONLY';
  if (!file.startsWith('src/')) return null;
  const policy = EXECUTION_PATH_POLICY[signature];
  if (!policy) return 'UNSAFE_DUPLICATE'; // unknown signature inside src: deny
  if (policy.legacy.includes(file)) return 'LEGACY_COMPATIBILITY';
  if (policy.canonical.includes(file)) return 'CANONICAL';
  return 'UNSAFE_DUPLICATE'; // unknown production execution path: deny
}

/**
 * Synthetic adversarial cases: future/unknown production paths must all be
 * blocked. These never touch the real repository tree.
 */
const SYNTHETIC_ADVERSARIAL_CASES = Object.freeze([
  { signature: 'model.decide', filePath: 'src/future/secondAgentLoop.js' },
  { signature: 'tool.exec', filePath: 'src/future/directToolRunner.js' },
  { signature: 'runMainAgent', filePath: 'src/future/secondMainRuntime.js' },
  { signature: 'PermissionEngine.evaluate', filePath: 'src/future/newPermissionGate.js' },
  { signature: 'provider.streamResponse', filePath: 'src/workflows/providerBypass.js' },
  { signature: 'child_process', filePath: 'src/random/unownedProcess.js' },
  { signature: 'fs.write', filePath: 'src/generator/configWriter.js' },
  { signature: 'fs.write', filePath: 'src/skills/skillFileWriter.js' },
  { signature: 'fs.write', filePath: 'src/hooks/hookFileWriter.js' },
  { signature: 'AgentHub.start', filePath: 'src/generator/hubLauncher.js' },
  { signature: 'model.decide', filePath: 'src/foo/newRuntime.js' },
  { signature: 'runMainAgent', filePath: 'src/foo/secondMain.js' }
]);

/** Positive controls: the policy must still allow the frozen known paths. */
const POSITIVE_CONTROL_CASES = Object.freeze([
  { signature: 'provider.streamResponse', filePath: 'src/agent/runtime/providerModelAdapter.js', expected: 'CANONICAL' },
  { signature: 'model.decide', filePath: 'src/agent/runtime/agentLoop.js', expected: 'CANONICAL' },
  { signature: 'tool.exec', filePath: 'src/agent/runtime/actionExecutor.js', expected: 'CANONICAL' },
  { signature: 'runMainAgent', filePath: 'src/ipc/mainAgent.js', expected: 'CANONICAL' },
  { signature: 'PermissionEngine.evaluate', filePath: 'src/agent/runtime/mainAgentRuntime.js', expected: 'CANONICAL' },
  { signature: 'child_process', filePath: 'src/tools/terminal.js', expected: 'CANONICAL' },
  { signature: 'fs.write', filePath: 'src/tools/patch.js', expected: 'CANONICAL' },
  { signature: 'AgentHub.start', filePath: 'src/ipc/handlers.js', expected: 'CANONICAL' },
  { signature: 'provider.streamResponse', filePath: 'src/agent/runtime.js', expected: 'LEGACY_COMPATIBILITY' },
  { signature: 'tool.exec', filePath: 'src/agent/runtime.js', expected: 'LEGACY_COMPATIBILITY' },
  { signature: 'PermissionEngine.evaluate', filePath: 'src/agent/runtime.js', expected: 'LEGACY_COMPATIBILITY' },
  { signature: 'fs.write', filePath: 'src/agent/runtime.js', expected: 'LEGACY_COMPATIBILITY' },
  { signature: 'model.decide', filePath: 'test/someFixture.test.js', expected: 'TEST_ONLY' },
  { signature: 'child_process', filePath: 'scripts/some-script.js', expected: 'TEST_ONLY' }
]);

/**
 * Run the synthetic fail-closed proof.
 * @returns {{ allBlocked: boolean, results: Array<{signature, filePath, classification, blocked}> }}
 */
function runAdversarialProof() {
  const results = SYNTHETIC_ADVERSARIAL_CASES.map(item => {
    const classification = classify(item.signature, item.filePath);
    return { ...item, classification, blocked: classification === 'UNSAFE_DUPLICATE' };
  });
  return { allBlocked: results.every(item => item.blocked), results };
}

/**
 * Run the positive controls (the classifier must not degenerate into deny-all).
 * @returns {{ allCorrect: boolean, results: Array<{signature, filePath, expected, actual}> }}
 */
function runPositiveControls() {
  const results = POSITIVE_CONTROL_CASES.map(item => {
    const actual = classify(item.signature, item.filePath);
    return { signature: item.signature, filePath: item.filePath, expected: item.expected, actual };
  });
  return { allCorrect: results.every(item => item.actual === item.expected), results };
}

module.exports = {
  SIGNATURE_PATTERNS,
  EXECUTION_PATH_POLICY,
  classify,
  SYNTHETIC_ADVERSARIAL_CASES,
  POSITIVE_CONTROL_CASES,
  runAdversarialProof,
  runPositiveControls
};
