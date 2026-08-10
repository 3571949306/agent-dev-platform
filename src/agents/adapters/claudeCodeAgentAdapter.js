'use strict';
/**
 * v2.8.0 — Claude Code 适配器（spec §49/§50/§51/§52/§53/§54）。
 *
 * spec §49 只规定"新增 ClaudeCodeAgentAdapter，production runtime 由研究决定"，
 * 研究结论（详见 docs/CLAUDE_RUNTIME_DECISION.md）：
 *
 *   runtimeMode = auto（默认）
 *     1) sdk  —— primary：@anthropic-ai/claude-agent-sdk 的 query()
 *                事件最全（thinking / stream_event / permission_denials / usage+cost）、
 *                session 最全（resume / forkSession）、permission 最全
 *                （canUseTool 是**唯一**能在非交互场景下由平台逐次裁决的官方通道）。
 *                → 满足 spec §50 "不要为了 CLI 统一反而放弃官方 SDK"。
 *     2) acp  —— 可选：@agentclientprotocol/claude-agent-acp（Apache-2.0, v0.66.0）。
 *                它本身就是"SDK 外面套一层 ACP"，多一层依赖，因此**不进 auto 链**，
 *                只在显式 runtimeMode='acp' 或 config.acpEnabled 时启用（spec §52：
 *                必须 pin version + audit）。走通用 AcpAgentAdapter，不在此重复实现。
 *     3) cli  —— fallback：claude -p --output-format stream-json（spec §53）。
 *                与 SDK **同一套 schema**，所以共用 claudeEventMapper；
 *                但没有 canUseTool 回调、没有 interrupt，能力声明必须如实降级（§45 精神）。
 *
 * 安全红线（spec §36/§30/§31/§32/§70）：
 *   - 绝不下发 permissionMode='bypassPermissions'，绝不使用 --dangerously-skip-permissions。
 *   - canUseTool 缺省 deny：先过权限交集（Broker），再交 GUI；无 GUI 一律拒绝。
 *   - 不读取 / 不提取 Claude 登录凭据，只依赖用户已有的官方登录态。
 *   - env 走 allowlist（SDK 的 options.env 会**整体替换**子进程环境，正合我们的最小化诉求）。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../hub/types');
const { CLAUDE_CODE } = require('../manifests/builtinAgents');
const { createClaudeEventMapper } = require('../protocols/claude/claudeEventMapper');
const {
  SDK_PACKAGE, CLI_COMMAND, PERMISSION_MODE, ALLOWED_PERMISSION_MODES,
  TOOL_KIND, classifyTool
} = require('../protocols/claude/claudeConstants');
const { createStructuredStreamDecoder } = require('../runtime/structuredStreamDecoder');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const { createExternalAgentSessionManager } = require('../session/externalAgentSessionManager');
const permissionBroker = require('../protocols/acp/permissionBroker');
const { AUTH_STATE, AUTH_MODE } = require('../protocols/acp/authBroker');
const { resolveCliInPath } = require('../../services/externalAgents');

const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/** 运行时选路模式。 */
const RUNTIME_MODE = {
  AUTO: 'auto',
  SDK: 'sdk',
  ACP: 'acp',
  CLI: 'cli'
};

/**
 * 各运行时**实际**具备的能力（spec §45：不允许一律 true）。
 *
 * 依据（逐条对应官方文档，不臆造）：
 *   sdk  —— Query.interrupt()/setPermissionMode()/setModel() 仅在 streaming input 模式可用；
 *           canUseTool 提供逐次审批；resume + forkSession 提供完整 session 语义。
 *   cli  —— 同一 schema 的 stream-json，但审批只能靠 --permission-mode / --allowedTools
 *           这类**预置策略**，没有运行时逐次回调 → approval:false、interrupt:false。
 *   acp  —— 由 ACP initialize 协商结果决定，这里给保守初值，实际以 AcpAgentAdapter 为准。
 */
const RUNTIME_CAPABILITIES = {
  [RUNTIME_MODE.SDK]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    planning: true, reasoning: true, mcp: true, review: false,
    streaming: true, session: true, resume: true,
    approval: true, interrupt: true, subagent: true, sandbox: false
  },
  [RUNTIME_MODE.CLI]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    planning: true, reasoning: true, mcp: true, review: false,
    streaming: true, session: true, resume: true,
    approval: false, interrupt: false, subagent: true, sandbox: false
  },
  [RUNTIME_MODE.ACP]: {
    coding: true, filesystem: true, terminal: true, git: true, diff: true,
    planning: true, reasoning: true, mcp: true, review: false,
    streaming: true, session: true, resume: true,
    approval: true, interrupt: true, subagent: false, sandbox: false
  }
};

/** 只读父 Run 下必须拉黑的写类工具（CLI 模式没有逐次回调，只能靠 deny 规则兜底）。 */
const READONLY_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** 把工具名映射到 Broker 的权限操作类别。 */
function operationForTool(toolName) {
  switch (classifyTool(toolName)) {
    case TOOL_KIND.COMMAND: return permissionBroker.OPERATION.RUN_SHELL;
    case TOOL_KIND.FILE_WRITE: return permissionBroker.OPERATION.WRITE_FILE;
    case TOOL_KIND.FILE_READ: return permissionBroker.OPERATION.OTHER;
    case TOOL_KIND.PLAN: return permissionBroker.OPERATION.OTHER;
    default:
      return /^mcp__/.test(String(toolName || ''))
        ? permissionBroker.OPERATION.MCP
        : permissionBroker.OPERATION.OTHER;
  }
}

/** 规整平台下发的 permissionMode —— 白名单外一律回落 default（绝不放行 bypass）。 */
function sanitizePermissionMode(mode, readOnly) {
  if (readOnly) return PERMISSION_MODE.PLAN;
  if (mode && ALLOWED_PERMISSION_MODES.has(mode)) return mode;
  return PERMISSION_MODE.DEFAULT;
}

/**
 * 组装 `claude -p --output-format stream-json` 参数（spec §53：只用公开官方 flag）。
 *
 * flag 来源（docs.claude.com/en/docs/claude-code/cli-reference，逐条核对）：
 *   --print/-p、--output-format {text|json|stream-json}、--verbose
 *   --resume/-r <id|name>、--fork-session、--session-id <uuid>
 *   --include-partial-messages（Requires --print 与 --output-format stream-json）
 *   --add-dir、--permission-mode、--allowedTools、--disallowedTools、--max-turns、--model
 *
 * 明确 **不使用**：--dangerously-skip-permissions（spec §36）。
 * prompt 不走 argv 而走 stdin：既避开 Windows 32767 字符上限，也避免引号/换行被 shell 破坏；
 * CHANGELOG 亦确认 `claude -p` 支持从 stdin 读取输入。
 */
function buildCliArgs(o = {}) {
  const args = ['-p', '--output-format', 'stream-json'];

  // 文档中所有 stream-json 示例均带 --verbose，且早期版本强制要求，加上更稳妥。
  args.push('--verbose');

  if (o.resumeSessionId) {
    args.push('--resume', String(o.resumeSessionId));
    if (o.forkSession) args.push('--fork-session');
  } else if (o.sessionId) {
    args.push('--session-id', String(o.sessionId));
  }

  if (o.model) args.push('--model', String(o.model));
  if (o.permissionMode) args.push('--permission-mode', String(o.permissionMode));
  if (Array.isArray(o.allowedTools) && o.allowedTools.length) {
    args.push('--allowedTools', ...o.allowedTools.map(String));
  }
  if (Array.isArray(o.disallowedTools) && o.disallowedTools.length) {
    args.push('--disallowedTools', ...o.disallowedTools.map(String));
  }
  if (Number.isFinite(o.maxTurns) && o.maxTurns > 0) args.push('--max-turns', String(o.maxTurns));
  if (Array.isArray(o.addDirs)) {
    for (const d of o.addDirs) { if (d) args.push('--add-dir', String(d)); }
  }
  if (o.includePartialMessages) args.push('--include-partial-messages');
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs.filter(a => typeof a === 'string'));
  return args;
}

/**
 * 可中断的异步消息队列 —— 给 SDK 的 streaming input 模式用。
 *
 * 为什么必须 streaming input：官方文档明确 `interrupt()` / `setPermissionMode()` /
 * `setModel()` **仅在 streaming input 模式可用**。若 prompt 传字符串，取消就只能靠
 * abortController 硬砍，拿不到"优雅中断"的语义（spec §66）。
 */
function createInputQueue(initialMessages = []) {
  const pending = [...initialMessages];
  let resolveNext = null;
  let closed = false;

  function push(msg) {
    if (closed) return false;
    if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: msg, done: false }); }
    else pending.push(msg);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(res => { resolveNext = res; });
        },
        return() { close(); return Promise.resolve({ value: undefined, done: true }); }
      };
    }
  };

  return { iterable, push, close, isClosed: () => closed };
}

/** 构造一条 SDKUserMessage（字段依官方类型：type / message / parent_tool_use_id 必填）。 */
function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: String(text == null ? '' : text) },
    parent_tool_use_id: null
  };
}

class ClaudeCodeAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] 缺省取内置 CLAUDE_CODE
   * @param {object} [opts.config]   { runtimeMode, model, permissionMode, allowedTools,
   *                                   disallowedTools, maxTurns, timeoutMs, passthroughEnv,
   *                                   environment, onPermission, acpEnabled, acpCommand,
   *                                   sdkPath, cliPath, includePartialMessages }
   * @param {Function} [opts.sdkLoader]        注入（单测）：() => sdkModule
   * @param {Function} [opts.supervisorFactory] 注入（单测）
   * @param {Function} [opts.acpAdapterFactory] 注入（单测）
   */
  constructor({ manifest, config, sessionPersistence, sdkLoader, supervisorFactory, acpAdapterFactory } = {}) {
    super({ manifest: manifest || CLAUDE_CODE, config });
    const cfg = { ...((manifest || CLAUDE_CODE).config || {}), ...(config || {}) };

    this.runtimeMode = cfg.runtimeMode || RUNTIME_MODE.AUTO;
    this.model = cfg.model || null;
    this.configuredPermissionMode = cfg.permissionMode || null;
    this.allowedTools = Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [];
    this.disallowedTools = Array.isArray(cfg.disallowedTools) ? cfg.disallowedTools : [];
    this.maxTurns = Number(cfg.maxTurns) || null;
    this.timeoutMs = Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.passthroughEnv = Array.isArray(cfg.passthroughEnv) ? cfg.passthroughEnv : [];
    this.environment = cfg.environment || null;
    this.permissionResolver = cfg.onPermission || null;
    this.includePartialMessages = !!cfg.includePartialMessages;
    this.cliCommand = cfg.cliPath || CLI_COMMAND;
    this.sdkPath = cfg.sdkPath || SDK_PACKAGE;
    this.acpEnabled = !!cfg.acpEnabled;
    this.acpCommand = cfg.acpCommand || 'claude-agent-acp';

    this.sessions = createExternalAgentSessionManager({ persistence: sessionPersistence });
    this._sessionPersistence = sessionPersistence || null;
    this.supervisor = (supervisorFactory || createCliProcessSupervisor)();
    this._sdkLoader = sdkLoader || (() => {
      // 可选依赖：Anthropic 商业条款（非 OSS）→ 绝不 vendor，缺包就降级（spec §50 注）
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(this.sdkPath);
    });
    this._acpAdapterFactory = acpAdapterFactory || null;

    this._runs = new Map();
    this._detected = null;
    this._activeRuntime = null;
  }

  getManifest() {
    const caps = RUNTIME_CAPABILITIES[this._activeRuntime] || null;
    if (!caps) return { ...this.manifest };
    return { ...this.manifest, capabilities: { ...this.manifest.capabilities, ...caps } };
  }

  /** 当前生效运行时（'sdk' | 'cli' | 'acp' | null）。 */
  getActiveRuntime() { return this._activeRuntime; }

  /** 探测三条路径的可用性（SDK 包 / claude CLI / claude-agent-acp）。 */
  async detect() {
    if (this._detected) return this._detected;

    let sdkAvailable = false;
    let sdkError = null;
    try {
      const mod = this._sdkLoader();
      sdkAvailable = !!(mod && typeof mod.query === 'function');
      if (!sdkAvailable) sdkError = `${this.sdkPath} 已安装但未导出 query()`;
    } catch (e) {
      sdkError = e && e.message ? e.message : String(e);
    }

    const cli = await this.supervisor.detect(this.cliCommand);
    let version = null;
    if (cli.available) {
      try {
        version = await this.supervisor.readVersion(cli.path, ['--version'], DEFAULT_VERSION_TIMEOUT_MS);
      } catch { version = null; }
    }

    let acpPath = null;
    if (this.acpEnabled || this.runtimeMode === RUNTIME_MODE.ACP) {
      try { acpPath = await resolveCliInPath(this.acpCommand); } catch { acpPath = null; }
    }

    this._detected = {
      available: sdkAvailable || cli.available || !!acpPath,
      sdkAvailable,
      sdkError,
      cliAvailable: cli.available,
      cliPath: cli.path,
      acpAvailable: !!acpPath,
      acpPath,
      version,
      path: cli.path
    };
    return this._detected;
  }

  async healthCheck() {
    const start = Date.now();
    const d = await this.detect();
    if (!d.available) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: `未检测到 ${SDK_PACKAGE}，也未在 PATH 中找到 ${this.cliCommand}`
      };
    }
    const detail = d.sdkAvailable
      ? `Claude Agent SDK 就绪${d.cliAvailable ? '（CLI 亦可用，作为 fallback）' : '（无 CLI fallback）'}`
      : `仅 CLI 可用，将使用 claude -p --output-format stream-json（SDK: ${d.sdkError || '未安装'}）`;
    return {
      status: d.sdkAvailable || d.cliAvailable ? HEALTH_STATE.HEALTHY : HEALTH_STATE.DEGRADED,
      version: d.version,
      latencyMs: Date.now() - start,
      detail
    };
  }

  /**
   * 同步返回当前认证状态（spec §29/§75/§79）。
   *
   * 平台绝不读取 Claude 的凭据文件来“核实”登录态（spec §30/§32），
   * 所以只有两种可判定状态：
   *   - 配置里显式提供了 ANTHROPIC_API_KEY → API_KEY
   *   - 其余一律 UNKNOWN（依赖用户在官方 CLI/SDK 里的登录态）
   * Router 会对 UNKNOWN 保守扣分，避免未登录的 Claude 抢占路由。
   */
  getAuthState() {
    const env = this.environment || {};
    const hasApiKey = !!(env.ANTHROPIC_API_KEY || this.config.apiKey);
    if (hasApiKey) {
      return { state: AUTH_STATE.API_KEY, mode: AUTH_MODE.API_KEY, authenticated: true, detail: '使用 API Key' };
    }
    return {
      state: AUTH_STATE.UNKNOWN,
      mode: AUTH_MODE.EXTERNAL_LOGIN,
      authenticated: false,
      detail: '依赖官方 Claude 登录态（平台不读取凭据，无法核实）'
    };
  }

  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('ClaudeCodeAgentAdapter.startTask: task.goal 必填');
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
      runId, ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      taskText,
      runtime: null,
      query: null,       // SDK Query 对象
      inputQueue: null,  // streaming input 队列
      handle: null,      // CLI ProcessHandle
      sessionId: null,
      delegate: null     // ACP 模式下的 AcpAgentAdapter
    };
    this._runs.set(runId, runState);

    this._emit(context, AGENT_EVENT.RUN_STARTED, { runId, agentId: this.id, goal: taskText });

    this._dispatch(runId, normalizedTask, taskText, context).catch(err => {
      const result = {
        status: 'failed', summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      this._settle(runId, result, context);
    });

    return { runId };
  }

  _emit(context, type, payload) {
    if (context && typeof context.emit === 'function') {
      try { context.emit(type, { type, ...payload }); } catch { /* listener 抛错不得影响 Run */ }
    }
  }

  /**
   * 运行时选路 + 降级（spec §49/§50/§52/§53）。
   * auto 链：sdk → cli；ACP 只在显式开启时参与（且优先于 cli，见 §52）。
   * 显式指定模式时不静默降级 —— 失败就是失败，避免"以为在用 SDK 其实在跑 CLI"。
   */
  async _dispatch(runId, task, taskText, context) {
    const d = await this.detect();
    const mode = this.runtimeMode;
    const wantAuto = mode === RUNTIME_MODE.AUTO;

    if (mode === RUNTIME_MODE.ACP || (wantAuto && this.acpEnabled && d.acpAvailable)) {
      try {
        return await this._runAcp(runId, task, taskText, context, d);
      } catch (err) {
        if (mode === RUNTIME_MODE.ACP) throw err;
        this._emit(context, AGENT_EVENT.FALLBACK, {
          runId, agentId: this.id, from: RUNTIME_MODE.ACP, to: RUNTIME_MODE.SDK,
          reason: 'ACP_UNAVAILABLE', detail: err && err.message
        });
      }
    }

    if (mode === RUNTIME_MODE.SDK || (wantAuto && d.sdkAvailable)) {
      try {
        return await this._runSdk(runId, task, taskText, context);
      } catch (err) {
        if (mode === RUNTIME_MODE.SDK) throw err;
        this._emit(context, AGENT_EVENT.FALLBACK, {
          runId, agentId: this.id, from: RUNTIME_MODE.SDK, to: RUNTIME_MODE.CLI,
          reason: 'SDK_RUN_FAILED', detail: err && err.message
        });
      }
    } else if (wantAuto) {
      // auto 链因为「SDK 没装」而跳过 primary —— 必须留痕。
      // 否则用户会"以为在用 SDK，其实一直在跑能力更弱的 CLI"（无 canUseTool / 无 interrupt）。
      this._emit(context, AGENT_EVENT.FALLBACK, {
        runId, agentId: this.id, from: RUNTIME_MODE.SDK, to: RUNTIME_MODE.CLI,
        reason: 'SDK_NOT_INSTALLED', detail: d.sdkError || null
      });
    }

    if (mode === RUNTIME_MODE.CLI || wantAuto) {
      if (!d.cliAvailable) {
        throw new Error(`Claude 不可用：未安装 ${SDK_PACKAGE}，PATH 中也没有 ${this.cliCommand}`);
      }
      return this._runCli(runId, task, taskText, context, d);
    }

    throw new Error(`未知的 Claude runtimeMode: ${mode}`);
  }

  // ────────────────────────────── SDK（primary） ──────────────────────────────

  async _runSdk(runId, task, taskText, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;

    const sdk = this._sdkLoader();
    if (!sdk || typeof sdk.query !== 'function') {
      throw new Error(`${this.sdkPath} 不可用或未导出 query()`);
    }

    runState.runtime = RUNTIME_MODE.SDK;
    this._activeRuntime = RUNTIME_MODE.SDK;

    const cwd = task.projectRoot || (context && context.projectRoot) || undefined;
    const readOnly = !!task.readOnly;
    const timeoutMs = Number(task.timeoutMs) || this.timeoutMs;

    const mapper = createClaudeEventMapper({
      emit: (type, payload) => this._emit(context, type, payload)
    });

    // streaming input：解锁 interrupt() / setPermissionMode()（官方明确的模式限制）
    const queue = createInputQueue([userMessage(taskText)]);
    runState.inputQueue = queue;

    const stderrTail = [];
    const options = {
      cwd,
      abortController: runState.ac,
      // options.env 会**整体替换**子进程环境 → 正好落实 allowlist 最小化（spec §28）
      env: buildEnvAllowlist(this.passthroughEnv, this.environment || (context && context.env) || {}),
      permissionMode: sanitizePermissionMode(task.permissionMode || this.configuredPermissionMode, readOnly),
      includePartialMessages: this.includePartialMessages,
      stderr: (data) => {
        if (stderrTail.length < 200) stderrTail.push(String(data));
      },
      canUseTool: (toolName, input, opts) =>
        this._decideToolPermission(toolName, input, opts, task, context, runId)
    };
    if (this.model || task.model) options.model = task.model || this.model;
    if (this.maxTurns) options.maxTurns = this.maxTurns;
    if (this.allowedTools.length) options.allowedTools = [...this.allowedTools];
    const denied = readOnly
      ? [...new Set([...this.disallowedTools, ...READONLY_DISALLOWED_TOOLS])]
      : this.disallowedTools;
    if (denied.length) options.disallowedTools = denied;
    const addDirs = Array.isArray(task.additionalDirectories) ? task.additionalDirectories : [];
    if (addDirs.length) options.additionalDirectories = addDirs;
    if (task.resumeSessionId) {
      options.resume = String(task.resumeSessionId);
      if (task.forkSession) options.forkSession = true;
    }

    const q = sdk.query({ prompt: queue.iterable, options });
    runState.query = q;
    runState.status = LIFECYCLE.RUNNING;

    // 超时 ≠ 取消（spec §67）：单独计时，超时后 abort 并打 timeout 标记
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { runState.ac.abort(); } catch { /* noop */ }
    }, timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();

    let terminal = null;
    let iterationError = null;
    try {
      for await (const msg of q) {
        const r = mapper.map(msg, { runId, agentId: this.id });
        if (r && r.sessionId && !runState.sessionId) {
          runState.sessionId = r.sessionId;
          this._registerSession(runId, task, cwd, r.sessionId, 'claude-sdk');
        }
        if (r && r.terminal) { terminal = r.terminal; break; }
      }
    } catch (e) {
      iterationError = e;
    } finally {
      if (timer) clearTimeout(timer);
      queue.close();
      try { q.close(); } catch { /* 已结束 */ }
    }

    const acc = mapper.finalize();
    const errors = [...acc.errors];
    let status;
    if (timedOut) {
      status = 'timeout';
      errors.push(`执行超时（${timeoutMs} ms）`);
    } else if (runState.ac.signal.aborted) {
      status = 'cancelled';
      if (!errors.length) errors.push('用户已停止');
    } else if (terminal === 'completed') {
      status = 'completed';
    } else if (terminal === 'failed') {
      status = 'failed';
    } else {
      // 迭代结束却没拿到 result 消息 → FAILED，绝不当 completed（spec §65）
      status = 'failed';
      errors.push(iterationError
        ? `Claude SDK 执行出错: ${iterationError.message || iterationError}`
        : 'Claude SDK 流结束但未产生 result 消息（协议流不完整）');
      const tail = stderrTail.join('').trim().slice(-2000);
      if (tail) errors.push(`stderr: ${tail}`);
    }

    const result = this._buildResult(status, acc, errors, RUNTIME_MODE.SDK, runState.sessionId);
    if (runState.sessionId) this.sessions.setStatus(runId, status);
    this._settle(runId, result, context);
    return result;
  }

  /**
   * canUseTool 桥接（spec §34/§35/§36）。
   *
   * 官方签名：
   *   (toolName, input, { signal, suggestions, blockedPath, decisionReason,
   *                       toolUseID, agentID, requestId }) => Promise<PermissionResult|null>
   *   PermissionResult = { behavior:'allow', updatedInput? } | { behavior:'deny', message, interrupt? }
   *
   * 顺序：权限交集评估 → 不通过直接 deny；通过再交 GUI；没有 GUI 一律 deny。
   */
  async _decideToolPermission(toolName, input, opts, task, context, runId) {
    const operation = operationForTool(toolName);
    const evaluation = permissionBroker.evaluate(
      { operation, scope: toolName, detail: (opts && opts.decisionReason) || '' },
      {
        parentRunPermission: task.readOnly ? 'read' : 'write',
        platformPolicy: (context && context.allowedScopes) || undefined,
        externalAgentPolicy: (this.manifest && this.manifest.allowedScopes) || undefined
      }
    );

    this._emit(context, AGENT_EVENT.PERMISSION_REQUIRED, {
      runId, agentId: this.id, tool: toolName, operation,
      granted: evaluation.granted, reason: evaluation.reason
    });

    if (!evaluation.granted) {
      return { behavior: 'deny', message: `平台权限策略拒绝：${evaluation.reason || operation}` };
    }

    const resolver = this.permissionResolver || (context && context.onPermission);
    if (typeof resolver !== 'function') {
      // 没有用户在场 → 不放行（spec §36：危险操作不得自动放行）
      return { behavior: 'deny', message: '无可用的审批通道，默认拒绝' };
    }
    try {
      const decision = await resolver({
        kind: classifyTool(toolName), tool: toolName, operation,
        params: input, runId, agentId: this.id,
        toolUseId: opts && opts.toolUseID
      });
      if (decision === true || decision === 'accept' || decision === 'approved' || decision === 'allow') {
        return { behavior: 'allow' };
      }
      if (decision && typeof decision === 'object' && decision.behavior) return decision;
      return { behavior: 'deny', message: '用户拒绝了该操作' };
    } catch (e) {
      return { behavior: 'deny', message: `审批失败，默认拒绝: ${e && e.message}` };
    }
  }

  // ────────────────────────────── CLI stream-json（fallback） ──────────────────────────────

  async _runCli(runId, task, taskText, context, detected) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.runtime = RUNTIME_MODE.CLI;
    this._activeRuntime = RUNTIME_MODE.CLI;
    runState.status = LIFECYCLE.RUNNING;

    const cwd = task.projectRoot || (context && context.projectRoot) || undefined;
    const readOnly = !!task.readOnly;
    const timeoutMs = Number(task.timeoutMs) || this.timeoutMs;

    const mapper = createClaudeEventMapper({
      emit: (type, payload) => this._emit(context, type, payload)
    });
    const decoder = createStructuredStreamDecoder({});
    const protocolErrors = [];
    let terminal = null;

    decoder.on('message', msg => {
      const r = mapper.map(msg, { runId, agentId: this.id });
      if (r && r.sessionId && !runState.sessionId) {
        runState.sessionId = r.sessionId;
        this._registerSession(runId, task, cwd, r.sessionId, 'claude-cli');
      }
      if (r && r.terminal) terminal = r.terminal;
    });
    decoder.on('malformed', info => {
      protocolErrors.push(`畸形事件（${info.error}）: ${String(info.preview || '').slice(0, 120)}`);
    });
    decoder.on('error', info => { protocolErrors.push(`协议流损坏: ${info.reason}`); });

    const denied = readOnly
      ? [...new Set([...this.disallowedTools, ...READONLY_DISALLOWED_TOOLS])]
      : this.disallowedTools;

    const args = buildCliArgs({
      model: task.model || this.model,
      permissionMode: sanitizePermissionMode(task.permissionMode || this.configuredPermissionMode, readOnly),
      allowedTools: this.allowedTools,
      disallowedTools: denied,
      maxTurns: this.maxTurns,
      addDirs: Array.isArray(task.additionalDirectories) ? task.additionalDirectories : [],
      resumeSessionId: task.resumeSessionId || null,
      forkSession: !!task.forkSession,
      includePartialMessages: this.includePartialMessages
    });

    const handle = await this.supervisor.spawnProcess({
      command: detected.cliPath || this.cliCommand,
      args,
      cwd,
      env: buildEnvAllowlist(this.passthroughEnv, this.environment || (context && context.env) || {}),
      timeoutMs,
      signal: runState.ac.signal,
      captureOutput: false // stdout 是 JSONL 协议流，交给 decoder 增量消费
    });
    runState.handle = handle;

    if (handle.child.stdout) handle.child.stdout.on('data', chunk => decoder.push(chunk));
    // prompt 走 stdin；必须 end()，否则 claude -p 会一直等输入（见上游 CHANGELOG）
    try {
      if (handle.child.stdin) {
        handle.child.stdin.write(String(taskText || ''));
        handle.child.stdin.end();
      }
    } catch { /* stdin 已关闭：由退出码路径兜底 */ }

    const exit = await handle.done;
    try { decoder.flush(); } catch { /* noop */ }

    const acc = mapper.finalize();
    const errors = [...acc.errors, ...protocolErrors];
    let status;
    if (exit.aborted || runState.ac.signal.aborted) {
      status = 'cancelled';
      if (!errors.length) errors.push('用户已停止');
    } else if (exit.timedOut) {
      status = 'timeout';
      errors.push(`执行超时（${timeoutMs} ms）`);
    } else if (terminal === 'completed') {
      status = 'completed';
    } else if (terminal === 'failed') {
      status = 'failed';
    } else {
      status = 'failed';
      errors.push(exit.error
        ? `进程错误: ${exit.error}`
        : exit.code === 0
          ? 'claude -p 退出但未产生 result 消息（协议流不完整）'
          : `claude -p 异常退出（exit=${exit.code}${exit.signal ? `, signal=${exit.signal}` : ''}）`);
      const tail = String(handle.stderr || '').trim().slice(-2000);
      if (tail) errors.push(`stderr: ${tail}`);
    }

    const result = this._buildResult(status, acc, errors, RUNTIME_MODE.CLI, runState.sessionId);
    result.exitCode = exit.code != null ? exit.code : null;
    if (runState.sessionId) this.sessions.setStatus(runId, status);
    this._settle(runId, result, context);
    return result;
  }

  // ────────────────────────────── ACP（可选，委派通用适配器） ──────────────────────────────

  /**
   * spec §52：claude-agent-acp 成熟且 Apache-2.0，可作为 ACP runtime mode。
   * 但它本身是"Claude Agent SDK 外面套 ACP"，因此这里**不重复实现 ACP**，
   * 直接委派给通用 AcpAgentAdapter（spec §55/§63：禁止重复造轮子）。
   */
  async _runAcp(runId, task, taskText, context, detected) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.runtime = RUNTIME_MODE.ACP;
    this._activeRuntime = RUNTIME_MODE.ACP;

    const factory = this._acpAdapterFactory || (opts => {
      // 延迟 require，避免 ACP 未启用时把整条 ACP 链拉进内存
      // eslint-disable-next-line global-require
      const { AcpAgentAdapter } = require('./acpAgentAdapter');
      return new AcpAgentAdapter(opts);
    });

    const delegate = factory({
      // 保持同一个 agentId：委派适配器直接对上层 context 发事件，
      // 若换 id 会让 Hub 收到未注册 Agent 的事件（spec §51：内部契约必须一致）。
      manifest: { ...this.manifest, transport: 'acp' },
      sessionPersistence: this._sessionPersistence,
      config: {
        command: detected.acpPath || this.acpCommand,
        args: [],
        cwdMode: 'projectRoot',
        timeoutMs: this.timeoutMs,
        passthroughEnv: this.passthroughEnv,
        environment: this.environment,
        onPermission: this.permissionResolver
      }
    });
    runState.delegate = delegate;

    // 直接透传上层 context：事件 / 权限 / finishRun 都由委派适配器发出，
    // 避免二次归一化造成"终态发两次"（spec §64）。
    runState._settled = true;
    const { runId: delegateRunId } = await delegate.startTask(task, context);
    runState.delegateRunId = delegateRunId;
    runState.status = LIFECYCLE.RUNNING;

    // 轮询委派 Run 的终态，回填到本适配器的 run 记录（供 getStatus/getResult 查询）
    const poll = async () => {
      const st = await delegate.getStatus(delegateRunId);
      runState.status = st.status;
      runState.sessionId = st.sessionId || runState.sessionId;
      if ([LIFECYCLE.COMPLETED, LIFECYCLE.FAILED, LIFECYCLE.CANCELLED, LIFECYCLE.TIMEOUT].includes(st.status)) {
        runState.result = await delegate.getResult(delegateRunId);
        if (runState.result) runState.result.runtime = RUNTIME_MODE.ACP;
        return;
      }
      setTimeout(poll, 500).unref?.();
    };
    poll().catch(() => { /* 委派适配器自己会发失败事件 */ });
    return { status: 'running', runtime: RUNTIME_MODE.ACP };
  }

  // ────────────────────────────── 公共部分 ──────────────────────────────

  _registerSession(runId, task, cwd, sessionId, transport) {
    if (task.resumeSessionId && task.resumeSessionId === sessionId) {
      this.sessions.linkRun(runId, this.id, sessionId);
      return;
    }
    this.sessions.create({
      agentId: this.id,
      externalSessionId: sessionId,
      projectId: task.projectId || null,
      projectRoot: cwd || null,
      parentRunId: runId,
      transport,
      resumable: true
    });
  }

  _buildResult(status, acc, errors, runtime, sessionId) {
    return {
      status,
      summary: acc.summary,
      findings: [],
      changedFiles: acc.changedFiles,
      readFiles: acc.readFiles,
      plan: acc.plan,
      usage: acc.usage,
      totalCostUsd: acc.totalCostUsd,
      numTurns: acc.numTurns,
      model: acc.model,
      permissionDenials: acc.permissionDenials,
      artifacts: [],
      errors,
      sessionId: sessionId || acc.sessionId || null,
      runtime
    };
  }

  /** 统一收尾（终态只发一次，spec §64）。 */
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

  /**
   * 运行中追加消息。
   * 只有 SDK 的 streaming input 模式支持（CLI 一次性 -p 无法中途插话）。
   */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    if (run.runtime === RUNTIME_MODE.ACP && run.delegate) {
      if (typeof run.delegate.sendMessage === 'function') {
        return run.delegate.sendMessage(run.delegateRunId, message);
      }
      return { ok: false, error: 'ACP 委派适配器不支持追加消息' };
    }
    if (run.runtime !== RUNTIME_MODE.SDK || !run.inputQueue) {
      return { ok: false, error: `claude ${run.runtime || 'cli'} 运行时不支持运行中追加消息` };
    }
    const pushed = run.inputQueue.push(userMessage(message));
    return pushed ? { ok: true } : { ok: false, error: '输入流已关闭' };
  }

  /** 切换权限模式（仅 SDK streaming input 可用；白名单外一律拒绝）。 */
  async setPermissionMode(runId, mode) {
    const run = this._runs.get(runId);
    if (!run || run.runtime !== RUNTIME_MODE.SDK || !run.query) {
      return { ok: false, error: '仅 SDK 运行时支持运行中切换权限模式' };
    }
    if (!ALLOWED_PERMISSION_MODES.has(mode)) {
      return { ok: false, error: `权限模式 ${mode} 不在平台白名单内（禁止 bypassPermissions）` };
    }
    try { await run.query.setPermissionMode(mode); return { ok: true }; }
    catch (e) { return { ok: false, error: e && e.message }; }
  }

  /**
   * 取消（spec §66/§106）：先协议级中断，再回收**本 Run 自己拉起的**进程。
   * 绝不按进程名遍历杀 claude —— 用户自己开的 CLI 不能被误伤。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };

    if (run.runtime === RUNTIME_MODE.ACP && run.delegate) {
      try { await run.delegate.cancel(run.delegateRunId); } catch { /* noop */ }
      run.status = LIFECYCLE.CANCELLED;
      return { ok: true };
    }

    if (run.runtime === RUNTIME_MODE.SDK && run.query) {
      try { await run.query.interrupt(); } catch { /* 继续强制回收 */ }
      await new Promise(r => setTimeout(r, 300)); // grace period
    }
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.inputQueue) { try { run.inputQueue.close(); } catch { /* noop */ } }
    if (run.query) { try { run.query.close(); } catch { /* noop */ } }
    if (run.handle && !run.handle._finished) { try { run.handle.kill('SIGKILL'); } catch { /* noop */ } }

    if (![LIFECYCLE.COMPLETED, LIFECYCLE.FAILED, LIFECYCLE.CANCELLED, LIFECYCLE.TIMEOUT].includes(run.status)) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
      startedAt: run.startedAt,
      runtime: run.runtime,
      sessionId: run.sessionId || null
    };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  async dispose() {
    for (const [, run] of this._runs) {
      try {
        if (run.status === LIFECYCLE.RUNNING || run.status === LIFECYCLE.STARTING) run.ac.abort();
      } catch { /* non-fatal */ }
      if (run.inputQueue) { try { run.inputQueue.close(); } catch { /* noop */ } }
      if (run.query) { try { run.query.close(); } catch { /* noop */ } }
      if (run.handle && !run.handle._finished) { try { run.handle.kill('SIGKILL'); } catch { /* noop */ } }
      if (run.delegate) { try { await run.delegate.dispose(); } catch { /* noop */ } }
    }
    this._runs.clear();
    this._detected = null;
    this._activeRuntime = null;
    this.sessions.clear();
    try { this.supervisor.dispose(); } catch { /* noop */ }
  }
}

module.exports = {
  ClaudeCodeAgentAdapter,
  RUNTIME_MODE,
  RUNTIME_CAPABILITIES,
  buildCliArgs,
  createInputQueue,
  sanitizePermissionMode,
  operationForTool,
  READONLY_DISALLOWED_TOOLS
};
