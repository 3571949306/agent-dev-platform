'use strict';
/**
 * P1-4 — cross-chat collaboration tools.
 *
 * v2.0.0 shipped multiple chats per project but they were sealed boxes: an agent
 * working in chat A had no way to know chat B existed, let alone hand it work.
 * The `agent_messages` table was created and never written to.
 *
 * These four tools close that loop:
 *   list_project_chats    — who else is in this project, and are they busy
 *   get_chat_summary      — what has chat X been doing (recent messages / task)
 *   send_message_to_chat  — hand a task to chat X and get its answer back
 *   get_chat_status       — poll a delegation that was sent async
 *
 * Recursion guard: every delegation carries a depth. `maxChatDelegationDepth`
 * (default 2) stops A→B→C→A loops from eating the machine. A chat also refuses
 * to delegate to itself.
 */

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

/** Compact one conversation into something a model can reason about. */
function describeChat(store, conv, { currentId } = {}) {
  const agent = conv.agent_id ? (store.agents.get(conv.agent_id) || store.externalAgents.get(conv.agent_id)) : null;
  const msgs = store.messages.list(conv.id) || [];
  const last = msgs[msgs.length - 1] || null;
  return {
    conversation_id: conv.id,
    title: conv.title || '(未命名对话)',
    agent: agent ? { id: agent.id, name: agent.name, type: agent.type } : null,
    message_count: msgs.length,
    last_activity: last ? last.created_at : conv.created_at,
    last_message_preview: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 120) : '',
    is_current: conv.id === currentId
  };
}

const tools = [
  /* ------------------------------------------------------------------ list */
  {
    name: 'list_project_chats',
    description: '列出当前项目下的所有对话（聊天），包含各自绑定的 Agent、消息数与最近活动。用于在需要协作时先看看有哪些同伴可以求助。',
    risk_level: 'low',
    permission: 'filesystem.read',
    input_schema: { type: 'object', properties: {} },
    async exec(ctx) {
      if (!ctx.store) return fail('NO_STORE', '数据层不可用');
      if (!ctx.projectId) return fail('NO_PROJECT', '当前未打开项目，无法列出对话');
      const list = (ctx.store.conversations.list(ctx.projectId) || [])
        .map(c => describeChat(ctx.store, c, { currentId: ctx.conversationId }));
      return ok({
        project_id: ctx.projectId,
        count: list.length,
        chats: list,
        note: list.length <= 1 ? '当前项目只有这一个对话，无可协作对象。' : undefined
      });
    }
  },

  /* --------------------------------------------------------------- summary */
  {
    name: 'get_chat_summary',
    description: '读取指定对话的近期内容摘要（默认最近 20 条消息），用于在委派任务前了解对方的上下文，避免重复劳动。',
    risk_level: 'low',
    permission: 'filesystem.read',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '目标对话 ID，来自 list_project_chats' },
        limit: { type: 'number', description: '最多返回多少条消息，默认 20，上限 100' }
      },
      required: ['conversation_id']
    },
    async exec(ctx, args) {
      if (!ctx.store) return fail('NO_STORE', '数据层不可用');
      const conv = ctx.store.conversations.get(args.conversation_id);
      if (!conv) return fail('NOT_FOUND', `对话 ${args.conversation_id} 不存在`);
      if (ctx.projectId && conv.project_id && conv.project_id !== ctx.projectId) {
        return fail('CROSS_PROJECT', '不允许读取其它项目的对话');
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const all = ctx.store.messages.list(conv.id) || [];
      const recent = all.slice(-limit).map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, 800),
        model: m.model || null,
        created_at: m.created_at
      }));
      return ok({
        ...describeChat(ctx.store, conv, { currentId: ctx.conversationId }),
        total_messages: all.length,
        returned: recent.length,
        messages: recent
      });
    }
  },

  /* ------------------------------------------------------------ delegation */
  {
    name: 'send_message_to_chat',
    description: '把一个任务或问题发给同项目下的另一个对话，由它绑定的 Agent 执行并把结果返回给你。适合让更擅长该领域的 Agent 接手。注意：这会真实消耗对方模型的额度。',
    risk_level: 'medium',
    permission: 'network',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '目标对话 ID' },
        message: { type: 'string', description: '要交办的任务描述，请写清楚背景与期望产出' },
        wait: { type: 'boolean', description: '是否等待对方执行完成并返回结果，默认 true。设为 false 时立即返回 message_id，稍后用 get_chat_status 查询' }
      },
      required: ['conversation_id', 'message']
    },
    async exec(ctx, args) {
      if (!ctx.store) return fail('NO_STORE', '数据层不可用');
      if (typeof ctx.sendChatTask !== 'function') return fail('NO_BUS', '跨对话调度不可用（运行时未注入 sendChatTask）');

      const target = args.conversation_id;
      if (!target) return fail('BAD_ARGS', '必须提供 conversation_id');
      if (target === ctx.conversationId) return fail('SELF_DELEGATION', '不能把任务发给自己所在的对话');

      const conv = ctx.store.conversations.get(target);
      if (!conv) return fail('NOT_FOUND', `对话 ${target} 不存在`);
      if (ctx.projectId && conv.project_id && conv.project_id !== ctx.projectId) {
        return fail('CROSS_PROJECT', '不允许向其它项目的对话派发任务');
      }
      if (!conv.agent_id) return fail('NO_AGENT', `对话「${conv.title || target}」没有绑定 Agent，无法执行任务`);

      const depth = Number(ctx.chatDepth || 0);
      const max = Number(ctx.maxChatDelegationDepth ?? 2);
      if (depth >= max) {
        return fail('DEPTH_EXCEEDED',
          `跨对话委派深度已达上限 ${max}（当前 ${depth}）。请自己完成这一步，或让用户手动在目标对话中发起。`);
      }

      const messageId = ctx.store.agentMessages.send({
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        fromAgentId: ctx.agentId,
        toAgentId: conv.agent_id,
        fromConversationId: ctx.conversationId,
        toConversationId: target,
        depth: depth + 1,
        type: 'task',
        content: args.message
      });

      const wait = args.wait !== false;
      if (!wait) {
        // Fire and forget; the delegate updates the row when it finishes.
        Promise.resolve(ctx.sendChatTask({ toConversationId: target, message: args.message, depth: depth + 1, messageId }))
          .catch(() => { /* status is recorded by the runner */ });
        return ok({
          message_id: messageId, delivered_to: target, waiting: false,
          note: '任务已投递，稍后用 get_chat_status 查询结果。'
        });
      }

      try {
        const reply = await ctx.sendChatTask({
          toConversationId: target, message: args.message, depth: depth + 1, messageId
        });
        const content = typeof reply === 'string' ? reply : (reply && reply.content) || '';
        ctx.store.agentMessages.update(messageId, { status: 'completed', content: args.message, payload: { reply: content } });
        return ok({
          message_id: messageId,
          delivered_to: target,
          target_chat: conv.title || target,
          reply: String(content).slice(0, 6000),
          depth: depth + 1
        });
      } catch (e) {
        ctx.store.agentMessages.update(messageId, { status: 'failed', payload: { error: e.message } });
        return fail('DELEGATION_FAILED', `目标对话执行失败：${e.message}`, true);
      }
    }
  },

  /* ------------------------------------------------------------------ poll */
  {
    name: 'get_chat_status',
    description: '查询之前用 send_message_to_chat（wait=false）投递的任务当前状态与结果。',
    risk_level: 'low',
    permission: 'filesystem.read',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '投递时返回的 message_id' },
        conversation_id: { type: 'string', description: '不传 message_id 时，可按目标对话列出所有投递记录' }
      }
    },
    async exec(ctx, args) {
      if (!ctx.store) return fail('NO_STORE', '数据层不可用');
      if (args.message_id) {
        const m = ctx.store.agentMessages.get(args.message_id);
        if (!m) return fail('NOT_FOUND', `投递记录 ${args.message_id} 不存在`);
        return ok({
          message_id: m.id,
          status: m.status,
          to_conversation_id: m.to_conversation_id,
          depth: m.depth,
          request: String(m.content || '').slice(0, 500),
          reply: m.payload && m.payload.reply ? String(m.payload.reply).slice(0, 6000) : null,
          error: m.payload && m.payload.error ? m.payload.error : null,
          created_at: m.created_at
        });
      }
      const filter = args.conversation_id
        ? { toConversationId: args.conversation_id }
        : { fromConversationId: ctx.conversationId };
      const list = (ctx.store.agentMessages.list(filter) || []).map(m => ({
        message_id: m.id, status: m.status, to_conversation_id: m.to_conversation_id,
        depth: m.depth, request: String(m.content || '').slice(0, 200), created_at: m.created_at
      }));
      return ok({ count: list.length, deliveries: list });
    }
  }
];

module.exports = { tools, describeChat };
