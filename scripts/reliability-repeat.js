'use strict';
/**
 * v2.9.8 Real Project Reliability — Repetition Gates（Determinism / Flake Gates）。
 *
 * 用法：
 *   node scripts/reliability-repeat.js production 10   # Reliability Production 10/10
 *   node scripts/reliability-repeat.js soak 1          # Reliability Soak（内部 20/20 fresh repos）
 *   node scripts/reliability-repeat.js provider-abort 20 # provider-abort critical 20/20
 *   node scripts/reliability-repeat.js unit 3          # full npm test 3/3
 *
 * 语义：串行重复执行整个套件 N 次；任何一次失败立即非零退出并报告 i/N。
 * 绝对禁止「只重跑失败的一次然后报满分」—— 每次迭代都是完整套件。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const kind = process.argv[2] || '';
const rounds = Math.max(1, Number(process.argv[3]) || 1);

const GATES = {
  production: { label: 'Reliability Production', cmd: () => spawnSync(process.execPath, [path.join('scripts', 'reliability-production-smoke.js')], { cwd: root, env: process.env, encoding: 'utf8' }) },
  soak: { label: 'Reliability Soak', cmd: () => spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), 'reliabilitySoak'], { cwd: root, env: process.env, encoding: 'utf8' }) },
  'provider-abort': { label: 'Provider Abort Critical', cmd: () => spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), 'providerabort'], { cwd: root, env: process.env, encoding: 'utf8' }) },
  unit: { label: 'Full Unit Suite', cmd: () => spawnSync(process.execPath, [path.join('scripts', 'run-tests.js')], { cwd: root, env: process.env, encoding: 'utf8' }) }
};

const gate = GATES[kind];
if (!gate) {
  console.error(`reliability-repeat: unknown gate "${kind}"（可用：${Object.keys(GATES).join(', ')}）`);
  process.exit(2);
}

for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now();
  const result = gate.cmd();
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  if (result.status !== 0) {
    console.error(`GATE_${kind.toUpperCase().replace(/-/g, '_')} FAIL iteration=${i}/${rounds} exitCode=${result.status}`);
    process.exit(result.status || 1);
  }
  console.log(`GATE_${kind.toUpperCase().replace(/-/g, '_')} iteration=${i}/${rounds} PASS wallMs=${Date.now() - t0}`);
}
console.log(`GATE_${kind.toUpperCase().replace(/-/g, '_')} ${rounds}/${rounds} PASS (${gate.label})`);
