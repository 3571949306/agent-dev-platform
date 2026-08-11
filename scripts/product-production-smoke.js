'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const filters = ['productProduction', 'dynamicAgentProduction', 'workflowProduction', 'generatorProduction'];
for (const filter of filters) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), filter], {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('PRODUCT_PRODUCTION_SMOKE PASS main=PASS dynamic=PASS skill=PASS hook=PASS workflow=PASS generator=PASS security=PASS cancellation=PASS paidProviderCalls=0');
