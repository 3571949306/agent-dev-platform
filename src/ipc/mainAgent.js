'use strict';
/**
 * v2.6.0 — Main Agent IPC handlers（spec §4/§27/§36）。
 *
 * 把 Main Agent Runtime 的复杂逻辑从 ipc/handlers.js 抽离。
 *
 * IPC 通道：
 *   mainAgent:run         — 启动 Main Agent 编码 Run（立即返回 runId，后台执行）
 *   mainAgent:stop        — 停止 Main Agent Run（复用 activeRuns abort + RunManager terminal gate）
 *   mainAgent:changedFiles— 返回本次 Run 修改的文件列表（Diff Viewer）
 *   mainAgent:fileDiff    — 返回某文件 before/after/diff（Diff Viewer）
 *   mainAgent:testSetModel— 测试钩子：注入 FakeCodingModel（仅测试激活）
 *   mainAgent:listRuns    — 列出 Main Agent Run 历史（Crash Recovery §29）
 */

const { ipcMain } = require('electron');
const { runMainAgent, EVENTS } = require('../agent/runtime/mainAgentRuntime');
const { createProviderModelAdapter } = require('../agent/runtime/providerModelAdapter');
const { createFakeCodingModel } = require('../agent/runtime/fakeCodingModel');
const { changedFilesSummary, listChangedFiles } = require('../agent/runtime/checkpoint');
const states = require('../agent/runtime/states');

// 测试钩子：注入的 FakeCodingModel（仅测试中设置）
let injectedModel = null;

function reg(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function resolveConfiguredMainModel({ agent, agentId, conversationId, resolveRuntimeModel, buildProvider, resolveModelFor, routingDefaults = null }) {
  const hasExplicitBinding = !!(agent.api_connection_id && agent.model);
  const autoRequested = !hasExplicitBinding && (
    agent.routingMode === 'auto' || agent.routing_mode === 'auto' || agent.modelRoutingMode === 'auto'
    || (agent.workspace && agent.workspace.modelRoutingMode === 'auto')
  );
  if (typeof resolveRuntimeModel === 'function' && (hasExplicitBinding || autoRequested)) {
    // B15.9 — 默认连接/模型是偏好不是旁路：只注入 preferences 打分项，
    // explicit 模式与全部硬约束不受影响；Agent 自身 requirements 优先。
    const baseRequirements = agent.modelRequirements || (agent.workspace && agent.workspace.modelRequirements) || {};
    let requirements = baseRequirements;
    if (!hasExplicitBinding && routingDefaults && (routingDefaults.connectionId || routingDefaults.modelId)) {
      const prefs = { ...((baseRequirements && baseRequirements.preferences) || {}) };
      if (routingDefaults.connectionId) {
        prefs.preferredConnectionIds = [...(prefs.preferredConnectionIds || []), routingDefaults.connectionId];
      }
      if (routingDefaults.modelId) {
        prefs.preferredModels = [...(prefs.preferredModels || []), routingDefaults.modelId];
      }
      requirements = { ...(baseRequirements || {}), preferences: prefs };
    }
    const resolution = resolveRuntimeModel({
      mode: hasExplicitBinding ? 'explicit' : 'auto',
      requirements,
      explicit: hasExplicitBinding ? { connectionId: agent.api_connection_id, modelId: agent.model } : null,
      context: { agent, agentId: agent.id || agentId, runId: null, conversationId: conversationId || null, timeoutMs: 120000 }
    });
    return resolution;
  }
  return { modelAdapter: createProviderModelAdapter({ buildProvider, agent, resolveModel: resolveModelFor, timeoutMs: 120000 }), selection: null };
}

function bindMainRouteDecision({ selection, bindRouteDecisionToRun, runId, conversationId }) {
  if (!selection || !selection.decisionId || typeof bindRouteDecisionToRun !== 'function') return false;
  return bindRouteDecisionToRun(selection.decisionId, {
    runId,
    conversationId: conversationId || null,
    rootRunId: runId,
    parentRunId: null
  });
}

/**
 * @param {object} deps {
 *   store, emit, runManager, getTool, buildProvider, resolveModelFor, resolveRuntimeModel,
 *   activeRuns: Map,  // conversationId -> AbortController
 *   requestPermission, getCurrentProject, getAgentFull, PermissionEngine
 * }
 */
function register(deps, registrar = reg) {
  const { store, emit, runManager, getTool, buildProvider, resolveModelFor, resolveRuntimeModel, bindRouteDecisionToRun, activeRuns, requestPermission, getCurrentProject, getAgentFull, PermissionEngine, skillRegistry, skillResolver, hookEngine, availableToolNames, projectMutationLock } = deps;
  const handlers = {};
  const expose = (channel, fn) => {
    handlers[channel] = fn;
    registrar(channel, fn);
  };

  expose('mainAgent:run', async ({ conversationId, agentId, goal, verification, requiredFiles, initialPlan, timeoutMs, useInjectedModel, skillIds, hookIds } = {}) => {
    if (!goal) throw new Error('goal 必填（用户目标）');
    const agent = getAgentFull ? getAgentFull(agentId) : null;
    const project = getCurrentProject ? getCurrentProject() : null;
    const projectRoot = project ? project.root_path : null;
    const projectId = project ? project.id : null;
    if (!projectRoot) throw new Error('未打开项目，Main Agent 无法执行本地编码');

    // v2.9.3 Skill Engine（R6/R7）— Main Agent 支持 requestedSkillIds：
    // 路由前把 Skill ModelRequirements 严格合并进 Agent 的模型要求（0 provider calls）；
    // Skill 不能放宽 Agent 限制（合并语义只取更严格结果）。完整 R4 校验在 runMainAgent 内。
    let effectiveAgent = agent;
    if (Array.isArray(skillIds) && skillIds.length && agent && skillResolver) {
      const merged = skillResolver.resolveModelMerge(skillIds, agent.modelRequirements || (agent.workspace && agent.workspace.modelRequirements) || {});
      if (!merged.ok) throw new Error(`${merged.errorCode}: ${merged.error}`);
      if (merged.modelRequirements) {
        effectiveAgent = {
          ...agent,
          modelRequirements: merged.modelRequirements,
          workspace: { ...(agent.workspace || {}), modelRequirements: merged.modelRequirements }
        };
      }
    }

    // 选择 model：测试注入优先，否则用 ProviderModelAdapter
    let model;
    let modelSelection = null;
    if (useInjectedModel && injectedModel) {
      model = injectedModel;
    } else if (effectiveAgent) {
      const resolution = resolveConfiguredMainModel({
        agent: effectiveAgent, agentId, conversationId, resolveRuntimeModel, buildProvider, resolveModelFor,
        // B15.9 — 默认连接/模型偏好来自统一 settings 真源（可为空）
        routingDefaults: {
          connectionId: store.settings.get('defaultConnectionId', null),
          modelId: store.settings.get('defaultModelId', null)
        }
      });
      model = resolution.modelAdapter;
      modelSelection = resolution.selection || null;
    } else {
      throw new Error('无可用模型（未注入测试模型且无 agent）');
    }

    const pe = PermissionEngine ? new PermissionEngine({ store, projectId }) : null;

    const result = runMainAgent({
      conversationId, agentId, agentName: agent ? agent.name : 'Main Agent',
      goal, projectRoot, projectId, projectName: project ? project.name : null,
      model, getTool, store, emit, runManager, requestPermission,
      permissionEngine: pe,
      verification, requiredFiles, initialPlan,
      timeoutMs,
      // v2.9.3 Skill Engine（R7）
      skillIds: Array.isArray(skillIds) ? skillIds : undefined,
      skillRegistry, skillResolver,
      hookIds: Array.isArray(hookIds) ? hookIds : undefined,
      hookEngine,
      availableToolNames,
      // v2.9.8 R7 — Project Lock / Run Isolation：Main Run 启动前拿项目写锁（fail busy），
      // 终态（completed/failed/cancelled/timeout）统一在 runtime finally 释放。
      projectMutationLock: projectMutationLock || null,
      onRunCreated: ({ runId: actualRunId }) => {
        bindMainRouteDecision({ selection: modelSelection, bindRouteDecisionToRun, runId: actualRunId, conversationId });
      },
      registerAbort: (convId, ac) => activeRuns.set(convId || goal, ac),
      unregisterAbort: (convId) => activeRuns.delete(convId || goal)
    });
    return result; // { runId, conversationId }
  });

  expose('mainAgent:stop', ({ conversationId, runId } = {}) => {
    const key = conversationId || runId;
    const ac = activeRuns.get(key);
    if (ac) ac.abort();
    activeRuns.delete(key);
    if (conversationId) {
      try { runManager.cancelByConversation(conversationId); } catch { /* Late Result Guard */ }
    }
    return { stopped: !!ac };
  });

  expose('mainAgent:changedFiles', ({ taskId } = {}) => {
    // 通过 taskId 查 file_changes
    const ctx = { store, taskId, projectId: null, agentId: null };
    return changedFilesSummary(ctx);
  });

  expose('mainAgent:fileDiff', ({ taskId, filePath } = {}) => {
    const files = listChangedFiles({ store, taskId });
    const f = files.find(x => x.path === filePath);
    if (!f) return null;
    return { path: f.path, before: f.before, after: f.after, diff: f.diff };
  });

  expose('mainAgent:listRuns', ({ limit = 20 } = {}) => {
    try { return store.runs.list(limit); } catch { return []; }
  });

  // 测试钩子：注入 FakeCodingModel（spec §35，E2E 用）
  expose('mainAgent:testSetModel', ({ script, opts } = {}) => {
    if (process.env.NODE_ENV !== 'test' && !process.env.CI) {
      throw new Error('testSetModel 仅在测试环境可用');
    }
    if (script) {
      injectedModel = createFakeCodingModel(script, opts || {});
    } else {
      injectedModel = null;
    }
    return { injected: !!injectedModel };
  });

  expose('mainAgent:states', () => ({ NON_TERMINAL: states.NON_TERMINAL, TERMINAL: states.TERMINAL }));

  return Object.freeze({
    run: handlers['mainAgent:run'],
    stop: handlers['mainAgent:stop'],
    changedFiles: handlers['mainAgent:changedFiles'],
    fileDiff: handlers['mainAgent:fileDiff'],
    listRuns: handlers['mainAgent:listRuns'],
    states: handlers['mainAgent:states']
  });
}

function createMainAgentService(deps) {
  return register(deps, () => {});
}

module.exports = { register, createMainAgentService, EVENTS, resolveConfiguredMainModel, bindMainRouteDecision, _setInjectedModel: (m) => { injectedModel = m; } };
