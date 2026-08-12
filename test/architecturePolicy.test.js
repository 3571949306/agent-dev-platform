'use strict';
/**
 * v2.9.7 Architecture Freeze Final Closure — R1 self-adversarial proof.
 *
 * The architecture classifier must be fail-closed by construction: synthetic
 * signature + unknown production path inputs are classified without touching
 * the real repository tree, and every one of them must be UNSAFE_DUPLICATE.
 * Positive controls prove the classifier did not degenerate into deny-all.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  classify,
  EXECUTION_PATH_POLICY,
  SYNTHETIC_ADVERSARIAL_CASES,
  runAdversarialProof,
  runPositiveControls
} = require('../scripts/executionPathPolicy');

test('architecture path policy is explicit for every frozen signature', () => {
  const signatures = [
    'provider.streamResponse', 'model.decide', 'tool.exec', 'child_process',
    'fs.write', 'AgentHub.start', 'runMainAgent', 'PermissionEngine.evaluate'
  ];
  for (const signature of signatures) {
    const policy = EXECUTION_PATH_POLICY[signature];
    assert.ok(policy, `policy missing for ${signature}`);
    assert.ok(Array.isArray(policy.canonical), `${signature} canonical allowlist missing`);
    assert.ok(Array.isArray(policy.legacy), `${signature} legacy allowlist missing`);
    for (const entry of [...policy.canonical, ...policy.legacy]) {
      assert.ok(entry.startsWith('src/') && entry.endsWith('.js'), `${signature} allowlist entry must be an exact src path: ${entry}`);
    }
  }
});

test('synthetic unknown production execution paths are blocked (default deny)', () => {
  assert.strictEqual(classify('model.decide', 'src/future/secondAgentLoop.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('tool.exec', 'src/future/directToolRunner.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('runMainAgent', 'src/future/secondMainRuntime.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('PermissionEngine.evaluate', 'src/future/newPermissionGate.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('provider.streamResponse', 'src/workflows/providerBypass.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('child_process', 'src/random/unownedProcess.js'), 'UNSAFE_DUPLICATE');

  const proof = runAdversarialProof();
  assert.strictEqual(proof.allBlocked, true, JSON.stringify(proof.results.filter(item => !item.blocked)));
  assert.ok(proof.results.length >= SYNTHETIC_ADVERSARIAL_CASES.length - 0 && proof.results.length >= 6);
  console.log('ARCHITECTURE_POLICY_ADVERSARIAL syntheticCases=' + proof.results.length + ' allBlocked=YES');
});

test('prefix-like locations still fail closed (no broad directory matching)', () => {
  // Exact-path matching only: being under src/agent/ or src/services/ must not help.
  assert.strictEqual(classify('model.decide', 'src/agent/secondLoop.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('provider.streamResponse', 'src/agent/runtime/secondAdapter.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('child_process', 'src/services/backgroundRunner.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('fs.write', 'src/generator/draftWriter.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('fs.write', 'src/skills/skillPersistence.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('fs.write', 'src/hooks/hookPersistence.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('AgentHub.start', 'src/generator/hubLauncher.js'), 'UNSAFE_DUPLICATE');
  assert.strictEqual(classify('runMainAgent', 'src/agents/hub/secondMain.js'), 'UNSAFE_DUPLICATE');
});

test('known frozen paths remain allowed and scoped paths stay TEST_ONLY', () => {
  const controls = runPositiveControls();
  assert.strictEqual(controls.allCorrect, true, JSON.stringify(controls.results.filter(item => item.actual !== item.expected)));
  assert.strictEqual(classify('model.decide', 'test/fixtures/modelFixture.js'), 'TEST_ONLY');
  assert.strictEqual(classify('child_process', 'scripts/build-helper.js'), 'TEST_ONLY');
  console.log('ARCHITECTURE_POLICY_CONTROLS positiveCases=' + controls.results.length + ' allCorrect=YES');
});
