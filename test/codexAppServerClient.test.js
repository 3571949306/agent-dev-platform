'use strict';
/**
 * v2.8.0 — Codex App Server 客户端测试（spec §10/§23/§30/§34/§36/§42/§43/§44/§65/§66）
 *
 * 这是 Codex 深度集成的 primary 路径，三条上游事实决定了它没法用现成 JSON-RPC 库：
 *   1) 裸信封 —— codex 既不发也不认 "jsonrpc" 字段（rpc.rs:1-2）
 *   2) 换行分帧 —— reader.lines()，不是 LSP 的 Content-Length
 *   3) 没有版本协商 —— InitializeResponse 里根本没有 protocolVersion
 * 这三条只要错一条，表现都是"连上了但一条事件都收不到"，所以必须端到端验。
 *
 * 因此测试不注入 session，而是用**假 app-server 子进程**跑真实链路：
 *   spawnProcess → StructuredStreamDecoder → createJsonRpcSession(envelopeVersion:null) → 通知扇出
 * 只有 spawnImpl 是假的。
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const {
  createCodexAppServerClient, APP_SERVER_ARGS, REQUIRED_METHODS
} = require('../src/agents/protocols/codex/codexAppServerClient');
const { createCliProcessSupervisor } = require('../src/agents/runtime/cliProcessSupervisor');
const {
  METHOD, CLIENT_NOTIFICATION, NOTIFICATION, SERVER_REQUEST,
  COMMAND_APPROVAL_DECISION, TURN_STATUS, CLIENT_INFO
} = require('../src/agents/protocols/codex/appServerConstants');

// ===========================================================================
// 假 app-server
// ===========================================================================

/**
 * @param {object} spec
 * @param {object} [spec.handlers] method → (params, api) => result | Promise | undefined(不回包)
 * @param {object} [spec.initResult] initialize 的返回体
 * @param {boolean} [spec.echoJsonrpcField] true = 回包里塞 jsonrpc:'2.0'（验证裸信封模式不挑剔）
 */
function fakeAppServer(spec = {}) {
  const received = [];      // 客户端发来的全部报文
  const spawns = [];
  const kills = [];
  let child = null;
  let nextServerRequestId = 9000;

  const write = (obj) => {
    if (!child || child.stdout.destroyed) return;
    const payload = spec.echoJsonrpcField ? { jsonrpc: '2.0', ...obj } : obj;
    child.stdout.write(JSON.stringify(payload) + '\n');
  };

  const api = {
    /** 服务端主动发通知。 */
    notify: (method, params) => write({ method, params }),
    /** 服务端主动发请求（反向 RPC，如审批）。 */
    requestClient: (method, params) => {
      const id = nextServerRequestId++;
      write({ id, method, params });
      return id;
    },
    respond: (id, result) => write({ id, result }),
    respondError: (id, code, message) => write({ id, error: { code, message } }),
    close: (code = 0, signal = null) => { if (child) child.emit('close', code, signal); },
    received,
    /** 取客户端对某个服务端请求 id 的回包。 */
    replyTo: (id) => received.find(m => m.id === id && !m.method),
    sent: (method) => received.filter(m => m.method === method)
  };

  const defaultHandlers = {
    [METHOD.INITIALIZE]: () => spec.initResult || {
      userAgent: 'codex-cli/0.5.0 (fake)',
      codexHome: '/home/u/.codex',
      platformFamily: 'unix',
      platformOs: 'linux'
    },
    [METHOD.THREAD_START]: () => ({ thread: { id: 'th-1' } }),
    [METHOD.THREAD_RESUME]: (p) => ({ thread: { id: p.threadId } }),
    [METHOD.TURN_INTERRUPT]: () => ({}),
    [METHOD.GET_AUTH_STATUS]: () => ({ authenticated: true, authMode: 'chatgpt' })
  };
  const handlers = { ...defaultHandlers, ...(spec.handlers || {}) };

  const spawnImpl = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    child = new EventEmitter();
    child.pid = 7001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    let buf = '';
    child.stdin = new Writable({
      write(chunk, enc, cb) {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          received.push(msg);
          if (msg.method && msg.id !== undefined) {
            const h = handlers[msg.method];
            setImmediate(async () => {
              if (!h) {
                api.respondError(msg.id, -32601, `method not found: ${msg.method}`);
                return;
              }
              try {
                const r = await h(msg.params || {}, api, msg);
                if (r !== undefined) api.respond(msg.id, r);
              } catch (e) {
                api.respondError(msg.id, -32603, e.message);
              }
            });
          }
        }
        cb();
      }
    });
    child.kill = () => {};
    return child;
  };

  const killTreeImpl = (c, sig) => { kills.push({ pid: c.pid, sig }); };

  return {
    api, spawns, kills, received,
    getChild: () => child,
    supervisor: () => createCliProcessSupervisor({
      spawnImpl, killTreeImpl, resolveImpl: async c => c
    })
  };
}

async function connected(spec = {}) {
  const srv = fakeAppServer(spec);
  const client = createCodexAppServerClient({ supervisor: srv.supervisor() });
  const { serverInfo } = await client.connect({ command: '/usr/bin/codex', cwd: '/proj' });
  return { srv, client, serverInfo };
}

async function waitFor(fn, { timeoutMs = 5000, label = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// ===========================================================================
// 连接与握手
// ===========================================================================

test('connect：子命令固定为 codex app-server，且不捕获 stdout（那是协议流）', async () => {
  const { srv, client } = await connected();
  assert.strictEqual(srv.spawns.length, 1);
  assert.strictEqual(srv.spawns[0].cmd, '/usr/bin/codex');
  assert.deepStrictEqual(APP_SERVER_ARGS, ['app-server']);
  assert.strictEqual(srv.spawns[0].opts.cwd, '/proj');
  client.dispose();
});

test('connect：initialize 报文必须是裸信封 —— 绝不能带 jsonrpc 字段（rpc.rs:1-2）', async () => {
  const { srv, client } = await connected();
  const init = srv.api.sent(METHOD.INITIALIZE)[0];
  assert.ok(init, '必须发出 initialize');
  assert.strictEqual('jsonrpc' in init, false, '带上 jsonrpc 字段会被 codex 拒收');
  assert.ok(init.id !== undefined);
  client.dispose();
});

test('connect：必须声明 experimentalApi，否则 experimental 字段一律被服务端拒绝', async () => {
  const { srv, client } = await connected();
  const init = srv.api.sent(METHOD.INITIALIZE)[0];
  assert.strictEqual(init.params.capabilities.experimentalApi, true);
  assert.deepStrictEqual(init.params.clientInfo, { ...CLIENT_INFO });
  client.dispose();
});

test('connect：握手后补发 initialized 通知（唯一的 client notification）', async () => {
  const { srv, client } = await connected();
  await waitFor(() => srv.api.sent(CLIENT_NOTIFICATION.INITIALIZED).length === 1,
    { label: 'initialized 通知' });
  const n = srv.api.sent(CLIENT_NOTIFICATION.INITIALIZED)[0];
  assert.strictEqual(n.id, undefined, '通知不带 id');
  assert.strictEqual('jsonrpc' in n, false);
  client.dispose();
});

test('connect：服务端即使多带了 jsonrpc 字段也照常接收（裸信封 = 不校验，不是反向校验）', async () => {
  const { client, serverInfo } = await connected({ echoJsonrpcField: true });
  assert.match(serverInfo.userAgent, /codex-cli/);
  client.dispose();
});

test('connect：serverInfo 原样返回（这里没有 protocolVersion，别去读不存在的字段）', async () => {
  const { client, serverInfo } = await connected();
  assert.strictEqual(serverInfo.platformOs, 'linux');
  assert.strictEqual(serverInfo.protocolVersion, undefined, 'InitializeResponse 本来就没有版本号');
  client.dispose();
});

test('connect：重复连接直接报错，避免两条 stdio 抢同一个 session', async () => {
  const { client } = await connected();
  await assert.rejects(() => client.connect({ command: '/usr/bin/codex' }), /already connected/);
  client.dispose();
});

test('connect：支持注入 transportFactory（给上层适配器做单测用）', async () => {
  const fakeSession = {
    onNotification() {}, onRequest() {}, notify() {},
    async request() { return { userAgent: 'injected/1.0' }; },
    dispose() {}
  };
  const client = createCodexAppServerClient({ transportFactory: async () => ({ session: fakeSession }) });
  const { serverInfo } = await client.connect({ command: 'x' });
  assert.strictEqual(serverInfo.userAgent, 'injected/1.0');
  client.dispose();
});

// ===========================================================================
// probeMethods —— 替代不存在的版本协商（spec §23 Codex 变体）
// ===========================================================================

test('probeMethods：连上后报告 userAgent 与所依赖的方法清单', async () => {
  const { client } = await connected();
  const p = client.probeMethods();
  assert.strictEqual(p.ok, true);
  assert.match(p.userAgent, /codex-cli/);
  assert.deepStrictEqual(p.requiredMethods, REQUIRED_METHODS);
  assert.deepStrictEqual(REQUIRED_METHODS, ['thread/start', 'turn/start', 'turn/interrupt']);
  client.dispose();
});

test('probeMethods：探测不得产生副作用 —— 未真正调用 thread/start', async () => {
  const { srv, client } = await connected();
  client.probeMethods();
  assert.strictEqual(srv.api.sent(METHOD.THREAD_START).length, 0,
    '为了探测而凭空建线程是不可接受的副作用');
  client.dispose();
});

test('probeMethods：userAgent 缺失时返回 null 而不是崩掉', async () => {
  const { client } = await connected({ initResult: {} });
  assert.strictEqual(client.probeMethods().userAgent, null);
  client.dispose();
});

// ===========================================================================
// thread 生命周期（Session ≠ Run，spec §39/§109）
// ===========================================================================

test('startThread：解析 thread.id，并把 cwd/model/sandbox 透传', async () => {
  const { srv, client } = await connected();
  const { threadId } = await client.startThread({
    cwd: '/proj', model: 'gpt-5-codex', sandbox: 'workspace-write', approvalPolicy: 'on-request'
  });
  assert.strictEqual(threadId, 'th-1');
  const req = srv.api.sent(METHOD.THREAD_START)[0];
  assert.deepStrictEqual(req.params, {
    cwd: '/proj', model: 'gpt-5-codex', sandbox: 'workspace-write', approvalPolicy: 'on-request'
  });
  client.dispose();
});

test('startThread：未提供的可选项不进 params（避免下发 undefined 触发服务端校验）', async () => {
  const { srv, client } = await connected();
  await client.startThread({});
  assert.deepStrictEqual(srv.api.sent(METHOD.THREAD_START)[0].params, {});
  client.dispose();
});

test('startThread：兼容扁平 threadId 响应形状', async () => {
  const { client } = await connected({
    handlers: { [METHOD.THREAD_START]: () => ({ threadId: 'flat-1' }) }
  });
  assert.strictEqual((await client.startThread({})).threadId, 'flat-1');
  client.dispose();
});

test('startThread：拿不到 id 就报错，绝不返回 undefined 让后续静默失败', async () => {
  const { client } = await connected({
    handlers: { [METHOD.THREAD_START]: () => ({ ok: true }) }
  });
  await assert.rejects(() => client.startThread({}), /未返回 thread id/);
  client.dispose();
});

test('resumeThread：以服务端返回的 id 为准，缺省回落到请求里的 id', async () => {
  const { client } = await connected();
  assert.strictEqual((await client.resumeThread({ threadId: 'th-old' })).threadId, 'th-old');

  const c2 = await connected({ handlers: { [METHOD.THREAD_RESUME]: () => ({}) } });
  assert.strictEqual((await c2.client.resumeThread({ threadId: 'th-x' })).threadId, 'th-x');
  client.dispose();
  c2.client.dispose();
});

// ===========================================================================
// turn —— 终态来自通知而不是响应（v2/turn.rs:407-410）
// ===========================================================================

test('startTurn：turn/start 的响应回来了也不算完成，必须等 turn/completed 通知', async () => {
  let respondedAt = null;
  const { srv, client } = await connected({
    handlers: {
      [METHOD.TURN_START]: (p, api) => {
        respondedAt = Date.now();
        setTimeout(() => api.notify(NOTIFICATION.TURN_COMPLETED, {
          threadId: 'th-1', turn: { status: TURN_STATUS.COMPLETED, id: 'turn-1' }
        }), 30);
        return {}; // 立刻回响应
      }
    }
  });

  const r = await client.startTurn({ threadId: 'th-1', text: '改代码' });
  assert.strictEqual(r.status, TURN_STATUS.COMPLETED);
  assert.strictEqual(r.turn.id, 'turn-1');
  assert.ok(Date.now() - respondedAt >= 25, '不能在响应到达时就当完成');

  const req = srv.api.sent(METHOD.TURN_START)[0];
  assert.deepStrictEqual(req.params.input, [{ type: 'text', text: '改代码' }]);
  client.dispose();
});

test('startTurn：只认自己 thread 的完成通知，别人的一概忽略（并发多 thread 时的张冠李戴）', async () => {
  const { client } = await connected({
    handlers: {
      [METHOD.TURN_START]: (p, api) => {
        setImmediate(() => {
          api.notify(NOTIFICATION.TURN_COMPLETED, { threadId: 'OTHER', turn: { status: 'failed' } });
          api.notify(NOTIFICATION.TURN_COMPLETED, { threadId: 'th-1', turn: { status: 'completed' } });
        });
        return {};
      }
    }
  });
  const r = await client.startTurn({ threadId: 'th-1', text: 'x' });
  assert.strictEqual(r.status, 'completed');
  client.dispose();
});

test('startTurn：turn 以 failed/interrupted 结束时如实上报，不美化成 completed', async () => {
  for (const st of [TURN_STATUS.FAILED, TURN_STATUS.INTERRUPTED]) {
    const { client } = await connected({
      handlers: {
        [METHOD.TURN_START]: (p, api) => {
          setImmediate(() => api.notify(NOTIFICATION.TURN_COMPLETED, {
            threadId: 'th-1', turn: { status: st }
          }));
          return {};
        }
      }
    });
    assert.strictEqual((await client.startTurn({ threadId: 'th-1', text: 'x' })).status, st);
    client.dispose();
  }
});

test('startTurn：超时返回 timeout 状态而不是永久挂起（spec §67）', async () => {
  const { client } = await connected({
    handlers: { [METHOD.TURN_START]: () => ({}) } // 永远不发 turn/completed
  });
  const ka = setInterval(() => {}, 20);
  try {
    const r = await client.startTurn({ threadId: 'th-1', text: 'x', timeoutMs: 40 });
    assert.strictEqual(r.status, 'timeout');
    assert.strictEqual(r.turn, null);
  } finally {
    clearInterval(ka);
    client.dispose();
  }
});

test('startTurn：method not found(-32601) 直接 reject，交由上层降级到 codex exec', async () => {
  const { client } = await connected({
    handlers: { [METHOD.TURN_START]: undefined } // 覆盖成 undefined → 走 -32601 分支
  });
  await assert.rejects(() => client.startTurn({ threadId: 'th-1', text: 'x' }), /method not found/);
  client.dispose();
});

test('startTurn：结束后摘除通知监听器，不泄漏（连续多轮不会越积越多）', async () => {
  const { client } = await connected({
    handlers: {
      [METHOD.TURN_START]: (p, api) => {
        setImmediate(() => api.notify(NOTIFICATION.TURN_COMPLETED, {
          threadId: 'th-1', turn: { status: 'completed' }
        }));
        return {};
      }
    }
  });
  const seen = [];
  client.onAnyNotification((m) => seen.push(m));
  for (let i = 0; i < 3; i++) await client.startTurn({ threadId: 'th-1', text: 'x' });
  // 3 轮各产生 1 条 turn/completed，若 watcher 泄漏则第 3 轮会被前两轮的 watcher 重复处理
  assert.strictEqual(seen.filter(m => m === NOTIFICATION.TURN_COMPLETED).length, 3);
  client.dispose();
});

test('interruptTurn：走协议中断，而不是直接 kill 进程（spec §66）', async () => {
  const { srv, client } = await connected();
  const r = await client.interruptTurn('th-1');
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(srv.api.sent(METHOD.TURN_INTERRUPT)[0].params, { threadId: 'th-1' });
  assert.deepStrictEqual(srv.kills, [], '中断阶段不该杀进程');
  client.dispose();
});

test('interruptTurn：服务端报错时返回 ok:false 而不是抛出（取消流程不能因此中断）', async () => {
  const { client } = await connected({
    handlers: { [METHOD.TURN_INTERRUPT]: () => { throw new Error('no active turn'); } }
  });
  const r = await client.interruptTurn('th-1');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no active turn/);
  client.dispose();
});

// ===========================================================================
// 审批（spec §34/§35/§36 —— 绝不自动放行）
// ===========================================================================

/** 触发一次服务端审批请求，返回客户端的回包。 */
async function askApproval(resolver, requestMethod = SERVER_REQUEST.COMMAND_EXECUTION_REQUEST_APPROVAL) {
  const { srv, client } = await connected();
  client.onApproval(resolver);
  const id = srv.api.requestClient(requestMethod, { command: 'rm -rf /' });
  await waitFor(() => !!srv.api.replyTo(id), { label: '审批回包' });
  const reply = srv.api.replyTo(id);
  client.dispose();
  return reply;
}

test('审批：没有 resolver 时一律 decline（不存在"没人管就放行"）', async () => {
  const reply = await askApproval(undefined);
  assert.strictEqual(reply.result.decision, COMMAND_APPROVAL_DECISION.DECLINE);
});

test('审批：resolver 同意才 accept，且绝不使用 acceptForSession 这类持久放行', async () => {
  const reply = await askApproval(async () => 'accept');
  assert.strictEqual(reply.result.decision, COMMAND_APPROVAL_DECISION.ACCEPT);
  assert.deepStrictEqual(
    Object.values(COMMAND_APPROVAL_DECISION), ['accept', 'decline', 'cancel'],
    '决策集合里不得出现 acceptForSession —— 一次同意不能变成永久授权'
  );
});

test('审批：cancel 透传，未知返回值一律降级为 decline', async () => {
  assert.strictEqual((await askApproval(async () => 'cancel')).result.decision, 'cancel');
  for (const v of ['yes', true, null, undefined, 1, 'ACCEPT']) {
    const reply = await askApproval(async () => v);
    assert.strictEqual(reply.result.decision, 'decline', `resolver 返回 ${String(v)} 必须 decline`);
  }
});

test('审批：resolver 抛错 → decline（fail-closed）', async () => {
  const reply = await askApproval(async () => { throw new Error('审批链路断了'); });
  assert.strictEqual(reply.result.decision, 'decline');
});

test('审批：文件变更与权限两类请求同样默认拒绝', async () => {
  const f = await askApproval(undefined, SERVER_REQUEST.FILE_CHANGE_REQUEST_APPROVAL);
  assert.strictEqual(f.result.decision, 'decline');
  const p = await askApproval(undefined, SERVER_REQUEST.PERMISSIONS_REQUEST_APPROVAL);
  assert.strictEqual(p.result.decision, 'decline');
});

test('审批：resolver 能拿到请求类别与原始参数', async () => {
  const seen = [];
  await askApproval(async (req) => { seen.push(req); return 'decline'; });
  assert.strictEqual(seen[0].kind, 'command');
  assert.deepStrictEqual(seen[0].params, { command: 'rm -rf /' });
});

// ===========================================================================
// 通知扇出
// ===========================================================================

test('通知扇出：全部已知通知都被转发给接收器', async () => {
  const { srv, client } = await connected();
  const got = [];
  client.onAnyNotification((m, p) => got.push({ m, p }));

  for (const m of Object.values(NOTIFICATION)) srv.api.notify(m, { tag: m });
  await waitFor(() => got.length === Object.values(NOTIFICATION).length, { label: '通知扇出' });
  assert.deepStrictEqual(got.map(g => g.m).sort(), Object.values(NOTIFICATION).sort());
  client.dispose();
});

test('通知扇出：单个接收器抛错不得影响其他接收器（UI 崩了不能拖垮协议层）', async () => {
  const { srv, client } = await connected();
  const good = [];
  client.onAnyNotification(() => { throw new Error('接收器炸了'); });
  client.onAnyNotification((m) => good.push(m));

  srv.api.notify(NOTIFICATION.ITEM_STARTED, {});
  await waitFor(() => good.length === 1, { label: '第二个接收器仍被调用' });
  client.dispose();
});

// ===========================================================================
// 退出与凭据
// ===========================================================================

test('意外退出：标记 clean:false，并让挂起的请求以错误结束而不是永久挂死（spec §65）', async () => {
  const { srv, client } = await connected({
    handlers: { [METHOD.THREAD_START]: () => undefined } // 收下请求但永不回包
  });
  const exits = [];
  client.onExit(info => exits.push(info));

  const pending = client.startThread({});
  const guarded = pending.then(() => 'RESOLVED', e => `REJECTED:${e && e.message}`);

  await waitFor(() => srv.api.sent(METHOD.THREAD_START).length === 1, { label: '请求已发出' });
  srv.api.close(1, null);

  const outcome = await guarded;
  assert.match(outcome, /^REJECTED:/, '进程没了还让调用方无限等待是最糟的失败模式');
  await waitFor(() => exits.length === 1, { label: 'onExit 回调' });
  assert.strictEqual(exits[0].clean, false);
  assert.strictEqual(exits[0].code, 1);
  client.dispose();
});

test('主动 dispose：后续退出被标记 clean:true，不误报成崩溃', async () => {
  const { srv, client } = await connected();
  const exits = [];
  client.onExit(info => exits.push(info));
  client.dispose();
  srv.api.close(0, null);
  await waitFor(() => exits.length === 1, { label: 'onExit 回调' });
  assert.strictEqual(exits[0].clean, true);
});

test('dispose：可重复调用且会回收进程', async () => {
  const { srv, client } = await connected();
  client.dispose();
  assert.strictEqual(srv.kills.length, 1);
  assert.strictEqual(srv.kills[0].sig, 'SIGKILL');
  client.dispose(); // 第二次不得抛
  assert.strictEqual(client._isConnected(), false);
});

test('getAuthStatus：只读登录状态，绝不回传 token 本体（spec §30/§31/§32）', async () => {
  const { client } = await connected({
    handlers: {
      [METHOD.GET_AUTH_STATUS]: () => ({
        authenticated: true, authMode: 'chatgpt',
        // 就算服务端多给了敏感字段，客户端也不能带出去
        accessToken: 'sk-secret', idToken: 'jwt-secret', apiKey: 'ak-secret'
      })
    }
  });
  const s = await client.getAuthStatus();
  assert.deepStrictEqual(s, { ok: true, authenticated: true, method: 'chatgpt' });
  const serialized = JSON.stringify(s);
  for (const leak of ['sk-secret', 'jwt-secret', 'ak-secret', 'accessToken', 'apiKey']) {
    assert.ok(!serialized.includes(leak), `返回体泄漏了 ${leak}`);
  }
  client.dispose();
});

test('getAuthStatus：查询失败时返回未认证而不是抛错', async () => {
  const { client } = await connected({
    handlers: { [METHOD.GET_AUTH_STATUS]: () => { throw new Error('not supported'); } }
  });
  const s = await client.getAuthStatus();
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.authenticated, false);
  client.dispose();
});
