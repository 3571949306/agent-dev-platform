'use strict';
/**
 * Test runner.
 *
 * better-sqlite3 is compiled against Electron's ABI (NODE_MODULE_VERSION 125),
 * so the DB / agent-loop tests must run inside Electron's bundled Node runtime.
 * ELECTRON_RUN_AS_NODE=1 gives us exactly that: plain Node semantics, matching ABI.
 *
 * Usage:  node scripts/run-tests.js [nameFilter]
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const filter = process.argv[2] || '';

const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filter || f.includes(filter))
  .map(f => path.join('test', f));

if (!files.length) {
  console.error('没有找到测试文件');
  process.exit(1);
}

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('未安装 electron，无法运行需要原生模块的测试。请先 npm install。');
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件（Electron Node 运行时）：\n  ${files.join('\n  ')}\n`);

const r = spawnSync(electronBin, ['--test', ...files], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
});

process.exit(r.status === null ? 1 : r.status);
