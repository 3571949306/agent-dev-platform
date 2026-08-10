'use strict';
/**
 * AgentHub — Agent Integration Hub 的中央门面。
 *
 * Main Agent 通过 AgentHub 与所有外部 / 内部 Agent 交互：
 *   - 注册 / 检测 / 健康检查
 *   - 路由（手动指定 or 自动选择）
 *   - 启动 / 取消 / 查询 Run
 *
 * AgentHub 不直接拥有状态——它委托给 registry / router / healthManager /
 * lifecycleManager / runBridge。它只编排流程。
 *
 * 启动流程 start(agentId, task)：
 *   1. 检查 Agent 存在且未禁用
 *   2. 检查健康（标记为 checking）
 *   3. 通过 runBridge 创建 Run（同时创建 RunManager + LifecycleManager Run）
 *   4. 调用 adapter.startTask，传入 task context
 *   5. 处理启动失败（返回 error，不抛异常）
 *   6. 返回 { runId, agentId }
 *
 * 自动路由 startAuto(task)：
 *   1. 通过 router.route 获取候选列表
 *   2. 依次尝试，失败则 fallback 到下一个
 *   3. 最多 3 次 fallback（然后 AGENT_ROUTE_EXHAUSTED）
 *   4. 每次 fallback 发射 agent.fallback 事件
 */

const { HEALTH_STATE, LIFECYCLE, ERROR_CODE, AGENT_EVENT } = require('./types');

/** 最大 fallback 次数（不含首次尝试）。 */
const MAX_FALLBACKS = 3;

/** 安全获取 ERROR_CODE 值，带 fallback。 */
function ec(name, fallback) {
  return (ERROR_CODE && ERROR_CODE[name]) || fallback;
}

/** 安全发射事件 — emit 失败不得中断 Run。 */
function safeEmit(emit, type, payload) {
  if (typeof emit !== 'function') return;
  try { emit(type, payload); } catch { /* telemetry must never break a run */ }
}

/**
 * v2.8.0 spec §77 — Agent Center 的 Transport 人类可读标签。
 * 多运行时 Agent 按当前生效运行时给精确值，未运行时给候选集。
 */
function transportLabelFor(adapter) {
  const id = adapter.id;
  const rt = typeof adapter.getActiveRuntime === 'function' ? adapter.getActiveRuntime() : null;
  if (id === 'codex') {
    if (rt === 'app-server') return 'Codex App Server';
    if (rt === 'exec') return 'Codex Exec (structured)';
    if (rt === 'legacy') return 'Codex CLI (legacy)';
    return 'App Server / Exec';
  }
  if (id === 'claude-code') {
    if (rt === 'sdk') return 'Claude Agent SDK';
    if (rt === 'cli') return 'Claude CLI (structured)';
    if (rt === 'acp') return 'ACP';
    return 'Agent SDK / CLI';
  }
  if (id === 'cline') return 'ClineCore Sidecar';
  if (id === 'native-main' || id === 'native') return 'Native Runtime';
  if (adapter.transport === 'acp') return 'ACP';
  if (id === 'opencode') return 'OpenCode Server';
  if (id === 'openhands') return 'OpenHands Server';
  if (adapter.transport === 'desktop') return 'Desktop Bridge';
  return adapter.transport || adapter.adapterType || 'unknown';
}

/**
 * 创建 AgentHub。
 * @param {object} opts
 * @param {object} opts.registry — AgentRegistry 实例
 * @param {object} opts.router — AgentRouter 实例
 * @param {object} opts.healthManager — HealthManager 实例
 * @param {object} opts.lifecycleManager — LifecycleManager 实例
 * @param {object} [opts.eventNormalizer] — EventNormalizer 实例
 * @param {object} opts.runBridge — RunBridge 实例
 * @param {Function} [opts.emit] — 事件发射函数 (type, payload) => void
 * @returns {object} agentHub 实例
 */
function createAgentHub(opts = {}) {
  const {
    registry, router, healthManager,
    lifecycleManager, eventNormalizer, runBridge,
    emit, projectLock,
    contextFactory   // v2.9.0 §39-40：统一 Adapter context 构建（修复 §7B 缺口）
  } = opts;

  if (!registry) throw new Error('createAgentHub: registry 必填');
  if (!router) throw new Error('createAgentHub: router 必填');
  if (!healthManager) throw new Error('createAgentHub: healthManager 必填');
  if (!lifecycleManager) throw new Error('createAgentHub: lifecycleManager 必填');
  if (!runBridge) throw new Error('createAgentHub: runBridge 必填');

  /**
   * v2.7.1 — 判断任务是否需要写锁。
   * 写锁条件：required 含 coding/filesystem/terminal，或 task.readOnly !== true。
   * @param {object} task
   * @returns {boolean}
   */
  function needsWriteLock(task) {
    const required = (task && Array.isArray(task.required)) ? task.required : [];
    const hasWriteCap = required.some(c => c === 'coding' || c === 'filesystem' || c === 'terminal');
    const isReadOnly = task && task.readOnly === true;
    return hasWriteCap || !isReadOnly;
  }

  /**
   * 注册 adapter（委托给 registry）。
   * @param {object} adapter
   * @returns {object} adapter
   */
  function register(adapter) {
    return registry.register(adapter);
  }

  /**
   * 检测所有 Agent（委托给 registry.detectAll）。
   * @returns {Promise<Map>} id -> { available, version, path }
   */
  async function detect() {
    return registry.detectAll();
  }

  /**
   * 健康检查所有 Agent（委托给 healthManager.checkAll）。
   * @param {object} [opts2] { force?: boolean }
   * @returns {Promise<Map>} id -> health result
   */
  async function health(options = {}) {
    return healthManager.checkAll(options);
  }

  /**
   * 路由（委托给 router.route）。
   * @param {object} task
   * @returns {Array<{agentId, score, reasons, penalties}>}
   */
  function route(task) {
    return router.route(task);
  }

  /**
   * 在指定 Agent 上启动任务。
   *
   * 流程：检查 Agent → 检查健康 → 创建 Run → adapter.startTask → 返回 runId
   * 启动失败时返回 { error, errorCode }，不抛异常。
   *
   * @param {string} agentId
   * @param {object} [task] — 任务描述（goal / required / preferred / projectRoot / ...）
   * @returns {Promise<{ runId: string, agentId: string }|{ error: string, errorCode: string, runId?: string }>}
   */
  async function start(agentId, task = {}) {
    // 1. 检查 Agent 存在且未禁用
    const adapter = registry.get(agentId);
    if (!adapter) {
      return { error: `Agent ${agentId} 未注册`, errorCode: ec('AGENT_NOT_FOUND', 'AGENT_NOT_FOUND') };
    }
    if (adapter.disabled) {
      return { error: `Agent ${agentId} 已禁用`, errorCode: ec('AGENT_DISABLED', 'AGENT_DISABLED') };
    }

    // 2. 检查健康（标记为 checking，不阻塞启动）
    try {
      const healthResult = await healthManager.check(agentId, { force: false, projectRoot: task.projectRoot });
      adapter.healthStatus = healthResult.status;
    } catch {
      // 健康检查失败不阻塞启动——让 adapter.startTask 自行决定
    }

    // 3. 通过 runBridge 创建 Run（RunManager + LifecycleManager）
    const { runId, lifecycleRunId } = runBridge.createAgentRun({
      agentId,
      conversationId: task.conversationId,
      taskId: task.taskId,
      goal: task.goal || task.description || null,
      parentRunId: task.parentRunId || null,
      projectRoot: task.projectRoot,
      projectId: task.projectId,
      adapterType: adapter.adapterType || adapter.transport || null
    });

    // v2.7.1 — Project Mutation Lock：在 adapter.startTask 之前获取锁
    let lockAcquired = false;
    if (projectLock && task.projectRoot) {
      const isWrite = needsWriteLock(task);
      const lockResult = isWrite
        ? projectLock.acquireWrite(task.projectRoot, runId, agentId)
        : projectLock.acquireRead(task.projectRoot, runId, agentId);
      if (!lockResult.ok) {
        // 锁被其他 Run 持有——不启动任务
        runBridge.finishAgentRun(runId, 'failed', 'PROJECT_LOCKED');
        return {
          error: 'PROJECT_LOCKED',
          errorCode: 'PROJECT_LOCKED',
          lockHolder: lockResult.lockHolder,
          runId
        };
      }
      lockAcquired = true;
    }

    // 4. 调用 adapter.startTask，传入 task context
    try {
      // v2.9.0 §39-40：用 contextFactory 构建完整 context（修复 §7B Native Hub Context 缺口）
      //   contextFactory 注入 runManager/model/getTool/store/permissionEngine/pathSecurity 等，
      //   让 NativeAgentAdapter.startTask 不再因 runManager/model 缺失而 throw。
      const _runInfo = { runId, lifecycleRunId, agentId, parentRunId: task.parentRunId || null, projectRoot: task.projectRoot, projectId: task.projectId };
      const _extraCtx = contextFactory ? contextFactory.create(adapter, task, _runInfo, {}) : {};
      const startResult = await adapter.startTask(task, {
        ..._extraCtx,
        runId,
        lifecycleRunId,
        agentId,
        projectRoot: task.projectRoot,
        projectId: task.projectId,
        allowedScopes: Array.isArray(task.allowedScopes) ? task.allowedScopes : undefined,
        // 包装 emit：经过 eventNormalizer 归一化后发射
        // v2.7.1 — adapter 若已自行归一化（type 以 agent. 开头），直接发射，避免二次映射丢失事件类型。
        emit: (type, payload) => {
          if (typeof type === 'string' && type.startsWith('agent.')) {
            // 已归一化事件：补全 runId/agentId 后直接发射
            const evt = (payload && typeof payload === 'object')
              ? { ...payload, type, runId: payload.runId || runId, agentId: payload.agentId || agentId }
              : { type, runId, agentId, data: payload };
            safeEmit(emit, evt.type, evt);
            return;
          }
          if (eventNormalizer) {
            const evt = eventNormalizer.normalize(
              { type, ...payload },
              adapter.adapterType || adapter.transport,
              runId,
              agentId
            );
            eventNormalizer.emit(evt);
          } else {
            safeEmit(emit, type, payload);
          }
        },
        // v2.7.0 — 允许 adapter 在任务完成时主动通知 Hub 更新生命周期终态。
        // 异步 adapter（如 TestAgentAdapter / 未来的 HTTP adapter）可在后台完成
        // 后调用此回调，使 hub:status / hub:result 返回正确的终态。
        finishRun: (status, result) => {
          if (['completed', 'failed', 'cancelled', 'timeout'].includes(status)) {
            runBridge.finishAgentRun(runId, status, result);
          }
          // v2.7.1 — 终态后释放项目锁
          if (lockAcquired && projectLock) {
            try { projectLock.release(runId); } catch { /* noop */ }
            lockAcquired = false;
          }
        }
      });

      // 5. 处理启动失败
      if (startResult && startResult.ok === false) {
        runBridge.finishAgentRun(runId, 'failed', startResult.error || '启动失败');
        if (lockAcquired && projectLock) {
          try { projectLock.release(runId); } catch { /* noop */ }
        }
        return {
          error: startResult.error || '启动失败',
          errorCode: ec('AGENT_START_FAILED', 'AGENT_START_FAILED'),
          runId
        };
      }

      // 启动成功：Lifecycle → running
      lifecycleManager.transition(lifecycleRunId, LIFECYCLE.RUNNING);

      // 6. 返回 runId
      return { runId, agentId };
    } catch (e) {
      // adapter.startTask 抛异常：完成 Run 为 failed，返回 error
      runBridge.finishAgentRun(runId, 'failed', e.message);
      if (lockAcquired && projectLock) {
        try { projectLock.release(runId); } catch { /* noop */ }
      }
      return {
        error: e.message,
        errorCode: ec('AGENT_START_FAILED', 'AGENT_START_FAILED'),
        runId
      };
    }
  }

  /**
   * 自动选择最佳 Agent 并启动任务。
   *
   * 流程：route → 尝试 top 候选 → 失败则 fallback → 最多 3 次 fallback
   * 每次 fallback 发射 agent.fallback 事件。
   *
   * @param {object} [task]
   * @returns {Promise<{ runId: string, agentId: string }|{ error: string, errorCode: string }>}
   */
  async function startAuto(task = {}) {
    // Cline health includes runtime, API configuration, and this exact
    // workspace, so refresh it immediately before making an auto-route choice.
    if (registry.get('cline')) {
      try {
        await healthManager.check('cline', { force: true, projectRoot: task.projectRoot });
      } catch { /* other candidates remain available */ }
    }
    const candidates = router.route(task);
    if (!candidates.length) {
      return { error: '没有可用的 Agent', errorCode: ec('AGENT_ROUTE_EXHAUSTED', 'AGENT_ROUTE_EXHAUSTED') };
    }

    const tried = new Set();
    const maxAttempts = Math.min(candidates.length, MAX_FALLBACKS + 1);

    for (let i = 0; i < maxAttempts; i++) {
      const candidate = candidates[i];
      if (tried.has(candidate.agentId)) continue;
      tried.add(candidate.agentId);

      const result = await start(candidate.agentId, task);
      // start 成功时返回 { runId, agentId }；失败时返回 { error, errorCode, runId? }
      // 用 agentId 判断成功（失败返回不含 agentId）
      if (result.agentId) {
        return result;
      }

      // 启动失败：如果有下一个候选，发射 fallback 事件
      if (i < maxAttempts - 1) {
        const nextAgentId = candidates[i + 1].agentId;
        safeEmit(emit, AGENT_EVENT.FALLBACK, {
          fromAgentId: candidate.agentId,
          toAgentId: nextAgentId,
          error: result.error,
          attempt: i + 1,
          timestamp: Date.now()
        });
      }
    }

    return {
      error: `尝试了 ${tried.size} 个 Agent 均失败`,
      errorCode: ec('AGENT_ROUTE_EXHAUSTED', 'AGENT_ROUTE_EXHAUSTED')
    };
  }

  /**
   * 取消 Run（通过 runBridge 同步取消 RunManager + LifecycleManager）。
   * @param {string} runId
   * @returns {object|null}
   */
  async function cancel(runId) {
    // v2.7.1 — 先调用 adapter.cancel() 让外部 Agent 真正停止（如 OpenCode session abort）
    const mapping = runBridge.getRunMapping(runId);
    if (mapping) {
      const lifecycleRun = lifecycleManager.getRun(mapping.lifecycleRunId);
      if (lifecycleRun && lifecycleRun.agentId) {
        const adapter = registry.get(lifecycleRun.agentId);
        if (adapter && typeof adapter.cancel === 'function') {
          try { await adapter.cancel(runId); } catch { /* adapter cancel failure must not block hub cancel */ }
        }
      }
    }
    const result = runBridge.cancelAgentRun(runId);
    // v2.7.1 — 取消时释放项目锁
    if (projectLock) {
      try { projectLock.release(runId); } catch { /* noop */ }
    }
    return result;
  }

  /**
   * 获取 Run 状态。
   * @param {string} runId
   * @returns {Promise<object|null>}
   */
  async function status(runId) {
    const mapping = runBridge.getRunMapping(runId);
    if (!mapping) return null;
    const lifecycleRun = lifecycleManager.getRun(mapping.lifecycleRunId);
    if (!lifecycleRun) return null;
    return {
      runId,
      lifecycleRunId: mapping.lifecycleRunId,
      agentId: lifecycleRun.agentId,
      status: lifecycleRun.status,
      startedAt: lifecycleRun.startedAt,
      updatedAt: lifecycleRun.updatedAt,
      terminalAt: lifecycleRun.terminalAt
    };
  }

  /**
   * 获取 Run 结果（终态后可用）。
   * @param {string} runId
   * @returns {Promise<object|null>}
   */
  async function result(runId) {
    const mapping = runBridge.getRunMapping(runId);
    if (!mapping) return null;
    const lifecycleRun = lifecycleManager.getRun(mapping.lifecycleRunId);
    if (!lifecycleRun) return null;
    return {
      runId,
      agentId: lifecycleRun.agentId,
      status: lifecycleRun.status,
      result: lifecycleRun.result,
      error: lifecycleRun.error
    };
  }

  /**
   * 获取所有已注册 adapter 的 manifest。
   * @returns {object[]}
   */
  function getManifests() {
    return registry.getManifests();
  }

  /**
   * 列出可用 Agent 及其健康状态。
   * @returns {Array<{ id, adapterType, transport, healthStatus, health, capabilities }>}
   */
  function getAvailable() {
    return registry.listAvailable().map(adapter => {
      // v2.8.0 spec §77/§78/§79：Agent Center 需要 transport 展示 / 安装态 / 版本 / 认证状态。
      // 认证只暴露状态机展示值（state/mode/authenticated/detail），绝不暴露凭据本体。
      let auth = null;
      if (typeof adapter.getAuthState === 'function') {
        try {
          const a = adapter.getAuthState();
          if (a) auth = { state: a.state || 'UNKNOWN', mode: a.mode || '', authenticated: !!a.authenticated, detail: a.detail || '' };
        } catch { auth = null; }
      }
      const detected = adapter._detected || null;
      return {
        id: adapter.id,
        adapterType: adapter.adapterType || null,
        transport: adapter.transport || null,
        transportLabel: transportLabelFor(adapter),
        healthStatus: adapter.healthStatus || HEALTH_STATE.UNKNOWN,
        health: healthManager.getStatus(adapter.id),
        capabilities: adapter.capabilities || [],
        installed: !!adapter.available,
        version: (detected && detected.version) || null,
        activeRuntime: typeof adapter.getActiveRuntime === 'function' ? adapter.getActiveRuntime() : null,
        auth
      };
    });
  }

  return {
    register,
    detect,
    health,
    route,
    start,
    startAuto,
    cancel,
    status,
    result,
    getManifests,
    getAvailable
  };
}

// ----------------------------------------------------------- 全局单例

/** @type {object|null} */
let _singleton = null;

/**
 * 获取全局 AgentHub 单例。
 * @returns {object|null}
 */
function getAgentHub() {
  return _singleton;
}

/**
 * 设置全局 AgentHub 单例。
 * @param {object} hub
 * @returns {object} hub
 */
function setAgentHub(hub) {
  _singleton = hub;
  return hub;
}

module.exports = { createAgentHub, getAgentHub, setAgentHub };
