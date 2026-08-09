'use strict';
/**
 * OpenHands 运行可靠性测试（spec §12/§13 / §16-§18 / §21-§22 / §30-§34 / §39-§41 / §63）。
 *
 * 覆盖真实失败场景（v2.7.1 全部误判为 completed 或语义混淆）：
 *   - 事件流结束但没有终态事件 → FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL（不再 COMPLETED）
 *   - 超时 → TIMEOUT（不是 CANCELLED），并发 agent.run.timeout
 *   - 用户取消 → CANCELLED（发 agent.run.cancelled）并删除 conversation
 *   - 晚期 completed（取消之后到达）被闸门忽略，终态只发生一次
 *   - 远端错误分类：401→AUTH_FAILED，5xx→REMOTE_ERROR，404→SESSION_NOT_FOUND
 *   - §33 方案 B：仅安装未配置 serverUrl → installed=true / configured=false / available=false
 *   - §41：凭据不得进入结果 errors
 *
 * 用注入的 clientFactory 精确控制事件流，避免依赖真实 HTTP 时序（确定性）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { OpenHandsAgentAdapter } = require('../src/agents/adapters/openHandsAgentAdapter');
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

/** 等待 abort（用于模拟「服务端一直不给终态」的挂起流）。 */
function waitAbort(signal) {
  return new Promise(resolve => {
    if (!signal) return resolve();
    if (signal.aborted) return resolve();
    try { signal.addEventListener('abort', () => resolve(), { once: true }); }
    catch { resolve(); }
  });
}

function httpError(message, status) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

/**
 * 构造可注入的 fake OpenHands client 工厂。
 * @param {object} spec { createError?, stream?, health? }
 */
function makeClientFactory(spec = {}) {
  const state = { created: 0, deleted: [], workingDir: null, lastOpts: null };
  const factory = (opts) => {
    state.lastOpts = opts;
    return {
      async health() {
        return spec.health ? spec.health() : { healthy: true, version: 'fake-oh-1.0.0', httpStatus: 200 };
      },
      async createConversation(body) {
        state.created++;
        state.workingDir = body && body.working_dir;
        if (spec.createError) throw spec.createError();
        return { conversation_id: 'conv-fake-1' };
      },
      async sendMessage() { return { ok: true }; },
      async getEvents() { return []; },
      async deleteConversation(id) { state.deleted.push(id); return true; },
      async *websocketEvents(id, o) {
        if (spec.stream) { yield* spec.stream(o); return; }
        // 默认：正常完成
        yield { type: 'message', content: 'working' };
        yield { type: 'agent_state_changed', agent_state: 'finished' };
      },
      hasWebSocket: false
    };
  };
  factory.state = state;
  return factory;
}

const CFG = { serverUrl: 'http://127.0.0.1:65535', apiKey: 'sk-shouldnotleak123' };

// ── §12/§13：无终态的流结束 → FAILED ───────────────────────────────────────
test('event stream ends without terminal → FAILED (v2.7.1 wrongly reported completed)', async () => {
  const clientFactory = makeClientFactory({
    stream: async function* () {
      yield { type: 'message', content: 'partial work' };
      yield { type: 'action', action: 'edit', path: 'src/a.js' };
      // 流直接结束，没有任何 finished / error 事件
    }
  });
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-noterm' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed', `expected failed, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL');
  assert.strictEqual(finish.result.ok, false, 'failed result must not claim ok=true');
  assert.ok(
    finish.result.errors.some(e => String(e).includes('without a terminal event')),
    'should record the missing-terminal reason'
  );
  await adapter.dispose();
});

// ── §17/§18：超时 → TIMEOUT ────────────────────────────────────────────────
test('timeout → TIMEOUT (not CANCELLED), emits agent.run.timeout', async () => {
  const clientFactory = makeClientFactory({
    stream: async function* (o) {
      yield { type: 'message', content: 'starting' };
      await waitAbort(o && o.signal);
    }
  });
  const adapter = new OpenHandsAgentAdapter({
    config: { ...CFG, timeoutMs: 120 },
    clientFactory
  });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-timeout' }, makeContext(collector));

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'timeout', `expected timeout, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_TIMEOUT');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_TIMEOUT), 'should emit agent.run.timeout');
  assert.ok(!collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'timeout must not emit cancelled');
  await adapter.dispose();
});

// ── §16/§18：用户取消 → CANCELLED ─────────────────────────────────────────
test('user cancel → CANCELLED, emits agent.run.cancelled and deletes conversation', async () => {
  const clientFactory = makeClientFactory({
    stream: async function* (o) {
      yield { type: 'message', content: 'long task' };
      await waitAbort(o && o.signal);
    }
  });
  const adapter = new OpenHandsAgentAdapter({
    config: { ...CFG, timeoutMs: 100000 },
    clientFactory
  });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-cancel2' }, makeContext(collector));
  await new Promise(r => setTimeout(r, 30));

  const cr = await adapter.cancel(runId);
  assert.strictEqual(cr.ok, true);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled', `expected cancelled, got ${finish.status}`);
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_CANCELLED');
  assert.ok(collector.events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED), 'should emit agent.run.cancelled');
  assert.ok(clientFactory.state.deleted.includes('conv-fake-1'), 'cancel should delete the conversation');
  await adapter.dispose();
});

// ── §21/§22：晚期终态被忽略 ───────────────────────────────────────────────
test('late finished after cancel is ignored (terminal exactly once)', async () => {
  const clientFactory = makeClientFactory({
    stream: async function* (o) {
      yield { type: 'message', content: 'work' };
      await waitAbort(o && o.signal);
      // 取消之后服务端才推来的「完成」——必须被忽略
      yield { type: 'agent_state_changed', agent_state: 'finished' };
    }
  });
  const adapter = new OpenHandsAgentAdapter({
    config: { ...CFG, timeoutMs: 100000 },
    clientFactory
  });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-late' }, makeContext(collector));
  await new Promise(r => setTimeout(r, 30));
  await adapter.cancel(runId);

  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'cancelled');

  // 闸门已终态，任何后续 completed 都不被接受
  const tr = adapter._gate.transition(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.status, LIFECYCLE.CANCELLED);
  assert.strictEqual(tr.terminalCount, 1, 'terminal must happen exactly once');

  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(collector.finish.status, 'cancelled', 'late completed must not overwrite cancelled');
  assert.strictEqual(collector.finishCount, 1, 'finishRun must fire exactly once');
  await adapter.dispose();
});

// ── §27/§36：远端错误分类 ─────────────────────────────────────────────────
test('remote 401 on createConversation → AUTH_FAILED', async () => {
  const clientFactory = makeClientFactory({
    createError: () => httpError('createConversation failed: HTTP 401 unauthorized', 401)
  });
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-401' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_AUTH_FAILED');
  await adapter.dispose();
});

test('remote 500 on createConversation → REMOTE_ERROR', async () => {
  const clientFactory = makeClientFactory({
    createError: () => httpError('createConversation failed: HTTP 500 boom', 500)
  });
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-500' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_REMOTE_ERROR');
  await adapter.dispose();
});

test('conversation disappears mid-stream (404) → SESSION_NOT_FOUND', async () => {
  const clientFactory = makeClientFactory({
    stream: async function* () {
      yield { type: 'message', content: 'work' };
      throw httpError('getEvents failed: HTTP 404 conversation not found', 404);
    }
  });
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  const { runId } = await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-404' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'failed');
  assert.strictEqual(adapter._gate.getState(runId).terminalReason, 'AGENT_SESSION_NOT_FOUND');
  await adapter.dispose();
});

// ── §30-§33 方案 B：安装 ≠ 可用 ───────────────────────────────────────────
test('Plan B: no serverUrl → configured=false, available=false, health UNAVAILABLE, startTask rejects', async () => {
  const adapter = new OpenHandsAgentAdapter({});
  const d = await adapter.detect();
  assert.strictEqual(d.configured, false, 'must not claim configured without serverUrl');
  assert.strictEqual(d.available, false, 'must not claim available without serverUrl');
  assert.ok(typeof d.installed === 'boolean', 'installed must be reported separately from available');
  assert.ok(/not supported|not installed|not configured/i.test(d.detail || ''), 'detail must explain why');

  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.UNAVAILABLE);
  assert.ok(h.detection, 'health must carry detection state separately (§51)');
  assert.strictEqual(h.detection.available, false);

  await assert.rejects(
    () => adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-planb' }, makeContext({ events: [], finish: null })),
    /openhands not available/
  );
  await adapter.dispose();
});

test('Plan B: serverUrl configured → installed/configured/available all true', async () => {
  const clientFactory = makeClientFactory({});
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const d = await adapter.detect();
  assert.strictEqual(d.installed, true);
  assert.strictEqual(d.configured, true);
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.mode, 'remote');
  await adapter.dispose();
});

// ── §41：凭据不得泄漏进结果 ───────────────────────────────────────────────
test('secrets are stripped from result errors (§41)', async () => {
  const clientFactory = makeClientFactory({
    createError: () => httpError('auth rejected for Bearer sk-shouldnotleak123 header', 401)
  });
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  await adapter.startTask({ goal: 'g', projectRoot: '/tmp/oh-secret' }, makeContext(collector));
  const finish = await waitForFinish(collector);
  const serialized = JSON.stringify(finish.result);
  assert.ok(!serialized.includes('sk-shouldnotleak123'), 'api key must never appear in the result payload');
  assert.ok(serialized.includes('[REDACTED]'), 'secret should be replaced by [REDACTED]');
  await adapter.dispose();
});

// ── working_dir 真实传递 ──────────────────────────────────────────────────
test('working_dir is the projectRoot actually passed to the server', async () => {
  const clientFactory = makeClientFactory({});
  const adapter = new OpenHandsAgentAdapter({ config: CFG, clientFactory });
  const collector = { events: [], finish: null };
  const projectRoot = '/tmp/oh-workdir-real';
  await adapter.startTask({ goal: 'g', projectRoot }, makeContext(collector));
  const finish = await waitForFinish(collector);
  assert.strictEqual(finish.status, 'completed');
  assert.strictEqual(clientFactory.state.workingDir, projectRoot);
  await adapter.dispose();
});
