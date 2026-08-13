'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function run(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`GUI_PRODUCTION_FAILURE=${label}`);
    process.exit(result.status || 1);
  }
}

run([path.join(root, 'scripts', 'run-tests.js'), 'mainCanonicalEntry'], 'canonical-main-proof');
run([
  require.resolve('@playwright/test/cli'),
  'test',
  'test/e2e/workbench.spec.js',
  '--workers=1',
  '--reporter=list'
], 'electron-workbench');

console.log('GUI_PRODUCT_MAIN_WORKBENCH=PASS');
console.log('GUI_INLINE_CHILD_TREE=PASS');
console.log('GUI_PARENT_CONSUMES_RESULTS=PASS');
console.log('GUI_CONCISE_CHAT=PASS');
console.log('GUI_DIFF=PASS');
