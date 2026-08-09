'use strict';
/**
 * OpenCodeAgentAdapter unit tests.
 *
 * Tests:
 *   - Manifest: correct id, capabilities, transport
 *   - detect() / healthCheck()
 *   - startTask: creates session, sends prompt, receives events, returns diff
 *   - Events mapped correctly
 *   - Cancel aborts the session
 *   - Dispose stops server
 *   - Server manager: health, detect, pure functions, reference counting
 *
 * Uses a fake OpenCode HTTP server (test/fakes/fakeOpenCodeServer.js) and an
 * injectable fake serverManager that wraps it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createFakeOpenCodeServer } = require('./fakes/fakeOpenCodeServer');
const { OpenCodeAgentAdapter, extractChangedFiles } = require('../src/agents/adapters/openCodeAgentAdapter');
const { createOpenCodeServerManager, allocatePort, generatePassword, basicAuthHeader } =
  require('../src/agents/integrations/opencode/serverManager');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../src/agents/hub/types');
const { OPENCODE } = require('../src/agents/manifests/builtinAgents');

// ── Fake serverManager that wraps the fake HTTP server ────────────────────
function createFakeServerManager(serverInfo) {
  const refs = new Map(); // projectRoot → Set<runId>
  const calls = { start: 0, release: 0, dispose: 0 };
  return {
    detect: async () => ({ available: true, path: '/fake/opencode' }),
    getVersion: async () => 'fake-1.0.0',
    start: async ({ projectRoot, runId }) => {
      calls.start++;
      if (!refs.has(projectRoot)) refs.set(projectRoot, new Set());
      refs.get(projectRoot).add(runId);
      return { ...serverInfo, refCount: refs.get(projectRoot).size };
    },
    release: (projectRoot, runId) => {
      calls.release++;
      const set = refs.get(projectRoot);
      if (set) {
        set.delete(runId);
        if (set.size === 0) refs.delete(projectRoot);
      }
      return !refs.has(projectRoot);
    },
    stop: () => true,
    health: async (baseUrl, password) => {
      try {
        const start = Date.now();
        const resp = await fetch(`${baseUrl}/global/health`);
        const body = await resp.json();
        return {
          healthy: body.healthy !== false,
          version: body.version || null,
          latencyMs: Date.now() - start
        };
      } catch {
        return { healthy: false, version: null, latencyMs: 0 };
      }
    },
    getServer: () => null,
    isRunning: () => true,
    isProcessAlive: () => true,
    dispose: async () => { calls.dispose++; refs.clear(); },
    _calls: calls,
    _refCount: (projectRoot) => refs.get(projectRoot)?.size || 0
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => { collector.finish = { status, result }; },
    signal: null
  };
}

async function waitForFinish(collector, timeoutMs = 5000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!collector.finish) throw new Error('finishRun not called within timeout');
  return collector.finish;
}

// ── Shared fake server (started once for all tests) ───────────────────────
let fakeServer;
let sm;

test.before(async () => {
  fakeServer = createFakeOpenCodeServer();
  await fakeServer.start();
  sm = createFakeServerManager({
    port: fakeServer.port,
    password: '',
    pid: 12345,
    baseUrl: fakeServer.baseUrl
  });
});

test.after(async () => {
  if (fakeServer) await fakeServer.stop();
});

// ── Tests: Manifest ───────────────────────────────────────────────────────
test('OpenCodeAgentAdapter: manifest has correct id, capabilities, transport', () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const m = adapter.getManifest();
  assert.strictEqual(m.id, 'opencode');
  assert.strictEqual(m.transport, 'http');
  assert.strictEqual(m.source, 'external');
  assert.ok(m.capabilities);
  assert.strictEqual(m.capabilities.coding, true);
  assert.strictEqual(m.capabilities.terminal, true);
  assert.strictEqual(m.capabilities.git, true);
  assert.strictEqual(m.capabilities.streaming, true);
  assert.strictEqual(m.capabilities.diff, true);
  assert.strictEqual(m.maxConcurrency, 2);
});

// ── Tests: detect / healthCheck ───────────────────────────────────────────
test('detect() returns available with CLI path', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const r = await adapter.detect();
  assert.strictEqual(r.available, true);
  assert.ok(r.version);
  assert.ok(typeof r.path === 'string');
});

test('healthCheck() returns healthy', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const r = await adapter.healthCheck();
  assert.strictEqual(r.status, HEALTH_STATE.HEALTHY);
  assert.ok(r.version);
  assert.ok(typeof r.latencyMs === 'number');
});

// ── Tests: startTask ──────────────────────────────────────────────────────
test('startTask: throws when projectRoot is missing', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  await assert.rejects(
    () => adapter.startTask({ goal: 'test' }, {}),
    /projectRoot 必填/
  );
});

test('startTask: throws when goal is missing', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  await assert.rejects(
    () => adapter.startTask({ projectRoot: '/tmp' }, {}),
    /task.goal 必填/
  );
});

test('startTask: creates session, receives events, returns completed result', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const { runId } = await adapter.startTask(
    { goal: 'write a function', projectRoot: '/tmp/test-project' },
    context
  );
  assert.ok(typeof runId === 'string' && runId.length > 0);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'completed');
  assert.ok(finish.result.summary !== undefined);
  assert.ok(finish.result.sessionId, 'should have sessionId');
  assert.ok(Array.isArray(finish.result.changedFiles));
  assert.ok(Array.isArray(finish.result.diff));
});

test('startTask: events are mapped to unified AGENT_EVENT types', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask(
    { goal: 'test event mapping', projectRoot: '/tmp/event-test' },
    context
  );
  await waitForFinish(collector);

  const types = collector.events.map(e => e.type);
  // server.connected + session.updated → RUN_STATUS
  assert.ok(types.includes(AGENT_EVENT.RUN_STATUS), 'should have RUN_STATUS');
  // message.updated → MESSAGE
  assert.ok(types.includes(AGENT_EVENT.MESSAGE), 'should have MESSAGE');
  // tool_call → TOOL_STARTED
  assert.ok(types.includes(AGENT_EVENT.TOOL_STARTED), 'should have TOOL_STARTED');
  // tool_call.updated (completed) → TOOL_COMPLETED
  assert.ok(types.includes(AGENT_EVENT.TOOL_COMPLETED), 'should have TOOL_COMPLETED');
  // session.completed → RUN_COMPLETED (terminal)
  assert.ok(types.includes(AGENT_EVENT.RUN_COMPLETED), 'should have RUN_COMPLETED');
});

test('startTask: diff is returned with changed files', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask(
    { goal: 'make changes', projectRoot: '/tmp/diff-test' },
    context
  );
  const finish = await waitForFinish(collector);

  assert.ok(Array.isArray(finish.result.diff));
  assert.ok(finish.result.diff.length > 0);
  assert.ok(finish.result.diff[0].path);
  assert.ok(finish.result.changedFiles.includes('src/test.js'));
});

// ── Tests: cancel ─────────────────────────────────────────────────────────
test('cancel: aborts the session and returns ok', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const { runId } = await adapter.startTask(
    { goal: 'long running task', projectRoot: '/tmp/cancel-test' },
    context
  );

  // Cancel immediately
  const cancelResult = await adapter.cancel(runId);
  assert.strictEqual(cancelResult.ok, true);

  // Wait for the run to reach a terminal state
  const finish = await waitForFinish(collector, 5000);
  assert.ok(['cancelled', 'completed'].includes(finish.status),
    `expected cancelled or completed, got ${finish.status}`);
});

test('cancel: returns error for unknown runId', async () => {
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const r = await adapter.cancel('nonexistent');
  assert.strictEqual(r.ok, false);
});

// ── Tests: dispose ────────────────────────────────────────────────────────
test('dispose: cleans up runs and releases serverManager', async () => {
  const localSm = createFakeServerManager({
    port: fakeServer.port,
    password: '',
    pid: 12345,
    baseUrl: fakeServer.baseUrl
  });
  const adapter = new OpenCodeAgentAdapter({ serverManager: localSm });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask({ goal: 'dispose test', projectRoot: '/tmp/dispose' }, context);
  assert.ok(adapter._runs.size > 0);

  await adapter.dispose();
  assert.strictEqual(adapter._runs.size, 0);
  assert.strictEqual(localSm._calls.dispose, 1);
});

// ── Tests: Server manager (real) ──────────────────────────────────────────
test('serverManager.health: returns healthy against fake server', async () => {
  const realSm = createOpenCodeServerManager();
  const r = await realSm.health(fakeServer.baseUrl, '');
  assert.strictEqual(r.healthy, true);
  assert.strictEqual(r.version, 'fake-1.0.0');
  assert.ok(typeof r.latencyMs === 'number');
});

test('serverManager.health: returns unhealthy for invalid URL', async () => {
  const realSm = createOpenCodeServerManager();
  const r = await realSm.health('http://127.0.0.1:1', '');
  assert.strictEqual(r.healthy, false);
});

test('serverManager.detect: opencode CLI not in PATH (test env)', async () => {
  const realSm = createOpenCodeServerManager();
  const r = await realSm.detect();
  assert.strictEqual(typeof r.available, 'boolean');
  assert.ok(r.path === null || typeof r.path === 'string');
});

test('serverManager: allocatePort returns a usable port number', async () => {
  const port = await allocatePort();
  assert.ok(typeof port === 'number');
  assert.ok(port > 0);
  assert.ok(port < 65536);
});

test('serverManager: generatePassword returns a hex string', () => {
  const pw = generatePassword();
  assert.ok(typeof pw === 'string');
  assert.ok(pw.length >= 32);
  assert.ok(/^[0-9a-f]+$/.test(pw));
});

test('serverManager: basicAuthHeader returns correct format', () => {
  const h = basicAuthHeader('test-password');
  assert.ok(h.startsWith('Basic '));
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  assert.strictEqual(decoded, 'opencode:test-password');
});

test('serverManager: basicAuthHeader with empty password', () => {
  const h = basicAuthHeader('');
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  assert.strictEqual(decoded, 'opencode:');
});

// ── Tests: extractChangedFiles ────────────────────────────────────────────
test('extractChangedFiles: extracts paths from diff array', () => {
  const diffs = [
    { path: 'src/a.js', additions: 1 },
    { file: 'src/b.js', additions: 2 },
    { filename: 'src/c.js', additions: 3 },
    { name: 'src/d.js', additions: 4 }
  ];
  const files = extractChangedFiles(diffs);
  assert.strictEqual(files.length, 4);
  assert.ok(files.includes('src/a.js'));
  assert.ok(files.includes('src/b.js'));
  assert.ok(files.includes('src/c.js'));
  assert.ok(files.includes('src/d.js'));
});

test('extractChangedFiles: deduplicates paths', () => {
  const diffs = [
    { path: 'src/a.js' },
    { path: 'src/a.js' },
    { file: 'src/b.js' }
  ];
  const files = extractChangedFiles(diffs);
  assert.strictEqual(files.length, 2);
});

test('extractChangedFiles: handles null and non-array', () => {
  assert.deepStrictEqual(extractChangedFiles(null), []);
  assert.deepStrictEqual(extractChangedFiles('not array'), []);
  assert.deepStrictEqual(extractChangedFiles([]), []);
});

// ── Tests: Reference counting ─────────────────────────────────────────────
test('reference counting: two runs on same projectRoot share server ref', async () => {
  const rcSm = createFakeServerManager({
    port: fakeServer.port,
    password: '',
    pid: 12345,
    baseUrl: fakeServer.baseUrl
  });
  const adapter = new OpenCodeAgentAdapter({ serverManager: rcSm });

  const collector1 = { events: [], finish: null };
  const collector2 = { events: [], finish: null };
  const context1 = makeContext(collector1);
  const context2 = makeContext(collector2);

  const projectRoot = '/tmp/refcount-test';

  // Start both tasks — both should ref the same projectRoot
  const { runId: r1 } = await adapter.startTask({ goal: 'task 1', projectRoot }, context1);
  const { runId: r2 } = await adapter.startTask({ goal: 'task 2', projectRoot }, context2);

  // Both start() calls should have been made
  assert.ok(rcSm._calls.start >= 2, `expected at least 2 start calls, got ${rcSm._calls.start}`);

  // Wait for both to complete — refs should be released
  await waitForFinish(collector1);
  await waitForFinish(collector2);

  // Both release() calls should have been made
  assert.ok(rcSm._calls.release >= 2, `expected at least 2 release calls, got ${rcSm._calls.release}`);

  // Ref count should be 0 after both complete
  assert.strictEqual(rcSm._refCount(projectRoot), 0);
});
