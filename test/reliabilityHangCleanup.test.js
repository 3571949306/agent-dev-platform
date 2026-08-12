'use strict';
/**
 * v2.9.8 Real Project Reliability — R6 Hang / Cancel / Cleanup。
 *
 * 真实链：MainAgentService（ProductEntry 背后的应用服务）→ RunManager →
 * ProviderModelAdapter → 真实 Terminal Tool。fake 的只有网络 provider。
 *
 *  - R6-A  Model Hang：provider 永不 settle → configured timeout 真兑现 →
 *          Run terminal = timeout；activeRuns=0；迟到结果不得复活。
 *  - R6-D  Cancel During Model：AbortSignal fired、provider 收到 abort、
 *          Main=cancelled、cancel 后 provider calls=0、迟到完成被忽略。
 *  - R6-E  Cancel During Tool：真实 terminal 进程被杀（owned child=0，
 *          迟到副作用文件绝不出现），Main=cancelled。
 *  - R6-G  Cancel During Verification：verification 命令挂起时取消 →
 *          验证进程被终止、Run cancelled、Completion Policy 绝不完成它。
 *
 * 每个场景终止后执行 R6 FINAL RESOURCE ASSERTION。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { getBuiltin } = require('../src/tools/registry');
const { terminalManager } = require('../src/tools/terminal');
const { _activeCount: orchestratorActiveCount } = require('../src/agent/orchestrator/mainAgentOrchestrator');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-hang-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

async function cleanupProject(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch { /* Windows 文件句柄释放有延迟，重试 */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

function waitForTerminal(runManager, runId, timeoutMs = 15000) {
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

/** 让后台 loop 完成收尾（finally 资源释放）的有界等待。 */
async function settle(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return predicate();
}

function baseDeps(root, extra = {}) {
  const events = [];
  const pe = new PermissionEngine({ projectId: 'rpr-hang' });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });
  return {
    deps: {
      conversationId: 'rpr-hang-' + Math.random().toString(36).slice(2),
      agentId: 'native-main',
      goal: 'hang cancel cleanup',
      projectRoot: root, projectId: 'rpr-hang',
      getTool: getBuiltin, store: null,
      emit: (type, payload) => { events.push({ type, payload }); },
      runManager: new RunManager(),
      permissionEngine: pe,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      projectMutationLock: createProjectMutationLock(),
      timeoutMs: 20000,
      ...extra
    },
    events
  };
}

/** R6 FINAL RESOURCE ASSERTION — 每种终止方式之后必须全部清零。 */
async function assertResourcesZero(ctx, { activeRuns, projectLock }) {
  terminalManager.pruneTerminal();
  assert.strictEqual(await settle(() => activeRuns.size === 0), true, 'activeRuns = 0');
  assert.strictEqual(orchestratorActiveCount(), 0, 'orchestrator registry = 0 (Dynamic instances disposed)');
  const snap = projectLock.snapshot();
  assert.deepStrictEqual(snap, { writeLocks: [], readLocks: [] }, 'Project locks = 0');
  assert.strictEqual(terminalManager.activeCount(), 0, 'owned child processes = 0');
  assert.strictEqual(ctx.pendingApprovals, 0, 'pending approvals = 0');
  assert.strictEqual(ctx.retryTimers, 0, 'retry timers = 0');
  assert.strictEqual(ctx.lateProviderCallsAfterTerminal, 0, 'late provider calls after terminal = 0');
}

test('R6-A model hang: configured timeout settles honest timeout, nothing left behind', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  const ctx = { pendingApprovals: 0, retryTimers: 0, lateProviderCallsAfterTerminal: 0 };
  try {
    const { deps, events } = baseDeps(root, { timeoutMs: 30000 });
    const activeRuns = new Map();
    let providerCalls = 0;
    // fake network provider：永不 resolve，也不理会 abort（最恶劣的挂死）
    const hangingProvider = {
      streamResponse() {
        providerCalls++;
        return new Promise(() => { /* never settles */ });
      }
    };
    // configured timeout = adapter 层 800ms（真实生产合同：ProviderModelAdapter.timeoutMs）
    const model = createProviderModelAdapter({
      buildProvider: async () => hangingProvider,
      agent: { model: 'hang-model' },
      resolveModel: () => ({ model: 'hang-model' }),
      timeoutMs: 800
    });

    const t0 = Date.now();
    const { runId } = runMainAgent({
      ...deps,
      model,
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    const terminal = await waitForTerminal(deps.runManager, runId, 15000);
    assert.strictEqual(terminal.status, 'timeout', `configured timeout must win, got ${terminal.status}`);
    assert.ok(Date.now() - t0 < 10000, 'timeout settles in bounded time');
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false, 'no fake completion');

    // 终态后 provider 不再被调用（无重试、无续命）
    const callsAtTerminal = providerCalls;
    const revived = deps.runManager.finishRun(runId, 'completed', { source: 'lateResult' });
    assert.strictEqual(revived.status, 'timeout', 'late result revival = 0 (terminal is terminal)');
    await new Promise(r => setTimeout(r, 1200));
    ctx.lateProviderCallsAfterTerminal = providerCalls - callsAtTerminal;

    await assertResourcesZero(ctx, { activeRuns, projectLock: deps.projectMutationLock });
    console.log('R6_A_MODEL_HANG status=timeout providerCalls=' + providerCalls + ' revival=IGNORED resources=ZERO');
  } finally {
    await cleanupProject(root);
  }
});

test('R6-D cancel during model: abort reaches provider, zero later calls, late completion ignored', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  const ctx = { pendingApprovals: 0, retryTimers: 0, lateProviderCallsAfterTerminal: 0 };
  try {
    const { deps, events } = baseDeps(root, { timeoutMs: 30000 });
    const activeRuns = new Map();
    let providerCalls = 0;
    let abortObserved = 0;
    let lateResolves = 0;
    const slowProvider = {
      streamResponse(input) {
        providerCalls++;
        return new Promise((resolve, reject) => {
          // 10 秒后才结算的“迟到完成”——cancel 之后它绝不能生效
          const timer = setTimeout(() => {
            lateResolves++;
            resolve({ content: JSON.stringify({ action: { type: 'complete', args: { summary: 'late completion' } } }) });
          }, 10000);
          if (timer.unref) timer.unref();
          if (input.signal) {
            input.signal.addEventListener('abort', () => {
              abortObserved++;
              clearTimeout(timer);
              const e = new Error('aborted');
              e.name = 'AbortError';
              e.aborted = true;
              reject(e);
            }, { once: true });
          }
        });
      }
    };
    const model = createProviderModelAdapter({
      buildProvider: async () => slowProvider,
      agent: { model: 'slow-model' },
      resolveModel: () => ({ model: 'slow-model' }),
      timeoutMs: 20000
    });

    const { runId } = runMainAgent({
      ...deps,
      model,
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    await new Promise(r => setTimeout(r, 300)); // 让模型请求真正发出
    assert.ok(providerCalls >= 1, 'provider request active');
    const ac = activeRuns.get(deps.conversationId);
    assert.ok(ac, 'AbortController registered');
    const tCancel = Date.now();
    ac.abort();
    deps.runManager.cancelByConversation(deps.conversationId);

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'cancelled');
    assert.ok(Date.now() - tCancel < 5000, 'cancel settles in bounded time');
    assert.ok(abortObserved >= 1, 'AbortSignal fired and provider received abort');

    const callsAtCancel = providerCalls;
    const revived = deps.runManager.finishRun(runId, 'completed', { source: 'lateCompletion' });
    assert.strictEqual(revived.status, 'cancelled', 'late completion ignored');
    await new Promise(r => setTimeout(r, 800));
    ctx.lateProviderCallsAfterTerminal = providerCalls - callsAtCancel;
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false, 'no completion event after cancel');

    await assertResourcesZero(ctx, { activeRuns, projectLock: deps.projectMutationLock });
    console.log('R6_D_CANCEL_DURING_MODEL abortObserved=' + abortObserved + ' laterProviderCalls=0 lateResolvesSettled=' + lateResolves + ' resources=ZERO');
  } finally {
    await cleanupProject(root);
  }
});

test('R6-E cancel during tool: real process tree killed, owned children zero', async () => {
  const root = makeProject({
    'note.txt': 'fixture\n',
    'late-effect.js': "setTimeout(() => { try { require('fs').writeFileSync('r6e-late-marker.txt', 'LATE'); } catch {} }, 2500);\n"
  });
  const ctx = { pendingApprovals: 0, retryTimers: 0, lateProviderCallsAfterTerminal: 0 };
  try {
    const { deps, events } = baseDeps(root, { timeoutMs: 30000 });
    const activeRuns = new Map();
    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([
        { type: 'run_command', args: { command: 'node late-effect.js', timeout_ms: 20000 } },
        { type: 'complete', args: { summary: 'should never get here' } }
      ]),
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    const startDeadline = Date.now() + 5000;
    while (!events.some(e => e.type === 'terminal_start') && Date.now() < startDeadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(events.some(e => e.type === 'terminal_start'), 'real terminal child started');
    await new Promise(r => setTimeout(r, 250));
    assert.ok(terminalManager.activeCount() >= 1, 'owned child process alive while command runs');

    const ac = activeRuns.get(deps.conversationId);
    assert.ok(ac);
    ac.abort();
    deps.runManager.cancelByConversation(deps.conversationId);

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'cancelled');

    // 进程树必须被杀：等过迟到副作用触发点，文件绝不能出现
    await new Promise(r => setTimeout(r, 3200));
    assert.strictEqual(fs.existsSync(path.join(root, 'r6e-late-marker.txt')), false,
      'process tree killed: late side-effect never appears');
    await assertResourcesZero(ctx, { activeRuns, projectLock: deps.projectMutationLock });
    console.log('R6_E_CANCEL_DURING_TOOL treeKilled=YES ownedChildren=0 resources=ZERO');
  } finally {
    await cleanupProject(root);
  }
});

test('R6-G cancel during verification: verification process terminated, Completion Policy never completes it', async () => {
  const root = makeProject({
    'note.txt': 'fixture\n',
    // 挂起的 verification 命令：2.5 秒后写迟到标记（取消后绝不能出现）
    'hang-verify.js': "setTimeout(() => { try { require('fs').writeFileSync('r6g-late-marker.txt', 'LATE'); } catch {} }, 2500);\n"
  });
  const ctx = { pendingApprovals: 0, retryTimers: 0, lateProviderCallsAfterTerminal: 0 };
  try {
    const { deps, events } = baseDeps(root, {
      timeoutMs: 30000,
      verification: [{ type: 'command', command: 'node hang-verify.js', required: true }]
    });
    const activeRuns = new Map();
    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([
        { type: 'complete', args: { summary: 'done, run my verification' } },
        { type: 'complete', args: { summary: 'still trying' } }
      ]),
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    // 等待 required verification 真正启动（真实 terminal 进程）
    const startDeadline = Date.now() + 8000;
    while (!events.some(e => e.type === 'terminal_start') && Date.now() < startDeadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(events.some(e => e.type === 'terminal_start'), 'verification command started');
    await new Promise(r => setTimeout(r, 250));

    const ac = activeRuns.get(deps.conversationId);
    assert.ok(ac, 'AbortController registered during verification');
    ac.abort();
    deps.runManager.cancelByConversation(deps.conversationId);

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'cancelled', `Run cancelled, got ${terminal.status}`);
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false,
      'Completion Policy never completes a cancelled run');

    await new Promise(r => setTimeout(r, 3200));
    assert.strictEqual(fs.existsSync(path.join(root, 'r6g-late-marker.txt')), false,
      'verification process terminated: no late side effect');
    await assertResourcesZero(ctx, { activeRuns, projectLock: deps.projectMutationLock });
    console.log('R6_G_CANCEL_DURING_VERIFICATION verificationKilled=YES completionPolicy=NEVER resources=ZERO');
  } finally {
    await cleanupProject(root);
  }
});
