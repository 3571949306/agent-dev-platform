'use strict';
/**
 * v2.8.0 — Codex 事件映射单元测试（spec §45/§46/§47/§51）
 *
 * Codex 有两套判别值命名风格不同的结构化 schema：
 *   A) App Server 通知 → camelCase（agentMessage / commandExecution / fileChange）
 *   B) codex exec --json → snake_case（agent_message / command_execution / file_change）
 *
 * 混用的后果不是抛异常，而是**静默丢事件**（switch 全部落到 default），
 * 表现为"Run 跑完了但界面一片空白"。所以除了逐类映射，本文件还专门加了
 * 跨 schema 隔离用例作为回归护栏。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createCodexAppServerEventMapper,
  createCodexExecEventMapper,
  createAccumulator
} = require('../src/agents/protocols/codex/codexEventMapper');

const { AGENT_EVENT } = require('../src/agents/hub/types');
const {
  NOTIFICATION, ITEM_TYPE, EXEC_EVENT, EXEC_ITEM_TYPE, TURN_STATUS
} = require('../src/agents/protocols/codex/appServerConstants');

const CTX = { runId: 'run-1', agentId: 'codex' };

/** 收集 emit 出来的事件，便于按类型断言。 */
function recorder() {
  const events = [];
  return {
    emit: (type, payload) => events.push({ type, payload }),
    events,
    ofType: (t) => events.filter(x => x.type === t).map(x => x.payload),
    types: () => events.map(x => x.type)
  };
}

// ===========================================================================
// A) App Server 映射器（camelCase）
// ===========================================================================

test('AppServer：agentMessage 仅在 completed 阶段产出 message 并计入 summary', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_STARTED, { item: { id: 'i1', type: ITEM_TYPE.AGENT_MESSAGE, text: '半成品' } }, CTX);
  assert.strictEqual(r.events.length, 0, 'started 阶段的消息不得提前渲染（会造成重复文本）');

  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'i1', type: ITEM_TYPE.AGENT_MESSAGE, text: '已完成分析' } }, CTX);
  assert.deepStrictEqual(r.ofType(AGENT_EVENT.MESSAGE), [{
    runId: 'run-1', agentId: 'codex', role: 'assistant', messageId: 'i1', content: '已完成分析'
  }]);
  assert.strictEqual(m.finalize().summary, '已完成分析');
});

test('AppServer：agentMessage delta 打上 chunk:true，与整条消息区分开', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.AGENT_MESSAGE_DELTA, { itemId: 'i1', delta: '增' }, CTX);
  m.map(NOTIFICATION.AGENT_MESSAGE_DELTA, { itemId: 'i1', delta: '量' }, CTX);

  const msgs = r.ofType(AGENT_EVENT.MESSAGE);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].chunk, true);
  assert.strictEqual(msgs[0].content, '增');
  assert.strictEqual(msgs[1].content, '量');
  assert.strictEqual(m.finalize().summary, '', 'delta 不得计入 summary，否则最终文本会翻倍');
});

test('AppServer：reasoning 只拼接官方 summary/content，不臆造推理（spec §46）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: { id: 'r1', type: ITEM_TYPE.REASONING, summary: ['第一步', '第二步'], content: ['细节'] }
  }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.REASONING), [{
    runId: 'run-1', agentId: 'codex', messageId: 'r1', content: '第一步\n第二步\n细节'
  }]);
});

test('AppServer：reasoning 无 summary/content 时不产出空事件', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'r1', type: ITEM_TYPE.REASONING } }, CTX);
  assert.strictEqual(r.events.length, 0);
});

test('AppServer：commandExecution started→completed 全链路，失败计入 errors', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_STARTED, {
    item: { id: 'c1', type: ITEM_TYPE.COMMAND_EXECUTION, command: 'npm test', cwd: '/w' }
  }, CTX);
  m.map(NOTIFICATION.COMMAND_OUTPUT_DELTA, { itemId: 'c1', delta: 'FAIL\n' }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: { id: 'c1', type: ITEM_TYPE.COMMAND_EXECUTION, command: 'npm test', status: 'failed', exitCode: 1 }
  }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.COMMAND_STARTED)[0], {
    runId: 'run-1', agentId: 'codex', itemId: 'c1', command: 'npm test', cwd: '/w'
  });
  assert.deepStrictEqual(r.ofType(AGENT_EVENT.COMMAND_OUTPUT)[0], {
    runId: 'run-1', agentId: 'codex', itemId: 'c1', chunk: 'FAIL\n'
  });
  const done = r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0];
  assert.strictEqual(done.failed, true);
  assert.strictEqual(done.exitCode, 1);
  assert.deepStrictEqual(m.finalize().errors, ['命令执行失败: npm test']);
});

test('AppServer：completed 未回带 command 时从 started 缓存补齐', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_STARTED, { item: { id: 'c1', type: ITEM_TYPE.COMMAND_EXECUTION, command: 'ls -la' } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'c1', type: ITEM_TYPE.COMMAND_EXECUTION, status: 'completed', exitCode: 0 } }, CTX);

  const done = r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0];
  assert.strictEqual(done.command, 'ls -la');
  assert.strictEqual(done.failed, false);
  assert.strictEqual(done.exitCode, 0, 'exitCode 0 必须保留，不能被当成缺省值丢掉');
});

test('AppServer：declined 的命令算失败，错误文案区分"被拒绝"（审批链路可观测）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });
  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: { id: 'c9', type: ITEM_TYPE.COMMAND_EXECUTION, command: 'rm -rf /', status: 'declined' }
  }, CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0].failed, true);
  assert.deepStrictEqual(m.finalize().errors, ['命令执行被拒绝: rm -rf /']);
});

test('AppServer：fileChange 汇总到 changedFiles 且自动去重（spec §47）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: {
      id: 'f1', type: ITEM_TYPE.FILE_CHANGE, status: 'completed',
      changes: [
        { path: 'src/a.js', kind: 'modify', diff: '@@' },
        { path: 'src/b.js', kind: 'add', diff: '@@' },
        { path: null }
      ]
    }
  }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: { id: 'f2', type: ITEM_TYPE.FILE_CHANGE, changes: [{ path: 'src/a.js', kind: 'modify' }] }
  }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.FILE_CHANGED)[0].changedFiles, ['src/a.js', 'src/b.js']);
  assert.deepStrictEqual(m.finalize().changedFiles, ['src/a.js', 'src/b.js'], '同一文件改两次只算一个');
});

test('AppServer：fileChange 无有效 path 时不产出事件', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'f1', type: ITEM_TYPE.FILE_CHANGE, changes: [] } }, CTX);
  assert.strictEqual(r.events.length, 0);
});

test('AppServer：turn/diff/updated 累积为 AgentResult.diff（不发事件，只记状态）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.TURN_DIFF_UPDATED, { diff: 'diff --git a/x b/x\n+1' }, CTX);
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(m.finalize().diff, 'diff --git a/x b/x\n+1');

  m.map(NOTIFICATION.TURN_DIFF_UPDATED, { diff: 'diff --git a/y b/y\n+2' }, CTX);
  assert.strictEqual(m.finalize().diff, 'diff --git a/y b/y\n+2', 'turn diff 是累积快照，应整体替换');
});

test('AppServer：mcpToolCall 按 status 分流 completed / failed', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_STARTED, { item: { id: 't1', type: ITEM_TYPE.MCP_TOOL_CALL, server: 'fs', tool: 'read' } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 't1', type: ITEM_TYPE.MCP_TOOL_CALL, server: 'fs', tool: 'read', status: 'completed' } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 't2', type: ITEM_TYPE.MCP_TOOL_CALL, server: 'db', tool: 'query', status: 'failed' } }, CTX);

  assert.deepStrictEqual(r.types(), [
    AGENT_EVENT.TOOL_STARTED, AGENT_EVENT.TOOL_COMPLETED, AGENT_EVENT.TOOL_FAILED
  ]);
  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_STARTED)[0].name, 'fs/read');
});

test('AppServer：webSearch / todoList 映射为工具事件与计划事件', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_STARTED, { item: { id: 'w1', type: ITEM_TYPE.WEB_SEARCH } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'w1', type: ITEM_TYPE.WEB_SEARCH } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, {
    item: { id: 'p1', type: ITEM_TYPE.TODO_LIST, items: [{ step: '写测试', status: 'completed' }] }
  }, CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_STARTED)[0].name, 'web_search');
  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_COMPLETED)[0].name, 'web_search');
  assert.deepStrictEqual(m.finalize().plan, [{ step: '写测试', status: 'completed' }]);
});

test('AppServer：turn/plan/updated 同时更新计划与解释文本', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });
  const plan = [{ step: '读代码', status: 'in_progress' }];

  m.map(NOTIFICATION.TURN_PLAN_UPDATED, { plan, explanation: '先摸清结构' }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.PLAN_UPDATED)[0], {
    runId: 'run-1', agentId: 'codex', plan, explanation: '先摸清结构'
  });
  assert.deepStrictEqual(m.finalize().plan, plan);
});

test('AppServer：turn/started 与 turn/completed 产出 RUN_STATUS 并收集 usage', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.TURN_STARTED, {}, CTX);
  m.map(NOTIFICATION.TURN_COMPLETED, {
    turn: { status: TURN_STATUS.COMPLETED, usage: { inputTokens: 10, outputTokens: 20 } }
  }, CTX);

  const st = r.ofType(AGENT_EVENT.RUN_STATUS);
  assert.strictEqual(st[0].status, TURN_STATUS.IN_PROGRESS);
  assert.strictEqual(st[1].status, TURN_STATUS.COMPLETED);
  assert.deepStrictEqual(m.finalize().usage, { inputTokens: 10, outputTokens: 20 });
});

test('AppServer：error item 计入 errors 但不自行终结 Run（终态由 turn 决定）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'e1', type: ITEM_TYPE.ERROR, message: '模型超载' } }, CTX);

  assert.strictEqual(r.events.length, 0);
  assert.deepStrictEqual(m.finalize().errors, ['模型超载']);
});

test('AppServer：未知方法 / 非法 item 不得抛错（上游加字段不能打挂客户端）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  assert.doesNotThrow(() => {
    m.map('some/futureMethod', { anything: 1 }, CTX);
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: null }, CTX);
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: 'not-an-object' }, CTX);
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'x', type: 'brandNewType' } }, CTX);
    m.map(NOTIFICATION.ITEM_COMPLETED, {}, CTX);
  });
  assert.strictEqual(r.events.length, 0);
});

test('AppServer：emit 监听器抛错不得中断映射（后续事件仍要送达）', () => {
  let calls = 0;
  const seen = [];
  const m = createCodexAppServerEventMapper({
    emit: (type) => { calls++; if (calls === 1) throw new Error('UI 炸了'); seen.push(type); }
  });

  assert.doesNotThrow(() => {
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'a', type: ITEM_TYPE.AGENT_MESSAGE, text: '一' } }, CTX);
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'b', type: ITEM_TYPE.AGENT_MESSAGE, text: '二' } }, CTX);
  });
  assert.deepStrictEqual(seen, [AGENT_EVENT.MESSAGE]);
});

test('AppServer：不传 emit 也能纯累积（供无 UI 的场景复用）', () => {
  const m = createCodexAppServerEventMapper();
  assert.doesNotThrow(() => {
    m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'a', type: ITEM_TYPE.AGENT_MESSAGE, text: 'hi' } }, CTX);
  });
  assert.strictEqual(m.finalize().summary, 'hi');
});

// ===========================================================================
// B) codex exec --json 映射器（snake_case）
// ===========================================================================

test('exec：thread.started 回传 threadId，供 resume 续接（Session ≠ Run，spec §109）', () => {
  const m = createCodexExecEventMapper({});
  assert.deepStrictEqual(
    m.map({ type: EXEC_EVENT.THREAD_STARTED, thread_id: 'th-42' }, CTX),
    { terminal: null, threadId: 'th-42' }
  );
});

test('exec：turn.completed → terminal=completed 并收集 usage', () => {
  const m = createCodexExecEventMapper({});
  const out = m.map({ type: EXEC_EVENT.TURN_COMPLETED, usage: { input_tokens: 5 } }, CTX);
  assert.strictEqual(out.terminal, 'completed');
  assert.deepStrictEqual(m.finalize().usage, { input_tokens: 5 });
});

test('exec：turn.failed / error → terminal=failed 且错误进 errors', () => {
  const m = createCodexExecEventMapper({});
  assert.strictEqual(m.map({ type: EXEC_EVENT.TURN_FAILED, error: { message: '沙箱拒绝写入' } }, CTX).terminal, 'failed');
  assert.strictEqual(m.map({ type: EXEC_EVENT.ERROR, message: '连接中断' }, CTX).terminal, 'failed');
  assert.deepStrictEqual(m.finalize().errors, ['沙箱拒绝写入', '连接中断']);
});

test('exec：item.completed 的 agent_message / reasoning 映射（snake_case 判别值）', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'i1', item_type: EXEC_ITEM_TYPE.AGENT_MESSAGE, text: '结论' } }, CTX);
  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'i2', item_type: EXEC_ITEM_TYPE.REASONING, text: '思路' } }, CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.MESSAGE)[0].content, '结论');
  assert.strictEqual(r.ofType(AGENT_EVENT.REASONING)[0].content, '思路');
  assert.strictEqual(m.finalize().summary, '结论');
});

test('exec：item 用 type 字段而非 item_type 时同样能识别（上游两种都出现过）', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });
  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'i1', type: EXEC_ITEM_TYPE.AGENT_MESSAGE, text: '兼容' } }, CTX);
  assert.strictEqual(r.ofType(AGENT_EVENT.MESSAGE)[0].content, '兼容');
});

test('exec：command_execution 读的是 exit_code（snake），不是 exitCode', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  m.map({ type: EXEC_EVENT.ITEM_STARTED, item: { id: 'c1', item_type: EXEC_ITEM_TYPE.COMMAND_EXECUTION, command: 'pytest' } }, CTX);
  m.map({
    type: EXEC_EVENT.ITEM_COMPLETED,
    item: { id: 'c1', item_type: EXEC_ITEM_TYPE.COMMAND_EXECUTION, command: 'pytest', status: 'failed', exit_code: 2 }
  }, CTX);

  const done = r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0];
  assert.strictEqual(done.exitCode, 2);
  assert.strictEqual(done.failed, true);
  assert.deepStrictEqual(m.finalize().errors, ['命令执行失败: pytest']);
});

test('exec：file_change 同时兼容 changes[].path 与 changes[].file', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  m.map({
    type: EXEC_EVENT.ITEM_COMPLETED,
    item: {
      id: 'f1', item_type: EXEC_ITEM_TYPE.FILE_CHANGE,
      changes: [{ path: 'a.ts' }, { file: 'b.ts' }, {}]
    }
  }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.FILE_CHANGED)[0].changedFiles, ['a.ts', 'b.ts']);
  assert.deepStrictEqual(m.finalize().changedFiles, ['a.ts', 'b.ts']);
});

test('exec：item.updated 阶段不产出 message/command 事件（避免重复渲染）', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  const out = m.map({
    type: EXEC_EVENT.ITEM_UPDATED,
    item: { id: 'i1', item_type: EXEC_ITEM_TYPE.AGENT_MESSAGE, text: '写到一半' }
  }, CTX);

  assert.deepStrictEqual(out, { terminal: null, threadId: null });
  assert.strictEqual(r.events.length, 0);
});

test('exec：web_search 只在 completed 阶段上报并带上 query', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  m.map({ type: EXEC_EVENT.ITEM_STARTED, item: { id: 'w1', item_type: EXEC_ITEM_TYPE.WEB_SEARCH, query: 'acp spec' } }, CTX);
  assert.strictEqual(r.events.length, 0);

  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'w1', item_type: EXEC_ITEM_TYPE.WEB_SEARCH, query: 'acp spec' } }, CTX);
  assert.deepStrictEqual(r.ofType(AGENT_EVENT.TOOL_COMPLETED)[0], {
    runId: 'run-1', agentId: 'codex', toolId: 'w1', name: 'web_search', query: 'acp spec'
  });
});

test('exec：非法事件与未知类型返回空终态，不抛错', () => {
  const m = createCodexExecEventMapper({});
  for (const bad of [null, undefined, 'string', 42, {}, { type: 'thread.futureEvent' }]) {
    assert.deepStrictEqual(m.map(bad, CTX), { terminal: null, threadId: null });
  }
});

// ===========================================================================
// 跨 schema 隔离：混用必须"什么都不发"，而不是错发
// ===========================================================================

test('隔离：snake_case item 喂给 AppServer 映射器 → 零事件（防止两套 schema 混用）', () => {
  const r = recorder();
  const m = createCodexAppServerEventMapper({ emit: r.emit });

  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'i1', type: EXEC_ITEM_TYPE.AGENT_MESSAGE, text: 'x' } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'c1', type: EXEC_ITEM_TYPE.COMMAND_EXECUTION, command: 'ls' } }, CTX);
  m.map(NOTIFICATION.ITEM_COMPLETED, { item: { id: 'f1', type: EXEC_ITEM_TYPE.FILE_CHANGE, changes: [{ path: 'a' }] } }, CTX);

  assert.strictEqual(r.events.length, 0, 'snake_case 不该被 camelCase 映射器认出');
  assert.deepStrictEqual(m.finalize().changedFiles, []);
});

test('隔离：camelCase item 喂给 exec 映射器 → 零事件', () => {
  const r = recorder();
  const m = createCodexExecEventMapper({ emit: r.emit });

  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'i1', item_type: ITEM_TYPE.AGENT_MESSAGE, text: 'x' } }, CTX);
  m.map({ type: EXEC_EVENT.ITEM_COMPLETED, item: { id: 'f1', item_type: ITEM_TYPE.FILE_CHANGE, changes: [{ path: 'a' }] } }, CTX);

  assert.strictEqual(r.events.length, 0);
});

test('隔离：AppServer 的斜杠方法名不会被 exec 映射器误当事件类型', () => {
  const m = createCodexExecEventMapper({});
  assert.deepStrictEqual(m.map({ type: NOTIFICATION.ITEM_COMPLETED, item: {} }, CTX), { terminal: null, threadId: null });
  assert.deepStrictEqual(m.map({ type: NOTIFICATION.TURN_COMPLETED }, CTX), { terminal: null, threadId: null });
});

// ===========================================================================
// 共享累积器
// ===========================================================================

test('accumulator：finalize 产出稳定形状，空态各字段有合理缺省', () => {
  const acc = createAccumulator();
  assert.deepStrictEqual(acc.finalize(), {
    changedFiles: [], diff: '', usage: null, plan: null, summary: '', errors: []
  });
});

test('accumulator：setDiff(null)/setUsage(undefined) 归一为 ""/null，不产出 undefined', () => {
  const acc = createAccumulator();
  acc.setDiff(null);
  acc.setUsage(undefined);
  const out = acc.finalize();
  assert.strictEqual(out.diff, '');
  assert.strictEqual(out.usage, null);
});

test('accumulator：finalize 返回快照副本，事后改动不得回写内部状态', () => {
  const acc = createAccumulator();
  acc.changedFiles.add('a.js');
  acc.errors.push('boom');

  const snap = acc.finalize();
  snap.changedFiles.push('injected.js');
  snap.errors.push('injected');

  const again = acc.finalize();
  assert.deepStrictEqual(again.changedFiles, ['a.js']);
  assert.deepStrictEqual(again.errors, ['boom']);
});

test('accumulator：summary 由多条消息换行拼接并去除首尾空白', () => {
  const acc = createAccumulator();
  acc.messages.push('  第一段');
  acc.messages.push('第二段  ');
  assert.strictEqual(acc.finalize().summary, '第一段\n第二段');
});
