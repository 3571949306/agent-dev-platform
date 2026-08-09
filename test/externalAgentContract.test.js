'use strict';
/**
 * Contract tests — verify that Cline, OpenCode, and OpenHands adapters
 * all satisfy the unified AgentAdapter contract from BaseAgentAdapter.
 *
 * Uses a reusable runAgentAdapterContract(factory) pattern. Each factory
 * returns { adapter, task, context, collector } configured for the
 * specific adapter's requirements (SDK injection, fake server, etc.).
 */
const test = require('node:test');
const assert = require('node:assert');

const { LIFECYCLE } = require('../src/agents/hub/types');

// ── Cline: inject fake SDK via require.cache ──────────────────────────────
const fakeSdk = require('./fakes/fakeClineSdk');

const clineFakeBridge = {
  __clineFake: true,
  probeSdk: async () => ({ available: true, version: '0.0.72-fake', error: null }),
  createAgent: async (config, onEvent) => new fakeSdk.Agent({ ...config, onEvent }),
  loadSdk: async () => fakeSdk,
  createCore: async (config) => fakeSdk.ClineCore.create(config)
};

const clineBridgePath = require.resolve('../src/agents/integrations/cline/sdkBridge');
const existing = require.cache[clineBridgePath];
if (!existing || !existing.exports || !existing.exports.__clineFake) {
  require.cache[clineBridgePath] = {
    id: clineBridgePath,
    filename: clineBridgePath,
    loaded: true,
    exports: clineFakeBridge
  };
  const clineAdapterPath = require.resolve('../src/agents/adapters/clineAgentAdapter');
  delete require.cache[clineAdapterPath];
}
const { ClineAgentAdapter } = require('../src/agents/adapters/clineAgentAdapter');

// ── OpenCode: fake server + fake serverManager ────────────────────────────
const { createFakeOpenCodeServer } = require('./fakes/fakeOpenCodeServer');
const { OpenCodeAgentAdapter } = require('../src/agents/adapters/openCodeAgentAdapter');

// ── OpenHands: fake server ────────────────────────────────────────────────
const { createFakeOpenHandsServer } = require('./fakes/fakeOpenHandsServer');
const { OpenHandsAgentAdapter } = require('../src/agents/adapters/openHandsAgentAdapter');

// ── Shared fake servers ───────────────────────────────────────────────────
let ocServer, ohServer;

test.before(async () => {
  ocServer = createFakeOpenCodeServer();
  await ocServer.start();
  ohServer = createFakeOpenHandsServer();
  await ohServer.start();
});

test.after(async () => {
  if (ocServer) await ocServer.stop();
  if (ohServer) await ohServer.stop();
});

// ── Fake serverManager for OpenCode ───────────────────────────────────────
function createFakeOcSm(serverInfo) {
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
    health: async () => ({ healthy: true, version: 'fake-1.0.0', latencyMs: 1 }),
    getServer: () => null,
    isRunning: () => true,
    isProcessAlive: () => true,
    dispose: async () => { refs.clear(); }
  };
}

// ── Factories ─────────────────────────────────────────────────────────────
function makeCollector() {
  return { events: [], finish: null };
}

function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => { collector.finish = { status, result }; },
    signal: null
  };
}

function clineFactory() {
  const store = {
    connections: {
      getDecrypted: (id) => id === 'contract-conn'
        ? { protocol: 'anthropic', apiKey: 'contract-key', model: 'claude-sonnet-4-20250514' }
        : null
    }
  };
  const adapter = new ClineAgentAdapter({ store });
  const collector = makeCollector();
  const context = makeContext(collector);
  const task = { goal: 'contract test task', connectionId: 'contract-conn', projectRoot: '/tmp/contract-cline' };
  return { adapter, task, context, collector };
}

function openCodeFactory() {
  const sm = createFakeOcSm({ port: ocServer.port, password: '', pid: 1, baseUrl: ocServer.baseUrl });
  const adapter = new OpenCodeAgentAdapter({ serverManager: sm });
  const collector = makeCollector();
  const context = makeContext(collector);
  const task = { goal: 'contract test task', projectRoot: '/tmp/contract-opencode' };
  return { adapter, task, context, collector };
}

function openHandsFactory() {
  const adapter = new OpenHandsAgentAdapter({ config: { serverUrl: ohServer.baseUrl } });
  const collector = makeCollector();
  const context = makeContext(collector);
  const task = { goal: 'contract test task', projectRoot: '/tmp/contract-openhands' };
  return { adapter, task, context, collector };
}

// ── Async wait helper ─────────────────────────────────────────────────────
async function waitForFinish(collector, timeoutMs = 10000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  return collector.finish;
}

const VALID_LIFECYCLE_STATES = Object.values(LIFECYCLE);

// ── Reusable contract runner ──────────────────────────────────────────────
function runAgentAdapterContract(name, factory) {
  test(`${name}: getManifest() returns object with required fields`, async () => {
    const { adapter } = factory();
    const m = adapter.getManifest();
    assert.ok(m && typeof m === 'object');
    assert.ok(typeof m.id === 'string' && m.id.length > 0);
    assert.ok(typeof m.transport === 'string');
    assert.ok(m.capabilities);
    assert.ok(typeof m.maxConcurrency === 'number');
    assert.ok(m.maxConcurrency >= 1);
  });

  test(`${name}: detect() returns { available, version?, path? }`, async () => {
    const { adapter } = factory();
    const r = await adapter.detect();
    assert.strictEqual(typeof r.available, 'boolean');
    if (r.version !== null && r.version !== undefined) {
      assert.ok(typeof r.version === 'string');
    }
    if (r.path !== null && r.path !== undefined) {
      assert.ok(typeof r.path === 'string');
    }
  });

  test(`${name}: healthCheck() returns { status, version?, latencyMs? }`, async () => {
    const { adapter } = factory();
    const r = await adapter.healthCheck();
    assert.ok(typeof r.status === 'string');
    assert.ok(typeof r.latencyMs === 'number');
  });

  test(`${name}: startTask returns { runId }`, async () => {
    const { adapter, task, context } = factory();
    try {
      const r = await adapter.startTask(task, context);
      assert.ok(r && typeof r.runId === 'string');
      assert.ok(r.runId.length > 0);
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: getStatus returns valid lifecycle status`, async () => {
    const { adapter, task, context } = factory();
    try {
      const { runId } = await adapter.startTask(task, context);
      const s = await adapter.getStatus(runId);
      assert.ok(typeof s.status === 'string');
      assert.ok(
        VALID_LIFECYCLE_STATES.includes(s.status),
        `${name}: status "${s.status}" is not a valid LIFECYCLE state`
      );
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: getResult returns result shape after completion`, async () => {
    const { adapter, task, context, collector } = factory();
    try {
      const { runId } = await adapter.startTask(task, context);
      const finish = await waitForFinish(collector);
      assert.ok(finish, `${name}: run should complete within timeout`);
      const result = await adapter.getResult(runId);
      assert.ok(result, `${name}: getResult should return non-null after completion`);
      assert.ok(typeof result.status === 'string');
      assert.ok(['completed', 'failed', 'cancelled', 'timeout'].includes(result.status));
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: cancel returns ok`, async () => {
    const { adapter, task, context } = factory();
    try {
      const { runId } = await adapter.startTask(task, context);
      const r = await adapter.cancel(runId);
      assert.strictEqual(r.ok, true);
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: cancel unknown runId returns ok=false`, async () => {
    const { adapter } = factory();
    try {
      const r = await adapter.cancel('nonexistent-run-id');
      assert.strictEqual(r.ok, false);
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: dispose cleans up without error`, async () => {
    const { adapter, task, context } = factory();
    await adapter.startTask(task, context);
    await adapter.dispose();
    // After dispose, runs map should be empty
    assert.strictEqual(adapter._runs.size, 0);
  });

  test(`${name}: getStatus for unknown runId returns idle`, async () => {
    const { adapter } = factory();
    try {
      const s = await adapter.getStatus('nonexistent');
      assert.ok(typeof s.status === 'string');
    } finally {
      await adapter.dispose();
    }
  });

  test(`${name}: getResult for unknown runId returns null`, async () => {
    const { adapter } = factory();
    try {
      const r = await adapter.getResult('nonexistent');
      assert.strictEqual(r, null);
    } finally {
      await adapter.dispose();
    }
  });
}

// ── Run contract for each adapter ─────────────────────────────────────────
runAgentAdapterContract('ClineAgentAdapter', clineFactory);
runAgentAdapterContract('OpenCodeAgentAdapter', openCodeFactory);
runAgentAdapterContract('OpenHandsAgentAdapter', openHandsFactory);
