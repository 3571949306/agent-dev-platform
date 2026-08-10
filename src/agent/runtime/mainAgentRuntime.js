'use strict';
/**
 * v2.6.0 Main Agent Runtime — 主编排器（spec §4/§27/§28/§29）。
 *
 * 把 Main Agent 的复杂逻辑从 ipc/handlers.js / pages.js 中抽离到独立模块。
 * 职责：
 *   - 创建 Run（通过 RunManager，复用唯一终态门）
 *   - 构建 runCtx（projectRoot / store / emit / abortSignal / permissionEngine）
 *   - 运行 Agent Loop
 *   - Stop / Cancel / Timeout / Late Result Guard（复用 RunManager terminal gate）
 *   - Run Persistence（spec §29）：持久化 run / tasks / blackboard / changed files / last step
 *   - Crash Recovery：interruptStale 已由 RunManager 处理
 *
 * 对外接口：
 *   runMainAgent({ conversationId, agentId, goal, projectRoot, projectId, model, getTool,
 *                  store, emit, runManager, requestPermission, limits, verification,
 *                  requiredFiles, initialPlan, conversationId }) -> { runId }
 *   runMainAgentSync(...) -> { status, ... }  // 同步等待完成（测试用）
 */

const crypto = require('crypto');
const states = require('./states');
const { EVENTS, timelineEntry, safeEmit } = require('./runtimeEvents');
const { createLimits } = require('./retryPolicy');
const { createPlan } = require('./taskPlanner');
const { createBlackboard } = require('./blackboard');
const { buildSystemPrompt } = require('./prompts/mainCodingAgent');
const { runAgentLoop } = require('./agentLoop');
const { changedFilesSummary } = require('./checkpoint');

/**
 * 启动 Main Agent Run（异步，立即返回 runId，状态通过事件推送）。
 * 与 agent:send 语义一致：IPC 立即 ACK，后台执行。
 *
 * @param {object} opts {
 *   conversationId, agentId, agentName, goal,
 *   projectRoot, projectId,
 *   model,          // { decide(...) }  生产用 ProviderModelAdapter / 测试用 FakeCodingModel
 *   getTool,        // (name) => tool def
 *   store, emit, runManager, requestPermission,
 *   limits?,        // retryPolicy.createLimits()
 *   verification?,  // [{ type:'command', command, required }]
 *   requiredFiles?,
 *   initialPlan?,   // [{ title }]
 *   timeoutMs?,     // run 总超时
 *   onToolResult?   // (action, result) => void
 * }
 * @returns {{ runId, conversationId }}
 */
function runMainAgent(opts) {
  const {
    conversationId, agentId, agentName = 'Main Agent',
    goal, projectRoot, projectId,
    model, getTool, store, emit, runManager, requestPermission,
    limits, verification, requiredFiles, initialPlan,
    timeoutMs, onToolResult
  } = opts;

  if (!runManager) throw new Error('runManager 必填');
  if (!model) throw new Error('model 必填（ProviderModelAdapter 或 FakeCodingModel）');
  if (!projectRoot) throw new Error('projectRoot 必填');

  // 1. 创建 Run（status=preparing，立即返回 runId）
  const run = runManager.createRun({ conversationId, agentId });
  const runId = run.id;

  const lim = limits || createLimits({ maxRuntimeMs: timeoutMs || lim0() });
  const plan = createPlan(goal, initialPlan || []);
  const blackboard = createBlackboard(goal);
  const verifyList = Array.isArray(verification) ? verification.map(v => ({ ...v, lastResult: null })) : [];

  // 2. 构建 runCtx
  const ac = new AbortController();
  const ctx = {
    projectRoot, projectId, agentId, agentName,
    conversationId, taskId: null,
    store, emit, abortSignal: ac.signal,
    // 工具需要的字段
    permissionEngine: opts.permissionEngine || null,
    // v2.9.0 §9 — MainAgentOrchestrator（delegate → AgentHub → Child Run → Blackboard）
    orchestrator: null   // 下方注入（如 AgentHub 可用）
  };

  // v2.9.0 §9 — 创建 Orchestrator 并注册（打通 delegate → AgentHub 闭环）
  //   executeDelegate 优先用 ctx.orchestrator.delegate 走完整编排链。
  //   AgentHub 不可用（隔离单测）时 orchestrator=null，delegate 回退现有逻辑。
  try {
    const { createMainAgentOrchestrator, register } = require('../orchestrator');
    const { getAgentHub } = require('../../agents/hub/agentHub');
    const _hub = getAgentHub();
    if (_hub) {
      const _orch = createMainAgentOrchestrator({
        hub: _hub, parentRunId: runId, parentAgentId: agentId || 'native-main',
        projectRoot, projectId, emit
      });
      _orch.start(goal);
      register(runId, _orch);
      ctx.orchestrator = _orch;
    }
  } catch { /* orchestrator 不可用时不阻塞 Main Agent（测试降级） */ }

  // 3. 注册到 activeRuns（供 agent:stop 中止）
  if (opts.registerAbort) opts.registerAbort(conversationId, ac);

  // 4. 状态迁移函数（发 mainAgent:stateChanged + runManager.updateRun）
  let currentState = 'IDLE';
  const setState = (next) => {
    if (!states.canTransition(currentState, next)) return;
    const prev = currentState;
    currentState = next;
    safeEmit(emit, EVENTS.STATE_CHANGED, { runId, state: next, previousState: prev });
    // 同步到 RunManager stage（映射到 runManager 的非终态名）
    try { runManager.updateRun(runId, mapToRunManagerState(next), { conversationId }); } catch { /* non-fatal */ }
  };

  // 5. run 总超时定时器
  let timeoutTimer = null;
  if (lim.maxRuntimeMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (!ac.signal.aborted) {
        ac.abort();
        // RunManager 终态用小写（'timeout'），大写会被当作未知终态拒绝。
        try { runManager.finishRun(runId, 'timeout', { source: 'mainAgentTimeout', message: `运行超时 ${lim.maxRuntimeMs}ms` }); } catch { /* Late Result Guard */ }
      }
    }, lim.maxRuntimeMs);
  }

  // 6. 后台执行 loop（不 await，立即返回 runId）
  (async () => {
    let result;
    try {
      // 创建 task 记录（store.tasks）
      if (store && store.tasks) {
        try {
          const task = store.tasks.create({ projectId, conversationId, agentId, title: String(goal || 'Main Agent 任务').slice(0, 60), status: 'running' });
          ctx.taskId = task.id;
        } catch { /* non-fatal */ }
      }

      const systemPrompt = buildSystemPrompt({
        projectName: opts.projectName,
        projectRoot,
        blackboardSummary: '',
        planSummary: ''
      });

      // 记录用户消息
      if (store && store.messages && conversationId) {
        try { store.messages.create({ conversation_id: conversationId, role: 'user', content: goal }); } catch { /* non-fatal */ }
      }

      result = await runAgentLoop({
        model, getTool, ctx, limits: lim, plan, blackboard,
        verification: verifyList, requiredFiles: requiredFiles || [],
        emit, runManager, runId, setState, systemPrompt,
        projectSummary: opts.projectSummary || '',
        requestPermission,
        onToolResult: onToolResult || defaultOnToolResult(ctx, store, conversationId)
      });

      // 持久化最终结果
      if (store && store.messages && conversationId) {
        try {
          store.messages.create({
            conversation_id: conversationId, role: 'assistant',
            content: result.summary || (result.status === 'completed' ? '任务完成' : (result.error || '任务结束')),
            model: agentName
          });
        } catch { /* non-fatal */ }
      }
      if (store && store.tasks && ctx.taskId) {
        try {
          store.tasks.update(ctx.taskId, {
            status: result.status === 'completed' ? 'completed' : (result.status === 'cancelled' ? 'cancelled' : 'failed'),
            summary: String(result.summary || result.error || '').slice(0, 200)
          });
        } catch { /* non-fatal */ }
      }

      // 推送终态事件（runManager.finishRun 已在 loop 内调用，这里补发 GUI 专用事件）
      emitTerminalEvent(emit, runId, result);
    } catch (e) {
      const isAbort = ctx.abortSignal.aborted || /\babort/i.test(e.message || '');
      const status = isAbort ? 'cancelled' : (/超时|timed?out/i.test(e.message || '') ? 'timeout' : 'failed');
      try { runManager.finishRun(runId, mapToRunManagerTerminal(status), { source: 'mainAgentCatch', error: e.message }); } catch { /* Late Result Guard */ }
      emitTerminalEvent(emit, runId, { status, error: e.message });
      result = { status, error: e.message };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (opts.unregisterAbort) opts.unregisterAbort(conversationId);
    }
  })();

  return { runId, conversationId };
}

/** 默认 onToolResult 钩子：记录到 events 表 + messages。 */
function defaultOnToolResult(ctx, store, conversationId) {
  return (action, result) => {
    if (!store) return;
    try {
      store.events.append({
        conversation_id: conversationId, task_id: ctx.taskId, agent_id: ctx.agentId,
        type: 'mainAgent:tool', payload: { action: { type: action.type, args: action.args }, ok: result.ok, tool: result.tool }
      });
    } catch { /* non-fatal */ }
  };
}

function emitTerminalEvent(emit, runId, result) {
  const changed = result.changedFiles || [];
  const tests = result.tests || [];
  if (result.status === 'completed') {
    safeEmit(emit, EVENTS.RUN_COMPLETED, { runId, summary: result.summary, changedFiles: changed, tests });
  } else if (result.status === 'failed') {
    safeEmit(emit, EVENTS.RUN_FAILED, { runId, error: result.error, errorCode: result.errorCode });
  } else if (result.status === 'cancelled') {
    safeEmit(emit, EVENTS.RUN_CANCELLED, { runId });
  } else if (result.status === 'timeout') {
    safeEmit(emit, EVENTS.RUN_TIMEOUT, { runId });
  }
}

/** Main Agent 状态 → RunManager stage（runManager 用小写非终态名）。 */
function mapToRunManagerState(s) {
  const map = {
    IDLE: 'preparing', PLANNING: 'preparing', READING_CONTEXT: 'preparing',
    EXECUTING: 'executing_tool', WAITING_TOOL: 'executing_tool',
    TESTING: 'testing', EVALUATING: 'executing_tool', REPAIRING: 'executing_tool',
    WAITING_PERMISSION: 'waiting_permission'
  };
  return map[s] || 'executing_tool';
}
function mapToRunManagerTerminal(s) {
  return { completed: 'completed', failed: 'failed', cancelled: 'cancelled', timeout: 'timeout' }[s] || 'failed';
}
function lim0() { return 10 * 60 * 1000; }

module.exports = { runMainAgent, EVENTS, states };
