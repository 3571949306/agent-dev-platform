'use strict';
/**
 * v2.8.0 — Claude Code 三态适配器测试（spec §45/§49/§50/§51/§52/§53/§64/§65/§66/§67/§106）
 *
 * 这是本次交付里分支最多的一块：同一个适配器要同时服务 SDK / CLI / ACP 三条运行时，
 * 而三者的能力**并不相同**。测试重点因此不在"能跑通"，而在以下几类容易悄悄出错的地方：
 *
 *   1) 选路与留痕：auto 链降级必须发 FALLBACK 事件，显式指定模式绝不静默降级。
 *      否则用户会"以为在用 SDK，其实在跑没有逐次审批的 CLI"。
 *   2) 能力如实声明（§45）：CLI 的 approval / interrupt 必须是 false，不许一律 true。
 *   3) 安全红线（§36）：canUseTool 缺省 deny；bypassPermissions 永远进不去。
 *   4) 终态语义（§65/§67）：流没给 result 就是 FAILED；超时和取消是两种终态。
 *   5) 收尾唯一性（§64）：终态只发一次；ACP 委派后本适配器不得再发一遍。
 *
 * 全部依赖注入（sdkLoader / supervisorFactory / acpAdapterFactory），不碰真实 claude 进程。
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const {
  ClaudeCodeAgentAdapter, RUNTIME_MODE, RUNTIME_CAPABILITIES,
  buildCliArgs, createInputQueue, sanitizePermissionMode, operationForTool,
  READONLY_DISALLOWED_TOOLS
} = require('../src/agents/adapters/claudeCodeAgentAdapter');
const { AGENT_EVENT, LIFECYCLE, HEALTH_STATE } = require('../src/agents/hub/types');
const { createCliProcessSupervisor } = require('../src/agents/runtime/cliProcessSupervisor');
const permissionBroker = require('../src/agents/protocols/acp/permissionBroker');
const {
  MESSAGE_TYPE, SYSTEM_SUBTYPE, RESULT_SUBTYPE, CONTENT_BLOCK, PERMISSION_MODE
} = require('../src/agents/protocols/claude/claudeConstants');

// ===========================================================================
// 工具函数
// ===========================================================================

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** node:test 在事件循环排空时会判定"测试未完成"，等待 unref 计时器的用例需要保活。 */
async function withKeepAlive(fn) {
  const ka = setInterval(() => {}, 20);
  try { return await fn(); } finally { clearInterval(ka); }
}

const tick = (n = 1) => new Promise(res => {
  let i = 0;
  const step = () => (++i >= n ? res() : setImmediate(step));
  setImmediate(step);
});

/**
 * 条件式等待。
 * ACP 模式下 detect() 会真的去 PATH 里找 claude-agent-acp（spawn where/which），
 * 耗时不可预测，固定 tick 数会导致假失败 —— 一律用条件等待。
 */
async function waitFor(fn, { timeoutMs = 5000, label = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** 上下文记录器：事件 + finishRun 完成信号。 */
function makeContext(extra = {}) {
  const events = [];
  const done = deferred();
  return {
    events,
    done: done.promise,
    ofType: t => events.filter(e => e.type === t).map(e => e.payload),
    types: () => events.map(e => e.type),
    context: {
      emit: (type, payload) => { events.push({ type, payload }); },
      finishRun: (status, result) => done.resolve({ status, result }),
      ...extra
    }
  };
}

const INIT_MSG = {
  type: MESSAGE_TYPE.SYSTEM, subtype: SYSTEM_SUBTYPE.INIT,
  session_id: 'sess-1', model: 'claude-sonnet-4', tools: ['Read', 'Bash']
};
const TEXT_MSG = {
  type: MESSAGE_TYPE.ASSISTANT,
  message: { content: [{ type: CONTENT_BLOCK.TEXT, text: '已完成重构' }] }
};
const RESULT_OK = {
  type: MESSAGE_TYPE.RESULT, subtype: RESULT_SUBTYPE.SUCCESS, is_error: false,
  session_id: 'sess-1', result: '已完成重构',
  usage: { input_tokens: 10, output_tokens: 4 }, total_cost_usd: 0.002, num_turns: 1
};

/**
 * 假 Claude Agent SDK。
 * @param {object} spec
 * @param {Array} [spec.messages] 依次产出的消息；元素为函数时会被调用（可 await，返回 null 表示不产出）
 * @param {Function} [spec.onInterrupt] q.interrupt() 时回调
 * @param {string}   [spec.queryThrows] 非空则 query() 直接抛错
 * @param {boolean}  [spec.noQuery] true = 导出对象里没有 query（模拟装了包但版本不对）
 */
function fakeSdk(spec = {}) {
  const calls = [];
  const mod = {};
  if (!spec.noQuery) {
    mod.query = ({ prompt, options }) => {
      const rec = { prompt, options, closed: false, interrupts: 0, modes: [], models: [] };
      calls.push(rec);
      if (spec.queryThrows) throw new Error(spec.queryThrows);

      const iterator = (async function* gen() {
        for (const m of (spec.messages || [])) {
          if (typeof m === 'function') {
            const v = await m(rec);
            if (v != null) yield v;
          } else {
            yield m;
          }
        }
      })();

      const q = {
        [Symbol.asyncIterator]() { return iterator; },
        close() { rec.closed = true; },
        async interrupt() { rec.interrupts += 1; if (spec.onInterrupt) spec.onInterrupt(rec); },
        async setPermissionMode(m) { rec.modes.push(m); },
        async setModel(m) { rec.models.push(m); }
      };
      rec.q = q;
      return q;
    };
  }
  return { mod, calls, last: () => calls[calls.length - 1] };
}

/**
 * 假 claude CLI 进程工厂（同时服务 `--version` 探测与主运行）。
 */
function fakeCli(o = {}) {
  const {
    version = '1.2.3', stdoutLines = [], exitCode = 0, stderr = '',
    autoClose = true, spawnError = null
  } = o;
  const runs = [];      // 主运行的 spawn 记录
  const kills = [];

  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const stdinChunks = [];
    child.stdin = new Writable({ write(c, e, cb) { stdinChunks.push(c.toString()); cb(); } });
    child.stdinData = () => stdinChunks.join('');
    child.stdinEnded = false;
    child.stdin.on('finish', () => { child.stdinEnded = true; });
    child.kill = () => {};

    // `--version` 探测：单独短路，不计入主运行记录
    if (args.length === 1 && args[0] === '--version') {
      child.pid = 1000;
      setImmediate(() => {
        child.stdout.write(String(version));
        child.emit('close', 0, null);
      });
      return child;
    }

    if (spawnError) throw new Error(spawnError);
    child.pid = 8000 + runs.length;
    runs.push({ cmd, args, opts, child });

    setImmediate(() => {
      for (const line of stdoutLines) {
        child.stdout.write(typeof line === 'string' ? line : JSON.stringify(line) + '\n');
      }
      if (stderr) child.stderr.write(stderr);
      if (autoClose) setImmediate(() => child.emit('close', exitCode, null));
    });
    return child;
  };

  const killTreeImpl = (child, sig) => { kills.push({ pid: child.pid, sig }); };

  return {
    runs, kills,
    lastRun: () => runs[runs.length - 1] || null,
    lastArgs: () => (runs[runs.length - 1] || {}).args || [],
    supervisorFactory: (available = true) => () => createCliProcessSupervisor({
      spawnImpl, killTreeImpl,
      resolveImpl: async cmd => (available && cmd === 'claude' ? '/usr/bin/claude' : null)
    })
  };
}

/** 组装适配器（默认：SDK 与 CLI 都可用）。 */
function makeAdapter(o = {}) {
  const cli = o.cli || fakeCli(o.cliSpec || {});
  const sdk = o.sdk === null ? null : (o.sdk || fakeSdk({ messages: [INIT_MSG, TEXT_MSG, RESULT_OK] }));
  const adapter = new ClaudeCodeAgentAdapter({
    config: o.config || {},
    sdkLoader: o.sdkLoader || (sdk ? () => sdk.mod : () => { throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"); }),
    supervisorFactory: cli.supervisorFactory(o.cliAvailable !== false),
    acpAdapterFactory: o.acpAdapterFactory
  });
  return { adapter, sdk, cli };
}

/** 假 ACP 委派适配器。 */
function fakeAcpDelegate(o = {}) {
  const calls = { ctor: [], start: [], cancel: [], dispose: 0, sendMessage: [] };
  const factory = (opts) => {
    calls.ctor.push(opts);
    return {
      async startTask(task, context) { calls.start.push({ task, context }); return { runId: 'acp-run-1' }; },
      async getStatus() { return { status: o.status || LIFECYCLE.COMPLETED, sessionId: 'acp-sess' }; },
      async getResult() { return o.result || { status: 'completed', summary: 'acp done', errors: [] }; },
      async cancel(id) { calls.cancel.push(id); return { ok: true }; },
      async sendMessage(id, m) { calls.sendMessage.push({ id, m }); return { ok: true }; },
      async dispose() { calls.dispose += 1; }
    };
  };
  return { factory, calls };
}

// ===========================================================================
// 纯函数：buildCliArgs（spec §53 —— 只用公开官方 flag）
// ===========================================================================

test('buildCliArgs：最小形态固定为 -p --output-format stream-json --verbose', () => {
  assert.deepStrictEqual(buildCliArgs(), ['-p', '--output-format', 'stream-json', '--verbose']);
});

test('buildCliArgs：任何组合下都绝不出现 --dangerously-skip-permissions（spec §36）', () => {
  const combos = [
    {}, { permissionMode: 'plan' }, { permissionMode: 'bypassPermissions' },
    { extraArgs: ['--dangerously-skip-permissions'] }
  ];
  for (const c of combos) {
    const args = buildCliArgs(c);
    if (c.extraArgs) {
      // extraArgs 是调用方自负的逃生口，但适配器自身逻辑绝不主动加它
      assert.ok(args.includes('--dangerously-skip-permissions'), 'extraArgs 原样透传');
    } else {
      assert.ok(!args.includes('--dangerously-skip-permissions'));
    }
  }
  // 适配器实际调用 buildCliArgs 时从不传 extraArgs（见 _runCli），下方集成用例会再验一次
});

test('buildCliArgs：resume 与 session-id 互斥，resume 优先', () => {
  const a = buildCliArgs({ resumeSessionId: 'sess-9', sessionId: 'sess-new' });
  assert.ok(a.includes('--resume'));
  assert.strictEqual(a[a.indexOf('--resume') + 1], 'sess-9');
  assert.ok(!a.includes('--session-id'), 'resume 时不得再下发 --session-id');
});

test('buildCliArgs：fork-session 只在 resume 时附加', () => {
  assert.ok(buildCliArgs({ resumeSessionId: 's', forkSession: true }).includes('--fork-session'));
  assert.ok(!buildCliArgs({ sessionId: 's', forkSession: true }).includes('--fork-session'));
  assert.ok(!buildCliArgs({ forkSession: true }).includes('--fork-session'));
});

test('buildCliArgs：无 resume 时用 --session-id', () => {
  const a = buildCliArgs({ sessionId: 'uuid-1' });
  assert.strictEqual(a[a.indexOf('--session-id') + 1], 'uuid-1');
});

test('buildCliArgs：allowedTools / disallowedTools 展开为多值而非逗号串', () => {
  const a = buildCliArgs({ allowedTools: ['Read', 'Glob'], disallowedTools: ['Bash', 'Write'] });
  const ai = a.indexOf('--allowedTools');
  assert.deepStrictEqual(a.slice(ai + 1, ai + 3), ['Read', 'Glob']);
  const di = a.indexOf('--disallowedTools');
  assert.deepStrictEqual(a.slice(di + 1, di + 3), ['Bash', 'Write']);
});

test('buildCliArgs：空数组不产生空 flag（空 --allowedTools 会被 CLI 当成语法错误）', () => {
  const a = buildCliArgs({ allowedTools: [], disallowedTools: [], addDirs: [] });
  assert.ok(!a.includes('--allowedTools'));
  assert.ok(!a.includes('--disallowedTools'));
  assert.ok(!a.includes('--add-dir'));
});

test('buildCliArgs：每个 addDir 各带一个 --add-dir，空值跳过', () => {
  const a = buildCliArgs({ addDirs: ['/a', '', null, '/b'] });
  assert.strictEqual(a.filter(x => x === '--add-dir').length, 2);
  assert.ok(a.includes('/a') && a.includes('/b'));
});

test('buildCliArgs：maxTurns 仅在正整数时下发', () => {
  assert.ok(buildCliArgs({ maxTurns: 3 }).includes('--max-turns'));
  for (const bad of [0, -1, NaN, null, undefined, 'x']) {
    assert.ok(!buildCliArgs({ maxTurns: bad }).includes('--max-turns'), `maxTurns=${bad} 不应下发`);
  }
});

test('buildCliArgs：includePartialMessages 是开关型 flag', () => {
  assert.ok(buildCliArgs({ includePartialMessages: true }).includes('--include-partial-messages'));
  assert.ok(!buildCliArgs({ includePartialMessages: false }).includes('--include-partial-messages'));
});

test('buildCliArgs：extraArgs 过滤非字符串项，避免把对象拼进命令行', () => {
  const a = buildCliArgs({ extraArgs: ['--foo', 42, null, { x: 1 }, '--bar'] });
  assert.ok(a.includes('--foo') && a.includes('--bar'));
  assert.ok(!a.some(x => typeof x !== 'string'));
});

// ===========================================================================
// 纯函数：sanitizePermissionMode（安全红线）
// ===========================================================================

test('sanitizePermissionMode：readOnly 一律强制 plan，无视传入值', () => {
  for (const m of [null, 'default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']) {
    assert.strictEqual(sanitizePermissionMode(m, true), PERMISSION_MODE.PLAN, `readOnly + ${m}`);
  }
});

test('sanitizePermissionMode：bypassPermissions 永远回落 default（spec §36）', () => {
  assert.strictEqual(sanitizePermissionMode(PERMISSION_MODE.BYPASS, false), PERMISSION_MODE.DEFAULT);
});

test('sanitizePermissionMode：白名单内原样通过，白名单外回落 default', () => {
  assert.strictEqual(sanitizePermissionMode('plan', false), 'plan');
  assert.strictEqual(sanitizePermissionMode('acceptEdits', false), 'acceptEdits');
  assert.strictEqual(sanitizePermissionMode('default', false), 'default');
  for (const bad of ['dontAsk', 'auto', 'yolo', '', null, undefined, 123]) {
    assert.strictEqual(sanitizePermissionMode(bad, false), PERMISSION_MODE.DEFAULT, `${bad} 必须回落`);
  }
});

// ===========================================================================
// 纯函数：operationForTool（工具 → 权限操作类别）
// ===========================================================================

test('operationForTool：Bash 归 run_shell，写类工具归 write_file', () => {
  assert.strictEqual(operationForTool('Bash'), permissionBroker.OPERATION.RUN_SHELL);
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.strictEqual(operationForTool(t), permissionBroker.OPERATION.WRITE_FILE, t);
  }
});

test('operationForTool：读类与计划类归 other（只读父 Run 下不应被拦）', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'TodoWrite']) {
    assert.strictEqual(operationForTool(t), permissionBroker.OPERATION.OTHER, t);
  }
});

test('operationForTool：mcp__ 前缀归 mcp，其余未知工具归 other', () => {
  assert.strictEqual(operationForTool('mcp__ide__getDiagnostics'), permissionBroker.OPERATION.MCP);
  assert.strictEqual(operationForTool('WebFetch'), permissionBroker.OPERATION.OTHER);
  assert.strictEqual(operationForTool(undefined), permissionBroker.OPERATION.OTHER);
});

test('operationForTool + broker：只读父 Run 下 Bash/Write 被拒，Read 放行', () => {
  const deny = (tool) => permissionBroker.evaluate(
    { operation: operationForTool(tool), scope: tool }, { parentRunPermission: 'read' }
  ).granted;
  assert.strictEqual(deny('Bash'), false);
  assert.strictEqual(deny('Write'), false);
  assert.strictEqual(deny('Read'), true);
});

// ===========================================================================
// 纯函数：createInputQueue（streaming input 是 interrupt 的前提）
// ===========================================================================

test('createInputQueue：初始消息按序产出后随 close 结束', async () => {
  const q = createInputQueue(['a', 'b']);
  const out = [];
  const p = (async () => { for await (const v of q.iterable) out.push(v); })();
  q.close();
  await p;
  assert.deepStrictEqual(out, ['a', 'b']);
});

test('createInputQueue：消费者等待时 push 立即唤醒（运行中插话的关键路径）', async () => {
  const q = createInputQueue();
  const out = [];
  const p = (async () => { for await (const v of q.iterable) { out.push(v); if (out.length === 2) break; } })();
  await tick();
  q.push('x');
  await tick();
  q.push('y');
  await p;
  assert.deepStrictEqual(out, ['x', 'y']);
});

test('createInputQueue：close 后 push 返回 false 且不再产出', async () => {
  const q = createInputQueue();
  q.close();
  assert.strictEqual(q.push('late'), false);
  assert.strictEqual(q.isClosed(), true);
  const out = [];
  for await (const v of q.iterable) out.push(v);
  assert.deepStrictEqual(out, []);
});

test('createInputQueue：提前 break 触发 return() 自动关闭队列', async () => {
  const q = createInputQueue(['a', 'b', 'c']);
  for await (const v of q.iterable) { if (v === 'a') break; }
  assert.strictEqual(q.isClosed(), true, 'break 后必须关闭，否则 SDK 子进程会一直等输入');
});

// ===========================================================================
// 能力声明（spec §45：不允许一律 true）
// ===========================================================================

test('RUNTIME_CAPABILITIES：CLI 如实降级 —— 没有逐次审批也没有中断', () => {
  assert.strictEqual(RUNTIME_CAPABILITIES[RUNTIME_MODE.CLI].approval, false);
  assert.strictEqual(RUNTIME_CAPABILITIES[RUNTIME_MODE.CLI].interrupt, false);
  assert.strictEqual(RUNTIME_CAPABILITIES[RUNTIME_MODE.SDK].approval, true);
  assert.strictEqual(RUNTIME_CAPABILITIES[RUNTIME_MODE.SDK].interrupt, true);
});

test('RUNTIME_CAPABILITIES：三条运行时都不谎报 sandbox（Claude 自身不提供沙箱）', () => {
  for (const mode of [RUNTIME_MODE.SDK, RUNTIME_MODE.CLI, RUNTIME_MODE.ACP]) {
    assert.strictEqual(RUNTIME_CAPABILITIES[mode].sandbox, false, mode);
  }
});

test('getManifest：未运行时不臆造运行时能力，运行后才叠加', async () => {
  const { adapter } = makeAdapter();
  assert.strictEqual(adapter.getActiveRuntime(), null);
  assert.strictEqual(adapter.getManifest().capabilities.approval, undefined);

  const c = makeContext();
  await adapter.startTask({ goal: '干活' }, c.context);
  await c.done;
  assert.strictEqual(adapter.getActiveRuntime(), RUNTIME_MODE.SDK);
  assert.strictEqual(adapter.getManifest().capabilities.approval, true);
  await adapter.dispose();
});

test('getManifest：CLI 运行后能力必须显示为不可审批 / 不可中断', async () => {
  const { adapter } = makeAdapter({
    sdk: null,
    cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  await adapter.startTask({ goal: '干活' }, c.context);
  await c.done;
  const caps = adapter.getManifest().capabilities;
  assert.strictEqual(caps.approval, false);
  assert.strictEqual(caps.interrupt, false);
  await adapter.dispose();
});

// ===========================================================================
// detect / healthCheck
// ===========================================================================

test('detect：SDK 与 CLI 都在 → 全可用并带回版本号', async () => {
  const { adapter } = makeAdapter();
  const d = await adapter.detect();
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.sdkAvailable, true);
  assert.strictEqual(d.cliAvailable, true);
  assert.strictEqual(d.version, '1.2.3');
  assert.strictEqual(d.sdkError, null);
  await adapter.dispose();
});

test('detect：SDK 缺包时记录原因而不是静默吞掉', async () => {
  const { adapter } = makeAdapter({ sdk: null });
  const d = await adapter.detect();
  assert.strictEqual(d.sdkAvailable, false);
  assert.match(d.sdkError, /Cannot find module/);
  assert.strictEqual(d.cliAvailable, true);
  assert.strictEqual(d.available, true, 'CLI 还在就仍算可用');
  await adapter.dispose();
});

test('detect：装了包但没导出 query() 视为不可用并说明原因', async () => {
  const bad = fakeSdk({ noQuery: true });
  const { adapter } = makeAdapter({ sdk: bad });
  const d = await adapter.detect();
  assert.strictEqual(d.sdkAvailable, false);
  assert.match(d.sdkError, /未导出 query\(\)/);
  await adapter.dispose();
});

test('detect：结果被缓存，重复调用不再重新探测', async () => {
  const { adapter } = makeAdapter();
  const a = await adapter.detect();
  const b = await adapter.detect();
  assert.strictEqual(a, b, 'detect 必须返回同一对象，否则健康检查会反复拉起 --version 进程');
  await adapter.dispose();
});

test('healthCheck：两条路都没有 → UNAVAILABLE 且给出可操作提示', async () => {
  const { adapter } = makeAdapter({ sdk: null, cliAvailable: false });
  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.UNAVAILABLE);
  assert.match(h.detail, /未检测到/);
  assert.ok(h.latencyMs >= 0);
  await adapter.dispose();
});

test('healthCheck：仅 CLI 可用时仍算 HEALTHY，但 detail 必须点明是降级路径', async () => {
  const { adapter } = makeAdapter({ sdk: null });
  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.HEALTHY);
  assert.match(h.detail, /仅 CLI 可用/);
  assert.strictEqual(h.version, '1.2.3');
  await adapter.dispose();
});

test('healthCheck：SDK 就绪时说明 CLI 是否还能兜底', async () => {
  const { adapter } = makeAdapter();
  const h = await adapter.healthCheck();
  assert.strictEqual(h.status, HEALTH_STATE.HEALTHY);
  assert.match(h.detail, /CLI 亦可用/);
  await adapter.dispose();
});

// ===========================================================================
// 运行时选路与降级留痕
// ===========================================================================

test('auto：SDK 可用时走 SDK，不发任何 FALLBACK', async () => {
  const { adapter, sdk } = makeAdapter();
  const c = makeContext();
  await adapter.startTask({ goal: '重构' }, c.context);
  const { result } = await c.done;
  assert.strictEqual(result.runtime, RUNTIME_MODE.SDK);
  assert.strictEqual(sdk.calls.length, 1);
  assert.deepStrictEqual(c.ofType(AGENT_EVENT.FALLBACK), []);
  await adapter.dispose();
});

test('auto：SDK 没装 → 必须发 FALLBACK 留痕后再走 CLI（否则用户会误以为在用 SDK）', async () => {
  const { adapter, cli } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  await adapter.startTask({ goal: '重构' }, c.context);
  const { result } = await c.done;

  const fb = c.ofType(AGENT_EVENT.FALLBACK);
  assert.strictEqual(fb.length, 1);
  assert.strictEqual(fb[0].from, RUNTIME_MODE.SDK);
  assert.strictEqual(fb[0].to, RUNTIME_MODE.CLI);
  assert.strictEqual(fb[0].reason, 'SDK_NOT_INSTALLED');
  assert.match(fb[0].detail, /Cannot find module/);
  assert.strictEqual(result.runtime, RUNTIME_MODE.CLI);
  assert.strictEqual(cli.runs.length, 1);
  await adapter.dispose();
});

test('auto：SDK 装了但运行时抛错 → FALLBACK(SDK_RUN_FAILED) 后由 CLI 接管', async () => {
  const sdk = fakeSdk({ queryThrows: 'sdk 内部炸了' });
  const { adapter, cli } = makeAdapter({ sdk, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] } });
  const c = makeContext();
  await adapter.startTask({ goal: '重构' }, c.context);
  const { result } = await c.done;

  const fb = c.ofType(AGENT_EVENT.FALLBACK);
  assert.strictEqual(fb[0].reason, 'SDK_RUN_FAILED');
  assert.match(fb[0].detail, /sdk 内部炸了/);
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.runtime, RUNTIME_MODE.CLI);
  assert.strictEqual(cli.runs.length, 1);
  await adapter.dispose();
});

test('显式 sdk 模式：SDK 出错绝不静默降级到 CLI，直接失败', async () => {
  const sdk = fakeSdk({ queryThrows: 'boom' });
  const { adapter, cli } = makeAdapter({ sdk, config: { runtimeMode: RUNTIME_MODE.SDK } });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(cli.runs.length, 0, '显式指定 sdk 时不许偷偷起 CLI');
  assert.deepStrictEqual(c.ofType(AGENT_EVENT.FALLBACK), []);
  assert.ok(result.errors.some(e => /boom/.test(e)));
  await adapter.dispose();
});

test('显式 cli 模式：CLI 不在 PATH 时给出明确失败原因，不去尝试 SDK', async () => {
  const { adapter, sdk } = makeAdapter({
    cliAvailable: false, config: { runtimeMode: RUNTIME_MODE.CLI }
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'failed');
  assert.ok(result.errors.some(e => /PATH 中也没有 claude/.test(e)));
  assert.strictEqual(sdk.calls.length, 0);
  await adapter.dispose();
});

test('auto + acpEnabled 但 claude-agent-acp 不在 PATH → 不走 ACP，正常回到 SDK', async () => {
  const acp = fakeAcpDelegate();
  const { adapter, sdk } = makeAdapter({
    config: { acpEnabled: true, acpCommand: 'definitely-not-installed-acp-xyz' },
    acpAdapterFactory: acp.factory
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(acp.calls.ctor.length, 0, 'ACP 不可用时不得构造委派适配器');
  assert.strictEqual(result.runtime, RUNTIME_MODE.SDK);
  assert.strictEqual(sdk.calls.length, 1);
  await adapter.dispose();
});

// ===========================================================================
// SDK 路径
// ===========================================================================

test('SDK：正常完成 —— 终态、摘要、用量、会话 ID 全部回填', async () => {
  const { adapter } = makeAdapter();
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: '重构', projectId: 'p1', projectRoot: '/proj' }, c.context);
  const { status, result } = await c.done;

  assert.strictEqual(status, LIFECYCLE.COMPLETED);
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.summary, '已完成重构');
  assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
  assert.strictEqual(result.totalCostUsd, 0.002);
  assert.strictEqual(result.sessionId, 'sess-1');
  assert.deepStrictEqual(result.errors, []);

  assert.deepStrictEqual(await adapter.getResult(runId), result);
  assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.COMPLETED);
  assert.ok(adapter.sessions.getByRun(runId), 'session 必须登记，否则 resume 无从谈起');
  await adapter.dispose();
});

test('SDK：prompt 必须是 streaming iterable 而非字符串（否则拿不到 interrupt）', async () => {
  const { adapter, sdk } = makeAdapter();
  const c = makeContext();
  await adapter.startTask({ goal: '你好' }, c.context);
  await c.done;

  const prompt = sdk.last().prompt;
  assert.strictEqual(typeof prompt, 'object');
  assert.strictEqual(typeof prompt[Symbol.asyncIterator], 'function');
  await adapter.dispose();
});

test('SDK：流结束却没有 result 消息 → FAILED，绝不当成功（spec §65）', async () => {
  const sdk = fakeSdk({ messages: [INIT_MSG, TEXT_MSG] });
  const { adapter } = makeAdapter({ sdk });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { status, result } = await c.done;

  assert.strictEqual(status, LIFECYCLE.FAILED);
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.errors.some(e => /未产生 result 消息/.test(e)));
  assert.deepStrictEqual(c.ofType(AGENT_EVENT.RUN_COMPLETED), []);
  assert.strictEqual(c.ofType(AGENT_EVENT.RUN_FAILED).length, 1);
  await adapter.dispose();
});

test('SDK：迭代中途抛错 → FAILED 且把 stderr 尾巴附进错误里', async () => {
  const sdk = fakeSdk({
    messages: [INIT_MSG, (rec) => { rec.options.stderr('权限被拒绝\n'); throw new Error('stream broke'); }]
  });
  const { adapter } = makeAdapter({ sdk });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'failed');
  assert.ok(result.errors.some(e => /stream broke/.test(e)));
  assert.ok(result.errors.some(e => /stderr: 权限被拒绝/.test(e)));
  await adapter.dispose();
});

test('SDK：readOnly 任务强制 plan 模式并拉黑全部写类工具', async () => {
  const { adapter, sdk } = makeAdapter();
  const c = makeContext();
  await adapter.startTask({ goal: 'x', readOnly: true }, c.context);
  await c.done;

  const opts = sdk.last().options;
  assert.strictEqual(opts.permissionMode, PERMISSION_MODE.PLAN);
  for (const t of READONLY_DISALLOWED_TOOLS) {
    assert.ok(opts.disallowedTools.includes(t), `readOnly 下必须拉黑 ${t}`);
  }
  await adapter.dispose();
});

test('SDK：配置里写 bypassPermissions 也会被降级成 default', async () => {
  const { adapter, sdk } = makeAdapter({ config: { permissionMode: PERMISSION_MODE.BYPASS } });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  await c.done;
  assert.strictEqual(sdk.last().options.permissionMode, PERMISSION_MODE.DEFAULT);
  await adapter.dispose();
});

test('SDK：env 走 allowlist —— 未授权变量不进子进程（spec §28/§70）', async () => {
  process.env.CLAUDE_TEST_SECRET_XYZ = 'super-secret';
  process.env.CLAUDE_TEST_ALLOWED_XYZ = 'ok';
  try {
    const { adapter, sdk } = makeAdapter({ config: { passthroughEnv: ['CLAUDE_TEST_ALLOWED_XYZ'] } });
    const c = makeContext();
    await adapter.startTask({ goal: 'x' }, c.context);
    await c.done;

    const env = sdk.last().options.env;
    assert.strictEqual(env.CLAUDE_TEST_SECRET_XYZ, undefined, '未列入白名单的变量绝不能泄漏进子进程');
    assert.strictEqual(env.CLAUDE_TEST_ALLOWED_XYZ, 'ok');
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'PATH') || Object.prototype.hasOwnProperty.call(env, 'Path'));
    await adapter.dispose();
  } finally {
    delete process.env.CLAUDE_TEST_SECRET_XYZ;
    delete process.env.CLAUDE_TEST_ALLOWED_XYZ;
  }
});

test('SDK：resume + forkSession 原样透传给 SDK options', async () => {
  const { adapter, sdk } = makeAdapter();
  const c = makeContext();
  await adapter.startTask({ goal: 'x', resumeSessionId: 'sess-old', forkSession: true }, c.context);
  await c.done;
  assert.strictEqual(sdk.last().options.resume, 'sess-old');
  assert.strictEqual(sdk.last().options.forkSession, true);
  await adapter.dispose();
});

test('SDK：additionalDirectories 与 model 透传', async () => {
  const { adapter, sdk } = makeAdapter({ config: { model: 'claude-opus-4' } });
  const c = makeContext();
  await adapter.startTask({ goal: 'x', additionalDirectories: ['/lib'] }, c.context);
  await c.done;
  assert.deepStrictEqual(sdk.last().options.additionalDirectories, ['/lib']);
  assert.strictEqual(sdk.last().options.model, 'claude-opus-4');
  await adapter.dispose();
});

test('SDK：超时 → status=timeout 且发 RUN_TIMEOUT，不得混成 cancelled（spec §67）', async () => {
  await withKeepAlive(async () => {
    const sdk = fakeSdk({
      messages: [INIT_MSG, (rec) => new Promise(res => {
        rec.options.abortController.signal.addEventListener('abort', () => res(null), { once: true });
      })]
    });
    const { adapter } = makeAdapter({ sdk });
    const c = makeContext();
    await adapter.startTask({ goal: 'x', timeoutMs: 30 }, c.context);
    const { status, result } = await c.done;

    assert.strictEqual(status, LIFECYCLE.TIMEOUT);
    assert.strictEqual(result.status, 'timeout');
    assert.ok(result.errors.some(e => /执行超时/.test(e)));
    assert.strictEqual(c.ofType(AGENT_EVENT.RUN_TIMEOUT).length, 1);
    assert.deepStrictEqual(c.ofType(AGENT_EVENT.RUN_CANCELLED), []);
    await adapter.dispose();
  });
});

test('SDK：cancel 先走协议级 interrupt，再兜底 abort，终态是 cancelled（spec §66）', async () => {
  await withKeepAlive(async () => {
    const sdk = fakeSdk({
      messages: [INIT_MSG, (rec) => new Promise(res => {
        rec.options.abortController.signal.addEventListener('abort', () => res(null), { once: true });
      })]
    });
    const { adapter } = makeAdapter({ sdk });
    const c = makeContext();
    const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
    await tick(4);

    const r = await adapter.cancel(runId);
    assert.strictEqual(r.ok, true);
    const { status, result } = await c.done;

    assert.strictEqual(sdk.last().interrupts, 1, '必须先给一次优雅中断的机会');
    assert.strictEqual(status, LIFECYCLE.CANCELLED);
    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(c.ofType(AGENT_EVENT.RUN_CANCELLED).length, 1);
    await adapter.dispose();
  });
});

test('SDK：cancel 只动本 Run 自己的资源，不按进程名清扫（spec §106）', async () => {
  await withKeepAlive(async () => {
    const cli = fakeCli({});
    const sdk = fakeSdk({
      messages: [INIT_MSG, (rec) => new Promise(res => {
        rec.options.abortController.signal.addEventListener('abort', () => res(null), { once: true });
      })]
    });
    const { adapter } = makeAdapter({ sdk, cli });
    const c = makeContext();
    const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
    await tick(4);
    await adapter.cancel(runId);
    await c.done;

    assert.deepStrictEqual(cli.kills, [], 'SDK 模式下没有自己 spawn 的 CLI 进程，就一个都不该杀');
    assert.strictEqual(sdk.last().closed, true, '但自己的 query 必须关掉');
    await adapter.dispose();
  });
});

test('cancel/getStatus/getResult：未知 runId 一律安全返回，不抛错', async () => {
  const { adapter } = makeAdapter();
  assert.deepStrictEqual(await adapter.cancel('nope'), { ok: false, error: 'unknown runId' });
  assert.strictEqual((await adapter.getStatus('nope')).status, LIFECYCLE.IDLE);
  assert.strictEqual(await adapter.getResult('nope'), null);
  await adapter.dispose();
});

test('startTask：缺 goal 直接抛错，不产生半个 Run', async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(() => adapter.startTask({}, makeContext().context), /task\.goal 必填/);
  await adapter.dispose();
});

test('_settle：终态只发一次（spec §64）', async () => {
  const { adapter } = makeAdapter();
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await c.done;
  // 再取消一次已完成的 Run，不得二次发终态
  await adapter.cancel(runId);
  const terminals = c.types().filter(t => [
    AGENT_EVENT.RUN_COMPLETED, AGENT_EVENT.RUN_FAILED,
    AGENT_EVENT.RUN_CANCELLED, AGENT_EVENT.RUN_TIMEOUT
  ].includes(t));
  assert.strictEqual(terminals.length, 1);
  assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.COMPLETED, '已完成的 Run 不该被取消改写');
  await adapter.dispose();
});

test('emit 监听器抛错不得影响 Run（宿主 UI 崩了不能拖垮执行）', async () => {
  const { adapter } = makeAdapter();
  const done = deferred();
  const ctx = {
    emit: () => { throw new Error('UI 挂了'); },
    finishRun: (status, result) => done.resolve({ status, result })
  };
  await adapter.startTask({ goal: 'x' }, ctx);
  const { result } = await done.promise;
  assert.strictEqual(result.status, 'completed');
  await adapter.dispose();
});

// ===========================================================================
// canUseTool —— 安全红线（spec §34/§35/§36）
// ===========================================================================

/** 跑一次 SDK Run，并在流中触发一次 canUseTool 审批。 */
async function runWithPermission({ tool = 'Bash', task = {}, contextExtra = {}, adapterConfig = {}, command = 'ls' } = {}) {
  let decision;
  const sdk = fakeSdk({
    messages: [
      INIT_MSG,
      async (rec) => { decision = await rec.options.canUseTool(tool, { command }, { toolUseID: 'tu-1' }); return null; },
      RESULT_OK
    ]
  });
  const { adapter } = makeAdapter({ sdk, config: adapterConfig });
  const c = makeContext(contextExtra);
  await adapter.startTask({ goal: 'x', ...task }, c.context);
  await c.done;
  await adapter.dispose();
  return { decision: () => decision, c };
}

test('canUseTool：危险命令无审批通道时 fail-closed 拒绝（spec §26/§76 —— 无人在场不自动放行）', async () => {
  const { decision } = await runWithPermission({ tool: 'Bash', command: 'rm -rf /' });
  assert.strictEqual(decision().behavior, 'deny');
  assert.match(decision().message, /默认拒绝|无 GUI/);
});

test('canUseTool：LOW 风险命令无审批通道时按 §26 自动放行（allow_once）', async () => {
  const { decision } = await runWithPermission({ tool: 'Bash', command: 'git status' });
  assert.strictEqual(decision().behavior, 'allow');
});

test('canUseTool：只读父 Run 下的 Bash 在 Broker 层就被拒，根本不惊动用户', async () => {
  let asked = 0;
  const { decision, c } = await runWithPermission({
    tool: 'Bash',
    task: { readOnly: true },
    contextExtra: { onPermission: async () => { asked += 1; return true; } }
  });
  assert.strictEqual(decision().behavior, 'deny');
  assert.match(decision().message, /平台权限策略拒绝/);
  assert.strictEqual(asked, 0, '策略已经否决了，不该再去弹窗骚扰用户');

  const perm = c.ofType(AGENT_EVENT.PERMISSION_REQUIRED);
  assert.strictEqual(perm.length, 1);
  assert.strictEqual(perm[0].granted, false);
  assert.strictEqual(perm[0].operation, permissionBroker.OPERATION.RUN_SHELL);
});

test('canUseTool：策略放行后交给用户，用户同意 → allow', async () => {
  const seen = [];
  const { decision } = await runWithPermission({
    tool: 'Bash',
    contextExtra: { onPermission: async (req) => { seen.push(req); return true; } }
  });
  assert.deepStrictEqual(decision(), { behavior: 'allow' });
  assert.strictEqual(seen[0].tool, 'Bash');
  assert.strictEqual(seen[0].kind, 'command');
  assert.strictEqual(seen[0].toolUseId, 'tu-1');
  assert.deepStrictEqual(seen[0].params, { command: 'ls' });
});

test('canUseTool：用户拒绝 / 返回未知值 → deny', async () => {
  for (const val of [false, 'reject', null, undefined, 0, 'maybe']) {
    const { decision } = await runWithPermission({
      tool: 'Bash', contextExtra: { onPermission: async () => val }
    });
    assert.strictEqual(decision().behavior, 'deny', `resolver 返回 ${String(val)} 必须视为拒绝`);
  }
});

test('canUseTool：审批通道自身抛错 → deny（fail-closed，绝不 fail-open）', async () => {
  const { decision } = await runWithPermission({
    tool: 'Bash', contextExtra: { onPermission: async () => { throw new Error('IPC 断了'); } }
  });
  assert.strictEqual(decision().behavior, 'deny');
  assert.match(decision().message, /审批失败，默认拒绝/);
});

test('canUseTool：resolver 返回完整 PermissionResult 时原样透传（支持 updatedInput）', async () => {
  const { decision } = await runWithPermission({
    tool: 'Write',
    contextExtra: {
      onPermission: async () => ({ behavior: 'allow', updatedInput: { file_path: '/safe.txt' } })
    }
  });
  assert.deepStrictEqual(decision(), { behavior: 'allow', updatedInput: { file_path: '/safe.txt' } });
});

test('canUseTool：多种同意别名都认（true / accept / approved / allow）', async () => {
  for (const val of [true, 'accept', 'approved', 'allow']) {
    const { decision } = await runWithPermission({
      tool: 'Read', contextExtra: { onPermission: async () => val }
    });
    assert.deepStrictEqual(decision(), { behavior: 'allow' }, String(val));
  }
});

test('canUseTool：适配器级 onPermission 配置同样生效（无需 context 提供）', async () => {
  const { decision } = await runWithPermission({
    tool: 'Read', adapterConfig: { onPermission: async () => true }
  });
  assert.deepStrictEqual(decision(), { behavior: 'allow' });
});

// ===========================================================================
// CLI 路径
// ===========================================================================

test('CLI：参数正确，prompt 走 stdin 且必须 end()（否则 claude -p 永远等输入）', async () => {
  const { adapter, cli } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  await adapter.startTask({ goal: '把测试补齐' }, c.context);
  await c.done;

  const run = cli.lastRun();
  assert.strictEqual(run.cmd, '/usr/bin/claude', '必须用 detect 解析出的绝对路径');
  assert.deepStrictEqual(run.args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(!run.args.includes('--dangerously-skip-permissions'));
  assert.strictEqual(run.child.stdinData(), '把测试补齐');
  assert.strictEqual(run.child.stdinEnded, true);
  await adapter.dispose();
});

test('CLI：JSONL 事件被 decoder 消费，终态与会话回填正确', async () => {
  const { adapter } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, TEXT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  const { status, result } = await c.done;

  assert.strictEqual(status, LIFECYCLE.COMPLETED);
  assert.strictEqual(result.runtime, RUNTIME_MODE.CLI);
  assert.strictEqual(result.summary, '已完成重构');
  assert.strictEqual(result.sessionId, 'sess-1');
  assert.strictEqual(result.exitCode, 0);
  assert.ok(c.ofType(AGENT_EVENT.MESSAGE).length >= 1, '中间过程必须可见');
  assert.ok(adapter.sessions.getByRun(runId));
  await adapter.dispose();
});

test('CLI：exit 0 但没有 result 消息 → FAILED（进程退了不等于任务成了，spec §65）', async () => {
  const { adapter } = makeAdapter({ sdk: null, cliSpec: { stdoutLines: [INIT_MSG] } });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'failed');
  assert.ok(result.errors.some(e => /协议流不完整/.test(e)));
  assert.strictEqual(result.exitCode, 0);
  await adapter.dispose();
});

test('CLI：异常退出码 + stderr 一起进错误列表，便于定位', async () => {
  const { adapter } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [], exitCode: 2, stderr: 'not logged in' }
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.exitCode, 2);
  assert.ok(result.errors.some(e => /exit=2/.test(e)));
  assert.ok(result.errors.some(e => /stderr: not logged in/.test(e)));
  await adapter.dispose();
});

test('CLI：畸形 JSONL 行只记协议错误，不影响其余事件解析', async () => {
  const { adapter } = makeAdapter({
    sdk: null,
    cliSpec: { stdoutLines: [INIT_MSG, '{ 这不是 json }\n', RESULT_OK] }
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  const { result } = await c.done;

  assert.strictEqual(result.status, 'completed', '一行坏数据不该让整个 Run 判死');
  assert.ok(result.errors.some(e => /畸形事件/.test(e)));
  await adapter.dispose();
});

test('CLI：readOnly 下发 --permission-mode plan 并拉黑写类工具', async () => {
  const { adapter, cli } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x', readOnly: true }, c.context);
  await c.done;

  const args = cli.lastArgs();
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], PERMISSION_MODE.PLAN);
  const di = args.indexOf('--disallowedTools');
  assert.ok(di > 0);
  for (const t of READONLY_DISALLOWED_TOOLS) assert.ok(args.includes(t), `缺少拉黑 ${t}`);
  await adapter.dispose();
});

test('CLI：不支持运行中追加消息，必须如实报错而不是假装成功', async () => {
  const { adapter } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await c.done;
  const r = await adapter.sendMessage(runId, '再改一处');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不支持运行中追加消息/);
  await adapter.dispose();
});

// ===========================================================================
// 运行中控制（SDK 专属）
// ===========================================================================

test('setPermissionMode：bypassPermissions 被硬拒，白名单内放行', async () => {
  await withKeepAlive(async () => {
    const sdk = fakeSdk({
      messages: [INIT_MSG, (rec) => new Promise(res => {
        rec.options.abortController.signal.addEventListener('abort', () => res(null), { once: true });
      })]
    });
    const { adapter } = makeAdapter({ sdk });
    const c = makeContext();
    const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
    await tick(4);

    const bad = await adapter.setPermissionMode(runId, PERMISSION_MODE.BYPASS);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /禁止 bypassPermissions/);

    const ok = await adapter.setPermissionMode(runId, PERMISSION_MODE.ACCEPT_EDITS);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(sdk.last().modes, [PERMISSION_MODE.ACCEPT_EDITS]);

    await adapter.cancel(runId);
    await c.done;
    await adapter.dispose();
  });
});

test('sendMessage：SDK streaming input 下可插话，队列关闭后失败', async () => {
  await withKeepAlive(async () => {
    const sdk = fakeSdk({
      messages: [INIT_MSG, (rec) => new Promise(res => {
        rec.options.abortController.signal.addEventListener('abort', () => res(null), { once: true });
      })]
    });
    const { adapter } = makeAdapter({ sdk });
    const c = makeContext();
    const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
    await tick(4);

    assert.deepStrictEqual(await adapter.sendMessage(runId, '补一句'), { ok: true });
    await adapter.cancel(runId);
    await c.done;

    const after = await adapter.sendMessage(runId, '太晚了');
    assert.strictEqual(after.ok, false);
    await adapter.dispose();
  });
});

test('setPermissionMode：CLI 运行时明确不支持', async () => {
  const { adapter } = makeAdapter({
    sdk: null, cliSpec: { stdoutLines: [INIT_MSG, RESULT_OK] }
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await c.done;
  const r = await adapter.setPermissionMode(runId, PERMISSION_MODE.PLAN);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /仅 SDK 运行时/);
  await adapter.dispose();
});

// ===========================================================================
// ACP 委派（spec §52/§55/§63 —— 不重复造轮子）
// ===========================================================================

test('ACP：显式 acp 模式委派通用适配器，且必须保持同一个 agentId', async () => {
  const acp = fakeAcpDelegate();
  const { adapter } = makeAdapter({
    config: { runtimeMode: RUNTIME_MODE.ACP, acpCommand: 'claude-agent-acp' },
    acpAdapterFactory: acp.factory
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await waitFor(() => acp.calls.ctor.length === 1, { label: 'ACP 委派适配器被构造' });

  const opts = acp.calls.ctor[0];
  assert.strictEqual(opts.manifest.id, adapter.id, 'agentId 换了会让 Hub 收到未注册 Agent 的事件');
  assert.strictEqual(opts.manifest.transport, 'acp');
  assert.strictEqual(opts.config.command, 'claude-agent-acp');
  assert.strictEqual(opts.config.cwdMode, 'projectRoot');

  assert.strictEqual(acp.calls.start.length, 1);
  assert.strictEqual(acp.calls.start[0].context, c.context, '必须直接透传上层 context，避免二次归一化');
  assert.strictEqual(adapter.getActiveRuntime(), RUNTIME_MODE.ACP);
  assert.strictEqual((await adapter.getStatus(runId)).runtime, RUNTIME_MODE.ACP);
  await adapter.dispose();
});

test('ACP：委派后本适配器不再自己发终态（避免终态发两次，spec §64）', async () => {
  const acp = fakeAcpDelegate();
  const { adapter } = makeAdapter({
    config: { runtimeMode: RUNTIME_MODE.ACP }, acpAdapterFactory: acp.factory
  });
  const c = makeContext();
  await adapter.startTask({ goal: 'x' }, c.context);
  await waitFor(() => acp.calls.start.length === 1, { label: '委派 Run 已启动' });
  await tick(4);

  const terminals = c.types().filter(t => [
    AGENT_EVENT.RUN_COMPLETED, AGENT_EVENT.RUN_FAILED,
    AGENT_EVENT.RUN_CANCELLED, AGENT_EVENT.RUN_TIMEOUT
  ].includes(t));
  assert.deepStrictEqual(terminals, [], '终态由委派适配器发，这里再发一遍就重复了');
  await adapter.dispose();
});

test('ACP：委派 Run 的终态被回填，结果标记 runtime=acp', async () => {
  const acp = fakeAcpDelegate({ result: { status: 'completed', summary: 'acp 干完了', errors: [] } });
  const { adapter } = makeAdapter({
    config: { runtimeMode: RUNTIME_MODE.ACP }, acpAdapterFactory: acp.factory
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await waitFor(async () => (await adapter.getResult(runId)) != null, { label: '委派终态回填' });

  const res = await adapter.getResult(runId);
  assert.strictEqual(res.summary, 'acp 干完了');
  assert.strictEqual(res.runtime, RUNTIME_MODE.ACP);
  assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.COMPLETED);
  await adapter.dispose();
});

test('ACP：cancel 与 sendMessage 都转交委派适配器（带上委派侧的 runId）', async () => {
  const acp = fakeAcpDelegate({ status: LIFECYCLE.RUNNING });
  const { adapter } = makeAdapter({
    config: { runtimeMode: RUNTIME_MODE.ACP }, acpAdapterFactory: acp.factory
  });
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await waitFor(() => acp.calls.start.length === 1, { label: '委派 Run 已启动' });

  await adapter.sendMessage(runId, '继续');
  assert.deepStrictEqual(acp.calls.sendMessage, [{ id: 'acp-run-1', m: '继续' }]);

  const r = await adapter.cancel(runId);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(acp.calls.cancel, ['acp-run-1']);
  assert.strictEqual((await adapter.getStatus(runId)).status, LIFECYCLE.CANCELLED);
  await adapter.dispose();
});

test('ACP：dispose 连带释放委派适配器', async () => {
  const acp = fakeAcpDelegate({ status: LIFECYCLE.RUNNING });
  const { adapter } = makeAdapter({
    config: { runtimeMode: RUNTIME_MODE.ACP }, acpAdapterFactory: acp.factory
  });
  await adapter.startTask({ goal: 'x' }, makeContext().context);
  await waitFor(() => acp.calls.start.length === 1, { label: '委派 Run 已启动' });
  await adapter.dispose();
  assert.strictEqual(acp.calls.dispose, 1);
});

// ===========================================================================
// dispose
// ===========================================================================

test('dispose：清空 Run 表、会话表与探测缓存，可安全重复调用', async () => {
  const { adapter } = makeAdapter();
  const c = makeContext();
  const { runId } = await adapter.startTask({ goal: 'x' }, c.context);
  await c.done;

  await adapter.dispose();
  assert.strictEqual(await adapter.getResult(runId), null);
  assert.strictEqual(adapter.getActiveRuntime(), null);
  assert.deepStrictEqual(adapter.sessions.list(), []);
  await adapter.dispose(); // 第二次不得抛
});
