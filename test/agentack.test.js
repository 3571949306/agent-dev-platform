'use strict';
/**
 * v2.3.2 — P0-1 ACK 语义自动测试。
 *
 * 验证 `agent:send` IPC handler 的核心契约：
 *   1. **立即 ACK**：handler 必须在远低于 runChatTurn 完成时间(< 200ms)内
 *      返回 `{ accepted: true, runId, conversationId, status: 'preparing' }`，
 *      而不是等待 Agent Run 完成。
 *   2. **后台独立执行**：runChatTurn 在后台异步运行，所有状态通过 agent:event
 *      推送；Promise resolve ≠ 业务成功。
 *   3. **完整收口**：后台异常 / 取消 / 超时都经 runManager.finishRun() 进入唯一
 *      终态，绝不产生 UnhandledPromiseRejection。
 *   4. **延迟终态事件**：runChatTurn 完成后才发出 run_completed / run_failed 等
 *      终态事件（通过 mock window.webContents.send 验证）。
 *
 * 实现方式：mock electron 模块（捕获 ipcMain.handle 注册的 handler）+ 真实 store
 * （临时 userData + seed）+ 真实 RunManager + mock extAgents.runExternalAgent
 * （人为延迟 5s 模拟慢任务）。runChatTurn 走 external 分支，5s 后才返回结果。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ---- 1. mock electron 模块（必须在 require handlers.js 之前注入）----
const ipcHandlers = new Map();
const sentEvents = [];
const electronMock = {
  ipcMain: {
    handle(channel, fn) { ipcHandlers.set(channel, fn); },
    removeHandler(channel) { ipcHandlers.delete(channel); }
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  shell: { showItemInFolder: () => {}, openExternal: () => {} },
  app: {
    getVersion: () => '2.3.2-test',
    getPath: (name) => name === 'userData' ? (electronMock.app._userData || os.tmpdir()) : os.tmpdir(),
    _userData: null
  }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

// ---- 2. 加载被测模块 ----
const store = require('../src/db/store');
const { seedDefaults } = require('../src/db/seed');
const extAgents = require('../src/services/externalAgents');
const handlers = require('../src/ipc/handlers');

// mock window：收集所有 webContents.send 事件
function makeMockWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) { sentEvents.push({ channel, payload }); }
    }
  };
}

let tmpDir = null;
let mockWindow = null;

function setupEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-ack-'));
  electronMock.app._userData = tmpDir;
  store.init(tmpDir);
  if (!store.settings.get('_initialized')) {
    seedDefaults(store);
    store.settings.set('_initialized', true);
  }
  mockWindow = makeMockWindow();
  sentEvents.length = 0;
  ipcHandlers.clear();
  handlers.register(mockWindow);
}

function teardownEnv() {
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  tmpDir = null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

test('P0-1 ACK：agent:send 立即返回 runId，不等 runChatTurn 完成', async () => {
  setupEnv();
  try {
    // 准备一个 external agent + project + conversation
    const proj = store.projects.create({ name: 'ACK 测试项目', rootPath: tmpDir });
    const ext = store.externalAgents.create({
      name: '慢外部智能体', description: '测试用', adapter_type: 'workbuddy', config: {}
    });
    const conv = store.conversations.create({ projectId: proj.id, agentId: ext.id, title: 'ACK 测试' });

    // mock extAgents.runExternalAgent：5 秒后才完成
    const originalRun = extAgents.runExternalAgent;
    let backgroundStarted = false;
    let backgroundResolved = false;
    extAgents.runExternalAgent = async (_adapter, _task, _ctx) => {
      backgroundStarted = true;
      await delay(5000);
      backgroundResolved = true;
      return JSON.stringify({ status: 'completed', summary: 'WORKBUDDY_BRIDGE_OK', findings: [], changedFiles: [], artifacts: [], errors: [] });
    };

    const sendHandler = ipcHandlers.get('agent:send');
    assert.ok(sendHandler, 'agent:send handler 应已注册');

    // 调用 handler，测量返回时间
    const t0 = Date.now();
    const ack = await sendHandler({}, { conversationId: conv.id, agentId: ext.id, message: '测试 ACK' });
    const ackLatency = Date.now() - t0;

    // 1. 立即 ACK：远低于 5s（CI 性能放宽到 1s）
    assert.ok(ack && ack.accepted === true, 'ACK 必须含 accepted:true');
    assert.ok(ack.runId, 'ACK 必须含 runId');
    assert.strictEqual(ack.conversationId, conv.id);
    assert.strictEqual(ack.status, 'preparing');
    assert.ok(ackLatency < 1000, `ACK 必须立即返回（实测 ${ackLatency}ms，应 < 1000ms，远低于 5s 任务）`);

    // 2. 后台已启动但未完成
    assert.ok(backgroundStarted, '后台 runChatTurn 应已启动');
    assert.ok(!backgroundResolved, '5s 任务在 ACK 时不应已完成');

    // 3. RunManager 当前状态为非终态
    const runBefore = handlers.runManager.getRun(ack.runId);
    assert.ok(runBefore, 'RunManager 应有此 Run');
    assert.ok(!['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(runBefore.status),
      `ACK 后 Run 应处于非终态，实际 ${runBefore.status}`);

    // 4. 等待后台完成（5s 任务 + 余量）
    await delay(6000);
    assert.ok(backgroundResolved, '后台任务最终应完成');

    // 5. Run 终态正确：completed
    const runAfter = handlers.runManager.getRun(ack.runId);
    assert.strictEqual(runAfter.status, 'completed', 'Run 最终应为 completed');

    // 6. 终态事件已通过 webContents.send 推送
    const termEvents = sentEvents
      .filter(e => e.channel === 'agent:event')
      .map(e => e.payload && e.payload.type)
      .filter(t => ['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(t));
    assert.ok(termEvents.includes('run_completed'), '应发出 run_completed 事件');

    // 还原
    extAgents.runExternalAgent = originalRun;
  } finally {
    teardownEnv();
  }
});

test('P0-1 收口：后台异常也经 finishRun 进入 failed 终态，不产生 UnhandledPromiseRejection', async () => {
  setupEnv();
  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandled);
  try {
    const proj = store.projects.create({ name: 'ACK 异常项目', rootPath: tmpDir });
    const ext = store.externalAgents.create({
      name: '抛错外部智能体', description: '测试用', adapter_type: 'workbuddy', config: {}
    });
    const conv = store.conversations.create({ projectId: proj.id, agentId: ext.id, title: 'ACK 异常测试' });

    // mock：抛同步异常 + 异步抛异常两种路径
    const originalRun = extAgents.runExternalAgent;
    extAgents.runExternalAgent = async () => {
      await delay(50);
      throw new Error('模拟外部智能体崩溃');
    };

    const sendHandler = ipcHandlers.get('agent:send');
    const t0 = Date.now();
    const ack = await sendHandler({}, { conversationId: conv.id, agentId: ext.id, message: '触发异常' });
    const ackLatency = Date.now() - t0;
    assert.ok(ack.accepted && ack.runId, '即使后台将抛错，ACK 也必须立即返回');
    assert.ok(ackLatency < 1000, `异常路径 ACK 也应立即返回（${ackLatency}ms）`);

    // 等待后台异常被 catch 并 finishRun
    await delay(500);

    const run = handlers.runManager.getRun(ack.runId);
    assert.strictEqual(run.status, 'failed', '异常应被收口为 failed 终态');
    assert.ok(run.error && run.error.includes('模拟外部智能体崩溃'), 'error 应记录异常信息');

    // 验证无未处理 Promise 拒绝
    assert.strictEqual(unhandled, null, '后台异常不得产生 UnhandledPromiseRejection');

    extAgents.runExternalAgent = originalRun;
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    teardownEnv();
  }
});

test('P0-1 单 Run 单终态：后台完成后再 finishRun 不会重复发终态事件', async () => {
  setupEnv();
  try {
    const proj = store.projects.create({ name: 'ACK 终态唯一', rootPath: tmpDir });
    const ext = store.externalAgents.create({ name: '终态测试', adapter_type: 'workbuddy', config: {} });
    const conv = store.conversations.create({ projectId: proj.id, agentId: ext.id, title: '终态唯一' });

    const originalRun = extAgents.runExternalAgent;
    extAgents.runExternalAgent = async () => {
      await delay(100);
      return JSON.stringify({ status: 'completed', summary: 'done', errors: [] });
    };

    const sendHandler = ipcHandlers.get('agent:send');
    const ack = await sendHandler({}, { conversationId: conv.id, agentId: ext.id, message: '终态唯一测试' });

    await delay(400);

    // 模拟「迟到的 completed」—— 试图再次 finishRun
    handlers.runManager.finishRun(ack.runId, 'completed', { source: 'late-duplicate' });
    handlers.runManager.finishRun(ack.runId, 'failed', { source: 'late-duplicate' });

    // 终态事件应只有 1 个 run_completed
    const termEvents = sentEvents
      .filter(e => e.channel === 'agent:event')
      .map(e => e.payload && e.payload.type)
      .filter(t => ['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(t));
    assert.strictEqual(termEvents.length, 1, '一个 Run 只能发一次终态事件');
    assert.strictEqual(termEvents[0], 'run_completed');

    extAgents.runExternalAgent = originalRun;
  } finally {
    teardownEnv();
  }
});

// 还原 Module._load（避免污染后续测试）
test('teardown：还原 Module._load', () => {
  Module._load = origLoad;
  assert.strictEqual(Module._load, origLoad);
});
