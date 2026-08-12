'use strict';
/**
 * v2.9.8 Real Project Reliability — R7.
 *
 * Bounded Long-Task Execution（No unbounded retry / No infinite run）:
 *  - run 总超时 → 诚实 'timeout'（不是挂起、不是假完成）
 *  - 迭代上限 / 工具调用上限 → 诚实 FAILED（AGENT_LOOP_LIMIT / AGENT_TOOL_LIMIT）
 *  - 终端命令超时 → TERMINAL_TIMEOUT、进程树被杀、Agent 存活并可继续
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
const { createLimits } = require('../src/agent/runtime/retryPolicy');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-limits-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** Windows 文件句柄释放有延迟，清理需重试（否则 ENOTEMPTY/EBUSY 假失败）。 */
async function cleanupProject(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch { /* retry after short wait */ }
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

function baseDeps(root, extra = {}) {
  const events = [];
  const pe = new PermissionEngine({ projectId: 'rpr-limits' });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });
  return {
    deps: {
      conversationId: 'rpr-limits-' + Math.random().toString(36).slice(2),
      agentId: 'native-main',
      goal: 'bounded execution',
      projectRoot: root, projectId: 'rpr-limits',
      getTool: getBuiltin, store: null,
      emit: (type, payload) => { events.push({ type, payload }); },
      runManager: new RunManager(),
      permissionEngine: pe,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      ...extra
    },
    events
  };
}

test('R7 run timeout: long task ends in honest timeout, not hang or fake success', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps, events } = baseDeps(root, {
      timeoutMs: 1000,
      // 只让 run 总超时生效：迭代/工具上限放到足够大
      limits: createLimits({ maxRuntimeMs: 1000, maxIterations: 100000, maxToolCalls: 100000 })
    });
    const t0 = Date.now();
    const reads = Array.from({ length: 500 }, () => ({ type: 'read_file', args: { path: 'note.txt' } }));
    const { runId } = runMainAgent({ ...deps, model: createFakeCodingModel(reads) });

    const terminal = await waitForTerminal(deps.runManager, runId, 10000);
    assert.strictEqual(terminal.status, 'timeout', `expected timeout, got ${terminal.status}`);
    assert.ok(Date.now() - t0 < 8000, 'timeout is bounded (no hang)');
    assert.strictEqual(terminal.terminalSource, 'mainAgentTimeout');
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false, 'no fake completion');
    // 给后台 loop 结算/退出的有界时间（超时 abort 后应当立即收尾）
    await new Promise(r => setTimeout(r, 500));
  } finally {
    await cleanupProject(root);
  }
});

test('R7 iteration bound: infinite non-completing model fails honestly (AGENT_LOOP_LIMIT)', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps, events } = baseDeps(root, {
      timeoutMs: 60000,
      limits: createLimits({ maxIterations: 3, maxRuntimeMs: 60000 })
    });
    const reads = Array.from({ length: 20 }, () => ({ type: 'read_file', args: { path: 'note.txt' } }));
    const { runId } = runMainAgent({ ...deps, model: createFakeCodingModel(reads) });

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'failed');
    assert.notStrictEqual(terminal.status, 'completed');
    assert.ok(/迭代|AGENT_LOOP_LIMIT/.test(terminal.error || ''), `honest limit error, got: ${terminal.error}`);
    const failedEvent = events.find(e => e.type === EVENTS.RUN_FAILED);
    assert.ok(failedEvent, 'RUN_FAILED emitted');
    assert.strictEqual(failedEvent.payload.errorCode, 'AGENT_LOOP_LIMIT');
  } finally {
    await cleanupProject(root);
  }
});

test('R7 tool-call bound: excessive tool usage fails honestly (AGENT_TOOL_LIMIT)', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps, events } = baseDeps(root, {
      timeoutMs: 60000,
      limits: createLimits({ maxToolCalls: 2, maxRuntimeMs: 60000 })
    });
    const reads = Array.from({ length: 20 }, () => ({ type: 'read_file', args: { path: 'note.txt' } }));
    const { runId } = runMainAgent({ ...deps, model: createFakeCodingModel(reads) });

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'failed');
    assert.ok(/工具调用|AGENT_TOOL_LIMIT/.test(terminal.error || ''), `honest limit error, got: ${terminal.error}`);
    const failedEvent = events.find(e => e.type === EVENTS.RUN_FAILED);
    assert.strictEqual(failedEvent.payload.errorCode, 'AGENT_TOOL_LIMIT');
  } finally {
    await cleanupProject(root);
  }
});

test('R7 terminal command timeout: process tree killed, agent survives and continues', async () => {
  const root = makeProject({
    // 1.5 秒后才写文件的进程；命令 400ms 超时 → 它绝不能留下副作用
    'timeout-marker.js': "setTimeout(() => { try { require('fs').writeFileSync('tmo-marker.txt', 'TMO'); } catch {} }, 1500);\n"
  });
  try {
    const { deps, events } = baseDeps(root, { timeoutMs: 20000 });
    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([
        { type: 'run_command', args: { command: 'node timeout-marker.js', timeout_ms: 400 } },
        { type: 'complete', args: { summary: 'survived command timeout' } }
      ])
    });

    const terminal = await waitForTerminal(deps.runManager, runId);
    assert.strictEqual(terminal.status, 'completed', 'agent survives a timed-out command');

    // 超时命令的 Tool Result 必须是失败（TERMINAL_TIMEOUT），不得假成功
    const toolResults = events.filter(e => e.type === EVENTS.TOOL_RESULT);
    assert.ok(toolResults.some(e => e.payload.ok === false), 'timed-out command reported as failed tool result');

    // 进程树被杀：等待超过副作用触发时间，文件绝不能出现
    await new Promise(r => setTimeout(r, 2000));
    assert.strictEqual(fs.existsSync(path.join(root, 'tmo-marker.txt')), false,
      'timed-out process tree killed: no late side effect');
  } finally {
    await cleanupProject(root);
  }
});
