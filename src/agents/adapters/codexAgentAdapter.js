'use strict';
/**
 * Codex 适配器 —— v2.6.0 起存在，v2.8.0 升级为深度集成（spec §42/§43/§44/§45/§46/§47/§48）。
 *
 * spec §42 明确要求"不要删除 CodexAgentAdapter，而是升级它"，所以本文件保留
 * 原有的类名 / 构造签名 / parseCodexResult 导出，只在内部增加运行时选路：
 *
 *   runtimeMode = auto（默认）
 *     1) app-server  —— primary，结构化协议（codex app-server，JSONL 裸信封 JSON-RPC）
 *     2) exec        —— fallback，结构化 JSON（codex exec --json）
 *     3) legacy      —— 最后兜底，沿用 v2.6.0 的 runCodex（含 API 模式 / 连接存储）
 *
 * 三条硬约束：
 *   - spec §44：primary 不允许"正则分析自然语言终端输出"。前两条路径都是官方
 *     结构化 JSON；legacy 只在前两者都不可用时启用，并会发 FALLBACK 事件留痕。
 *   - spec §45：capability 按实际运行时动态给，不允许一律 true。
 *   - spec §65/§67：进程意外退出 = FAILED（不是 COMPLETED）；超时 ≠ 取消。
 *
 * 凭据：本适配器从不读取 / 提取 Codex 登录 token（spec §30/§31/§32）。
 * app-server 模式下只调用 getAuthStatus 读"是否已登录"，不碰 token 本体。
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../hub/types');
const { CODEX } = require('../manifests/builtinAgents');
const {
  runCodex,
  killTree,
  resolveCliInPath,
  resolveCodexCli,
  TERMINAL_STATES
} = require('../../services/externalAgents');
const { createCodexAppServerClient } = require('../protocols/codex/codexAppServerClient');
const { createCodexExecRunner } = require('../protocols/codex/codexExecRunner');
const { createCodexAppServerEventMapper } = require('../protocols/codex/codexEventMapper');
const { createExternalAgentSessionManager } = require('../session/externalAgentSessionManager');
const { buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const permissionBroker = require('../protocols/acp/permissionBroker');
const { classifyRisk } = require('../../security/permissionRiskClassifier');
const permissionAudit = require('../../security/permissionAudit');
const { AUTH_STATE, AUTH_MODE } = require('../protocols/acp/authBroker');
const { TURN_STATUS } = require('../protocols/codex/appServerConstants');

const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600000;

/** 运行时选路模式。 */
const RUNTIME_MODE = {
  AUTO: 'auto',
  APP_SERVER: 'app-server',
  EXEC: 'exec',
  LEGACY: 'legacy'
};

/**
 * 各运行时实际具备的能力（spec §45：实际支持什么就填什么，不要全 true）。
 *
 * 依据：
 *   app-server —— thread/turn/审批/diff/plan/reasoning/review 全套结构化接口
 *                 （v2/turn.rs、v2/item.rs、review/start）
 *   exec       —— 同样结构化，但没有交互式审批通道、没有 turn/interrupt，
 *                 review 需另起 `codex exec review` 子命令，故此处不声明。
 *   legacy     —— 只有一次性文本/JSON 结果，无结构化事件。
 */
const RUNTIME_CAPABILITIES = {
  [RUNTIME_MODE.APP_SERVER]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    review: true, planning: true, reasoning: true, mcp: true, web: true,
    sandbox: true, session: true, resume: true, streaming: true,
    approval: true, interrupt: true, subagent: false
  },
  [RUNTIME_MODE.EXEC]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    review: false, planning: true, reasoning: true, mcp: true, web: true,
    sandbox: true, session: true, resume: true, streaming: true,
    approval: false, interrupt: false, subagent: false
  },
  [RUNTIME_MODE.LEGACY]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    review: false, planning: false, reasoning: false, mcp: false, web: false,
    sandbox: true, session: false, resume: false, streaming: true,
    approval: false, interrupt: false, subagent: false
  }
};

/** 把 runCodex 返回的 JSON 字符串解析为统一结果对象（v2.6.0 legacy 路径沿用）。 */
function parseCodexResult(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const status = TERMINAL_STATES.includes(parsed.status) ? parsed.status : 'failed';
    return {
      status,
      summary: parsed.summary || '',
      findings: parsed.findings || [],
      changedFiles: parsed.changedFiles || [],
      artifacts: parsed.artifacts || [],
      errors: parsed.errors || [],
      raw: parsed
    };
  } catch {
    return {
      status: 'failed',
      summary: String(raw || '').slice(0, 4000),
      findings: [], changedFiles: [], artifacts: [], errors: ['无法解析 Codex 返回结果']
    };
  }
}

/** JSON-RPC "method not found"：说明当前 codex 版本没有该深度方法 → 降级。 */
function isMethodNotFound(err) {
  if (!err) return false;
  if (err.code === -32601) return true;
  return /method not found|-32601|unknown method/i.test(String(err.message || ''));
}

class CodexAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] codex manifest（缺省取内置 CODEX）
   * @param {object} [opts.store]    连接存储（legacy runCodex API 模式需要）
   * @param {object} [opts.config]   { runtimeMode, sandbox, model, timeoutMs, passthroughEnv, onPermission }
   * @param {object} [opts.sessionPersistence] 会话落库后端（spec §110/§111；缺省纯内存）
   * @param {Function} [opts.appServerClientFactory] 注入（单测）
   * @param {Function} [opts.execRunnerFactory]      注入（单测）
   */
  constructor({ manifest, store, config, sessionPersistence, appServerClientFactory, execRunnerFactory } = {}) {
    super({ manifest: manifest || CODEX, config });
    this.store = store || null;
    const cfg = { ...((manifest || CODEX).config || {}), ...(config || {}) };
    this.runtimeMode = cfg.runtimeMode || RUNTIME_MODE.AUTO;
    this.sandbox = cfg.sandbox || null;
    this.passthroughEnv = Array.isArray(cfg.passthroughEnv) ? cfg.passthroughEnv : [];
    this.permissionResolver = cfg.onPermission || null;
    this.sessions = createExternalAgentSessionManager({ persistence: sessionPersistence });
    this._appServerClientFactory = appServerClientFactory || createCodexAppServerClient;
    this._execRunnerFactory = execRunnerFactory || createCodexExecRunner;
    // runId -> run state
    this._runs = new Map();
    this._detected = null;
    /** 实际生效的运行时（首次 startTask 后确定），供 GUI / 路由查询。 */
    this._activeRuntime = null;
    /** app-server getAuthStatus 的最近一次结果（不含任何凭据本体）。 */
    this._lastAuthStatus = null;
  }

  getManifest() {
    // capability 随实际运行时动态回填（spec §45）
    const caps = RUNTIME_CAPABILITIES[this._activeRuntime] || null;
    if (!caps) return { ...this.manifest };
    return { ...this.manifest, capabilities: { ...this.manifest.capabilities, ...caps } };
  }

  /** 当前生效的运行时（'app-server' | 'exec' | 'legacy' | null）。 */
  getActiveRuntime() { return this._activeRuntime; }

  /**
   * 探测 Codex CLI，并判断是否支持 app-server 深度路径。
   *
   * app-server 子命令在 cli/src/main.rs:152-153 是**非 hidden** 的
   * （"[experimental] Run the app server or related tooling."），
   * 因此可以用无副作用的 `codex --help` 判定其存在性，无需真的起进程。
   */
  async detect() {
    if (this._detected) return this._detected;
    const cfg = this.manifest.config || this.config || {};
    let cliPath = null;
    try { cliPath = await resolveCodexCli(cfg); } catch { /* fallthrough to PATH */ }
    if (!cliPath) {
      try { cliPath = await resolveCliInPath('codex'); } catch { cliPath = null; }
    }
    let version = null;
    let supportsAppServer = false;
    if (cliPath) {
      try { version = await this._readVersion(cliPath); } catch { version = null; }
      try {
        const help = await this._readHelp(cliPath);
        supportsAppServer = /(^|\s)app-server(\s|$)/m.test(help);
      } catch { supportsAppServer = false; }
    }
    this._detected = { available: !!cliPath, version, path: cliPath, supportsAppServer };
    return this._detected;
  }

  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: 'codex CLI not found in PATH'
      };
    }
    try {
      const version = await this._readVersion(detected.path);
      return {
        status: HEALTH_STATE.HEALTHY,
        version,
        latencyMs: Date.now() - start,
        detail: detected.supportsAppServer
          ? 'codex CLI responsive（支持 app-server 深度集成）'
          : 'codex CLI responsive（无 app-server，将使用 codex exec --json）'
      };
    } catch (e) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: `codex --version failed: ${e.message}`
      };
    }
  }

  /**
   * 同步返回当前认证状态（spec §29/§75/§79）。
   *
   * 可判定的两条路径：
   *   - 配置显式提供 OPENAI_API_KEY → API_KEY
   *   - app-server 运行时曾回报 getAuthStatus → 缓存的 authenticated/required
   * 其余一律 UNKNOWN：平台不读取 Codex 登录 token（spec §30/§31）。
   */
  getAuthState() {
    const env = (this.config && this.config.environment) || {};
    if (env.OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
      return { state: AUTH_STATE.API_KEY, mode: AUTH_MODE.API_KEY, authenticated: true, detail: '使用 API Key' };
    }
    if (this._lastAuthStatus) {
      const loggedIn = this._lastAuthStatus === 'authenticated' || this._lastAuthStatus === 'authenticated_with_api_key';
      return {
        state: loggedIn ? AUTH_STATE.AUTHENTICATED : AUTH_STATE.AUTH_REQUIRED,
        mode: AUTH_MODE.EXTERNAL_LOGIN,
        authenticated: loggedIn,
        detail: loggedIn ? '已认证（官方 Codex 登录态）' : '需要登录（codex login）'
      };
    }
    return {
      state: AUTH_STATE.UNKNOWN,
      mode: AUTH_MODE.EXTERNAL_LOGIN,
      authenticated: false,
      detail: '依赖官方 Codex 登录态（平台不读取凭据，无法核实）'
    };
  }

  /** 跑 `${cliPath} --version`，限时 5s，返回 trimmed stdout。 */
  _readVersion(cliPath) {
    return this._runShortLived(cliPath, ['--version'], code => code === 0);
  }

  /** 跑 `${cliPath} --help`，限时 5s。clap 的 help 可能以非 0 退出，故放宽判定。 */
  _readHelp(cliPath) {
    return this._runShortLived(cliPath, ['--help'], () => true);
  }

  /** 短命令执行封装（--version / --help）。 */
  _runShortLived(cliPath, args, acceptExit) {
    return new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawn(cliPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(new Error('spawn failed: ' + e.message));
      }
      const timer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        reject(new Error(`${args[0]} command timed out`));
      }, HEALTH_TIMEOUT_MS);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (acceptExit(code)) resolve(out.trim());
        else reject(new Error(`${args[0]} exited with code ${code}`));
      });
    });
  }

  /**
   * 启动一次 Codex Run。立即返回 runId；实际执行在后台，
   * 状态 / 结果走 getStatus / getResult，流式事件走 context.emit。
   *
   * @param {object} task    { goal, projectId, projectRoot, timeoutMs, model, sandbox, resumeSessionId, readOnly, ... }
   * @param {object} context { signal, emit, onChunk, onState, projectRoot, store, onPermission, finishRun }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('CodexAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    const normalizedTask = typeof task === 'string' ? { goal: task } : task;

    const runId = crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      taskText,
      runtime: null,
      client: null,
      threadId: null
    };
    this._runs.set(runId, runState);

    this._emit(context, AGENT_EVENT.RUN_STARTED, { runId, agentId: this.id, goal: taskText });

    this._dispatch(runId, normalizedTask, taskText, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      this._emit(context, AGENT_EVENT.RUN_FAILED, { runId, agentId: this.id, error: err && err.message });
      if (typeof context.finishRun === 'function') context.finishRun('failed', runState.result);
    });

    return { runId };
  }

  _emit(context, type, payload) {
    if (context && typeof context.emit === 'function') {
      try { context.emit(type, { type, ...payload }); } catch { /* listener 抛错不得影响 Run */ }
    }
  }

  /**
   * 运行时选路 + 自动降级（spec §43）。
   * 降级都会发 AGENT_EVENT.FALLBACK，保证 GUI / 日志能看到"为什么没走深度路径"。
   */
  async _dispatch(runId, task, taskText, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;

    const detected = await this.detect();
    if (!detected.available) {
      throw new Error('codex CLI 不可用（PATH 中未找到 codex）');
    }

    const mode = this.runtimeMode;
    const wantAuto = mode === RUNTIME_MODE.AUTO;

    // 1) app-server（primary）
    if (mode === RUNTIME_MODE.APP_SERVER || (wantAuto && detected.supportsAppServer)) {
      try {
        return await this._runAppServer(runId, task, taskText, context, detected);
      } catch (err) {
        if (mode === RUNTIME_MODE.APP_SERVER) throw err; // 显式指定就不静默降级
        this._emit(context, AGENT_EVENT.FALLBACK, {
          runId, agentId: this.id, from: RUNTIME_MODE.APP_SERVER, to: RUNTIME_MODE.EXEC,
          reason: isMethodNotFound(err) ? 'METHOD_NOT_FOUND' : 'APP_SERVER_UNAVAILABLE',
          detail: err && err.message
        });
      }
    }

    // 2) codex exec --json（结构化 fallback）
    if (mode === RUNTIME_MODE.EXEC || wantAuto) {
      try {
        return await this._runExec(runId, task, taskText, context, detected);
      } catch (err) {
        if (mode === RUNTIME_MODE.EXEC) throw err;
        this._emit(context, AGENT_EVENT.FALLBACK, {
          runId, agentId: this.id, from: RUNTIME_MODE.EXEC, to: RUNTIME_MODE.LEGACY,
          reason: 'EXEC_UNAVAILABLE', detail: err && err.message
        });
      }
    }

    // 3) legacy runCodex（v2.6.0 行为，最后兜底）
    return this._runLegacy(runId, task, taskText, context);
  }

  // ────────────────────────────── app-server（primary） ──────────────────────────────

  async _runAppServer(runId, task, taskText, context, detected) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.runtime = RUNTIME_MODE.APP_SERVER;
    this._activeRuntime = RUNTIME_MODE.APP_SERVER;

    const cwd = task.projectRoot || (context && context.projectRoot) || undefined;
    const env = buildEnvAllowlist(this.passthroughEnv, (context && context.env) || {});
    const timeoutMs = Number(task.timeoutMs) || Number(this.config && this.config.timeoutMs) || DEFAULT_TIMEOUT_MS;

    const client = this._appServerClientFactory();
    runState.client = client;

    const mapper = createCodexAppServerEventMapper({
      emit: (type, payload) => this._emit(context, type, payload)
    });
    client.onAnyNotification((method, params) => mapper.map(method, params, { runId, agentId: this.id }));

    // 意外退出必须判 FAILED（spec §65）
    let unexpectedExit = null;
    client.onExit(info => {
      if (!info.clean) unexpectedExit = info;
    });

    await client.connect({ command: detected.path, cwd, env, timeoutMs });

    const probe = client.probeMethods();
    if (!probe.ok) throw new Error('codex app-server 握手成功但状态异常');

    // 只读登录状态并缓存，供路由 / GUI 展示；绝不触碰 token 本体（spec §30/§79）。
    try {
      const auth = await client.getAuthStatus();
      if (auth && auth.ok) this._lastAuthStatus = auth.authenticated ? 'authenticated' : 'required';
    } catch { /* 读不到登录态不阻断 Run */ }

    // 审批：交集评估 + GUI 决策，缺省一律拒绝（spec §35/§36）
    client.onApproval(async ({ kind, params }) => this._decideApproval(kind, params, task, context, runId));

    // Session（spec §39/§109：Session ≠ Run）
    let threadId;
    if (task.resumeSessionId) {
      ({ threadId } = await client.resumeThread({ threadId: task.resumeSessionId }));
      this.sessions.linkRun(runId, this.id, threadId);
    } else {
      ({ threadId } = await client.startThread({
        cwd,
        model: task.model || (this.config && this.config.model) || undefined,
        sandbox: task.sandbox || this.sandbox || undefined
      }));
      this.sessions.create({
        agentId: this.id,
        externalSessionId: threadId,
        projectId: task.projectId || null,
        projectRoot: cwd || null,
        parentRunId: runId,
        transport: 'codex-app-server',
        resumable: true
      });
    }
    runState.threadId = threadId;
    runState.status = LIFECYCLE.RUNNING;

    const turn = await client.startTurn({ threadId, text: taskText, cwd, timeoutMs });

    const acc = mapper.finalize();
    let status;
    if (runState.ac.signal.aborted) status = 'cancelled';
    else if (turn.status === 'timeout') status = 'timeout';
    else if (unexpectedExit) status = 'failed';
    else {
      switch (turn.status) {
        case TURN_STATUS.COMPLETED: status = 'completed'; break;
        case TURN_STATUS.INTERRUPTED: status = 'cancelled'; break;
        default: status = 'failed';
      }
    }

    const errors = [...acc.errors];
    if (unexpectedExit) {
      errors.push(`codex app-server 意外退出（code=${unexpectedExit.code}${unexpectedExit.signal ? `, signal=${unexpectedExit.signal}` : ''}）`);
      const tail = String(unexpectedExit.stderr || '').trim().slice(-2000);
      if (tail) errors.push(`stderr: ${tail}`);
    }
    if (status === 'timeout') errors.push(`执行超时（${timeoutMs} ms）`);
    if (status === 'cancelled' && !errors.length) errors.push('用户已停止');

    const result = {
      status,
      summary: acc.summary,
      findings: [],
      changedFiles: acc.changedFiles,
      diff: acc.diff,
      usage: acc.usage,
      plan: acc.plan,
      artifacts: [],
      errors,
      sessionId: threadId,
      runtime: RUNTIME_MODE.APP_SERVER
    };

    try { client.dispose(); } catch { /* noop */ }
    this.sessions.setStatus(runId, status);
    this._settle(runId, result, context);
    return result;
  }

  /**
   * 审批决策（spec §34/§35/§36）。
   * 顺序：权限交集评估 → 不通过直接 decline；通过再交 GUI；无 GUI 一律 decline。
   */
  async _decideApproval(kind, params, task, context, runId) {
    const operation = kind === 'command'
      ? permissionBroker.OPERATION.RUN_SHELL
      : kind === 'fileChange'
        ? permissionBroker.OPERATION.WRITE_FILE
        : permissionBroker.OPERATION.OTHER;

    const evaluation = permissionBroker.evaluate({ operation }, {
      parentRunPermission: task.readOnly ? 'read' : 'write',
      platformPolicy: (context && context.allowedScopes) || undefined,
      externalAgentPolicy: (this.manifest && this.manifest.allowedScopes) || undefined
    });

    const projectRoot = task.cwd || (context && context.cwd) || null;
    const commandText = kind === 'command'
      ? (typeof params === 'string' ? params : (params && (params.command || params.cmd || params.input || params.shell || '')) || '')
      : '';
    const riskInfo = classifyRisk({ command: commandText, cwd: projectRoot, projectRoot }, operation, projectRoot);
    const resolver = this.permissionResolver || (context && context.onPermission);
    const hasResolver = typeof resolver === 'function';
    const decision = permissionBroker.decidePermission(evaluation, riskInfo, { hasResolver });

    this._emit(context, AGENT_EVENT.PERMISSION_REQUIRED, {
      runId, agentId: this.id, kind, operation,
      granted: evaluation.granted, reason: evaluation.reason,
      risk: riskInfo.risk, riskReasons: riskInfo.reasons, decisionSource: decision.decisionSource
    });

    // v2.8.1 — 登记权限决策审计（spec §31/§32/§78）：含风险与决策来源，命令已脱敏。
    const finalize = (granted, source) => permissionAudit.log({
      runId, agentId: this.id, risk: riskInfo.risk, operation, decision: granted, decisionSource: source, command: commandText
    });

    if (!evaluation.granted) { finalize(false, evaluation.reason); return 'decline'; }

    if (!hasResolver) {
      // 无 GUI resolver：按风险 fail-closed（§26），不默认放行危险命令。
      finalize(decision.granted, decision.decisionSource);
      return decision.granted ? 'accept' : 'decline';
    }
    try {
      const userDecision = await resolver({ kind, operation, params, runId, agentId: this.id, risk: riskInfo.risk, riskReasons: riskInfo.reasons });
      if (userDecision === true || userDecision === 'accept' || userDecision === 'approved') { finalize(true, 'USER'); return 'accept'; }
      if (userDecision === 'cancel' || userDecision === 'cancelled') { finalize(false, 'USER'); return 'cancel'; }
      finalize(false, 'USER'); return 'decline';
    } catch { finalize(false, 'USER'); return 'decline'; }
  }

  // ────────────────────────────── codex exec --json（fallback） ──────────────────────────────

  async _runExec(runId, task, taskText, context, detected) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.runtime = RUNTIME_MODE.EXEC;
    this._activeRuntime = RUNTIME_MODE.EXEC;
    runState.status = LIFECYCLE.RUNNING;

    const cwd = task.projectRoot || (context && context.projectRoot) || undefined;
    const env = buildEnvAllowlist(this.passthroughEnv, (context && context.env) || {});
    const timeoutMs = Number(task.timeoutMs) || Number(this.config && this.config.timeoutMs) || DEFAULT_TIMEOUT_MS;

    const runner = this._execRunnerFactory();
    const raw = await runner.run({
      command: detected.path,
      prompt: taskText,
      cwd,
      env,
      model: task.model || (this.config && this.config.model) || null,
      sandbox: task.sandbox || this.sandbox || (task.readOnly ? 'read-only' : null),
      addDirs: task.additionalDirectories || [],
      skipGitRepoCheck: !!task.skipGitRepoCheck,
      resumeSessionId: task.resumeSessionId || null,
      timeoutMs,
      signal: runState.ac.signal,
      runId,
      agentId: this.id,
      onEvent: (type, payload) => this._emit(context, type, payload)
    });

    if (raw.threadId) {
      runState.threadId = raw.threadId;
      if (task.resumeSessionId) this.sessions.linkRun(runId, this.id, raw.threadId);
      else {
        this.sessions.create({
          agentId: this.id,
          externalSessionId: raw.threadId,
          projectId: task.projectId || null,
          projectRoot: cwd || null,
          parentRunId: runId,
          transport: 'codex-exec',
          resumable: true
        });
      }
      this.sessions.setStatus(runId, raw.status);
    }

    const result = {
      status: raw.status,
      summary: raw.summary,
      findings: [],
      changedFiles: raw.changedFiles,
      diff: raw.diff,
      usage: raw.usage,
      plan: raw.plan,
      artifacts: [],
      errors: raw.errors,
      sessionId: raw.threadId || null,
      runtime: RUNTIME_MODE.EXEC
    };
    this._settle(runId, result, context);
    return result;
  }

  // ────────────────────────────── legacy runCodex（兜底） ──────────────────────────────

  async _runLegacy(runId, task, taskText, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.runtime = RUNTIME_MODE.LEGACY;
    this._activeRuntime = RUNTIME_MODE.LEGACY;
    runState.status = LIFECYCLE.RUNNING;

    const cfg = {
      ...(this.manifest.config || {}),
      ...(this.config || {}),
      ...(task.config || {}),
      cliPath: task.cliPath || (this.manifest.config && this.manifest.config.cliPath) || (this.config && this.config.cliPath),
      cliMode: task.cliMode || (this.manifest.config && this.manifest.config.cliMode) || (this.config && this.config.cliMode),
      connectionId: task.connectionId || (this.manifest.config && this.manifest.config.connectionId) || (this.config && this.config.connectionId),
      model: task.model || (this.manifest.config && this.manifest.config.model) || (this.config && this.config.model),
      args: task.args || (this.manifest.config && this.manifest.config.args) || (this.config && this.config.args),
      cwd: task.cwd || task.projectRoot || (context && context.projectRoot) || (this.config && this.config.cwd),
      timeoutMs: task.timeoutMs || (this.config && this.config.timeoutMs) || DEFAULT_TIMEOUT_MS
    };

    const legacyAdapter = {
      id: this.manifest.id,
      name: this.manifest.displayName,
      adapter_type: 'codex',
      config: cfg,
      model: cfg.model || null,
      command: cfg.cliPath || 'codex'
    };

    const store = (context && context.store) || this.store;
    const signal = runState.ac.signal;
    const raw = await runCodex(legacyAdapter, taskText, store, {
      signal,
      onChunk: context && context.onChunk,
      onState: context && context.onState,
      projectId: (context && context.projectId) || null,
      projectRoot: (context && context.projectRoot) || null,
      conversationId: context && context.conversationId,
      taskId: context && context.taskId
    });
    const result = parseCodexResult(raw);
    if (signal.aborted && result.status !== 'cancelled') {
      result.status = 'cancelled';
      if (!result.errors || !result.errors.length) result.errors = ['用户已停止'];
    }
    result.runtime = RUNTIME_MODE.LEGACY;
    this._settle(runId, result, context);
    return result;
  }

  /** 统一收尾：写状态、发终态事件、通知 Hub（终态只发一次，spec §64）。 */
  _settle(runId, result, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    if (runState._settled) return;
    runState._settled = true;

    runState.status = this._mapToLifecycle(result.status);
    runState.result = result;

    const evt = result.status === 'completed' ? AGENT_EVENT.RUN_COMPLETED
      : result.status === 'cancelled' ? AGENT_EVENT.RUN_CANCELLED
        : result.status === 'timeout' ? AGENT_EVENT.RUN_TIMEOUT : AGENT_EVENT.RUN_FAILED;
    this._emit(context, evt, {
      runId, agentId: this.id, status: result.status, runtime: result.runtime
    });
    if (context && typeof context.finishRun === 'function') {
      try { context.finishRun(runState.status, result); } catch { /* noop */ }
    }
  }

  _mapToLifecycle(status) {
    switch (status) {
      case 'completed': return LIFECYCLE.COMPLETED;
      case 'failed': return LIFECYCLE.FAILED;
      case 'cancelled': return LIFECYCLE.CANCELLED;
      case 'timeout': return LIFECYCLE.TIMEOUT;
      case 'running': return LIFECYCLE.RUNNING;
      default: return LIFECYCLE.FAILED;
    }
  }

  /** sendMessage：仅 app-server 支持运行中干预（turn/steer），其余模式明确不支持。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    if (run.runtime !== RUNTIME_MODE.APP_SERVER) {
      return { ok: false, error: `codex ${run.runtime || 'cli'} 运行时不支持运行中追加消息` };
    }
    return { ok: false, error: 'turn/steer 尚未接入（需 experimental 能力协商）' };
  }

  /**
   * 取消（spec §66）：先走协议中断，再回收本 Run 自己拉起的进程。
   * 绝不遍历杀 "codex" 进程名 —— 只动本适配器 spawn 的那棵进程树（spec §106）。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };

    if (run.runtime === RUNTIME_MODE.APP_SERVER && run.client && run.threadId) {
      try { await run.client.interruptTurn(run.threadId); } catch { /* 继续走强制回收 */ }
      await new Promise(r => setTimeout(r, 300)); // grace period
    }
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.client) { try { run.client.dispose(); } catch { /* noop */ } }

    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: run.status, startedAt: run.startedAt, runtime: run.runtime, sessionId: run.threadId || null };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：取消所有在跑的 Codex run，并回收 app-server 连接。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try {
        if (run.status === LIFECYCLE.RUNNING || run.status === LIFECYCLE.STARTING) run.ac.abort();
      } catch { /* non-fatal */ }
      if (run.client) { try { run.client.dispose(); } catch { /* noop */ } }
    }
    this._runs.clear();
    this._detected = null;
    this._activeRuntime = null;
    this.sessions.clear();
  }
}

module.exports = {
  CodexAgentAdapter,
  parseCodexResult,
  RUNTIME_MODE,
  RUNTIME_CAPABILITIES
};
