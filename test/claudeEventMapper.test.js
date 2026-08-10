'use strict';
/**
 * v2.8.0 — Claude SDKMessage → 统一 AGENT_EVENT 映射测试（spec §46/§51）
 *
 * 同一份映射服务两条运行时（SDK 与 CLI stream-json 是同一套 schema），
 * 因此这里的每条断言都同时是 SDK 路径与 CLI 路径的契约。
 *
 * 重点覆盖：
 *   - tool_use 按工具语义分流（Bash/Read/Write/TodoWrite/其他）
 *   - tool_result 必须能凭 tool_use_id 关联回发起方，否则完成态会张冠李戴
 *   - result 消息的终态判定：只有 subtype=success && is_error!==true 才算成功（spec §65）
 *   - §46：只透传官方 thinking，不做隐藏推理还原
 */

const test = require('node:test');
const assert = require('node:assert');

const { createClaudeEventMapper, extractPaths } = require('../src/agents/protocols/claude/claudeEventMapper');
const { AGENT_EVENT } = require('../src/agents/hub/types');
const {
  MESSAGE_TYPE, SYSTEM_SUBTYPE, RESULT_SUBTYPE, CONTENT_BLOCK
} = require('../src/agents/protocols/claude/claudeConstants');

const CTX = { runId: 'run-9', agentId: 'claude-code' };

function recorder() {
  const events = [];
  return {
    emit: (type, payload) => events.push({ type, payload }),
    events,
    ofType: (t) => events.filter(x => x.type === t).map(x => x.payload),
    types: () => events.map(x => x.type)
  };
}

/** 构造一条 assistant 消息（SDK 与 CLI 形状一致）。 */
function assistantMsg(content, extra = {}) {
  return { type: MESSAGE_TYPE.ASSISTANT, message: { content }, ...extra };
}
function userMsg(content, extra = {}) {
  return { type: MESSAGE_TYPE.USER, message: { content }, ...extra };
}

// ---------------------------------------------------------------------------
// extractPaths
// ---------------------------------------------------------------------------

test('extractPaths：识别 file_path / path / notebook_path 三种公开入参键', () => {
  assert.deepStrictEqual(extractPaths({ file_path: 'a.js' }), ['a.js']);
  assert.deepStrictEqual(extractPaths({ path: 'b/' }), ['b/']);
  assert.deepStrictEqual(extractPaths({ notebook_path: 'n.ipynb' }), ['n.ipynb']);
  assert.deepStrictEqual(
    extractPaths({ file_path: 'a.js', path: 'b/', notebook_path: 'n.ipynb' }),
    ['a.js', 'b/', 'n.ipynb']
  );
});

test('extractPaths：展开 MultiEdit 的 edits[].file_path', () => {
  assert.deepStrictEqual(
    extractPaths({ edits: [{ file_path: 'x.ts' }, { file_path: 'y.ts' }, null, { nope: 1 }] }),
    ['x.ts', 'y.ts']
  );
});

test('extractPaths：非法/空入参返回空数组，不抛错', () => {
  for (const bad of [null, undefined, 'str', 42, {}, { file_path: '' }, { file_path: 123 }]) {
    assert.deepStrictEqual(extractPaths(bad), []);
  }
});

// ---------------------------------------------------------------------------
// system 消息
// ---------------------------------------------------------------------------

test('system/init：记录 sessionId 与 model，并发出 running 状态', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  const out = m.map({
    type: MESSAGE_TYPE.SYSTEM, subtype: SYSTEM_SUBTYPE.INIT,
    session_id: 'sess-1', model: 'claude-sonnet-4', tools: ['Bash', 'Read']
  }, CTX);

  assert.deepStrictEqual(out, { terminal: null, sessionId: 'sess-1' });
  assert.deepStrictEqual(r.ofType(AGENT_EVENT.RUN_STATUS)[0], {
    runId: 'run-9', agentId: 'claude-code', status: 'running', sessionId: 'sess-1', model: 'claude-sonnet-4'
  });
  const f = m.finalize();
  assert.strictEqual(f.model, 'claude-sonnet-4');
  assert.deepStrictEqual(f.availableTools, ['Bash', 'Read']);
});

test('system/api_retry：上报 retrying 状态与重试计数（可观测，不算失败）', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map({ type: MESSAGE_TYPE.SYSTEM, subtype: SYSTEM_SUBTYPE.API_RETRY, attempt: 2, max_retries: 5 }, CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.RUN_STATUS)[0], {
    runId: 'run-9', agentId: 'claude-code', status: 'retrying', attempt: 2, maxRetries: 5
  });
});

test('system 其它 subtype 不产出事件（如 plugin_install）', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map({ type: MESSAGE_TYPE.SYSTEM, subtype: SYSTEM_SUBTYPE.PLUGIN_INSTALL }, CTX);
  assert.strictEqual(r.events.length, 0);
});

// ---------------------------------------------------------------------------
// assistant 内容块
// ---------------------------------------------------------------------------

test('assistant text → agent.message 并计入 summary', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '我先读一下代码' }]), CTX);
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '改完了' }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.MESSAGE).map(p => p.content), ['我先读一下代码', '改完了']);
  assert.strictEqual(m.finalize().summary, '我先读一下代码\n改完了');
});

test('assistant thinking → agent.reasoning（§46：只透传官方块）', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.THINKING, thinking: '需要先看 package.json' }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.REASONING)[0], {
    runId: 'run-9', agentId: 'claude-code', parentToolUseId: null, content: '需要先看 package.json'
  });
  assert.strictEqual(m.finalize().summary, '', 'thinking 不得混入最终摘要');
});

test('assistant redacted_thinking → 只记录发生过，不尝试解密内容', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.REDACTED_THINKING, data: 'ENCRYPTED_BLOB' }]), CTX);

  const ev = r.ofType(AGENT_EVENT.REASONING)[0];
  assert.strictEqual(ev.redacted, true);
  assert.strictEqual(ev.content, '');
  assert.ok(!JSON.stringify(ev).includes('ENCRYPTED_BLOB'), '加密载荷不得外泄到事件里');
});

test('tool_use Bash → agent.command.started，取 input.command 作为命令文本', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.COMMAND_STARTED)[0], {
    runId: 'run-9', agentId: 'claude-code', parentToolUseId: null, itemId: 'tu1', command: 'npm run build'
  });
});

test('tool_use Read/Grep → agent.file.read 并累计 readFiles', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'tu1', name: 'Read', input: { file_path: 'src/a.js' } }]), CTX);
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'tu2', name: 'Grep', input: { path: 'src/' } }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.FILE_READ).map(p => p.files), [['src/a.js'], ['src/']]);
  assert.deepStrictEqual(m.finalize().readFiles, ['src/a.js', 'src/']);
  assert.deepStrictEqual(m.finalize().changedFiles, [], '读操作绝不能污染 changedFiles');
});

test('tool_use Write/Edit/MultiEdit → agent.file.changed 并去重累计 changedFiles', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'w1', name: 'Write', input: { file_path: 'a.js' } }]), CTX);
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'w2', name: 'Edit', input: { file_path: 'a.js' } }]), CTX);
  m.map(assistantMsg([{
    type: CONTENT_BLOCK.TOOL_USE, id: 'w3', name: 'MultiEdit',
    input: { edits: [{ file_path: 'b.js' }, { file_path: 'c.js' }] }
  }]), CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.FILE_CHANGED).length, 3);
  assert.deepStrictEqual(m.finalize().changedFiles, ['a.js', 'b.js', 'c.js']);
});

test('tool_use TodoWrite → agent.plan.updated，plan 取 input.todos', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  const todos = [{ content: '跑测试', status: 'pending' }];

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'p1', name: 'TodoWrite', input: { todos } }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.PLAN_UPDATED)[0].plan, todos);
  assert.deepStrictEqual(m.finalize().plan, todos);
});

test('tool_use 未知工具（含 MCP 工具）→ 通用 agent.tool.started', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 't9', name: 'mcp__github__create_issue', input: {} }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.TOOL_STARTED)[0], {
    runId: 'run-9', agentId: 'claude-code', parentToolUseId: null, toolId: 't9', name: 'mcp__github__create_issue'
  });
});

test('tool_use 缺 name 时归为 unknown 并走通用分支，不崩', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 't0' }]), CTX);
  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_STARTED)[0].name, 'unknown');
});

test('subagent 消息透传 parent_tool_use_id，便于 UI 归属到父工具', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '子代理输出' }], { parent_tool_use_id: 'task-1' }), CTX);
  assert.strictEqual(r.ofType(AGENT_EVENT.MESSAGE)[0].parentToolUseId, 'task-1');
});

test('assistant 内容非数组 / 含脏块时安全跳过', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  assert.doesNotThrow(() => {
    m.map({ type: MESSAGE_TYPE.ASSISTANT, message: { content: 'not-array' } }, CTX);
    m.map({ type: MESSAGE_TYPE.ASSISTANT, message: null }, CTX);
    m.map(assistantMsg([null, 'str', { type: 'brand_new_block' }, { type: CONTENT_BLOCK.TEXT, text: '' }]), CTX);
  });
  assert.strictEqual(r.events.length, 0);
});

// ---------------------------------------------------------------------------
// user / tool_result 回填
// ---------------------------------------------------------------------------

test('tool_result 凭 tool_use_id 关联回 Bash → agent.command.completed', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'tu1', name: 'Bash', input: { command: 'ls' } }]), CTX);
  m.map(userMsg([{ type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'tu1', content: 'a\nb' }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0], {
    runId: 'run-9', agentId: 'claude-code', parentToolUseId: null, itemId: 'tu1', command: 'Bash', failed: false
  });
  assert.strictEqual(m._pendingTools.size, 0, '结算后必须摘除挂起工具，否则会内存泄漏');
});

test('tool_result is_error=true → 命令标记失败并计入 errors', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'tu1', name: 'Bash', input: { command: 'false' } }]), CTX);
  m.map(userMsg([{ type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'tu1', is_error: true }]), CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.COMMAND_COMPLETED)[0].failed, true);
  assert.deepStrictEqual(m.finalize().errors, ['命令执行失败: Bash']);
});

test('文件读写成功时不重复发完成事件（started 已表达语义）', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'w1', name: 'Write', input: { file_path: 'a.js' } }]), CTX);
  m.map(userMsg([{ type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'w1' }]), CTX);

  assert.deepStrictEqual(r.types(), [AGENT_EVENT.FILE_CHANGED]);
});

test('文件写入失败时补发 agent.tool.failed 并记录错误', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([{ type: CONTENT_BLOCK.TOOL_USE, id: 'w1', name: 'Write', input: { file_path: 'a.js' } }]), CTX);
  m.map(userMsg([{ type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'w1', is_error: true }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.TOOL_FAILED)[0].name, 'Write');
  assert.deepStrictEqual(m.finalize().errors, ['Write 失败']);
});

test('通用工具 tool_result 按 is_error 分流 completed / failed', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map(assistantMsg([
    { type: CONTENT_BLOCK.TOOL_USE, id: 'a', name: 'WebFetch', input: {} },
    { type: CONTENT_BLOCK.TOOL_USE, id: 'b', name: 'WebSearch', input: {} }
  ]), CTX);
  m.map(userMsg([
    { type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'a' },
    { type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'b', is_error: true }
  ]), CTX);

  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_COMPLETED)[0].name, 'WebFetch');
  assert.strictEqual(r.ofType(AGENT_EVENT.TOOL_FAILED)[0].name, 'WebSearch');
  assert.deepStrictEqual(m.finalize().errors, ['工具执行失败: WebSearch']);
});

test('孤儿 tool_result（无对应 tool_use）降级为 unknown 工具，不得丢事件也不得崩', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(userMsg([{ type: CONTENT_BLOCK.TOOL_RESULT, tool_use_id: 'ghost' }]), CTX);

  assert.deepStrictEqual(r.ofType(AGENT_EVENT.TOOL_COMPLETED)[0].name, 'unknown');
});

test('user 消息中的非 tool_result 块被忽略（用户纯文本回合）', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });
  m.map(userMsg([{ type: CONTENT_BLOCK.TEXT, text: '继续' }]), CTX);
  assert.strictEqual(r.events.length, 0);
});

// ---------------------------------------------------------------------------
// stream_event 增量
// ---------------------------------------------------------------------------

test('stream_event text_delta → chunk:true 的增量消息', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map({ type: MESSAGE_TYPE.STREAM_EVENT, event: { delta: { type: 'text_delta', text: 'Hel' } } }, CTX);
  m.map({ type: MESSAGE_TYPE.STREAM_EVENT, event: { delta: { type: 'text_delta', text: 'lo' } } }, CTX);

  const msgs = r.ofType(AGENT_EVENT.MESSAGE);
  assert.deepStrictEqual(msgs.map(p => p.content), ['Hel', 'lo']);
  assert.ok(msgs.every(p => p.chunk === true));
  assert.strictEqual(m.finalize().summary, '', '增量不得进 summary，否则与整条 text 重复');
});

test('stream_event 非 text_delta（如 thinking_delta / 无 delta）被忽略', () => {
  const r = recorder();
  const m = createClaudeEventMapper({ emit: r.emit });

  m.map({ type: MESSAGE_TYPE.STREAM_EVENT, event: { delta: { type: 'thinking_delta', thinking: 'x' } } }, CTX);
  m.map({ type: MESSAGE_TYPE.STREAM_EVENT, event: {} }, CTX);
  m.map({ type: MESSAGE_TYPE.STREAM_EVENT }, CTX);

  assert.strictEqual(r.events.length, 0);
});

// ---------------------------------------------------------------------------
// result 终态（spec §65）
// ---------------------------------------------------------------------------

test('result success → terminal=completed，并收集 usage/cost/turns', () => {
  const m = createClaudeEventMapper({});
  const out = m.map({
    type: MESSAGE_TYPE.RESULT, subtype: RESULT_SUBTYPE.SUCCESS, is_error: false,
    session_id: 'sess-2', result: '任务完成',
    usage: { input_tokens: 100, output_tokens: 50 },
    total_cost_usd: 0.0123, num_turns: 3
  }, CTX);

  assert.deepStrictEqual(out, { terminal: 'completed', sessionId: 'sess-2' });
  const f = m.finalize();
  assert.strictEqual(f.summary, '任务完成');
  assert.deepStrictEqual(f.usage, { input_tokens: 100, output_tokens: 50 });
  assert.strictEqual(f.totalCostUsd, 0.0123);
  assert.strictEqual(f.numTurns, 3);
  assert.deepStrictEqual(f.errors, []);
});

test('result success 但 is_error=true → 判失败（不得只看 subtype，spec §65）', () => {
  const m = createClaudeEventMapper({});
  const out = m.map({ type: MESSAGE_TYPE.RESULT, subtype: RESULT_SUBTYPE.SUCCESS, is_error: true }, CTX);
  assert.strictEqual(out.terminal, 'failed');
  assert.ok(m.finalize().errors.some(x => x.includes('success')));
});

test('result 各错误 subtype 一律 failed，errors 数组合并进来', () => {
  for (const subtype of [
    RESULT_SUBTYPE.ERROR_MAX_TURNS,
    RESULT_SUBTYPE.ERROR_DURING_EXECUTION,
    RESULT_SUBTYPE.ERROR_MAX_BUDGET_USD,
    RESULT_SUBTYPE.ERROR_MAX_STRUCTURED_OUTPUT_RETRIES
  ]) {
    const m = createClaudeEventMapper({});
    const out = m.map({ type: MESSAGE_TYPE.RESULT, subtype, errors: ['底层报错'] }, CTX);
    assert.strictEqual(out.terminal, 'failed', subtype + ' 必须判失败');
    assert.deepStrictEqual(m.finalize().errors, ['底层报错', `Claude 以 ${subtype} 结束`]);
  }
});

test('result 的 result 文本与已有 message 重复时不重复计入 summary', () => {
  const m = createClaudeEventMapper({});
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '改完了' }]), CTX);
  m.map({ type: MESSAGE_TYPE.RESULT, subtype: RESULT_SUBTYPE.SUCCESS, result: '改完了' }, CTX);
  assert.strictEqual(m.finalize().summary, '改完了');
});

test('permission_denials 被记录并汇总成一条可读错误（spec §35/§36 可观测性）', () => {
  const m = createClaudeEventMapper({});
  m.map({
    type: MESSAGE_TYPE.RESULT, subtype: RESULT_SUBTYPE.SUCCESS,
    permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }]
  }, CTX);

  const f = m.finalize();
  assert.strictEqual(f.permissionDenials.length, 2);
  assert.deepStrictEqual(f.errors, ['有 2 个操作因权限被拒绝']);
});

// ---------------------------------------------------------------------------
// 通用鲁棒性
// ---------------------------------------------------------------------------

test('sessionId 一旦确定就不被后续消息覆盖（首个 session_id 生效）', () => {
  const m = createClaudeEventMapper({});
  m.map({ type: 'unknown_future_type', session_id: 'sess-first' }, CTX);
  m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: 'x' }], { session_id: 'sess-second' }), CTX);
  assert.strictEqual(m.finalize().sessionId, 'sess-first');
});

test('非法输入与未知 type 返回 { terminal:null }，不抛错', () => {
  const m = createClaudeEventMapper({});
  for (const bad of [null, undefined, 'str', 42, {}, { type: 'future_type' }]) {
    const out = m.map(bad, CTX);
    assert.strictEqual(out.terminal, null);
  }
});

test('emit 监听器抛错不得中断映射', () => {
  let n = 0;
  const seen = [];
  const m = createClaudeEventMapper({
    emit: (t) => { n++; if (n === 1) throw new Error('UI 崩了'); seen.push(t); }
  });
  assert.doesNotThrow(() => {
    m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '一' }]), CTX);
    m.map(assistantMsg([{ type: CONTENT_BLOCK.TEXT, text: '二' }]), CTX);
  });
  assert.deepStrictEqual(seen, [AGENT_EVENT.MESSAGE]);
  assert.strictEqual(m.finalize().summary, '一\n二', '事件发不出去也不能丢累积状态');
});

test('finalize 形状稳定：空 Run 也返回全部字段', () => {
  const m = createClaudeEventMapper({});
  assert.deepStrictEqual(m.finalize(), {
    sessionId: null, summary: '', changedFiles: [], readFiles: [], plan: null,
    usage: null, totalCostUsd: null, numTurns: null, model: null,
    availableTools: [], permissionDenials: [], errors: []
  });
});
