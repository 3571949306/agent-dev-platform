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

// v2.3.1 (P0-2/P0-3/P0-4) — 全应用唯一的 Run 状态机。只有它能宣布 Run 终态。
const runManager = new RunManager({ store, emit });

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
  const isMain = agent.is_main || agent.type === 'computer' || /main/i.test(agent.name || '');
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

  // projects
  reg('projects:list', () => store.projects.list());
  reg('projects:recent', () => store.projects.list());
  reg('projects:create', (body) => store.projects.create(body));
  reg('projects:update', (id, body) => store.projects.update(id, body));
  reg('projects:remove', (id) => store.projects.remove(id));
  reg('projects:open', (id) => { currentProjectId = id; const p = store.projects.get(id); if (p) store.projects.touch(id); return p; });
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
  ipcMain.handle('agent:send', async (_e, { conversationId, agentId, message }) => {
    // v2.3.1 (P0-2/P0-3): agent:send 通过 RunManager 创建 Run 并唯一宣布终态。
    // Promise resolve ≠ 业务成功 —— 只有 runChatTurn 返回的 status 决定终态。
    const run = runManager.createRun({ conversationId, agentId });
    const runId = run.id;
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
      emit('error', { conversationId, message: c.error });
      runManager.finishRun(runId, c.status, { error: c.error, message: c.error, source: 'agent:send-catch' });
    }
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

module.exports = { register, initServices, runChatTurn, runManager, _internals: { getTool, mcpManager, browser: browser.manager, computer: computer.manager } };
