'use strict';
/**
 * v2.9.8 Real Project Reliability — R8 SOAK。
 *
 * 20 个完全 fresh 的真实临时 Git repos。每一轮：
 *   create repo → commit baseline → seed dirty user state → run full coding task
 *   （真实 fail → repair → pass）→ verify expected files → verify real tests →
 *   verify terminal truth → verify cleanup → destroy repo。
 *
 * Soak Contract：20/20 PASS；任何一轮失败 → 本测试失败（exit != 0）。
 * 绝对禁止「只重跑失败轮然后报 20/20」—— 每轮顺序执行、一次定结果。
 *
 * Per-iteration Resource Proof：activeRuns=0、Dynamic instances=0、
 * AgentHub active=0、Project locks=0、pending approvals=0、
 * owned child processes=0、retry timers=0（late model calls=0）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { getBuiltin } = require('../src/tools/registry');
const { terminalManager } = require('../src/tools/terminal');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { _activeCount: orchestratorActiveCount } = require('../src/agent/orchestrator/mainAgentOrchestrator');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');

const ITERATIONS = 20;

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

async function cleanupDir(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch { /* Windows 句柄释放延迟 */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

function waitTerminal(runManager, runId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const run = runManager.getRun(runId);
      if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) {
        clearInterval(timer); resolve(run); return;
      }
      if (Date.now() > deadline) { clearInterval(timer); resolve(runManager.getRun(runId)); }
    }, 15);
  });
}

/** 一轮完整 soak：fresh repo → dirty seed → fail→repair→pass → verify → destroy。 */
async function runSoakIteration(i) {
  const M_UNCOMMITTED = `USER_UNCOMMITTED_MARKER_4827_it${i}`;
  const M_SAMEFILE = `USER_SAME_FILE_MARKER_5518_it${i}`;
  const M_README = `USER_README_MARKER_9184_it${i}`;
  const M_UNTRACKED = `USER_UNTRACKED_MARKER_3371_it${i}`;

  // --- create repo + commit baseline ---
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `adp-soak-${i}-`));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'soak@example.com');
  git(root, 'config', 'user.name', 'soak');
  fs.writeFileSync(path.join(root, 'src', 'calc.js'),
    'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n', 'utf8');
  fs.writeFileSync(path.join(root, 'test', 'calc.test.js'),
    "'use strict';\nconst { test } = require('node:test');\nconst assert = require('node:assert');\n" +
    "const { add } = require('../src/calc');\n" +
    "test('add works', () => { assert.strictEqual(add(2, 3), 5); });\n", 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'soak readme\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'baseline');

  // --- seed dirty user state（tracked / staged / untracked / same-file）---
  fs.appendFileSync(path.join(root, 'src', 'calc.js'), `// ${M_UNCOMMITTED}\n// ${M_SAMEFILE}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), `# soak\n${M_README}\n`, 'utf8');
  git(root, 'add', 'README.md');
  fs.writeFileSync(path.join(root, 'notes-user.txt'), `${M_UNTRACKED}\n`, 'utf8');

  const headBefore = git(root, 'rev-parse', 'HEAD');
  const readmeBefore = fs.readFileSync(path.join(root, 'README.md'));
  const notesBefore = fs.readFileSync(path.join(root, 'notes-user.txt'));

  // --- run full coding task（真实 fail → repair → pass）---
  const WRONG = 'function add(a, b) {\n  return a * b;\n}\nmodule.exports = { add };\n' +
    `// ${M_UNCOMMITTED}\n// ${M_SAMEFILE}\n`;
  const RIGHT = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n' +
    `// ${M_UNCOMMITTED}\n// ${M_SAMEFILE}\n`;
  const model = createFakeCodingModel([
    { type: 'read_file', args: { path: 'src/calc.js' } },
    { type: 'write_file', args: { path: 'src/calc.js', content: WRONG } },
    { type: 'run_tests', args: { command: 'node --test' } },
    { type: 'write_file', args: { path: 'src/calc.js', content: RIGHT } },
    { type: 'run_tests', args: { command: 'node --test' } },
    { type: 'complete', args: { summary: 'calc fixed' } }
  ]);

  const runManager = new RunManager();
  const events = [];
  const activeRuns = new Map();
  const projectLock = createProjectMutationLock();
  let permissionRequests = 0;
  const pe = new PermissionEngine({ projectId: `soak-${i}` });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });

  const { runId } = runMainAgent({
    conversationId: `soak-${i}-conv`, agentId: 'native-main',
    goal: `soak iteration ${i}: fix the calc bug`,
    projectRoot: root, projectId: `soak-${i}`,
    model, getTool: getBuiltin, store: null,
    emit: (type, payload) => { events.push({ type, payload }); },
    runManager, permissionEngine: pe,
    projectMutationLock: projectLock,
    requestPermission: async () => { permissionRequests++; return { decision: 'deny', range: 'once' }; },
    registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
    unregisterAbort: (convId) => activeRuns.delete(convId || runId),
    timeoutMs: 30000
  });

  try {
    const terminal = await waitTerminal(runManager, runId);

    // --- verify terminal truth ---
    assert.strictEqual(terminal.status, 'completed',
      `iteration ${i}: run must complete, got ${terminal.status} (${terminal.error || ''})`);
    assert.ok(terminal.terminalAt >= terminal.startedAt, 'terminalAt coherent');
    assert.ok(terminal.terminalSource, 'terminal audit source recorded');
    assert.ok(Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0, 'durationMs recorded');

    // --- verify repair truth + verification status ---
    const repairs = events.filter(e => e.type === EVENTS.REPAIR_START);
    assert.ok(repairs.length >= 1, `iteration ${i}: repairRounds >= 1`);
    const completedEvent = events.find(e => e.type === EVENTS.RUN_COMPLETED);
    assert.ok(completedEvent, 'RUN_COMPLETED emitted');
    assert.strictEqual(completedEvent.payload.verificationStatus, 'PASS');
    const testResults = events.filter(e => e.type === EVENTS.TEST_RESULT);
    assert.ok(testResults.some(t => t.payload.passed === false) && testResults.some(t => t.payload.passed === true),
      'real FAIL then real PASS observed');

    // --- verify real tests（run 之外独立复验）---
    const check = spawnSync('node', ['--test'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.strictEqual(check.status, 0, `iteration ${i}: real node --test PASS`);

    // --- verify expected files / user markers / git truth ---
    const calcAfter = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    assert.ok(calcAfter.includes('return a + b'), 'bug fixed');
    assert.ok(calcAfter.includes(M_SAMEFILE) && calcAfter.includes(M_UNCOMMITTED), 'same-file + uncommitted markers preserved');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'README.md')), readmeBefore, 'staged README byte-identical');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'notes-user.txt')), notesBefore, 'untracked byte-identical');
    assert.strictEqual(git(root, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged');
    assert.strictEqual(git(root, 'stash', 'list'), '', 'no stash');

    // --- Per-iteration Resource Proof ---
    const callsAtTerminal = model.callCount();
    await new Promise(r => setTimeout(r, 300));
    terminalManager.pruneTerminal();
    assert.strictEqual(activeRuns.size, 0, 'activeRuns = 0');
    assert.strictEqual(orchestratorActiveCount(), 0, 'Dynamic instances / orchestrators = 0');
    assert.strictEqual(projectLock.snapshot().writeLocks.length + projectLock.snapshot().readLocks.length, 0,
      'Project locks = 0');
    assert.strictEqual(permissionRequests, 0, 'pending approvals = 0');
    assert.strictEqual(terminalManager.activeCount(), 0, 'owned child processes = 0');
    assert.strictEqual(model.callCount(), callsAtTerminal, 'retry timers = 0 (no late model calls)');
    return { ok: true, durationMs: terminal.durationMs, repairs: repairs.length };
  } finally {
    // --- destroy repo（cleanup truth）---
    await cleanupDir(root);
    assert.strictEqual(fs.existsSync(root), false, `iteration ${i}: repo destroyed (cleanup truth)`);
  }
}

test(`R8 soak: ${ITERATIONS} fresh dirty git repos survive a complete fail→repair→pass coding task`, async () => {
  const results = [];
  for (let i = 1; i <= ITERATIONS; i++) {
    const t0 = Date.now();
    // 顺序执行、一次定结果：失败立即 assert 终止（SOAK FAILED，exit != 0）
    const r = await runSoakIteration(i);
    results.push(r);
    console.log(`SOAK_ITERATION_${i}=PASS wallMs=${Date.now() - t0} runMs=${r.durationMs} repairRounds=${r.repairs} resources=ZERO`);
  }
  assert.strictEqual(results.length, ITERATIONS);
  assert.ok(results.every(r => r.ok));
  console.log(`SOAK_RESULT=${results.length}/${ITERATIONS} PASS freshRepos=${ITERATIONS} retryOnlyFailed=NEVER`);
});
