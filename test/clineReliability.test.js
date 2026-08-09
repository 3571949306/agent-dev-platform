'use strict';
/**
 * Cline 运行可靠性测试（spec §7-§9 / §11-§23 / §37 / §39-§41 / §60）。
 *
 * 覆盖 v2.7.1 里被掩盖的真实失败场景：
 *   - agent.run() 返回值不含任何终态证据 → FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL
 *     （v2.7.1 无条件当 completed）
 *   - 超时 → TIMEOUT 且发 agent.run.timeout（v2.7.1 超时被写成 CANCELLED）
 *   - 用户取消 → CANCELLED 且发 agent.run.cancelled
 *   - 取消 / 超时之后才 resolve 的晚期结果被闸门忽略，终态恰好一次
 *   - 远端错误分类：401→AUTH_FAILED，404→SESSION_NOT_FOUND，5xx→REMOTE_ERROR
 *   - §37：projectRoot 真实传给 SDK；SDK 未接住时如实标注 warning，不假装已沙箱化
 *   - §40：结果不再携带完整 raw，只有脱敏后的 sanitizedRaw
 *   - §7/§8/§9：版本不伪造、导出缺失 = 不可用、构造不出实例 = degraded
 *
 * 通过 adapter 的 bridge 注入点直接控制 SDK 行为，不依赖 require.cache hack，
 * 也不消耗任何真实 API。
 */
const test = require('node:test');
const assert = require('node:assert');

const { ClineAgentAdapter } = require('../src/agents/adapters/clineAgentAdapter');
const { LIFECYCLE, AGENT_EVENT, HEALTH_STATE } = require('../src/agents/hub/types');

// ── Helpers ───────────────────────────────────────────────────────────────
function makeContext(collector) {
  return {
    emit: (type, data) => { collector.events.push({ type, data }); },
    finishRun: (status, result) => {
      collector.finishCount = (collector.finishCount || 0) + 1;
      collector.finish = { status, result };
    },
    signal: null
  };
}

async function waitForFinish(collector, timeoutMs = 8000) {
  const start = Date.now();
  while (!collector.finish && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!collector.finish) throw new Error('finishRun not called within timeout');
  return collector.finish;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpError(message, status) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

const CONN = { protocol: 'anthropic', apiKey: 'sk-clineconnsecret1', model: 'claude-sonnet-4-20250514' };

function makeStore(conn = CONN) {
  return { connections: { getDecrypted: (id) => (id === 'c1' ? conn : null) } };
}

const DEFAULT_PROBE = {
  available: true,
  installed: true,
  apiSurfaceOk: true,
  version: '1.2.3',
  versionSource: 'package.json',
  exports: { Agent: true, ClineCore: true },
  missing: [],
  error: null
};

/**
 * 可控 fake Agent。行为完全由 spec 决定。
 */
class ControllableAgent {
  constructor(config, onEvent, spec, state) {
    this._config = config;
    this._onEvent = onEvent;
    this._subs = [];
    this._spec = spec;
    this._state = state;
    this._cancelled = false;
    this._release = null;
    // §37：只有 spec.acceptCwd 时才「接住」workspace 根目录，用于验证适配器如实上报
    // spec 可能为 undefined（适配器 _verifyRuntime 兜底路径直接 new Agent(config) 不传 spec）
    if (spec && spec.acceptCwd && config.cwd) this.cwd = config.cwd;
  }

  subscribe(cb) { this._subs.push(cb); }

  cancel() {
    this._cancelled = true;
    this._state.cancelCount++;
    if (this._release) { const r = this._release; this._release = null; r(); }
  }

  _emit(evt) {
    if (this._onEvent) this._onEvent(evt);
    for (const cb of this._subs) { try { cb(evt); } catch { /* noop */ } }
  }

  async run(prompt) {
    const spec = this._spec;
    this._state.runCount++;
    for (const e of (spec.emitEvents || [])) this._emit(e);

    if (spec.throwError) throw spec.throwError();

    if (spec.hangMs != null) {
      // 挂起直到 cancel() 释放，或到达兜底时限
      await new Promise(resolve => {
        this._release = resolve;
        const t = setTimeout(resolve, spec.hangMs);
        if (typeof t.unref === 'function') t.unref();
      });
    } else if (spec.delayMs) {
      await sleep(spec.delayMs);
    }

    if (spec.throwAfterDelay) throw spec.throwAfterDelay();
    if (typeof spec.result === 'function') return spec.result(this, prompt);
    if ('result' in spec) return spec.result;
    return { text: 'done', usage: { inputTokens: 10, outputTokens: 5 }, iterations: 2 };
  }
}

/**
 * 构造可注入的 fake sdkBridge。
 * @param {object} spec { probe?, sdk?, result?, throwError?, hangMs?, delayMs?, emitEvents?, acceptCwd? }
 */
function makeBridge(spec = {}) {
  const state = { createdConfigs: [], agents: [], cancelCount: 0, runCount: 0 };
  const bridge = {
    probeSdk: async () => (spec.probe || DEFAULT_PROBE),
    loadSdk: async () => (spec.sdk !== undefined ? spec.sdk : { Agent: ControllableAgent }),
    createAgent: async (config, onEvent) => {
      state.createdConfigs.push(config);
      const agent = new ControllableAgent(config, onEvent, spec, state);
      state.agents.push(agent);
      return agent;
    }
  };
  bridge.state = state;
  return bridge;
}

function makeAdapter(spec = {}, opts = {}) {
  return new ClineAgentAdapter({
    store: makeStore(opts.conn),
    config: opts.config || {},
    bridge: makeBridge(spec)
  });
}

// ── §11/§12：无终态证据的返回 → FAILED ────────────────────────────────────
test('agent.run() resolves undefined → FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL', async () => {
  const adapter = makeAdapter({ result: undefined });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1', projectRoot: '/tmp/cl-noterm' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed', `expected failed, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL');
  assert.strictEqual(finish.result.ok, false, 'failed result must not claim ok=true');
  assert.ok(
    finish.result.errors.some(e => String(e).includes('without a terminal result')),
    'should record the missing-terminal reason'
  );
  await adapter.dispose();
});

test('agent.run() resolves empty object → FAILED (no terminal evidence)', async () => {
  const adapter = makeAdapter({ result: {} });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL');
  await adapter.dispose();
});

// ── §17/§18：超时 → TIMEOUT（不是 CANCELLED）──────────────────────────────
test('timeout → TIMEOUT (not CANCELLED), emits agent.run.timeout', async () => {
  const adapter = makeAdapter({ hangMs: 5000 }, { config: { timeoutMs: 120 } });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1', projectRoot: '/tmp/cl-timeout' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'timeout', `expected timeout, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_TIMEOUT');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_TIMEOUT), 'should emit agent.run.timeout');
  assert.ok(!collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'timeout must not emit cancelled');
  assert.strictEqual(finish.result.status, 'timeout');
  assert.strictEqual(finish.result.ok, false);
  await adapter.dispose();
});

// ── §16/§18：用户取消 → CANCELLED ─────────────────────────────────────────
test('user cancel → CANCELLED, emits agent.run.cancelled and calls agent.cancel()', async () => {
  const spec = { hangMs: 5000 };
  const adapter = makeAdapter(spec, { config: { timeoutMs: 100000 } });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1', projectRoot: '/tmp/cl-cancel' }, makeContext(collector));
  await sleep(30);

  const cr = await adapter.cancel(runId);
  assert.strictEqual(cr.ok, true);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled', `expected cancelled, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_CANCELLED');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'should emit agent.run.cancelled');
  assert.ok(adapter._bridge.state.cancelCount > 0, 'SDK agent.cancel() must actually be called');
  assert.ok(!collector.events.some(e => e.type === AGENT_EVENT.RUN_TIMEOUT), 'cancel must not emit timeout');
  await adapter.dispose();
});

// ── §20-§23：晚期结果被忽略，终态恰好一次 ────────────────────────────────
test('late completed result after cancel is ignored (terminal exactly once)', async () => {
  // 取消会释放挂起，run() 随后返回一个「成功」结果 —— 必须被闸门丢弃
  const adapter = makeAdapter({
    hangMs: 5000,
    result: { text: 'late success', usage: { inputTokens: 1, outputTokens: 1 }, iterations: 9 }
  }, { config: { timeoutMs: 100000 } });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));
  await sleep(30);
  await adapter.cancel(runId);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled');

  // 闸门已终态，任何后续 completed 都不被接受
  const tr = adapter._gate.transition(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.status, LIFECYCLE.CANCELLED);
  assert.strictEqual(tr.terminalCount, 1, 'terminal must happen exactly once');

  await sleep(80);
  assert.strictEqual(collector.finish.status, 'cancelled', 'late success must not overwrite cancelled');
  assert.strictEqual(collector.finishCount, 1, 'finishRun must fire exactly once');
  const st = await adapter.getStatus(runId);
  assert.strictEqual(st.status, LIFECYCLE.CANCELLED);
  await adapter.dispose();
});

test('late result after timeout is ignored (status stays timeout)', async () => {
  const adapter = makeAdapter({
    hangMs: 5000,
    result: { text: 'late after timeout', usage: {}, iterations: 1 }
  }, { config: { timeoutMs: 100 } });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'timeout');
  await sleep(80);
  assert.strictEqual(collector.finishCount, 1, 'finishRun must fire exactly once');
  assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.TIMEOUT);
  assert.ok(!String(JSON.stringify(collector.finish.result)).includes('late after timeout'));
  await adapter.dispose();
});

// ── §27/§36：远端错误分类 ─────────────────────────────────────────────────
test('SDK throws 401 → AUTH_FAILED', async () => {
  const adapter = makeAdapter({ throwError: () => httpError('cline provider rejected credentials (401)', 401) });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_AUTH_FAILED');
  await adapter.dispose();
});

test('SDK throws 404 → SESSION_NOT_FOUND；5xx → REMOTE_ERROR', async () => {
  const a404 = makeAdapter({ throwError: () => httpError('cline session gone (404)', 404) });
  const c404 = { events: [], finish: null };
  const r404 = await a404.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(c404));
  await waitForFinish(c404);
  assert.strictEqual(a404._gate.getState(r404.runId).terminalReason, 'AGENT_SESSION_NOT_FOUND');
  await a404.dispose();

  const a500 = makeAdapter({ throwError: () => httpError('cline upstream exploded (503)', 503) });
  const c500 = { events: [], finish: null };
  const r500 = await a500.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(c500));
  await waitForFinish(c500);
  assert.strictEqual(a500._gate.getState(r500.runId).terminalReason, 'AGENT_REMOTE_ERROR');
  await a500.dispose();
});

// ── §41：凭据不得进入结果 ─────────────────────────────────────────────────
test('secrets are stripped from result errors (§41)', async () => {
  const adapter = makeAdapter({
    throwError: () => httpError('auth rejected for Bearer sk-clineleak123 header', 401)
  });
  const collector = { events: [], finish: null };
  await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  const serialized = JSON.stringify(finish.result);
  assert.ok(!serialized.includes('sk-clineleak123'), 'api key must never appear in the result payload');
  assert.ok(serialized.includes('[REDACTED]'), 'secret should be replaced by [REDACTED]');
  await adapter.dispose();
});

// ── §40：结果不携带完整 raw ───────────────────────────────────────────────
test('result carries sanitizedRaw only, never the full raw payload (§40)', async () => {
  const adapter = makeAdapter({
    result: {
      text: 'done',
      usage: { inputTokens: 3, outputTokens: 4 },
      iterations: 2,
      internal: { apiKey: 'sk-rawleak999', transcript: 'x'.repeat(5000) }
    }
  });
  const collector = { events: [], finish: null };
  await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));
  const finish = await waitForFinish(collector);

  assert.strictEqual(finish.status, 'completed');
  assert.strictEqual(finish.result.raw, undefined, 'full raw must not be persisted (§40)');
  assert.ok(typeof finish.result.sanitizedRaw === 'string', 'sanitizedRaw should be a bounded string');
  assert.ok(finish.result.sanitizedRaw.length <= 2100, 'sanitizedRaw must be truncated');
  const serialized = JSON.stringify(finish.result);
  assert.ok(!serialized.includes('sk-rawleak999'), 'raw secrets must be redacted');
  assert.strictEqual(finish.result.ok, true);
  assert.strictEqual(finish.result.iterations, 2);
  await adapter.dispose();
});

// ── §37：projectRoot 必须真实传给 SDK ─────────────────────────────────────
test('§37: projectRoot is actually handed to the SDK constructor', async () => {
  const adapter = makeAdapter({ acceptCwd: true });
  const collector = { events: [], finish: null };
  const projectRoot = '/tmp/cl-workspace-real';
  await adapter.startTask({ goal: 'g', connectionId: 'c1', projectRoot }, makeContext(collector));
  const finish = await waitForFinish(collector);

  const cfg = adapter._bridge.state.createdConfigs[0];
  assert.strictEqual(cfg.cwd, projectRoot, 'cwd must be passed into the SDK agent config');
  assert.strictEqual(finish.result.provenance.projectRoot, projectRoot);
  assert.strictEqual(finish.result.provenance.projectRootApplied, true);
  assert.deepStrictEqual(finish.result.warnings, [], 'no warning when the SDK really accepts the workspace root');
  await adapter.dispose();
});

test('§37: SDK ignoring cwd is reported honestly, not silently assumed', async () => {
  const adapter = makeAdapter({ acceptCwd: false });
  const collector = { events: [], finish: null };
  const projectRoot = '/tmp/cl-workspace-ignored';
  await adapter.startTask({ goal: 'g', connectionId: 'c1', projectRoot }, makeContext(collector));
  const finish = await waitForFinish(collector);

  assert.strictEqual(adapter._bridge.state.createdConfigs[0].cwd, projectRoot, 'value must still be sent');
  assert.strictEqual(finish.result.provenance.projectRootApplied, false);
  assert.ok(
    finish.result.warnings.some(w => /§37|workspace scoping is unverified/.test(w)),
    'must warn that workspace scoping could not be verified'
  );
  await adapter.dispose();
});

// ── §7：版本不伪造 ────────────────────────────────────────────────────────
test('§7: version comes from SDK metadata; unknown stays null instead of a fabricated 0.0.72', async () => {
  const withVersion = makeAdapter({});
  const d1 = await withVersion.detect();
  assert.strictEqual(d1.version, '1.2.3');
  assert.strictEqual(d1.versionSource, 'package.json');
  await withVersion.dispose();

  const unknown = makeAdapter({
    probe: { available: true, installed: true, apiSurfaceOk: true, version: null, versionSource: 'unknown', missing: [], error: null }
  });
  const d2 = await unknown.detect();
  assert.strictEqual(d2.version, null, 'unknown version must stay null, never fabricated');
  assert.strictEqual(d2.versionSource, 'unknown');
  const h2 = await unknown.healthCheck();
  assert.strictEqual(h2.status, HEALTH_STATE.HEALTHY);
  assert.strictEqual(h2.version, null);
  assert.ok(!JSON.stringify({ d2, h2 }).includes('0.0.72'), 'the hardcoded 0.0.72 must be gone');
  await unknown.dispose();
});

// ── §8：导出缺失 = 已安装但不可用 ─────────────────────────────────────────
test('§8: SDK importable but expected exports missing → installed=true, configured=false, unavailable', async () => {
  const adapter = makeAdapter({
    probe: {
      available: false, installed: true, apiSurfaceOk: false,
      version: '9.9.9', versionSource: 'package.json',
      exports: { Agent: false }, missing: ['Agent'],
      error: '@cline/sdk loaded but expected exports are missing: Agent'
    }
  });
  const d = await adapter.detect();
  assert.strictEqual(d.installed, true, 'module did import');
  assert.strictEqual(d.configured, false, 'wrong API surface must not count as configured');
  assert.strictEqual(d.available, false);

  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.UNAVAILABLE);
  assert.ok(h.detection, 'health must carry detection state separately (§51)');
  assert.strictEqual(h.detection.available, false);

  await assert.rejects(
    () => adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext({ events: [], finish: null })),
    /@cline\/sdk 未安装/
  );
  await adapter.dispose();
});

// ── §9：构造不出运行时实例 → degraded ─────────────────────────────────────
test('§9: SDK loads but Agent has no run() → DEGRADED, not HEALTHY', async () => {
  const adapter = makeAdapter({ sdk: { Agent: class Broken {} } });
  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.DEGRADED, `expected degraded, got ${h.status}`);
  assert.ok(/run\(\)/.test(h.detail), 'detail must explain the missing run() method');
  await adapter.dispose();
});

test('§9: SDK loads but Agent export missing → UNAVAILABLE', async () => {
  const adapter = makeAdapter({ sdk: { NotAgent: class X {} } });
  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.UNAVAILABLE);
  await adapter.dispose();
});

// ── 结果诚实性：错误事件不会被 completed 掩盖 ─────────────────────────────
test('error events during the run are surfaced in the final result', async () => {
  const adapter = makeAdapter({
    emitEvents: [
      { type: 'content_update', contentType: 'text', text: 'partial ' },
      { type: 'error', error: 'tool write_file denied' }
    ],
    result: { text: 'finished anyway', usage: { inputTokens: 1, outputTokens: 1 }, iterations: 1 }
  });
  const collector = { events: [], finish: null };
  await adapter.startTask({ goal: 'g', connectionId: 'c1' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.ok(
    finish.result.errors.some(e => String(e).includes('tool write_file denied')),
    'run-level errors must not be swallowed'
  );
  await adapter.dispose();
});
