'use strict';
/**
 * v2.9.8 Real Project Reliability — R7 / R8 Production Matrix。
 *
 * 全链：ProductEntry.mainAgent.run → MainAgentService → RunManager →
 * ProviderModelAdapter（fake network provider）→ ActionExecutor → 真实 Tool →
 * 真实文件系统 / 真实 Git / 真实 `node --test`。
 *
 *  - R8-C（必需链）ProductEntry → 真实 filesystem mutation → 真实 node --test FAIL
 *          → Repair → 真实 node --test PASS → Completion Policy → completed，
 *          同时覆盖 R8-A（真实脏 Git 项目，全部用户 marker 保留）与
 *          R8-B（同文件用户 marker 与 Agent 修改共存）。
 *  - R8-D  Stale verification：mutation #2 之后旧 PASS 不得用于完成。
 *  - R8-E  Concurrent external edit：stale write 拒绝，外部编辑保留。
 *  - R8-H  Cancellation + real child process（ProductEntry stop 语义）。
 *  - R7-A/B/E 同项目争用：Run B mutation exec = 0（fail busy）、cancel 释放锁、
 *          锁 holder 绑定真实 runId/agentId/projectRoot（禁止 conversationId 伪装）。
 *  - R7-C/D 失败释放锁；不同项目零假争用。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const store = require('../src/db/store');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { createMainAgentService } = require('../src/ipc/mainAgent');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createModelCatalog, createModelRouter, createRuntimeModelResolver, createRouteAudit } = require('../src/models/router');
const { getBuiltin, listBuiltinDefs } = require('../src/tools/registry');
const { createProductEntry } = require('../src/services/productEntry');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');

const USER_UNCOMMITTED_MARKER = 'USER_UNCOMMITTED_MARKER_4827';
const USER_README_MARKER = 'USER_README_MARKER_9184';
const USER_UNTRACKED_MARKER = 'USER_UNTRACKED_MARKER_3371';
const USER_SAME_FILE_MARKER = 'USER_SAME_FILE_MARKER_5518';
const EXTERNAL_EDIT_MARKER = 'EXTERNAL_EDIT_MARKER_7281';

const cap = value => ({ value, state: 'tested', source: 'reliability-production-fixture' });
const metric = value => ({ value, state: 'declared', source: 'reliability-production-fixture' });

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
    } catch { /* Windows 句柄延迟 */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function waitTerminal(runManager, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runManager.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return runManager.getRun(runId);
}

async function settleTo(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return predicate();
}

/**
 * 生产接线：真实 Store + ModelRouter + ProviderModelAdapter + MainAgentService + ProductEntry。
 * activeProvider 可变闭包：每个场景在 run 前设置自己的脚本化 fake network provider。
 */
function buildPlatform({ projectRoots }) {
  let activeProvider = null;
  let providerCalls = 0;
  const countCalls = () => providerCalls;
  const countingProvider = {
    streamResponse(input) {
      providerCalls++;
      if (!activeProvider) throw new Error('NO_ACTIVE_PROVIDER');
      return activeProvider.streamResponse(input);
    }
  };

  const connection = store.connections.create({
    name: 'Reliability Fake Network', provider: 'custom', base_url: 'https://reliability.invalid/v1',
    api_key: 'fixture-placeholder-key', models: ['reliability-model-B'], enabled: true
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 1 });
  store.models.upsert(connection.id, 'reliability-model-B', {
    text: cap(true), vision: cap(false), contextWindow: metric(32000), latencyMs: metric(1),
    pricing: { input: metric(0), output: metric(0), currency: 'USD', unit: 'per_1m_tokens' }
  });
  const agent = store.agents.create({
    name: 'Reliability Main', is_main: true, api_connection_id: connection.id,
    model: 'reliability-model-B', tools: []
  });

  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const resolver = createRuntimeModelResolver({
    router,
    audit,
    createModelAdapter(selection) {
      return createProviderModelAdapter({
        buildProvider: async () => countingProvider,
        agent: {
          id: agent.id, name: agent.name, api_connection_id: selection.selected.connectionId,
          model: selection.selected.modelId, max_tokens: 256
        },
        resolveModel: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
        timeoutMs: 5000
      });
    }
  });

  const runManager = new RunManager({ store });
  const projectLock = createProjectMutationLock();
  const events = [];
  const emit = (type, payload) => { events.push({ type, payload }); };

  const workflowRuntimeStub = { run: () => { throw new Error('WORKFLOW_NOT_IN_SCENARIO'); }, cancel: () => {}, approve: () => {}, reject: () => {} };
  const generatorServiceStub = { generate: () => { throw new Error('GENERATOR_NOT_IN_SCENARIO'); }, validate: () => {}, save: () => {}, cancel: () => {} };

  /** 每个 projectRoot 一个 MainAgentService（共享同一把 projectLock 与 RunManager）。 */
  function makeEntry(projectRoot, { timeoutMs = 25000 } = {}) {
    const project = store.projects.create({ name: 'Reliability ' + path.basename(projectRoot), rootPath: projectRoot });
    const activeRuns = new Map();
    const service = createMainAgentService({
      store,
      emit,
      runManager,
      getTool: getBuiltin,
      buildProvider: async () => countingProvider,
      resolveModelFor: configured => ({ model: configured.model, connectionId: configured.api_connection_id }),
      resolveRuntimeModel: resolver.resolveRuntimeModel,
      bindRouteDecisionToRun: audit.bindRunIdentity,
      activeRuns,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      getCurrentProject: () => project,
      getAgentFull: id => store.agents.get(id),
      PermissionEngine,
      availableToolNames: listBuiltinDefs().map(definition => definition.name),
      projectMutationLock: projectLock,
      timeoutMs
    });
    const productEntry = createProductEntry({ mainAgentService: service, workflowRuntime: workflowRuntimeStub, generatorService: generatorServiceStub });
    const newConversation = (title) => store.conversations.create({ projectId: project.id, agentId: agent.id, title });
    const run = (conversationId, goal, extra = {}) => productEntry.mainAgent.run({
      conversationId, agentId: agent.id, goal, ...extra
    });
    return { project, productEntry, activeRuns, newConversation, run };
  }

  return {
    agent, runManager, projectLock, events, makeEntry, countCalls,
    setProvider: p => { activeProvider = p; },
    locksEmpty: () => projectLock.snapshot().writeLocks.length === 0 && projectLock.snapshot().readLocks.length === 0
  };
}

/** 脚本化 provider：按 decide 次数弹出 action；可按 context 内容分支。 */
function scriptProvider(actions, { onCall } = {}) {
  let calls = 0;
  return {
    streamResponse(input) {
      const call = calls++;
      if (typeof onCall === 'function') onCall({ call, input });
      const action = actions[call] || { type: 'complete', args: { summary: 'script exhausted' } };
      const text = JSON.stringify({ action });
      input.onChunk(text);
      return Promise.resolve({ content: text });
    }
  };
}

test('R8 production matrix: ProductEntry fail→repair→pass on a real dirty git project', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-prod-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-prod-git-'));
  store.init(dataRoot);
  try {
    // --- 真实 Git fixture：baseline commit + tracked/staged/untracked 脏状态 ---
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'fixture');
    fs.writeFileSync(path.join(root, 'src', 'calc.js'),
      'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n', 'utf8');
    fs.writeFileSync(path.join(root, 'test', 'calc.test.js'),
      "'use strict';\nconst { test } = require('node:test');\nconst assert = require('node:assert');\n" +
      "const { add } = require('../src/calc');\n" +
      "test('add works', () => { assert.strictEqual(add(2, 3), 5); });\n", 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), 'original readme\n', 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'baseline');
    // R8-B：用户在 Agent 即将修改的同一文件里留下 marker（tracked dirty）
    fs.appendFileSync(path.join(root, 'src', 'calc.js'), `// ${USER_SAME_FILE_MARKER}\n`, 'utf8');
    fs.appendFileSync(path.join(root, 'src', 'calc.js'), `// ${USER_UNCOMMITTED_MARKER}\n`, 'utf8');
    // staged dirty + untracked
    fs.writeFileSync(path.join(root, 'README.md'), `# project\n${USER_README_MARKER}\n`, 'utf8');
    git(root, 'add', 'README.md');
    fs.writeFileSync(path.join(root, 'notes-user.txt'), `${USER_UNTRACKED_MARKER}\n`, 'utf8');

    const headBefore = git(root, 'rev-parse', 'HEAD');
    const statusBefore = git(root, 'status', '--porcelain=v2');
    const readmeBefore = fs.readFileSync(path.join(root, 'README.md'));
    const notesBefore = fs.readFileSync(path.join(root, 'notes-user.txt'));

    const platform = buildPlatform({ projectRoots: [root] });
    const entry = platform.makeEntry(root, { timeoutMs: 40000 });

    // ProductEntry 静态合同证明（与生产 handlers.js 相同接线）
    const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'handlers.js'), 'utf8');
    assert.ok(/mainAgentIpc\.register\s*\(/.test(ipcSource), 'Main IPC registers the MainAgentService used by ProductEntry');
    assert.ok(/createProductEntry\s*\(\s*\{\s*mainAgentService/.test(ipcSource.replace(/\s+/g, ' ')) || ipcSource.includes('createProductEntry({'),
      'production entry is ProductEntry');

    // 脚本化 fake model：错误修复 → 真实 node --test FAIL → 修复 → PASS → complete
    const WRONG = 'function add(a, b) {\n  return a * b;\n}\nmodule.exports = { add };\n' +
      `// ${USER_SAME_FILE_MARKER}\n// ${USER_UNCOMMITTED_MARKER}\n`;
    const RIGHT = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n' +
      `// ${USER_SAME_FILE_MARKER}\n// ${USER_UNCOMMITTED_MARKER}\n`;
    platform.setProvider(scriptProvider([
      { type: 'read_file', args: { path: 'src/calc.js' } },
      { type: 'write_file', args: { path: 'src/calc.js', content: WRONG } },
      { type: 'run_tests', args: { command: 'node --test' } },
      { type: 'write_file', args: { path: 'src/calc.js', content: RIGHT } },
      { type: 'run_tests', args: { command: 'node --test' } },
      { type: 'complete', args: { summary: 'calc fixed' } }
    ]));

    const conversation = entry.newConversation('R8 fail repair pass');
    const callsBefore = platform.countCalls();
    const started = await entry.run(conversation.id, 'Fix the calc bug so node --test passes; keep user markers.');
    assert.match(started.runId, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(started.runId, conversation.id, 'run identity is not conversation identity');

    const terminal = await waitTerminal(platform.runManager, started.runId, 60000);
    assert.strictEqual(terminal.status, 'completed', `expected completed, got ${terminal.status} (${terminal.error || ''})`);

    // 必需链机器断言：Entry = ProductEntry；真实 FAIL → Repair → 真实 PASS
    const repairs = platform.events.filter(e => e.type === EVENTS.REPAIR_START && e.payload.runId === started.runId);
    assert.ok(repairs.length >= 1, 'repairRounds >= 1');
    const testResults = platform.events.filter(e => e.type === EVENTS.TEST_RESULT && e.payload.runId === started.runId);
    assert.ok(testResults.some(t => t.payload.passed === false), 'real node --test FAIL observed');
    assert.ok(testResults.some(t => t.payload.passed === true), 'real node --test PASS observed');
    const falseIdx = testResults.findIndex(t => t.payload.passed === false);
    const trueIdx = testResults.findIndex(t => t.payload.passed === true);
    assert.ok(falseIdx < trueIdx, 'FAIL before PASS (real repair order)');
    const completedEvent = platform.events.find(e => e.type === EVENTS.RUN_COMPLETED && e.payload.runId === started.runId);
    assert.ok(completedEvent, 'RUN_COMPLETED via Completion Policy');
    assert.strictEqual(completedEvent.payload.verificationStatus, 'PASS');

    // 真实测试在 run 之外独立复验 PASS
    const check = spawnSync('node', ['--test'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    assert.strictEqual(check.status, 0, 'real node --test PASS after the run');

    // R8-A/B：用户状态逐字节保留；同文件 marker 与 bug fix 共存
    const calcAfter = fs.readFileSync(path.join(root, 'src', 'calc.js'), 'utf8');
    assert.ok(calcAfter.includes('return a + b'), 'bug fixed in the same file the user edited');
    assert.ok(calcAfter.includes(USER_SAME_FILE_MARKER), 'USER_SAME_FILE_MARKER_5518 preserved');
    assert.ok(calcAfter.includes(USER_UNCOMMITTED_MARKER), 'USER_UNCOMMITTED_MARKER_4827 preserved');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'README.md')), readmeBefore, 'staged README byte-identical');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, 'notes-user.txt')), notesBefore, 'untracked file byte-identical');
    assert.strictEqual(git(root, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged');
    assert.strictEqual(git(root, 'stash', 'list'), '', 'no automatic stash');
    const statusAfter = git(root, 'status', '--porcelain=v2');
    assert.ok(statusAfter.split('\n').some(l => /^1 M\S? /.test(l) && l.endsWith('README.md')), 'staged state preserved');
    assert.ok(statusAfter.includes('notes-user.txt'), 'untracked preserved');
    assert.strictEqual(statusBefore.split('\n').length, statusAfter.split('\n').length, 'status entry count unchanged');
    assert.ok(platform.countCalls() > callsBefore, 'fake network provider was exercised');
    console.log('RELIABILITY_PRODUCTION entry=ProductEntry failRepairPass=PASS repairRounds=' + repairs.length +
      ' verificationStatus=PASS dirtyMarkers=PRESERVED headUnchanged=YES paidProviderCalls=0');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

test('R8-D stale verification via ProductEntry: completion blocked until fresh verification', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-stale-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-stale-'));
  store.init(dataRoot);
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    const CORRECT = 'function getValue() { return 42; }\nmodule.exports = { getValue };\n';
    const BROKEN = 'function getValue() { return 43; }\nmodule.exports = { getValue };\n';
    fs.writeFileSync(path.join(root, 'src', 'app.js'), BROKEN, 'utf8');
    fs.writeFileSync(path.join(root, 'test', 'check.js'),
      'const { getValue } = require(\'../src/app\');\n' +
      'if (getValue() !== 42) { console.error(\'VALUE_CHECK_FAIL\'); process.exit(1); }\n' +
      'console.log(\'VALUE_CHECK_PASS\');\n', 'utf8');

    const platform = buildPlatform({ projectRoots: [root] });
    const entry = platform.makeEntry(root, { timeoutMs: 40000 });
    platform.setProvider(scriptProvider([
      { type: 'write_file', args: { path: 'src/app.js', content: CORRECT } },   // mutation #1
      { type: 'run_tests', args: { command: 'node test/check.js' } },            // PASS @ seq 1
      { type: 'write_file', args: { path: 'src/app.js', content: BROKEN } },     // mutation #2 → PASS stale
      { type: 'complete', args: { summary: 'done' } },                           // 必须被拒
      { type: 'run_tests', args: { command: 'node test/check.js' } },            // FAIL（真实）
      { type: 'write_file', args: { path: 'src/app.js', content: CORRECT } },   // mutation #3
      { type: 'run_tests', args: { command: 'node test/check.js' } },            // PASS @ seq 3（新鲜）
      { type: 'complete', args: { summary: 'done for real' } }
    ]));

    const conversation = entry.newConversation('R8-D stale verification');
    const started = await entry.run(conversation.id, 'make the value check pass', {
      verification: [{ type: 'command', command: 'node test/check.js', required: true }]
    });
    const terminal = await waitTerminal(platform.runManager, started.runId, 60000);
    assert.strictEqual(terminal.status, 'completed', `got ${terminal.status} (${terminal.error || ''})`);

    const repairs = platform.events.filter(e => e.type === EVENTS.REPAIR_START && e.payload.runId === started.runId);
    assert.ok(repairs.some(e => /验证已过期|verify:freshness|verify-stale/.test(e.payload.reason)),
      'stale completion rejected for freshness: ' + JSON.stringify(repairs.map(e => e.payload.reason)));
    const completedEvent = platform.events.find(e => e.type === EVENTS.RUN_COMPLETED && e.payload.runId === started.runId);
    assert.strictEqual(completedEvent.payload.verificationStatus, 'PASS', 'final verification fresh');
    console.log('R8_D_STALE_VERIFICATION blockedUntilFresh=YES finalStatus=PASS entry=ProductEntry');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

test('R8-E concurrent external edit via ProductEntry: stale write rejected, external marker survives', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-ext-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-ext-'));
  store.init(dataRoot);
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'config.js'), 'module.exports = { version: "A" };\n', 'utf8');

    const platform = buildPlatform({ projectRoots: [root] });
    const entry = platform.makeEntry(root, { timeoutMs: 30000 });
    let calls = 0;
    platform.setProvider({
      streamResponse(input) {
        const call = calls++;
        let action;
        if (call === 0) {
          action = { type: 'read_file', args: { path: 'src/config.js' } };
        } else if (call === 1) {
          // Agent 已读 version A；写前外部进程抢先编辑（真实并发编辑）
          fs.appendFileSync(path.join(root, 'src', 'config.js'), `// ${EXTERNAL_EDIT_MARKER}\n`, 'utf8');
          action = { type: 'write_file', args: { path: 'src/config.js', content: 'module.exports = { version: "B" };\n' } };
        } else {
          action = { type: 'complete', args: { summary: 'done' } };
        }
        const text = JSON.stringify({ action });
        input.onChunk(text);
        return Promise.resolve({ content: text });
      }
    });

    const conversation = entry.newConversation('R8-E external edit');
    const started = await entry.run(conversation.id, 'update config version');
    const terminal = await waitTerminal(platform.runManager, started.runId, 30000);
    assert.ok(['completed', 'failed'].includes(terminal.status), 'run settles honestly: ' + terminal.status);

    const after = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
    assert.ok(after.includes(EXTERNAL_EDIT_MARKER), 'external edit preserved');
    assert.ok(!after.includes('version: "B"'), 'stale content never written');
    const failedTool = platform.events.some(e => e.type === EVENTS.TOOL_RESULT && e.payload.runId === started.runId && e.payload.ok === false);
    assert.ok(failedTool, 'stale write surfaced as a failed tool result (FILE_CHANGED_SINCE_READ)');
    console.log('R8_E_EXTERNAL_EDIT preserved=YES staleWritten=NO entry=ProductEntry');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

test('R8-H cancellation with real child process via ProductEntry leaves nothing behind', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r8h-db-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r8h-'));
  store.init(dataRoot);
  try {
    fs.writeFileSync(path.join(root, 'r8h-late.js'),
      "setTimeout(() => { try { require('fs').writeFileSync('r8h-late-marker.txt', 'LATE'); } catch {} }, 2500);\n", 'utf8');

    const platform = buildPlatform({ projectRoots: [root] });
    const entry = platform.makeEntry(root, { timeoutMs: 30000 });
    platform.setProvider(scriptProvider([
      { type: 'run_command', args: { command: 'node r8h-late.js', timeout_ms: 25000 } },
      { type: 'complete', args: { summary: 'never' } }
    ]));

    const conversation = entry.newConversation('R8-H cancel child');
    const started = await entry.run(conversation.id, 'run the long command');

    const startedEv = await settleTo(() => platform.events.some(e => e.type === 'terminal_start'
      && platform.runManager.getRun(started.runId) && platform.runManager.getRun(started.runId).status === 'executing_tool'), 8000);
    assert.ok(startedEv, 'real terminal child running');
    await new Promise(r => setTimeout(r, 250));

    const stopped = entry.productEntry.mainAgent.stop({ conversationId: conversation.id, runId: started.runId });
    assert.strictEqual(stopped.stopped, true);
    const terminal = await waitTerminal(platform.runManager, started.runId);
    assert.strictEqual(terminal.status, 'cancelled');

    await new Promise(r => setTimeout(r, 3200));
    assert.strictEqual(fs.existsSync(path.join(root, 'r8h-late-marker.txt')), false, 'child process tree killed');
    assert.strictEqual(await settleTo(() => platform.locksEmpty()), true, 'project lock = 0');
    assert.strictEqual(await settleTo(() => entry.activeRuns.size === 0), true, 'activeRuns = 0');
    console.log('R8_H_CANCELLATION treeKilled=YES projectLock=0 entry=ProductEntry');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(root);
  }
});

test('R7 production: same-project contention blocks Run B mutations until the lock frees', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r7a-db-'));
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r7a-A-'));
  store.init(dataRoot);
  try {
    fs.writeFileSync(path.join(rootA, 'hang.js'),
      "setInterval(() => {}, 1000); setTimeout(() => {}, 30000);\n", 'utf8');
    fs.writeFileSync(path.join(rootA, 'note.txt'), 'project A\n', 'utf8');

    const platform = buildPlatform({ projectRoots: [rootA] });
    const entryA = platform.makeEntry(rootA, { timeoutMs: 30000 });

    // --- Run A：真实长命令期间持有 mutation lock ---
    platform.setProvider(scriptProvider([
      { type: 'run_command', args: { command: 'node hang.js', timeout_ms: 25000 } },
      { type: 'complete', args: { summary: 'never' } }
    ]));
    const convA = entryA.newConversation('R7 Run A');
    const runA = await entryA.run(convA.id, 'long mutation work on A');
    const aRunning = await settleTo(() => platform.events.some(e => e.type === 'terminal_start'), 8000);
    assert.ok(aRunning, 'Run A executing a real command while holding the lock');
    await new Promise(r => setTimeout(r, 200));

    // --- R7-E Identity Truth：holder 必须是真实 runId/agentId/canonical projectRoot ---
    const holder = platform.projectLock.getLockHolder(rootA);
    assert.ok(holder, 'project A is locked');
    assert.strictEqual(holder.runId, runA.runId, 'lock holder runId is the real RunManager run id');
    assert.match(holder.runId, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(holder.runId, convA.id, 'conversationId never impersonates runId');
    assert.strictEqual(holder.agentId, platform.agent.id, 'lock holder agentId is the real agent id');
    // canonical projectRoot：同一 root 的不同表示必须共享同一把锁（大小写/归一化不敏感）
    assert.ok(platform.projectLock.isBusy(rootA), 'busy via original notation');
    assert.ok(platform.projectLock.isBusy(path.join(rootA, 'sub', '..')), 'normalized notation shares the lock');
    if (process.platform === 'win32') {
      assert.ok(platform.projectLock.isBusy(rootA.toUpperCase()), 'case-insensitive notation shares the lock');
    }
    assert.ok(String(holder.projectRoot).endsWith(path.basename(rootA).toLowerCase()),
      'canonical projectRoot recorded on the lock: ' + holder.projectRoot);

    // --- R7-A：Run B 同项目 mutation → fail busy，actual mutation exec = 0 ---
    const callsBeforeB = platform.countCalls();
    platform.setProvider(scriptProvider([
      { type: 'create_file', args: { path: 'b-was-here.txt', content: 'RUN_B_MUTATION\n' } },
      { type: 'complete', args: { summary: 'b done' } }
    ]));
    const convB = entryA.newConversation('R7 Run B');
    const runB = await entryA.run(convB.id, 'mutate the same project');
    const terminalB = await waitTerminal(platform.runManager, runB.runId, 10000);
    assert.strictEqual(terminalB.status, 'failed', 'Run B fails busy while A holds the lock');
    assert.ok(/PROJECT_LOCKED/.test(terminalB.error || ''), 'honest PROJECT_LOCKED reason: ' + terminalB.error);
    const failedB = platform.events.find(e => e.type === EVENTS.RUN_FAILED && e.payload.runId === runB.runId);
    assert.ok(failedB && failedB.payload.errorCode === 'PROJECT_LOCKED');
    assert.strictEqual(fs.existsSync(path.join(rootA, 'b-was-here.txt')), false, 'Run B actual mutation exec = 0');
    assert.strictEqual(platform.countCalls(), callsBeforeB, 'Run B never reached the model (zero provider calls)');
    assert.ok(!platform.events.some(e => e.type === EVENTS.FILE_CHANGED && e.payload.runId === runB.runId),
      'sameProjectInterleavedWrites = 0');

    // --- R7-B：cancel 持锁者 → 锁清零 → Run C 正常 mutation ---
    const stoppedA = entryA.productEntry.mainAgent.stop({ conversationId: convA.id, runId: runA.runId });
    assert.strictEqual(stoppedA.stopped, true, 'Run A stop reached the real AbortController');
    const terminalA = await waitTerminal(platform.runManager, runA.runId);
    assert.strictEqual(terminalA.status, 'cancelled');
    assert.strictEqual(await settleTo(() => platform.locksEmpty()), true, 'lock after cancel = 0');

    platform.setProvider(scriptProvider([
      { type: 'create_file', args: { path: 'c-done.txt', content: 'RUN_C_MUTATION\n' } },
      { type: 'complete', args: { summary: 'c done' } }
    ]));
    const convC = entryA.newConversation('R7 Run C');
    const runC = await entryA.run(convC.id, 'mutate after lock freed');
    const terminalC = await waitTerminal(platform.runManager, runC.runId, 20000);
    assert.strictEqual(terminalC.status, 'completed', `Run C completes after release, got ${terminalC.status} (${terminalC.error || ''})`);
    assert.strictEqual(fs.readFileSync(path.join(rootA, 'c-done.txt'), 'utf8'), 'RUN_C_MUTATION\n');
    assert.strictEqual(await settleTo(() => platform.locksEmpty()), true, 'lock after completion = 0');
    console.log('R7_PRODUCTION_ABE runBMutationExec=0 interleavedWrites=0 lockAfterCancel=0 lockAfterCompletion=0 identityTruth=PASS');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(rootA);
  }
});

test('R7 production: failure releases the lock; different projects never falsely contend', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r7c-db-'));
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r7c-A-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-r7c-B-'));
  store.init(dataRoot);
  try {
    fs.writeFileSync(path.join(rootA, 'hang.js'), "setInterval(() => {}, 1000);\n", 'utf8');
    fs.writeFileSync(path.join(rootA, 'note.txt'), 'project A\n', 'utf8');
    fs.writeFileSync(path.join(rootB, 'note.txt'), 'project B\n', 'utf8');

    const platform = buildPlatform({ projectRoots: [rootA, rootB] });
    const entryA = platform.makeEntry(rootA, { timeoutMs: 30000 });
    const entryB = platform.makeEntry(rootB, { timeoutMs: 30000 });

    // --- R7-C：真实故障路径（permission deny → FATAL）释放锁 ---
    platform.setProvider(scriptProvider([
      { type: 'delete_file', args: { path: 'note.txt' } },
      { type: 'complete', args: { summary: 'never' } }
    ]));
    const convD = entryA.newConversation('R7 Run D fail');
    const runD = await entryA.run(convD.id, 'a run that fails on permission');
    const terminalD = await waitTerminal(platform.runManager, runD.runId, 15000);
    assert.strictEqual(terminalD.status, 'failed', 'Run D fails via a real failure path');
    assert.ok(fs.existsSync(path.join(rootA, 'note.txt')), 'denied delete never executed');
    assert.strictEqual(await settleTo(() => platform.locksEmpty()), true, 'lock after failure = 0');

    // --- R7-D：A 持锁期间，B 的 mutation Run 不受牵连（false contention = NO）---
    platform.setProvider(scriptProvider([
      { type: 'run_command', args: { command: 'node hang.js', timeout_ms: 25000 } },
      { type: 'complete', args: { summary: 'never' } }
    ]));
    const convA3 = entryA.newConversation('R7 Run A3 holder');
    const runA3 = await entryA.run(convA3.id, 'hold the lock on A');
    assert.ok(await settleTo(() => platform.events.some(e => e.type === 'terminal_start'), 8000), 'A3 command running');
    await new Promise(r => setTimeout(r, 200));
    assert.ok(platform.projectLock.getLockHolder(rootA), 'A locked by A3');
    assert.strictEqual(platform.projectLock.getLockHolder(rootB), null, 'B not locked');

    platform.setProvider(scriptProvider([
      { type: 'create_file', args: { path: 'e-done.txt', content: 'RUN_E_MUTATION\n' } },
      { type: 'complete', args: { summary: 'e done' } }
    ]));
    const convE = entryB.newConversation('R7 Run E other project');
    const runE = await entryB.run(convE.id, 'mutate project B while A is locked');
    const terminalE = await waitTerminal(platform.runManager, runE.runId, 20000);
    assert.strictEqual(terminalE.status, 'completed',
      `different project must not contend, got ${terminalE.status} (${terminalE.error || ''})`);
    assert.strictEqual(fs.readFileSync(path.join(rootB, 'e-done.txt'), 'utf8'), 'RUN_E_MUTATION\n');

    // 收尾：取消 A3，全部锁清零
    const stoppedA3 = entryA.productEntry.mainAgent.stop({ conversationId: convA3.id, runId: runA3.runId });
    assert.strictEqual(stoppedA3.stopped, true, 'A3 stop reached the real AbortController');
    const terminalA3 = await waitTerminal(platform.runManager, runA3.runId);
    assert.strictEqual(terminalA3.status, 'cancelled', 'holder run cancels cleanly');
    assert.strictEqual(await settleTo(() => platform.locksEmpty()), true, 'all locks released');
    console.log('R7_PRODUCTION_CD lockAfterFailure=0 falseContention=NO differentProjectsParallel=YES');
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    await cleanupDir(dataRoot);
    await cleanupDir(rootA);
    await cleanupDir(rootB);
  }
});
