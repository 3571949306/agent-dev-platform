'use strict';
/**
 * IPC handlers — the bridge between the renderer (window.api) and all services.
 * High-privilege operations (filesystem, terminal, computer, git) run ONLY here
 * in the main process, never exposed over HTTP.
 */
const { ipcMain, dialog, shell, app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('../db/store');
const registry = require('../tools/registry');
const providers = require('../providers');
const capabilities = require('../providers/capabilities');
const { runAgentTurn } = require('../agent/runtime');
const { runSubAgent } = require('../agent/subagent');
const { buildToolDefs, subAgentIdFromToolName } = require('../agent/context');
const { PermissionEngine } = require('../security/permissions');
const { McpManager } = require('../services/mcp');
const { createBrowserTools } = require('../services/browser');
const { createComputerTools } = require('../services/computer');
const extAgents = require('../services/externalAgents');
const { DesktopAgentBridge } = require('../services/desktopBridge');
const { pickVisionModel } = require('../services/visionReader');
const { RunManager } = require('../agent/runManager');
// v2.6.0 — Main Agent Runtime（自主编码闭环）。独立 IPC 模块，避免 handlers.js 膨胀。
const mainAgentIpc = require('./mainAgent');
// v2.7.0 — Agent Integration Hub
const { createAgentHub, setAgentHub } = require('../agents/hub/agentHub');
const { createAgentRegistry } = require('../agents/hub/agentRegistry');
const { createAgentRouter } = require('../agents/hub/agentRouter');
const { createHealthManager } = require('../agents/hub/healthManager');
const { createLifecycleManager } = require('../agents/hub/lifecycleManager');
const { createEventNormalizer } = require('../agents/hub/eventNormalizer');
const { createRunBridge } = require('../agents/hub/runBridge');
const { createCapabilityRegistry } = require('../agents/hub/capabilityRegistry');
const { BUILTIN_AGENT_MANIFESTS } = require('../agents/manifests/builtinAgents');
const { NativeAgentAdapter } = require('../agents/adapters/nativeAgentAdapter');
const { CodexAgentAdapter } = require('../agents/adapters/codexAgentAdapter');
const { WorkBuddyAgentAdapter } = require('../agents/adapters/workBuddyAgentAdapter');
// v2.7.1 — External Agent Pack
const { ClineAgentAdapter } = require('../agents/adapters/clineAgentAdapter');
const { OpenCodeAgentAdapter } = require('../agents/adapters/openCodeAgentAdapter');
const { OpenHandsAgentAdapter } = require('../agents/adapters/openHandsAgentAdapter');
const { ClaudeCodeAgentAdapter } = require('../agents/adapters/claudeCodeAgentAdapter');
const { createOpenCodeServerManager } = require('../agents/integrations/opencode/serverManager');
const { createDbSessionPersistence } = require('../agents/session/externalAgentSessionManager');
const { createProjectMutationLock } = require('../security/projectMutationLock');

const mcpManager = new McpManager();
const browser = createBrowserTools();
const computer = createComputerTools();
const mcpToolMap = new Map();
const dynamicTools = new Map();

for (const [n, fn] of Object.entries(browser.execs)) dynamicTools.set(n, { def: browser.defs.find(d => d.name === n), exec: fn, permission: 'computer', source: 'browser' });
for (const [n, fn] of Object.entries(computer.execs)) dynamicTools.set(n, { def: computer.defs.find(d => d.name === n), exec: fn, permission: 'computer', source: 'computer' });

let mainWindow = null;
let currentProjectId = null;
const activeRuns = new Map();
const pendingPermissions = new Map();

// E2E 测试钩子：externalImport:selectFile 一次性返回的文件路径（仅测试中设置）
let testFilePickPath = null;

// v2.3.1 (P0-2/P0-3/P0-4) — 全应用唯一的 Run 状态机。只有它能宣布 Run 终态。
const runManager = new RunManager({ store, emit });

// v2.7.0 — Agent Integration Hub
const capabilityRegistry = createCapabilityRegistry();
const agentRegistry = createAgentRegistry();
const agentPreferences = store.agentPrefs || { getRoutingMode: () => 'auto', getPreferredAgent: () => null, getDisabledAgents: () => [] };
const agentRouter = createAgentRouter({ registry: agentRegistry, preferences: agentPreferences });
const healthManager = createHealthManager({ registry: agentRegistry });
const lifecycleManager = createLifecycleManager({ emit });
const eventNormalizer = createEventNormalizer({ emit });
const runBridge = createRunBridge({ runManager, lifecycleManager, emit });
// v2.7.1 — Project Mutation Lock & OpenCode server manager（在 createAgentHub 之前创建）
const openCodeServerManager = createOpenCodeServerManager();
const projectLock = createProjectMutationLock();
const agentHub = createAgentHub({ registry: agentRegistry, router: agentRouter, healthManager, lifecycleManager, eventNormalizer, runBridge, emit, projectLock });
setAgentHub(agentHub);

// Register built-in adapters
// v2.8.0 — 外部 Agent 会话落库后端（spec §110/§111）。DB 未就绪（隔离单测）时为 null → 纯内存。
const sessionPersistence = (() => { try { return createDbSessionPersistence(store.externalAgentSessions); } catch { return null; } })();
const nativeAdapter = new NativeAgentAdapter({ manifest: BUILTIN_AGENT_MANIFESTS[0], runMainAgentFn: require('../agent/runtime/mainAgentRuntime').runMainAgent, emit });
agentHub.register(nativeAdapter);
const codexAdapter = new CodexAgentAdapter({ manifest: BUILTIN_AGENT_MANIFESTS[1], store, sessionPersistence });
agentHub.register(codexAdapter);
const workBuddyAdapter = new WorkBuddyAgentAdapter({ manifest: BUILTIN_AGENT_MANIFESTS[2], computerManager: computer.manager });
agentHub.register(workBuddyAdapter);

// v2.7.1 — Register external adapters (Cline, OpenCode, OpenHands)
const clineAdapter = new ClineAgentAdapter({
  manifest: BUILTIN_AGENT_MANIFESTS.find(m => m.id === 'cline'),
  store,
  // Some isolated unit tests load handlers before the database fixture is
  // initialized. Production initialization has a database; tests safely fall
  // back to an empty, honestly degraded Cline configuration.
  config: (() => { try { return store.extAgentConfigs.getCline(); } catch { return {}; } })(),
  dataDir: path.join(app.getPath('userData'), 'cline')
});
const productionClineSidecarManager = clineAdapter._sidecar;
agentHub.register(clineAdapter);
const openCodeAdapter = new OpenCodeAgentAdapter({ manifest: BUILTIN_AGENT_MANIFESTS.find(m => m.id === 'opencode'), store, serverManager: openCodeServerManager });
agentHub.register(openCodeAdapter);
const openHandsAdapter = new OpenHandsAgentAdapter({ manifest: BUILTIN_AGENT_MANIFESTS.find(m => m.id === 'openhands'), store });
agentHub.register(openHandsAdapter);

// v2.8.0 — Claude Code（primary: Claude Agent SDK；fallback: claude -p --output-format stream-json）
const claudeCodeAdapter = new ClaudeCodeAgentAdapter({
  manifest: BUILTIN_AGENT_MANIFESTS.find(m => m.id === 'claude-code'),
  // 与 Cline 同理：隔离单测可能在 DB fixture 就绪前加载 handlers，缺配置时退化为空配置
  config: (() => { try { return store.extAgentConfigs.getClaudeCode(); } catch { return {}; } })(),
  sessionPersistence
});
agentHub.register(claudeCodeAdapter);

let shutdownPromise = null;
async function shutdownServices() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    projectLock.clearAll();
    await Promise.allSettled([
      clineAdapter.dispose(),
      openCodeAdapter.dispose(),
      openHandsAdapter.dispose()
    ]);
  })();
  return shutdownPromise;
}

// v2.7.1 — cleanup on exit（guard：测试环境 mock 的 app 可能没有 .on）
if (app && typeof app.on === 'function') {
  app.on('before-quit', () => {
    void shutdownServices();
  });
}

// v2.4.1 — ProbeManager：真正的 GUI Probe Cancel（abort fetch）+ probeId 生命周期。
const sec = require('../security/secret');
const probeManager = new (require('../providers/onboarding').ProbeManager)({ emit, sec });

function emit(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', { ...(payload || {}), type });
}

function rebuildMcpToolMap() {
  mcpToolMap.clear();
  for (const s of store.mcpServers.list()) {
    for (const t of (s.tools || [])) mcpToolMap.set(t.name, { serverId: s.id, def: { name: t.name, description: t.description, input_schema: t.input_schema } });
  }
}

function getTool(name) {
  const b = registry.getBuiltin(name);
  if (b) return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
  if (mcpToolMap.has(name)) {
    const m = mcpToolMap.get(name);
    return { def: m.def, exec: (ctx, args) => mcpManager.callTool(m.serverId, name, args), permission: 'mcp', source: 'mcp' };
  }
  if (dynamicTools.has(name)) return dynamicTools.get(name);
  return null;
}

function subAgentsFor(agent) { return (agent.sub_agent_ids || []).map(id => store.agents.get(id) || store.externalAgents.get(id)).filter(Boolean); }

// P1-4 — the four cross-chat tools. Main agents get them automatically (they are
// the orchestrators); any other agent can still opt in via its `tools` list.
const CHAT_TOOL_NAMES = ['list_project_chats', 'get_chat_summary', 'send_message_to_chat', 'get_chat_status'];

function buildToolDefsFor(agent) {
  const mcpDefs = [...mcpToolMap.values()].map(m => m.def);
  const defs = buildToolDefs(agent, { mcpDefs, subAgents: subAgentsFor(agent) });
  // v2.3.2 (§42): is_main 是唯一判据，不再依赖显示名称 /main/i.test(name)。
  // Computer 操作员同样需要 browser+computer 工具集。
  const isMain = !!(agent.is_main || agent.type === 'computer');
  if (isMain) defs.push(...browser.defs, ...computer.defs);
  if (isMain) {
    const have = new Set(defs.map(d => d.name));
    for (const name of CHAT_TOOL_NAMES) {
      if (have.has(name)) continue;
      const b = registry.getBuiltin(name);
      if (b) defs.push({ name: b.def.name, description: b.def.description, parameters: b.def.input_schema });
    }
  }
  return defs;
}

function getAgentFull(id) { return store.agents.get(id) || store.externalAgents.get(id); }

async function buildProvider(agent) {
  const conn = store.connections.getDecrypted(agent.api_connection_id);
  if (!conn) throw new Error(`智能体「${agent.name}」未绑定 API 连接`);
  return providers.getProvider(conn);
}

/**
 * P0-1 — the single place that decides which model id goes on the wire.
 * Providers are NOT allowed to substitute conn.models[0] on their own any more;
 * every fallback that happens here is reported (source / fellBack) and recorded
 * in the model_calls table so "why did it use that model?" is answerable.
 */
function resolveModelFor(agent, override) {
  const raw = agent && agent.api_connection_id ? store.connections.get(agent.api_connection_id) : null;
  const r = providers.resolveModel({ agent, conn: raw, override });
  return {
    ...r,
    provider: raw ? raw.provider : (agent && agent.provider) || null,
    connectionId: raw ? raw.id : null,
    connectionName: raw ? raw.name : null
  };
}

/** Does the model this Agent will actually use accept image input? */
function visionSupportFor(agent) {
  const info = resolveModelFor(agent);
  if (!info.model) return false;
  // A tested probe (Diagnostics page) always beats a guess from the model id.
  if (info.connectionId) {
    const caps = store.models.caps(info.connectionId, info.model);
    if (caps && caps.vision && typeof caps.vision.value === 'boolean' && caps.vision.state === 'tested') return caps.vision.value;
    if (caps && typeof caps.vision === 'boolean') return caps.vision;
  }
  return providers.inferVision(info.model).value === true;
}

/**
 * P0-4 — the vision model the WorkBuddy bridge falls back to when the target
 * window exposes no UI-automation text.
 *
 * An adapter can pin one explicitly (config.visionConnectionId / visionModel);
 * otherwise we look for a probe-tested vision model, then guess from model ids.
 * Returns null when the user has none, so the bridge reports
 * VISION_MODEL_REQUIRED instead of silently doing nothing.
 */
function visionReaderFor(adapter) {
  const cfg = (adapter && adapter.config) || {};
  if (cfg.visionFallback === false) return null;
  try {
    return pickVisionModel({ store, providers }, {
      connectionId: cfg.visionConnectionId || (adapter && adapter.api_connection_id) || null,
      model: cfg.visionModel || null
    });
  } catch { return null; }
}

function artifactsDirFor(project) {
  const base = project && project.root_path
    ? path.join(project.root_path, '.adp', 'artifacts')
    : path.join(app.getPath('userData'), 'artifacts');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* best effort */ }
  return base;
}

function requestPermission(req) {
  return new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingPermissions.set(reqId, resolve);
    emit('permission_request', { reqId, ...req });
  });
}

/** Hard ceiling on chat→chat delegation so A→B→A can never loop forever. */
const MAX_CHAT_DELEGATION_DEPTH = 2;

/**
 * P1-4 — run one turn in ANOTHER conversation on behalf of the caller and hand
 * the answer back. `messageId` (when present) is the agent_messages row that
 * tracks this delegation, so async (wait:false) deliveries also reach a
 * terminal status instead of sitting on `pending` forever.
 */
async function sendChatTask({ toConversationId, message, depth = 0, messageId = null, delegationPath = [] }) {
  const conv = store.conversations.get(toConversationId);
  if (!conv) {
    if (messageId) store.agentMessages.update(messageId, { status: 'failed', payload: { error: '目标聊天不存在' } });
    throw new Error('目标聊天不存在');
  }
  // P1-6 second line of defence: the tool checks the path, but sendChatTask is
  // also reachable from the async (wait:false) branch and from tests.
  if (Array.isArray(delegationPath) && delegationPath.slice(0, -1).includes(toConversationId)) {
    const err = `检测到跨对话循环委派，已阻止：${[...delegationPath].join(' → ')}`;
    if (messageId) store.agentMessages.update(messageId, { status: 'failed', payload: { error: err } });
    throw new Error(err);
  }
  if (messageId) store.agentMessages.update(messageId, { status: 'running' });
  try {
    await runChatTurn(toConversationId, conv.agent_id, message, { chatDepth: depth, delegationPath });
  } catch (e) {
    if (messageId) store.agentMessages.update(messageId, { status: 'failed', payload: { error: e.message } });
    throw e;
  }
  const msgs = store.messages.list(toConversationId);
  const last = msgs.filter(m => m.role === 'assistant').pop();
  const reply = last ? last.content : '';
  if (messageId) store.agentMessages.update(messageId, { status: 'completed', payload: { reply } });
  return reply;
}

/**
 * Run 一个对话回合，返回正式业务结果：
 *   { status: 'completed'|'failed'|'cancelled'|'timeout'|'interrupted', result, error, taskId }
 *
 * v2.3.1 (P0-2) — Promise resolve ≠ 业务成功。调用方（agent:send）必须根据
 * 返回的 status 决定终态，禁止无条件 completed。
 */
async function runChatTurn(conversationId, agentId, userMessage, opts = {}) {
  const runId = opts.runId || null;
  const rm = opts.runManager || runManager;
  const agent = getAgentFull(agentId);
  const conv = store.conversations.get(conversationId);
  const project = conv && conv.project_id ? store.projects.get(conv.project_id) : null;
  const projectRoot = project ? project.root_path : (currentProjectId ? store.projects.get(currentProjectId)?.root_path : null);
  if (!agent) { emit('error', { conversationId, message: '智能体不存在' }); return { status: 'failed', result: null, error: '智能体不存在', taskId: null }; }

  if (agent.type === 'external') {
    rm.updateRun(runId, 'waiting_external_agent', { conversationId });
    store.messages.create({ conversation_id: conversationId, role: 'user', content: userMessage });
    emit('assistant_status', { conversationId, status: '正在调用外部智能体 ' + agent.name });
    // v2.1.0: external runs are now cancellable and stream their state machine
    // progress, exactly like native agent turns do.
    const extAc = new AbortController();
    activeRuns.set(conversationId, extAc);
    const STATE_LABEL = {
      locating: '定位目标窗口', focusing: '聚焦窗口', inputting: '输入任务',
      submitted: '已提交，等待对方开始', waiting: '等待对方完成', reading: '读取回答',
      degrading: '窗口读不到文本，改用截图 + 视觉模型',
      'vision-reading': '视觉读屏中', 'vision-poll': '视觉读屏中', 'vision-error': '视觉读屏出错',
      completed: '已完成', failed: '失败', timeout: '超时', cancelled: '已取消'
    };
    let res;
    try {
      // Same ExternalAgentContext the sub-agent path builds — an external agent
      // launched straight from a chat must be gated, cancellable and rooted in
      // the current project exactly like a delegated one.
      res = await extAgents.runExternalAgent(agent, userMessage, {
        projectId: project?.id || currentProjectId || null,
        projectRoot,
        conversationId,
        store,
        computerManager: computer.manager,
        permissionEngine: new PermissionEngine({ store, projectId: project?.id || null }),
        requestPermission,
        visionReader: visionReaderFor(agent),
        signal: extAc.signal,
        emit,
        onState: (state, detail) => emit('assistant_status', {
          conversationId,
          status: `${agent.name}：${STATE_LABEL[state] || state}${detail && detail.error ? ' — ' + detail.error : ''}`
        }),
        onChunk: (text) => emit('assistant_text', { conversationId, chunk: text })
      });
    } finally {
      activeRuns.delete(conversationId);
      emit('assistant_status', { conversationId, status: '' }); // never leave the spinner stuck
    }
    store.messages.create({ conversation_id: conversationId, role: 'assistant', content: res, model: agent.name });
    emit('assistant_message', { conversationId, content: res });
    // v2.3.1 (P0-4) — External 四态（completed/failed/cancelled/timeout）统一映射为正式结果，
    // 终态由 agent:send 的 finishRun 统一宣布，这里不再直接 emit 终态。
    const mapped = extAgents.mapExternalResult(res);
    return { status: mapped.status, result: res, error: mapped.error, taskId: null };
  }
  if (!projectRoot) { emit('error', { conversationId, message: '未打开项目，无法执行本地工具' }); return { status: 'failed', result: null, error: '未打开项目', taskId: null }; }

  const ac = new AbortController();
  activeRuns.set(conversationId, ac);
  rm.updateRun(runId, 'requesting_model', { conversationId });
  const pe = new PermissionEngine({ store, projectId: project?.id || null });
  const deps = {
    store, project, projectRoot, abortSignal: ac.signal,
    permissionEngine: pe, buildProvider, getTool,
    resolveModel: resolveModelFor,
    visionSupport: visionSupportFor,
    artifactsDir: artifactsDirFor(project),
    subAgentTool: (name) => { const id = subAgentIdFromToolName(name); return id ? getAgentFull(id) : null; },
    buildToolDefs: buildToolDefsFor,
    // P0-4: resolved per external adapter, not once per turn — a WorkBuddy
    // adapter may pin its own vision model.
    visionReaderFor,
    runSubAgent: (subDef, args, ctx) => runSubAgent(deps, subDef, args, ctx),
    sendChatTask, requestPermission, computerManager: computer.manager, emit,
    chatDepth: opts.chatDepth || 0,
    maxChatDelegationDepth: MAX_CHAT_DELEGATION_DEPTH,
    delegationPath: Array.isArray(opts.delegationPath) ? opts.delegationPath : [],
    // A chat already mid-turn must not be handed a second task concurrently.
    isChatBusy: (id) => activeRuns.has(id),
    pinnedFacts: store.memories.list('project', project?.id).map(m => m.value)
  };
  store.messages.create({ conversation_id: conversationId, role: 'user', content: userMessage });
  try {
    const r = await runAgentTurn(deps, { agent, conversationId, userMessage, history: store.messages.list(conversationId), toolDefs: buildToolDefsFor(agent) });
    // r = { ok, aborted, error, content, taskId, model } (runtime 已捕获自己的异常)
    if (r.aborted) return { status: 'cancelled', result: r.content || '', error: null, taskId: r.taskId || null };
    if (!r.ok) return { status: classifyError(r.error).status, result: null, error: r.error || null, taskId: r.taskId || null };
    return { status: 'completed', result: r.content || '', error: null, taskId: r.taskId || null };
  } catch (e) {
    const c = classifyError(e);
    return { status: c.status, result: null, error: c.error, taskId: null };
  } finally {
    activeRuns.delete(conversationId);
  }
}

/** 把异常归类为 Run 终态：Abort→cancelled，超时→timeout，其余→failed */
function classifyError(err) {
  const msg = (err && err.message) ? String(err.message) : String(err || '未知错误');
  if (err && (err.aborted === true || err.name === 'AbortError')) return { status: 'cancelled', error: msg };
  if (/\b(abort|aborted|cancelled|canceled)\b/i.test(msg)) return { status: 'cancelled', error: msg };
  if (/超时|timed?out|ETIMEDOUT|timeout/i.test(msg)) return { status: 'timeout', error: msg };
  return { status: 'failed', error: msg };
}

// ---------------- register ----------------
function reg(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function register(window) {
  mainWindow = window;
  rebuildMcpToolMap();

  // v2.6.0 — Main Agent Runtime IPC（自主编码闭环）
  mainAgentIpc.register({
    store, emit, runManager, getTool, buildProvider, resolveModelFor,
    activeRuns, requestPermission,
    getCurrentProject: () => currentProjectId ? store.projects.get(currentProjectId) : null,
    getAgentFull, PermissionEngine
  });

  // projects
  reg('projects:list', () => store.projects.list());
  reg('projects:recent', () => store.projects.list());
  reg('projects:create', (body) => store.projects.create(body));
  reg('projects:update', (id, body) => store.projects.update(id, body));
  reg('projects:remove', (id) => store.projects.remove(id));
  reg('projects:open', (id) => {
    currentProjectId = id;
    const p = store.projects.get(id);
    if (p) store.projects.touch(id);
    healthManager.invalidate('cline');
    return p;
  });
  reg('projects:current', () => currentProjectId ? store.projects.get(currentProjectId) : null);

  // connections
  reg('connections:list', () => store.connections.list());
  reg('connections:create', (body) => store.connections.create(body));
  reg('connections:update', (id, body) => store.connections.update(id, body));
  reg('connections:remove', (id) => store.connections.remove(id));
  reg('connections:test', async (id) => {
    const c = store.connections.get(id); if (!c) throw new Error('连接不存在');
    const conn = store.connections.getDecrypted(id);
    const r = await providers.getProvider(conn).testConnection();
    store.connections.setTestResult(id, { ok: r.ok, error: r.ok ? '' : r.message, latency: r.latency });
    return r;
  });
  reg('connections:models', async (id) => {
    const conn = store.connections.getDecrypted(id);
    const provider = providers.getProvider(conn);
    // P1-7: report where the list came from so the UI can flag hard-coded
    // fallbacks instead of presenting them as if they were fetched live.
    let result;
    if (typeof provider.listModelsDetailed === 'function') {
      result = await provider.listModelsDetailed();
    } else {
      const list = await provider.listModels();
      result = { models: list, source: 'remote' };
    }
    // v2.3.1 (P1-16): merge 而非覆盖 —— 远端结果进 remote，手动添加的模型保留
    const updated = store.connections.mergeModels(id, result.models, result.source || 'remote');
    return { models: updated.models, source: result.source || 'remote', note: result.note || null };
  });
  // P0: 手动添加模型（source='manual'，幂等）
  reg('connections:addModel', (id, modelId) => {
    if (!modelId || !String(modelId).trim()) throw new Error('模型 ID 不能为空');
    const updated = store.connections.addModel(id, String(modelId).trim());
    return { ok: true, models: updated.models };
  });
  // v2.3.1 (P1-18): 收藏统一持久化到 models_json.favorite（唯一真源，重启保留）
  reg('connections:setModelFavorite', (id, modelId, fav) => {
    const updated = store.connections.setModelFavorite(id, modelId, !!fav);
    return { ok: true, models: updated.models };
  });

  // P1-5 — Diagnostics: probe each capability separately against the live
  // endpoint and persist the verdict, so the rest of the app can stop guessing.
  reg('diagnostics:capabilities', async (connectionId, modelId, which) => {
    const conn = store.connections.getDecrypted(connectionId);
    if (!conn) throw new Error('连接不存在');
    const provider = providers.getProvider(conn);
    const model = modelId || providers.resolveModel({ conn }).model;
    const report = await capabilities.detectCapabilities(provider, model, {
      which: Array.isArray(which) && which.length ? which : undefined,
      onProgress: (name, phase, result) =>
        emit('diagnostics_progress', { connectionId, model, name, phase, result })
    });
    // Merge with the pre-probe description so declared/inferred entries survive
    // for anything we did not actually test this round.
    const merged = { ...providers.describeCapabilities(conn, model), ...report };
    store.models.upsert(connectionId, model, merged);
    return merged;
  });
  reg('diagnostics:known', (connectionId, modelId) => {
    if (modelId) return store.models.caps(connectionId, modelId);
    return store.models.listByConnection(connectionId);
  });
  reg('diagnostics:describe', (connectionId, modelId) => {
    const conn = store.connections.get(connectionId);
    return providers.describeCapabilities(conn, modelId);
  });
  reg('diagnostics:modelCalls', (limit) => store.modelCalls.list(limit || 100));
  reg('diagnostics:mismatches', () => store.modelCalls.mismatches());
  // v2.3.2 (P0-2 诊断)：E2E 超时排查用 —— 返回所有活跃 Run + 按 conversation 索引，
  // 让测试在断言失败时能立刻看到 RunManager 真实状态（status / stage / lastActivityAt / error）。
  reg('diagnostics:dumpRuns', () => ({
    runs: runManager.list().map(r => ({
      id: r.id, conversationId: r.conversationId, agentId: r.agentId, taskId: r.taskId,
      status: r.status, stage: r.stage, startedAt: r.startedAt, lastActivityAt: r.lastActivityAt,
      terminalAt: r.terminalAt, error: r.error, message: r.message,
      logTail: (r.log || []).slice(-5)
    })),
    activeRunsByConversation: [...runManager.byConversation.entries()].map(([convId, runId]) => ({ convId, runId })),
    activeAbortControllers: [...activeRuns.keys()]
  }));
  // v2.3.2 (P0-3): E2E 数据库一致性检查 —— 直接读 runs 表，确认 UI 终态 = runs.status。
  reg('runs:get', (id) => store.runs.get(id));
  reg('runs:list', (limit) => store.runs.list(limit || 100));

  // prompts / skills
  reg('prompts:list', () => store.prompts.list());
  reg('prompts:create', (b) => store.prompts.create(b));
  reg('prompts:update', (id, b) => store.prompts.update(id, b));
  reg('prompts:remove', (id) => store.prompts.remove(id));
  reg('skills:list', () => store.skills.list());
  reg('skills:create', (b) => store.skills.create(b));
  reg('skills:remove', (id) => store.skills.remove(id));

  // agents
  reg('agents:list', () => store.agents.list());
  reg('agents:create', (b) => store.agents.create(b));
  reg('agents:update', (id, b) => store.agents.update(id, b));
  reg('agents:remove', (id) => store.agents.remove(id));
  reg('agents:get', (id) => getAgentFull(id));
  // external agents
  reg('externalAgents:list', () => store.externalAgents.list());
  reg('externalAgents:create', (b) => store.externalAgents.create(b));
  reg('externalAgents:update', (id, b) => store.externalAgents.update(id, b));
  reg('externalAgents:remove', (id) => store.externalAgents.remove(id));
  // v2.3.0: 轻量级连接自检 —— 只定位窗口并尝试读取一次 UI 文本，不真的发送任务。
  // 前端「测试 WorkBuddy 桥接」按钮调用。body: { adapter_type, config }
  reg('externalAgents:test', async (id, body) => {
    const adapter = (id && id !== 'workbuddy-test') ? store.externalAgents.get(id) : null;
    const adapterType = adapter ? adapter.adapter_type : ((body && body.adapter_type) || 'workbuddy');
    if (adapterType !== 'workbuddy') return { ok: false, error: '仅 WorkBuddy 桥接支持连接测试。' };
    const cfg = adapter ? (adapter.config || {}) : ((body && body.config) || {});
    if (!computer.manager) return { ok: false, error: 'Computer 运行时不可用。' };
    const bridge = new DesktopAgentBridge({
      computer: computer.manager,
      config: { windowMatch: /workbuddy/i, windowTitle: (cfg && cfg.windowTitle) || 'WorkBuddy', ...(cfg || {}) }
    });
    const started = Date.now();
    const loc = await bridge.locateWindow();
    if (!loc.ok) return { ok: false, error: loc.error, elapsed: ((Date.now() - started) / 1000).toFixed(1) };
    const title = loc.window.title;
    let readVia = 'Windows UI 自动化';
    try {
      const text = await bridge.readWindowText(title);
      if (text == null || (typeof text === 'string' && text.trim() === '')) {
        readVia = '窗口未暴露 UI 文本（可开启视觉降级）';
      }
    } catch { readVia = '窗口未暴露 UI 文本（可开启视觉降级）'; }
    return { ok: true, readVia, window: title, elapsed: ((Date.now() - started) / 1000).toFixed(1) };
  });

  // conversations
  reg('conversations:list', (projectId) => store.conversations.list(projectId));
  reg('conversations:byProject', (projectId) => store.conversations.list(projectId));
  reg('conversations:create', (b) => store.conversations.create(b));
  reg('conversations:get', (id) => store.conversations.getWithMessages(id));
  reg('conversations:remove', (id) => store.conversations.remove(id));

  // messages
  reg('messages:list', (convId) => store.messages.list(convId));
  reg('messages:rate', (id, rating) => store.messages.rate(id, rating));

  // tools registry
  reg('tools:list', () => ([
    ...registry.listBuiltinDefs(),
    ...[...mcpToolMap.values()].map(m => ({ ...m.def, source: 'mcp' })),
    ...[...dynamicTools.values()].filter(d => d.source !== 'builtin').map(d => ({ ...d.def, source: d.source })),
    ...store.tools.list().map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, source: t.source, risk_level: t.risk_level }))
  ]));
  reg('tools:create', (b) => { const r = store.tools.create(b);  return r; });
  reg('tools:update', (id, b) => { const r = store.tools.update(id, b);  return r; });
  reg('tools:remove', (id) => store.tools.remove(id));

  // mcp
  reg('mcp:list', () => store.mcpServers.list());
  reg('mcp:create', (b) => store.mcpServers.create(b));
  reg('mcp:update', (id, b) => store.mcpServers.update(id, b));
  reg('mcp:remove', (id) => { mcpManager.disconnect(id); return store.mcpServers.remove(id); });
  reg('mcp:connect', async (id) => {
    const s = store.mcpServers.get(id); if (!s) throw new Error('服务器不存在');
    const toolsList = await mcpManager.connect(s);
    store.mcpServers.setStatus(id, 'connected', toolsList);
    rebuildMcpToolMap();
    return { status: 'connected', tools: toolsList };
  });
  reg('mcp:disconnect', (id) => { mcpManager.disconnect(id); store.mcpServers.setStatus(id, 'disconnected', []); rebuildMcpToolMap(); return { ok: true }; });
  reg('mcp:call', async (serverId, name, args) => ({ result: await mcpManager.callTool(serverId, name, args) }));

  // tasks / memories / usage / audit / settings
  reg('tasks:list', (projectId) => store.tasks.list(projectId));
  reg('tasks:get', (id) => store.tasks.get(id));
  reg('memories:list', (layer, projectId) => store.memories.list(layer, projectId));
  reg('memories:set', (b) => store.memories.set(b));
  reg('memories:remove', (id) => store.memories.remove(id));
  reg('usage:list', () => store.usage.list());
  reg('usage:summary', () => store.usage.summary());
  reg('audit:list', () => store.audit.list());
  reg('settings:get', (key, def) => store.settings.get(key, def));
  reg('settings:set', (key, value) => store.settings.set(key, value));
  reg('dashboard:stats', () => ({
    projects: store.projects.list().length,
    connections: store.connections.list().length,
    prompts: store.prompts.list().length,
    agents: store.agents.list().length,
    externalAgents: store.externalAgents.list().length,
    conversations: store.conversations.list().length,
    mcpServers: store.mcpServers.list().length,
    mainAgents: store.agents.listNative().filter(a => a.is_main).length
  }));

  // file changes / checkpoints (project views)
  reg('fileChanges:list', (projectId) => store.fileChanges.list(projectId));
  reg('checkpoints:list', (projectId) => store.checkpoints.list(projectId));

  // ---------- dialogs / filesystem browsing (renderer never touches fs directly) ----------
  reg('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: '选择项目文件夹' });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  reg('dialog:pickFile', async (filters) => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [] });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  reg('shell:showItem', (p) => { shell.showItemInFolder(p); return true; });
  reg('shell:openExternal', (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); return true; });

  const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'build', '.cache', 'out', '__pycache__', '.venv', 'venv']);
  reg('files:tree', (relDir) => {
    const proj = currentProjectId ? store.projects.get(currentProjectId) : null;
    if (!proj) throw new Error('未打开项目');
    const { guard } = require('../security/pathguard');
    const abs = guard(proj.root_path, relDir || '.');
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const items = entries
      .filter(e => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
      .map(e => {
        const rel = path.relative(proj.root_path, path.join(abs, e.name)).split(path.sep).join('/');
        let size = 0;
        try { if (e.isFile()) size = fs.statSync(path.join(abs, e.name)).size; } catch {}
        return { name: e.name, path: rel, dir: e.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
    return { root: proj.root_path, dir: relDir || '.', items };
  });
  reg('files:read', (relPath) => {
    const proj = currentProjectId ? store.projects.get(currentProjectId) : null;
    if (!proj) throw new Error('未打开项目');
    const { guard } = require('../security/pathguard');
    const abs = guard(proj.root_path, relPath);
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) return { path: relPath, truncated: true, content: '（文件过大，仅供智能体分段读取）' };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { path: relPath, binary: true, content: '（二进制文件）' };
    return { path: relPath, content: buf.toString('utf8'), size: st.size };
  });

  // ---------- terminal panel (user-initiated) ----------
  reg('terminal:run', async (command) => {
    const proj = currentProjectId ? store.projects.get(currentProjectId) : null;
    if (!proj) throw new Error('未打开项目');
    const term = require('../tools/terminal');
    const runId = crypto.randomUUID();
    const ctx = { projectRoot: proj.root_path, emit };
    emit('terminal_start', { runId, command, source: 'user' });
    const r = await term.runCommand(ctx, command, proj.root_path, 300000, false, runId, null);
    return r.ok ? r.data : { error: r.error };
  });
  reg('terminal:cancel', (runId) => require('../tools/terminal').terminalManager.cancel(runId));

  // ---------- v2.4.0 Smart API Onboarding ----------
  const onboarding = require('../providers/onboarding');
  const sec = require('../security/secret');
  // onboarding:presets — 列出本地 preset（GUI「常用服务」按钮用）
  reg('onboarding:presets', () => onboarding.listPresets());
  // onboarding:parse — 本地解析（不发网络请求），返回真实候选（前端 mask 显示）。
  // §11: ImportCandidate 只在内存；前端是可信 Electron renderer，与 connForm 处理明文 key 一致。
  // §17: 日志/序列化必须用 sanitizeCandidate；此处返回真实候选供后续 probe/import 使用。
  reg('onboarding:parse', (text) => {
    const result = onboarding.parseInput(text || '');
    if (result.candidate) {
      result.candidate._viable = onboarding.isViable(result.candidate);
    }
    return result;
  });
  // v2.4.1: onboarding:probe:start — 立即返回 probeId，后台执行 probe()，结果通过 onboarding:probe:event 推送
  // §3-§9: 真正的 GUI Probe Cancel。不再让 IPC 等待整个 Probe 完成。
  reg('onboarding:probe:start', (candidate, opts) => {
    const probeId = probeManager.startProbe(candidate, opts || {});
    return { probeId };
  });
  // v2.4.1: onboarding:probe:cancel — 通过 probeId 取消 Probe，真实 abort fetch
  reg('onboarding:probe:cancel', (probeId) => {
    return probeManager.cancelProbe(probeId);
  });
  // v2.4.1: onboarding:probe:get — 获取 Probe 安全 diagnostics（不含 apiKey）
  reg('onboarding:probe:get', (probeId) => {
    return probeManager.getProbe(probeId);
  });
  // v2.4.1: diagnostics:listActiveProbes — 供 E2E / Advanced Diagnostics 读取活跃 Probe
  reg('diagnostics:listActiveProbes', () => {
    return probeManager.listActiveProbes();
  });
  // 旧 onboarding:probe 保留向后兼容（同步等待完成），新代码应使用 probe:start
  reg('onboarding:probe', async (candidate, opts) => {
    const report = await onboarding.probe(candidate, opts || {});
    return report;
  });
  // onboarding:import — 用户确认后写库（secret 走 sec.encrypt），可选分配主智能体
  reg('onboarding:import', (candidate, opts) => {
    const r = onboarding.importCandidate(candidate, {
      store, sec,
      assignToMain: !!(opts && opts.assignToMain),
      agentId: opts && opts.agentId,
      forceOverwrite: opts && opts.forceOverwrite,
      modelsOverride: opts && opts.modelsOverride
    });
    // §60 audit：只记 import source / protocol，不记 key
    try {
      store.audit.add({
        agent: 'system',
        task: 'onboarding:import',
        tool: 'connections',
        target: r.connection && r.connection.id,
        permission: 'write',
        result: `imported source=${candidate.source && candidate.source.type} protocol=${candidate.protocolHint} assigned=${r.assigned}`
      });
    } catch { /* audit 失败不阻塞 */ }
    return r;
  });
  // onboarding:ccswitch — 批量解析 CC Switch 配置（只读），返回真实候选数组（前端 mask 显示）
  reg('onboarding:ccswitch', (text) => {
    if (!text) return { batch: [] };
    const ccSwitchParser = require('../providers/onboarding/parsers/ccSwitch');
    // Deep Link 单条
    if (/^ccswitch:\/\//i.test(String(text).trim())) {
      const c = ccSwitchParser.parseDeepLink(String(text).trim());
      return { batch: c ? [c] : [] };
    }
    // JSON 数组
    let arr;
    try { arr = JSON.parse(text); } catch { arr = null; }
    if (Array.isArray(arr)) {
      return { batch: ccSwitchParser.parseConfigBatch(arr) };
    }
    return { batch: [] };
  });
  // onboarding:duplicate — 重复检测（前端预览时调用）
  reg('onboarding:duplicate', (baseUrl, provider) => {
    const list = store.connections.list();
    const norm = onboarding.normalizeBaseUrl(baseUrl);
    const found = list.find(c => onboarding.normalizeBaseUrl(c.base_url) === norm && c.provider === provider);
    return found ? { id: found.id, name: found.name } : null;
  });

  // ---------- v2.5.0 External Config Import ----------
  const external = onboarding.external;
  // externalImport:listSources — GUI 渲染「从其他工具导入」按钮列表
  reg('externalImport:listSources', () => external.listSources());
  // externalImport:discover — 检查单个 sourceType 在本机是否安装/可读
  reg('externalImport:discover', (sourceType) => external.discover(sourceType));
  // externalImport:discoverAll — 批量 discover 所有已注册 importer
  reg('externalImport:discoverAll', () => external.discoverAll());
  // externalImport:parse — 解析指定 sourceType 为 candidates（opts: { filePath?, env? }）
  // §53/§54: 返回真实候选（前端 mask 显示），日志/audit 只记 source/protocol 不记 key
  reg('externalImport:parse', (sourceType, opts) => {
    const r = external.parseSource(sourceType, opts || {});
    // sanitize candidates 副本用于安全打印，但返回真实候选供后续 probe/import
    return r;
  });
  // externalImport:resolveConflicts — 批量冲突检测
  // v2.5.1 §14-§18：DUPLICATE 结果需进一步做 credential check（constant-time compare 解密后的 key）
  reg('externalImport:resolveConflicts', (candidates) => {
    const list = store.connections.list();
    const batch = external.resolveBatchConflicts(candidates, list);
    const { enrichBatchWithCredentialConflicts } = require('../providers/onboarding/external/conflictResolver');
    return enrichBatchWithCredentialConflicts(batch, store, sec);
  });
  // externalImport:importBatch — 批量导入，每个 candidate 独立处理
  // §43: 一个失败不影响其他；§45: 并发 2~3
  reg('externalImport:importBatch', async (items) => {
    const results = await external.importBatch(items, { store, sec, maxConcurrency: 3 });
    // §54 audit：批量导入也记 audit
    for (const r of results) {
      try {
        store.audit.add({
          agent: 'system',
          task: 'externalImport:importBatch',
          tool: 'connections',
          target: r.result && r.result.connection && r.result.connection.id,
          permission: 'write',
          result: `imported source=${r.candidate && r.candidate.source && r.candidate.source.type} ok=${r.result && r.result.ok} action=${r.action}`
        });
      } catch { /* audit 失败不阻塞 */ }
    }
    return results;
  });
  // externalImport:readFile — 用户手动选择文件（.env/.json/.toml）后读取
  // §63: 通过 dialog.showOpenDialog 选择，限制扩展名
  // E2E 测试钩子：testFilePickPath 由 externalImport:testSetFilePick 设置，
  //   仅在测试中激活，生产环境始终为 null 走真实 dialog。
  reg('externalImport:selectFile', async () => {
    if (testFilePickPath) {
      const p = testFilePickPath;
      testFilePickPath = null;
      return { canceled: false, filePath: p };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择配置文件',
      properties: ['openFile'],
      filters: [
        { name: '配置文件', extensions: ['env', 'json', 'toml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
  });
  // E2E 测试专用：设置下一次 selectFile 返回的文件路径（一次性，用后即清）
  reg('externalImport:testSetFilePick', (filePath) => { testFilePickPath = filePath || null; });
  // externalImport:parseFile — 根据文件扩展名自动选择 importer 解析
  reg('externalImport:parseFile', (filePath) => {
    if (!filePath) return { source: null, candidates: [], warnings: [] };
    const ext = path.extname(filePath).toLowerCase();
    let sourceType = null;
    if (ext === '.env') sourceType = 'env-file';
    else if (ext === '.json') sourceType = 'json-file';
    else if (ext === '.toml') sourceType = 'toml-file';
    if (!sourceType) return {
      source: null,
      candidates: [],
      warnings: [{ type: 'parse_warning', message: `不支持的文件扩展名：${ext}` }]
    };
    return external.parseSource(sourceType, { filePath, userSelected: true });
  });

  // ---------- computer panel ----------
  reg('computer:windows', () => computer.manager.listWindows());
  reg('computer:screenshot', () => computer.manager.screenshot());
  reg('computer:focus', (title) => computer.manager.focusWindow(title));
  reg('browser:status', () => browser.manager.status());

  // ---------- events / logs / system ----------
  reg('events:list', (conversationId) => conversationId ? store.events.list(conversationId) : []);
  reg('tasks:steps', (taskId) => store.tasks.steps(taskId));
  reg('system:info', () => {
    const sec = require('../security/secret');
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      dbPath: require('../db/schema').dbPath(app.getPath('userData')),
      secretBackend: sec.isUsingSafe() ? 'Windows DPAPI (safeStorage)' : 'base64 回退（未加密，建议在 Electron 环境使用）',
      browser: browser.manager.status()
    };
  });

  // agent runtime
  // v2.3.2 (P0-1): agent:send 必须「立即 ACK」—— 创建 Run 后立即返回 runId，
  // 后台执行 runChatTurn，绝不让 Renderer 等待 Agent 完成。所有状态通过
  // agent:event（run_state_changed + 终态事件）推送。后台 IIFE 完整 try/catch
  // 收口，任何异常都经 runManager.finishRun() 进入唯一终态，禁止
  // UnhandledPromiseRejection。
  ipcMain.handle('agent:send', (_e, { conversationId, agentId, message }) => {
    const run = runManager.createRun({ conversationId, agentId });
    const runId = run.id;
    // 后台执行 —— 不 await，IPC Promise 立即 resolve，Renderer 立刻拿到 runId。
    (async () => {
      try {
        const result = await runChatTurn(conversationId, agentId, message, { runId, runManager });
        const status = (result && result.status) || 'failed';
        runManager.finishRun(runId, status, {
          error: (result && result.error) || null,
          message: (result && result.error) || null,
          source: 'agent:send'
        });
      } catch (err) {
        const c = classifyError(err);
        try { emit('error', { conversationId, message: c.error }); } catch { /* emit must not break finish */ }
        runManager.finishRun(runId, c.status, { error: c.error, message: c.error, source: 'agent:send-catch' });
      }
    })();
    return { accepted: true, runId, conversationId, status: 'preparing' };
  });
  ipcMain.handle('agent:stop', (_e, { conversationId }) => {
    const ac = activeRuns.get(conversationId);
    if (ac) ac.abort();
    activeRuns.delete(conversationId);
    // v2.3.1 (P0-3): 终态由 RunManager 唯一宣布；若 Run 已终态（例如刚好完成），
    // cancel 会被忽略，保证 cancelled 后绝不出现 completed。
    const run = runManager.cancelByConversation(conversationId);
    return { stopped: !!ac || !!run };
  });
  ipcMain.handle('agent:permission-response', (_e, { reqId, decision, range }) => {
    const resolve = pendingPermissions.get(reqId);
    if (resolve) { pendingPermissions.delete(reqId); resolve({ decision, range }); }
    return { ok: true };
  });

  // v2.7.0 — Agent Integration Hub IPC
  ipcMain.handle('hub:manifests', () => agentHub.getManifests());
  ipcMain.handle('hub:available', async () => {
    const project = currentProjectId ? store.projects.get(currentProjectId) : null;
    await agentHub.detect();
    await agentHub.health({ force: false, projectRoot: project?.root_path || null });
    const available = agentHub.getAvailable();
    // v2.8.0 spec §110 — 认证状态落库：只存状态机的展示值，绝不存凭据。
    // UNKNOWN 不落库（无信息量，且会覆盖更精确的历史状态）。
    try {
      if (store.externalAgentAuthStates) {
        for (const a of available) {
          if (a && a.auth && a.auth.state && a.auth.state !== 'UNKNOWN') {
            store.externalAgentAuthStates.set(a.id, { state: a.auth.state, mode: a.auth.mode, detail: a.auth.detail });
          }
        }
      }
    } catch { /* DB 写失败不得影响读路径 */ }
    return available;
  });
  ipcMain.handle('hub:detect', async () => { return agentHub.detect(); });
  // v2.8.0 spec §81 — Session UI：外部 Agent 会话列表 + 认证状态（均不含凭据）
  ipcMain.handle('hub:sessions', () => {
    try {
      return {
        sessions: store.externalAgentSessions ? store.externalAgentSessions.list() : [],
        authStates: store.externalAgentAuthStates ? store.externalAgentAuthStates.list() : []
      };
    } catch { return { sessions: [], authStates: [] }; }
  });
  ipcMain.handle('hub:health', async (e, { force = false } = {}) => {
    const project = currentProjectId ? store.projects.get(currentProjectId) : null;
    return agentHub.health({ force, projectRoot: project?.root_path || null });
  });
  ipcMain.handle('hub:route', (e, task) => agentHub.route(task));
  // hub:start 支持两种调用约定：
  //   1) { agentId, task } 单参数对象（生产代码 / 内部调用）
  //   2) (agentId, task) 两个参数（E2E 测试 / 委派场景）
  ipcMain.handle('hub:start', async (e, agentIdOrObj, taskArg) => {
    const agentId = typeof agentIdOrObj === 'string' ? agentIdOrObj : (agentIdOrObj && agentIdOrObj.agentId);
    const task = { ...((typeof agentIdOrObj === 'string' ? taskArg : (agentIdOrObj && agentIdOrObj.task)) || {}) };
    const project = currentProjectId ? store.projects.get(currentProjectId) : null;
    if (!task.projectRoot && project) task.projectRoot = project.root_path;
    if (!task.projectId && project) task.projectId = project.id;
    return agentHub.start(agentId, task);
  });
  ipcMain.handle('hub:startAuto', async (e, taskOrObj) => {
    const task = { ...((taskOrObj && taskOrObj.task ? taskOrObj.task : taskOrObj) || {}) };
    const project = currentProjectId ? store.projects.get(currentProjectId) : null;
    if (!task.projectRoot && project) task.projectRoot = project.root_path;
    if (!task.projectId && project) task.projectId = project.id;
    return agentHub.startAuto(task);
  });
  // hub:delegate — Main Agent 委派子任务给合适的 Agent（防环由 delegationPath 保证）
  ipcMain.handle('hub:delegate', async (e, { goal, required, preferred, delegationPath, parentRunId }) => {
    const project = currentProjectId ? store.projects.get(currentProjectId) : null;
    const task = {
      goal,
      required: required || [],
      preferred: preferred || [],
      delegationPath: delegationPath || [],
      parentRunId,
      projectRoot: project?.root_path || null,
      projectId: project?.id || null
    };
    return agentHub.startAuto(task);
  });
  ipcMain.handle('hub:cancel', async (e, runId) => agentHub.cancel(runId));
  ipcMain.handle('hub:status', async (e, runId) => agentHub.status(runId));
  ipcMain.handle('hub:result', async (e, runId) => agentHub.result(runId));

  // v2.7.1 — Project Mutation Lock IPC
  ipcMain.handle('lock:isBusy', (e, projectRoot) => projectLock.isBusy(projectRoot));
  ipcMain.handle('lock:getHolder', (e, projectRoot) => projectLock.getLockHolder(projectRoot));
  ipcMain.handle('lock:listBusy', () => projectLock.listBusy());

  // v2.7.1 — External agent config IPC
  ipcMain.handle('extcfg:get', (e, agentId) => store.extAgentConfigs.get(agentId));
  ipcMain.handle('extcfg:set', (e, agentId, config) => {
    const safeConfig = agentId === 'cline'
      ? {
          connectionId: typeof config?.connectionId === 'string' ? config.connectionId : '',
          model: typeof config?.model === 'string' ? config.model.trim() : '',
          timeoutMs: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : undefined,
          maxIterations: Number.isInteger(config?.maxIterations) ? config.maxIterations : undefined
        }
      : config;
    const saved = store.extAgentConfigs.set(agentId, safeConfig || {});
    if (agentId === 'cline') {
      clineAdapter.config = { ...saved };
      healthManager.invalidate('cline');
    }
    return saved;
  });
  ipcMain.handle('extcfg:getAll', () => ({
    cline: store.extAgentConfigs.getCline(),
    opencode: store.extAgentConfigs.getOpenCode(),
    openhands: store.extAgentConfigs.getOpenHands()
  }));

  // v2.7.0 — Test helpers（仅测试模式可用）
  if (process.env.NODE_ENV === 'test') {
    const { TestAgentAdapter } = require('../agents/adapters/testAgentAdapter');
    ipcMain.handle('hub:testRegisterAdapter', (e, config) => {
      const adapter = new TestAgentAdapter(config);
      agentHub.register(adapter);
      return { ok: true, id: adapter.id };
    });

    // v2.8.0 — ACP E2E hook：注册一个**真实的** AcpAgentAdapter，其 command/args
    // 指向 fake ACP Agent 子进程（wire v1 严格实现）。走的是与生产完全相同的
    // 握手 / 协商 / 权限交集 / 取消 / 超时 / 崩溃 / resume / 落库 代码路径。
    const { AcpAgentAdapter } = require('../agents/adapters/acpAgentAdapter');
    const FAKE_ACP_AGENT_SCRIPT = path.join(__dirname, '..', '..', 'test', 'fakes', 'fakeAcpAgent.js');
    ipcMain.handle('hub:testRegisterAcpAdapter', (e, opts = {}) => {
      const manifest = opts.manifest || {
        id: 'fake-acp', displayName: 'Fake ACP Agent', transport: 'acp',
        capabilities: { coding: true }, maxConcurrency: 2
      };
      const adapter = new AcpAgentAdapter({
        manifest,
        config: {
          command: process.execPath,
          args: [FAKE_ACP_AGENT_SCRIPT],
          environment: {
            // Electron 以 Node 模式运行 fake agent；纯 Node 环境下该变量无害。
            ELECTRON_RUN_AS_NODE: '1',
            FAKE_ACP_CONFIG: JSON.stringify(opts.agentConfig || {})
          },
          cancelGraceMs: 1500,
          ...(opts.adapterConfig || {})
        },
        sessionPersistence
      });
      agentHub.register(adapter);
      return { ok: true, id: adapter.id };
    });

    // v2.8.0 — Codex auth E2E hook：模拟 app-server 运行时 getAuthStatus 的读取结果，
    // 驱动真实的 CodexAgentAdapter.getAuthState() 状态映射（不含任何凭据）。
    ipcMain.handle('hub:testSetCodexAuth', (e, status) => {
      codexAdapter._lastAuthStatus = status === 'authenticated' ? 'authenticated' : 'required';
      return { ok: true, auth: codexAdapter.getAuthState() };
    });

    // v2.8.0 — Codex detect E2E hook：CI 机器上没有真实 codex CLI 时，预设探测结果，
    // 使适配器表面（transportLabel / auth 面 / 路由候选 / GUI 卡片）可被验证。
    // detect() 对已缓存的 _detected 短路返回，后续 hub:available 的 detect 不会覆盖它。
    ipcMain.handle('hub:testSetCodexDetected', (e, detected) => {
      codexAdapter._detected = {
        available: true,
        path: 'fake-codex',
        version: '0.0.0-test',
        supportsAppServer: true,
        ...(detected || {})
      };
      return { ok: true, detected: codexAdapter._detected };
    });

    // v2.7.1 — External Agent Pack test injection hooks
    // 注入 fake Cline SDK（避免消耗真实 API）
    const clineSdkBridge = require('../agents/integrations/cline/sdkBridge');
    ipcMain.handle('test:injectClineSdk', (e, opts = {}) => {
      const fakeSdk = require('../../test/fakes/fakeClineSdk');
      clineSdkBridge.setSdkForTest(fakeSdk);
      clineAdapter._detected = null; // 清除 detect 缓存，下次 detect 用 fake
      clineAdapter._sdkInjected = true;
      return { ok: true, version: 'fake-0.0.72', delayMs: opts.delayMs || 0 };
    });
    ipcMain.handle('test:resetClineSdk', () => {
      clineSdkBridge.clearSdkForTest();
      clineAdapter._detected = null;
      clineAdapter._sdkInjected = false;
      // v2.7.1 — 重置后让 health 缓存失效并标记不可用，避免后续 Case 路由误判为 healthy
      clineAdapter.healthStatus = 'unavailable';
      healthManager.invalidate('cline');
      return { ok: true };
    });

    // Production-path E2E hook: replace only the process boundary with a
    // deterministic sidecar-shaped fixture. The adapter remains in sidecar
    // mode and consumes current official ClineCore event envelopes.
    ipcMain.handle('test:setClineSidecarMode', (e, mode = 'healthy') => {
      const active = new Map();
      const state = { mode, cancelCount: 0, lateEventSent: false };
      clineAdapter._sdkInjected = false;
      clineAdapter._legacyBridge = false;
      clineAdapter._sidecar = {
        detect: () => mode === 'missing'
          ? { available: false, installed: false, configured: false, version: null, nodeVersion: null, error: 'fixture runtime missing', runtime: { missing: ['node.exe'] } }
          : { available: true, installed: true, configured: true, version: '0.0.72', nodeVersion: '22.23.2', runtime: { manifest: { protocolVersion: 1 } } },
        probe: async projectRoot => ({ ok: true, runtime: 'ClineCore', coreConstructible: true, networkCall: false, nodeVersion: '22.23.2', clineSdkVersion: '0.0.72', projectRoot }),
        run: async options => {
          options.onStarted?.({ sessionId: `e2e-${mode}`, workspace: options.projectRoot });
          if (mode === 'crash') {
            const error = new Error('fixture sidecar crashed');
            error.code = 'CLINE_SIDECAR_CRASHED';
            throw error;
          }
          if (mode === 'hang') {
            return new Promise(resolve => active.set(options.runId, resolve));
          }
          if (mode === 'timeout' || mode === 'late') {
            if (mode === 'late') {
              setTimeout(() => {
                state.lateEventSent = true;
                options.onEvent?.({ type: 'agent_event', payload: { sessionId: `e2e-${mode}`, event: { type: 'content_start', contentType: 'text', text: 'LATE_RESULT_MUST_BE_IGNORED' } } });
              }, 30);
            }
            return { type: 'run.timeout', payload: { error: { code: 'CLINE_RUN_TIMEOUT', message: 'fixture timeout' } } };
          }
          options.onEvent?.({ type: 'agent_event', payload: { sessionId: `e2e-${mode}`, event: { type: 'content_start', contentType: 'text', text: 'CLINE_SIDECAR_E2E_OK' } } });
          return {
            type: 'run.result',
            payload: {
              result: { finishReason: 'completed', text: 'CLINE_SIDECAR_E2E_OK', iterations: 1, changedFiles: [] },
              provenance: { runtime: 'ClineCore Sidecar', nodeVersion: '22.23.2', sdkVersion: '0.0.72', sessionId: `e2e-${mode}` }
            }
          };
        },
        cancel: runId => {
          const resolve = active.get(runId);
          if (!resolve) return false;
          state.cancelCount += 1;
          active.delete(runId);
          resolve({ type: 'run.cancelled', payload: { error: { code: 'CLINE_RUN_CANCELLED', message: 'fixture cancelled' } } });
          return true;
        },
        dispose: async () => {}
      };
      clineAdapter._testSidecarState = state;
      clineAdapter._detected = null;
      healthManager.invalidate('cline');
      return { ok: true, mode };
    });
    ipcMain.handle('test:getClineSidecarState', () => ({ ...(clineAdapter._testSidecarState || {}) }));
    ipcMain.handle('test:resetClineSidecar', () => {
      clineAdapter._sidecar = productionClineSidecarManager;
      clineAdapter._testSidecarState = null;
      clineAdapter._detected = null;
      clineAdapter._sdkInjected = false;
      clineAdapter._legacyBridge = false;
      healthManager.invalidate('cline');
      return { ok: true };
    });

    // 注入 fake OpenCode Server（在主进程内启动 fake HTTP server，注入 fake serverManager）
    ipcMain.handle('test:injectOpenCodeServer', async (e, opts = {}) => {
      const { createFakeOpenCodeServer } = require('../../test/fakes/fakeOpenCodeServer');
      const fakeServer = createFakeOpenCodeServer({ port: 0 });
      await fakeServer.start();
      const baseUrl = fakeServer.baseUrl;
      // 构造 fake serverManager：返回 fake server 的 baseUrl，不启动真实进程
      const fakeServerManager = {
        detect: async () => ({ available: true, path: '/fake/opencode' }),
        getVersion: async () => 'fake-1.0.0',
        start: async ({ projectRoot, runId }) => ({ baseUrl, password: null, refCount: 1 }),
        release: () => true,
        stop: () => true,
        health: async () => ({ healthy: true, version: 'fake-1.0.0', latencyMs: 1 }),
        getServer: () => null,
        isRunning: () => true,
        isProcessAlive: () => true,
        dispose: async () => { try { await fakeServer.stop(); } catch { /* noop */ } }
      };
      openCodeAdapter.serverManager = fakeServerManager;
      openCodeAdapter._detected = null;
      openCodeAdapter._fakeServer = fakeServer;
      return { ok: true, baseUrl, version: 'fake-1.0.0' };
    });
    ipcMain.handle('test:resetOpenCodeServer', async () => {
      if (openCodeAdapter._fakeServer) {
        try { await openCodeAdapter._fakeServer.stop(); } catch { /* noop */ }
        openCodeAdapter._fakeServer = null;
      }
      openCodeAdapter.serverManager = openCodeServerManager;
      openCodeAdapter._detected = null;
      // v2.7.1 — 重置后让 health 缓存失效并标记不可用，避免后续 Case 路由误判为 healthy
      openCodeAdapter.healthStatus = 'unavailable';
      healthManager.invalidate('opencode');
      return { ok: true };
    });
    // v2.7.1 — Cancel E2E：控制 fake OpenCode server 的 hang 模式 + 读取 abort 调用数
    ipcMain.handle('test:setOpenCodeHang', () => {
      if (openCodeAdapter._fakeServer && typeof openCodeAdapter._fakeServer.setHangNext === 'function') {
        openCodeAdapter._fakeServer.setHangNext();
        return { ok: true };
      }
      return { ok: false, error: 'fake server not injected' };
    });
    ipcMain.handle('test:getOpenCodeAbortCount', () => {
      if (openCodeAdapter._fakeServer) {
        return { ok: true, count: openCodeAdapter._fakeServer.abortCount || 0 };
      }
      return { ok: true, count: 0 };
    });

    // 注入 fake OpenHands Server（在主进程内启动 fake HTTP server，设置 adapter config.serverUrl）
    ipcMain.handle('test:injectOpenHandsServer', async (e, opts = {}) => {
      const { createFakeOpenHandsServer } = require('../../test/fakes/fakeOpenHandsServer');
      const fakeServer = createFakeOpenHandsServer({ port: 0 });
      await fakeServer.start();
      const baseUrl = fakeServer.baseUrl;
      openHandsAdapter.config = { ...(openHandsAdapter.config || {}), serverUrl: baseUrl, mode: 'remote' };
      openHandsAdapter._detected = null;
      openHandsAdapter._fakeServer = fakeServer;
      return { ok: true, baseUrl, version: 'fake-1.41.0' };
    });
    ipcMain.handle('test:resetOpenHandsServer', async () => {
      if (openHandsAdapter._fakeServer) {
        try { await openHandsAdapter._fakeServer.stop(); } catch { /* noop */ }
        openHandsAdapter._fakeServer = null;
      }
      openHandsAdapter.config = null;
      openHandsAdapter._detected = null;
      // v2.7.1 — 重置后让 health 缓存失效并标记不可用，避免后续 Case 路由误判为 healthy
      openHandsAdapter.healthStatus = 'unavailable';
      healthManager.invalidate('openhands');
      return { ok: true };
    });
  }
}

// connect MCP servers marked connected at startup
async function initServices() {
  // v2.3.1 (P1-14): 应用上次被关闭 —— 数据库里所有非终态 Run 统一标记 interrupted，
  // GUI 绝不恢复旧 Spinner。
  try { runManager.interruptStale(); } catch (e) { console.log('[runManager] interruptStale 失败: ' + e.message); }
  const targets = store.mcpServers.list().filter(s => s.status === 'connected');
  // Reconnect in parallel: one dead server must not delay the others, and a
  // hung handshake is bounded by the client-side timeout.
  await Promise.allSettled(targets.map(async (s) => {
    try {
      const toolsList = await mcpManager.connect(s);
      store.mcpServers.setStatus(s.id, 'connected', toolsList);
    } catch (e) {
      store.mcpServers.setStatus(s.id, 'error', []);
      emit('mcp_status', { serverId: s.id, status: 'error', message: e.message });
    }
  }));
  rebuildMcpToolMap();
}

module.exports = { register, initServices, shutdownServices, runChatTurn, runManager, _internals: { getTool, mcpManager, browser: browser.manager, computer: computer.manager, clineAdapter } };
