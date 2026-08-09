'use strict';
/**
 * OpenHandsAgentAdapter unit tests.
 *
 * Tests:
 *   - Manifest: correct id, capabilities, transport
 *   - detect() / healthCheck()
 *   - startTask: creates conversation, sends message, receives events
 *   - Events mapped correctly
 *   - Cancel deletes conversation
 *   - Dispose cleans up
 *   - Remote mode: configured serverUrl
 *   - Workspace: working_dir from projectRoot
 *
 * Uses a fake OpenHands server (test/fakes/fakeOpenHandsServer.js).
 * The OpenHands client falls back to HTTP polling when no global WebSocket
 * is available (Node 20 / Electron 31), so the fake HTTP server is sufficient.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createFakeOpenHandsServer } = require('./fakes/fakeOpenHandsServer');
const { OpenHandsAgentAdapter } = require('../src/agents/adapters/openHandsAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../src/agents/hub/types');
const { OPENHANDS } = require('../src/agents/manifests/builtinAgents');

// ── Helpers ───────────────────────────────────────────────────────────────
function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => { collector.finish = { status, result }; },
    signal: null
  };
}

async function waitForFinish(collector, timeoutMs = 10000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!collector.finish) throw new Error('finishRun not called within timeout');
  return collector.finish;
}

// ── Shared fake server ────────────────────────────────────────────────────
let fakeServer;

test.before(async () => {
  fakeServer = createFakeOpenHandsServer();
  await fakeServer.start();
});

test.after(async () => {
  if (fakeServer) await fakeServer.stop();
});

// ── Tests: Manifest ───────────────────────────────────────────────────────
test('OpenHandsAgentAdapter: manifest has correct id, capabilities, transport', () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const m = adapter.getManifest();
  assert.strictEqual(m.id, 'openhands');
  assert.strictEqual(m.transport, 'http');
  assert.strictEqual(m.source, 'external');
  assert.ok(m.capabilities);
  assert.strictEqual(m.capabilities.coding, true);
  assert.strictEqual(m.capabilities.browser, true);
  assert.strictEqual(m.capabilities.sandbox, true);
  assert.strictEqual(m.capabilities.streaming, true);
  assert.strictEqual(m.maxConcurrency, 1);
});

// ── Tests: detect ─────────────────────────────────────────────────────────
test('detect: returns unavailable when no CLI and no serverUrl', async () => {
  const adapter = new OpenHandsAgentAdapter({});
  const r = await adapter.detect();
  assert.strictEqual(r.available, false);
  assert.ok(!r.mode, 'mode should be falsy when unavailable');
});

test('detect: remote mode returns available with serverUrl', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const r = await adapter.detect();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.mode, 'remote');
  assert.strictEqual(r.path, fakeServer.baseUrl);
});

// ── Tests: healthCheck ────────────────────────────────────────────────────
test('healthCheck: returns healthy when server is up', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const r = await adapter.healthCheck();
  assert.strictEqual(r.status, HEALTH_STATE.HEALTHY);
  assert.ok(r.version);
  assert.ok(typeof r.latencyMs === 'number');
});

test('healthCheck: returns unavailable when no serverUrl and no CLI', async () => {
  const adapter = new OpenHandsAgentAdapter({});
  const r = await adapter.healthCheck();
  assert.strictEqual(r.status, HEALTH_STATE.UNAVAILABLE);
});

test('healthCheck: returns degraded when serverUrl is unreachable', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: 'http://127.0.0.1:1' }
  });
  const r = await adapter.healthCheck();
  assert.ok(
    r.status === HEALTH_STATE.DEGRADED || r.status === HEALTH_STATE.UNAVAILABLE,
    `expected degraded or unavailable, got ${r.status}`
  );
});

// ── Tests: startTask ──────────────────────────────────────────────────────
test('startTask: throws when projectRoot is missing', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  await assert.rejects(
    () => adapter.startTask({ goal: 'test' }, {}),
    /projectRoot 必填/
  );
});

test('startTask: throws when goal is missing', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  await assert.rejects(
    () => adapter.startTask({ projectRoot: '/tmp' }, {}),
    /task.goal 必填/
  );
});

test('startTask: creates conversation, sends message, receives events', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const { runId } = await adapter.startTask(
    { goal: 'write a test file', projectRoot: '/tmp/oh-test' },
    context
  );
  assert.ok(typeof runId === 'string' && runId.length > 0);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'completed');
  assert.ok(finish.result.conversationId, 'should have conversationId');
  assert.ok(finish.result.summary !== undefined);
  assert.ok(Array.isArray(finish.result.changedFiles));

  // Verify conversation was created on the server
  const status = await adapter.getStatus(runId);
  assert.ok(status.conversationId);
  assert.ok(fakeServer.conversations.has(status.conversationId));
});

test('startTask: events are mapped to unified AGENT_EVENT types', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask(
    { goal: 'test event mapping', projectRoot: '/tmp/oh-events' },
    context
  );
  await waitForFinish(collector);

  const types = collector.events.map(e => e.type);
  // message event → MESSAGE
  assert.ok(types.includes(AGENT_EVENT.MESSAGE), 'should have MESSAGE');
  // action: edit → FILE_CHANGED
  assert.ok(types.includes(AGENT_EVENT.FILE_CHANGED), 'should have FILE_CHANGED');
  // terminal: agent_state_changed finished → RUN_COMPLETED
  assert.ok(types.includes(AGENT_EVENT.RUN_COMPLETED), 'should have RUN_COMPLETED');
});

test('startTask: changed files include edited paths', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask(
    { goal: 'edit files', projectRoot: '/tmp/oh-files' },
    context
  );
  const finish = await waitForFinish(collector);

  assert.ok(finish.result.changedFiles.length > 0);
  assert.ok(finish.result.changedFiles.includes('src/test.js'));
});

test('startTask: throws when no serverUrl configured and no CLI detected', async () => {
  const adapter = new OpenHandsAgentAdapter({});
  await assert.rejects(
    () => adapter.startTask(
      { goal: 'should fail', projectRoot: '/tmp/oh-fail' },
      makeContext({ events: [], finish: null })
    ),
    /openhands not available/
  );
});

// ── Tests: cancel ─────────────────────────────────────────────────────────
test('cancel: deletes conversation and returns ok', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const { runId } = await adapter.startTask(
    { goal: 'long running task', projectRoot: '/tmp/oh-cancel' },
    context
  );

  // Cancel immediately
  const cancelResult = await adapter.cancel(runId);
  assert.strictEqual(cancelResult.ok, true);

  // Wait for terminal state
  const finish = await waitForFinish(collector, 10000);
  assert.ok(['cancelled', 'completed'].includes(finish.status),
    `expected cancelled or completed, got ${finish.status}`);
});

test('cancel: returns error for unknown runId', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const r = await adapter.cancel('nonexistent');
  assert.strictEqual(r.ok, false);
});

// ── Tests: dispose ────────────────────────────────────────────────────────
test('dispose: cleans up internal state', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask({ goal: 'dispose test', projectRoot: '/tmp/oh-dispose' }, context);
  assert.ok(adapter._runs.size > 0);

  await adapter.dispose();
  assert.strictEqual(adapter._runs.size, 0);
});

// ── Tests: Remote mode ────────────────────────────────────────────────────
test('Remote mode: configured serverUrl enables detect and healthCheck', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl, apiKey: 'test-key' }
  });

  const detected = await adapter.detect();
  assert.strictEqual(detected.available, true);
  assert.strictEqual(detected.mode, 'remote');

  const health = await adapter.healthCheck();
  assert.strictEqual(health.status, HEALTH_STATE.HEALTHY);
});

// ── Tests: Workspace ──────────────────────────────────────────────────────
test('Workspace: working_dir is set from projectRoot', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const projectRoot = '/tmp/oh-workspace-test';
  const { runId } = await adapter.startTask(
    { goal: 'workspace test', projectRoot },
    context
  );
  const finish = await waitForFinish(collector);

  // The conversation on the server should have working_dir = projectRoot
  const status = await adapter.getStatus(runId);
  const conv = fakeServer.conversations.get(status.conversationId);
  assert.ok(conv, 'conversation should exist on server');
  assert.strictEqual(conv.working_dir, projectRoot);
});

test('sendMessage: returns not supported when no active conversation', async () => {
  const adapter = new OpenHandsAgentAdapter({
    config: { serverUrl: fakeServer.baseUrl }
  });
  const r = await adapter.sendMessage('nonexistent', 'msg');
  assert.strictEqual(r.ok, false);
});
