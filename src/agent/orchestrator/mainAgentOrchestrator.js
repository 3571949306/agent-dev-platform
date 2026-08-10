'use strict';
/**
 * MainAgentOrchestrator — v2.9.0 统一主 Agent 编排层（spec §9）。
 *
 * 职责（§9）：接收 Main Agent Run / 维护 Parent Run / 允许 Main Agent 自己执行 Tool /
 * 允许 Main Agent Delegate / 调用 AgentHub / 维护 Child Run / 接收 Child Events /
 * 等待 Child Result / 规范化 Child Result / 写入 Blackboard / 把结果反馈 Main Agent /
 * 最终 Verification。
 *
 * §10：AgentLoop 只认识 delegate，不了解具体 Agent（由 Orchestrator→AgentHub 决定）。
 * §56：统一入口，不要求立即统一内部实现（底层三套 Runtime 暂时保留）。
 * §72：内部事件（run.started / delegation.before|started|completed|failed / verification.* / run.completed）供未来 Hook 订阅。
 */

const { createBlackboard } = require('./orchestrationBlackboard');
const { createChildRunTracker } = require('./childRunTracker');
const { createExecutionContextFactory } = require('./executionContextFactory');
const { createAgentHubBridge } = require('./agentHubBridge');
const { createAgentTask } = require('./agentTaskContract');
const { EventEmitter } = require('events');

/**
 * 创建 MainAgentOrchestrator 实例（per Parent Run）。
 * @param {object} opts
 *   { hub, runtimeDeps, parentRunId, parentAgentId, projectRoot, projectId, emit }
 * @returns {object} orchestrator
 */
function createMainAgentOrchestrator(opts) {
  const o = opts || {};
  const hub = o.hub;
  const parentRunId = o.parentRunId || null;
  const parentAgentId = o.parentAgentId || 'native-main';
  const projectRoot = o.projectRoot || null;
  const projectId = o.projectId || null;
  const externalEmit = o.emit || null;

  const blackboard = createBlackboard();
  const childRunTracker = createChildRunTracker();
  const executionContextFactory = createExecutionContextFactory(o.runtimeDeps);
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(50);

  const bridge = createAgentHubBridge({
    hub,
    childRunTracker,
    blackboard,
    parentRunId,
    parentAgentId,
    emit: (type, payload) => {
      // §20: Child events 实时到 GUI + eventBus
      try { eventBus.emit(type, payload); } catch { /* noop */ }
      if (externalEmit) {
        try { externalEmit(type, payload); } catch { /* noop */ }
      }
    }
  });

  let started = false;
  let goal = null;

  /**
   * 启动编排（§9 接收 Main Agent Run）。
   */
  function start(taskGoal) {
    if (started) return;
    started = true;
    goal = taskGoal;
    blackboard.setGoal(taskGoal);
    eventBus.emit('run.started', { parentRunId, goal: taskGoal });
  }

  /**
   * Main Agent delegate → AgentHub（§13/§18）。
   * @param {object} delegateArgs  delegate action args（goal/requiredCapabilities/readOnly/preferredAgentId/expectedOutput）
   * @param {object} [options]      { abortSignal, rankedAgents }
   * @returns {Promise<object>} AgentResult（§12）
   */
  async function delegate(delegateArgs, options) {
    const taskInput = {
      goal: delegateArgs.goal || delegateArgs.task || '',
      taskType: delegateArgs.taskType || 'generic',
      projectId,
      projectRoot,
      requiredCapabilities: delegateArgs.requiredCapabilities || delegateArgs.required || [],
      preferredCapabilities: delegateArgs.preferredCapabilities || delegateArgs.preferred || [],
      preferredAgentId: delegateArgs.preferredAgentId || delegateArgs.agentId || null,
      readOnly: delegateArgs.readOnly === true,
      permissions: delegateArgs.permissions || {},
      expectedOutput: delegateArgs.expectedOutput || null,
      verificationRequirements: delegateArgs.verificationRequirements || [],
      context: delegateArgs.context || { conversationId: options && options.conversationId, taskId: options && options.taskId },
      parentRunId,
      parentAgentId,
      delegationPath: (options && options.delegationPath) || [parentAgentId],
      budget: delegateArgs.budget,
      abortSignal: options && options.abortSignal
    };
    const { ok, task, error, errorCode } = createAgentTask(taskInput);
    if (!ok) {
      return { ok: false, status: 'failed', agentId: null, runId: null, errors: [error], errorCode };
    }

    eventBus.emit('delegation.before', { parentRunId, goal: task.goal });
    const result = await bridge.startChildTask(task, options);
    eventBus.emit(result.ok ? 'delegation.completed' : 'delegation.failed',
      { parentRunId, agentId: result.agentId, runId: result.runId, status: result.status });
    return result;
  }

  /**
   * 获取喂回 Main Agent 的 observation（§36，从 Blackboard 提取，不重新搜索聊天记录）。
   */
  function getObservation() {
    return blackboard.buildObservation();
  }

  /**
   * 获取 execution context（§39-40，传给 adapter）。
   */
  function createExecutionContext(agent, task, run, hubCtx) {
    return executionContextFactory.create(agent, task, run, hubCtx);
  }

  /**
   * 获取 Child Run 列表（§23）。
   */
  function getChildren() {
    return childRunTracker.getChildren(parentRunId);
  }

  /**
   * 取消所有 owned children（§24 取消级联）。
   * @param {function} cancelExternal  async (runId) => hub.cancel
   */
  async function cancelAllChildren(cancelExternal) {
    const kids = childRunTracker.getChildren(parentRunId);
    const all = [];
    for (const childId of kids) {
      const cancelled = await childRunTracker.cancel(childId, cancelExternal);
      all.push(...cancelled);
    }
    return all;
  }

  /**
   * Main Agent 最终 Verification（§51-54）。
   * External Agent 的"完成"只是 Claim，Main Agent 仍需本地复核。
   * @param {object} verifyOpts  { runTests, inspectDiff, requiredFiles, checkChildFindings }
   * @param {function} runLocalTests  async () => { passed, summary }
   * @returns {Promise<object>} { verified, localTests, externalClaims, unresolved }
   */
  async function finalVerify(verifyOpts, runLocalTests) {
    eventBus.emit('verification.started', { parentRunId });
    const snap = blackboard.snapshot();
    const externalClaims = [];
    for (const cr of snap.childResults) {
      if (cr.tests && cr.tests.externalClaim) {
        externalClaims.push({ agentId: cr.agentId, passed: cr.tests.passed });
      }
    }
    let localTests = null;
    if (verifyOpts && verifyOpts.runTests && typeof runLocalTests === 'function') {
      try { localTests = await runLocalTests(); } catch (e) { localTests = { passed: false, summary: String(e.message || e) }; }
    }
    const unresolved = snap.blockers.length > 0;
    const verified = !unresolved && (!localTests || localTests.passed);
    eventBus.emit('verification.completed', { parentRunId, verified, localPassed: localTests && localTests.passed });
    return {
      verified,
      localTests,
      externalClaims,   // §53：external tests ≠ localVerification
      changedFiles: snap.changedFiles,
      findings: snap.findings,
      unresolved
    };
  }

  /**
   * 完成 Parent Run（§72 run.completed / run.before_complete）。
   */
  function complete(status) {
    eventBus.emit('run.before_complete', { parentRunId });
    eventBus.emit('run.completed', { parentRunId, status: status || 'completed' });
  }

  return {
    start, delegate, getObservation, createExecutionContext,
    getChildren, cancelAllChildren, finalVerify, complete,
    blackboard, childRunTracker, bridge, executionContextFactory,
    eventBus,
    parentRunId, parentAgentId
  };
}

/** 全局 orchestrator 注册表（parentRunId -> orchestrator），供 agentLoop delegate 查找。 */
const registry = new Map();

function register(parentRunId, orchestrator) {
  registry.set(parentRunId, orchestrator);
}
function get(parentRunId) {
  return registry.get(parentRunId) || null;
}
function unregister(parentRunId) {
  registry.delete(parentRunId);
}

module.exports = { createMainAgentOrchestrator, register, get, unregister };
