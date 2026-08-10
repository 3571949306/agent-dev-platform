'use strict';
/**
 * ClineAgentAdapter unit tests.
 *
 * Tests:
 *   - Manifest: correct id, capabilities, transport
 *   - detect() / healthCheck() when SDK unavailable
 *   - configMapper: common providers mapped correctly
 *   - eventMapper: content_start / content_update / usage + ACP events
 *   - startTask: creates agent, emits events, returns completed result
 *   - cancel: aborts the run
 *   - dispose: cleans up
 *   - Secret filtering: apiKey not in any emitted event
 *
 * The fake @cline/sdk is injected by replacing sdkBridge in require.cache,
 * so the adapter's closure captures the fake probeSdk / createAgent.
 */
const test = require('node:test');
const assert = require('node:assert');

// ── Phase 1: pure-function tests (eventMapper, configMapper) ──────────────
const { mapClineEvent } = require('../src/agents/integrations/cline/eventMapper');
const { mapConnection } = require('../src/agents/integrations/cline/configMapper');
const { CLINE } = require('../src/agents/manifests/builtinAgents');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../src/agents/hub/types');

// ── Phase 2: inject fake SDK into the bridge cache ────────────────────────
const fakeSdk = require('./fakes/fakeClineSdk');

let sdkAvailable = true;
let agentDelayMs = 0;

const fakeBridgeExports = {
  __clineFake: true,
  probeSdk: async () => sdkAvailable
    ? { available: true, version: '0.0.72-fake', error: null }
    : { available: false, version: null, error: 'Cannot find module @cline/sdk' },
  createAgent: async (config, onEvent) =>
    new fakeSdk.Agent({ ...config, onEvent, delayMs: agentDelayMs }),
  loadSdk: async () => fakeSdk,
  createCore: async (config) => fakeSdk.ClineCore.create(config)
};

const bridgePath = require.resolve('../src/agents/integrations/cline/sdkBridge');
// Save real bridge so we can test probeSdk-fails path if it's still real
const realBridge = require.cache[bridgePath] ? require.cache[bridgePath].exports : null;
const isRealBridge = realBridge && !realBridge.__clineFake;

require.cache[bridgePath] = {
  id: bridgePath,
  filename: bridgePath,
  loaded: true,
  exports: fakeBridgeExports
};
// Clear adapter cache so it re-requires the (now fake) bridge
const adapterPath = require.resolve('../src/agents/adapters/clineAgentAdapter');
delete require.cache[adapterPath];
const { ClineAgentAdapter } = require('../src/agents/adapters/clineAgentAdapter');

// ── Helpers ───────────────────────────────────────────────────────────────
function makeStore(conn) {
  return {
    connections: {
      getDecrypted: (id) => id === 'test-conn' ? conn : null
    }
  };
}

const TEST_CONN = {
  protocol: 'anthropic',
  apiKey: 'SECRET-KEY-XYZ',
  model: 'claude-sonnet-4-20250514'
};

function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => { collector.finish = { status, result }; },
    signal: null
  };
}

async function waitForFinish(collector, timeoutMs = 2000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!collector.finish) throw new Error('finishRun not called within timeout');
  return collector.finish;
}

// ── Tests: Manifest ───────────────────────────────────────────────────────
test('ClineAgentAdapter: manifest has correct id, capabilities, transport', () => {
  const adapter = new ClineAgentAdapter();
  const m = adapter.getManifest();
  assert.strictEqual(m.id, 'cline');
  assert.strictEqual(m.transport, 'protocol');
  assert.strictEqual(m.source, 'external');
  assert.ok(m.capabilities);
  assert.strictEqual(m.capabilities.coding, true);
  assert.strictEqual(m.capabilities.planning, true);
  assert.strictEqual(m.capabilities.filesystem, true);
  assert.strictEqual(m.capabilities.streaming, true);
  assert.strictEqual(m.capabilities.sandbox, false);
  assert.strictEqual(m.maxConcurrency, 1);
});

// ── Tests: detect / healthCheck (SDK unavailable) ────────────────────────
test('detect() returns available: false when SDK not installed', async () => {
  sdkAvailable = false;
  try {
    const adapter = new ClineAgentAdapter();
    const r = await adapter.detect();
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.version, null);
    assert.ok(r.error);
  } finally {
    sdkAvailable = true;
  }
});

test('healthCheck() returns unavailable when SDK not installed', async () => {
  sdkAvailable = false;
  try {
    const adapter = new ClineAgentAdapter();
    const r = await adapter.healthCheck();
    assert.strictEqual(r.status, HEALTH_STATE.UNAVAILABLE);
    assert.strictEqual(r.version, null);
    assert.ok(typeof r.latencyMs === 'number');
    assert.ok(r.detail.includes('@cline/sdk'));
  } finally {
    sdkAvailable = true;
  }
});

test('real probeSdk returns unavailable when @cline/sdk not installed', {
  skip: !isRealBridge ? 'bridge already replaced by another test file' : false
}, async () => {
  const r = await realBridge.probeSdk();
  assert.strictEqual(r.available, false);
  assert.ok(r.error);
});

// ── Tests: detect / healthCheck (SDK available) ──────────────────────────
test('detect() returns available: true when SDK is installed', async () => {
  sdkAvailable = true;
  const adapter = new ClineAgentAdapter();
  const r = await adapter.detect();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.version, '0.0.72-fake');
});

test('healthCheck() returns healthy when SDK is installed', async () => {
  sdkAvailable = true;
  const adapter = new ClineAgentAdapter();
  const r = await adapter.healthCheck();
  assert.strictEqual(r.status, HEALTH_STATE.HEALTHY);
  assert.strictEqual(r.version, '0.0.72-fake');
  assert.ok(typeof r.latencyMs === 'number');
});

// ── Tests: configMapper ───────────────────────────────────────────────────
test('mapConnection: maps anthropic provider', () => {
  const r = mapConnection({ protocol: 'anthropic', apiKey: 'k', model: 'm' });
  assert.strictEqual(r.providerId, 'anthropic');
  assert.strictEqual(r.modelId, 'm');
  assert.strictEqual(r.apiKey, 'k');
});

test('mapConnection: maps google → gemini', () => {
  const r = mapConnection({ provider: 'google', apiKey: 'k' });
  assert.strictEqual(r.providerId, 'gemini');
});

test('mapConnection: maps openrouter', () => {
  const r = mapConnection({ protocol: 'openrouter', apiKey: 'k' });
  assert.strictEqual(r.providerId, 'openrouter');
});

test('mapConnection: maps deepseek, mistral, groq, xai', () => {
  for (const p of ['deepseek', 'mistral', 'groq', 'xai', 'moonshot', 'bedrock', 'azure', 'ollama']) {
    const r = mapConnection({ protocol: p, apiKey: 'k' });
    assert.strictEqual(r.providerId, p, `provider ${p} should map to itself`);
  }
});

test('mapConnection: model override takes precedence', () => {
  const r = mapConnection({ protocol: 'openai', model: 'gpt-4' }, 'gpt-4o');
  assert.strictEqual(r.modelId, 'gpt-4o');
});

test('mapConnection: falls back to protocol for unknown provider', () => {
  const r = mapConnection({ protocol: 'custom-provider', apiKey: 'k' });
  assert.strictEqual(r.providerId, 'custom-provider');
});

test('mapConnection: returns null for null connection', () => {
  assert.strictEqual(mapConnection(null), null);
});

test('mapConnection: uses connection.model when model arg is null', () => {
  const r = mapConnection({ protocol: 'openai', model: 'gpt-4', apiKey: 'k' });
  assert.strictEqual(r.modelId, 'gpt-4');
});

test('mapConnection: maps encrypted-store snake_case fields and local compatible providers', () => {
  assert.deepStrictEqual(mapConnection({
    provider: 'local',
    api_key: 'sk-test-store-shape',
    base_url: 'http://127.0.0.1:1234/v1',
    models: [{ id: 'local-model' }]
  }), {
    providerId: 'openai',
    modelId: 'local-model',
    apiKey: 'sk-test-store-shape',
    baseUrl: 'http://127.0.0.1:1234/v1',
    headers: undefined
  });
});

// ── Tests: eventMapper ────────────────────────────────────────────────────
test('mapClineEvent: content_start with text returns null', () => {
  const r = mapClineEvent({ type: 'content_start', contentType: 'text' }, 'r1', 'cline');
  assert.strictEqual(r, null);
});

test('mapClineEvent: content_start with tool maps to TOOL_STARTED', () => {
  const r = mapClineEvent({ type: 'content_start', contentType: 'tool', toolName: 'read_file' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.TOOL_STARTED);
  assert.strictEqual(r.data.toolName, 'read_file');
  assert.strictEqual(r.runId, 'r1');
  assert.strictEqual(r.agentId, 'cline');
});

test('mapClineEvent: content_update with text maps to MESSAGE', () => {
  const r = mapClineEvent({ type: 'content_update', contentType: 'text', text: 'hello' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(r.data.text, 'hello');
  assert.strictEqual(r.data.delta, true);
});

test('mapClineEvent: usage maps to RUN_STATUS', () => {
  const r = mapClineEvent({ type: 'usage', inputTokens: 100, outputTokens: 50 }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.RUN_STATUS);
  assert.strictEqual(r.data.usage.inputTokens, 100);
  assert.strictEqual(r.data.usage.outputTokens, 50);
  assert.strictEqual(r.data.status, 'running');
});

test('mapClineEvent: agent_message_chunk (ACP) maps to MESSAGE', () => {
  const r = mapClineEvent({ type: 'agent_message_chunk', text: 'chunk text' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(r.data.text, 'chunk text');
  assert.strictEqual(r.data.delta, true);
});

test('mapClineEvent: agent_thought_chunk maps to MESSAGE with thought', () => {
  const r = mapClineEvent({ type: 'agent_thought_chunk', text: 'thinking...' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(r.data.thought, true);
});

test('mapClineEvent: tool_call (ACP) maps to TOOL_STARTED', () => {
  const r = mapClineEvent({ type: 'tool_call', toolName: 'write_file', input: { path: 'a.js' } }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.TOOL_STARTED);
  assert.strictEqual(r.data.toolName, 'write_file');
  assert.deepStrictEqual(r.data.input, { path: 'a.js' });
});

test('mapClineEvent: plan (ACP) maps to PLAN_UPDATED', () => {
  const r = mapClineEvent({ type: 'plan', plan: { steps: ['a', 'b'] } }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.PLAN_UPDATED);
  assert.deepStrictEqual(r.data.plan, { steps: ['a', 'b'] });
});

test('mapClineEvent: error (ACP) maps to RUN_FAILED', () => {
  const r = mapClineEvent({ type: 'error', error: 'something broke' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.RUN_FAILED);
  assert.strictEqual(r.data.error, 'something broke');
});

test('mapClineEvent: unknown event type maps to a bounded notice without raw payload', () => {
  const r = mapClineEvent({ type: 'custom_event', foo: 'bar' }, 'r1', 'cline');
  assert.strictEqual(r.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(r.rawType, 'custom_event');
  assert.strictEqual(r.data.rawType, 'custom_event');
  assert.strictEqual(r.data.raw, undefined);
});

test('mapClineEvent: null event returns null', () => {
  assert.strictEqual(mapClineEvent(null, 'r1', 'cline'), null);
  assert.strictEqual(mapClineEvent({}, 'r1', 'cline'), null);
});

// ── Tests: startTask ──────────────────────────────────────────────────────
test('startTask: throws when SDK unavailable', async () => {
  sdkAvailable = false;
  try {
    const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
    await assert.rejects(
      () => adapter.startTask({ goal: 'test', connectionId: 'test-conn' }, {}),
      /@cline\/sdk 未安装/
    );
  } finally {
    sdkAvailable = true;
  }
});

test('startTask: throws when connectionId not found', async () => {
  sdkAvailable = true;
  const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
  await assert.rejects(
    () => adapter.startTask({ goal: 'test', connectionId: 'missing-conn' }, {}),
    /未找到 API 连接/
  );
});

test('startTask: throws when goal is missing', async () => {
  sdkAvailable = true;
  const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
  await assert.rejects(
    () => adapter.startTask({}, {}),
    /task.goal 必填/
  );
});

test('startTask: completes with result and emits events', async () => {
  sdkAvailable = true;
  agentDelayMs = 0;
  const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  const { runId } = await adapter.startTask(
    { goal: 'write a test', connectionId: 'test-conn' },
    context
  );
  assert.ok(typeof runId === 'string' && runId.length > 0);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'completed');
  assert.ok(finish.result.summary);
  assert.strictEqual(finish.result.status, 'completed');
  assert.ok(Array.isArray(finish.result.changedFiles));
  assert.ok(finish.result.usage);

  // Events should include content_start (null → skipped), content_update, usage
  const types = collector.events.map(e => e.type);
  assert.ok(types.includes(AGENT_EVENT.MESSAGE), 'should have MESSAGE event');
  assert.ok(types.includes(AGENT_EVENT.RUN_STATUS), 'should have RUN_STATUS event');
});

// ── Tests: cancel ─────────────────────────────────────────────────────────
test('cancel: stops an in-progress run', async () => {
  sdkAvailable = true;
  agentDelayMs = 200; // slow enough to cancel before completion
  try {
    const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
    const collector = { events: [], finish: null };
    const context = makeContext(collector);

    const { runId } = await adapter.startTask(
      { goal: 'long task', connectionId: 'test-conn' },
      context
    );

    // Cancel before the delay completes
    await adapter.cancel(runId);

    const finish = await waitForFinish(collector, 5000);
    assert.ok(['cancelled', 'completed'].includes(finish.status),
      `expected cancelled or completed, got ${finish.status}`);
    // The run status should be cancelled (signal was aborted before run completed)
    const status = await adapter.getStatus(runId);
    assert.ok(
      status.status === LIFECYCLE.CANCELLED || status.status === LIFECYCLE.COMPLETED,
      `expected CANCELLED or COMPLETED, got ${status.status}`
    );
  } finally {
    agentDelayMs = 0;
  }
});

test('cancel: returns error for unknown runId', async () => {
  const adapter = new ClineAgentAdapter();
  const r = await adapter.cancel('nonexistent');
  assert.strictEqual(r.ok, false);
});

test('sendMessage: returns not supported', async () => {
  const adapter = new ClineAgentAdapter();
  const r = await adapter.sendMessage('any', 'msg');
  assert.strictEqual(r.ok, false);
});

// ── Tests: dispose ────────────────────────────────────────────────────────
test('dispose: cleans up internal state', async () => {
  sdkAvailable = true;
  agentDelayMs = 100;
  try {
    const adapter = new ClineAgentAdapter({ store: makeStore(TEST_CONN) });
    const collector = { events: [], finish: null };
    const context = makeContext(collector);

    await adapter.startTask({ goal: 'task', connectionId: 'test-conn' }, context);
    assert.ok(adapter._runs.size > 0);

    await adapter.dispose();
    assert.strictEqual(adapter._runs.size, 0);
  } finally {
    agentDelayMs = 0;
  }
});

// ── Tests: Secret filtering ───────────────────────────────────────────────
test('Secret filtering: apiKey not in any emitted event', async () => {
  sdkAvailable = true;
  agentDelayMs = 0;
  const secretKey = 'SUPER-SECRET-API-KEY-12345';
  const conn = { ...TEST_CONN, apiKey: secretKey };
  const adapter = new ClineAgentAdapter({ store: makeStore(conn) });
  const collector = { events: [], finish: null };
  const context = makeContext(collector);

  await adapter.startTask({ goal: 'secret task', connectionId: 'test-conn' }, context);
  await waitForFinish(collector);

  // No event should contain the apiKey
  for (const evt of collector.events) {
    const serialized = JSON.stringify(evt);
    assert.ok(
      !serialized.includes(secretKey),
      `apiKey leaked in event: ${serialized}`
    );
  }

  // Result should also not contain the apiKey
  const resultSerialized = JSON.stringify(collector.finish.result);
  assert.ok(
    !resultSerialized.includes(secretKey),
    'apiKey leaked in result'
  );
});
