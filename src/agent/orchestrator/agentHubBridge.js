'use strict';
/**
 * AgentHubBridge — v2.9.0 AgentTask → AgentHub → Child Run → AgentResult 桥接（spec §18）。
 *
 * 完成（§18）：
 *   AgentTask → AgentHub.route → AgentHub.start → Child Run → wait terminal → AgentResult
 *
 * §19：平台 Runtime 自己 await child terminal，一次性把结果作为 observation 返回 Main Agent，
 *      禁止 Main Agent 轮询数据库。
 * §20：Child Event Streaming 经 emit 实时到 GUI（Main Agent 等待 ≠ GUI 无事件）。
 * §42-44：防自委派 / maxDepth=3 / delegationPath 追踪。
 * §36：Child Result 写 Blackboard。
 * §24：取消级联（Parent cancel → children cancel）。
 */

const { checkDelegationDepth, isSelfDelegation, MAX_DELEGATION_DEPTH } = require('./agentTaskContract');
const { classifyFailure, shouldFallback, chooseFallback } = require('./delegationController');
const { sanitize } = require('./orchestrationBlackboard');
const { TERMINAL_STATUSES } = require('./childRunTracker');

const POLL_INTERVAL_MS = 500;

/**
 * 创建 AgentHubBridge。
 * @param {object} opts
 *   { hub, childRunTracker, blackboard, parentRunId, parentAgentId, emit }
 */
function createAgentHubBridge(opts) {
  const hub = opts && opts.hub;
  const tracker = opts && opts.childRunTracker;
  const blackboard = opts && opts.blackboard;
  const parentRunId = (opts && opts.parentRunId) || null;
  const parentAgentId = (opts && opts.parentAgentId) || null;
  const emit = (opts && opts.emit) || null;

  /**
   * 后台轮询 hub.result 直到终态，然后 setTerminal（§19 event-driven wait）。
   */
  function pollUntilTerminal(runId, abortSignal, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 300000);
    const poll = async () => {
      if (tracker.isTerminal(runId)) return;
      if (abortSignal && abortSignal.aborted) {
        try { await hub.cancel(runId); } catch { /* noop */ }
        tracker.setTerminal(runId, 'cancelled', null);
        return;
      }
      if (Date.now() > deadline) {
        try { await hub.cancel(runId); } catch { /* noop */ }
        tracker.setTerminal(runId, 'timeout', null);
        return;
      }
      try {
        const r = await hub.result(runId);
        if (r && TERMINAL_STATUSES.has(r.status)) {
          tracker.setTerminal(runId, r.status, r.result || r);
          return;
        }
      } catch { /* transient */ }
      const _t = setTimeout(poll, POLL_INTERVAL_MS);
      if (_t && _t.unref) _t.unref();   // 不阻止 process 退出（测试环境）
    };
    poll();
  }

  /**
   * 规范化 Child Result 为 AgentResult（§12）。
   */
  function normalizeResult(status, result, agentId, runId) {
    const r = result || {};
    return {
      ok: status === 'completed',
      agentId,
      runId,
      sessionId: r.sessionId || null,
      status,
      summary: sanitize(typeof r.summary === 'string' ? r.summary : (r.message || '')),
      findings: Array.isArray(r.findings) ? r.findings.map(sanitize) : [],
      changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : [],
      diff: r.diff || null,
      tests: r.tests || null,
      artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
      usage: r.usage || null,
      errors: Array.isArray(r.errors) ? r.errors.map(e => sanitize(typeof e === 'string' ? e : (e && e.message) || '')) : [],
      durationMs: r.durationMs || null,
      provenance: { parentRunId, parentAgentId, delegatedAt: Date.now() }
    };
  }

  /**
   * 启动 Child Task 并等待终态（§18/§19）。
   * @param {object} agentTask  AgentTask（agentTaskContract.createAgentTask 返回）
   * @param {object} [options]  { abortSignal, rankedAgents, maxAttempts }
   * @returns {Promise<object>} AgentResult
   */
  async function startChildTask(agentTask, options) {
    const o = options || {};
    const abortSignal = o.abortSignal || agentTask.abortSignal || null;

    // §44: delegation depth 检查
    if (!checkDelegationDepth(agentTask.delegationPath)) {
      return {
        ok: false, status: 'failed', agentId: null, runId: null,
        errors: [`DELEGATION_DEPTH_EXCEEDED（max ${MAX_DELEGATION_DEPTH}）`],
        summary: '委派深度超限'
      };
    }

    let agentId = agentTask.preferredAgentId;
    let rankedAgents = o.rankedAgents || null;

    // 自动路由（未指定 preferredAgentId）
    if (!agentId) {
      try {
        const routeResult = hub.route({
          required: agentTask.requiredCapabilities,
          preferred: agentTask.preferredCapabilities,
          preferredAgentId: null,
          parentAgentId,
          delegationPath: agentTask.delegationPath
        });
        rankedAgents = Array.isArray(routeResult) ? routeResult : (routeResult && routeResult.data) || [];
        if (rankedAgents.length) {
          agentId = rankedAgents[0].agentId;
        }
      } catch (e) {
        return { ok: false, status: 'failed', agentId: null, runId: null, errors: [String(e.message || e)], summary: '路由失败' };
      }
    }

    if (!agentId) {
      return { ok: false, status: 'failed', agentId: null, runId: null, errors: ['NO_AVAILABLE_AGENT'], summary: '无可用 Agent' };
    }

    // §42: 防自委派
    if (isSelfDelegation(parentAgentId, agentId)) {
      return { ok: false, status: 'failed', agentId, runId: null, errors: ['SELF_DELEGATION_BLOCKED'], summary: '禁止委派给自身' };
    }

    const maxAttempts = o.maxAttempts || 2;
    const triedAgentIds = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      triedAgentIds.push(agentId);
      const result = await runOnce(agentTask, agentId, abortSignal);
      // 成功或不可 fallback 的失败 → 直接返回
      if (result.ok) return result;
      const failureType = classifyFailure(result);
      if (!shouldFallback(failureType)) {
        // §29/§32: PERMISSION_DENIED/POLICY_DENIED/USER_CANCELLED 不 fallback（No-Bypass）
        return result;
      }
      // §33: 尝试 fallback
      if (attempt >= maxAttempts) return result;
      const next = chooseFallback(rankedAgents, attempt, triedAgentIds);
      if (!next) return result;
      agentId = next.agentId;
      // 重新 route 获取完整 rankedAgents（如果之前没拿到）
      if (!rankedAgents || !rankedAgents.length) {
        try {
          const rr = hub.route({ required: agentTask.requiredCapabilities, preferredAgentId: null, parentAgentId, delegationPath: agentTask.delegationPath });
          rankedAgents = Array.isArray(rr) ? rr : (rr && rr.data) || [];
        } catch { /* keep */ }
      }
    }
    return { ok: false, status: 'failed', agentId, runId: null, errors: ['DELEGATION_EXHAUSTED'], summary: '委派尝试耗尽' };
  }

  /**
   * 单次执行：hub.start → wait terminal → AgentResult。
   */
  async function runOnce(agentTask, agentId, abortSignal) {
    const hubTask = {
      goal: agentTask.goal,
      required: agentTask.requiredCapabilities,
      preferred: agentTask.preferredCapabilities,
      allowedScopes: agentTask.allowedScopes || Object.keys(agentTask.permissions || {}),
      projectRoot: agentTask.projectRoot,
      projectId: agentTask.projectId,
      conversationId: agentTask.context && agentTask.context.conversationId,
      taskId: agentTask.context && agentTask.context.taskId,
      parentRunId,
      parentAgentId,
      delegationPath: agentTask.delegationPath,
      readOnly: agentTask.readOnly
    };

    let startResult;
    try {
      startResult = await hub.start(agentId, hubTask);
    } catch (e) {
      return { ok: false, status: 'failed', agentId, runId: null, errors: [String(e.message || e)], summary: '启动失败', errorCode: 'CRASH' };
    }
    if (startResult.error) {
      return {
        ok: false, status: 'failed', agentId,
        runId: startResult.runId || null,
        errors: [startResult.error],
        summary: startResult.error,
        errorCode: startResult.errorCode
      };
    }
    const runId = startResult.runId;

    // 注册到 Run tree
    tracker.register(parentRunId, runId, agentId);

    // §20: child started event 到 GUI
    if (emit) {
      try { emit('agent.delegation.started', { runId, agentId, parentRunId, goal: sanitize(agentTask.goal) }); } catch { /* noop */ }
    }

    // §19: 后台轮询 hub.result，终态时 setTerminal
    pollUntilTerminal(runId, abortSignal, agentTask.budget.maxRuntimeMs);

    // await terminal（event-driven，不轮询 DB）
    const { status, result } = await tracker.wait(runId, agentTask.budget.maxRuntimeMs);

    const agentResult = normalizeResult(status, result, agentId, runId);

    // §36: Child Result 写 Blackboard
    if (blackboard) {
      try { blackboard.addChildResult(agentResult); } catch { /* noop */ }
    }

    // §20: child terminal event 到 GUI
    if (emit) {
      try { emit('agent.delegation.terminal', { runId, agentId, status, parentRunId }); } catch { /* noop */ }
    }

    return agentResult;
  }

  /**
   * 取消指定 child run（§25）。
   */
  async function cancelChild(runId) {
    return tracker.cancel(runId, async (id) => {
      try { await hub.cancel(id); } catch { /* noop */ }
    });
  }

  return { startChildTask, runOnce, cancelChild };
}

module.exports = { createAgentHubBridge };
