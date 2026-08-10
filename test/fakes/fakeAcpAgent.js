'use strict';
/**
 * v2.8.0 — 假 ACP Agent（spec §57：必须有 fake ACP agent 用于确定性测试）。
 *
 * ── 本文件的价值在于"严格"，不在于"能跑通"────────────────────────────
 * 如果 fake 也按我们客户端的猜测形状回话，那测试只能证明"我们和自己一致"，
 * 证明不了"我们和真实 Agent 一致"。所以这里逐字实现 ACP **wire v1**
 * （schema/v1/schema.json），并对客户端的每一处协议违规**记录 violation**：
 *
 *   1. initialize      → 回 { protocolVersion, agentCapabilities, authMethods, agentInfo }
 *                        （不是 v2 的 capabilities/info）
 *   2. session/new     → **由 Agent 生成 sessionId** 并在响应里返回；
 *                        客户端若自带 sessionId 即记违规
 *   3. session/prompt  → params.prompt 必须是 **ContentBlock[]**；字符串即违规
 *   4. session/cancel  → **通知**（无 id）。客户端当请求发（带 id）即违规
 *   5. request_permission → params 用 **toolCall**（ToolCallUpdate），
 *                        响应必须是嵌套信封 {outcome:{outcome:'selected'|'cancelled', optionId?}}
 *   6. PromptResponse  → 只有 **stopReason**（5 个枚举值），没有任何文本字段
 *
 * 两种使用模式：
 *
 *  A) 进程内模式（快，用于 transport / runtime 层单测）
 *       const { spawnImpl, killTreeImpl, resolveImpl, lastChild } = createFakeAcpAgent({...});
 *       const sup = createCliProcessSupervisor({ spawnImpl, killTreeImpl, resolveImpl });
 *
 *  B) 真子进程模式（用于 AcpAgentAdapter 端到端，走真实 spawn/stdio/分帧）
 *       node test/fakes/fakeAcpAgent.js        // 配置来自 env FAKE_ACP_CONFIG（JSON）
 *
 * 所有行为均可配置，保证测试确定性（无随机、无网络、无真实文件写入）。
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const {
  METHOD,
  NOTIFICATION,
  CLIENT_METHOD,
  SESSION_UPDATE,
  TOOL_KIND,
  TOOL_CALL_STATUS,
  STOP_REASON,
  PERMISSION_OPTION_KIND,
  PERMISSION_OUTCOME,
  PROTOCOL_VERSION,
  JSONRPC
} = require('../../src/agents/protocols/acp/constants');

const RPC = { INVALID_PARAMS: -32602, METHOD_NOT_FOUND: -32601 };

/** 默认的一段"干了点活"的 session/update 脚本（全部为 v1 形状）。 */
const DEFAULT_UPDATES = [
  {
    sessionUpdate: SESSION_UPDATE.AGENT_THOUGHT_CHUNK,
    content: { type: 'text', text: '先看一下现有实现' }
  },
  {
    sessionUpdate: SESSION_UPDATE.PLAN,
    entries: [
      { content: '定位需要修改的文件', priority: 'high', status: 'in_progress' },
      { content: '写入修改', priority: 'medium', status: 'pending' }
    ]
  },
  {
    sessionUpdate: SESSION_UPDATE.AGENT_MESSAGE_CHUNK,
    content: { type: 'text', text: '准备修改文件。' }
  },
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL,
    toolCallId: 'tool-1',
    title: 'Write src/demo.js',
    kind: TOOL_KIND.EDIT,
    status: TOOL_CALL_STATUS.PENDING,
    locations: [{ path: 'src/demo.js' }],
    rawInput: { path: 'src/demo.js' }
  },
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL_UPDATE,
    toolCallId: 'tool-1',
    status: TOOL_CALL_STATUS.IN_PROGRESS
  },
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL_UPDATE,
    toolCallId: 'tool-1',
    status: TOOL_CALL_STATUS.COMPLETED,
    content: [
      { type: 'diff', path: 'src/demo.js', oldText: null, newText: 'module.exports = 1;\n' }
    ]
  },
  {
    sessionUpdate: SESSION_UPDATE.AGENT_MESSAGE_CHUNK,
    content: { type: 'text', text: '已完成修改。' }
  },
  { sessionUpdate: SESSION_UPDATE.USAGE_UPDATE, used: 1200, size: 200000 }
];

/** 一段执行 shell 的脚本（用于 COMMAND_* 事件测试）。 */
const EXEC_UPDATES = [
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL,
    toolCallId: 'tool-exec',
    title: 'npm test',
    kind: TOOL_KIND.EXECUTE,
    status: TOOL_CALL_STATUS.IN_PROGRESS,
    rawInput: { command: 'npm test' }
  },
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL_UPDATE,
    toolCallId: 'tool-exec',
    content: [{ type: 'content', content: { type: 'text', text: '2 passing\n' } }]
  },
  {
    sessionUpdate: SESSION_UPDATE.TOOL_CALL_UPDATE,
    toolCallId: 'tool-exec',
    status: TOOL_CALL_STATUS.COMPLETED,
    rawOutput: { exitCode: 0 }
  }
];

/** v1 默认权限选项（4 个 kind 齐全）。 */
const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: '允许一次', kind: PERMISSION_OPTION_KIND.ALLOW_ONCE },
  { optionId: 'allow-always', name: '总是允许', kind: PERMISSION_OPTION_KIND.ALLOW_ALWAYS },
  { optionId: 'reject-once', name: '拒绝一次', kind: PERMISSION_OPTION_KIND.REJECT_ONCE },
  { optionId: 'reject-always', name: '总是拒绝', kind: PERMISSION_OPTION_KIND.REJECT_ALWAYS }
];

const DEFAULT_CONFIG = {
  /** initialize 返回的协议版本（用于测试不支持版本的分支）。 */
  protocolVersion: PROTOCOL_VERSION.V1,
  /**
   * initialize 返回的 agentCapabilities（v1 形状）。
   * v1 baseline（session/new · prompt · cancel · update）**不**出现在这里。
   */
  agentCapabilities: {
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: { resume: {}, close: {} }
  },
  authMethods: [],
  agentInfo: { name: 'fake-acp-agent', version: '0.0.1-test' },
  /** initialize 直接返回 JSON-RPC error。 */
  initializeError: null,
  /** prompt 期间推送的 session/update 列表（null → DEFAULT_UPDATES；[] → 不推送）。 */
  updates: null,
  /** 非空时在 prompt 中途发起 session/request_permission，值为 v1 ToolCallUpdate。 */
  requestPermission: null,
  /** 权限请求携带的 options[]（可设为只含 reject 的数组以测 fail-closed）。 */
  permissionOptions: null,
  /** 权限被拒时是否仍然按 end_turn 收尾（默认 false → refusal）。 */
  continueOnPermissionDenied: false,
  /** prompt 的终态，取值必须来自 v1 StopReason。 */
  stopReason: STOP_REASON.END_TURN,
  /** prompt 响应前插入的延迟（ms），用于 cancel 测试。 */
  promptDelayMs: 0,
  /** 收到 prompt 后永不响应（配合 cancel / timeout 测试）。 */
  hangOnPrompt: false,
  /** 收到 cancel 后也不收尾（测试客户端强杀兜底路径）。 */
  ignoreCancel: false,
  /** 在 prompt 流中混入一行畸形 JSON，验证解码器容错。 */
  emitMalformedLine: false,
  /** 收到 prompt 后直接退出进程（测"意外退出 = FAILED"）。 */
  exitOnPrompt: false,
  /** session/new 返回的 sessionId 前缀。 */
  sessionIdPrefix: 'fake-session',
  /** 强制 session/new 不返回 sessionId（测客户端是否 fail-closed）。 */
  omitSessionId: false
};

/**
 * ACP v1 协议引擎（与 I/O 无关）。
 * @param {object} userConfig
 * @param {{ write:Function, writeRaw:Function, exit:Function }} io
 */
function createAcpAgentEngine(userConfig, io) {
  const config = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
  const state = {
    /** 收到的所有 client → agent 报文 { method, params, isNotification }。 */
    received: [],
    /** 客户端违反 v1 协议的地方（测试应断言为空）。 */
    violations: [],
    sessions: new Map(),     // sessionId -> { cwd, mcpServers }
    /** client 对 session/request_permission 的原始响应。 */
    permissionResponse: null,
    /** 归一化后的结果：'allowed' | 'rejected' | 'cancelled' | null */
    permissionOutcome: null,
    clientCapabilities: null,
    clientInfo: null,
    cancelled: false,
    initialized: false,
    authenticatedWith: null,
    exited: false
  };

  let sessionSeq = 0;
  let nextAgentRequestId = 1000;
  /** agentRequestId -> resolve */
  const outbound = new Map();
  /** 挂起的 prompt：{ id, sessionId } —— cancel 时用它收尾。 */
  let pendingPrompt = null;

  const violate = (msg) => state.violations.push(msg);
  const send = (obj) => io.write({ jsonrpc: JSONRPC.VERSION, ...obj });
  const respond = (id, result) => send({ id, result: result === undefined ? null : result });
  const respondError = (id, code, message) => send({ id, error: { code, message } });
  const notify = (method, params) => send({ method, params });

  function pushUpdate(sessionId, update) {
    notify(CLIENT_METHOD.SESSION_UPDATE, { sessionId, update });
  }

  /** 向 client 发起反向请求，等待其响应。 */
  function requestClient(method, params) {
    const id = nextAgentRequestId++;
    return new Promise(resolve => {
      outbound.set(id, resolve);
      send({ id, method, params });
    });
  }

  /** 校验并归一化 client 的 RequestPermissionResponse。 */
  function interpretPermissionResponse(res) {
    state.permissionResponse = res;
    if (!res || typeof res !== 'object') {
      violate('RequestPermissionResponse 不是对象');
      return 'rejected';
    }
    const outcome = res.outcome;
    if (typeof outcome === 'string') {
      // v2 alpha / 早期猜测的扁平形状
      violate(`RequestPermissionResponse.outcome 必须是对象，收到字符串 "${outcome}"`);
      return 'rejected';
    }
    if (!outcome || typeof outcome !== 'object') {
      violate('RequestPermissionResponse 缺少 outcome 对象');
      return 'rejected';
    }
    if (outcome.outcome === PERMISSION_OUTCOME.CANCELLED) return 'cancelled';
    if (outcome.outcome !== PERMISSION_OUTCOME.SELECTED) {
      violate(`未知 outcome.outcome: ${JSON.stringify(outcome.outcome)}`);
      return 'rejected';
    }
    const options = state.lastPermissionOptions || [];
    const hit = options.find(o => o.optionId === outcome.optionId);
    if (!hit) {
      violate(`optionId "${outcome.optionId}" 不在 options[] 中`);
      return 'rejected';
    }
    return hit.kind === PERMISSION_OPTION_KIND.ALLOW_ONCE || hit.kind === PERMISSION_OPTION_KIND.ALLOW_ALWAYS
      ? 'allowed'
      : 'rejected';
  }

  async function runPrompt(id, params) {
    const sessionId = params && params.sessionId;
    pendingPrompt = { id, sessionId };

    if (config.exitOnPrompt) { state.exited = true; io.exit(3); return; }

    const updates = Array.isArray(config.updates) ? config.updates : DEFAULT_UPDATES;
    for (const u of updates) {
      if (state.cancelled) break;
      pushUpdate(sessionId, u);
    }

    if (config.emitMalformedLine) io.writeRaw('{ this is not json\n');

    let denied = false;
    if (config.requestPermission && !state.cancelled) {
      const options = Array.isArray(config.permissionOptions)
        ? config.permissionOptions
        : DEFAULT_PERMISSION_OPTIONS;
      state.lastPermissionOptions = options;
      const res = await requestClient(CLIENT_METHOD.SESSION_REQUEST_PERMISSION, {
        sessionId,
        toolCall: config.requestPermission,
        options
      });
      state.permissionOutcome = interpretPermissionResponse(res);
      denied = state.permissionOutcome !== 'allowed';
    }

    if (config.hangOnPrompt) return; // 永不响应，交给 cancel / timeout

    const finish = () => {
      if (!pendingPrompt || pendingPrompt.id !== id) return; // 已被 cancel 收尾
      pendingPrompt = null;
      let stopReason = config.stopReason;
      if (state.cancelled) stopReason = STOP_REASON.CANCELLED;
      else if (denied && !config.continueOnPermissionDenied) stopReason = STOP_REASON.REFUSAL;
      // v1 PromptResponse 只有 stopReason，没有 message/text 字段。
      respond(id, { stopReason });
    };

    if (config.promptDelayMs > 0) setTimeout(finish, config.promptDelayMs);
    else finish();
  }

  function doCancel() {
    if (config.ignoreCancel) return;
    state.cancelled = true;
    if (pendingPrompt) {
      const p = pendingPrompt;
      pendingPrompt = null;
      respond(p.id, { stopReason: STOP_REASON.CANCELLED });
    }
  }

  /** 处理一条来自 client 的 JSON-RPC 报文。 */
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.jsonrpc !== JSONRPC.VERSION) {
      violate(`报文缺少 jsonrpc:"2.0"（ACP 是严格 JSON-RPC 2.0）: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    // 1) client 对 agent 反向请求的响应
    if (msg.id !== undefined && msg.id !== null && !msg.method && outbound.has(msg.id)) {
      const resolve = outbound.get(msg.id);
      outbound.delete(msg.id);
      resolve(msg.error ? { __error: msg.error } : msg.result);
      return;
    }

    if (!msg.method) return;
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};
    state.received.push({ method: msg.method, params, isNotification });

    // session/cancel 是**通知**：客户端当请求发就是协议违规。
    if (msg.method === NOTIFICATION.SESSION_CANCEL) {
      if (!isNotification) violate('session/cancel 必须以通知发送（不得带 id）');
      doCancel();
      return;
    }

    if (isNotification) return; // 其余通知目前不处理

    const id = msg.id;

    switch (msg.method) {
      case METHOD.INITIALIZE: {
        if (config.initializeError) {
          respondError(id, config.initializeError.code, config.initializeError.message);
          return;
        }
        if (typeof params.protocolVersion !== 'number') {
          violate('initialize 缺少数值型 protocolVersion');
        }
        if (!params.clientCapabilities || typeof params.clientCapabilities !== 'object') {
          violate('initialize 缺少 clientCapabilities 对象');
        }
        if ('capabilities' in params) violate('initialize 使用了 v2 字段名 capabilities');
        if ('info' in params) violate('initialize 使用了 v2 字段名 info');
        state.clientCapabilities = params.clientCapabilities || null;
        state.clientInfo = params.clientInfo || null;
        state.initialized = true;
        respond(id, {
          protocolVersion: config.protocolVersion,
          agentCapabilities: config.agentCapabilities,
          authMethods: config.authMethods,
          agentInfo: config.agentInfo
        });
        return;
      }

      case METHOD.AUTHENTICATE:
        state.authenticatedWith = params.methodId || null;
        respond(id, {});
        return;

      case METHOD.SESSION_NEW: {
        if ('sessionId' in params) {
          violate('session/new 不得由客户端自带 sessionId（v1 由 Agent 生成）');
        }
        if (typeof params.cwd !== 'string' || !params.cwd) {
          violate('session/new 缺少必填 cwd');
          respondError(id, RPC.INVALID_PARAMS, 'cwd is required');
          return;
        }
        if (!Array.isArray(params.mcpServers)) {
          violate('session/new 缺少必填 mcpServers 数组');
          respondError(id, RPC.INVALID_PARAMS, 'mcpServers is required');
          return;
        }
        const sessionId = `${config.sessionIdPrefix}-${++sessionSeq}`;
        state.sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers });
        respond(id, config.omitSessionId ? {} : { sessionId });
        return;
      }

      case METHOD.SESSION_RESUME: {
        if (typeof params.sessionId !== 'string' || !params.sessionId) {
          violate('session/resume 缺少必填 sessionId');
          respondError(id, RPC.INVALID_PARAMS, 'sessionId is required');
          return;
        }
        state.sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers || [] });
        respond(id, {});
        return;
      }

      case METHOD.SESSION_PROMPT: {
        if (!Array.isArray(params.prompt)) {
          violate(`session/prompt 的 prompt 必须是 ContentBlock[]，收到 ${typeof params.prompt}`);
          respondError(id, RPC.INVALID_PARAMS, 'prompt must be an array of ContentBlock');
          return;
        }
        if (!params.prompt.every(b => b && typeof b === 'object' && typeof b.type === 'string')) {
          violate('session/prompt 的 prompt[] 里存在非 ContentBlock 元素');
        }
        // 不 await：prompt 是长任务，期间还要能收 cancel
        runPrompt(id, params);
        return;
      }

      case METHOD.SESSION_CLOSE:
        state.sessions.delete(params.sessionId);
        respond(id, {});
        return;

      default:
        respondError(id, RPC.METHOD_NOT_FOUND, 'Method not found: ' + msg.method);
    }
  }

  return { handleMessage, state, config };
}

/** 按行切分并解析 JSONL，逐条交给 handler。 */
function createLineReader(onObject) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onObject(obj);
    }
  };
}

/**
 * A) 进程内模式：返回可注入 CliProcessSupervisor 的 spawnImpl / killTreeImpl。
 * @param {object} [config] 见 DEFAULT_CONFIG
 */
function createFakeAcpAgent(config = {}) {
  let pidSeq = 40000;
  const spawned = [];

  function spawnImpl(command, args, opts) {
    const child = new EventEmitter();
    child.pid = ++pidSeq;
    child.spawnargs = [command, ...(args || [])];
    child.spawnOpts = opts || {};
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const io = {
      write: (obj) => { try { child.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* closed */ } },
      writeRaw: (s) => { try { child.stdout.write(s); } catch { /* closed */ } },
      exit: (code) => { setImmediate(() => child.emit('close', code, null)); }
    };
    const engine = createAcpAgentEngine(config, io);
    const feed = createLineReader(engine.handleMessage);

    child.stdin = new Writable({
      write(chunk, _enc, cb) { feed(chunk); cb(); }
    });
    child.kill = (sig) => {
      if (child.killed) return true;
      child.killed = true;
      child.killSignal = sig;
      setImmediate(() => child.emit('close', null, sig || 'SIGKILL'));
      return true;
    };
    child.engine = engine;
    spawned.push(child);
    return child;
  }

  /** 与真实 killTree 同签名，但不碰真实进程。 */
  function killTreeImpl(child, signal) {
    if (child && typeof child.kill === 'function') child.kill(signal);
  }

  return {
    spawnImpl,
    killTreeImpl,
    /** PATH 解析桩：任何命令都"找得到"。 */
    resolveImpl: (cmd) => Promise.resolve(`/fake/bin/${cmd}`),
    /** 最近一次 spawn 出来的 child（含 .engine.state）。 */
    lastChild: () => spawned[spawned.length - 1] || null,
    children: () => [...spawned]
  };
}

/** B) 真子进程模式入口。 */
function runAsProcess() {
  let config = {};
  try { config = JSON.parse(process.env.FAKE_ACP_CONFIG || '{}'); } catch { config = {}; }

  const io = {
    write: (obj) => process.stdout.write(JSON.stringify(obj) + '\n'),
    writeRaw: (s) => process.stdout.write(s),
    exit: (code) => process.exit(code)
  };
  const engine = createAcpAgentEngine(config, io);
  const feed = createLineReader(engine.handleMessage);
  process.stdin.on('data', feed);
  process.stdin.on('end', () => process.exit(0));
  // 保持事件循环存活，直到被 kill 或显式退出
  process.stdin.resume();
}

if (require.main === module) runAsProcess();

module.exports = {
  createFakeAcpAgent,
  createAcpAgentEngine,
  createLineReader,
  DEFAULT_UPDATES,
  EXEC_UPDATES,
  DEFAULT_PERMISSION_OPTIONS,
  DEFAULT_CONFIG
};
