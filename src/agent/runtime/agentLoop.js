'use strict';
/**
 * v2.6.0 Main Agent Runtime — Agent Loop（spec §6）。
 *
 * while (!done) {
 *   gatherContext();
 *   decision = await model.decide();
 *   execute(decision);
 *   observeResult();
 *   evaluate();
 *   if (needsRepair) { repair(); continue; }
 *   if (goalSatisfied) { complete(); break; }
 * }
 *
 * 但不能无限循环：maxIterations / maxToolCalls / maxRepairRounds / maxRuntimeMs /
 * maxInvalidActions。超过限制 → FAILED(AGENT_LOOP_LIMIT)，不能假装 completed。
 *
 * Stop / Timeout 通过 abortSignal 与 RunManager terminal gate 保证：
 * 一个 runId 最多一个 terminal event，Late Result 不得覆盖 cancelled/timeout。
 */

const states = require('./states');
const { EVENTS, timelineEntry, safeEmit } = require('./runtimeEvents');
const { parseAndValidate, READ_ONLY_ACTIONS } = require('./actionSchema');
const { executeAction, isMutatingAction, isTestAction } = require('./actionExecutor');
const { evaluateActionResult, testStatusFromResult } = require('./resultEvaluator');
const { checkLimits } = require('./retryPolicy');
const { evaluate } = require('./completionPolicy');
const { buildContext, compact, runSummary } = require('./contextBuilder');
const { createCheckpoint, trackFileChange, listChangedFiles, changedFilesSummary } = require('./checkpoint');
const { addFact, addProblem, resolveProblemsMatching, addImportantFile, update: bbUpdate } = require('./blackboard');

// v2.9.8 R4 — 完成裁决的诊断问题（「完成策略未满足: ...」）只为反馈模型而存在：
// 每次重新评估 / 新鲜测试通过后必须清除，否则旧裁决文本会永久污染
// unresolvedErrors，把本可完成的 run 顶成 AGENT_REPAIR_LIMIT。
const COMPLETION_POLICY_PROBLEM_PREFIX = '完成策略未满足';
function clearCompletionPolicyProblems(blackboard) {
  if (!blackboard || !Array.isArray(blackboard.problems)) return;
  blackboard.problems = blackboard.problems.filter(p => !String(p).startsWith(COMPLETION_POLICY_PROBLEM_PREFIX));
}
const { composeSystemPromptWithHookContext } = require('./prompts/mainCodingAgent');
const { dispatchRuntimeHook } = require('../../hooks/runtimeDispatch');
const mt = require('./multiturn');

/** 多轮历史结果摘要（tool_result content）。 */
function mtResultText(r) {
  if (!r) return '';
  if (!r.ok && r.error) return `失败[${r.error.code || ''}] ${r.error.message || ''}`;
  return r.stdoutSummary || r.stderrSummary || r.summary || (r.ok ? '成功' : '失败');
}

// v2.9.8 Final Closure（A1）— 区分 user cancellation 与 run timeout abort：
// mainAgentRuntime 的 timeout timer 以 ac.abort({ type: 'timeout' }) 触发，
// 用户 stop 是普通 abort（无 reason）。loop 据此结算正确的终态语义；
// 最终 terminal truth 仍由 RunManager 终态门兑底（先到者胜）。
function abortTerminalStatus(ctx) {
  const reason = ctx && ctx.abortSignal && ctx.abortSignal.reason;
  return reason && reason.type === 'timeout'
    ? { status: 'timeout', summary: '运行超时' }
    : { status: 'cancelled', summary: '用户已停止' };
}

/**
 * 运行 Main Agent Loop。
 * @param {object} deps {
 *   model,             // { decide({system, context, iteration, abortSignal}) -> { text?|action? } }
 *   getTool,           // (name) => tool def
 *   ctx,               // runCtx { projectRoot, projectId, taskId, agentId, agentName, conversationId, store, emit, abortSignal }
 *   limits,            // retryPolicy.createLimits()
 *   plan,              // taskPlanner plan
 *   blackboard,        // blackboard
 *   verification,      // [{ type:'command', command, required }]
 *   requiredFiles,     // string[]
 *   emit,              // event emitter
 *   runManager, runId, // RunManager + runId
 *   setState,          // (state) => void  状态迁移
 *   systemPrompt,      // string
 *   projectSummary,    // string
 *   requestPermission, // (req) => { decision }
 *   onToolResult       // (action, result) => void  钩子（记录到 messages 等）
 * }
 * @returns {Promise<{ status, summary?, error?, errorCode?, changedFiles?, tests? }>}
 */
async function runAgentLoop(deps) {
  const { model, getTool, ctx, limits, plan, blackboard, emit, runManager, runId, setState, systemPrompt, projectSummary } = deps;
  const verification = Array.isArray(deps.verification) ? deps.verification : [];
  const requiredFiles = Array.isArray(deps.requiredFiles) ? deps.requiredFiles : [];
  const startedAt = Date.now();

  const counters = { iteration: 0, toolCalls: 0, repairRounds: 0, invalidActions: 0, runtimeMs: 0 };
  const toolResults = []; // 历史工具结果
  // v2.9.9 Phase 5：真实多轮历史（opt-in，默认关闭以保证回归）。仅 tools 路径 provider 消费。
  const useMultiturn = !!ctx.multiturn;
  const history = [];
  let taskDescription = '';
  let lastTestResult = null;
  let checkpointCreated = false;
  let terminalReached = false;
  // v2.9.8 R4 — Verification Freshness：每次成功的文件变异递增；测试/验证结果
  // 记录其对应的 seq，完成裁决要求验证不早于最后一次变异。
  let mutationSeq = 0;

  const finish = (status, extra = {}) => {
    if (terminalReached) return null;
    terminalReached = true;
    if (runManager && runId) {
      // RunManager 统一使用小写终态名（completed/failed/cancelled/timeout），
      // 之前误把 status 映射成大写 'COMPLETED' 会被 RunManager 当作未知终态拒绝，
      // 导致 run 记录从未真正进入终态，后续 late finishRun('failed') 反而能覆盖。
      try {
        runManager.finishRun(runId, status, {
          source: 'mainAgentLoop',
          ...extra,
          message: extra.message || extra.summary || null
        });
      } catch { /* Late Result Guard */ }
    }
    return { status, ...extra };
  };

  try {
    while (true) {
      // 0. 中止 / 超时检查
      if (ctx.abortSignal && ctx.abortSignal.aborted) {
        const ab = abortTerminalStatus(ctx);
        return finish(ab.status, { summary: ab.summary });
      }
      counters.runtimeMs = Date.now() - startedAt;
      const lim = checkLimits(limits, counters);
      if (lim.exceeded) {
        return finish('failed', { errorCode: lim.code, error: lim.message, summary: lim.message });
      }

      counters.iteration++;
      // 1. 状态 → PLANNING（首轮）/ READING_CONTEXT
      if (counters.iteration === 1) {
        setState('PLANNING');
        safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('analyze', '分析项目与需求') });
        safeEmit(emit, EVENTS.RUN_STARTED, { runId, conversationId: ctx.conversationId, goal: blackboard.goal });
      }

      // v2.9.8 R7：run 总超时触发后（超时定时器已把 run 标记 timeout 并 abort），
      // 循环必须在当前迭代内立即退出，而不是拖到下一迭代才结算。
      if (ctx.abortSignal && ctx.abortSignal.aborted) {
        const ab = abortTerminalStatus(ctx);
        return finish(ab.status, { summary: ab.summary });
      }

      // 2. 构建上下文
      setState('READING_CONTEXT');
      const compacted = compact(toolResults);
      const contextText = buildContext({
        goal: blackboard.goal,
        plan,
        blackboard,
        currentTask: (plan.tasks && plan.tasks.find(t => t.status === 'in_progress' || t.status === 'pending')) || null,
        toolResults: compacted.recent,
        changedFiles: listChangedFiles(ctx).map(f => f.path),
        currentDiff: '',
        projectSummary,
        iteration: counters.iteration,
        repairRounds: counters.repairRounds,
        // v2.9.9 Phase 4：token 预算（可经 ctx/agent 配置覆盖），估算值以 debug 日志暴露
        maxContextTokens: (ctx.agent && ctx.agent.max_context_tokens) || ctx.maxContextTokens || undefined,
        onTokens: (t, max) => { if (process.env.ADP_DEBUG_CONTEXT) console.error(`[context] tokens≈${t}/${max}`); }
      });
      // Phase 5：首轮 context（目标+计划）作为多轮历史的首条 user 任务描述
      if (useMultiturn && counters.iteration === 1) taskDescription = contextText;
      if (compacted.summary) {
        // 压缩摘要作为额外事实
      }

      // 3. 调用模型决策
      let decision;
      try {
        const beforeModel = await dispatchRuntimeHook(ctx, 'before_model', {
          iteration: counters.iteration,
          actionType: 'model_decision'
        });
        if (!beforeModel.ok) {
          return finish('failed', {
            errorCode: beforeModel.errorCode,
            error: beforeModel.error,
            summary: beforeModel.error
          });
        }
        decision = await model.decide({
          system: composeSystemPromptWithHookContext(systemPrompt, beforeModel.context),
          context: contextText,
          iteration: counters.iteration,
          abortSignal: ctx.abortSignal,
          // Phase 5：真实多轮历史（仅 tools 路径 provider 消费；文本路径忽略）
          history: useMultiturn ? mt.toProviderMessages(history, taskDescription) : undefined
        });
        await dispatchRuntimeHook(ctx, 'after_model', {
          iteration: counters.iteration,
          actionType: decision && decision.action ? decision.action.type : 'model_response',
          outcome: { hasAction: !!(decision && decision.action) }
        });
      } catch (e) {
        if (ctx.abortSignal && ctx.abortSignal.aborted) {
          const ab = abortTerminalStatus(ctx);
          return finish(ab.status, { summary: ab.summary });
        }
        const isTimeout = /超时|timed?out/i.test(e.message || '');
        if (isTimeout) return finish('timeout', { error: e.message });
        return finish('failed', { error: '模型调用失败: ' + e.message, errorCode: 'MODEL_CALL_FAILED' });
      }

      // 4. 解析 + 校验 Action
      let action;
      if (decision && decision.action) {
        // Fake Model 或已结构化返回
        const { validateAction } = require('./actionSchema');
        const v = validateAction(decision.action);
        if (!v.ok) {
          counters.invalidActions++;
          safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('error', '模型返回无效 Action', v.error) });
          continue;
        }
        action = v.action;
      } else {
        const text = (decision && decision.text) || String(decision || '');
        const pv = parseAndValidate(text);
        if (!pv.ok) {
          counters.invalidActions++;
          safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('error', '模型响应无法解析', pv.error) });
          // 尝试让模型 repair（有限次数后 AGENT_RESPONSE_INVALID 已由 limits 处理）
          continue;
        }
        action = pv.action;
      }
      counters.invalidActions = 0; // 成功解析，重置

      // v2.9.9 体验对标 Phase 2：一轮多个只读 action → Promise.all 并发执行。
      // 任一并发调用抛异常被捕获为结构化错误（不丢失其它成功结果）。
      // 写类/命令类/delegate 不会进入此分支（adapter 已保证全只读），仍走下方单 action 路径。
      if (decision && Array.isArray(decision.actions) && decision.actions.length > 1 &&
          decision.actions.every(a => READ_ONLY_ACTIONS.includes(a.type))) {
        const acts = decision.actions;
        for (const a of acts) safeEmit(emit, EVENTS.ACTION, { runId, action: a, thought: a.thought });
        setState('READING_CONTEXT');
        safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('read', `并发执行 ${acts.length} 个只读操作`) });
        const results = await Promise.all(acts.map(a =>
          executeAction(ctx, a, getTool).catch(e => ({ ok: false, tool: a.type, action: a, error: { code: 'EXEC_ERROR', message: e.message, retryable: true } }))
        ));
        counters.toolCalls += acts.length;
        acts.forEach((a, i) => {
          const r = results[i];
          if (typeof deps.onToolResult === 'function') { try { deps.onToolResult(a, r); } catch { /* non-fatal */ } }
          safeEmit(emit, EVENTS.TOOL_RESULT, { runId, tool: r.tool, ok: r.ok, summary: r.stdoutSummary || r.stderrSummary || (r.ok ? '成功' : '失败'), error: r.error && { code: r.error.code, message: r.error.message } });
          toolResults.push({ action: a, ...r, summary: r.stdoutSummary || r.stderrSummary || r.summary });
        });
        // Phase 5：记录 assistant tool_use + 配对 tool_result
        if (useMultiturn) {
          const tcs = acts.map((a, i) => ({ id: mt.makeToolCallId(runId, counters.iteration, i), name: a.type, arguments: JSON.stringify(a.args || {}) }));
          mt.pushAssistant(history, { text: acts[0].thought, toolCalls: tcs });
          acts.forEach((a, i) => mt.pushToolResult(history, tcs[i].id, mtResultText(results[i])));
        }
        continue;
      }

      safeEmit(emit, EVENTS.ACTION, { runId, action, thought: action.thought });
      if (action.thought) safeEmit(emit, EVENTS.ASSISTANT_TEXT, { runId, text: action.thought });

      // 5. complete Action → 完成策略评估
      if (action.type === 'complete') {
        setState('EVALUATING');
        // v2.9.8 R4：上一轮裁决记录的「完成策略未满足」问题只服务于诊断反馈，
        // 重新评估前必须清除，否则旧裁决文本会污染 unresolvedErrors 形成死循环。
        if (typeof clearCompletionPolicyProblems === 'function') clearCompletionPolicyProblems(blackboard);
        // 运行 required verification（若未运行）
        const verificationResults = await runVerification(deps, ctx, verification, emit, runId, getTool, mutationSeq);
        const unresolvedErrors = blackboard.problems.slice();
        const completionCtx = {
          plan, blackboard,
          changedFiles: listChangedFiles(ctx).map(f => f.path),
          verification: verificationResults,
          unresolvedErrors,
          requiredFiles,
          // v2.9.8 R4：新鲜度裁决输入
          mutationSeq,
          latestTest: lastTestResult
        };
        const verdict = evaluate(completionCtx);
        if (verdict.satisfied) {
          safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('complete', '完成', action.args && action.args.summary) });
          const tests = lastTestResult ? [lastTestResult] : [];
          return finish('completed', {
            summary: (action.args && action.args.summary) || '任务完成',
            changedFiles: listChangedFiles(ctx).map(f => f.path),
            tests,
            completion: verdict
          });
        }
        // 未满足：进入修复（若有测试失败）或失败
        setState('REPAIRING');
        counters.repairRounds++;
        safeEmit(emit, EVENTS.REPAIR_START, { runId, round: counters.repairRounds, reason: '完成策略未满足: ' + verdict.reasons.join('; ') });
        addProblem(blackboard, COMPLETION_POLICY_PROBLEM_PREFIX + ': ' + verdict.missing.join(', '));
        if (counters.repairRounds > limits.maxRepairRounds) {
          return finish('failed', { errorCode: 'AGENT_REPAIR_LIMIT', error: '完成策略未满足且已达修复上限', summary: verdict.reasons.join('; ') });
        }
        continue;
      }

      // 6. delegate（v2.9.0 §7A 修复：不再 placeholder，走 executeAction → executeDelegate → Orchestrator/AgentHub）
      //    ask_permission 仍由 loop 处理
      if (action.type === 'ask_permission') {
        if (typeof deps.requestPermission === 'function') {
          const d = await deps.requestPermission({ scope: action.args && action.args.scope, tool: action.args && action.args.tool, args: action.args, conversationId: ctx.conversationId, runId: ctx.runId || null, agentId: ctx.agentId || null });
          if (d && d.decision === 'deny') {
            return finish('failed', { errorCode: 'PERMISSION_DENIED', error: '用户拒绝权限' });
          }
        }
        continue;
      }

      // 7. 执行 Action
      // 在首次修改文件前建立 checkpoint
      if (isMutatingAction(action) && !checkpointCreated) {
        setState('EXECUTING');
        try {
          const cp = await createCheckpoint(ctx, { note: 'Main Agent 修改前检查点', runId });
          checkpointCreated = true;
          safeEmit(emit, EVENTS.CHECKPOINT, { runId, checkpointId: cp.checkpointId, kind: cp.kind });
        } catch { /* checkpoint 失败不阻断 */ }
      }

      setState(isTestAction(action) ? 'TESTING' : 'EXECUTING');
      const icon = isTestAction(action) ? 'run' : (isMutatingAction(action) ? 'edit' : 'read');
      safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry(icon, actionLabel(action)) });

      const result = await executeAction(ctx, action, getTool);
      counters.toolCalls++;

      // 记录文件修改到 checkpoint
      if (isMutatingAction(action) && result.ok) {
        // v2.9.8 R4：成功的文件变异推进 mutationSeq（旧验证随之过期）
        mutationSeq++;
        const filePath = action.args && action.args.path;
        if (filePath) {
          trackFileChange(ctx, filePath, null, null, result.diff || '', runId);
          addImportantFile(blackboard, filePath);
          safeEmit(emit, EVENTS.FILE_CHANGED, { runId, path: filePath, diff: result.diff || '' });
          safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('edit', `修改 ${filePath}`, `+${result.linesAdded || 0}`) });
        }
      }

      // 测试结果
      if (isTestAction(action)) {
        lastTestResult = testStatusFromResult(action, result);
        if (lastTestResult) {
          // v2.9.8 R4：测试 PASS 只对执行时的代码状态有效——记录对应 mutationSeq
          lastTestResult.seq = mutationSeq;
          bbUpdate(blackboard, { latestTestStatus: lastTestResult });
        }
        const passed = result.ok && result.passed !== false;
        safeEmit(emit, EVENTS.TEST_RESULT, { runId, command: action.args && action.args.command, passed, summary: result.stderrSummary || result.stdoutSummary, errors: result.errors });
        safeEmit(emit, EVENTS.TIMELINE, { runId, entry: passed ? timelineEntry('test-pass', '测试通过', action.args && action.args.command) : timelineEntry('test-fail', '测试失败', action.args && action.args.command) });
      }

      // 调用 onToolResult 钩子（记录到 messages / events）
      if (typeof deps.onToolResult === 'function') {
        try { deps.onToolResult(action, result); } catch { /* non-fatal */ }
      }
      safeEmit(emit, EVENTS.TOOL_RESULT, { runId, tool: result.tool, ok: result.ok, summary: result.stdoutSummary || result.stderrSummary || (result.ok ? '成功' : '失败'), error: result.error && { code: result.error.code, message: result.error.message } });

      // 8. 观察结果 + 评估
      const ev = evaluateActionResult(action, result);
      // v2.9.8 R4：新一轮观察到的非测试问题出现时，清除上一轮完成裁决的诊断问题
      // （它们的使命是反馈给模型，不应永久滞留 blackboard 阻塞后续完成）。
      if (ev.needsRepair && !ev.isTestFailure && typeof clearCompletionPolicyProblems === 'function') {
        clearCompletionPolicyProblems(blackboard);
      }
      // v2.9.0 Real Runtime Closure（R6）：delegate 的 Child Result 摘要（result.summary）
      // 必须保留进 toolResults，才能进入下一轮 model context；不得被 undefined 覆盖。
      toolResults.push({ action, ...result, summary: result.stdoutSummary || result.stderrSummary || result.summary });
      // Phase 5：记录单 action 的 assistant tool_use + 配对 tool_result
      if (useMultiturn) {
        const id = mt.makeToolCallId(runId, counters.iteration, 0);
        mt.pushAssistant(history, { text: action.thought, toolCalls: [{ id, name: action.type, arguments: JSON.stringify(action.args || {}) }] });
        mt.pushToolResult(history, id, mtResultText(result));
      }

      // 致命错误（权限拒绝 / 沙箱逃逸）
      if (ev.fatal) {
        return finish('failed', { errorCode: 'FATAL', error: ev.fatalReason, summary: ev.fatalReason });
      }

      // 测试失败 → 修复
      if (ev.needsRepair) {
        setState('REPAIRING');
        counters.repairRounds++;
        safeEmit(emit, EVENTS.REPAIR_START, { runId, round: counters.repairRounds, reason: ev.repairReason });
        addProblem(blackboard, ev.repairReason);
        if (result.errors && result.errors.length) {
          for (const e of result.errors.slice(0, 3)) addFact(blackboard, '测试错误: ' + e);
        }
        safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('repair', '自动修复', ev.repairReason) });
        if (counters.repairRounds > limits.maxRepairRounds) {
          return finish('failed', { errorCode: 'AGENT_REPAIR_LIMIT', error: '测试持续失败且已达修复上限', summary: ev.repairReason });
        }
        // 继续循环让模型修复
        continue;
      }

      // 测试通过 → 解决该测试命令相关的所有未解决问题。
      // 之前用 ev.repairReason（测试通过时为空串）去精确匹配，导致失败时记录的
      // 「测试命令失败: <cmd>」问题永远残留，最终把 completion 顶成 AGENT_REPAIR_LIMIT。
      // 改为按命令子串模糊清理，并把该测试命令记入 completed。
      if (isTestAction(action) && lastTestResult && lastTestResult.passed) {
        const cmd = action.args && action.args.command;
        if (cmd) {
          resolveProblemsMatching(blackboard, cmd);
          resolveProblemsMatching(blackboard, '测试命令失败');
          resolveProblemsMatching(blackboard, '测试未通过');
        }
        // v2.9.8 R4：新鲜测试 PASS 同时清除旧的完成裁决诊断问题（重新验证已发生）。
        if (typeof clearCompletionPolicyProblems === 'function') clearCompletionPolicyProblems(blackboard);
        if (cmd && !blackboard.completed.includes(cmd)) {
          blackboard.completed.push(String(cmd).slice(0, 200));
          blackboard.completed = blackboard.completed.slice(-50);
          blackboard.updatedAt = Date.now();
        }
      }
    }
  } catch (e) {
    if (ctx.abortSignal && ctx.abortSignal.aborted) {
      const ab = abortTerminalStatus(ctx);
      return finish(ab.status, { summary: ab.summary });
    }
    const isTimeout = /超时|timed?out/i.test(e.message || '');
    if (isTimeout) return finish('timeout', { error: e.message });
    return finish('failed', { error: e.message, errorCode: 'LOOP_ERROR' });
  }
}

/** 运行 verification 命令清单（complete 时）。mutationSeq 用于新鲜度标记。 */
async function runVerification(deps, ctx, verification, emit, runId, getTool, mutationSeq) {
  const out = [];
  for (const v of verification) {
    if (v.type !== 'command') continue;
    const action = { type: 'run_tests', args: { command: v.command }, thought: 'verification: ' + v.command };
    const result = await executeAction(ctx, action, getTool);
    const passed = result.ok && result.passed !== false;
    // v2.9.8 R4：验证结果绑定执行时的代码状态 seq
    const vr = { ...v, lastResult: { passed, exitCode: result.exitCode, command: v.command, seq: Number.isFinite(mutationSeq) ? mutationSeq : undefined } };
    out.push(vr);
    safeEmit(emit, EVENTS.TEST_RESULT, { runId, command: v.command, passed, summary: result.stderrSummary || result.stdoutSummary, errors: result.errors, required: v.required });
    if (v.required && !passed) {
      safeEmit(emit, EVENTS.TIMELINE, { runId, entry: timelineEntry('test-fail', `必需验证失败: ${v.command}`) });
    }
  }
  return out;
}

function actionLabel(action) {
  if (!action) return '?';
  const a = action.args || {};
  switch (action.type) {
    case 'read_file': case 'read_files': return `读取 ${a.path || (a.paths || []).join(', ')}`;
    case 'list_directory': return `列出 ${a.path || '.'}`;
    case 'search': case 'find_text': return `搜索 ${a.query || a.pattern || ''}`;
    case 'patch_file': return `修改 ${a.path || ''}`;
    case 'write_file': return `写入 ${a.path || ''}`;
    case 'create_file': return `创建 ${a.path || ''}`;
    case 'delete_file': return `删除 ${a.path || ''}`;
    case 'run_command': return a.command || '运行命令';
    case 'run_tests': return a.command || '运行测试';
    case 'git_status': return 'git status';
    case 'git_diff': return 'git diff';
    default: return action.type;
  }
}

module.exports = { runAgentLoop, runVerification };
