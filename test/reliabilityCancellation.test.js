'use strict';
/**
 * v2.9.8 Real Project Reliability — R6.
 *
 * Cancellation Reliability & No Terminal Revival:
 *  - 真实长命令执行期间取消 → run cancelled、进程树被杀（迟到副作用文件不出现）
 *  - Terminal means terminal：取消后的迟到 completed 不得复活终态
 *  - 模型请求挂起期间取消 → 有界时间内 cancelled
 *  - 资源清零：activeRuns（AbortController 登记）清空
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

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-cancel-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function waitForStatus(runManager, runId, statuses, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const run = runManager.getRun(runId);
      if (run && statuses.includes(run.status)) { clearInterval(timer); resolve(run); return; }
      if (Date.now() > deadline) { clearInterval(timer); resolve(runManager.getRun(runId)); }
    }, 15);
  });
}

function baseDeps(root, extra = {}) {
  const pe = new PermissionEngine({ projectId: 'rpr-cancel' });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });
  return {
    conversationId: 'rpr-cancel-' + Math.random().toString(36).slice(2),
    agentId: 'native-main',
    goal: 'cancel reliability',
    projectRoot: root, projectId: 'rpr-cancel',
    getTool: getBuiltin, store: null, emit: () => {},
    runManager: new RunManager(),
    permissionEngine: pe,
    requestPermission: async () => ({ decision: 'deny', range: 'once' }),
    timeoutMs: 20000,
    ...extra
  };
}

test('R6 cancel during real long-running terminal command: killed tree, no late effect, no revival', async () => {
  const root = makeProject({
    'note.txt': 'fixture\n',
    // 2.5 秒后才写文件的“迟到副作用”进程——取消后它绝不能出现
    'slow-marker.js': "setTimeout(() => { try { require('fs').writeFileSync('late-marker.txt', 'LATE'); } catch {} }, 2500);\n"
  });
  try {
    const deps = baseDeps(root);
    const activeRuns = new Map();
    const events = [];
    deps.emit = (type, payload) => { events.push({ type, payload }); };

    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([
        { type: 'run_command', args: { command: 'node slow-marker.js', timeout_ms: 15000 } },
        { type: 'complete', args: { summary: 'should never get here' } }
      ]),
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    // 等待真实终端命令启动（terminal_start 事件来自真实 terminal 工具）
    const startDeadline = Date.now() + 5000;
    while (!events.some(e => e.type === 'terminal_start') && Date.now() < startDeadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(events.some(e => e.type === 'terminal_start'), 'real terminal command started');
    await new Promise(r => setTimeout(r, 250));

    // 用户取消（与 mainAgent:stop 相同语义：abort + RunManager 终态门）
    const tCancel = Date.now();
    const ac = activeRuns.get(deps.conversationId);
    assert.ok(ac, 'AbortController registered');
    ac.abort();
    deps.runManager.cancelByConversation(deps.conversationId);

    const terminal = await waitForStatus(deps.runManager, runId, ['cancelled', 'completed', 'failed', 'timeout']);
    assert.strictEqual(terminal.status, 'cancelled', `cancel must win, got ${terminal.status}`);
    assert.ok(Date.now() - tCancel < 5000, 'cancel settles in bounded time');

    // Terminal means terminal：迟到的 completed 不得复活
    const revive = deps.runManager.finishRun(runId, 'completed', { source: 'lateResult' });
    assert.strictEqual(revive.status, 'cancelled', 'late completed must not revive a cancelled run');
    assert.strictEqual(deps.runManager.getRun(runId).status, 'cancelled');
    assert.notStrictEqual(terminal.terminalSource, 'lateResult');

    // 进程树必须被杀：等待超过迟到副作用的触发时间，文件绝不能出现
    await new Promise(r => setTimeout(r, 3200));
    assert.strictEqual(fs.existsSync(path.join(root, 'late-marker.txt')), false,
      'process tree killed: late side-effect file must never appear');

    // 资源清零
    assert.strictEqual(activeRuns.size, 0, 'AbortController registry cleaned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R6 cancel during hanging model request settles cancelled in bounded time', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const deps = baseDeps(root);
    const activeRuns = new Map();
    // 挂起 provider：只有 signal abort 才 settle（真实 ProviderModelAdapter 之下的行为）
    const hangingProvider = {
      streamResponse(input) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ content: '{}' }), 10000);
          if (input.signal) {
            input.signal.addEventListener('abort', () => {
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
      buildProvider: async () => hangingProvider,
      agent: { model: 'hang-model' },
      resolveModel: () => ({ model: 'hang-model' })
    });

    const { runId } = runMainAgent({
      ...deps,
      model,
      registerAbort: (convId, ac) => activeRuns.set(convId || runId, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || runId)
    });

    await new Promise(r => setTimeout(r, 300)); // 让模型请求真正挂起
    const ac = activeRuns.get(deps.conversationId);
    assert.ok(ac);
    const tCancel = Date.now();
    ac.abort();
    deps.runManager.cancelByConversation(deps.conversationId);

    const terminal = await waitForStatus(deps.runManager, runId, ['cancelled', 'completed', 'failed', 'timeout']);
    assert.strictEqual(terminal.status, 'cancelled');
    assert.ok(Date.now() - tCancel < 5000, 'hanging model request cancels in bounded time');
    assert.strictEqual(activeRuns.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
