'use strict';
/**
 * v2.8.0 — 通用 ACP Agent 适配器端到端测试（spec §27/§55/§56/§59/§65/§66/§67/§68/§106）。
 *
 * ── 这里刻意**不**打桩进程 ──────────────────────────────────────────────
 * 走真实 spawn / 真实 stdio 管道 / 真实分帧，对面是以子进程模式运行的
 * test/fakes/fakeAcpAgent.js（严格 ACP wire v1）。只有这样才能证明：
 *
 *   1. 终态判定正确：end_turn→COMPLETED、取消→CANCELLED、超时→TIMEOUT、
 *      进程意外退出→FAILED（绝不因为"prompt 返回了"就报成功）。
 *   2. 零 zombie：任何终态之后，本 Run spawn 的 PID 必须真的死掉。
 *   3. 只杀自己的进程（§106）：dispose 只回收本适配器 spawn 的 PID。
 *
 * 子进程用当前运行时自身启动（Electron 需要 ELECTRON_RUN_AS_NODE=1 才当 Node 用），
 * 该变量经 config.environment 显式注入 —— env allowlist 不会替我们透传它。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { AcpAgentAdapter } = require('../src/agents/adapters/acpAgentAdapter');
const { LIFECYCLE, AGENT_EVENT, ERROR_CODE } = require('../src/agents/hub/types');
const { ACP_ERROR } = require('../src/agents/protocols/acp/errors');
const { STOP_REASON, TOOL_KIND } = require('../src/agents/protocols/acp/constants');

const FAKE_AGENT = require.resolve('./fakes/fakeAcpAgent.js');
const PROJECT_ROOT = os.tmpdir();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MANIFEST = {
  id: 'fake-acp',
  displayName: 'Fake ACP Agent',
  transport: 'acp',
  capabilities: { coding: true },
  maxConcurrency: 1
};

/**
 * 造一个跑真实子进程的适配器。
 * @param {object} [agentConfig] fakeAcpAgent 的行为配置（经 env 传给子进程）
 * @param {object} [override]    适配器自身配置覆盖
 */
function makeAdapter(agentConfig = {}, override = {}) {
  return new AcpAgentAdapter({
    manifest: MANIFEST,
    config: {
      command: process.execPath,
      args: [FAKE_AGENT],
      environment: {
        // Electron 以 Node 模式运行本脚本；纯 Node 环境下该变量无害。
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_ACP_CONFIG: JSON.stringify(agentConfig)
      },
      cancelGraceMs: 1500,
      ...override
    }
  });
}

/** 采集事件 + 等待终态。 */
function makeContext(extra = {}) {
  const events = [];
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  return {
    events,
    done,
    types: () => events.map(e => e.type),
    has: (t) => events.some(e => e.type === t),
    projectRoot: PROJECT_ROOT,
    emit: (type, payload) => { events.push({ type, payload }); },
    finishRun: (lifecycle, result) => resolveDone({ lifecycle, result }),
    ...extra
  };
}

/** 等一个 PID 真正消失（Windows 的 taskkill 是异步的）。 */
async function waitForDead(pid, timeoutMs = 5000) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return true; // ESRCH：进程已不存在
    }
    await sleep(50);
  }
  return false;
}

/** 轮询等待 runState 拿到 sessionId（说明握手 + session/new 已完成）。 */
async function waitForSession(adapter, runId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await adapter.getStatus(runId);
    if (s && s.sessionId) return s;
    await sleep(20);
  }
  throw new Error('timed out waiting for session');
}

// ---------------------------------------------------------------------------
// detect / healthCheck
// ---------------------------------------------------------------------------

test('detect：命令不存在时 available=false（不抛错）', async () => {
  const adapter = new AcpAgentAdapter({
    manifest: MANIFEST,
    config: { command: path.join(os.tmpdir(), 'definitely-not-here-acp.exe') }
  });
  try {
    assert.deepStrictEqual(await adapter.detect(), { available: false, path: null });
    const h = await adapter.healthCheck();
    assert.strictEqual(h.status, 'unavailable');
  } finally { await adapter.dispose(); }
});

test('startTask：命令不可用时直接抛错，不产生僵尸 Run', async () => {
  const adapter = new AcpAgentAdapter({ manifest: MANIFEST, config: { command: '' } });
  try {
    await assert.rejects(
      () => adapter.startTask({ goal: 'x' }, makeContext()),
      /not available/
    );
  } finally { await adapter.dispose(); }
});

test('startTask：缺少 goal 时拒绝执行', async () => {
  const adapter = makeAdapter();
  try {
    await assert.rejects(() => adapter.startTask({}, makeContext()), /goal/);
  } finally { await adapter.dispose(); }
});

// ---------------------------------------------------------------------------
// 正常完成（真子进程）
// ---------------------------------------------------------------------------

test('端到端：真子进程跑完一轮 → COMPLETED，事件与产物齐全，进程被回收', async () => {
  const adapter = makeAdapter();
  const ctx = makeContext();
  try {
    const { runId } = await adapter.startTask({ goal: '改一下 demo', projectRoot: PROJECT_ROOT }, ctx);
    const status = await waitForSession(adapter, runId);
    const pid = status.pid;
    assert.ok(pid > 0, '应记录本 Run spawn 的 PID');

    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.COMPLETED);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stopReason, STOP_REASON.END_TURN);
    assert.strictEqual(result.summary, '准备修改文件。已完成修改。');
    assert.deepStrictEqual(result.changedFiles, ['src/demo.js']);
    assert.strictEqual(result.provenance.externalName, 'fake-acp-agent');

    // 事件流：RUN_STARTED 开头、RUN_COMPLETED 收尾，中间有工具/文件事件
    assert.strictEqual(ctx.events[0].type, AGENT_EVENT.RUN_STARTED);
    assert.strictEqual(ctx.events[ctx.events.length - 1].type, AGENT_EVENT.RUN_COMPLETED);
    assert.ok(ctx.has(AGENT_EVENT.MESSAGE));
    assert.ok(ctx.has(AGENT_EVENT.TOOL_STARTED));
    assert.ok(ctx.has(AGENT_EVENT.FILE_CHANGED));
    assert.ok(!ctx.has(AGENT_EVENT.RUN_FAILED), '不得同时发出失败事件');

    assert.strictEqual(await waitForDead(pid), true, '终态后必须零 zombie');
    assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.COMPLETED);
    assert.deepStrictEqual((await adapter.getResult(runId)).status, 'completed');
  } finally { await adapter.dispose(); }
});

test('端到端：refusal 也是终态 completed，但 ok=false 且只结算一次', async () => {
  const adapter = makeAdapter({ stopReason: STOP_REASON.REFUSAL, updates: [] });
  const ctx = makeContext();
  try {
    await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.COMPLETED);
    assert.strictEqual(result.ok, false);

    await sleep(150);
    const terminal = ctx.events.filter(e =>
      e.type === AGENT_EVENT.RUN_COMPLETED || e.type === AGENT_EVENT.RUN_FAILED ||
      e.type === AGENT_EVENT.RUN_CANCELLED || e.type === AGENT_EVENT.RUN_TIMEOUT);
    assert.strictEqual(terminal.length, 1, '终态事件只能发一次');
  } finally { await adapter.dispose(); }
});

// ---------------------------------------------------------------------------
// §65 意外退出 = FAILED
// ---------------------------------------------------------------------------

test('§65 Agent 进程中途退出 → FAILED（绝不当成 COMPLETED）', async () => {
  const adapter = makeAdapter({ exitOnPrompt: true });
  const ctx = makeContext();
  try {
    const { runId } = await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    const { lifecycle, result } = await ctx.done;

    assert.strictEqual(lifecycle, LIFECYCLE.FAILED);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.errorCode, ACP_ERROR.UNEXPECTED_EXIT);
    assert.ok(
      result.errors.some(e => /exited unexpectedly/.test(e)),
      '错误里要带上 code/signal 便于排障：' + JSON.stringify(result.errors)
    );
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_FAILED), true);
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_COMPLETED), false);
    assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.FAILED);
  } finally { await adapter.dispose(); }
});

// ---------------------------------------------------------------------------
// §66 取消 = CANCELLED
// ---------------------------------------------------------------------------

test('§66 用户取消 → CANCELLED（不是 FAILED），Agent 有机会自然收尾', async () => {
  // Agent 收到 cancel 后会以 stopReason='cancelled' 收尾，无需强杀
  const adapter = makeAdapter({ promptDelayMs: 8000 });
  const ctx = makeContext();
  try {
    const { runId } = await adapter.startTask({ goal: 'long task', projectRoot: PROJECT_ROOT }, ctx);
    const { pid } = await waitForSession(adapter, runId);

    const ack = await adapter.cancel(runId);
    assert.strictEqual(ack.ok, true);
    assert.strictEqual(ack.forced, false, '正常收尾不该走强杀兜底');

    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.CANCELLED);
    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_CANCELLED), true);
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_FAILED), false, '取消绝不能报成失败');
    assert.strictEqual(await waitForDead(pid), true);
  } finally { await adapter.dispose(); }
});

test('§66 Agent 无视 cancel → grace 到点强杀兜底，仍判 CANCELLED', async () => {
  const adapter = makeAdapter(
    { hangOnPrompt: true, ignoreCancel: true },
    { cancelGraceMs: 300 }
  );
  const ctx = makeContext();
  try {
    const { runId } = await adapter.startTask({ goal: 'stuck', projectRoot: PROJECT_ROOT }, ctx);
    const { pid } = await waitForSession(adapter, runId);

    const ack = await adapter.cancel(runId);
    assert.strictEqual(ack.forced, true, '超过 grace 必须强杀');

    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.CANCELLED);
    assert.strictEqual(result.errorCode, ERROR_CODE.AGENT_CANCELLED);
    assert.deepStrictEqual(result.errors, ['用户已停止']);
    assert.strictEqual(await waitForDead(pid), true, '强杀后不得留 zombie');
  } finally { await adapter.dispose(); }
});

test('cancel 未知 runId / 已终态 runId 都安全返回', async () => {
  const adapter = makeAdapter({ updates: [] });
  const ctx = makeContext();
  try {
    assert.deepStrictEqual(await adapter.cancel('nope'), { ok: false, error: 'unknown runId' });
    const { runId } = await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    await ctx.done;
    const ack = await adapter.cancel(runId);
    assert.strictEqual(ack.ok, true);
    assert.strictEqual(ack.alreadySettled, true);
  } finally { await adapter.dispose(); }
});

// ---------------------------------------------------------------------------
// §67 超时 = TIMEOUT（≠ 取消，≠ 失败）
// ---------------------------------------------------------------------------

test('§67 Agent 挂死 → TIMEOUT（既不是 CANCELLED 也不是 FAILED）', async () => {
  const adapter = makeAdapter({ hangOnPrompt: true }, { timeoutMs: 2500 });
  const ctx = makeContext();
  try {
    const { runId } = await adapter.startTask({ goal: 'hang', projectRoot: PROJECT_ROOT }, ctx);
    const { pid } = await waitForSession(adapter, runId);

    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.TIMEOUT);
    assert.strictEqual(result.status, 'timeout');
    assert.strictEqual(result.errorCode, ERROR_CODE.AGENT_TIMEOUT);
    assert.ok(result.errors.some(e => /timed out/.test(e)), JSON.stringify(result.errors));
    // 我方主动杀的，不该被描述成"意外退出"
    assert.ok(!result.errors.some(e => /unexpectedly/.test(e)));
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_TIMEOUT), true);
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_CANCELLED), false, '超时 ≠ 取消');
    assert.strictEqual(ctx.has(AGENT_EVENT.RUN_FAILED), false, '超时 ≠ 失败');
    assert.strictEqual(await waitForDead(pid), true);
    assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.TIMEOUT);
  } finally { await adapter.dispose(); }
});

// ---------------------------------------------------------------------------
// 能力协商 / 权限 / 凭据边界
// ---------------------------------------------------------------------------

test('§22 期望能力未满足 → FAILED，且失败前把进程收干净', async () => {
  const adapter = makeAdapter(
    { agentCapabilities: {} },
    { expectedAcpCapabilities: { resume: true } }
  );
  const ctx = makeContext();
  try {
    await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.FAILED);
    assert.strictEqual(result.errorCode, ACP_ERROR.CAPABILITY_NEGOTIATION_FAILED);
    assert.ok(/resume/.test(result.errors[0]));
  } finally { await adapter.dispose(); }
});

test('§36 只读任务下的 shell 权限请求被拒绝，Run 以 refusal 收尾', async () => {
  const adapter = makeAdapter({
    updates: [],
    requestPermission: {
      toolCallId: 'tc-1', title: 'rm -rf /', kind: TOOL_KIND.EXECUTE,
      rawInput: { command: 'rm -rf /' }
    }
  });
  const ctx = makeContext();
  try {
    await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT, readOnly: true }, ctx);
    const { lifecycle, result } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.COMPLETED);
    assert.strictEqual(result.stopReason, STOP_REASON.REFUSAL);
    assert.strictEqual(result.ok, false, '危险操作被拒不算成功产出');
  } finally { await adapter.dispose(); }
});

test('§30/§31 external_login 模式下绝不调用 ACP authenticate', async () => {
  const adapter = makeAdapter({
    authMethods: [{ id: 'oauth', name: 'OAuth', description: null }],
    updates: []
  });
  const ctx = makeContext();
  const seen = [];
  try {
    // 包一层 runtime 探针：只观察调用，不改变行为
    const origFactory = adapter._runtimeFactory;
    assert.strictEqual(origFactory, null, '默认不注入 runtimeFactory');

    const { createAcpClientRuntime } = require('../src/agents/protocols/acp/acpClientRuntime');
    const { createAcpProcessTransport } = require('../src/agents/protocols/acp/acpProcessTransport');
    adapter._runtimeFactory = (runState) => {
      const rt = createAcpClientRuntime({
        transportFactory: (o) => adapter._createTransport(runState, o)
      });
      return new Proxy(rt, {
        get(target, prop) {
          if (prop === 'authenticate') {
            return (...a) => { seen.push(a); return target.authenticate(...a); };
          }
          return target[prop];
        }
      });
    };

    await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    const { lifecycle } = await ctx.done;
    assert.strictEqual(lifecycle, LIFECYCLE.COMPLETED);
    assert.strictEqual(seen.length, 0, 'authMode=external_login 时平台不得介入凭据流程');
  } finally { await adapter.dispose(); }
});

test('§28 子进程 env 走 allowlist：不整体复制 process.env', async () => {
  const marker = 'ADP_SECRET_MARKER_' + Date.now();
  process.env[marker] = 'must-not-leak';
  const captured = [];
  const adapter = makeAdapter({ updates: [] });
  // 探针 supervisor：拦下 spawn 参数，其余行为不变
  const realSpawn = adapter.supervisor.spawnProcess.bind(adapter.supervisor);
  adapter.supervisor.spawnProcess = (opts) => { captured.push(opts); return realSpawn(opts); };

  const ctx = makeContext();
  try {
    await adapter.startTask({ goal: 'x', projectRoot: PROJECT_ROOT }, ctx);
    await ctx.done;
    assert.strictEqual(captured.length, 1);
    const env = captured[0].env;
    assert.ok(!(marker in env), '未列入 allowlist 的环境变量绝不能透传给外部 Agent');
    assert.strictEqual(env.FAKE_ACP_CONFIG !== undefined, true, '显式注入的配置应在');
  } finally {
    delete process.env[marker];
    await adapter.dispose();
  }
});

// ---------------------------------------------------------------------------
// §106 / §68 dispose 只回收自己的进程
// ---------------------------------------------------------------------------

test('§106/§68 dispose 回收本适配器的进程，且不碰别的适配器', async () => {
  const victim = makeAdapter({ hangOnPrompt: true });
  const bystander = makeAdapter({ hangOnPrompt: true });
  const ctxA = makeContext();
  const ctxB = makeContext();
  try {
    const a = await victim.startTask({ goal: 'a', projectRoot: PROJECT_ROOT }, ctxA);
    const b = await bystander.startTask({ goal: 'b', projectRoot: PROJECT_ROOT }, ctxB);
    const sa = await waitForSession(victim, a.runId);
    const sb = await waitForSession(bystander, b.runId);
    assert.notStrictEqual(sa.pid, sb.pid);

    await victim.dispose();
    assert.strictEqual(await waitForDead(sa.pid), true, '自己的进程必须收掉');

    // 旁观者的进程不受影响
    let bystanderAlive = true;
    try { process.kill(sb.pid, 0); } catch { bystanderAlive = false; }
    assert.strictEqual(bystanderAlive, true, '绝不能误杀其他适配器/用户自己的 CLI');
  } finally {
    await bystander.dispose();
    await victim.dispose();
  }
});
