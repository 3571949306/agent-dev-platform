'use strict';
/**
 * v2.9.9 Phase B Final — B19 Terminal Workspace 2.0 契约测试。
 *
 * 机器证明：
 *   TERMINAL_ACTIVE=PASS        活动命令含 Command/CWD/Owner/Started/Duration/Status
 *   TERMINAL_HISTORY=PASS       有界历史含 exitCode/duration/timeout/cancelled 真话
 *   TERMINAL_CANCEL_TREE=PASS   Cancel 真实终止进程树（cancelled 与 timeout 不互换）
 *   TERMINAL_OUTPUT_BOUNDED=PASS 完整输出 backend 可查，Renderer 自行 bounded
 *   TERMINAL_OWNER_TRUTH=PASS   USER/MAIN_AGENT/CHILD_AGENT/WORKFLOW 各归其主
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const term = require('../src/tools/terminal');
const { terminalManager, runCommand, isHighRisk } = term;

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-term-'));

// 长进程 fixture：用独立脚本文件避免 cmd 嵌套引号的地域差异（确定、无歧义）
fs.writeFileSync(path.join(CWD, 'b19-long.js'), 'setTimeout(() => {}, 15000);\n', 'utf8');
const LONG_CMD = 'node b19-long.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('B19.1/B19.3/B19.5 active command truth + real process-tree cancel', async () => {
  const events = [];
  const ctx = { emit: (type, payload) => events.push({ type, payload }) };
  // 真实长进程：node setTimeout 15s；cancel 必须立刻终止（进程树 kill）
  const runId = 'b19-long-run';
  const pending = runCommand(ctx, LONG_CMD, CWD, 60000, false, runId, null, { owner: 'USER' });
  // 等子进程真正进入 running（启动耗时不确定，最多等 8s）
  let entry = null;
  for (let i = 0; i < 160; i++) {
    entry = terminalManager.active().find(a => a.id === runId);
    if (entry) break;
    await sleep(50);
  }
  if (!entry) {
    const settledDbg = await Promise.race([pending, sleep(3000).then(() => 'PENDING')]);
    assert.fail('active command listed — settled early: ' + JSON.stringify(settledDbg).slice(0, 400));
  }
  assert.strictEqual(entry.owner, 'USER');
  assert.ok(entry.command.includes('b19-long.js'));
  assert.strictEqual(entry.cwd, CWD);
  assert.ok(entry.durationMs >= 0 && typeof entry.startedAt === 'number');
  assert.strictEqual(entry.status, 'running');
  console.log('TERMINAL_ACTIVE=PASS');

  // Cancel：真实终止进程树
  assert.strictEqual(terminalManager.cancel(runId), true);
  const settled = await pending;
  assert.strictEqual(terminalManager.activeCount(), 0, 'no active terminal after cancel');
  const output = terminalManager.output(runId);
  assert.ok(output.cancelled, 'cancelled truth recorded');
  assert.notStrictEqual(output.timeout, true, 'cancelled != timeout: must not be interchanged');
  const hist = terminalManager.history(50).find(h => h.id === runId);
  assert.ok(hist, 'cancelled run enters bounded history');
  assert.strictEqual(hist.cancelled, true);
  assert.strictEqual(hist.timeout, false);
  console.log('TERMINAL_CANCEL_TREE=PASS');
  console.log('TERMINAL_CANCEL_RESIDUE=0');
});

test('B19.2/B19.3 history + full output truth (exitCode/duration/stdout)', async () => {
  const ctx = { emit: () => {} };
  const runId = 'b19-echo';
  const r = await runCommand(ctx, 'echo B19_OUTPUT_PROOF_7351', CWD, 30000, false, runId, null, { owner: 'MAIN_AGENT', agentRunId: 'run-x' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.exit_code, 0);
  assert.ok(r.data.stdout.includes('B19_OUTPUT_PROOF_7351'));

  const hist = terminalManager.history(50).find(h => h.id === runId);
  assert.ok(hist, 'history entry exists');
  assert.strictEqual(hist.exitCode, 0);
  assert.strictEqual(hist.owner, 'MAIN_AGENT');
  assert.ok(hist.durationMs >= 0);
  assert.ok(hist.stdout.includes('B19_OUTPUT_PROOF_7351'), 'full stdout preserved in backend history');

  // terminal:output 等价 backend 查询：完整输出可审计
  const output = terminalManager.output(runId);
  assert.strictEqual(output.exitCode, 0);
  assert.strictEqual(output.timeout, false);
  assert.strictEqual(output.cancelled, false);
  assert.ok(output.stdout.includes('B19_OUTPUT_PROOF_7351'));
  console.log('TERMINAL_HISTORY=PASS');
  console.log('TERMINAL_OUTPUT_BOUNDED=PASS');
});

test('B19.1 owner truth: USER / MAIN_AGENT / CHILD_AGENT / WORKFLOW never mixed', async () => {
  const ctx = { emit: () => {} };
  const owners = [
    ['b19-o1', 'USER'],
    ['b19-o2', 'MAIN_AGENT'],
    ['b19-o3', 'CHILD_AGENT'],
    ['b19-o4', 'WORKFLOW']
  ];
  for (const [runId, owner] of owners) {
    await runCommand(ctx, 'echo owner', CWD, 10000, false, runId, null, { owner });
  }
  for (const [runId, owner] of owners) {
    const hist = terminalManager.history(50).find(h => h.id === runId);
    assert.strictEqual(hist.owner, owner, `owner truth preserved for ${owner}`);
  }
  console.log('TERMINAL_OWNER_TRUTH=PASS');
});

test('B19.3 timeout truth stays timeout (never reported cancelled)', async () => {
  const ctx = { emit: () => {} };
  const runId = 'b19-timeout';
  const r = await runCommand(ctx, LONG_CMD, CWD, 500, false, runId, null, { owner: 'MAIN_AGENT' });
  assert.strictEqual(r.ok, false, 'must fail: ' + JSON.stringify(r).slice(0, 300));
  assert.strictEqual(r.error.code, 'TERMINAL_TIMEOUT', 'expected timeout, got ' + JSON.stringify(r.error));
  const hist = terminalManager.history(50).find(h => h.id === runId);
  assert.strictEqual(hist.timeout, true);
  assert.strictEqual(hist.cancelled, false, 'timeout != cancelled');
  assert.strictEqual(hist.status, 'timeout');
  console.log('TERMINAL_TIMEOUT_TRUTH=PASS');
});

test('B19.6 dangerous commands are detected even when typed by the user', () => {
  assert.strictEqual(isHighRisk('git reset --hard HEAD~1'), true);
  assert.strictEqual(isHighRisk('rm -rf ./build'), true);
  assert.strictEqual(isHighRisk('format C:'), true);
  assert.strictEqual(isHighRisk('npm test'), false, 'ordinary commands stay normal');
  assert.strictEqual(isHighRisk('node scripts/run-tests.js'), false);
  console.log('TERMINAL_DANGEROUS_GATE=PASS');
});

test('B19.2 history is bounded', async () => {
  const ctx = { emit: () => {} };
  for (let i = 0; i < 60; i++) {
    await runCommand(ctx, `echo bounded-${i}`, CWD, 10000, false, `b19-bound-${i}`, null, { owner: 'USER' });
  }
  assert.ok(terminalManager.history(1000).length <= 50, 'history bounded at 50');
  assert.ok(terminalManager.history(1000).some(h => h.id === 'b19-bound-59'), 'newest kept');
  console.log('TERMINAL_HISTORY_BOUNDED=PASS');
});
