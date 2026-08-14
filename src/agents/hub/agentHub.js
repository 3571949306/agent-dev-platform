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
const { createExternalAgentTerminalGate } = require('../runtime/externalTerminalGate');
const { captureProjectState, verifyExternalResult } = require('../verification/externalResultVerifier');
const { sanitizeExternalResult } = require('../runtime/resultSanitizer');
const pathSecurity = require('../../security/pathSecurity');

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
    verificationRegistry,
    reportProblem,
    contextFactory,   // v2.9.0 §39-40：统一 Adapter context 构建（修复 §7B 缺口）
    delegationAuthorityVerifier   // v2.9.8 Final Closure（A5）：(parentRunId, token) => boolean
  } = opts;

  if (!registry) throw new Error('createAgentHub: registry 必填');
  if (!router) throw new Error('createAgentHub: router 必填');
  if (!healthManager) throw new Error('createAgentHub: healthManager 必填');
  if (!lifecycleManager) throw new Error('createAgentHub: lifecycleManager 必填');
  if (!runBridge) throw new Error('createAgentHub: runBridge 必填');

  // P4 run controls are orchestration metadata only. RunManager remains the
  // single lifecycle truth; this map guards resources around that truth.
  const runControls = new Map();
  const terminalGate = createExternalAgentTerminalGate();

  function isExternal(adapter) {
    return !!(adapter && adapter.manifest && adapter.manifest.source === 'external');
  }

  function report(code, message, detail = {}) {
    if (typeof reportProblem !== 'function') return;
    try {
      reportProblem({
        severity: 'ERROR', source: 'External Agent', code, message,
        runId: detail.runId || null,
        relatedKey: detail.runId ? `${code}:${detail.runId}` : code,
        detail
      });
    } catch { /* Problems Center must never break execution */ }
  }

  function normalizeCancelResult(value) {
    const v = value && typeof value === 'object' ? value : {};
    return {
      ok: v.ok === true,
      status: v.status || null,
      quiesced: v.quiesced === true,
      residual: v.residual == null ? null : v.residual,
      detail: v.detail || v.error || null
    };
  }

  function releaseControl(control) {
    if (!control || control.released) return;
    if (control.lockAcquired && projectLock) {
      try { projectLock.release(control.runId); } catch { /* noop */ }
      control.lockAcquired = false;
    }
    control.released = true;
    if (control.counted) {
      control.adapter.activeRunCount = Math.max(0, Number(control.adapter.activeRunCount) - 1);
      control.counted = false;
    }
  }

  function finishControl(control, status, result, { release = true } = {}) {
    if (!control) return null;
    const tr = terminalGate.transition(control.runId, status, result && result.errorCode);
    if (!tr.accepted) return tr;
    control.terminal = true;
    control.pendingTerminal = null;
    runBridge.finishAgentRun(control.runId, status, result);
    if (release) releaseControl(control);
    return tr;
  }

  async function finishFromAdapter(control, status, result) {
    if (!control || control.terminal) return;
    if (control.cancelInProgress) {
      control.pendingTerminal = { status, result };
      return;
    }
    if (isExternal(control.adapter) && typeof control.adapter.awaitQuiescence === 'function') {
      let q;
      try { q = await control.adapter.awaitQuiescence(control.runId, 10000); }
      catch (e) { q = { quiesced: false, residual: e.message }; }
      if (!q || q.quiesced !== true) {
        control.pendingTerminal = { status, result };
        report(ERROR_CODE.AGENT_CANCEL_NOT_QUIESCED, 'External Agent reached a terminal result before runtime quiescence was confirmed', {
          runId: control.runId, agentId: control.adapter.id, residual: q && q.residual
        });
        return;
      }
    }
    let finalResult = result;
    if (status === LIFECYCLE.COMPLETED && control.beforeState) {
      try {
        const effect = await verifyExternalResult({
          projectRoot: control.projectRoot,
          before: control.beforeState,
          result,
          expectedFile: control.expectedFile,
          expectedContent: control.expectedContent,
          readOnly: control.readOnly
        });
        finalResult = (result && typeof result === 'object') ? { ...result, ...effect } : { summary: result, ...effect };
        if (!effect.effectObserved && effect.verificationStatus !== 'NOT_APPLICABLE') {
          report(ERROR_CODE.AGENT_EFFECT_NOT_OBSERVED, 'External Agent reported completion without an independently observed project effect', {
            runId: control.runId, agentId: control.adapter.id,
            reportedChangedFiles: effect.reportedChangedFiles,
            observedChangedFiles: effect.observedChangedFiles
          });
        }
      } catch (e) {
        finalResult = (result && typeof result === 'object')
          ? { ...result, effectObserved: false, verificationStatus: 'EXTERNAL_EFFECT_VERIFICATION_FAILED', verificationError: e.message }
          : { summary: result, effectObserved: false, verificationStatus: 'EXTERNAL_EFFECT_VERIFICATION_FAILED', verificationError: e.message };
      }
    }
    if (isExternal(control.adapter)) {
      finalResult = sanitizeExternalResult(finalResult, { agentId: control.adapter.id, runId: control.runId });
    }
    finishControl(control, status, finalResult);
  }

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

  function unregister(agentId) {
    return registry.unregister(agentId);
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

    // P4 project-root truth: an external coding runtime never inherits the
    // app cwd/home/default workspace. Canonicalization happens before a Run or
    // project lock exists, so an invalid root cannot start execution.
    const codingExternal = isExternal(adapter) && (adapter.capabilities || []).some(c =>
      c === 'coding' || c === 'filesystem' || c === 'terminal');
    if (codingExternal && !task.projectRoot) {
      return { error: 'PROJECT_ROOT_REQUIRED', errorCode: ERROR_CODE.PROJECT_ROOT_REQUIRED, executionStarted: false };
    }
    if (task.projectRoot) {
      try {
        task = { ...task, projectRoot: pathSecurity.canonicalizeRoot(task.projectRoot) };
      } catch (e) {
        return { error: e.message, errorCode: e.code || 'PROJECT_ROOT_INVALID', executionStarted: false };
      }
    }

    const maxConcurrency = Number(adapter.maxConcurrency || (adapter.manifest && adapter.manifest.maxConcurrency) || 1);
    if (Number(adapter.activeRunCount || 0) >= maxConcurrency) {
      return {
        error: 'AGENT_CONCURRENCY_LIMIT', errorCode: ERROR_CODE.AGENT_CONCURRENCY_LIMIT,
        agentId, maxConcurrency, executionStarted: false
      };
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

    const control = {
      runId, lifecycleRunId, adapter, projectRoot: task.projectRoot || null,
      lockAcquired: false, released: false, terminal: false,
      cancelInProgress: false, pendingTerminal: null, executionStarted: false,
      counted: true, beforeState: null, readOnly: task.readOnly === true,
      expectedFile: task.verificationExpectedFile || null,
      expectedContent: task.verificationExpectedContent == null ? null : String(task.verificationExpectedContent)
    };
    adapter.activeRunCount = Number(adapter.activeRunCount || 0) + 1;
    runControls.set(runId, control);
    terminalGate.init(runId, LIFECYCLE.STARTING);

    // v2.7.1 — Project Mutation Lock：在 adapter.startTask 之前获取锁
    // v2.9.8 Final Closure（A5）— Unforgeable Lock Reentrancy：
    // 禁止用 task.rootRunId（调用方/模型可控文本）声称同树。
    // child 的真实 root 一律从 RunManager 持久 lineage 推导：task.parentRunId 是
    // 平台 Orchestrator/Bridge 设置的真实身份（非模型可控），沿它在 RunManager
    // 中推导到树顶；锁持有者的 root 同样从 RunManager 推导。严格相等才重入；
    // 任一侧推导失败（未知 runId）= fail-closed：不重入，正常争锁。
    // 独立 Run 即使伪造 task.rootRunId = holder 的 root，也不会影响推导链，
    // 其推导出的 root 仍是自己，依旧 PROJECT_LOCKED。
    if (projectLock && task.projectRoot) {
      const holder = typeof projectLock.getLockHolder === 'function'
        ? projectLock.getLockHolder(task.projectRoot)
        : null;
      let sameRootTree = false;
      if (task.parentRunId && holder) {
        const childRealRoot = runBridge.getRootRunId(task.parentRunId);
        const holderRealRoot = runBridge.getRootRunId(holder.runId);
        if (childRealRoot && holderRealRoot && childRealRoot === holderRealRoot) {
          // 真实 lineage 匹配后进一步验证委派授权（orchestrator token）：
          // 伪造 parentRunId 的独立 Run 拿不到对应活跃 orchestrator 的 token。
          // verifier 已注入（生产 handlers.js 恒注入）时以验证结果为准；
          // 未注入时退回 lineage 判定（兼容无 orchestrator 的旧部署）。
          sameRootTree = typeof delegationAuthorityVerifier === 'function'
            ? delegationAuthorityVerifier(task.parentRunId, task.delegationToken) === true
            : true;
        }
      }
      if (!sameRootTree) {
        const isWrite = needsWriteLock(task);
        const lockResult = isWrite
          ? projectLock.acquireWrite(task.projectRoot, runId, agentId)
          : projectLock.acquireRead(task.projectRoot, runId, agentId);
        if (!lockResult.ok) {
          // 锁被其他 Run 持有——不启动任务（execution 从未开始）
          finishControl(control, 'failed', { status: 'failed', errorCode: 'PROJECT_LOCKED', errors: ['PROJECT_LOCKED'] });
          return {
            error: 'PROJECT_LOCKED',
            errorCode: 'PROJECT_LOCKED',
            lockHolder: lockResult.lockHolder,
            runId,
            executionStarted: false
          };
        }
        control.lockAcquired = true;
      }
    }

    const verifyEffect = codingExternal && needsWriteLock(task) && task.responseOnly !== true && task.verifyEffect !== false;
    if (verifyEffect) {
      try {
        control.beforeState = await captureProjectState(task.projectRoot);
      } catch (e) {
        finishControl(control, 'failed', { status: 'failed', errorCode: 'EXTERNAL_EFFECT_BASELINE_FAILED', errors: [e.message] });
        return { error: e.message, errorCode: 'EXTERNAL_EFFECT_BASELINE_FAILED', runId, executionStarted: false };
      }
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
        productionHub: true,
        allowedScopes: Array.isArray(task.allowedScopes) ? task.allowedScopes : undefined,
        // 包装 emit：经过 eventNormalizer 归一化后发射
        // v2.7.1 — adapter 若已自行归一化（type 以 agent. 开头），直接发射，避免二次映射丢失事件类型。
        emit: (type, payload) => {
          if (typeof type === 'string' && type.startsWith('agent.')) {
            // 已归一化事件：补全 runId/agentId 后直接发射
            const evt = (payload && typeof payload === 'object')
              ? { ...payload, type, runId, agentId }
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
            void finishFromAdapter(control, status, result);
          }
        }
      });

      // P4 identity fail-closed: external session/thread IDs are separate
      // fields; the adapter's returned Run ID must be the canonical Hub ID.
      if (isExternal(adapter) && (!startResult || startResult.runId !== runId)) {
        const returnedRunId = startResult && startResult.runId;
        control.executionStarted = !!returnedRunId;
        let cancelled = { ok: false, quiesced: false, residual: 'identity-mismatched run' };
        if (returnedRunId && typeof adapter.cancel === 'function') {
          try { cancelled = normalizeCancelResult(await adapter.cancel(returnedRunId)); } catch (e) { cancelled.detail = e.message; }
        }
        const detail = {
          status: 'failed', errorCode: ERROR_CODE.AGENT_RUN_IDENTITY_MISMATCH,
          errors: [`adapter returned ${returnedRunId || '<missing>'}; expected ${runId}`],
          adapterRunId: returnedRunId || null, hubRunId: runId,
          quiesced: cancelled.quiesced, residual: cancelled.residual
        };
        report(ERROR_CODE.AGENT_RUN_IDENTITY_MISMATCH, 'External adapter returned a non-canonical Run ID', {
          runId, agentId, adapterRunId: returnedRunId || null, quiesced: cancelled.quiesced, residual: cancelled.residual
        });
        // A terminal Hub run is truthful even if cleanup failed, but the
        // project lock remains held until an operator/cleanup path confirms
        // quiescence.
        finishControl(control, 'failed', detail, { release: cancelled.quiesced });
        return {
          error: ERROR_CODE.AGENT_RUN_IDENTITY_MISMATCH,
          errorCode: ERROR_CODE.AGENT_RUN_IDENTITY_MISMATCH,
          runId, adapterRunId: returnedRunId || null,
          executionStarted: !!returnedRunId,
          quiesced: cancelled.quiesced
        };
      }

      // 5. 处理启动失败
      // v2.9.8 Final Closure（A2）— Execution-Started Truth：runId 存在 != execution started。
      // 只有 adapter.startTask 真实执行且未拒绝时 executionStarted=true；
      // 此前任何失败（锁/定义/路由/启动异常）一律 executionStarted=false。
      if (startResult && startResult.ok === false) {
        finishControl(control, 'failed', { status: 'failed', errors: [startResult.error || '启动失败'] });
        return {
          error: startResult.error || '启动失败',
          errorCode: ec('AGENT_START_FAILED', 'AGENT_START_FAILED'),
          runId,
          executionStarted: false
        };
      }

      // 启动成功：Lifecycle → running
      control.executionStarted = true;
      lifecycleManager.transition(lifecycleRunId, LIFECYCLE.RUNNING);

      // 6. 返回 runId（executionStarted=true：adapter 真实启动）
      return { runId, agentId, executionStarted: true };
    } catch (e) {
      // adapter.startTask 抛异常：完成 Run 为 failed，返回 error
      finishControl(control, 'failed', { status: 'failed', errors: [e.message] });
      return {
        error: e.message,
        errorCode: ec('AGENT_START_FAILED', 'AGENT_START_FAILED'),
        runId,
        executionStarted: false
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

      // Once an external runtime started, another writer must not continue the
      // same task against a partially mutated project. Automatic fallback is
      // only safe before execution.
      if (result.executionStarted === true) {
        return { ...result, fallbackSuppressed: true, fallbackPolicy: 'fallbackBeforeExecutionOnly' };
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
    const control = runControls.get(runId);
    if (control && control.terminal) return runBridge.getRunMapping(runId);
    if (control) control.cancelInProgress = true;

    // Native adapters retain the P1-P3 cancellation contract. P4's strict
    // process/session quiescence barrier applies only to external runtimes.
    if (control && !isExternal(control.adapter)) {
      try {
        if (typeof control.adapter.cancel === 'function') await control.adapter.cancel(runId);
      } catch { /* RunBridge remains the lifecycle truth for native cancel */ }
      control.cancelInProgress = false;
      const nativeResult = runBridge.cancelAgentRun(runId);
      releaseControl(control);
      return nativeResult;
    }

    // P4: external adapter cancellation is a quiescence barrier, not a best-effort
    // notification. The Hub remains non-terminal and keeps the project lock
    // when cleanup cannot be proven.
    const mapping = runBridge.getRunMapping(runId);
    let cancelled = { ok: false, quiesced: false, residual: 'adapter not found', detail: null };
    if (mapping) {
      const lifecycleRun = lifecycleManager.getRun(mapping.lifecycleRunId);
      if (lifecycleRun && lifecycleRun.agentId) {
        const adapter = registry.get(lifecycleRun.agentId);
        if (adapter && typeof adapter.cancel === 'function') {
          try { cancelled = normalizeCancelResult(await adapter.cancel(runId)); }
          catch (e) { cancelled = { ok: false, quiesced: false, residual: 'cancel threw', detail: e.message }; }
        }
      }
    }
    if (!cancelled.quiesced) {
      if (control) control.cancelInProgress = false;
      report(ERROR_CODE.AGENT_CANCEL_NOT_QUIESCED, 'External Agent cancellation did not reach quiescence', {
        runId, residual: cancelled.residual, detail: cancelled.detail
      });
      return {
        ok: false,
        error: ERROR_CODE.AGENT_CANCEL_NOT_QUIESCED,
        errorCode: ERROR_CODE.AGENT_CANCEL_NOT_QUIESCED,
        quiesced: false,
        residual: cancelled.residual,
        detail: cancelled.detail
      };
    }
    const result = control
      ? (finishControl(control, 'cancelled', {
          status: 'cancelled', errorCode: ERROR_CODE.AGENT_CANCELLED,
          errors: ['用户已取消'], quiesced: true, residual: cancelled.residual
        }), runBridge.getRunMapping(runId))
      : runBridge.cancelAgentRun(runId);
    if (control) control.cancelInProgress = false;
    return { ...(result || {}), ok: true, status: 'cancelled', quiesced: true, residual: cancelled.residual };
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
    return registry.list().filter(adapter => !adapter.disabled).map(adapter => {
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
      const installed = detected && detected.installed != null
        ? !!detected.installed
        : !!(detected && detected.available);
      const configured = detected && detected.configured != null
        ? !!detected.configured
        : installed;
      const available = !!(detected && detected.available);
      const health = healthManager.getStatus(adapter.id);
      const healthStatus = adapter.healthStatus || HEALTH_STATE.UNKNOWN;
      let availability = 'UNAVAILABLE';
      if (!installed) availability = 'NOT_INSTALLED';
      else if (!configured) availability = 'INSTALLED_UNCONFIGURED';
      else if (!available) availability = 'UNAVAILABLE';
      else if (auth && auth.state === 'AUTH_REQUIRED') availability = 'AUTH_REQUIRED';
      else if (healthStatus === HEALTH_STATE.DEGRADED) availability = 'DEGRADED';
      else if (healthStatus === 'error') availability = 'ERROR';
      else if (auth && auth.state === 'UNKNOWN') availability = 'AUTH_UNKNOWN';
      else availability = 'AVAILABLE';
      return {
        id: adapter.id,
        adapterType: adapter.adapterType || null,
        transport: adapter.transport || null,
        transportLabel: transportLabelFor(adapter),
        healthStatus: adapter.healthStatus || HEALTH_STATE.UNKNOWN,
        health,
        capabilities: adapter.capabilities || [],
        installed,
        configured,
        available,
        availability,
        version: adapter._verifiedVersion || (detected && detected.version) || null,
        path: (detected && detected.path) || null,
        executablePath: (detected && detected.path) || null,
        mode: adapter.runtimeMode || '',
        activeRuntime: adapter._verifiedRuntime || (typeof adapter.getActiveRuntime === 'function' ? adapter.getActiveRuntime() : null),
        runtime: adapter._verifiedRuntime || (typeof adapter.getActiveRuntime === 'function' ? adapter.getActiveRuntime() : null) || adapter.transport || adapter.adapterType || null,
        auth
      };
    });
  }

  return {
    register,
    unregister,
    detect,
    health,
    route,
    start,
    startAuto,
    cancel,
    status,
    result,
    getManifests,
    getAvailable,
    getDiagnostics: () => ({
      activeRuns: [...runControls.values()].filter(c => !c.terminal).length,
      controls: [...runControls.values()].map(c => ({
        runId: c.runId, agentId: c.adapter.id, terminal: c.terminal,
        cancelInProgress: c.cancelInProgress, lockHeld: c.lockAcquired,
        executionStarted: c.executionStarted
      }))
    })
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
