'use strict';
/**
 * v2.7.2 Agent Integration Hub — Cline SDK 适配器（spec §4.3 / §7-§9 / §11-§23 / §35-§41）。
 *
 * 包装 @cline/sdk（ESM-only）接入统一 AgentAdapter 接口。通过 sdkBridge 动态
 * import SDK，使主进程（CJS）能在不安装 SDK 时也正常加载（detect 返回 unavailable）。
 *
 * 相对 v2.7.1 的可靠性修正：
 *   §7  版本不再硬编码 '0.0.72'：detect() 透传 sdkBridge 从 package metadata 读到的版本，
 *       读不到就是 null（versionSource='unknown'），绝不伪造。
 *   §8  detect() 真实判定：installed（模块可 import）/ configured（期望导出齐全）/
 *       available（二者都成立）三态分离，不再「文件存在即可用」。
 *   §9  healthCheck() 增加 runtime constructibility 校验（构造探针 Agent，只看实例形状，
 *       不消耗任何真实 API），形状不对 → DEGRADED 而非谎报 HEALTHY。
 *   §11-§15 终态闸门：所有终态经唯一漏斗 _finish() → ExternalAgentTerminalGate，
 *       「终态一次」。agent.run() 解析出的结果若不含任何终态证据（null / 空对象），
 *       判 FAILED + AGENT_STREAM_ENDED_WITHOUT_TERMINAL，绝不默认 COMPLETED。
 *   §16-§19 超时与取消分离：超时 → TIMEOUT（abortReason='timeout'，发 agent.run.timeout）；
 *       用户取消 → CANCELLED（abortReason='user_cancel'，发 agent.run.cancelled）；
 *       父级取消 / 关停分别记 'parent_cancel' / 'shutdown'。不再共用一个 AbortController 语义。
 *   §20-§23 晚期结果保护：终态之后才 resolve 的 agent.run() 结果被闸门忽略。
 *   §37 projectRoot 真实下发：cwd / workspacePath / workingDirectory 一并传给 SDK 构造函数，
 *       并回读实例确认是否被接住；未被接住时在结果 warnings 中如实标注，不假装已沙箱化。
 *   §39-§41 统一结果契约 + 脱敏：不再把完整 raw 落库/落事件，改为有限长度的 sanitizedRaw。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE, AGENT_EVENT } = require('../hub/types');
const { CLINE } = require('../manifests/builtinAgents');
const sdkBridge = require('../integrations/cline/sdkBridge');
const { mapClineEvent, mapClineEvents } = require('../integrations/cline/eventMapper');
const { ClineSidecarManager, canonicalDirectory } = require('../integrations/cline/sidecarManager');
const { mapConnection } = require('../integrations/cline/configMapper');
const { createExternalAgentTerminalGate } = require('../runtime/externalTerminalGate');
const { buildExternalResult, sanitizeErrors, sanitizeRaw } = require('../runtime/resultSanitizer');
const permissionBroker = require('../protocols/acp/permissionBroker');

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_RUN_TIMEOUT_MS = 600000;

/**
 * v2.8.1 §37 — Cline scope → Permission Broker operation 映射。
 * 键集合与 sidecar `buildToolPolicies` 认识的 scope 严格一致
 * （sidecars/cline-runtime/src/runtime.mjs:48-57），不多不少。
 *
 * 注意 `terminal.read` 同样映射为 RUN_SHELL（属写操作）：sidecar 对
 * `terminal.read` 与 `terminal.write` 启用的是**同一套** TOOL_NAMES.terminal
 * 工具，不存在"只读终端"。按 RUN_SHELL 处理才与 sidecar 实际能力一致，
 * 否则只读父 Run 会拿到可执行命令的终端工具。
 */
const CLINE_SCOPE_OPERATION = {
  'filesystem.read': permissionBroker.OPERATION.READ_FILE,
  'filesystem.write': permissionBroker.OPERATION.WRITE_FILE,
  'terminal.read': permissionBroker.OPERATION.RUN_SHELL,
  'terminal.write': permissionBroker.OPERATION.RUN_SHELL,
  network: permissionBroker.OPERATION.NETWORK
};

/** 健康检查探针配置（无凭据、无网络调用）。 */
const PROBE_AGENT_CONFIG = Object.freeze({
  providerId: '__probe__',
  modelId: '__probe__',
  apiKey: '',
  maxIterations: 1
});

/**
 * 本地兜底：判断 agent 实例是否真的接住了 workspace 根目录（§37）。
 * 优先使用 sdkBridge 的实现；测试注入的 fake bridge 可能没有该导出。
 */
function localDescribeAgentWorkspace(agent, cwd) {
  if (!agent || !cwd) return { applied: false, field: null };
  const candidates = [
    ['cwd', agent.cwd],
    ['workspacePath', agent.workspacePath],
    ['workingDirectory', agent.workingDirectory],
    ['config.cwd', agent.config && agent.config.cwd],
    ['options.cwd', agent.options && agent.options.cwd]
  ];
  for (const [field, value] of candidates) {
    if (value && String(value) === String(cwd)) return { applied: true, field };
  }
  return { applied: false, field: null };
}

/**
 * 判定 agent.run() 的返回值是否构成「显式终态证据」（§11/§12）。
 * v2.7.1 直接把任何返回都当 completed；本函数要求结果里至少有一项可核对的产出，
 * 否则视为「流结束但没有终态」。
 * @param {*} raw
 * @returns {{ terminal: boolean, cancelled: boolean, failed: boolean, error: string|null }}
 */
function classifyRunOutcome(raw) {
  const none = { terminal: false, cancelled: false, failed: false, error: null };
  if (raw === null || raw === undefined) return none;
  if (typeof raw === 'string') {
    return raw.length ? { terminal: true, cancelled: false, failed: false, error: null } : none;
  }
  if (typeof raw !== 'object') return none;
  if (raw.cancelled === true || raw.aborted === true) {
    return { terminal: true, cancelled: true, failed: false, error: null };
  }
  if (raw.error) {
    return { terminal: true, cancelled: false, failed: true, error: typeof raw.error === 'string' ? raw.error : (raw.error.message || 'cline run reported an error') };
  }
  const hasEvidence =
    typeof raw.text === 'string' ||
    typeof raw.output === 'string' ||
    raw.usage != null ||
    raw.iterations != null ||
    raw.status != null ||
    raw.success != null;
  if (!hasEvidence) return none;
  return { terminal: true, cancelled: false, failed: false, error: null };
}

/**
 * 把 agent.run() 返回的 { text, usage, iterations } 解析为统一结果字段（不含完整 raw，§40）。
 */
function parseClineResult(raw, status) {
  const r = raw || {};
  return {
    status: status || 'completed',
    summary: typeof r.text === 'string' ? r.text : (typeof r.output === 'string' ? r.output : ''),
    findings: [],
    changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : [],
    artifacts: [],
    errors: [],
    usage: r.usage || null,
    iterations: r.iterations != null ? r.iterations : 0,
    // §40：绝不把完整 raw 落 SQLite / Event / GUI，只保留有限长度、已脱敏的摘要
    sanitizedRaw: sanitizeRaw(r)
  };
}

class ClineAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest] cline manifest（缺省取内置 CLINE）
   * @param {object} [opts.store]    连接存储（store.connections.getDecrypted 解密 API 连接）
   * @param {object} [opts.config]   适配器配置（connectionId / model / timeoutMs / maxIterations）
   * @param {object} [opts.bridge]   可注入的 sdkBridge（测试用）
   */
  constructor({ manifest, store, config, bridge, sidecarManager, dataDir } = {}) {
    super({ manifest: manifest || CLINE, config });
    this.store = store || null;
    this._bridge = bridge || sdkBridge;
    this._legacyBridge = !!bridge || !!this._bridge.__clineFake;
    this._sidecar = sidecarManager || new ClineSidecarManager({ dataDir });
    // runId -> { ac, status, result, startedAt, agent, projectRoot, taskText, abortReason, ... }
    this._runs = new Map();
    this._gate = createExternalAgentTerminalGate();
    // detect 缓存
    this._detected = null;
  }

  _useLegacyBridge() {
    return this._legacyBridge || this._sdkInjected === true || this.config?.runtimeMode === 'in-process-test';
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测 @cline/sdk 是否真实可用（§8 / §51）。
   * installed：模块可 import；configured：期望导出齐全；available：二者都成立。
   * @returns {Promise<{ available, installed, configured, version, versionSource, missing, error, detail }>}
   */
  async detect() {
    if (this._detected) return this._detected;
    if (!this._useLegacyBridge()) {
      const detection = this._sidecar.detect();
      this._detected = {
        ...detection,
        versionSource: detection.version ? 'bundled-runtime-manifest' : 'unknown',
        missing: detection.runtime?.missing || [],
        detail: detection.available
          ? `Bundled ClineCore sidecar detected (Node ${detection.nodeVersion}, @cline/sdk ${detection.version})`
          : `Bundled ClineCore sidecar unavailable: ${detection.error || 'runtime files are missing'}`,
        integration: 'ClineCore Sidecar',
        protocolVersion: detection.runtime?.manifest?.protocolVersion || null
      };
      return this._detected;
    }
    let probe;
    try {
      probe = await this._bridge.probeSdk();
    } catch (e) {
      probe = { available: false, installed: false, apiSurfaceOk: false, version: null, error: e && e.message ? e.message : String(e) };
    }
    probe = probe || {};
    const installed = probe.installed !== undefined ? !!probe.installed : !!probe.available;
    const configured = probe.apiSurfaceOk !== undefined ? !!probe.apiSurfaceOk : !!probe.available;
    const available = probe.available !== undefined ? !!probe.available : (installed && configured);
    const missing = Array.isArray(probe.missing) ? probe.missing : [];
    this._detected = {
      available,
      installed,
      configured,
      version: probe.version != null ? probe.version : null,
      versionSource: probe.versionSource || (probe.version ? 'bridge' : 'unknown'),
      missing,
      error: probe.error || null,
      detail: available
        ? '@cline/sdk loaded with expected exports'
        : (installed
          ? `@cline/sdk not configured: missing exports ${missing.join(', ') || '(unknown)'}`
          : `@cline/sdk not installed: ${probe.error || 'module could not be imported'}`)
    };
    return this._detected;
  }

  /**
   * 健康检查（§9 / §50-§52）：SDK 加载 + API surface + runtime constructibility。
   * 不消耗真实 API 额度。
   * @returns {Promise<{ status, version, latencyMs, detail, detection }>}
   */
  async healthCheck({ projectRoot } = {}) {
    const start = Date.now();
    const detection = await this.detect();
    if (!this._useLegacyBridge()) {
      if (!detection.available) {
        return {
          status: HEALTH_STATE.UNAVAILABLE,
          version: detection.version,
          latencyMs: Date.now() - start,
          detail: detection.detail,
          detection,
          integration: 'ClineCore Sidecar',
          runtime: { nodeVersion: detection.nodeVersion, sdkVersion: detection.version, probe: false }
        };
      }
      try {
        let workspace = { ready: false, path: null, error: 'No project is currently selected' };
        if (projectRoot) {
          try {
            const canonicalRoot = canonicalDirectory(projectRoot);
            workspace = { ready: true, path: canonicalRoot, error: null };
          } catch (error) {
            workspace = { ready: false, path: null, error: error.message };
          }
        }

        const connectionId = this.config?.connectionId || null;
        let connection = null;
        if (connectionId && this.store?.connections?.getDecrypted) {
          try { connection = this.store.connections.getDecrypted(connectionId); } catch { /* reported below */ }
        }
        const mapped = mapConnection(connection, this.config?.model);
        const sourceProvider = connection?.protocol || connection?.provider || '';
        const keyOptional = ['ollama', 'local', 'mock'].includes(sourceProvider);
        const apiConfigured = !!(
          connectionId && connection && mapped?.providerId && mapped?.modelId &&
          (mapped.apiKey || keyOptional)
        );
        const api = {
          configured: apiConfigured,
          connectionId,
          providerId: mapped?.providerId || null,
          modelId: mapped?.modelId || null,
          error: apiConfigured
            ? null
            : (!connectionId
              ? 'No API connection selected'
              : (!connection
                ? 'Selected API connection was not found'
                : (!mapped?.modelId ? 'No Cline model selected' : 'Selected API connection has no credential')))
        };

        const probe = await this._sidecar.probe(workspace.ready ? workspace.path : undefined);
        const sidecarReady = !!(probe.ok && probe.coreConstructible);
        const healthy = sidecarReady && api.configured && workspace.ready;
        const missing = [
          !sidecarReady && 'sidecar probe',
          !api.configured && 'API configuration',
          !workspace.ready && 'workspace'
        ].filter(Boolean);
        return {
          status: healthy ? HEALTH_STATE.HEALTHY : HEALTH_STATE.DEGRADED,
          version: probe.clineSdkVersion || detection.version,
          latencyMs: Date.now() - start,
          detail: healthy
            // v2.8.1 §40/§45 — health detail 只描述"当前运行时状态"，不得出现
            // verified / working / real 这类验证结论（验证级别由 agentVerification 统一裁决）。
            ? `ClineCore Sidecar ready (Node ${probe.nodeVersion}, @cline/sdk ${probe.clineSdkVersion}; API configured; workspace ready; no LLM network call)`
            : `ClineCore runtime is ready, but ${missing.join(', ') || 'configuration'} is not ready`,
          detection,
          integration: 'ClineCore Sidecar',
          sidecar: { ready: sidecarReady, protocolVersion: detection.protocolVersion || null },
          api,
          workspace,
          runtime: { ...probe, probe: true }
        };
      } catch (error) {
        return {
          status: HEALTH_STATE.DEGRADED,
          version: detection.version,
          latencyMs: Date.now() - start,
          detail: `ClineCore Sidecar detected but probe failed: ${error.message}`,
          detection,
          integration: 'ClineCore Sidecar',
          runtime: { nodeVersion: detection.nodeVersion, sdkVersion: detection.version, probe: false, error: error.message }
        };
      }
    }
    if (!detection.installed) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: detection.error ? `@cline/sdk unavailable: ${detection.error}` : '@cline/sdk not installed',
        detection
      };
    }
    if (!detection.configured) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: detection.version,
        latencyMs: Date.now() - start,
        detail: `@cline/sdk loaded but API surface is wrong: missing ${detection.missing.join(', ') || '(unknown)'}`,
        detection
      };
    }
    const runtime = await this._verifyRuntime();
    if (!runtime.apiSurfaceOk) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: detection.version,
        latencyMs: Date.now() - start,
        detail: `@cline/sdk API surface invalid: ${runtime.detail}`,
        detection
      };
    }
    if (!runtime.constructible) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: detection.version,
        latencyMs: Date.now() - start,
        detail: `@cline/sdk loaded but runtime not constructible: ${runtime.detail}`,
        detection
      };
    }
    return {
      status: HEALTH_STATE.HEALTHY,
      version: detection.version,
      latencyMs: Date.now() - start,
      detail: `@cline/sdk available (${runtime.detail})`,
      detection
    };
  }

  /**
   * 运行时可构造性校验（§9）。优先用 bridge.verifyRuntime，缺失时本地兜底。
   * @returns {Promise<{ apiSurfaceOk:boolean, constructible:boolean, detail:string }>}
   */
  async _verifyRuntime() {
    if (typeof this._bridge.verifyRuntime === 'function') {
      try { return await this._bridge.verifyRuntime(); }
      catch (e) { return { apiSurfaceOk: false, constructible: false, detail: e && e.message ? e.message : String(e) }; }
    }
    try {
      const sdk = typeof this._bridge.loadSdk === 'function' ? await this._bridge.loadSdk() : null;
      if (!sdk) return { apiSurfaceOk: false, constructible: false, detail: 'sdk not loadable' };
      const mod = sdk.Agent ? sdk : (sdk.default || sdk);
      const Agent = mod && mod.Agent;
      if (typeof Agent !== 'function') {
        return { apiSurfaceOk: false, constructible: false, detail: 'Agent export missing or not constructible' };
      }
      let instance = null;
      try { instance = new Agent({ ...PROBE_AGENT_CONFIG }); }
      catch (e) { return { apiSurfaceOk: true, constructible: false, detail: `Agent constructor threw: ${e && e.message ? e.message : String(e)}` }; }
      const constructible = !!instance && typeof instance.run === 'function';
      if (instance && typeof instance.dispose === 'function') { try { instance.dispose(); } catch { /* noop */ } }
      return {
        apiSurfaceOk: true,
        constructible,
        detail: constructible ? 'Agent constructible with run()' : 'Agent instance has no run() method'
      };
    } catch (e) {
      return { apiSurfaceOk: false, constructible: false, detail: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * 启动一次 Cline Run。
   * 立即返回 runId；agent.run() 在后台执行，状态/结果走 getStatus / getResult。
   *
   * @param {object} task    { goal, connectionId, model, systemPrompt?, maxIterations?, projectRoot, timeoutMs? }
   * @param {object} context { signal, emit, finishRun, projectRoot, projectId, store, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('ClineAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;

    // SDK 必须可用
    const detected = await this.detect();
    if (!detected.available) {
      throw new Error('ClineAgentAdapter: @cline/sdk 未安装，无法启动任务');
    }

    // 解析 API 连接：task.connectionId → store.connections.getDecrypted
    const store = (context && context.store) || this.store;
    const connectionId = task.connectionId || (this.config && this.config.connectionId);
    let connection = null;
    if (connectionId && store && store.connections && typeof store.connections.getDecrypted === 'function') {
      try { connection = store.connections.getDecrypted(connectionId); } catch { /* leave null */ }
    }
    if (!connection) {
      throw new Error(`ClineAgentAdapter: 未找到 API 连接 (connectionId=${connectionId || 'null'})`);
    }

    const model = task.model || (this.config && this.config.model) || null;
    const clineConfig = mapConnection(connection, model);
    if (!clineConfig) {
      throw new Error('ClineAgentAdapter: API 连接映射失败');
    }

    // projectRoot 取自 task / context，绝不回退到 home 目录
    const projectRoot = task.projectRoot || (context && context.projectRoot) || null;

    const runId = (context && context.runId) || crypto.randomUUID();
    const ac = new AbortController();
    // 外部 signal（context.signal）联动到本 Run 的 AC —— 记为 parent_cancel（§16）
    if (context.signal) {
      if (context.signal.aborted) {
        ac.abort();
      } else {
        try {
          context.signal.addEventListener('abort', () => {
            const r = this._runs.get(runId);
            if (r && !r.abortReason) r.abortReason = 'parent_cancel';
            if (r?.runtimeMode === 'sidecar') this._sidecar.cancel(runId, 'parent_cancel');
            ac.abort();
          }, { once: true });
        } catch { /* noop */ }
      }
    }

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      agent: null,
      projectRoot,
      projectRootApplied: false,
      projectRootField: null,
      taskText,
      abortReason: context.signal && context.signal.aborted ? 'parent_cancel' : null,
      context: context || {},
      summary: '',
      errors: [],
      warnings: [],
      changedFiles: [],
      usage: null,
      iterations: 0,
      sanitizedRaw: null,
      lateResultIgnored: false,
      runtimeMode: this._useLegacyBridge() ? 'legacy-test-bridge' : 'sidecar',
      runtimeProvenance: null
    };
    this._runs.set(runId, runState);
    this._gate.init(runId, LIFECYCLE.STARTING);

    // 后台执行（不 await）：仅当尚未进入终态时才以 FAILED 兜底（终态一次）
    const execution = runState.runtimeMode === 'sidecar'
      ? this._executeSidecar(runId, clineConfig, taskText, task, context)
      : this._executeCline(runId, clineConfig, taskText, task, context);
    execution.catch(err => {
      const run = this._runs.get(runId);
      const cls = this._classifyFailure(run, err);
      const tr = this._finish(runId, cls.status, cls.reason,
        this._buildResult(run, cls.status, { extraErrors: [err && err.message ? err.message : String(err)] }));
      if (!tr.accepted && run) {
        run.errors = sanitizeErrors([...(run.errors || []), err && err.message ? err.message : String(err)]);
      }
    });

    return { runId };
  }

  /**
   * v2.8.1 §37 — Cline Tool Approval 统一入口。
   *
   * ClineCore sidecar 是独立 Node 22 进程，协议只有 host→sidecar 的命令与
   * sidecar→host 的事件，没有同步回问通道，因此**无法**做 per-invocation 的
   * GUI 审批（不重写 Cline Runtime 是 §37 的显式约束）。
   *
   * 本轮建立的统一入口是「scope 下发前必须经 Permission Broker 交集」：
   * 此前该方法直接透传 task/context 的 allowedScopes，`task.readOnly` 被完全
   * 忽略——只读父 Run 依然可能把 `filesystem.write` / `terminal.write` 下发给
   * sidecar。现在每个候选 scope 都映射为 broker 的 operation 后逐个 evaluate，
   * 未通过或无法识别的 scope 一律剥离（fail-closed）。
   *
   * 局限（不伪造，见 §38）：Cline 的权限中介粒度是 scope-level，不是
   * per-command risk-level。命令级风险分级对 Cline 不可用。
   */
  _resolveAllowedScopes(task, context) {
    const explicit = task.allowedScopes || (context && context.allowedScopes);
    const requested = Array.isArray(explicit)
      ? [...new Set(explicit.filter(scope => typeof scope === 'string'))]
      // Without a permission-engine grant, the production runtime remains read-only.
      : ['filesystem.read'];

    const parentRunPermission = task.readOnly ? 'read' : 'write';
    const manifestScopes = (this.manifest && this.manifest.allowedScopes) || null;
    const externalAgentPolicy = Array.isArray(manifestScopes)
      ? manifestScopes.map(scope => CLINE_SCOPE_OPERATION[scope]).filter(Boolean)
      : undefined;

    const granted = [];
    for (const scope of requested) {
      const operation = CLINE_SCOPE_OPERATION[scope];
      // 未知 scope：sidecar 的 buildToolPolicies 也不认识，直接剥离而不是透传。
      if (!operation) continue;
      const evaluation = permissionBroker.evaluate({ operation }, {
        parentRunPermission,
        externalAgentPolicy
      });
      if (evaluation.granted) granted.push(scope);
    }
    return granted;
  }

  _consumeMappedEvent(run, mapped, context) {
    if (context && typeof context.emit === 'function') {
      try { context.emit(mapped.type, mapped.data); } catch { /* listener isolation */ }
    }
    if (mapped.type === AGENT_EVENT.MESSAGE && typeof mapped.data?.text === 'string') run.summary += mapped.data.text;
    if (mapped.type === AGENT_EVENT.RUN_FAILED || mapped.type === AGENT_EVENT.TOOL_FAILED) {
      const message = mapped.data?.error || mapped.data?.message;
      if (message) run.errors.push(String(message));
    }
    if (mapped.type === AGENT_EVENT.FILE_CHANGED && mapped.data?.path && !run.changedFiles.includes(mapped.data.path)) {
      run.changedFiles.push(mapped.data.path);
    }
    if (mapped.type === AGENT_EVENT.RUN_STATUS && mapped.data?.usage) run.usage = mapped.data.usage;
    if (mapped.type === AGENT_EVENT.RUN_STATUS && Number.isInteger(mapped.data?.iteration)) run.iterations = mapped.data.iteration;
  }

  async _executeSidecar(runId, clineConfig, taskText, task, context) {
    const run = this._runs.get(runId);
    if (!run) return;
    if (!run.projectRoot) {
      throw Object.assign(new Error('ClineCore Sidecar requires an explicit projectRoot'), { code: 'CLINE_WORKSPACE_INVALID' });
    }
    run.status = LIFECYCLE.RUNNING;
    const timeoutMs = task.timeoutMs || this.config?.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;
    const runtimePayload = {
      prompt: taskText,
      providerId: clineConfig.providerId,
      modelId: clineConfig.modelId,
      apiKey: clineConfig.apiKey,
      baseUrl: clineConfig.baseUrl,
      headers: clineConfig.headers,
      systemPrompt: task.systemPrompt || this.config?.systemPrompt || undefined,
      maxIterations: task.maxIterations || this.config?.maxIterations || DEFAULT_MAX_ITERATIONS,
      allowedScopes: this._resolveAllowedScopes(task, context),
      parentRunId: task.parentRunId || context.parentRunId || null,
      delegationPath: Array.isArray(task.delegationPath) ? task.delegationPath.slice(0, 32) : []
    };
    try {
      const response = await this._sidecar.run({
        runId,
        projectRoot: run.projectRoot,
        timeoutMs,
        payload: runtimePayload,
        onStarted: payload => {
          if (this._gate.isTerminal(runId)) return;
          run.projectRootApplied = payload.workspace === run.projectRoot;
          run.projectRootField = 'manifest.cwd/workspace_root';
          run.sessionId = payload.sessionId || null;
        },
        onEvent: rawEvent => {
          if (this._gate.isTerminal(runId)) {
            run.lateResultIgnored = true;
            return;
          }
          for (const mapped of mapClineEvents(rawEvent, runId, this.manifest.id)) this._consumeMappedEvent(run, mapped, context);
        }
      });

      if (this._gate.isTerminal(runId)) {
        run.lateResultIgnored = true;
        return;
      }
      const payload = response.payload || {};
      run.runtimeProvenance = payload.provenance || null;
      const raw = payload.result || {};
      if (Array.isArray(raw.changedFiles)) {
        const newlyChanged = raw.changedFiles.filter(file => !run.changedFiles.includes(file));
        run.changedFiles = [...new Set([...run.changedFiles, ...raw.changedFiles])];
        for (const file of newlyChanged) {
          this._consumeMappedEvent(run, { type: AGENT_EVENT.FILE_CHANGED, data: { path: file } }, context);
        }
      }
      if (raw.usage) run.usage = raw.usage;
      if (Number.isInteger(raw.iterations)) run.iterations = raw.iterations;
      const extraErrors = payload.error?.message ? [payload.error.message] : [];
      if (response.type === 'run.result') {
        this._finish(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE', this._buildResult(run, LIFECYCLE.COMPLETED, { raw }));
      } else if (response.type === 'run.cancelled') {
        this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED', this._buildResult(run, LIFECYCLE.CANCELLED, { raw, extraErrors }));
      } else if (response.type === 'run.timeout') {
        this._finish(runId, LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT', this._buildResult(run, LIFECYCLE.TIMEOUT, { raw, extraErrors }));
      } else {
        this._finish(runId, LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR', this._buildResult(run, LIFECYCLE.FAILED, {
          raw,
          extraErrors: extraErrors.length ? extraErrors : ['ClineCore run failed']
        }));
      }
    } finally {
      // Credentials are deliberately kept out of run state and cleared as soon
      // as the serialized request has reached a terminal outcome.
      runtimePayload.apiKey = undefined;
      runtimePayload.headers = undefined;
      clineConfig.apiKey = undefined;
      clineConfig.headers = undefined;
    }
  }

  async _executeCline(runId, clineConfig, taskText, task, context) {
    const run = this._runs.get(runId);
    if (!run) return;
    run.status = LIFECYCLE.RUNNING;

    const timeoutMs = task.timeoutMs || (this.config && this.config.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS;

    // 超时定时器：超时 → TIMEOUT（与取消分离，§17/§18）
    const timer = setTimeout(() => {
      const r = this._runs.get(runId);
      if (!r || this._gate.isTerminal(runId)) return;
      r.abortReason = 'timeout';
      const ctx = r.context || {};
      if (ctx.emit) {
        try { ctx.emit(AGENT_EVENT.RUN_TIMEOUT, { runId, agentId: this.manifest.id, timeoutMs }); } catch { /* noop */ }
      }
      this._finish(runId, LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT',
        this._buildResult(r, LIFECYCLE.TIMEOUT, { extraErrors: [`cline run exceeded ${timeoutMs}ms without a terminal result`] }));
      this._cancelAgent(r.agent);
      try { r.ac.abort(); } catch { /* noop */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      // 事件回调：Cline 原生事件 → eventMapper → context.emit
      const onEvent = (rawEvent) => {
        let mapped = null;
        try { mapped = mapClineEvent(rawEvent, runId, this.manifest.id); } catch { /* drop malformed */ }
        if (!mapped) return;
        if (context && typeof context.emit === 'function') {
          try { context.emit(mapped.type, mapped.data); } catch { /* listener must not break the run */ }
        }
        // 累积流式文本与错误，供终态结果使用
        if (mapped.type === AGENT_EVENT.MESSAGE && mapped.data && typeof mapped.data.text === 'string') {
          run.summary = (run.summary || '') + mapped.data.text;
        }
        if (mapped.type === AGENT_EVENT.RUN_FAILED || mapped.type === AGENT_EVENT.TOOL_FAILED) {
          const em = (mapped.data && (mapped.data.error || mapped.data.message)) || '';
          if (em) run.errors.push(String(em));
        }
        if (mapped.type === AGENT_EVENT.FILE_CHANGED && mapped.data && mapped.data.path) {
          if (!run.changedFiles.includes(mapped.data.path)) run.changedFiles.push(mapped.data.path);
        }
        if (mapped.type === AGENT_EVENT.RUN_STATUS && mapped.data && mapped.data.usage) {
          run.usage = mapped.data.usage;
        }
      };

      const agentConfig = {
        providerId: clineConfig.providerId,
        modelId: clineConfig.modelId,
        apiKey: clineConfig.apiKey,
        systemPrompt: task.systemPrompt || (this.config && this.config.systemPrompt) || undefined,
        maxIterations: task.maxIterations || (this.config && this.config.maxIterations) || DEFAULT_MAX_ITERATIONS,
        // §37：workspace 根目录必须真实传给 SDK，不能只存在适配器变量里
        cwd: run.projectRoot || undefined
      };

      const agent = await this._bridge.createAgent(agentConfig, onEvent);
      run.agent = agent;

      // §37 回读：SDK 是否真的接住了 projectRoot；没接住就如实标注，不假装已沙箱化
      const describe = typeof this._bridge.describeAgentWorkspace === 'function'
        ? this._bridge.describeAgentWorkspace
        : localDescribeAgentWorkspace;
      const ws = describe(agent, run.projectRoot);
      run.projectRootApplied = !!ws.applied;
      run.projectRootField = ws.field || null;
      if (run.projectRoot && !run.projectRootApplied) {
        run.warnings.push(
          'projectRoot was passed to @cline/sdk (cwd / workspacePath / workingDirectory) but the ' +
          'constructed Agent does not expose it; workspace scoping is unverified (spec §37)'
        );
      }

      // SDK 可能同时支持 subscribe —— 注册同一回调以兼容只走 subscribe 的实现
      if (agent && typeof agent.subscribe === 'function') {
        try { agent.subscribe(onEvent); } catch { /* already wired via onEvent */ }
      }

      // 已在等待期间被取消 / 超时
      if (run.ac.signal.aborted || this._gate.isTerminal(runId)) {
        this._cancelAgent(agent);
        if (!this._gate.isTerminal(runId)) {
          const cls = this._classifyFailure(run, null);
          this._finish(runId, cls.status, cls.reason, this._buildResult(run, cls.status));
        }
        return;
      }

      // abort 联动：取消 / 超时时调用 agent.cancel()
      const onAbort = () => this._cancelAgent(agent);
      try { run.ac.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ }

      const raw = await agent.run(taskText);

      // §20-§23 晚期结果保护：闸门已终态（取消 / 超时先到）→ 直接丢弃
      if (this._gate.isTerminal(runId)) {
        run.lateResultIgnored = true;
        return;
      }

      // 取消 / 超时意图优先于返回值
      if (run.abortReason === 'timeout') {
        this._finish(runId, LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT', this._buildResult(run, LIFECYCLE.TIMEOUT));
        return;
      }
      if (run.abortReason || run.ac.signal.aborted) {
        this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED',
          this._buildResult(run, LIFECYCLE.CANCELLED, { raw, extraErrors: ['用户已停止'] }));
        return;
      }

      // §11/§12：只有显式终态证据才能判 COMPLETED
      const outcome = classifyRunOutcome(raw);
      if (outcome.cancelled) {
        this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED',
          this._buildResult(run, LIFECYCLE.CANCELLED, { raw, extraErrors: ['cline agent reported cancelled'] }));
        return;
      }
      if (outcome.failed) {
        this._finish(runId, LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR',
          this._buildResult(run, LIFECYCLE.FAILED, { raw, extraErrors: [outcome.error] }));
        return;
      }
      if (!outcome.terminal) {
        this._finish(runId, LIFECYCLE.FAILED, 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL',
          this._buildResult(run, LIFECYCLE.FAILED, {
            raw,
            extraErrors: ['@cline/sdk agent.run() resolved without a terminal result (no text / usage / status evidence)']
          }));
        return;
      }
      this._finish(runId, LIFECYCLE.COMPLETED, 'AGENT_DONE', this._buildResult(run, LIFECYCLE.COMPLETED, { raw }));
    } catch (err) {
      if (this._gate.isTerminal(runId)) {
        run.errors = sanitizeErrors([...(run.errors || []), err && err.message ? err.message : String(err)]);
        return;
      }
      const cls = this._classifyFailure(run, err);
      this._finish(runId, cls.status, cls.reason,
        this._buildResult(run, cls.status, { extraErrors: [err && err.message ? err.message : String(err)] }));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 失败分类（§16-§19 / §27）：先判取消 / 超时意图，再按远端状态码分类。
   * @returns {{ status: string, reason: string }}
   */
  _classifyFailure(run, err) {
    const reasonTag = run && run.abortReason;
    if (reasonTag === 'timeout') return { status: LIFECYCLE.TIMEOUT, reason: 'AGENT_TIMEOUT' };
    if (reasonTag === 'user_cancel' || reasonTag === 'parent_cancel' || reasonTag === 'shutdown') {
      return { status: LIFECYCLE.CANCELLED, reason: 'AGENT_CANCELLED' };
    }
    if (run && run.ac && run.ac.signal.aborted) return { status: LIFECYCLE.CANCELLED, reason: 'AGENT_CANCELLED' };
    const code = err && (err.httpStatus || err.status || err.statusCode);
    if (code === 401 || code === 403) return { status: LIFECYCLE.FAILED, reason: 'AGENT_AUTH_FAILED' };
    if (code === 404) return { status: LIFECYCLE.FAILED, reason: 'AGENT_SESSION_NOT_FOUND' };
    if (typeof code === 'number' && code >= 500) return { status: LIFECYCLE.FAILED, reason: 'AGENT_REMOTE_ERROR' };
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      return { status: LIFECYCLE.FAILED, reason: 'AGENT_UNAVAILABLE' };
    }
    return { status: LIFECYCLE.FAILED, reason: 'AGENT_REMOTE_ERROR' };
  }

  /**
   * 单一终态漏斗：经闸门 transition（terminal once）；仅首次进入终态时通知 Hub。
   * @returns {{ accepted:boolean, status:string, terminal:boolean, terminalCount:number }}
   */
  _finish(runId, status, reason, result) {
    const run = this._runs.get(runId);
    if (!run) return { accepted: false, status, terminal: false, terminalCount: 0, late: true };
    const tr = this._gate.transition(runId, status, reason);
    run.status = tr.status;
    if (tr.accepted) {
      run.result = result || run.result || null;
      const ctx = run.context || {};
      if (typeof ctx.finishRun === 'function') {
        try { ctx.finishRun(this._lifecycleToResultStatus(tr.status), run.result); } catch { /* noop */ }
      }
    }
    return tr;
  }

  _lifecycleToResultStatus(status) {
    if (status === LIFECYCLE.COMPLETED) return 'completed';
    if (status === LIFECYCLE.CANCELLED) return 'cancelled';
    if (status === LIFECYCLE.TIMEOUT) return 'timeout';
    return 'failed';
  }

  /** 统一结果契约（§39）+ 脱敏（§41）。 */
  _buildResult(run, status, extra = {}) {
    if (!run) {
      return buildExternalResult({ agentId: this.manifest.id, runId: null, status: 'failed' });
    }
    const parsed = extra.raw !== undefined ? parseClineResult(extra.raw, this._lifecycleToResultStatus(status)) : null;
    const errors = sanitizeErrors([...(run.errors || []), ...(extra.extraErrors || [])]);
    const summary = (parsed && parsed.summary) || run.summary || '';
    const changedFiles = (parsed && parsed.changedFiles.length ? parsed.changedFiles : null) || run.changedFiles || [];
    const usage = (parsed && parsed.usage) || run.usage || null;
    const result = buildExternalResult({
      agentId: this.manifest.id,
      runId: run.runId,
      status: this._lifecycleToResultStatus(status),
      summary,
      findings: [],
      changedFiles,
      usage,
      errors,
      startedAt: run.startedAt,
      provenance: {
        agent: 'cline',
        transport: run.runtimeMode === 'sidecar' ? 'sidecar-jsonl' : 'sdk-test-bridge',
        integration: run.runtimeMode === 'sidecar' ? 'ClineCore Sidecar' : 'Injected fake SDK',
        projectRoot: run.projectRoot || null,
        projectRootApplied: !!run.projectRootApplied,
        projectRootField: run.projectRootField || null,
        ...(run.runtimeProvenance || {})
      }
    });
    result.iterations = parsed ? parsed.iterations : (run.iterations || 0);
    // §40：只保留有限长度、已脱敏的 raw 摘要，绝不落完整 raw
    result.sanitizedRaw = parsed ? parsed.sanitizedRaw : (run.sanitizedRaw || null);
    result.warnings = [...(run.warnings || [])];
    return result;
  }

  _cancelAgent(agent) {
    if (!agent) return;
    if (typeof agent.cancel === 'function') {
      try { agent.cancel(); } catch { /* already cancelled */ }
    }
    if (typeof agent.abort === 'function') {
      try { agent.abort(); } catch { /* noop */ }
    }
  }

  /** sendMessage：Cline Agent 单次 run 不支持运行中追加消息。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'cline agent does not support mid-run messages' };
  }

  /**
   * 取消（§16/§18）：标记 user_cancel → 经闸门进入 CANCELLED → 发 agent.run.cancelled → abort。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    if (!run.abortReason) run.abortReason = 'user_cancel';
    if (run.runtimeMode === 'sidecar') this._sidecar.cancel(runId, 'user_cancel');
    this._cancelAgent(run.agent);
    const tr = this._finish(runId, LIFECYCLE.CANCELLED, 'AGENT_CANCELLED',
      this._buildResult(run, LIFECYCLE.CANCELLED, { extraErrors: ['用户已停止'] }));
    if (tr.accepted) {
      const ctx = run.context || {};
      if (typeof ctx.emit === 'function') {
        try { ctx.emit(AGENT_EVENT.RUN_CANCELLED, { runId, agentId: this.manifest.id }); } catch { /* noop */ }
      }
    }
    try { run.ac.abort(); } catch { /* already aborted */ }
    return { ok: true };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: this._gate.getStatus(runId) || run.status, startedAt: run.startedAt };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：取消所有在跑的 Cline run（abortReason='shutdown'，与用户取消区分）。 */
  async dispose() {
    for (const [runId, run] of this._runs) {
      try {
        if (!run.abortReason) run.abortReason = 'shutdown';
        this._cancelAgent(run.agent);
        if (!this._gate.isTerminal(runId)) {
          try { run.ac.abort(); } catch { /* noop */ }
        }
      } catch { /* non-fatal */ }
    }
    this._runs.clear();
    this._gate.clear();
    this._detected = null;
    await this._sidecar.dispose();
  }
}

module.exports = { ClineAgentAdapter, parseClineResult, classifyRunOutcome, localDescribeAgentWorkspace };
