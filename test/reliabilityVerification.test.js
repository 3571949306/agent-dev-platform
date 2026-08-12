'use strict';
/**
 * v2.9.8 Real Project Reliability — R4.
 *
 * Verification Freshness + Repair Truth:
 *  - 测试 PASS 只对执行时的代码状态有效（mutationSeq 新鲜度裁决）
 *  - 模型说「完成了」≠ completed（Completion Policy 仍是最终裁决者）
 *  - 真实 Repair Loop：fail → repair → pass → complete
 *  - 无验证可用时报告 verificationStatus = NOT_AVAILABLE（不伪造 Tests PASS）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { getBuiltin } = require('../src/tools/registry');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');

const CORRECT_APP = 'function getValue() { return 42; }\nmodule.exports = { getValue };\n';
const BROKEN_APP = 'function getValue() { return 43; }\nmodule.exports = { getValue };\n';
const CHECK_CMD = 'node test/check.js';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-verify-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), BROKEN_APP, 'utf8');
  fs.writeFileSync(path.join(root, 'test', 'check.js'),
    'const { getValue } = require(\'../src/app\');\n' +
    'if (getValue() !== 42) { console.error(\'VALUE_CHECK_FAIL\'); process.exit(1); }\n' +
    'console.log(\'VALUE_CHECK_PASS\');\n', 'utf8');
  return root;
}

function waitForTerminal(runManager, runId) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const run = runManager.getRun(runId);
      if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) {
        clearInterval(timer);
        resolve(run);
      }
    }, 15);
  });
}

async function runScript(scriptActions, root) {
  const runManager = new RunManager();
  const events = [];
  const pe = new PermissionEngine({ projectId: 'rpr-verify' });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });
  const { runId } = runMainAgent({
    conversationId: 'rpr-verify-' + Math.random().toString(36).slice(2),
    agentId: 'native-main',
    goal: 'make the value check pass',
    projectRoot: root, projectId: 'rpr-verify',
    model: createFakeCodingModel(scriptActions),
    getTool: getBuiltin, store: null,
    emit: (type, payload) => { events.push({ type, payload }); },
    runManager, permissionEngine: pe,
    requestPermission: async () => ({ decision: 'deny', range: 'once' }),
    timeoutMs: 30000
  });
  const terminal = await waitForTerminal(runManager, runId);
  return { runManager, runId, terminal, events };
}

test('R4 Scenario A: stale PASS cannot complete — rerun, repair, fresh PASS required', async () => {
  const root = makeFixture();
  try {
    const { terminal, events } = await runScript([
      { type: 'write_file', args: { path: 'src/app.js', content: CORRECT_APP } },   // mutation seq 1
      { type: 'run_tests', args: { command: CHECK_CMD } },                           // PASS @ seq 1
      { type: 'write_file', args: { path: 'src/app.js', content: BROKEN_APP } },     // mutation seq 2 → 旧 PASS 已 stale
      { type: 'complete', args: { summary: 'done' } },                               // 必须被拒绝
      { type: 'run_tests', args: { command: CHECK_CMD } },                           // FAIL（当前代码确实坏了）
      { type: 'write_file', args: { path: 'src/app.js', content: CORRECT_APP } },   // 修复 mutation seq 3
      { type: 'run_tests', args: { command: CHECK_CMD } },                           // PASS @ seq 3（新鲜）
      { type: 'complete', args: { summary: 'done for real' } }                       // 此时才允许完成
    ], root);

    assert.strictEqual(terminal.status, 'completed', `run should finally complete, got ${terminal.status}`);

    // 第一次 complete 必须被拒绝（stale verification），证据：REPAIR_START 且原因含 freshness
    const repairs = events.filter(e => e.type === EVENTS.REPAIR_START);
    assert.ok(repairs.length >= 1, 'stale complete attempt must trigger repair');
    assert.ok(repairs.some(e => /验证已过期|verify:freshness/.test(e.payload.reason)),
      'first completion must be rejected for stale verification: ' + JSON.stringify(repairs.map(e => e.payload.reason)));

    // 完成事件的 verificationStatus 必须是真实的 PASS（新鲜测试）
    const completedEvent = events.find(e => e.type === EVENTS.RUN_COMPLETED);
    assert.ok(completedEvent, 'RUN_COMPLETED emitted');
    assert.strictEqual(completedEvent.payload.verificationStatus, 'PASS');
    // 最终文件状态是修复后的
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), CORRECT_APP);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R4 Scenario B: fresh test FAIL + model complete → never completed (REPAIR/FAILED only)', async () => {
  const root = makeFixture();
  try {
    const { terminal, events } = await runScript([
      { type: 'write_file', args: { path: 'src/app.js', content: BROKEN_APP } },
      { type: 'run_tests', args: { command: CHECK_CMD } }, // FAIL（exitCode != 0）
      { type: 'complete', args: { summary: '假装完成' } }     // 模型直接 complete → 必须被拒绝
    ], root);

    assert.notStrictEqual(terminal.status, 'completed', 'a run with a fresh failing test must never be completed');
    assert.strictEqual(terminal.status, 'failed');
    assert.ok(/已达修复上限|AGENT_REPAIR_LIMIT/.test(terminal.error || ''), `repair-limit failure expected, got: ${terminal.error}`);
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false, 'no RUN_COMPLETED event may be emitted');
    assert.ok(events.some(e => e.type === EVENTS.REPAIR_START), 'repair was attempted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R4 Scenario C: real repair loop — fail, repair, pass, complete', async () => {
  const root = makeFixture();
  try {
    const { terminal, events } = await runScript([
      { type: 'write_file', args: { path: 'src/app.js', content: BROKEN_APP } },
      { type: 'run_tests', args: { command: CHECK_CMD } }, // FAIL
      { type: 'write_file', args: { path: 'src/app.js', content: CORRECT_APP } },
      { type: 'run_tests', args: { command: CHECK_CMD } }, // PASS
      { type: 'complete', args: { summary: 'repaired' } }
    ], root);

    assert.strictEqual(terminal.status, 'completed');
    const repairs = events.filter(e => e.type === EVENTS.REPAIR_START);
    assert.ok(repairs.length >= 1, 'repairRounds >= 1');
    const testResults = events.filter(e => e.type === EVENTS.TEST_RESULT);
    const lastTest = testResults[testResults.length - 1];
    assert.strictEqual(lastTest.payload.passed, true, 'final tests = PASS');
    const completedEvent = events.find(e => e.type === EVENTS.RUN_COMPLETED);
    assert.strictEqual(completedEvent.payload.verificationStatus, 'PASS', 'final verification newer than last mutation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R4 No Tests Available: completion allowed but verificationStatus = NOT_AVAILABLE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-noverify-'));
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'no verification configured\n', 'utf8');
    const { terminal, events } = await runScript([
      { type: 'complete', args: { summary: 'nothing to verify' } }
    ], root);

    assert.strictEqual(terminal.status, 'completed');
    const completedEvent = events.find(e => e.type === EVENTS.RUN_COMPLETED);
    assert.ok(completedEvent);
    assert.strictEqual(completedEvent.payload.verificationStatus, 'NOT_AVAILABLE',
      'must report NOT_AVAILABLE instead of faking Tests PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
