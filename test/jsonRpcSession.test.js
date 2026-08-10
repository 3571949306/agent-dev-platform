'use strict';
/**
 * v2.8.0 — JSON-RPC 会话层单元测试（spec §24/§94）
 *
 * 本层是 ACP 与 Codex App Server 两条链路的公共信封层，最关键的分歧点是：
 *   - ACP：严格 JSON-RPC 2.0，报文必须带 "jsonrpc":"2.0"，缺字段必须丢弃。
 *   - Codex App Server：上游 codex-rs/app-server-protocol/src/rpc.rs 明确写着
 *     "We do not do true JSON-RPC 2.0, as we neither send nor expect the
 *      \"jsonrpc\": \"2.0\" field."
 *     → 出站不能加该字段，入站不能因缺该字段而拒收。
 *
 * 这两条如果写反，表现是"整条链路静默失联"（对端收到但忽略 / 我方收到但丢弃），
 * 没有任何异常抛出，极难排查。所以此处逐条卡死。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createJsonRpcSession,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RPC_ERROR
} = require('../src/agents/protocols/jsonRpcSession');

/** 建一个把出站报文记进数组的会话，便于断言线上字节。 */
function makeSession(opts = {}) {
  const sent = [];
  const session = createJsonRpcSession({
    send: (s) => sent.push(JSON.parse(s)),
    ...opts
  });
  return { session, sent, last: () => sent[sent.length - 1] };
}

// ---------------------------------------------------------------------------
// 信封模式：严格 2.0（ACP）
// ---------------------------------------------------------------------------

test('严格模式：出站 request 带 jsonrpc:"2.0" 与自增 id', () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });

  session.request('initialize', { protocolVersion: 1 });
  session.request('session/new', { cwd: '/tmp' });

  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].jsonrpc, '2.0');
  assert.strictEqual(sent[0].method, 'initialize');
  assert.deepStrictEqual(sent[0].params, { protocolVersion: 1 });
  assert.strictEqual(sent[0].id, 1);
  assert.strictEqual(sent[1].id, 2, 'id 必须单调递增，否则响应会配错请求');
});

test('严格模式：notify / respond / respondError 出站全部带 jsonrpc 字段', () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });

  session.notify('session/cancel', { sessionId: 's1' });
  session.respond(42, { ok: true });
  session.respondError(43, RPC_ERROR.INVALID_PARAMS, 'bad params', { field: 'cwd' });

  assert.strictEqual(sent[0].jsonrpc, '2.0');
  assert.strictEqual(sent[0].id, undefined, 'notification 不得带 id');
  assert.strictEqual(sent[1].jsonrpc, '2.0');
  assert.deepStrictEqual(sent[1], { jsonrpc: '2.0', id: 42, result: { ok: true } });
  assert.strictEqual(sent[2].jsonrpc, '2.0');
  assert.deepStrictEqual(sent[2].error, {
    code: RPC_ERROR.INVALID_PARAMS,
    message: 'bad params',
    data: { field: 'cwd' }
  });
});

test('严格模式：入站报文缺 jsonrpc 字段必须丢弃（不得 resolve pending）', async () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });

  let settled = false;
  const p = session.request('initialize', {}, { timeoutMs: 0 });
  p.then(() => { settled = true; }, () => { settled = true; });

  // 裸信封响应（Codex 风格）打到严格模式会话上 → 必须被丢弃
  session.receive({ id: 1, result: { protocolVersion: 1 } });
  // jsonrpc 版本号不匹配 → 同样丢弃
  session.receive({ jsonrpc: '1.0', id: 1, result: { protocolVersion: 1 } });

  await new Promise(r => setImmediate(r));
  assert.strictEqual(settled, false, '缺/错 jsonrpc 的响应不得被采纳');
  assert.strictEqual(session._pendingCount(), 1);

  // 合法响应才放行
  session.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  assert.deepStrictEqual(await p, { protocolVersion: 1 });
  assert.strictEqual(session._pendingCount(), 0);
});

test('严格模式：入站通知缺 jsonrpc 字段同样丢弃', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const hits = [];
  session.onNotification('session/update', p => hits.push(p));

  session.receive({ method: 'session/update', params: { a: 1 } });
  assert.strictEqual(hits.length, 0);

  session.receive({ jsonrpc: '2.0', method: 'session/update', params: { a: 2 } });
  assert.deepStrictEqual(hits, [{ a: 2 }]);
});

// ---------------------------------------------------------------------------
// 信封模式：裸信封（Codex App Server）
// ---------------------------------------------------------------------------

test('裸信封模式：出站报文一律不得出现 jsonrpc 字段', () => {
  const { session, sent } = makeSession({ envelopeVersion: null });

  session.request('initialize', { clientInfo: { name: 'adp' } });
  session.notify('turn/interrupt', { threadId: 't1' });
  session.respond(7, { decision: 'decline' });
  session.respondError(8, RPC_ERROR.INTERNAL_ERROR, 'boom');

  for (const msg of sent) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(msg, 'jsonrpc'),
      'Codex 不接受 jsonrpc 字段，出现即视为未知字段：' + JSON.stringify(msg)
    );
  }
  assert.strictEqual(sent[0].method, 'initialize');
  assert.strictEqual(sent[0].id, 1);
});

test('裸信封模式：入站不带 jsonrpc 的响应/通知/请求全部正常受理', async () => {
  const { session, sent } = makeSession({ envelopeVersion: null });

  const p = session.request('thread/start', { cwd: '/w' }, { timeoutMs: 0 });
  session.receive({ id: 1, result: { threadId: 'th-1' } });
  assert.deepStrictEqual(await p, { threadId: 'th-1' });

  const notes = [];
  session.onNotification('turn/completed', x => notes.push(x));
  session.receive({ method: 'turn/completed', params: { status: 'completed' } });
  assert.deepStrictEqual(notes, [{ status: 'completed' }]);

  session.onRequest('commandExecution/requestApproval', (params, { respond }) => {
    respond({ decision: 'decline' });
  });
  session.receive({ id: 99, method: 'commandExecution/requestApproval', params: { command: 'rm -rf /' } });
  await new Promise(r => setImmediate(r));
  const reply = sent[sent.length - 1];
  assert.deepStrictEqual(reply, { id: 99, result: { decision: 'decline' } });
});

test('裸信封模式：即便对端多发了 jsonrpc 字段也不拒收（向前兼容）', async () => {
  const { session } = makeSession({ envelopeVersion: null });
  const p = session.request('initialize', {}, { timeoutMs: 0 });
  session.receive({ jsonrpc: '2.0', id: 1, result: { ok: 1 } });
  assert.deepStrictEqual(await p, { ok: 1 });
});

// ---------------------------------------------------------------------------
// 请求 / 响应语义
// ---------------------------------------------------------------------------

test('错误响应 reject 出的 Error 需携带 code 与 data', async () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const p = session.request('session/prompt', {}, { timeoutMs: 0 });

  session.receive({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32001, message: 'auth required', data: { methods: ['oauth'] } }
  });

  await assert.rejects(p, (err) => {
    assert.strictEqual(err.message, 'auth required');
    assert.strictEqual(err.code, -32001);
    assert.deepStrictEqual(err.data, { methods: ['oauth'] });
    return true;
  });
});

test('未知 id 的响应被安全忽略（超时后迟到的回包不得 crash）', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  assert.doesNotThrow(() => {
    session.receive({ jsonrpc: '2.0', id: 12345, result: { late: true } });
  });
  assert.strictEqual(session._pendingCount(), 0);
});

test('对端请求：未注册 handler → 回 METHOD_NOT_FOUND 而不是静默', async () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });
  session.receive({ jsonrpc: '2.0', id: 5, method: 'fs/read_text_file', params: {} });
  await new Promise(r => setImmediate(r));

  const reply = sent[sent.length - 1];
  assert.strictEqual(reply.id, 5);
  assert.strictEqual(reply.error.code, RPC_ERROR.METHOD_NOT_FOUND);
  assert.match(reply.error.message, /fs\/read_text_file/);
});

test('对端请求：handler 抛错 → 回 INTERNAL_ERROR，不得让对端永久挂起', async () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });
  session.onRequest('session/request_permission', () => {
    throw new Error('broker exploded');
  });

  session.receive({ jsonrpc: '2.0', id: 6, method: 'session/request_permission', params: {} });
  await new Promise(r => setImmediate(r));

  const reply = sent[sent.length - 1];
  assert.strictEqual(reply.id, 6);
  assert.strictEqual(reply.error.code, RPC_ERROR.INTERNAL_ERROR);
  assert.strictEqual(reply.error.message, 'broker exploded');
});

test('对端请求：handler 返回 Promise 时也需等待其结算后再回包', async () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });
  session.onRequest('session/request_permission', async (params, { respond }) => {
    await new Promise(r => setTimeout(r, 10));
    respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  session.receive({ jsonrpc: '2.0', id: 8, method: 'session/request_permission', params: {} });
  assert.strictEqual(sent.length, 0, '异步 handler 未结算前不得抢先回包');

  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(sent[0], {
    jsonrpc: '2.0',
    id: 8,
    result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  });
});

test('respond(undefined) 序列化为 null，避免产出非法的空 result 字段', () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });
  session.respond(1);
  assert.strictEqual(sent[0].result, null);
  assert.ok('result' in sent[0]);
});

test('通知 handler 抛错不得中断收流（后续通知仍要送达）', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const ok = [];
  session.onNotification('bad', () => { throw new Error('handler blew up'); });
  session.onNotification('good', p => ok.push(p));

  assert.doesNotThrow(() => {
    session.receive({ jsonrpc: '2.0', method: 'bad', params: {} });
  });
  session.receive({ jsonrpc: '2.0', method: 'good', params: { n: 1 } });
  assert.deepStrictEqual(ok, [{ n: 1 }]);
});

test('非对象入参被安全忽略（解码器吐出脏数据时不得炸）', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  assert.doesNotThrow(() => {
    session.receive(null);
    session.receive(undefined);
    session.receive('a string');
    session.receive(123);
  });
});

// ---------------------------------------------------------------------------
// 超时与释放
// ---------------------------------------------------------------------------

test('请求超时 → reject 且从 pending 摘除（超时 ≠ 取消，spec §67）', async () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const p = session.request('session/prompt', {}, { timeoutMs: 15 });

  // 超时计时器被实现方 unref()（刻意为之：一个待回包的 RPC 不该吊住整个应用退出）。
  // 因此测试期间必须自己拿一个 ref 计时器保活，否则事件循环会先排空、
  // node:test 会判定"Promise 仍挂起但事件循环已结束"并级联取消后续用例。
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(p, /request timeout: session\/prompt/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.strictEqual(session._pendingCount(), 0, '超时后必须清理，否则迟到回包会误配');
});

test('超时计时器必须 unref：待回包的 RPC 不得阻止进程退出（spec §106 邻域约束）', () => {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = function patched(...args) {
    const t = realSetTimeout.apply(this, args);
    timers.push(t);
    return t;
  };
  try {
    const { session } = makeSession({ envelopeVersion: '2.0' });
    // dispose() 会 reject 这个 pending 请求，必须先接住，否则变成 unhandledRejection
    session.request('session/prompt', {}, { timeoutMs: 60000 }).catch(() => {});
    assert.strictEqual(timers.length, 1, '应当为该请求创建了一个超时计时器');
    assert.strictEqual(
      timers[0].hasRef(),
      false,
      '超时计时器必须 unref，否则宿主进程会被一个挂起的 RPC 拖住不退出'
    );
    session.dispose();
  } finally {
    global.setTimeout = realSetTimeout;
    for (const t of timers) clearTimeout(t);
  }
});

test('timeoutMs=0 表示不设超时（长任务 prompt 场景）', async () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const p = session.request('session/prompt', {}, { timeoutMs: 0 });
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(session._pendingCount(), 1);
  session.receive({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  assert.deepStrictEqual(await p, { stopReason: 'end_turn' });
});

test('dispose：所有 pending 请求以 disposeErrorCode 结束，不得留悬挂 Promise', async () => {
  const { session } = makeSession({ envelopeVersion: '2.0', disposeErrorCode: 'ACP_CANCELLED' });
  const p1 = session.request('a', {}, { timeoutMs: 0 });
  const p2 = session.request('b', {}, { timeoutMs: 0 });
  assert.strictEqual(session._pendingCount(), 2);

  session.dispose();

  for (const p of [p1, p2]) {
    await assert.rejects(p, (err) => {
      assert.strictEqual(err.message, 'transport disposed');
      assert.strictEqual(err.code, 'ACP_CANCELLED');
      return true;
    });
  }
  assert.strictEqual(session._pendingCount(), 0);
  assert.strictEqual(session._isDisposed(), true);
});

test('dispose 后：request 直接 reject、notify 抛错、receive 静默丢弃', async () => {
  const { session, sent } = makeSession({ envelopeVersion: '2.0' });
  const hits = [];
  session.onNotification('x', p => hits.push(p));
  session.dispose();

  await assert.rejects(session.request('a', {}), /transport disposed/);
  assert.throws(() => session.notify('x', {}), /transport disposed/);
  session.receive({ jsonrpc: '2.0', method: 'x', params: {} });
  assert.strictEqual(hits.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('dispose 幂等（重复调用不得二次 reject 或抛错）', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  session.dispose();
  assert.doesNotThrow(() => session.dispose());
});

test('send 抛错时：request 立刻 reject 并清理 pending（管道已断）', async () => {
  const session = createJsonRpcSession({
    send: () => { throw new Error('EPIPE'); },
    envelopeVersion: '2.0'
  });
  await assert.rejects(session.request('a', {}, { timeoutMs: 0 }), /EPIPE/);
  assert.strictEqual(session._pendingCount(), 0);
});

test('未提供 send 时给出明确报错而不是静默丢包', async () => {
  const session = createJsonRpcSession({ envelopeVersion: '2.0' });
  await assert.rejects(session.request('a', {}, { timeoutMs: 0 }), /transport has no send function/);
});

test('onNotification / onRequest 返回 api 本身以支持链式注册', () => {
  const { session } = makeSession({ envelopeVersion: '2.0' });
  const ret = session.onNotification('a', () => {}).onRequest('b', () => {});
  assert.strictEqual(ret, session);
});

test('默认值：envelopeVersion 默认严格 2.0，默认超时 10 分钟', () => {
  const { session, sent } = makeSession();
  session.notify('ping', {});
  assert.strictEqual(sent[0].jsonrpc, '2.0', '默认必须是 ACP 严格模式');
  assert.strictEqual(DEFAULT_REQUEST_TIMEOUT_MS, 600000);
});

test('RPC_ERROR 常量与 JSON-RPC 2.0 规范一致', () => {
  assert.deepStrictEqual(RPC_ERROR, {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603
  });
});
