'use strict';
/**
 * P1-4 — cross-chat collaboration, exercised against a REAL SQLite database.
 *
 * v2.0.0 created the `agent_messages` table and never inserted a row: chats
 * could not see or talk to each other at all. These tests drive the four tools
 * end to end — real conversations, real messages, real delegation rows — and
 * pin down the recursion guard, which is the thing that turns "agents can call
 * each other" from a feature into a runaway bill.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/db/store');
const registry = require('../src/tools/registry');

function tool(name) {
  const t = registry.getBuiltin(name);
  assert.ok(t, `内置工具 ${name} 应已注册`);
  return t;
}

/** Fresh DB + a project with three chats wired to three agents. */
function scaffold() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-chats-'));
  store.init(dir);
  const project = store.projects.create({ name: 'demo', rootPath: dir });
  const conn = store.connections.create({ name: 'mock', provider: 'mock', base_url: '', api_key: '' });

  const mk = (name, title) => {
    const agent = store.agents.create({ name, api_connection_id: conn.id, model: 'm1', tools: [] });
    const conv = store.conversations.create({ projectId: project.id, agentId: agent.id, title });
    return { agent, conv };
  };
  const a = mk('主控', '主线开发');
  const b = mk('前端专家', '前端重构');
  const c = mk('测试专家', '回归测试');

  store.messages.create({ conversation_id: b.conv.id, role: 'user', content: '把按钮组件抽出来' });
  store.messages.create({ conversation_id: b.conv.id, role: 'assistant', content: '已抽出 Button.tsx，含 3 个变体', model: 'm1' });

  return { dir, project, a, b, c };
}

/** Minimal tool ctx matching what the runtime injects. */
function ctxFor(s, from, extra = {}) {
  return {
    store,
    projectId: s.project.id,
    conversationId: from.conv.id,
    agentId: from.agent.id,
    taskId: null,
    chatDepth: 0,
    maxChatDelegationDepth: 2,
    ...extra
  };
}

/* ------------------------------------------------------- list_project_chats */

test('P1-4: list_project_chats 列出同项目全部对话并标出当前所在', async () => {
  const s = scaffold();
  const r = await tool('list_project_chats').exec(ctxFor(s, s.a));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.count, 3);
  const titles = r.data.chats.map(c => c.title).sort();
  assert.deepStrictEqual(titles, ['主线开发', '前端重构', '回归测试']);
  const me = r.data.chats.find(c => c.is_current);
  assert.strictEqual(me.title, '主线开发');
  const fe = r.data.chats.find(c => c.title === '前端重构');
  assert.strictEqual(fe.agent.name, '前端专家');
  assert.strictEqual(fe.message_count, 2);
  assert.match(fe.last_message_preview, /Button\.tsx/);
});

test('P1-4: 未打开项目时 list_project_chats 给出可操作错误而不是空数组', async () => {
  const s = scaffold();
  const r = await tool('list_project_chats').exec({ store, projectId: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_PROJECT');
});

/* ---------------------------------------------------------- get_chat_summary */

test('P1-4: get_chat_summary 返回目标对话的真实历史消息', async () => {
  const s = scaffold();
  const r = await tool('get_chat_summary').exec(ctxFor(s, s.a), { conversation_id: s.b.conv.id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.total_messages, 2);
  assert.strictEqual(r.data.messages[0].role, 'user');
  assert.match(r.data.messages[1].content, /Button\.tsx/);
  assert.strictEqual(r.data.agent.name, '前端专家');
});

test('P1-4: get_chat_summary 的 limit 生效且只取最近若干条', async () => {
  const s = scaffold();
  for (let i = 0; i < 30; i++) {
    store.messages.create({ conversation_id: s.c.conv.id, role: 'user', content: '第 ' + i + ' 条' });
  }
  const r = await tool('get_chat_summary').exec(ctxFor(s, s.a), { conversation_id: s.c.conv.id, limit: 5 });
  assert.strictEqual(r.data.returned, 5);
  assert.strictEqual(r.data.total_messages, 30);
  assert.match(r.data.messages[4].content, /第 29 条/, '应取最近的而不是最早的');
});

test('P1-4: get_chat_summary 拒绝读取不存在的对话', async () => {
  const s = scaffold();
  const r = await tool('get_chat_summary').exec(ctxFor(s, s.a), { conversation_id: 'nope' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NOT_FOUND');
});

test('P1-4: 跨项目读取被拒绝', async () => {
  const s = scaffold();
  const other = store.projects.create({ name: 'other', rootPath: s.dir });
  const conv = store.conversations.create({ projectId: other.id, agentId: s.b.agent.id, title: '别的项目' });
  const r = await tool('get_chat_summary').exec(ctxFor(s, s.a), { conversation_id: conv.id });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CROSS_PROJECT');
});

/* ------------------------------------------------------ send_message_to_chat */

test('P1-4: send_message_to_chat 真的把任务交出去并带回对方的回答', async () => {
  const s = scaffold();
  const delivered = [];
  const ctx = ctxFor(s, s.a, {
    sendChatTask: async ({ toConversationId, message, depth, messageId }) => {
      delivered.push({ toConversationId, message, depth, messageId });
      return '组件已重构完成，新增 2 个单测。';
    }
  });
  const r = await tool('send_message_to_chat').exec(ctx, {
    conversation_id: s.b.conv.id, message: '把 Button 的样式收敛到 tokens'
  });

  assert.strictEqual(r.ok, true);
  assert.match(r.data.reply, /新增 2 个单测/);
  assert.strictEqual(r.data.target_chat, '前端重构');
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].toConversationId, s.b.conv.id);
  assert.strictEqual(delivered[0].depth, 1, '深度必须递增');

  // 委派必须在 agent_messages 里留下可审计的一行
  const row = store.agentMessages.get(r.data.message_id);
  assert.ok(row, 'agent_messages 应有记录');
  assert.strictEqual(row.status, 'completed');
  assert.strictEqual(row.from_conversation_id, s.a.conv.id);
  assert.strictEqual(row.to_conversation_id, s.b.conv.id);
  assert.strictEqual(row.depth, 1);
  assert.match(row.payload.reply, /新增 2 个单测/);
});

test('P1-4: 委派深度达到上限时拒绝，防止 A→B→C→A 无限递归', async () => {
  const s = scaffold();
  let called = false;
  const ctx = ctxFor(s, s.a, {
    chatDepth: 2, maxChatDelegationDepth: 2,
    sendChatTask: async () => { called = true; return 'x'; }
  });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '再来一层' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DEPTH_EXCEEDED');
  assert.match(r.error.message, /上限 2/);
  assert.strictEqual(called, false, '超限后绝不能真的发出去');
});

test('P1-4: 深度 1 仍允许再委派一层（边界正确，不是差一错误）', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.a, { chatDepth: 1, sendChatTask: async () => '好的' });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '第二层' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.depth, 2);
});

test('P1-4: 不允许把任务发给自己所在的对话', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.a, { sendChatTask: async () => 'x' });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.a.conv.id, message: '自己干' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SELF_DELEGATION');
});

test('P1-4: 目标对话没绑定 Agent 时拒绝派发', async () => {
  const s = scaffold();
  const orphan = store.conversations.create({ projectId: s.project.id, agentId: null, title: '空对话' });
  const ctx = ctxFor(s, s.a, { sendChatTask: async () => 'x' });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: orphan.id, message: '干活' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_AGENT');
});

test('P1-4: 对方执行抛错时记为 failed 并把原因回传给调用方', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.a, {
    sendChatTask: async () => { throw new Error('目标模型额度不足'); }
  });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '干活' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DELEGATION_FAILED');
  assert.match(r.error.message, /额度不足/);
  const rows = store.agentMessages.list({ toConversationId: s.b.conv.id });
  assert.strictEqual(rows[rows.length - 1].status, 'failed');
});

test('P1-4: 运行时未注入 sendChatTask 时给出明确失败而不是静默无事发生', async () => {
  const s = scaffold();
  const r = await tool('send_message_to_chat').exec(ctxFor(s, s.a), { conversation_id: s.b.conv.id, message: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_BUS');
});

/* ----------------------------------------------------------- P1-6 循环检测 */

test('P1-6: A→B→A 被识别为循环委派（即使深度 2 仍在上限内）', async () => {
  const s = scaffold();
  // B 正在执行（来自 A 的委派：path=[A,B]，depth=1），现在 B 想把任务发回 A。
  // depth 1 < max 2，v2.1.0 会让它通过并真的发回去，导致互相踢皮球。
  const ctx = ctxFor(s, s.b, { chatDepth: 1, delegationPath: [s.a.conv.id], sendChatTask: async () => 'x' });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.a.conv.id, message: '回传主线' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHAT_DELEGATION_LOOP');
  assert.strictEqual(r.error.retryable, false);
  // path 字段必须呈现完整可追溯链：A → B → A
  assert.deepStrictEqual(r.error.path, [s.a.conv.id, s.b.conv.id, s.a.conv.id]);
  assert.match(r.error.message, /主线开发 → 前端重构 → 主线开发/);
});

test('P1-6: 循环链包含可读标题，便于用户定位是谁在踢皮球', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.c, {
    chatDepth: 2,
    delegationPath: [s.a.conv.id, s.b.conv.id],
    sendChatTask: async () => 'x'
  });
  // C 把任务派回 A（A→B→C→A 之间的环路）
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.a.conv.id, message: '回到主线' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHAT_DELEGATION_LOOP');
  assert.match(r.error.message, /主线开发 → 前端重构 → 回归测试 → 主线开发/);
  assert.deepStrictEqual(r.error.path, [s.a.conv.id, s.b.conv.id, s.c.conv.id, s.a.conv.id]);
});

test('P1-6: 正在执行任务的对话不被重复派发（防并发重入）', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.a, {
    isChatBusy: (id) => id === s.b.conv.id,
    sendChatTask: async () => { assert.fail('不应真的发出去'); }
  });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '再来一个' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHAT_BUSY');
  assert.strictEqual(r.error.retryable, true);
});

test('P1-6: isChatBusy 仅挡住忙对话，空闲对话照常委派', async () => {
  const s = scaffold();
  let called = false;
  const ctx = ctxFor(s, s.a, {
    isChatBusy: (id) => id === s.b.conv.id, // 只有 B 忙，C 空闲
    sendChatTask: async () => { called = true; return 'OK'; }
  });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.c.conv.id, message: '派给空闲的' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(called, true);
});

test('P1-6: 成功委派会把完整 delegationPath 透传给下一层', async () => {
  const s = scaffold();
  const seen = [];
  const ctx = ctxFor(s, s.a, {
    sendChatTask: async (o) => { seen.push(o); return '完成'; }
  });
  // A 主动发起第一跳，path 应为 [A, B]
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '第一跳' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data.delegation_path, [s.a.conv.id, s.b.conv.id]);
  assert.deepStrictEqual(seen[0].delegationPath, [s.a.conv.id, s.b.conv.id]);
  assert.strictEqual(seen[0].depth, 1);
});

test('P1-6: 非环形长链仍受深度上限约束（A→B→C 可走，A→B→C→D 才超限）', async () => {
  // 深度上限是独立的第二道闸，只拦长链不拦环；环形由循环检测单独处理。
  const s = scaffold();
  const ctx = ctxFor(s, s.a, { chatDepth: 2, maxChatDelegationDepth: 2, sendChatTask: async () => 'x' });
  const r = await tool('send_message_to_chat').exec(ctx, { conversation_id: s.c.conv.id, message: '第四层' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DEPTH_EXCEEDED');
});

/* ----------------------------------------------------------- get_chat_status */

test('P1-4: wait=false 立即返回 message_id，随后可查到最终结果', async () => {
  const s = scaffold();
  let resolveIt;
  const gate = new Promise(r => { resolveIt = r; });
  const ctx = ctxFor(s, s.a, {
    sendChatTask: async ({ messageId }) => {
      await gate;
      store.agentMessages.update(messageId, { status: 'completed', payload: { reply: '异步跑完了' } });
      return '异步跑完了';
    }
  });

  const sent = await tool('send_message_to_chat').exec(ctx, {
    conversation_id: s.b.conv.id, message: '慢活', wait: false
  });
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(sent.data.waiting, false);

  const pending = await tool('get_chat_status').exec(ctx, { message_id: sent.data.message_id });
  assert.strictEqual(pending.data.status, 'pending', '尚未执行时应为 pending');

  resolveIt();
  await new Promise(r => setImmediate(r));

  const done = await tool('get_chat_status').exec(ctx, { message_id: sent.data.message_id });
  assert.strictEqual(done.data.status, 'completed');
  assert.match(done.data.reply, /异步跑完了/);
});

test('P1-4: get_chat_status 不带 id 时列出本对话发出的全部委派', async () => {
  const s = scaffold();
  const ctx = ctxFor(s, s.a, { sendChatTask: async () => '好' });
  await tool('send_message_to_chat').exec(ctx, { conversation_id: s.b.conv.id, message: '任务一' });
  await tool('send_message_to_chat').exec(ctx, { conversation_id: s.c.conv.id, message: '任务二' });
  const r = await tool('get_chat_status').exec(ctx, {});
  assert.strictEqual(r.data.count, 2);
  assert.deepStrictEqual(r.data.deliveries.map(d => d.request).sort(), ['任务一', '任务二']);
});

test('P1-4: 四个跨聊天工具都已注册进内置工具表', () => {
  for (const n of ['list_project_chats', 'get_chat_summary', 'send_message_to_chat', 'get_chat_status']) {
    const t = registry.getBuiltin(n);
    assert.ok(t, `${n} 应可被 Agent 调用`);
    assert.ok(t.def.description && t.def.description.length > 10, `${n} 需要有对模型有用的描述`);
    assert.ok(t.permission, `${n} 必须声明权限域`);
  }
});
