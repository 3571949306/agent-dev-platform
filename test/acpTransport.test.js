'use strict';
/**
 * v2.8.0 — test/acpTransport.test.js（spec §124）。
 *
 * acpTransport 是 jsonRpcSession 的 ACP 特化封装。jsonRpcSession.test.js 已覆盖
 * 通用信封语义，这里只验证 ACP 特化的三件事：
 *   1. 出站报文固定 jsonrpc:"2.0"（ACP 是严格 JSON-RPC 2.0，不存在宽松模式）
 *   2. dispose 时 pending 请求以 ACP_ERROR.CANCELLED 拒绝（取消 ≠ 失败）
 *   3. 请求超时以 ACP_ERROR.TIMEOUT 打标（超时 ≠ 取消，spec §67）
 */
const test = require('node:test');
const assert = require('node:assert');

const { createAcpTransport } = require('../src/agents/protocols/acp/acpTransport');
const { ACP_ERROR } = require('../src/agents/protocols/acp/errors');

/** 造一个内存对端：捕获出站字符串，可手动喂入站对象。 */
function makePair() {
  const sent = [];
  const transport = createAcpTransport({ send: (s) => sent.push(s) });
  return {
    transport,
    sent,
    lastSent: () => JSON.parse(sent[sent.length - 1]),
    feed: (obj) => transport.receive(obj)
  };
}

test('出站 request / notify 一律携带 jsonrpc:"2.0"（严格模式，无宽松开关）', async () => {
  const { transport, sent } = makePair();
  const p = transport.request('initialize', { protocolVersion: 1 });
  transport.notify('session/cancel', { sessionId: 's-1' });

  assert.strictEqual(sent.length, 2);
  for (const raw of sent) {
    const obj = JSON.parse(raw);
    assert.strictEqual(obj.jsonrpc, '2.0');
  }
  // 收尾：对端响应，避免悬挂
  const reqId = JSON.parse(sent[0]).id;
  transport.receive({ jsonrpc: '2.0', id: reqId, result: {} });
  await p;
});

test('收到不带 jsonrpc:"2.0" 的响应一律丢弃（不 resolve pending，绝不猜测）', async () => {
  const { transport, sent } = makePair();
  let settled = false;
  let resolved;
  const p = transport.request('session/new', { cwd: '/tmp', mcpServers: [] })
    .then((v) => { settled = true; resolved = v; }, () => { settled = true; });
  const id = JSON.parse(sent[0]).id;

  transport.receive({ id, result: { sessionId: 's-1' } }); // 缺 jsonrpc
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(settled, false, '违规报文不得被当成有效响应');

  transport.receive({ jsonrpc: '2.0', id, result: { sessionId: 's-1' } });
  await p;
  assert.strictEqual(resolved.sessionId, 's-1');
});

test('dispose：pending 请求以 ACP_ERROR.CANCELLED 拒绝（取消语义，不是 FAILED）', async () => {
  const { transport } = makePair();
  const p = transport.request('session/prompt', { sessionId: 's-1', prompt: [] });
  transport.dispose();
  await assert.rejects(p, err => {
    assert.strictEqual(err.code, ACP_ERROR.CANCELLED);
    return true;
  });
});

test('请求超时以 ACP_ERROR.TIMEOUT 打标（超时 ≠ 取消，spec §67）', async () => {
  const sent = [];
  const transport = createAcpTransport({ send: (s) => sent.push(s), requestTimeoutMs: 40 });
  const p = transport.request('session/prompt', { sessionId: 's-1', prompt: [] });
  // 内部超时定时器是 unref 的（不阻止进程退出），单测里另加一个 ref'd 定时
  // 保持事件循环存活，等它自然触发。
  const keepAlive = new Promise(r => setTimeout(r, 150));
  await assert.rejects(p, err => {
    assert.strictEqual(err.code, ACP_ERROR.TIMEOUT);
    assert.strictEqual(err.timeout, true, '必须携带 timeout=true 供上层归类');
    return true;
  });
  await keepAlive;
});

test('对端通知路由到 onNotification handler（session/update 通道）', async () => {
  const { transport } = makePair();
  const got = [];
  transport.onNotification('session/update', params => got.push(params));
  transport.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk' } } });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sessionId, 's-1');
});
