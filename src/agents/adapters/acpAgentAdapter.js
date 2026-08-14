'use strict';
/**
 * v2.8.0 — 通用 ACP Agent 适配器（spec §55/§56/§59）。
 *
 * 这是本轮最重要的模块之一：任何"拥有标准 ACP"的外部 Coding Agent，只要提供
 *   command / args / cwd / environment / expectedCapabilities / authMode
 * 即可接入 AgentHub，无需改动 MainAgentRuntime / AgentRouter / GUI 主代码。
 *
 * 理想最终用法（spec §56）：
 *   registry.register(new AcpAgentAdapter({ manifest, command, args }))
 *
 * 设计：
 *   - 每个 Run 启动一个独立 ACP 进程（与 CLI 适配器一致），便于取消时精确 killTree，
 *     不误伤其他 Run / 用户自己的 CLI（§106：只杀本适配器 spawn 的 PID）。
 *   - connect 时完成 initialize 握手 + 能力协商（spec §22）。v1 把
 *     session/new · prompt · cancel · update 定为 baseline，因此**不再**检查
 *     "是否声明 session 能力"（那是 v2 alpha 的形状，会误杀所有真实 Agent）。
 *   - 流式 session/update → 统一 AGENT_EVENT（经 context.emit 直接发射）。
 *   - 权限经 ExternalAgentPermissionBroker 交集评估；无 GUI resolver 时默认拒绝。
 *   - 复用 CliProcessSupervisor（进程 / env allowlist / killTree）与 AcpClientRuntime。
 *
 * ── 终态语义（本轮修正的核心，spec §65/§66/§67/§27/§68）─────────────
 *   1. 任何路径进入终态后，**必须**在 finally 里回收 ACP 子进程 —— 零 zombie。
 *   2. 用户取消 → CANCELLED（不是 FAILED）。取消先发 v1 通知，给 grace period
 *      让 Agent 以 stopReason='cancelled' 自然收尾；超过 grace 才强杀兜底。
 *   3. 请求超时 → TIMEOUT（不是 FAILED）。依据 err.timeout / err.code=ACP_TIMEOUT，
 *      由 jsonRpcSession 打标，超时 ≠ 取消 ≠ 失败。
 *   4. 进程意外退出（非我方 kill）→ FAILED，并在 errors 里带上 code/signal。
 *   5. 终态只结算一次（settled 标记），cancel 与 _executeAcp 竞争时不会双发事件。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT, ERROR_CODE } = require('../hub/types');
const { createAcpClientRuntime } = require('../protocols/acp/acpClientRuntime');
const { createAcpProcessTransport } = require('../protocols/acp/acpProcessTransport');
const { AcpError, ACP_ERROR } = require('../protocols/acp/errors');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const { createExternalAgentSessionManager } = require('../session/externalAgentSessionManager');
const { AUTH_STATE, AUTH_MODE } = require('../protocols/acp/authBroker');
const { resolveCliInPath } = require('../../services/externalAgents');
const pathSecurity = require('../../security/pathSecurity');

const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_VERSION_TIMEOUT_MS = 5000;
/** 取消后等待 Agent 自然收尾的宽限期；超过则强杀本 Run 的进程。 */
const DEFAULT_CANCEL_GRACE_MS = 3000;
const CANCEL_POLL_MS = 50;

/** Run 终态 → LIFECYCLE。未知状态一律按 FAILED 处理（保守）。 */
const STATUS_TO_LIFECYCLE = {
  completed: LIFECYCLE.COMPLETED,
  failed: LIFECYCLE.FAILED,
  cancelled: LIFECYCLE.CANCELLED,
  timeout: LIFECYCLE.TIMEOUT
};

/** Run 终态 → 对外事件。 */
const STATUS_TO_EVENT = {
  completed: AGENT_EVENT.RUN_COMPLETED,
  failed: AGENT_EVENT.RUN_FAILED,
  cancelled: AGENT_EVENT.RUN_CANCELLED,
  timeout: AGENT_EVENT.RUN_TIMEOUT
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class AcpAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest ACP agent manifest（含 command / args / expectedAcpCapabilities / authMode / maxConcurrency）
   * @param {object} [opts.config] 运行配置（凭据 / 路径覆盖 / 权限策略）
   */
  constructor({ manifest, config, sessionPersistence } = {}) {
    super({ manifest, config });
    const cfg = { ...(manifest && manifest.config), ...(config || {}) };
    this.command = cfg.command;
    this.args = Array.isArray(cfg.args) ? cfg.args : [];
    this.cwdMode = cfg.cwdMode || 'projectRoot';
    this.configCwd = cfg.cwd || null;
    this.expectedAcpCapabilities = cfg.expectedAcpCapabilities || null;
    this.authMode = cfg.authMode || (manifest && manifest.authMode) || 'external_login';
    this.authMethodId = cfg.authMethodId || null;
    this.environment = cfg.environment || null; // 来自安全存储的显式 env（如 API key）
    this.timeoutMs = Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.cancelGraceMs = Number(cfg.cancelGraceMs) || DEFAULT_CANCEL_GRACE_MS;
    this.versionCommand = cfg.versionCommand ? (Array.isArray(cfg.versionCommand) ? cfg.versionCommand : [cfg.versionCommand]) : null;
    this.passthroughEnv = Array.isArray(cfg.passthroughEnv) ? cfg.passthroughEnv : [];
    this.permissionResolver = cfg.onPermission || null; // GUI 回调（可选）
    this.mcpServers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
    // 诚实声明：本适配器尚未实现 client 侧 fs/* 与 terminal/*，默认全 false。
    this.clientCapabilities = cfg.clientCapabilities || null;
    this.frameLimitBytes = cfg.frameLimitBytes || undefined;
        // 单测可注入：runtimeFactory(runState) => AcpClientRuntime
    this._runtimeFactory = cfg.runtimeFactory || null;
        // 会话管理器跨 Run 共享（Session ≠ Run，spec §109），可选落库（spec §110/§111）
        this.sessions = createExternalAgentSessionManager({ persistence: sessionPersistence });
    this.supervisor = cfg.supervisor || createCliProcessSupervisor();
    this._runs = new Map();
    this._detected = null;
    /** 最近一次握手/认证后的状态缓存（不含凭据），供路由 / GUI 同步读取。 */
    this._lastAuthState = null;
  }

  getManifest() { return { ...this.manifest }; }

  async detect() {
    if (this._detected) return this._detected;
    if (!this.command) { this._detected = { available: false, path: null }; return this._detected; }
    let path = null;
    if (this.command.includes('/') || this.command.includes('\\') || this.command.toLowerCase().endsWith('.exe')) {
      const fs = require('fs');
      path = fs.existsSync(this.command) ? this.command : null;
    } else {
      try { path = await resolveCliInPath(this.command); } catch { path = null; }
    }
    this._detected = { available: !!path, path };
    return this._detected;
  }

  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return { status: HEALTH_STATE.UNAVAILABLE, version: null, latencyMs: Date.now() - start, detail: `${this.command} not found` };
    }
    // ACP agent 不一定有 --version；探测失败不降级（仅 version=null）
    let version = null;
    if (this.versionCommand) {
      try { version = await this.supervisor.readVersion(detected.path, this.versionCommand, DEFAULT_VERSION_TIMEOUT_MS); } catch { version = null; }
    }
    return { status: HEALTH_STATE.HEALTHY, version, latencyMs: Date.now() - start, detail: 'ACP agent available' };
  }

  /**
   * 同步返回当前认证状态（spec §29/§75/§79）。
   * 优先级：显式 env 凭据 → 最近一次握手/认证缓存 → UNKNOWN。
   */
  getAuthState() {
    if (this.environment && Object.keys(this.environment).some(k => /KEY|TOKEN/i.test(k) && this.environment[k])) {
      return { state: AUTH_STATE.API_KEY, mode: AUTH_MODE.API_KEY, authenticated: true, detail: '使用显式 API 凭据' };
    }
    if (this._lastAuthState) return this._lastAuthState;
    return {
      state: AUTH_STATE.UNKNOWN,
      mode: AUTH_MODE.EXTERNAL_LOGIN,
      authenticated: false,
      detail: '尚未握手，认证状态未知'
    };
  }

  /** Safe verification performs initialize only. It never authenticates,
   * creates a session or sends a prompt. */
  async safeVerify({ projectRoot, verificationId } = {}) {
    const detection = await this.detect();
    const base = {
      agentId: this.id, paidCalls: 0, modelCalls: 0,
      protocolAttempted: false, protocolVerified: false,
      runtime: 'acp', version: null, auth: this.getAuthState()
    };
    if (!detection.available || !projectRoot) return base;
    const runState = { runId: `safe:${verificationId || crypto.randomUUID()}`, pid: null, exitInfo: null };
    const runtime = createAcpClientRuntime({
      transportFactory: connectOpts => this._createTransport(runState, connectOpts),
      sessionManager: this.sessions
    });
    let handshake = null;
    let q = { quiesced: false, residual: 'not disconnected' };
    try {
      handshake = await runtime.connect({
        command: detection.path,
        args: this.args,
        cwd: pathSecurity.canonicalizeRoot(projectRoot),
        env: buildEnvAllowlist(this.passthroughEnv, this.environment || {}),
        timeoutMs: 30000,
        frameLimitBytes: this.frameLimitBytes,
        agentId: this.id,
        expectedCapabilities: this.expectedAcpCapabilities,
        clientCapabilities: this.clientCapabilities || undefined,
        runId: runState.runId
      });
      const authMethods = Array.isArray(handshake.authMethods) ? handshake.authMethods : [];
      this._lastAuthState = authMethods.length
        ? { state: AUTH_STATE.AUTH_REQUIRED, mode: AUTH_MODE.EXTERNAL_LOGIN, authenticated: false, detail: 'ACP initialize reports authentication methods' }
        : { state: AUTH_STATE.AUTHENTICATED, mode: AUTH_MODE.NONE, authenticated: true, detail: 'ACP initialize reports no authentication requirement' };
    } finally {
      try { runtime.disconnect(); } catch { /* noop */ }
      q = await runtime.awaitQuiescence(5000);
    }
    return {
      ...base,
      protocolAttempted: true,
      protocolVerified: !!(handshake && q.quiesced),
      reason: q.quiesced ? '' : 'ACP_PROCESS_RESIDUE',
      version: handshake && handshake.agentInfo && handshake.agentInfo.version || null,
      auth: this.getAuthState(),
      quiesced: q.quiesced,
      residual: q.residual
    };
  }

  _resolveCwd(task, context) {
    if (context && context.productionHub) {
      const root = task.projectRoot || context.projectRoot;
      if (!root) throw Object.assign(new Error('ACP production run requires projectRoot'), { code: 'PROJECT_ROOT_REQUIRED' });
      return pathSecurity.canonicalizeRoot(root);
    }
    if (this.cwdMode === 'config' && this.configCwd) return this.configCwd;
    if (this.cwdMode === 'inherit') return undefined;
    return task.projectRoot || (context && context.projectRoot) || this.configCwd || undefined;
  }

  /**
   * 用本适配器自己的 supervisor 起 ACP 进程，并把 pid / 退出信息记进 runState。
   * 复用同一个 supervisor 是为了 dispose() 时能一次性回收全部子进程，
   * 且只回收我们 spawn 的 PID（§106）。
   */
  async _createTransport(runState, connectOpts) {
    const factory = createAcpProcessTransport({
      supervisor: this.supervisor,
      frameLimitBytes: this.frameLimitBytes
    });
    const transport = await factory.connect(connectOpts);
    try { runState.pid = typeof transport.pid === 'function' ? transport.pid() : null; } catch { runState.pid = null; }
    if (typeof transport.on === 'function') {
      // clean=false 表示不是我方 dispose/kill 触发的退出 → 属于"意外退出"（§65）
      transport.on('exit', info => { runState.exitInfo = info || null; });
    }
    return transport;
  }

  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('AcpAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    const detected = await this.detect();
    if (!detected.available) {
      throw new Error(`AcpAgentAdapter: command "${this.command}" not available`);
    }

    const runId = (context && context.runId) || crypto.randomUUID();
    const runState = {
      runId,
      runtime: null,
      sessionId: null,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      taskText,
      pid: null,
      exitInfo: null,
      cancelRequested: false,
      reclaimed: false,
      settled: false
    };

    const runtime = this._runtimeFactory
      ? this._runtimeFactory(runState)
      : createAcpClientRuntime({
        transportFactory: (connectOpts) => this._createTransport(runState, connectOpts),
        sessionManager: this.sessions
      });
    runState.runtime = runtime;
    this._runs.set(runId, runState);

    if (typeof context.emit === 'function') {
      context.emit(AGENT_EVENT.RUN_STARTED, { type: AGENT_EVENT.RUN_STARTED, runId, agentId: this.id, goal: taskText });
    }

    const actualCwd = this._resolveCwd(task, context);
    runState.projectRoot = actualCwd || null;
    runState.actualCwd = actualCwd || null;
    runState.executionPromise = this._executeAcp(runId, runtime, detected.path, actualCwd,
      buildEnvAllowlist(this.passthroughEnv, this.environment || (context && context.env) || {}),
      taskText, task, context)
      .catch(err => {
        // _executeAcp 自身已兜底；这里只处理结算阶段（emit/finishRun）抛出的意外。
        this._settleRun(runState, this._buildFailureResult(err, runState), context);
        return runState.result;
      });

    return { runId };
  }

  async _executeAcp(runId, runtime, commandPath, cwd, env, taskText, task, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.status = LIFECYCLE.STARTING;

    let result = null;
    try {
      this._throwIfCancelled(runState, 'connect');

      await runtime.connect({
        command: commandPath,
        args: this.args,
        cwd,
        env,
        timeoutMs: this.timeoutMs,
        frameLimitBytes: this.frameLimitBytes,
        agentId: this.id,
        expectedCapabilities: this.expectedAcpCapabilities,
        clientCapabilities: this.clientCapabilities || undefined
        ,runId
      });
      runState.status = LIFECYCLE.RUNNING;

      await this._maybeAuthenticate(runtime);
      this._throwIfCancelled(runState, 'session/new');

      const { externalSessionId } = await runtime.createSession({
        projectRoot: cwd || task.projectRoot,
        additionalDirectories: task.additionalDirectories || undefined,
        mcpServers: Array.isArray(task.mcpServers) ? task.mcpServers : this.mcpServers,
        resumeSessionId: task.resumeSessionId || null,
        parentRunId: runId,
        projectId: task.projectId || null
      });
      runState.sessionId = externalSessionId;

      // 会话建立后才知道 sessionId：若此刻已被取消，先按协议发一次 cancel 通知再退出。
      if (runState.cancelRequested) {
        try { await runtime.cancel({ sessionId: externalSessionId }); } catch { /* noop */ }
        this._throwIfCancelled(runState, 'session/prompt');
      }

      result = await runtime.prompt({
        sessionId: externalSessionId,
        runId,
        agentId: this.id,
        message: taskText,
        context: {
          timeoutMs: this.timeoutMs,
          parentRunPermission: task.readOnly ? 'read' : 'write',
          platformPolicy: (context && context.allowedScopes) || undefined,
          externalAgentPolicy: (this.manifest && this.manifest.allowedScopes) || undefined
        },
        onEvent: (type, payload) => {
          if (typeof context.emit === 'function') context.emit(type, payload);
        },
        onPermission: this.permissionResolver || (context && context.onPermission)
      });

      // prompt 正常返回但进程其实已意外退出（stopReason 可信度存疑）→ 按 §65 判失败。
      if (runState.exitInfo && runState.exitInfo.clean === false && result && result.status === 'completed') {
        result = this._buildFailureResult(
          new AcpError(ACP_ERROR.UNEXPECTED_EXIT, 'agent process exited before the run was acknowledged'),
          runState
        );
      }
    } catch (err) {
      result = this._buildFailureResult(err, runState);
    } finally {
      // 终态即回收：无论成功、失败、取消还是超时，本 Run 的 ACP 进程都不允许留存（§27/§68）。
      await this._reclaim(runState, runtime);
    }

    this._settleRun(runState, result, context);
  }

  /** 取消已在别处发起时，用统一的 AcpError 中断流水线，交给 _buildFailureResult 归类。 */
  _throwIfCancelled(runState, stage) {
    if (runState.cancelRequested) {
      throw new AcpError(ACP_ERROR.CANCELLED, `run cancelled before ${stage}`);
    }
  }

  /**
   * 仅在 manifest 明确要求走 ACP authenticate 时才触发。
   * external_login 模式下用户在 Agent 自己的 CLI 里登录，平台绝不介入、
   * 绝不读取或转存任何凭据（spec §30/§31/§32）。
   */
  async _maybeAuthenticate(runtime) {
    if (this.authMode !== 'acp_authenticate') {
      // external_login：把握手得到的 authMethods 映射成展示状态（不含凭据）。
      const hs = typeof runtime.getHandshake === 'function' ? runtime.getHandshake() : null;
      if (hs && Array.isArray(hs.authMethods) && hs.authMethods.length) {
        this._lastAuthState = {
          state: AUTH_STATE.AUTH_REQUIRED, mode: AUTH_MODE.EXTERNAL_LOGIN,
          authenticated: false, detail: '需要登录（官方流程）'
        };
      } else if (hs) {
        this._lastAuthState = {
          state: AUTH_STATE.AUTHENTICATED, mode: AUTH_MODE.NONE,
          authenticated: true, detail: '该 Agent 不需要认证'
        };
      }
      return;
    }
    const hs = typeof runtime.getHandshake === 'function' ? runtime.getHandshake() : null;
    if (!hs || !Array.isArray(hs.authMethods) || !hs.authMethods.length) return;
    await runtime.authenticate(this.authMethodId || null);
    this._lastAuthState = {
      state: AUTH_STATE.AUTHENTICATED, mode: AUTH_MODE.EXTERNAL_LOGIN,
      authenticated: true, detail: '已通过 ACP 官方认证流程'
    };
  }

  /** 回收本 Run 的会话与进程；幂等，cancel 与正常路径都可调用。 */
  async _reclaim(runState, runtime) {
    if (runState.reclaimed) return;
    runState.reclaimed = true;
    if (!runtime) return;
    // 已取消的会话不再走 session/close（进程马上就要被杀，等 5s 超时没有意义）
    if (!runState.cancelRequested && runState.sessionId && typeof runtime.closeSession === 'function') {
      try { await runtime.closeSession(runState.sessionId); } catch { /* best effort */ }
    }
    try { runtime.disconnect(); } catch { /* noop */ }
  }

  /**
   * 把异常归类成 AgentResult。这里是 §65/§66/§67 的判定点：
   *   取消 > 超时 > 意外退出 > 一般失败
   */
  _buildFailureResult(err, runState) {
    const message = (err && err.message) ? err.message : String(err || 'unknown error');
    const exitInfo = runState.exitInfo || null;
    // 两条超时来源：① JSON-RPC 请求级超时（jsonRpcSession 打标）；
    // ② 进程级硬超时（CliProcessSupervisor 到点 killTree，经 transport exit 事件透传）。
    // 后者若不认，超时会退化成"进程意外退出 = FAILED"，违反 §67。
    const isTimeout = !!(
      (err && (err.timeout === true || err.code === ACP_ERROR.TIMEOUT)) ||
      (exitInfo && exitInfo.timedOut === true)
    );
    const unexpectedExit = !!(exitInfo && exitInfo.clean === false);

    let status;
    let errorCode;
    if (runState.cancelRequested) {
      status = 'cancelled';
      errorCode = ERROR_CODE.AGENT_CANCELLED;
    } else if (isTimeout) {
      status = 'timeout';
      errorCode = ERROR_CODE.AGENT_TIMEOUT;
    } else {
      status = 'failed';
      errorCode = unexpectedExit
        ? ACP_ERROR.UNEXPECTED_EXIT
        : ((err && err.code) || ERROR_CODE.AGENT_PROTOCOL_ERROR);
    }

    const errors = [];
    if (status === 'cancelled') errors.push('用户已停止');
    else if (status === 'timeout') errors.push(`external agent timed out after ${this.timeoutMs}ms`);
    else errors.push(message);
    // 超时/取消下的退出是**我方**动手杀的，不能写成"意外退出"，否则排障时会误导。
    if (unexpectedExit && status === 'failed') {
      const info = exitInfo || {};
      errors.push(`external agent exited unexpectedly (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`);
    }

    return {
      ok: false,
      agentId: this.id,
      runId: runState.runId,
      sessionId: runState.sessionId,
      status,
      stopReason: null,
      truncated: false,
      summary: '',
      findings: [],
      changedFiles: [],
      readFiles: [],
      plan: null,
      toolCalls: [],
      diff: null,
      artifacts: [],
      usage: null,
      errors,
      errorCode,
      durationMs: Date.now() - runState.startedAt,
      provenance: { agent: this.id, transport: 'acp', sessionId: runState.sessionId }
    };
  }

  /** 结算终态：只发一次事件、只回调一次 finishRun。 */
  _settleRun(runState, result, context) {
    if (runState.settled) return;
    runState.settled = true;

    const safeResult = result || this._buildFailureResult(new Error('run produced no result'), runState);
    const lifecycle = STATUS_TO_LIFECYCLE[safeResult.status] || LIFECYCLE.FAILED;
    const evt = STATUS_TO_EVENT[safeResult.status] || AGENT_EVENT.RUN_FAILED;

    runState.status = lifecycle;
    runState.result = safeResult;

    if (typeof context.emit === 'function') {
      try {
        context.emit(evt, {
          type: evt,
          runId: runState.runId,
          agentId: this.id,
          status: safeResult.status,
          errorCode: safeResult.errorCode || null,
          errors: safeResult.errors || []
        });
      } catch { /* GUI 侧异常不得影响回收 */ }
    }
    if (typeof context.finishRun === 'function') {
      try { context.finishRun(lifecycle, safeResult); } catch { /* noop */ }
    }
  }

  /**
   * 取消一个 Run（spec §66）。
   *
   * 流程：打标 → 发 v1 session/cancel **通知** → 等 grace period 让 Agent 以
   * stopReason='cancelled' 自然收尾 → 仍未终态则强杀本 Run 的进程兜底。
   * 强杀只作用于本适配器 spawn 的 PID，绝不触碰用户自己的 CLI（§106）。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    if (run.settled) {
      const q = run.runtime && typeof run.runtime.awaitQuiescence === 'function'
        ? await run.runtime.awaitQuiescence(3000) : { quiesced: true, residual: 0 };
      return { ok: true, alreadySettled: true, status: run.status, quiesced: q.quiesced === true, residual: q.residual };
    }

    run.cancelRequested = true;
    try {
      if (run.runtime && run.sessionId) {
        await run.runtime.cancel({ sessionId: run.sessionId });
      }
    } catch { /* 通知发不出去就直接进入兜底 */ }

    const deadline = Date.now() + this.cancelGraceMs;
    while (!run.settled && Date.now() < deadline) {
      await sleep(CANCEL_POLL_MS);
    }

    let forced = false;
    if (!run.settled) {
      // 兜底：dispose 会 reject 所有挂起请求（code=ACP_CANCELLED）并 killTree，
      // _executeAcp 的 catch 随即把它判成 cancelled 并完成结算。
      forced = true;
      await this._reclaim(run, run.runtime);
      const hardDeadline = Date.now() + 1000;
      while (!run.settled && Date.now() < hardDeadline) await sleep(CANCEL_POLL_MS);
    }

    // 极端情况下（runtime 被注入且不抛错）仍未结算 → 本地兜底结算，避免 Run 悬挂。
    if (!run.settled) {
      run.status = LIFECYCLE.CANCELLED;
      run.result = run.result || {
        ok: false, agentId: this.id, runId, sessionId: run.sessionId, status: 'cancelled',
        summary: '', errors: ['用户已停止'], changedFiles: [], artifacts: [],
        errorCode: ERROR_CODE.AGENT_CANCELLED
      };
      run.settled = true;
    }

    let quiesced = true;
    let residual = 0;
    if (run.runtime && typeof run.runtime.awaitQuiescence === 'function') {
      const q = await run.runtime.awaitQuiescence(3000);
      quiesced = q.quiesced === true;
      residual = q.residual;
    } else if (run.pid && !run.reclaimed) {
      quiesced = false;
      residual = { pid: run.pid };
    }
    return {
      ok: quiesced, forced, status: run.status,
      quiesced, residual,
      detail: quiesced ? 'ACP process/session quiesced' : 'ACP process exit unconfirmed'
    };
  }

  async awaitQuiescence(runId, timeoutMs = 3000) {
    const run = this._runs.get(runId);
    if (!run) return { quiesced: true, residual: 0 };
    if (run.runtime && typeof run.runtime.awaitQuiescence === 'function') return run.runtime.awaitQuiescence(timeoutMs);
    return { quiesced: !!run.reclaimed, residual: run.reclaimed ? 0 : { pid: run.pid } };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: run.status, startedAt: run.startedAt, sessionId: run.sessionId, pid: run.pid || null };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  async dispose() {
    for (const [, run] of this._runs) {
      run.cancelRequested = true;
      try { await this._reclaim(run, run.runtime); } catch { /* noop */ }
    }
    this._runs.clear();
    // supervisor 只管理本适配器 spawn 的进程，dispose 不会波及用户自己的 CLI（§106）。
    try { this.supervisor.dispose(); } catch { /* noop */ }
    this._detected = null;
  }
}

module.exports = { AcpAgentAdapter };
