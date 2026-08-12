'use strict';
/**
 * v2.9.7 Architecture Freeze Final Closure — Product Production Smoke.
 *
 * The summary is derived from real machine proof, never printed unconditionally:
 * every suite runs serially through the real test runner; any suite failure
 * exits non-zero immediately, and the final PASS summary is only emitted when
 * each label has a matching proof token in the captured suite output.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

const suites = [
  { filter: 'productProduction', label: 'productProduction' },
  { filter: 'dynamicAgentProduction', label: 'dynamicAgentProduction' },
  { filter: 'workflowProduction', label: 'workflowProduction' },
  { filter: 'generatorProduction', label: 'generatorProduction' }
];

const outputBySuite = {};
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), suite.filter], {
    cwd: root,
    env: process.env,
    encoding: 'utf8'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  outputBySuite[suite.label] = output;
  if (result.status !== 0) {
    console.error(`PRODUCT_PRODUCTION_SMOKE FAIL suite=${suite.label} exitCode=${result.status}`);
    process.exit(result.status || 1);
  }
}

const proof = {
  mainProductEntry: outputBySuite.productProduction.includes('PRODUCT_MAIN_PRODUCTION entry=application-service'),
  mainToDynamic: outputBySuite.productProduction.includes('PRODUCT_MAIN_TO_DYNAMIC entry=ProductEntry')
    && outputBySuite.productProduction.includes('childResultConsumed=YES')
    && outputBySuite.productProduction.includes('parentLinkage=PASS')
    && outputBySuite.productProduction.includes('rootIdentity=PASS'),
  workflowProductEntry: outputBySuite.workflowProduction.includes('WORKFLOW_PRODUCTION'),
  generatorProductEntry: outputBySuite.generatorProduction.includes('GENERATOR_PRODUCTION'),
  security: outputBySuite.dynamicAgentProduction.includes('DYNAMIC_AGENT_PRODUCTION security=PASS'),
  cancellation: outputBySuite.productProduction.includes('cancellation=PASS')
};

const allOutput = Object.values(outputBySuite).join('\n');
const paidTokens = [...allOutput.matchAll(/paidProviderCalls=(\d+)/g)].map(match => Number(match[1]));
const paidProviderCallsZero = paidTokens.length > 0 && paidTokens.every(value => value === 0);

const missing = Object.entries(proof).filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length || !paidProviderCallsZero) {
  if (missing.length) console.error(`PRODUCT_PRODUCTION_SMOKE FAIL missing proof: ${missing.join(', ')}`);
  if (!paidProviderCallsZero) console.error('PRODUCT_PRODUCTION_SMOKE FAIL paid provider calls not proven zero');
  process.exit(1);
}

console.log('PRODUCT_PRODUCTION_SMOKE PASS');
console.log('mainProductEntry=PASS');
console.log('mainToDynamic=PASS');
console.log('workflowProductEntry=PASS');
console.log('generatorProductEntry=PASS');
console.log('security=PASS');
console.log('cancellation=PASS');
console.log('paidProviderCalls=0');
