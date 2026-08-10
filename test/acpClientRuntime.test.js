'use strict';
/**
 * v2.8.0 — ACP 客户端运行时全链路测试（spec §21/§22/§23/§24/§35/§36/§57/§66）。
 *
 * ── 这组测试要证明的不是"我们和自己一致"，而是"我们和真实 Agent 一致"───
 * 对面是 test/fakes/fakeAcpAgent.js，它逐字实现 ACP **wire v1**，并对客户端的
 * 每一处协议违规记录 violation。因此几乎每个用例末尾都会断言：
 *
 *     assert.deepStrictEqual(state.violations, [])
 *
 * 只要我们退回 v2 alpha 的猜测形状（自造 sessionId / prompt 传字符串 /
 * session/cancel 当请求发 / 扁平 outcome），这些用例就会红。
 *
 * 链路是**真实**的：runtime → acpProcessTransport → structuredStreamDecoder
 * → jsonRpcSession，只有最底层的 spawn 被换成进程内 fake（快且确定性）。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeAcpAgent, EXEC_UPDATES } = require('./fakes/fakeAcpAgent');
const { createCliProcessSupervisor } = require('../src/agents/runtime/cliProcessSupervisor');
const { createAcpProcessTransport } = require('../src/agents/protocols/acp/acpProcessTransport');
const {
  createAcpClientRuntime, toContentBlocks, classifyStopReason
} = require('../src/agents/protocols/acp/acpClientRuntime');
const { ACP_ERROR } = require('../src/agents/protocols/acp/errors');
const { AGENT_EVENT } = require('../src/agents/hub/types');
const {
  METHOD, NOTIFICATION, STOP_REASON, TOOL_KIND, TOOL_CALL_STATUS,
  PERMISSION_OPTION_KIND, PERMISSION_OUTCOME, SUPPORTED_PROTOCOL_VERSION
} = require('../src/agents/protocols/acp/constants');

const PROJECT_ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const OUTSIDE_PATH = process.platform === 'win32' ? 'C:\\etc\\passwd' : '/etc/passwd';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 组装一条真实链路（唯一的替身是 spawn）。
 * @param {object} [config] fakeAcpAgent 的配置
 */
function harness(config = {}) {
  const fake = createFakeAcpAgent(config);
  const supervisor = createCliProcessSupervisor({
    spawnImpl: fake.spawnImpl,
    killTreeImpl: fake.killTreeImpl,
    resolveImpl: fake.resolveImpl
  });
  const factory = createAcpProcessTransport({ supervisor });
  const runtime = createAcpClientRuntime({ transportFactory: (o) => factory.connect(o) });

  const h = {
    fake,
    supervisor,
    runtime,
    child: () => fake.lastChild(),
    state: () => fake.lastChild().engine.state,
    sent: (method) => fake.lastChild().engine.state.received.filter(r => r.method === method),
    connect: (extra = {}) => runtime.connect({
      command: 'fake-acp', args: ['--acp'], cwd: PROJECT_ROOT, agentId: 'fake-agent', ...extra
    }),
    /** connect + session/new，返回 Agent 生成的 sessionId。 */
    async boot(extra = {}) {
      await h.connect(extra);
      const s = await runtime.createSession({ projectRoot: PROJECT_ROOT, parentRunId: 'run-1' });
      return s.externalSessionId;
    },
    cleanup: () => { try { runtime.disconnect(); } catch { /* noop */ } }
  };
  return h;
}

/** 收集 prompt 期间发射的统一事件。 */
function collector() {
  const events = [];
  return {
    events,
    onEvent: (type, payload) => events.push({ type, payload }),
    typesOf: () => events.map(e => e.type),
    first: (type) => events.find(e => e.type === type) || null,
    all: (type) => events.filter(e => e.type === type)
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('toContentBlocks：字符串 → [{type:text}]，空串 → []', () => {
  assert.deepStrictEqual(toContentBlocks('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepStrictEqual(toContentBlocks(''), []);
  assert.deepStrictEqual(toContentBlocks(null), []);
});

test('toContentBlocks：已是 ContentBlock / ContentBlock[] 时原样透传', () => {
  const link = { type: 'resource_link', uri: 'file:///a.js', name: 'a.js' };
  assert.deepStrictEqual(toContentBlocks(link), [link]);
  assert.deepStrictEqual(toContentBlocks([link, 'tail']), [link, { type: 'text', text: 'tail' }]);
  // 非法元素被剔除，绝不把垃圾塞进 wire
  assert.deepStrictEqual(toContentBlocks([null, 42, link]), [link]);
});

test('classifyStopReason：5 个 v1 枚举各自的终态语义', () => {
  assert.deepStrictEqual(classifyStopReason(STOP_REASON.END_TURN), { status: 'completed', ok: true, errors: [] });
  assert.strictEqual(classifyStopReason(STOP_REASON.MAX_TOKENS).truncated, true);
  assert.strictEqual(classifyStopReason(STOP_REASON.MAX_TURN_REQUESTS).truncated, true);
  assert.strictEqual(classifyStopReason(STOP_REASON.REFUSAL).ok, false);
  assert.strictEqual(classifyStopReason(STOP_REASON.REFUSAL).status, 'completed');
  assert.strictEqual(classifyStopReason(STOP_REASON.CANCELLED).status, 'cancelled');
});

test('classifyStopReason：stopReason 缺失是协议违规 → failed（绝不当成功）', () => {
  const v = classifyStopReason(undefined);
  assert.strictEqual(v.status, 'failed');
  assert.match(v.errors[0], /stopReason is required/);
});

// ---------------------------------------------------------------------------
// initialize 握手
// ---------------------------------------------------------------------------

test('initialize 用 v1 形状握手（clientCapabilities/clientInfo），Agent 无违规', async () => {
  const h = harness();
  try {
    const hs = await h.connect();
    assert.strictEqual(hs.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
    assert.strictEqual(hs.agentInfo.name, 'fake-acp-agent');

    const st = h.state();
    assert.strictEqual(st.initialized, true);
    assert.deepStrictEqual(st.clientInfo.name, 'Agent Dev Platform');
    // 诚实声明：未实现 fs/terminal 就不能声明 true（否则 Agent 会调到 METHOD_NOT_FOUND）
    assert.strictEqual(st.clientCapabilities.fs.readTextFile, false);
    assert.strictEqual(st.clientCapabilities.terminal, false);
    assert.deepStrictEqual(st.violations, []);
  } finally { h.cleanup(); }
});

test('v1 baseline 能力不在 capabilities 里：agent 未声明 session 也不得判失败', async () => {
  // 真实 codex-acp 就不会声明 "session" 能力（baseline 强制支持）
  const h = harness({ agentCapabilities: {} });
  try {
    const hs = await h.connect();
    assert.strictEqual(hs.acpFlags.sessions, true, 'baseline 恒为 true');
    assert.strictEqual(hs.acpFlags.prompt, true);
    assert.strictEqual(hs.acpFlags.cancel, true);
    assert.strictEqual(hs.acpFlags.resume, false, '未声明的可选扩展才是 false');
    assert.deepStrictEqual(h.state().violations, []);
  } finally { h.cleanup(); }
});

test('协议版本高于客户端上限 → PROTOCOL_UNSUPPORTED（不得降级硬发）', async () => {
  const h = harness({ protocolVersion: 2 });
  try {
    await assert.rejects(() => h.connect(), err => {
      assert.strictEqual(err.code, ACP_ERROR.PROTOCOL_UNSUPPORTED);
      assert.match(err.message, /exceeds client max/);
      return true;
    });
  } finally { h.cleanup(); }
});

test('协议版本非法（非整数）→ PROTOCOL_UNSUPPORTED', async () => {
  const h = harness({ protocolVersion: 'v1' });
  try {
    await assert.rejects(() => h.connect(), err => err.code === ACP_ERROR.PROTOCOL_UNSUPPORTED);
  } finally { h.cleanup(); }
});

test('expectedCapabilities 未满足 → CAPABILITY_NEGOTIATION_FAILED', async () => {
  const h = harness({ agentCapabilities: { sessionCapabilities: { close: {} } } });
  try {
    await assert.rejects(
      () => h.connect({ expectedCapabilities: { resume: true } }),
      err => {
        assert.strictEqual(err.code, ACP_ERROR.CAPABILITY_NEGOTIATION_FAILED);
        assert.match(err.message, /resume/);
        return true;
      }
    );
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

test('session/new 只发 {cwd, mcpServers}，sessionId 由 Agent 生成并回传', async () => {
  const h = harness();
  try {
    const sessionId = await h.boot();
    assert.strictEqual(sessionId, 'fake-session-1', 'sessionId 必须来自 NewSessionResponse');

    const [req] = h.sent(METHOD.SESSION_NEW);
    assert.ok(req, '应发出 session/new');
    assert.strictEqual(req.params.cwd, PROJECT_ROOT);
    assert.deepStrictEqual(req.params.mcpServers, [], 'mcpServers 是 required，无 MCP 时传空数组');
    assert.ok(!('sessionId' in req.params), '客户端不得自造 sessionId');
    assert.deepStrictEqual(h.state().violations, []);
  } finally { h.cleanup(); }
});

test('session/new 缺 projectRoot → SESSION_CREATE_FAILED（cwd 是必填绝对路径）', async () => {
  const h = harness();
  try {
    await h.connect();
    await assert.rejects(
      () => h.runtime.createSession({}),
      err => err.code === ACP_ERROR.SESSION_CREATE_FAILED
    );
    assert.strictEqual(h.sent(METHOD.SESSION_NEW).length, 0, '参数不合法时不得发到 wire 上');
  } finally { h.cleanup(); }
});

test('Agent 未回 sessionId → fail-closed 抛 SESSION_CREATE_FAILED（绝不自造一个）', async () => {
  const h = harness({ omitSessionId: true });
  try {
    await h.connect();
    await assert.rejects(
      () => h.runtime.createSession({ projectRoot: PROJECT_ROOT }),
      err => {
        assert.strictEqual(err.code, ACP_ERROR.SESSION_CREATE_FAILED);
        assert.match(err.message, /did not return a sessionId/);
        return true;
      }
    );
  } finally { h.cleanup(); }
});

test('Agent 未声明 resume 能力时请求 resume → RESUME_UNSUPPORTED', async () => {
  const h = harness({ agentCapabilities: {} });
  try {
    await h.connect();
    await assert.rejects(
      () => h.runtime.createSession({ projectRoot: PROJECT_ROOT, resumeSessionId: 'sess-x' }),
      err => err.code === ACP_ERROR.RESUME_UNSUPPORTED
    );
  } finally { h.cleanup(); }
});

test('additionalDirectories 仅在 Agent 声明该扩展时才发（避免未知字段）', async () => {
  const extra = process.platform === 'win32' ? 'C:\\shared' : '/shared';

  const off = harness({ agentCapabilities: {} });
  try {
    await off.connect();
    await off.runtime.createSession({ projectRoot: PROJECT_ROOT, additionalDirectories: [extra] });
    assert.ok(!('additionalDirectories' in off.sent(METHOD.SESSION_NEW)[0].params));
  } finally { off.cleanup(); }

  const on = harness({ agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } });
  try {
    await on.connect();
    await on.runtime.createSession({ projectRoot: PROJECT_ROOT, additionalDirectories: [extra] });
    assert.deepStrictEqual(on.sent(METHOD.SESSION_NEW)[0].params.additionalDirectories, [extra]);
  } finally { on.cleanup(); }
});

// ---------------------------------------------------------------------------
// session/prompt + 事件映射
// ---------------------------------------------------------------------------

test('session/prompt 发 ContentBlock[]，end_turn → completed，summary 来自 chunk 累积', async () => {
  const h = harness();
  const c = collector();
  try {
    const sessionId = await h.boot();
    const res = await h.runtime.prompt({
      sessionId, runId: 'run-1', agentId: 'fake-agent', message: '改一下 demo', onEvent: c.onEvent
    });

    const [req] = h.sent(METHOD.SESSION_PROMPT);
    assert.ok(Array.isArray(req.params.prompt), 'prompt 必须是 ContentBlock[]');
    assert.deepStrictEqual(req.params.prompt, [{ type: 'text', text: '改一下 demo' }]);
    assert.strictEqual(req.params.sessionId, sessionId);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.stopReason, STOP_REASON.END_TURN);
    // v1 PromptResponse 没有任何文本字段，summary 只能来自 agent_message_chunk
    assert.strictEqual(res.summary, '准备修改文件。已完成修改。');
    assert.deepStrictEqual(res.changedFiles, ['src/demo.js']);
    assert.deepStrictEqual(res.usage, { used: 1200, size: 200000, cost: null });
    assert.strictEqual(res.provenance.transport, 'acp');
    assert.strictEqual(res.provenance.externalName, 'fake-acp-agent');
    assert.deepStrictEqual(h.state().violations, []);
  } finally { h.cleanup(); }
});

test('流式 session/update → 统一 AGENT_EVENT（thought/plan/message/tool/file）', async () => {
  const h = harness();
  const c = collector();
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'run-1', agentId: 'fake-agent', message: 'go', onEvent: c.onEvent
    });

    const types = new Set(c.typesOf());
    assert.ok(types.has(AGENT_EVENT.REASONING), 'agent_thought_chunk → REASONING');
    assert.ok(types.has(AGENT_EVENT.PLAN_UPDATED), 'plan → PLAN_UPDATED');
    assert.ok(types.has(AGENT_EVENT.MESSAGE), 'agent_message_chunk → MESSAGE');
    assert.ok(types.has(AGENT_EVENT.TOOL_STARTED));
    assert.ok(types.has(AGENT_EVENT.TOOL_COMPLETED));
    assert.ok(types.has(AGENT_EVENT.FILE_CHANGED));

    const started = c.first(AGENT_EVENT.TOOL_STARTED);
    assert.strictEqual(started.payload.toolId, 'tool-1');
    assert.strictEqual(started.payload.kind, TOOL_KIND.EDIT);
    assert.strictEqual(started.payload.runId, 'run-1');
    assert.strictEqual(started.payload.agentId, 'fake-agent');
  } finally { h.cleanup(); }
});

test('execute 类工具 → COMMAND_STARTED / COMMAND_OUTPUT / COMMAND_COMPLETED', async () => {
  const h = harness({ updates: EXEC_UPDATES });
  const c = collector();
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'run-1', agentId: 'fake-agent', message: 'run tests', onEvent: c.onEvent
    });

    assert.strictEqual(c.first(AGENT_EVENT.COMMAND_STARTED).payload.command, 'npm test');
    assert.strictEqual(c.first(AGENT_EVENT.COMMAND_OUTPUT).payload.chunk, '2 passing\n');
    assert.strictEqual(c.first(AGENT_EVENT.COMMAND_COMPLETED).payload.exitCode, 0);
  } finally { h.cleanup(); }
});

test('max_tokens → completed + truncated；refusal → completed 但 ok=false', async () => {
  const trunc = harness({ stopReason: STOP_REASON.MAX_TOKENS, updates: [] });
  try {
    const sid = await trunc.boot();
    const r = await trunc.runtime.prompt({ sessionId: sid, runId: 'r', agentId: 'a', message: 'x' });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.truncated, true);
  } finally { trunc.cleanup(); }

  const refused = harness({ stopReason: STOP_REASON.REFUSAL, updates: [] });
  try {
    const sid = await refused.boot();
    const r = await refused.runtime.prompt({ sessionId: sid, runId: 'r', agentId: 'a', message: 'x' });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /refused/);
  } finally { refused.cleanup(); }
});

test('空 message → PROMPT_FAILED（不发空 prompt 到 wire）', async () => {
  const h = harness();
  try {
    const sessionId = await h.boot();
    await assert.rejects(
      () => h.runtime.prompt({ sessionId, runId: 'r', agentId: 'a', message: '' }),
      err => err.code === ACP_ERROR.PROMPT_FAILED
    );
    assert.strictEqual(h.sent(METHOD.SESSION_PROMPT).length, 0);
  } finally { h.cleanup(); }
});

test('流中混入畸形行不影响本次 Run（单条畸形只告警，不判定流损坏）', async () => {
  const h = harness({ emitMalformedLine: true });
  try {
    const sessionId = await h.boot();
    const res = await h.runtime.prompt({ sessionId, runId: 'r', agentId: 'a', message: 'x' });
    assert.strictEqual(res.status, 'completed');
    assert.deepStrictEqual(h.state().violations, []);
  } finally { h.cleanup(); }
});

test('未连接就 prompt / createSession → HANDSHAKE_FAILED', async () => {
  const h = harness();
  await assert.rejects(
    () => h.runtime.createSession({ projectRoot: PROJECT_ROOT }),
    err => err.code === ACP_ERROR.HANDSHAKE_FAILED
  );
  await assert.rejects(
    () => h.runtime.prompt({ sessionId: 's', runId: 'r', agentId: 'a', message: 'x' }),
    err => err.code === ACP_ERROR.HANDSHAKE_FAILED
  );
});

// ---------------------------------------------------------------------------
// 权限桥（§35 交集 / §36 绝不自动放行）
// ---------------------------------------------------------------------------

const SHELL_TOOL_CALL = {
  toolCallId: 'tool-perm',
  title: 'Run npm install',
  kind: TOOL_KIND.EXECUTE,
  status: TOOL_CALL_STATUS.PENDING,
  rawInput: { command: 'npm install' }
};

test('只读父 Run + shell 请求 → 选 reject_once，响应是 v1 嵌套信封', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [] });
  try {
    const sessionId = await h.boot();
    const res = await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'install',
      context: { parentRunPermission: 'read' }
    });

    const st = h.state();
    assert.strictEqual(st.permissionOutcome, 'rejected');
    // 形状必须是 {outcome:{outcome:'selected', optionId}}，不是扁平 {outcome:'approved'}
    assert.strictEqual(st.permissionResponse.outcome.outcome, PERMISSION_OUTCOME.SELECTED);
    assert.strictEqual(st.permissionResponse.outcome.optionId, 'reject-once');
    assert.deepStrictEqual(st.violations, []);
    // 被拒 → Agent 以 refusal 收尾
    assert.strictEqual(res.stopReason, STOP_REASON.REFUSAL);
  } finally { h.cleanup(); }
});

test('无 GUI resolver 且交集拒绝 → 默认拒绝（不得静默放行）', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [] });
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write', platformPolicy: ['read_file'] }
    });
    assert.strictEqual(h.state().permissionOutcome, 'rejected');
  } finally { h.cleanup(); }
});

test('GUI 批准 → 选 allow_once，绝不替用户升级成 allow_always（§36）', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [], continueOnPermissionDenied: true });
  const seen = [];
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write' },
      onPermission: async (req) => { seen.push(req); return { granted: true }; }
    });

    const st = h.state();
    assert.strictEqual(st.permissionOutcome, 'allowed');
    assert.strictEqual(st.permissionResponse.outcome.optionId, 'allow-once');
    assert.notStrictEqual(st.permissionResponse.outcome.optionId, 'allow-always');
    assert.deepStrictEqual(st.violations, []);

    // resolver 拿到的是已映射好的规范请求 + 交集评估结论
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].operation, 'run_shell');
    assert.strictEqual(seen[0].toolCallId, 'tool-perm');
    assert.strictEqual(seen[0].evaluation.granted, true);
  } finally { h.cleanup(); }
});

test('交集通过但 GUI 拒绝 → 仍然拒绝（GUI 决定权高于交集结论）', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [] });
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write' },
      onPermission: async () => ({ granted: false })
    });
    assert.strictEqual(h.state().permissionOutcome, 'rejected');
  } finally { h.cleanup(); }
});

test('批准但 Agent 只给了 reject 选项 → fail-closed 回退到 reject', async () => {
  const h = harness({
    requestPermission: SHELL_TOOL_CALL,
    updates: [],
    permissionOptions: [{ optionId: 'r-only', name: '拒绝', kind: PERMISSION_OPTION_KIND.REJECT_ONCE }]
  });
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write' },
      onPermission: async () => ({ granted: true })
    });
    const st = h.state();
    assert.strictEqual(st.permissionOutcome, 'rejected');
    assert.strictEqual(st.permissionResponse.outcome.optionId, 'r-only');
    assert.deepStrictEqual(st.violations, [], '绝不能伪造一个不存在的 optionId');
  } finally { h.cleanup(); }
});

test('Agent 给了空 options[] → 回 cancelled（绝不伪造 optionId）', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [], permissionOptions: [] });
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write' },
      onPermission: async () => ({ granted: true })
    });
    const st = h.state();
    assert.strictEqual(st.permissionOutcome, 'cancelled');
    assert.strictEqual(st.permissionResponse.outcome.outcome, PERMISSION_OUTCOME.CANCELLED);
    assert.deepStrictEqual(st.violations, []);
  } finally { h.cleanup(); }
});

test('read 越界（projectRoot 之外）被判为 read_outside_root', async () => {
  const h = harness({
    updates: [],
    requestPermission: {
      toolCallId: 'tool-read',
      title: 'Read secrets',
      kind: TOOL_KIND.READ,
      locations: [{ path: OUTSIDE_PATH }]
    }
  });
  const seen = [];
  try {
    const sessionId = await h.boot();
    await h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'read' },
      onPermission: async (req) => { seen.push(req); return { granted: false }; }
    });
    assert.strictEqual(seen[0].operation, 'read_outside_root');
    assert.deepStrictEqual(seen[0].locations, [OUTSIDE_PATH]);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// cancel（§66）
// ---------------------------------------------------------------------------

test('session/cancel 必须以**通知**发送，Run 以 stopReason=cancelled 收尾', async () => {
  const h = harness({ promptDelayMs: 2000 });
  try {
    const sessionId = await h.boot();
    const p = h.runtime.prompt({ sessionId, runId: 'r', agentId: 'a', message: 'x' });
    await sleep(30);

    // 打标是同步的：Adapter 需要在 prompt 尚未 settle 时就能区分 CANCELLED / FAILED
    const ackPromise = h.runtime.cancel({ sessionId });
    assert.strictEqual(h.runtime.isCancelled(), true, 'cancel 应立即打标');
    const ack = await ackPromise;
    assert.strictEqual(ack.ok, true);

    const res = await p;
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(res.stopReason, STOP_REASON.CANCELLED);
    // Run 终态后上下文即清理，isCancelled 只描述"当前 Run"
    assert.strictEqual(h.runtime.isCancelled(), false, '终态后 Run 上下文应已释放');

    const [cancelMsg] = h.sent(NOTIFICATION.SESSION_CANCEL);
    assert.ok(cancelMsg, '应发出 session/cancel');
    assert.strictEqual(cancelMsg.isNotification, true, 'cancel 是通知，当请求发会永久挂起');
    assert.strictEqual(cancelMsg.params.sessionId, sessionId);
    assert.deepStrictEqual(h.state().violations, []);
  } finally { h.cleanup(); }
});

test('取消时挂起的 request_permission 必须以 cancelled 回掉（协议强制）', async () => {
  const h = harness({ requestPermission: SHELL_TOOL_CALL, updates: [], promptDelayMs: 2000 });
  let resolverEntered = false;
  try {
    const sessionId = await h.boot();
    const p = h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      context: { parentRunPermission: 'write' },
      // 模拟 GUI 弹窗久久没人点：永不 resolve
      onPermission: () => { resolverEntered = true; return new Promise(() => {}); }
    });
    await sleep(40);
    assert.strictEqual(resolverEntered, true, '权限请求应已到达 resolver');

    await h.runtime.cancel({ sessionId });
    const res = await p;

    assert.strictEqual(res.status, 'cancelled');
    const st = h.state();
    assert.strictEqual(st.permissionOutcome, 'cancelled', 'Agent 不能被永远卡在等审批');
    assert.deepStrictEqual(st.violations, []);
  } finally { h.cleanup(); }
});

test('取消后到达的权限请求直接回 cancelled，不再打扰 GUI', async () => {
  const h = harness({ updates: [], hangOnPrompt: true, ignoreCancel: true });
  try {
    const sessionId = await h.boot();
    const p = h.runtime.prompt({
      sessionId, runId: 'r', agentId: 'a', message: 'x',
      onPermission: async () => { throw new Error('取消后不应再询问用户'); }
    });
    await sleep(20);
    await h.runtime.cancel({ sessionId });
    // Agent 无视 cancel，仍然挂起 → 由 disconnect 收尾（pending 请求以 CANCELLED reject）
    h.runtime.disconnect();
    await assert.rejects(() => p, err => err.code === ACP_ERROR.CANCELLED);
  } finally { h.cleanup(); }
});

test('未连接时 cancel 返回 not connected 而不是抛错', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.runtime.cancel({ sessionId: 'x' }), { ok: false, reason: 'not connected' });
});

// ---------------------------------------------------------------------------
// 生命周期回收（§27/§65/§68）
// ---------------------------------------------------------------------------

test('closeSession 仅在 Agent 声明 close 能力时才发', async () => {
  const off = harness({ agentCapabilities: {} });
  try {
    const sid = await off.boot();
    await off.runtime.closeSession(sid);
    assert.strictEqual(off.sent(METHOD.SESSION_CLOSE).length, 0);
  } finally { off.cleanup(); }

  const on = harness();
  try {
    const sid = await on.boot();
    await on.runtime.closeSession(sid);
    assert.strictEqual(on.sent(METHOD.SESSION_CLOSE).length, 1);
  } finally { on.cleanup(); }
});

test('disconnect 杀掉 agent 进程并复位状态（零 zombie）', async () => {
  const h = harness();
  await h.boot();
  const child = h.child();
  assert.strictEqual(child.killed, false);

  h.runtime.disconnect();
  assert.strictEqual(child.killed, true, 'ACP 进程必须被回收');
  assert.strictEqual(h.runtime.isConnected(), false);
  assert.strictEqual(h.runtime.getHandshake(), null);
});

test('Agent 中途崩溃 → 挂起的 prompt 以 ACP_CANCELLED 被拒绝（不会永久挂起）', async () => {
  const h = harness({ exitOnPrompt: true });
  try {
    const sessionId = await h.boot();
    await assert.rejects(
      () => h.runtime.prompt({ sessionId, runId: 'r', agentId: 'a', message: 'x' }),
      err => err.code === ACP_ERROR.CANCELLED
    );
  } finally { h.cleanup(); }
});

test('Session ≠ Run：会话按 parentRunId 可反查，且持久化视图不含凭据（§109/§111）', async () => {
  const h = harness();
  try {
    const sessionId = await h.boot();
    const mgr = h.runtime.getSessionManager();

    const rec = mgr.getByRun('run-1');
    assert.ok(rec, '应能按 parentRunId 反查会话');
    assert.strictEqual(rec.externalSessionId, sessionId);
    assert.strictEqual(rec.transport, 'acp');
    assert.strictEqual(rec.projectRoot, PROJECT_ROOT);
    // Session 有自己的主键，绝不与 runId 硬绑定为同一值
    assert.notStrictEqual(rec.id, 'run-1');
    assert.notStrictEqual(rec.id, sessionId);

    // 同一 Session 可承载后续多个 Run
    mgr.linkRun('run-2', 'fake-agent', sessionId);
    assert.strictEqual(mgr.getByRun('run-2').id, rec.id);

    const persisted = mgr.toPersistable(rec);
    assert.strictEqual(persisted.external_session_id, sessionId);
    const keys = Object.keys(persisted).join(',');
    assert.ok(!/token|key|secret|credential/i.test(keys), '持久化视图不得含凭据字段');
  } finally { h.cleanup(); }
});
