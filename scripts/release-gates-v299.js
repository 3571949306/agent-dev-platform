'use strict';
// v2.9.9 Phase B — Release Gates（严格串行；任一失败立即停止）
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');

const gates = [
  ['npm test', ['scripts/run-tests.js']],
  ['test:dynamic-agent', ['scripts/run-tests.js', 'dynamicAgent']],
  ['test:dynamic-agent:production', ['scripts/run-tests.js', 'dynamicAgentProduction']],
  ['test:model-router', ['scripts/run-tests.js', 'modelRouter.test']],
  ['test:model-router:production', ['scripts/run-tests.js', 'modelRouterProduction']],
  ['test:skill', ['scripts/run-tests.js', 'skill.test']],
  ['test:skill:production', ['scripts/run-tests.js', 'skillProduction']],
  ['test:hook', ['scripts/run-tests.js', 'hook.test']],
  ['test:hook:production', ['scripts/run-tests.js', 'hookProduction']],
  ['test:workflow', ['scripts/run-tests.js', 'workflow.test']],
  ['test:workflow:production', ['scripts/run-tests.js', 'workflowProduction']],
  ['test:generator', ['scripts/run-tests.js', 'generator.test']],
  ['test:generator:production', ['scripts/run-tests.js', 'generatorProduction']],
  ['test:architecture', ['scripts/test-architecture.js']],
  ['test:architecture-policy', ['scripts/run-tests.js', 'architecturePolicy']],
  ['test:product', ['scripts/run-tests.js', 'product.test']],
  ['test:product:production', ['scripts/product-production-smoke.js']],
  ['test:reliability', ['scripts/run-tests.js', 'reliability']],
  ['test:reliability:production', ['scripts/reliability-production-smoke.js']],
  ['test:reliability:soak', ['scripts/run-tests.js', 'reliabilitySoak']],
  ['test:gui', ['scripts/run-tests.js', 'guiWorkbench']],
  ['test:gui:production', ['scripts/gui-production-smoke.js']],
  ['e2e', [require.resolve('@playwright/test/cli'), 'test']]
];

for (const [label, args] of gates) {
  console.log(`\n=== GATE ${label} ===`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '0' } });
  const code = result.status === null ? 1 : result.status;
  if (code !== 0) {
    console.log(`GATE_FAILED=${label}`);
    process.exit(code);
  }
  console.log(`GATE_OK=${label}`);
}
console.log('ALL_RELEASE_GATES=PASS');
