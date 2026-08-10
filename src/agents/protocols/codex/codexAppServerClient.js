'use strict';
/**
 * v2.8.0 — Codex App Server 客户端（spec §10/§42/§43/§44/§45）。
 *
 * 这是 Codex 深度集成的 **primary** 路径：结构化协议，不做任何自然语言文本抓取。
 *
 * 上游事实（openai/codex @ 21aa552e）与由此产生的三条硬约束：
 *
 * 1) 非标准 JSON-RPC —— rpc.rs:1-2 明写不发也不认 "jsonrpc" 字段。
 *    → 用 createJsonRpcSession({ envelopeVersion: null })，不能用现成 JSON-RPC 库。
 *
 * 2) 换行分帧 —— app-server-transport/src/transport/stdio.rs:46 用 `reader.lines()`，
 *    不是 LSP 的 Content-Length。→ 复用 StructuredStreamDecoder（JSONL）。
 *
 * 3) **没有版本协商** —— InitializeResponse（v1.rs:70-80）只有
 *    userAgent / codexHome / platformFamily / platformOs，没有 protocolVersion。
 *    → 只能"pin 版本 + 方法探测"：initialize 后主动验证关键方法可用，
 *      不可用就让上层降级到 `codex exec --json`（spec §43 C）。
 *
 * 另：绝大多数高级字段带 `#[experimental(...)]` 门控，不在 initialize 里声明
 * capabilities.experimentalApi=true 会被服务端直接拒绝
 * （experimental_api.rs:30-32 "{reason} requires experimentalApi capability"）。
 *
 * 本文件不碰凭据：登录状态由 Codex 自己管理（spec §30/§31），我们只读 getAuthStatus。
 */

const { createJsonRpcSession } = require('../jsonRpcSession');
const { createStructuredStreamDecoder } = require('../../runtime/structuredStreamDecoder');
const { createCliProcessSupervisor } = require('../../runtime/cliProcessSupervisor');
const {
  METHOD, CLIENT_NOTIFICATION, NOTIFICATION, SERVER_REQUEST,
  COMMAND_APPROVAL_DECISION, FILE_CHANGE_APPROVAL_DECISION,
  USER_INPUT_TYPE, TURN_STATUS, CLIENT_INFO
} = require('./appServerConstants');

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;

/** App Server 子命令。`codex app-server`（cli/src/main.rs:152-153，标记 [experimental]）。 */
const APP_SERVER_ARGS = ['app-server'];

/**
 * 深度集成所依赖的方法集合。任一缺失即判定当前 codex 版本不支持深度路径。
 * 只列**真正会调用**的，不做无谓的能力膨胀。
 */
const REQUIRED_METHODS = [METHOD.THREAD_START, METHOD.TURN_START, METHOD.TURN_INTERRUPT];

/**
 * 创建 Codex App Server 客户端。
 * @param {object} [opts]
 * @param {object} [opts.supervisor] 注入的 CliProcessSupervisor（单测用）
 * @param {Function} [opts.transportFactory] 注入的传输工厂（单测用，返回 { session, kill, dispose, onExit }）
 */
function createCodexAppServerClient({ supervisor, transportFactory } = {}) {
  const sup = supervisor || createCliProcessSupervisor();

  let session = null;
  let handle = null;
  let decoder = null;
  let connected = false;
  let cleanShutdown = false;
  let serverInfo = null;
  const exitListeners = [];
  const notificationSinks = [];

  function onExit(cb) { exitListeners.push(cb); }
  function emitExit(info) {
    for (const cb of exitListeners) { try { cb(info); } catch { /* noop */ } }
  }

  /** 注册一个"接收全部通知"的接收器（适配器用它驱动事件映射）。 */
  function onAnyNotification(cb) { notificationSinks.push(cb); }
  function fanout(method, params) {
    for (const cb of notificationSinks) {
      try { cb(method, params); } catch { /* 单个接收器抛错不得影响其他 */ }
    }
  }

  /**
   * 启动 app-server 进程并完成 initialize 握手。
   * @param {object} o
   * @param {string} o.command codex 可执行路径
   * @param {string} [o.cwd]
   * @param {object} [o.env] 已 allowlist 的 env
   * @param {number} [o.timeoutMs] 整体运行超时（进程级）
   * @param {number} [o.handshakeTimeoutMs]
   * @returns {Promise<{ serverInfo: object }>}
   */
  async function connect(o = {}) {
    if (connected) throw new Error('codex app-server already connected');

    if (transportFactory) {
      // 单测注入路径：直接拿一个已连通的 session
      const injected = await transportFactory(o);
      session = injected.session;
      handle = injected.handle || null;
      if (typeof injected.onExit === 'function') injected.onExit(emitExit);
    } else {
      handle = await sup.spawnProcess({
        command: o.command,
        args: APP_SERVER_ARGS,
        cwd: o.cwd,
        env: o.env,
        timeoutMs: o.timeoutMs,
        captureOutput: false // stdout 是协议流，由 decoder 增量消费
      });

      decoder = createStructuredStreamDecoder({ frameLimitBytes: o.frameLimitBytes });
      decoder.on('message', obj => { if (session) session.receive(obj); });

      session = createJsonRpcSession({
        // ⚠️ 裸信封：Codex 既不发也不认 "jsonrpc" 字段
        envelopeVersion: null,
        send: (s) => {
          if (handle.child.stdin && !handle.child.stdin.destroyed) {
            try { handle.child.stdin.write(s + '\n'); } catch { /* pipe closed */ }
          }
        }
      });

      if (handle.child.stdout) handle.child.stdout.on('data', chunk => decoder.push(chunk));
      handle.child.on('close', (code, sig) => {
        const clean = cleanShutdown;
        if (!clean && session) session.dispose(); // pending 请求以 disposed 拒绝，不会静默挂死
        try { if (decoder) decoder.flush(); } catch { /* noop */ }
        connected = false;
        emitExit({ code, signal: sig, clean, stderr: handle ? handle.stderr : '' });
      });
    }

    // 所有服务端通知统一扇出
    for (const method of Object.values(NOTIFICATION)) {
      session.onNotification(method, (params) => fanout(method, params));
    }

    // initialize —— 必须声明 experimentalApi，否则 experimental 字段/方法一律被拒
    const initResult = await session.request(METHOD.INITIALIZE, {
      clientInfo: { ...CLIENT_INFO },
      capabilities: { experimentalApi: true }
    }, { timeoutMs: o.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS });

    // initialized 通知（common.rs:1816，唯一的 client notification）
    try { session.notify(CLIENT_NOTIFICATION.INITIALIZED, {}); } catch { /* 非致命 */ }

    serverInfo = initResult || {};
    connected = true;
    return { serverInfo };
  }

  /**
   * 方法探测（替代不存在的版本协商，spec §23 的 Codex 变体）。
   *
   * 做法：不真正执行副作用方法，而是根据 initialize 是否成功 + userAgent 是否可解析
   * 判定基础可用性；对 REQUIRED_METHODS 的存在性验证放在首次调用时（method not found
   * 会以 JSON-RPC -32601 返回，由 startTurn 捕获并交由上层降级）。
   *
   * 这样避免"为了探测而产生真实副作用"（比如凭空 thread/start 出一个空线程）。
   * @returns {{ ok: boolean, userAgent: string|null, requiredMethods: string[] }}
   */
  function probeMethods() {
    const ua = serverInfo && typeof serverInfo.userAgent === 'string' ? serverInfo.userAgent : null;
    return { ok: !!connected, userAgent: ua, requiredMethods: [...REQUIRED_METHODS] };
  }

  /**
   * 注册审批处理器（spec §34/§35/§36）。
   * resolver 返回 'accept' | 'decline' | 'cancel'。缺省一律 decline —— 不存在自动放行。
   * @param {Function} resolver async ({ kind, params }) => 'accept'|'decline'|'cancel'
   */
  function onApproval(resolver) {
    const decide = async (kind, params) => {
      if (typeof resolver !== 'function') return 'decline';
      try {
        const d = await resolver({ kind, params });
        return d === 'accept' || d === 'cancel' ? d : 'decline';
      } catch {
        return 'decline'; // 评估出错 → 拒绝，绝不放行
      }
    };

    session.onRequest(SERVER_REQUEST.COMMAND_EXECUTION_REQUEST_APPROVAL, async (params, { respond }) => {
      const d = await decide('command', params);
      respond({ decision: COMMAND_APPROVAL_DECISION[d.toUpperCase()] || COMMAND_APPROVAL_DECISION.DECLINE });
    });
    session.onRequest(SERVER_REQUEST.FILE_CHANGE_REQUEST_APPROVAL, async (params, { respond }) => {
      const d = await decide('fileChange', params);
      respond({ decision: FILE_CHANGE_APPROVAL_DECISION[d.toUpperCase()] || FILE_CHANGE_APPROVAL_DECISION.DECLINE });
    });
    session.onRequest(SERVER_REQUEST.PERMISSIONS_REQUEST_APPROVAL, async (params, { respond }) => {
      const d = await decide('permissions', params);
      respond({ decision: d === 'accept' ? 'accept' : 'decline' });
    });
  }

  /**
   * 新建 thread（= 平台侧的 External Session，spec §39/§109）。
   * @param {object} o { cwd, model, sandbox, approvalPolicy }
   * @returns {Promise<{ threadId: string, raw: object }>}
   */
  async function startThread(o = {}) {
    const params = {};
    if (o.cwd) params.cwd = o.cwd;
    if (o.model) params.model = o.model;
    if (o.sandbox) params.sandbox = o.sandbox;
    if (o.approvalPolicy) params.approvalPolicy = o.approvalPolicy;
    const res = await session.request(METHOD.THREAD_START, params);
    const threadId = res && res.thread && res.thread.id ? res.thread.id : (res && res.threadId) || null;
    if (!threadId) throw new Error('codex thread/start 未返回 thread id');
    return { threadId, raw: res };
  }

  /**
   * 恢复既有 thread（spec §40）。
   * @param {object} o { threadId }
   */
  async function resumeThread(o = {}) {
    const res = await session.request(METHOD.THREAD_RESUME, { threadId: o.threadId });
    const threadId = res && res.thread && res.thread.id ? res.thread.id : o.threadId;
    return { threadId, raw: res };
  }

  /**
   * 发起一个 turn 并等待其终态。
   * turn/start 的响应本身不代表完成 —— 完成信号来自 turn/completed 通知
   * （v2/turn.rs:407-410），所以这里用通知来 settle。
   *
   * @param {object} o { threadId, text, cwd, timeoutMs }
   * @returns {Promise<{ status: string, turn: object|null }>}
   */
  function startTurn(o = {}) {
    const { threadId, text, cwd, timeoutMs } = o;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        const i = notificationSinks.indexOf(watcher);
        if (i >= 0) notificationSinks.splice(i, 1);
      };
      const settle = (fn, v) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(v);
      };

      // 监听 turn 终态通知
      const watcher = (method, params) => {
        if (method !== NOTIFICATION.TURN_COMPLETED) return;
        if (params && params.threadId && threadId && params.threadId !== threadId) return;
        const turn = (params && params.turn) || {};
        settle(resolve, { status: turn.status || TURN_STATUS.COMPLETED, turn });
      };
      notificationSinks.push(watcher);

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => settle(resolve, { status: 'timeout', turn: null }), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      session.request(METHOD.TURN_START, {
        threadId,
        input: [{ type: USER_INPUT_TYPE.TEXT, text: String(text || '') }],
        ...(cwd ? { cwd } : {})
      }, { timeoutMs: 0 }).catch(err => {
        // -32601 = method not found → 该 codex 版本不支持深度路径，交上层降级
        settle(reject, err);
      });
    });
  }

  /** 中断当前 turn（spec §66：Cancel 必须走协议，而不是直接 kill）。 */
  async function interruptTurn(threadId) {
    try {
      await session.request(METHOD.TURN_INTERRUPT, { threadId }, { timeoutMs: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  }

  /** 读取登录状态。绝不读取/提取 token 本体（spec §30/§31/§32）。 */
  async function getAuthStatus() {
    try {
      const res = await session.request(METHOD.GET_AUTH_STATUS, {}, { timeoutMs: 5000 });
      return { ok: true, authenticated: !!(res && (res.authenticated || res.authMode)), method: res && res.authMode ? String(res.authMode) : null };
    } catch (e) {
      return { ok: false, authenticated: false, error: e && e.message };
    }
  }

  /** 优雅关闭：标记 cleanShutdown，避免把主动关闭误报成"意外退出"（spec §65）。 */
  function dispose() {
    cleanShutdown = true;
    connected = false;
    try { if (session) session.dispose(); } catch { /* noop */ }
    try { if (decoder) decoder.flush(); } catch { /* noop */ }
    try { if (handle) handle.kill('SIGKILL'); } catch { /* gone */ }
    session = null;
    handle = null;
    decoder = null;
  }

  return {
    connect,
    probeMethods,
    onApproval,
    onAnyNotification,
    onExit,
    startThread,
    resumeThread,
    startTurn,
    interruptTurn,
    getAuthStatus,
    dispose,
    _isConnected: () => connected,
    _serverInfo: () => serverInfo,
    _session: () => session
  };
}

module.exports = {
  createCodexAppServerClient,
  APP_SERVER_ARGS,
  REQUIRED_METHODS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS
};
