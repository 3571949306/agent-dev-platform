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
const { dispatchRuntimeHook } = require('../../hooks/runtimeDispatch');
// v2.9.9 Phase B PART A（A1）— Verification Truth：终态时把机器证据落库
const { verificationFromOutcome } = require('../runVerification');

/**
 * v2.9.9 Phase B PART A（A1）— 终态后持久化验证证据。
 * 只写 runs.verification_status，绝不影响 run.status（两个独立事实）。
 * 证据持久化失败不得影响 Run 终态。
 */
function persistVerificationEvidence(store, runId, result) {
  if (!store || !store.runs || typeof store.runs.setVerification !== 'function') return;
  try {
    const evidence = verificationFromOutcome({
      status: result && result.status,
      completion: result && result.completion,
      tests: result && result.tests
    });
    store.runs.setVerification(runId, evidence);
  } catch { /* 证据持久化失败不得影响 Run 终态 */ }
}

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
    timeoutMs, onToolResult, pathSecurity
  } = opts;

  if (!runManager) throw new Error('runManager 必填');
  if (!model) throw new Error('model 必填（ProviderModelAdapter 或 FakeCodingModel）');
  if (!projectRoot) throw new Error('projectRoot 必填');

  // 1. 创建 Run（status=preparing，立即返回 runId）
  const run = runManager.createRun({
    conversationId,
    agentId,
    parentRunId: opts.parentRunId || null,
    rootRunId: opts.rootRunId || null,
    depth: opts.parentRunId ? 1 : 0
  });
  const runId = run.id;
  if (typeof opts.onRunCreated === 'function') {
    try { opts.onRunCreated({ runId, conversationId: conversationId || null, agentId: agentId || null }); }
    catch (error) {
      try { runManager.finishRun(runId, 'failed', { error: error.message, source: 'modelRouteBinding' }); } catch { /* best effort */ }
      throw error;
    }
  }

  // v2.9.8 R7 — Project Lock / Run Isolation：Main Run 在启动前获取项目写锁。
  // 锁 holder 绑定真实身份（runId + agentId + canonical projectRoot），绝不用
  // conversationId 伪装。获取失败（另一 Run 持锁）= fail busy：诚实 failed(PROJECT_LOCKED)，
  // 零 mutation。释放统一在后台 loop 的 finally（完成/取消/失败/超时都释放）。
  const projectMutationLock = opts.projectMutationLock || null;
  let projectLockHeld = false;
  if (projectMutationLock && projectRoot) {
    const lockResult = projectMutationLock.acquireWrite(projectRoot, runId, agentId || 'native-main');
    if (!lockResult.ok) {
      const holder = lockResult.lockHolder || null;
      try {
        runManager.finishRun(runId, 'failed', {
          source: 'projectMutationLock',
          error: 'PROJECT_LOCKED: 项目正被另一个 Run 修改（holder=' + (holder ? holder.runId : 'unknown') + '）',
          message: '项目写锁被占用，任务未启动'
        });
      } catch { /* Late Result Guard */ }
      emitTerminalEvent(emit, runId, { status: 'failed', error: 'PROJECT_LOCKED', errorCode: 'PROJECT_LOCKED' });
      persistVerificationEvidence(store, runId, { status: 'failed' });
      return { runId, conversationId, locked: false, lockHolder: holder };
    }
    projectLockHeld = true;
  }

  const lim = limits || createLimits({ maxRuntimeMs: timeoutMs || lim0() });
  const plan = createPlan(goal, initialPlan || []);
  const blackboard = createBlackboard(goal);
  const verifyList = Array.isArray(verification) ? verification.map(v => ({ ...v, lastResult: null })) : [];

  // v2.9.9 Phase B PART A（A1/A3）— 事件审计链 + 逻辑去重身份：
  //   1. 每个事件携带稳定 eventId（Renderer 逻辑去重的首选身份，不再依赖 JS 对象引用）
  //   2. TEST_RESULT 持久化进 events 表，作为 Verification Truth 的机器证据
  const upstreamEmit = typeof emit === 'function' ? emit : () => {};
  const trackedEmit = (type, payload) => {
    const enriched = (payload && typeof payload === 'object')
      ? (payload.eventId ? payload : { eventId: crypto.randomUUID(), ...payload })
      : payload;
    upstreamEmit(type, enriched);
    if (type === EVENTS.TEST_RESULT && store && store.events && conversationId) {
      try {
        store.events.append({
          conversation_id: conversationId, task_id: null, agent_id: agentId,
          type, payload: { ...enriched, runId }
        });
      } catch { /* 审计持久化失败不得中断 Run */ }
    }
  };

  // 2. 构建 runCtx
  const ac = new AbortController();
  const ctx = {
    runId,
    rootRunId: opts.rootRunId || run.rootRunId || runId,
    parentRunId: opts.parentRunId || run.parentRunId || null,
    projectRoot, projectId, agentId, agentName,
    conversationId, taskId: null,
    store, emit: trackedEmit, abortSignal: ac.signal,
    // 工具需要的字段
    permissionEngine: opts.permissionEngine || null,
    // v2.9.0 Real Runtime Closure（R4）：工具权限闸门需要 requestPermission（'ask' 决策通道）
    requestPermission: requestPermission || null,
    // v2.9.0 Real Runtime Closure（R3）：per-run PathSecurity（cacheRoots）；未注入时工具用默认实例
    pathSecurity: pathSecurity || null,
    // v2.9.0 §9 — MainAgentOrchestrator（delegate → AgentHub → Child Run → Blackboard）
    orchestrator: null,   // 下方注入（如 AgentHub 可用）
    canDelegate: opts.canDelegate !== false,
    delegationPath: Array.isArray(opts.delegationPath) ? opts.delegationPath.slice() : [],
    agentType: 'native',
    skillIds: Array.isArray(opts.skillIds) ? opts.skillIds.slice() : [],
    hookIds: [],
    hookEngine: opts.hookEngine || null
  };

  // v2.9.3 Skill Engine（R7）— 在启动前解析 Skill（fail fast）。
  // Skill 只能要求能力，不能授予能力：解析失败（SKILL_*）直接终止 Run，
  // 而不是静默降级继续执行。deniedTools 通过包装 getTool 强制生效。
  const { skillIds, skillInstructions: passthroughSkillInstructions } = opts;
  const wantSkills = Array.isArray(skillIds) && skillIds.length > 0;
  let skillResolution = null;
  let effectiveGetTool = getTool;
  if (wantSkills) {
    try {
      const { getSkillRuntime } = require('../../skills/runtimeRegistry');
      const skillRegistry = opts.skillRegistry || getSkillRuntime().registry;
      const skillResolver = opts.skillResolver || getSkillRuntime().resolver;
      if (!skillRegistry || !skillResolver) {
        const error = new Error('SKILL_ENGINE_UNAVAILABLE: SkillRegistry/SkillResolver 未注入');
        error.code = 'SKILL_ENGINE_UNAVAILABLE';
        throw error;
      }
      const availableToolNames = opts.availableToolNames || require('../../tools/registry').listBuiltinDefs().map(def => def.name);
      const resolution = skillResolver.resolve({
        requestedSkillIds: skillIds,
        agentContext: {
          toolPolicy: { allow: [], deny: [] },
          permissionPolicy: { readOnly: false, allow: [], deny: [] },
          permissionCheck: opts.permissionEngine
            ? scope => opts.permissionEngine.evaluate(scope, {}) === 'allow'
            : null,
          availableTools: availableToolNames,
          modelRequirements: opts.modelRequirements || {}
        },
        projectContext: { projectRoot, projectId }
      });
      if (!resolution.ok) {
        const error = new Error(`${resolution.errorCode}: ${resolution.error}`);
        error.code = resolution.errorCode;
        throw error;
      }
      skillResolution = resolution;
      const denied = new Set(resolution.deniedTools);
      if (denied.size) {
        effectiveGetTool = name => (denied.has(name) ? null : getTool(name));
      }
    } catch (error) {
      // fail-closed：Skill 解析失败 → Run 直接失败，绝不静默继续
      try { runManager.finishRun(runId, 'failed', { error: error.message, source: 'skillResolution' }); } catch { /* Late Result Guard */ }
      emitTerminalEvent(emit, runId, { status: 'failed', error: error.message, errorCode: error.code });
      persistVerificationEvidence(store, runId, { status: 'failed' });
      if (projectLockHeld) { try { projectMutationLock.release(runId); } catch { /* noop */ } projectLockHeld = false; }
      throw error;
    }
  }

  // 动态子 Agent 携带已解析的 Skill Instructions（agentFactory 在创建实例时解析并传入）
  const skillInstructions = skillResolution
    ? skillResolution.instructions
    : (passthroughSkillInstructions || null);

  // Hook definitions belong to this existing Run. Resolve the requested set
  // before any provider/tool/delegate call; missing definitions, disabled
  // required hooks, and unregistered trusted handlers fail closed.
  const requestedHookIds = Array.isArray(opts.hookIds) ? opts.hookIds : [];
  if (requestedHookIds.length) {
    const { getHookRuntime } = require('../../hooks/runtimeRegistry');
    const hookEngine = opts.hookEngine || getHookRuntime();
    if (!hookEngine || !hookEngine.resolver) {
      const error = new Error('HOOK_ENGINE_UNAVAILABLE: Hook Engine is not initialized');
      error.code = 'HOOK_ENGINE_UNAVAILABLE';
      try { runManager.finishRun(runId, 'failed', { error: error.message, source: 'hookResolution' }); } catch { /* terminal gate */ }
      if (projectLockHeld) { try { projectMutationLock.release(runId); } catch { /* noop */ } projectLockHeld = false; }
      throw error;
    }
    const selection = hookEngine.resolver.resolveSelection({ hookIds: requestedHookIds });
    if (!selection.ok) {
      const error = new Error(`${selection.errorCode}: ${selection.error}`);
      error.code = selection.errorCode;
      try { runManager.finishRun(runId, 'failed', { error: error.message, source: 'hookResolution' }); } catch { /* terminal gate */ }
      if (projectLockHeld) { try { projectMutationLock.release(runId); } catch { /* noop */ } projectLockHeld = false; }
      throw error;
    }
    ctx.hookEngine = hookEngine;
    ctx.hookIds = selection.hookIds;
  }

  // v2.9.0 §9 — 创建 Orchestrator 并注册（打通 delegate → AgentHub 闭环）
  //   executeDelegate 优先用 ctx.orchestrator.delegate 走完整编排链。
  //   AgentHub 不可用（隔离单测）时 orchestrator=null，delegate 回退现有逻辑。
  let _orch = null;
  let _unregister = null;
  // v2.9.8 Final Closure（A8）— descendant quiescence 探测依赖：保留 hub 与
  // dynamic factory 引用，finally 中用真实 lifecycle/实例状态作证据。
  let _hub = null;
  let _dynamicFactory = null;
  try {
    const { createMainAgentOrchestrator, register, unregister } = require('../orchestrator');
    _unregister = unregister;
    const { getAgentHub } = require('../../agents/hub/agentHub');
    const dynamicRuntime = require('../../agents/dynamic/runtimeRegistry').getDynamicAgentRuntime();
    _dynamicFactory = (dynamicRuntime && dynamicRuntime.factory) || null;
    _hub = getAgentHub();
    if (_hub) {
      _orch = createMainAgentOrchestrator({
        hub: _hub, parentRunId: runId, rootRunId: opts.rootRunId || runId, parentAgentId: agentId || 'native-main',
        projectRoot, projectId, emit,
        dynamicAgentFactory: opts.dynamicAgentFactory || dynamicRuntime.factory || null,
        definitionStore: opts.definitionStore || dynamicRuntime.definitionStore || null,
        parentModelAdapter: model,
        parentPermissionEngine: opts.permissionEngine || null,
        parentCanDelegate: opts.canDelegate !== false,
        parentPolicy: opts.parentPolicy || null,
        getTool: effectiveGetTool
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
  // v2.9.8 Final Closure（A1）— abort 携带 reason 区分 timeout 与 user cancel（设计 A），
  // 但最终 terminal truth 仍以 RunManager 为准（设计 C 兑底）。
  let timeoutTimer = null;
  if (lim.maxRuntimeMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (!ac.signal.aborted) {
        try { ac.abort({ type: 'timeout', runId }); } catch { ac.abort(); }
        // RunManager 终态用小写（'timeout'），大写会被当作未知终态拒绝。
        try { runManager.finishRun(runId, 'timeout', { source: 'mainAgentTimeout', message: `运行超时 ${lim.maxRuntimeMs}ms` }); } catch { /* Late Result Guard */ }
      }
    }, lim.maxRuntimeMs);
  }

  // 6. 后台执行 loop（不 await，立即返回 runId）
  (async () => {
    let result;
    try {
      const runStart = await dispatchRuntimeHook(ctx, 'run_start');
      if (!runStart.ok) {
        const error = new Error(runStart.error || runStart.errorCode);
        error.code = runStart.errorCode;
        throw error;
      }
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
        dynamicRole: opts.dynamicRole,
        dynamicRolePrompt: opts.dynamicSystemPrompt,
        skillInstructions,
        hookContextSlot: true,
        blackboardSummary: '',
        planSummary: ''
      });

      // 记录用户消息
      if (store && store.messages && conversationId) {
        try { store.messages.create({ conversation_id: conversationId, role: 'user', content: goal }); } catch { /* non-fatal */ }
      }

      result = await runAgentLoop({
        model, getTool: effectiveGetTool, ctx, limits: lim, plan, blackboard,
        verification: verifyList, requiredFiles: requiredFiles || [],
        emit: trackedEmit, runManager, runId, setState, systemPrompt,
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

      // 推送终态事件（以 RunManager terminal truth 为准，一个 Run 只发一次 terminal event）
      const finalRun = runManager.getRun(runId);
      const terminalStatus = finalRun && finalRun.status ? finalRun.status : (result && result.status);
      emitTerminalEvent(emit, runId, { ...result, status: terminalStatus });
      // v2.9.9 Phase B PART A（A1）— 验证证据落库（CompletionPolicy/测试结果的机器证据）
      persistVerificationEvidence(store, runId, { ...result, status: terminalStatus });
    } catch (e) {
      // v2.9.8 Final Closure（A1）— Terminal Truth All Exit Paths：
      // catch 只推断「写入 RunManager 的目标终态」；若 RunManager 已终态（如 timeout
      // timer 先到），finishRun 被终态门忽略。最终 GUI terminal event 一律以
      // RunManager finalRun.status 为准，禁止 catch 自己重新声称最终事实。
      const abortReason = ctx.abortSignal && ctx.abortSignal.reason;
      const isTimeoutAbort = !!(abortReason && abortReason.type === 'timeout');
      const isAbort = ctx.abortSignal.aborted || /\babort/i.test(e.message || '');
      const inferred = isTimeoutAbort ? 'timeout'
        : (isAbort ? 'cancelled' : (/超时|timed?out/i.test(e.message || '') ? 'timeout' : 'failed'));
      try { runManager.finishRun(runId, mapToRunManagerTerminal(inferred), { source: 'mainAgentCatch', error: e.message }); } catch { /* Late Result Guard */ }
      const finalRun = runManager.getRun(runId);
      const truthStatus = finalRun && finalRun.status ? finalRun.status : inferred;
      emitTerminalEvent(emit, runId, { status: truthStatus, error: e.message, errorCode: e.code });
      persistVerificationEvidence(store, runId, { status: truthStatus });
      result = { status: truthStatus, error: e.message, errorCode: e.code };
    } finally {
      try {
        const finalRun = runManager.getRun(runId);
        await dispatchRuntimeHook(ctx, 'run_end', {
          outcome: { status: finalRun ? finalRun.status : (result && result.status), errorCode: result && result.errorCode }
        });
      } catch { /* run_end observers cannot alter terminal truth */ }
      if (timeoutTimer) clearTimeout(timeoutTimer);

      // v2.9.8 R2 / Final Closure（A8）— Parent lock must outlive owned descendants：
      // 先级联取消所有 running child，然后 bounded 等待 descendant quiescence
      //（runtime execution + hub lifecycle + dynamic 实例 + terminal 进程全部真实停止），
      // 再释放项目锁，最后才解注册 abort/runtime bookkeeping。
      //
      // 完整 quiescence 探测只对「持有项目锁的 root run」启用（A8 的锁释放门控）。
      // 重入父锁的 child run 不持有锁，其清理只需等待自己的 descendant tracker 终态，
      // 否则 child 会反过来等待 root 的 dynamic 实例 dispose，造成交叉等待拖慢 unregister。
      if (_orch) {
        try {
          // 级联取消所有 running child（不等待 dispose 内部再取消）
          await _orch.cancelAllChildren(async (childRunId) => {
            try { await _orch.cancelChild(childRunId); } catch { /* noop */ }
          });
        } catch { /* noop */ }
        const quiescenceProbes = projectLockHeld ? {
          hub: _hub,
          // 仅计当前 root 树 owned 的 Dynamic 实例
          dynamicInstanceCount: () => (_dynamicFactory && typeof _dynamicFactory.activeForRoot === 'function')
            ? _dynamicFactory.activeForRoot(ctx.rootRunId || runId)
            : 0,
          // owned terminal 进程计数（全局兑底：任何活进程存在都延迟释放，方向安全）
          terminalActiveCount: () => require('../../tools/terminal').terminalManager.activeCount()
        } : {};
        // bounded 等待 descendant quiescence（最大 5 秒，超时强制继续，绝不无限持锁）
        try { await waitDescendantCleanup(_orch, 5000, quiescenceProbes); } catch { /* noop */ }
        try { await _orch.dispose(); } catch { /* noop */ }
        try { if (_unregister) _unregister(runId); } catch { /* noop */ }
      }

      // v2.9.8 R7/R2 — 终态后释放项目写锁（完成/取消/失败/超时统一路径，锁绝不陪葬）
      if (projectLockHeld) {
        try { projectMutationLock.release(runId); } catch { /* noop */ }
        projectLockHeld = false;
      }

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
    // v2.9.8 R4：verificationStatus 真话（PASS/FAIL/NOT_AVAILABLE）随完成事件可观测
    safeEmit(emit, EVENTS.RUN_COMPLETED, {
      runId, summary: result.summary, changedFiles: changed, tests,
      verificationStatus: (result.completion && result.completion.verificationStatus) || 'NOT_AVAILABLE'
    });
  } else if (result.status === 'failed') {
    safeEmit(emit, EVENTS.RUN_FAILED, { runId, error: result.error, errorCode: result.errorCode });
  } else if (result.status === 'cancelled') {
    safeEmit(emit, EVENTS.RUN_CANCELLED, { runId });
  } else if (result.status === 'timeout') {
    safeEmit(emit, EVENTS.RUN_TIMEOUT, { runId });
  }
}

/**
 * Main Agent 状态 → RunManager stage（runManager 用小写非终端态名）。
 *
 * v2.9.0 Real Runtime Closure（P1 Run State Consistency）：修正映射链，
 * 保证每次 updateRun 都落在 RunManager 合法迁移表内：
 *   preparing(PLANNING) → requesting_model(READING_CONTEXT) → executing_tool(EXECUTING/TESTING)
 * 旧映射把 READING_CONTEXT 映为 'preparing'、TESTING 映为 'testing'，会产生
 * preparing → executing_tool 的非法迁移警告（RunManager 合法表无此边，且
 * 'testing' 从 requesting_model 不可达）。修映射链，不放宽 RunManager。
 */
function mapToRunManagerState(s) {
  const map = {
    IDLE: 'preparing', PLANNING: 'preparing',
    READING_CONTEXT: 'requesting_model',
    EXECUTING: 'executing_tool', WAITING_TOOL: 'executing_tool',
    TESTING: 'executing_tool', EVALUATING: 'executing_tool', REPAIRING: 'executing_tool',
    WAITING_PERMISSION: 'waiting_permission'
  };
  return map[s] || 'executing_tool';
}
function mapToRunManagerTerminal(s) {
  return { completed: 'completed', failed: 'failed', cancelled: 'cancelled', timeout: 'timeout' }[s] || 'failed';
}

/**
 * v2.9.8 R2 / Final Closure（A8）— Bounded descendant quiescence wait。
 *
 * Child terminal flag != Child execution quiesced。root project lock 只有在
 * 所有 owned descendant 的 runtime execution / lifecycle / terminal 进程真正
 * 停止后才能释放。证据链（每项都是真实探测，不是 status 推断）：
 *   - trackerTerminal：childRunTracker 全部终态（runtime task promise settled）
 *   - hubLifecycleTerminal：AgentHub lifecycle 不再 active
 *   - dynamicInstancesZero：Dynamic 实例已 dispose
 *   - terminalProcessesZero：owned terminal 进程数 = 0
 * bounded：超过 timeoutMs 强制返回（root terminal truth 保持真实，绝不无限持锁），
 * 上层已有强制终止机制兑底。
 * @returns {Promise<{ quiesced: boolean, evidence: object }>}
 */
async function waitDescendantCleanup(orchestrator, timeoutMs, probes = {}) {
  const evidence = {
    trackerTerminal: true,
    hubLifecycleTerminal: true,
    dynamicInstancesZero: true,
    terminalProcessesZero: true
  };
  if (!orchestrator || !orchestrator.childRunTracker) return { quiesced: true, evidence };
  const tracker = orchestrator.childRunTracker;
  const deadline = Date.now() + timeoutMs;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'];
  while (Date.now() < deadline) {
    const children = (tracker.getChildren && tracker.getChildren(orchestrator.parentRunId)) || [];
    const allTrackerTerminal = children.every(childId => tracker.isTerminal(childId));
    evidence.trackerTerminal = allTrackerTerminal;

    // AgentHub lifecycle 探测：child 的 hub run 也必须终态
    if (allTrackerTerminal && probes.hub && typeof probes.hub.status === 'function') {
      let allHubTerminal = true;
      for (const childId of children) {
        try {
          const st = await probes.hub.status(childId);
          if (st && !TERMINAL.includes(st.status)) { allHubTerminal = false; break; }
        } catch { /* 查不到映射 = 已不在活跃生命周期 */ }
      }
      evidence.hubLifecycleTerminal = allHubTerminal;
    } else if (!probes.hub) {
      evidence.hubLifecycleTerminal = allTrackerTerminal;
    }

    // Dynamic 实例探测（仅计当前 root 树 owned 实例，避免被无关 run 干扰）
    if (typeof probes.dynamicInstanceCount === 'function') {
      try { evidence.dynamicInstancesZero = probes.dynamicInstanceCount() === 0; } catch { /* best effort */ }
    }

    // Owned terminal 进程探测（仅计当前 runId，避免被无关 run 干扰）
    if (typeof probes.terminalActiveCount === 'function') {
      try { evidence.terminalProcessesZero = probes.terminalActiveCount() === 0; } catch { /* best effort */ }
    }

    if (allTrackerTerminal && evidence.hubLifecycleTerminal
        && evidence.dynamicInstancesZero && evidence.terminalProcessesZero) {
      return { quiesced: true, evidence };
    }
    await sleep(20);
  }
  return { quiesced: false, evidence };
}

function lim0() { return 10 * 60 * 1000; }

module.exports = { runMainAgent, EVENTS, states };
