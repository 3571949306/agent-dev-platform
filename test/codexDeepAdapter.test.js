'use strict';
/**
 * v2.8.0 — test/codexDeepAdapter.test.js（spec §42/§43/§44/§45/§46/§65/§67/§79）。
 *
 * CodexAgentAdapter 深度集成选路。单测套路：
 *   - 预设 adapter._detected，跳过真实 CLI 探测
 *   - 注入 appServerClientFactory / execRunnerFactory 假实现
 *
 * 核心约束：
 *   - auto：app-server(primary) 失败 → 发 FALLBACK 事件 → exec（结构化 fallback）
 *   - 显式 runtimeMode 不静默降级
 *   - 进程意外退出 = FAILED（绝不 COMPLETED）；超时 ≠ 取消
 *   - capability 随实际运行时动态给（app-server 有 review/approval，exec 没有）
 *   - getAuthState 三分支，绝不读取凭据本体
 */
const test = require('node:test');
const assert = require('node:assert');

const { CodexAgentAdapter, RUNTIME_MODE } = require('../src/agents/adapters/codexAgentAdapter');
const { AGENT_EVENT } = require('../src/agents/hub/types');

/** 收集事件 + finishRun 的 context。 */
function makeContext(extra = {}) {
  const events = [];
  let resolveFinish;
  const finished = new Promise(res => { resolveFinish = res; });
  return {
    events,
    finished,
    context: {
      emit: (type, payload) => events.push(payload || { type }),
      finishRun: (status, result) => resolveFinish({ status, result }),
      projectRoot: 'C:/fake-proj',
      ...extra
    }
  };
}

/** 假 app-server client（形状对齐 createCodexAppServerClient 被适配器用到的面）。 */
function makeFakeAppServer(opts = {}) {
  const {
    connectError = null,
    turnStatus = 'completed',
    authenticated = true,
    exitOnTurn = null,
    threadId = 'thread-1'
  } = opts;
  const calls = [];
  let exitHandler = null;
  const client = {
    calls,
    onAnyNotification() {},
    onExit(fn) { exitHandler = fn; },
    onApproval(fn) { client._approval = fn; },
    async connect(o) { calls.push(['connect', o]); if (connectError) throw new Error(connectError); },
    probeMethods() { return { ok: true }; },
    async getAuthStatus() { return { ok: true, authenticated }; },
    async startThread(o) { calls.push(['startThread', o]); return { threadId }; },
    async resumeThread(o) { calls.push(['resumeThread', o]); return { threadId: o.threadId }; },
    async startTurn(o) {
      calls.push(['startTurn', o]);
      if (exitOnTurn && exitHandler) exitHandler(exitOnTurn);
      return { status: turnStatus };
    },
    async interruptTurn() {},
    dispose() { calls.push(['dispose']); }
  };
  return client;
}

/** 假 codex exec runner。 */
function makeFakeExecRunner(result) {
  const calls = [];
  const ok = result || {
    status: 'completed', summary: 'exec done', changedFiles: ['a.js'],
    diff: null, usage: null, plan: null, errors: [], threadId: 'exec-thread-1'
  };
  return { calls, async run(o) { calls.push(o); if (ok instanceof Error) throw ok; return ok; } };
}

function makeAdapter({ supportsAppServer = true, runtimeMode = 'auto', appServer, exec, config = {} } = {}) {
  let clientCreated = 0;
  const adapter = new CodexAgentAdapter({
    config: { runtimeMode, ...config },
    appServerClientFactory: () => { clientCreated++; return appServer || makeFakeAppServer(); },
    execRunnerFactory: () => exec || makeFakeExecRunner()
  });
  adapter._detected = { available: true, path: 'fake-codex', version: '0.0.0-fake', supportsAppServer };
  adapter._clientCreated = () => clientCreated;
  return adapter;
}

test('auto + supportsAppServer → 走 app-server（primary），能力按运行时回填', async () => {
  const appServer = makeFakeAppServer({ authenticated: true });
  const adapter = makeAdapter({ appServer });
  const { finished, context } = makeContext();

  await adapter.startTask({ goal: '修复 bug' }, context);
  const { status, result } = await finished;

  assert.strictEqual(status, 'completed');
  assert.strictEqual(result.runtime, RUNTIME_MODE.APP_SERVER);
  assert.strictEqual(result.sessionId, 'thread-1');
  assert.strictEqual(adapter.getActiveRuntime(), RUNTIME_MODE.APP_SERVER);
  // capability 动态回填：app-server 全套（含 review / approval）
  const caps = adapter.getManifest().capabilities;
  assert.strictEqual(caps.review, true);
  assert.strictEqual(caps.approval, true);
  // 登录状态只读缓存（不含凭据）
  assert.strictEqual(adapter._lastAuthStatus, 'authenticated');
  assert.ok(appServer.calls.some(c => c[0] === 'dispose'), 'Run 结束必须释放连接');
});

test('auto：app-server 失败 → FALLBACK 事件留痕 → 降级到 exec（spec §43）', async () => {
  const appServer = makeFakeAppServer({ connectError: 'app-server spawn 失败' });
  const exec = makeFakeExecRunner();
  const adapter = makeAdapter({ appServer, exec });
  const { finished, context, events } = makeContext();

  await adapter.startTask({ goal: '任务' }, context);
  const { result } = await finished;

  const fallback = events.find(e => e.type === AGENT_EVENT.FALLBACK);
  assert.ok(fallback, '降级必须发 FALLBACK 事件');
  assert.strictEqual(fallback.from, RUNTIME_MODE.APP_SERVER);
  assert.strictEqual(fallback.to, RUNTIME_MODE.EXEC);
  assert.strictEqual(result.runtime, RUNTIME_MODE.EXEC);
  // exec 运行时能力不含 review / approval（spec §45：不一律 true）
  const caps = adapter.getManifest().capabilities;
  assert.strictEqual(caps.review, false);
  assert.strictEqual(caps.approval, false);
  assert.strictEqual(exec.calls.length, 1);
});

test('显式 app-server 模式：失败不静默降级，直接 FAILED', async () => {
  const appServer = makeFakeAppServer({ connectError: 'boom' });
  const exec = makeFakeExecRunner();
  const adapter = makeAdapter({ appServer, exec, runtimeMode: 'app-server' });
  const { finished, context, events } = makeContext();

  await adapter.startTask({ goal: '任务' }, context);
  const { status, result } = await finished;

  assert.strictEqual(status, 'failed');
  assert.strictEqual(result.status, 'failed');
  assert.ok(!events.some(e => e.type === AGENT_EVENT.FALLBACK), '显式模式不允许静默降级');
  assert.strictEqual(exec.calls.length, 0, '绝不偷偷走 exec');
});

test('auto + 不支持 app-server → 直接 exec（不发 FALLBACK，不创建 app-server client）', async () => {
  const exec = makeFakeExecRunner();
  const adapter = makeAdapter({ supportsAppServer: false, exec });
  const { finished, context, events } = makeContext();

  await adapter.startTask({ goal: '任务' }, context);
  const { result } = await finished;

  assert.strictEqual(result.runtime, RUNTIME_MODE.EXEC);
  assert.ok(!events.some(e => e.type === AGENT_EVENT.FALLBACK));
  assert.strictEqual(adapter._clientCreated(), 0);
});

test('进程意外退出 → FAILED（即使 turn 报 completed，spec §65）', async () => {
  const appServer = makeFakeAppServer({
    turnStatus: 'completed',
    exitOnTurn: { clean: false, code: 137, signal: null, stderr: 'segfault' }
  });
  const adapter = makeAdapter({ appServer });
  const { finished, context, events } = makeContext();

  await adapter.startTask({ goal: '任务' }, context);
  const { status, result } = await finished;

  assert.strictEqual(status, 'failed', 'unexpected exit 不得判 COMPLETED');
  assert.ok(result.errors.some(e => e.includes('意外退出')));
  assert.ok(result.errors.some(e => e.includes('segfault')));
  assert.ok(events.some(e => e.type === AGENT_EVENT.RUN_FAILED));
});

test('turn timeout → 状态 timeout（超时 ≠ 取消，spec §67）', async () => {
  const appServer = makeFakeAppServer({ turnStatus: 'timeout' });
  const adapter = makeAdapter({ appServer });
  const { finished, context, events } = makeContext();

  await adapter.startTask({ goal: '任务', timeoutMs: 1000 }, context);
  const { status, result } = await finished;

  assert.strictEqual(status, 'timeout');
  assert.strictEqual(result.status, 'timeout');
  assert.ok(events.some(e => e.type === AGENT_EVENT.RUN_TIMEOUT));
  assert.ok(!events.some(e => e.type === AGENT_EVENT.RUN_CANCELLED));
});

test('resumeSessionId → resumeThread + 会话复用（Session ≠ Run）', async () => {
  const appServer = makeFakeAppServer();
  const adapter = makeAdapter({ appServer });
  const { finished, context } = makeContext();

  await adapter.startTask({ goal: '继续', resumeSessionId: 'thread-old' }, context);
  await finished;

  assert.ok(appServer.calls.some(c => c[0] === 'resumeThread' && c[1].threadId === 'thread-old'));
  assert.ok(!appServer.calls.some(c => c[0] === 'startThread'), 'resume 不得另起新 thread');
  const runId = [...adapter._runs.keys()][0];
  const status = await adapter.getStatus(runId);
  assert.strictEqual(status.sessionId, 'thread-old', 'Run 继续挂在旧 Session 上（Session ≠ Run）');
  assert.strictEqual(adapter.sessions.getByExternal(adapter.id, 'thread-old'), null, 'resume 不重复创建会话记录');
});

test('getAuthState 三分支：API_KEY / 登录态缓存 / UNKNOWN（绝不读凭据）', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    // 1) 显式 API Key
    const a1 = new CodexAgentAdapter({ config: { environment: { OPENAI_API_KEY: 'sk-test' } } });
    assert.strictEqual(a1.getAuthState().state, 'API_KEY');
    assert.strictEqual(a1.getAuthState().authenticated, true);

    // 2) app-server 曾回报登录态
    const a2 = new CodexAgentAdapter({});
    a2._lastAuthStatus = 'authenticated';
    assert.strictEqual(a2.getAuthState().state, 'AUTHENTICATED');
    a2._lastAuthStatus = 'required';
    assert.strictEqual(a2.getAuthState().state, 'AUTH_REQUIRED');
    assert.strictEqual(a2.getAuthState().authenticated, false);

    // 3) 平台不读凭据 → 无法核实 → UNKNOWN
    const a3 = new CodexAgentAdapter({});
    const st = a3.getAuthState();
    assert.strictEqual(st.state, 'UNKNOWN');
    assert.strictEqual(st.authenticated, false);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test('_decideApproval：交集评估 + 无 GUI 一律 decline（spec §35/§36）', async () => {
  const adapter = makeAdapter({});

  // 1) 只读父 Run + 写操作 → PARENT_READ_ONLY → decline
  const d1 = await adapter._decideApproval('fileChange', {}, { readOnly: true }, {}, 'run-1');
  assert.strictEqual(d1, 'decline');

  // 2) 交集通过 + 危险命令 + 无用户在场 → fail-closed decline（spec §26/§75）
  const d2 = await adapter._decideApproval('command', { command: 'git reset --hard HEAD~1' }, { readOnly: false }, {}, 'run-2');
  assert.strictEqual(d2, 'decline');

  // 2b) 交集通过 + LOW 风险命令 + 无用户在场 → 按 §26 自动放行（allow_once）
  const d2b = await adapter._decideApproval('command', { command: 'git status' }, { readOnly: false }, {}, 'run-2b');
  assert.strictEqual(d2b, 'accept');

  // 3) 交集通过 + GUI resolver accept → accept
  const ctx = makeContext({ onPermission: async () => 'accept' }).context;
  const d3 = await adapter._decideApproval('command', {}, { readOnly: false }, ctx, 'run-3');
  assert.strictEqual(d3, 'accept');

  // 4) resolver cancel → cancel
  const ctx2 = makeContext({ onPermission: async () => 'cancel' }).context;
  const d4 = await adapter._decideApproval('command', {}, { readOnly: false }, ctx2, 'run-4');
  assert.strictEqual(d4, 'cancel');
});
