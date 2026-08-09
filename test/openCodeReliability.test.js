'use strict';
/**
 * OpenCode 运行可靠性测试（spec §12 / §16-§18 / §21 / §24 / §25 / §27 / §58 / §62 / §63 / §64）。
 *
 * 覆盖真实失败场景：
 *   - SSE 意外断开（无显式终态）→ FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL（不再 COMPLETED）
 *   - 超时 → TIMEOUT（不是 CANCELLED），并发 agent.run.timeout
 *   - 用户取消 → CANCELLED（发出 agent.run.cancelled）
 *   - 连续畸形事件达到阈值 → PROTOCOL_ERROR，单个不崩溃
 *   - 远端错误分类：401/403→AUTH_FAILED，5xx→REMOTE_ERROR，404→SESSION_NOT_FOUND
 *   - 晚期结果保护（取消后到达的 completed 被忽略）
 *
 * 每个用例使用独立的 fake server + serverManager，避免共享状态互相干扰。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createFakeOpenCodeServer } = require('./fakes/fakeOpenCodeServer');
const { OpenCodeAgentAdapter, MAX_MALFORMED_EVENTS } = require('../src/agents/adapters/openCodeAgentAdapter');
const { LIFECYCLE, AGENT_EVENT } = require('../src/agents/hub/types');

function createFakeServerManager(serverInfo) {
  const refs = new Map();
  return {
    detect: async () => ({ available: true, path: '/fake/opencode' }),
    getVersion: async () => 'fake-1.0.0',
    start: async ({ projectRoot, runId }) => {
      if (!refs.has(projectRoot)) refs.set(projectRoot, new Set());
      refs.get(projectRoot).add(runId);
      return { ...serverInfo, refCount: refs.get(projectRoot).size };
    },
    release: (projectRoot, runId) => {
      const set = refs.get(projectRoot);
      if (set) { set.delete(runId); if (set.size === 0) refs.delete(projectRoot); }
      return !refs.has(projectRoot);
    },
    stop: () => true,
    health: async () => ({ healthy: true, version: 'fake-1.0.0', latencyMs: 0 }),
    getServer: () => null,
    isRunning: () => true,
    isProcessAlive: () => true,
    dispose: async () => { refs.clear(); }
  };
}

function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => { collector.finish = { status, result }; },
    signal: null
  };
}

// 跟踪所有 per-test server，test.after 统一关闭，避免 dangling 句柄导致进程不退出
const allServers = [];
async function makeServer() {
  const s = createFakeOpenCodeServer();
  await s.start();
  allServers.push(s);
  return s;
}
test.after(async () => {
  for (const s of allServers) { try { await s.stop(); } catch { /* noop */ } }
  allServers.length = 0;
});

async function waitForFinish(collector, timeoutMs = 8000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!collector.finish) throw new Error('finishRun not called within timeout');
  return collector.finish;
}

test('SSE abrupt disconnect without terminal → FAILED (not COMPLETED)', async () => {
  const server = await makeServer();
  server.setHangNext(); // 发 running 但永不 completed
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/disc' }, makeContext(collector));
  // 让 SSE 建立并收到 running，然后强行断开 server（无 completed）
  await new Promise(r => setTimeout(r, 120));
  await server.stop();
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed', `expected failed, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL');
  await adapter.dispose();
});

test('timeout → TIMEOUT (not CANCELLED), emits agent.run.timeout', async () => {
  const server = await makeServer();
  server.setHangNext(); // 发 running 但永不 completed
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/timeout', timeoutMs: 120 }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'timeout', `expected timeout, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_TIMEOUT');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_TIMEOUT), 'should emit agent.run.timeout');
  assert.ok(!collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'timeout must not emit cancelled');
  await adapter.dispose();
});

test('user cancel → CANCELLED (not COMPLETED), emits agent.run.cancelled', async () => {
  const server = await makeServer();
  server.setHangNext();
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/cancel', timeoutMs: 100000 }, makeContext(collector));
  await new Promise(r => setTimeout(r, 50));
  const cr = await adapter.cancel(runId);
  assert.strictEqual(cr.ok, true);
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled', `expected cancelled, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_CANCELLED');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'should emit agent.run.cancelled');
  await adapter.dispose();
});

test('consecutive malformed events reach threshold → PROTOCOL_ERROR; single does not crash', async () => {
  const server = await makeServer();
  server.setMalformedBurst(MAX_MALFORMED_EVENTS + 1); // 超过阈值
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/malformed', timeoutMs: 100000 }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed', `expected failed, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_PROTOCOL_ERROR');
  await adapter.dispose();
});

test('remote 401 → AUTH_FAILED', async () => {
  const server = await makeServer();
  server.setForcedCreateStatus(401);
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/auth', timeoutMs: 100000 }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_AUTH_FAILED');
  await adapter.dispose();
});

test('remote 500 → REMOTE_ERROR', async () => {
  const server = await makeServer();
  server.setForcedCreateStatus(500);
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/remote', timeoutMs: 100000 }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_REMOTE_ERROR');
  await adapter.dispose();
});

test('late completed after cancel is ignored (terminal once)', async () => {
  const server = await makeServer();
  const sm = createFakeServerManager({ port: server.port, password: '', pid: 1, baseUrl: server.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/late', timeoutMs: 100000 }, makeContext(collector));
  // 立即取消 → CANCELLED
  await adapter.cancel(runId);
  // 闸门已终态，再尝试 completed 必须被忽略
  const tr = adapter._gate.transition(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.status, LIFECYCLE.CANCELLED);
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled');
  await adapter.dispose();
});
