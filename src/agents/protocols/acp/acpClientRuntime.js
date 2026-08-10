'use strict';
/**
 * v2.8.0 — ACP 客户端运行时（spec §21/§22/§23/§24/§39/§40/§42/§46/§47/§48/§65/§66/§67）。
 *
 * AcpClientRuntime 是"通用外部 Agent 通信层"的核心：把任意 ACP 兼容 Agent
 * （codex-acp / claude-agent-acp / 未来）统一接入 AgentHub。
 *
 * 职责：
 *   spawn/connect → initialize（握手 + 协议协商 + 能力协商）→ 鉴权（如需）
 *   → new session / resume session → send prompt（流式 session/update → 统一事件）
 *   → permission bridge（session/request_permission → 平台权限代理 → GUI/自动决策）
 *   → receive updates → cancel → shutdown
 *
 * ── 协议基线：ACP wire v1（取证见 constants.js 头注释）────────────────
 * 关键 v1 语义，全部按 schema 逐字实现，不得凭猜测改动：
 *   1. initialize 发 { protocolVersion, clientCapabilities, clientInfo }，
 *      收 { protocolVersion, agentCapabilities, authMethods, agentInfo }。
 *   2. session/new 只发 { cwd, mcpServers, additionalDirectories? }；
 *      **sessionId 由 Agent 生成并在 NewSessionResponse 返回**，客户端不得自造。
 *   3. session/prompt 的 prompt 是 **ContentBlock[]**，不是字符串。
 *   4. session/cancel 是 **通知（CancelNotification）**，不是请求 —— 当请求发会永久挂起。
 *      取消时客户端**必须**把所有挂起的 session/request_permission 以 cancelled 回掉。
 *   5. 终态取自 PromptResponse.stopReason（必填枚举，5 个值）。
 *
 * 所有 method / sessionUpdate 名称来自 src/agents/protocols/acp/constants.js（实时 schema）。
 * 不在此硬编码 protocol 细节；传输层见 acpProcessTransport，JSON-RPC 见 acpTransport。
 */

const { createAcpProcessTransport } = require('./acpProcessTransport');
// 注：修订前此处写的是 '../session/externalAgentSessionManager'（少一级），
// 从 src/agents/protocols/acp/ 解析会指向不存在的 src/agents/protocols/session/。
const { createExternalAgentSessionManager } = require('../../session/externalAgentSessionManager');
const { createExternalAgentAuthBroker } = require('./authBroker');
const { createAcpEventMapper } = require('./eventMapper');
const { extractAcpCapabilityFlags, checkExpectedAcpCapabilities } = require('./capabilityMapper');
const {
  mapAcpPermissionRequest,
  evaluate,
  buildResponse,
  buildCancelledResponse
} = require('./permissionBroker');
const {
  METHOD,
  NOTIFICATION,
  CLIENT_METHOD,
  STOP_REASON,
  SUPPORTED_PROTOCOL_VERSION,
  MAX_SUPPORTED_PROTOCOL_VERSION
} = require('./constants');
const { AcpError, ACP_ERROR, JSONRPC_ERROR_CODE } = require('./errors');

const CLIENT_NAME = 'Agent Dev Platform';
const CLIENT_VERSION = '2.8.0';

/**
 * 把平台的 message 归一为 ACP v1 ContentBlock[]。
 * 接受 string（最常见）、单个 ContentBlock、或已经是 ContentBlock[]。
 * baseline 只保证 text / resource_link 被 Agent 支持（PromptCapabilities 文档），
 * 其余类型由调用方在确认能力后自行构造。
 */
function toContentBlocks(message) {
  if (message == null) return [];
  if (typeof message === 'string') {
    return message ? [{ type: 'text', text: message }] : [];
  }
  if (Array.isArray(message)) {
    return message
      .map(m => (typeof m === 'string' ? { type: 'text', text: m } : m))
      .filter(m => m && typeof m === 'object' && typeof m.type === 'string');
  }
  if (typeof message === 'object' && typeof message.type === 'string') return [message];
  return [];
}

/**
 * 依据 v1 StopReason 判定 Run 终态。
 * stopReason 在 PromptResponse 里是**必填**；缺失即协议违规 → failed。
 */
function classifyStopReason(stopReason) {
  switch (stopReason) {
    case STOP_REASON.END_TURN:
      return { status: 'completed', ok: true, errors: [] };
    case STOP_REASON.MAX_TOKENS:
      return { status: 'completed', ok: true, truncated: true, errors: [] };
    case STOP_REASON.MAX_TURN_REQUESTS:
      return { status: 'completed', ok: true, truncated: true, errors: [] };
    case STOP_REASON.REFUSAL:
      // 模型明确拒绝：不是崩溃，但这次 Run 没有产出，ok=false 让上层能感知。
      return { status: 'completed', ok: false, errors: ['agent refused the request (stopReason=refusal)'] };
    case STOP_REASON.CANCELLED:
      return { status: 'cancelled', ok: false, errors: [] };
    default:
      if (stopReason === undefined || stopReason === null) {
        return { status: 'failed', ok: false, errors: ['protocol violation: PromptResponse.stopReason is required'] };
      }
      return { status: 'completed', ok: false, errors: ['unknown stopReason: ' + String(stopReason)] };
  }
}

/**
 * 创建 ACP 客户端运行时。
 * @param {object} [opts]
 * @param {Function} [opts.transportFactory] (connectOpts) => Promise<transportHandle>
 * @param {object} [opts.sessionManager]
 * @param {Function} [opts.authBrokerFactory]
 */
function createAcpClientRuntime({ transportFactory, sessionManager, authBrokerFactory } = {}) {
  const connectImpl = transportFactory || ((connectOpts) => createAcpProcessTransport({}).connect(connectOpts));
  const sessionMgr = sessionManager || createExternalAgentSessionManager();
  const authBroker = (authBrokerFactory || createExternalAgentAuthBroker)();

  let transport = null;
  let handshake = null;
  let agentId = null;
  let projectRootHint = null;

  // 当前 Run 上下文（事件 + 权限路由）
  // { runId, agentId, eventMapper, permissionContext, permissionResolver, cancelled, pendingPermissions:Set }
  let currentRunCtx = null;

  function buildAgentResult(promptResult, finalized, meta) {
    const stopReason = promptResult ? promptResult.stopReason : undefined;
    const verdict = classifyStopReason(stopReason);

    return {
      ok: verdict.ok,
      agentId: meta.agentId,
      runId: meta.runId,
      sessionId: meta.sessionId,
      status: verdict.status,
      stopReason: stopReason ?? null,
      truncated: !!verdict.truncated,
      // v1 PromptResponse 无文本字段，摘要来自 agent_message_chunk 累积。
      summary: (finalized.assistantText || '').slice(0, 4000),
      findings: [],
      changedFiles: finalized.changedFiles || [],
      readFiles: finalized.readFiles || [],
      plan: finalized.plan || null,
      toolCalls: finalized.toolCalls || [],
      diff: null,
      artifacts: [],
      usage: finalized.usage || null,
      errors: verdict.errors,
      durationMs: meta.durationMs || null,
      provenance: {
        agent: meta.agentId,
        transport: 'acp',
        protocolVersion: handshake ? handshake.protocolVersion : null,
        externalVersion: handshake && handshake.agentInfo ? handshake.agentInfo.version : null,
        externalName: handshake && handshake.agentInfo ? handshake.agentInfo.name : null,
        sessionId: meta.sessionId
      }
    };
  }

  /** 处理 agent 发来的 session/request_permission（client 侧 method）。 */
  async function handlePermissionRequest(params, rpc) {
    const ctxAtEntry = currentRunCtx;
    const token = { respond: (payload) => rpc.respond(payload), done: false };
    if (ctxAtEntry) ctxAtEntry.pendingPermissions.add(token);

    const settle = (payload) => {
      if (token.done) return;
      token.done = true;
      if (ctxAtEntry) ctxAtEntry.pendingPermissions.delete(token);
      rpc.respond(payload);
    };

    try {
      // 已经取消的回合：直接按协议要求回 cancelled（schema RequestPermissionOutcome 原文：
      // "When a client sends a session/cancel notification ... it MUST respond to all
      //  pending session/request_permission requests with this Cancelled outcome."）
      if (ctxAtEntry && ctxAtEntry.cancelled) {
        settle(buildCancelledResponse());
        return;
      }

      const req = mapAcpPermissionRequest(params, { projectRoot: projectRootHint });
      const permCtx = (ctxAtEntry && ctxAtEntry.permissionContext) || {};
      const evaluation = evaluate(req, permCtx);

      let granted = evaluation.granted;
      let cancelled = false;

      // 交集判定通过 ≠ 自动放行危险操作（§36）：只要注册了 resolver，
      // 就把决定权交给 GUI；resolver 缺席时才用交集结论，且默认拒绝。
      const resolver = ctxAtEntry && ctxAtEntry.permissionResolver;
      if (typeof resolver === 'function') {
        const decision = await resolver({ ...req, evaluation });
        if (decision && decision.cancelled) cancelled = true;
        else granted = !!(decision && decision.granted);
      } else if (!evaluation.granted) {
        granted = false; // 默认拒绝（只读父 Run / 策略拒绝已在交集里判定）
      }

      // resolver 返回期间可能已被取消 → 仍按协议回 cancelled
      if (cancelled || (ctxAtEntry && ctxAtEntry.cancelled)) {
        settle(buildCancelledResponse());
        return;
      }

      const { response, selected } = buildResponse({ granted, options: req.options });
      if (granted && selected && selected.fallback) {
        // Agent 没给任何 allow 选项：我们只能选 reject，记录下来便于排障。
        granted = false;
      }
      settle(response);
    } catch (e) {
      if (!token.done) {
        token.done = true;
        if (ctxAtEntry) ctxAtEntry.pendingPermissions.delete(token);
        try {
          rpc.respondError(JSONRPC_ERROR_CODE.INTERNAL_ERROR, (e && e.message) || 'permission handling error');
        } catch { /* stream closed */ }
      }
    }
  }

  /**
   * 连接并握手。
   * @param {object} connectOpts { command, args, cwd, env, timeoutMs, frameLimitBytes, agentId,
   *                               expectedCapabilities, clientCapabilities }
   */
  async function connect(connectOpts = {}) {
    transport = await connectImpl(connectOpts);
    agentId = connectOpts.agentId || null;
    projectRootHint = connectOpts.cwd || null;

    // 注册一次性的通知 / 请求处理（按当前 Run 上下文路由）
    transport.onNotification(CLIENT_METHOD.SESSION_UPDATE, (params) => {
      if (!currentRunCtx) return;
      const upd = params && params.update;
      if (upd) {
        currentRunCtx.eventMapper.map(upd, {
          runId: currentRunCtx.runId,
          agentId: currentRunCtx.agentId,
          sessionId: params.sessionId
        });
      }
    });
    transport.onRequest(CLIENT_METHOD.SESSION_REQUEST_PERMISSION, handlePermissionRequest);

    /**
     * clientCapabilities 必须**诚实**：本运行时目前未实现 fs/* 与 terminal/*
     * 这些 client 侧 method，声明 true 会诱导 Agent 调用我们答不出的方法
     * （直接 METHOD_NOT_FOUND，反而更糟）。默认全 false，由 Adapter 在实现后显式开启。
     */
    const clientCapabilities = connectOpts.clientCapabilities || {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false
    };

    const result = await transport.request(METHOD.INITIALIZE, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
    }) || {};

    const negotiated = result.protocolVersion;
    if (typeof negotiated !== 'number' || !Number.isInteger(negotiated) || negotiated < 1) {
      throw new AcpError(
        ACP_ERROR.PROTOCOL_UNSUPPORTED,
        `agent returned invalid protocolVersion: ${JSON.stringify(negotiated)}`
      );
    }
    if (negotiated > MAX_SUPPORTED_PROTOCOL_VERSION) {
      // 上游要求：客户端不支持该版本时应断开，而不是继续用旧形状硬发。
      throw new AcpError(
        ACP_ERROR.PROTOCOL_UNSUPPORTED,
        `negotiated protocolVersion ${negotiated} exceeds client max ${MAX_SUPPORTED_PROTOCOL_VERSION}`
      );
    }

    const agentCapabilities = result.agentCapabilities || {};
    const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
    const acpFlags = extractAcpCapabilityFlags(agentCapabilities, authMethods);

    // 注意：v1 把 session/new + session/prompt + session/cancel + session/update 定为
    // baseline（不在 capabilities 里体现），因此这里**不能**再检查"是否声明 session 能力"。
    if (connectOpts.expectedCapabilities) {
      const { ok, missing } = checkExpectedAcpCapabilities(connectOpts.expectedCapabilities, acpFlags);
      if (!ok) {
        throw new AcpError(
          ACP_ERROR.CAPABILITY_NEGOTIATION_FAILED,
          'missing expected ACP capabilities: ' + missing.join(',')
        );
      }
    }

    authBroker.initFromHandshake(authMethods);
    handshake = {
      protocolVersion: negotiated,
      agentCapabilities,
      authMethods,
      acpFlags,
      agentInfo: result.agentInfo || null,
      clientCapabilities
    };
    return handshake;
  }

  function getHandshake() { return handshake; }
  function getAuthBroker() { return authBroker; }
  function getSessionManager() { return sessionMgr; }
  function isConnected() { return !!transport; }

  /**
   * 若 Agent 需要登录，触发官方 auth flow（实际交互在 Agent 进程内完成）。
   * v1 的 method 是 `authenticate`，参数是 { methodId }（不是 v2 的 auth/login）。
   * 绝不在此读取、转存或转发任何凭据（spec §30/§31/§32）。
   */
  async function authenticate(methodId, opts = {}) {
    if (!transport) throw new AcpError(ACP_ERROR.HANDSHAKE_FAILED, 'not connected');
    if (!handshake || !handshake.authMethods.length) return { ok: true, required: false };
    const chosen = methodId || (handshake.authMethods[0] && handshake.authMethods[0].id) || handshake.authMethods[0];
    const result = await transport.request(METHOD.AUTHENTICATE, { methodId: chosen, ...opts });
    authBroker.markAuthenticated(chosen, 'external_login');
    return { ok: true, required: true, result };
  }

  /**
   * 创建或恢复一个 Session。
   * v1：sessionId 由 Agent 生成，客户端从 NewSessionResponse 读取。
   * @returns {Promise<{ externalSessionId:string, record:object, resumed:boolean, modes:object|null, configOptions:Array|null }>}
   */
  async function createSession({
    projectRoot,
    additionalDirectories,
    mcpServers,
    resumeSessionId,
    parentRunId,
    projectId
  } = {}) {
    if (!transport) throw new AcpError(ACP_ERROR.HANDSHAKE_FAILED, 'not connected');
    if (!projectRoot) {
      throw new AcpError(ACP_ERROR.SESSION_CREATE_FAILED, 'projectRoot (cwd) is required and must be an absolute path');
    }

    const flags = (handshake && handshake.acpFlags) || {};
    const params = {
      cwd: projectRoot,
      // schema：mcpServers 在 NewSessionRequest 中是 **required**，无 MCP 时传空数组。
      mcpServers: Array.isArray(mcpServers) ? mcpServers : []
    };
    // additionalDirectories 是可选扩展，Agent 未声明支持时不发（避免未知字段）。
    if (Array.isArray(additionalDirectories) && additionalDirectories.length && flags.additionalDirectories) {
      params.additionalDirectories = additionalDirectories;
    }

    let externalSessionId;
    let resumed = false;
    let response;

    if (resumeSessionId) {
      if (!flags.resume) {
        throw new AcpError(ACP_ERROR.RESUME_UNSUPPORTED, 'agent does not advertise session/resume capability');
      }
      // ResumeSessionRequest 必填 { sessionId, cwd }
      response = await transport.request(METHOD.SESSION_RESUME, { ...params, sessionId: resumeSessionId }) || {};
      externalSessionId = resumeSessionId;
      resumed = true;
    } else {
      response = await transport.request(METHOD.SESSION_NEW, params) || {};
      externalSessionId = response.sessionId;
      if (typeof externalSessionId !== 'string' || !externalSessionId) {
        throw new AcpError(
          ACP_ERROR.SESSION_CREATE_FAILED,
          'agent did not return a sessionId in NewSessionResponse'
        );
      }
    }

    const record = sessionMgr.create({
      agentId,
      externalSessionId,
      projectId: projectId || null,
      projectRoot: projectRoot || null,
      parentRunId: parentRunId || null,
      resumable: !!flags.resume,
      transport: 'acp'
    });
    if (parentRunId) sessionMgr.linkRun(parentRunId, agentId, externalSessionId);

    return {
      externalSessionId,
      record,
      resumed,
      modes: response.modes || null,
      configOptions: response.configOptions || null
    };
  }

  /**
   * 发送一次 prompt（一个 Run）。流式 session/update 经 eventMapper → onEvent。
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.runId
   * @param {string} p.agentId
   * @param {string|object|Array} p.message 字符串或 ContentBlock([])
   * @param {object} [p.context] { timeoutMs, parentRunPermission, platformPolicy, externalAgentPolicy }
   * @param {Function} [p.onEvent] (type, payload) => void
   * @param {Function} [p.onPermission] (request) => Promise<{granted, cancelled}>  弹 GUI 时用
   * @returns {Promise<object>} AgentResult
   */
  async function prompt({ sessionId, runId, agentId: aid, message, context = {}, onEvent, onPermission } = {}) {
    if (!transport) throw new AcpError(ACP_ERROR.HANDSHAKE_FAILED, 'not connected');
    const promptBlocks = toContentBlocks(message);
    if (!promptBlocks.length) {
      throw new AcpError(ACP_ERROR.PROMPT_FAILED, 'prompt must contain at least one ContentBlock');
    }

    const eventMapper = createAcpEventMapper({
      emit: (type, payload) => { if (typeof onEvent === 'function') onEvent(type, payload); }
    });
    const runCtx = {
      runId,
      agentId: aid,
      sessionId,
      eventMapper,
      permissionContext: {
        parentRunPermission: context.parentRunPermission || 'write',
        platformPolicy: context.platformPolicy,
        externalAgentPolicy: context.externalAgentPolicy
      },
      permissionResolver: onPermission,
      cancelled: false,
      pendingPermissions: new Set()
    };
    currentRunCtx = runCtx;

    const startedAt = Date.now();
    let promptResult;
    try {
      promptResult = await transport.request(
        METHOD.SESSION_PROMPT,
        { sessionId, prompt: promptBlocks },
        { timeoutMs: context.timeoutMs || 600000 }
      );
    } finally {
      // 无论成败都要清理挂起的权限请求，避免 Agent 侧永久等待。
      flushPendingPermissions(runCtx);
      if (currentRunCtx === runCtx) currentRunCtx = null;
    }

    const finalized = eventMapper.finalize();
    return buildAgentResult(promptResult, finalized, {
      agentId: aid,
      runId,
      sessionId,
      durationMs: Date.now() - startedAt
    });
  }

  /** 把某个 Run 上下文里所有挂起的权限请求以 cancelled 回掉（协议强制要求）。 */
  function flushPendingPermissions(runCtx) {
    if (!runCtx || !runCtx.pendingPermissions.size) return;
    for (const token of [...runCtx.pendingPermissions]) {
      if (token.done) continue;
      token.done = true;
      try { token.respond(buildCancelledResponse()); } catch { /* stream closed */ }
    }
    runCtx.pendingPermissions.clear();
  }

  /**
   * 取消一个 Run 对应的 Session 前台工作（spec §66）。
   *
   * v1 的 session/cancel 是**通知**：发完立即返回，Agent 随后会以
   * stopReason='cancelled' 结束那次 session/prompt。发成请求会永久挂起。
   * 同时必须把所有挂起的 request_permission 回成 cancelled，否则 Agent 卡在等审批。
   */
  async function cancel({ sessionId } = {}) {
    if (!transport) return { ok: false, reason: 'not connected' };
    const runCtx = currentRunCtx;
    if (runCtx && (!sessionId || runCtx.sessionId === sessionId)) {
      runCtx.cancelled = true;
    }
    try {
      transport.notify(NOTIFICATION.SESSION_CANCEL, { sessionId });
    } catch {
      return { ok: false, reason: 'notify failed' };
    }
    if (runCtx) flushPendingPermissions(runCtx);
    return { ok: true };
  }

  /** 当前 Run 是否已被显式取消（供 Adapter 区分 CANCELLED / FAILED）。 */
  function isCancelled() {
    return !!(currentRunCtx && currentRunCtx.cancelled);
  }

  /** 关闭一个 Session。Agent 未声明 close 能力时跳过。 */
  async function closeSession(sessionId) {
    if (!transport || !sessionId) return;
    const flags = (handshake && handshake.acpFlags) || {};
    if (!flags.close) return;
    try { await transport.request(METHOD.SESSION_CLOSE, { sessionId }, { timeoutMs: 5000 }); } catch { /* ignore */ }
  }

  /** 断开并回收进程（spec §27/§65/§68）。 */
  function disconnect() {
    if (currentRunCtx) flushPendingPermissions(currentRunCtx);
    if (transport) {
      try { transport.dispose(); } catch { /* noop */ }
    }
    transport = null;
    handshake = null;
    currentRunCtx = null;
    projectRootHint = null;
  }

  return {
    connect,
    getHandshake,
    getAuthBroker,
    getSessionManager,
    isConnected,
    isCancelled,
    authenticate,
    createSession,
    prompt,
    cancel,
    closeSession,
    disconnect
  };
}

// 注：修订前这里导出了 `buildAgentResult`，但该函数定义在工厂闭包内部，
// 模块顶层引用它会直接抛 ReferenceError —— 等于整个 ACP 运行时无法被 require。
// 现改为只导出真正位于模块作用域的纯函数。
module.exports = { createAcpClientRuntime, toContentBlocks, classifyStopReason };
