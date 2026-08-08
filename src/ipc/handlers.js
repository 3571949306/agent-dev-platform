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
const { runAgentTurn } = require('../agent/runtime');
const { runSubAgent } = require('../agent/subagent');
const { buildToolDefs, subAgentIdFromToolName } = require('../agent/context');
const { PermissionEngine } = require('../security/permissions');
const { McpManager } = require('../services/mcp');
const { createBrowserTools } = require('../services/browser');
const { createComputerTools } = require('../services/computer');
const extAgents = require('../services/externalAgents');

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

function buildToolDefsFor(agent) {
  const mcpDefs = [...mcpToolMap.values()].map(m => m.def);
  const defs = buildToolDefs(agent, { mcpDefs, subAgents: subAgentsFor(agent) });
  if (agent.is_main || agent.type === 'computer' || /main/i.test(agent.name || '')) defs.push(...browser.defs, ...computer.defs);
  return defs;
}

function getAgentFull(id) { return store.agents.get(id) || store.externalAgents.get(id); }

async function buildProvider(agent) {
  const conn = store.connections.getDecrypted(agent.api_connection_id);
  if (!conn) throw new Error(`Agent「${agent.name}」未绑定 API 连接`);
  return providers.getProvider(conn);
}

function requestPermission(req) {
  return new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingPermissions.set(reqId, resolve);
    emit('permission_request', { reqId, ...req });
  });
}

async function sendChatTask({ toConversationId, message }) {
  const conv = store.conversations.get(toConversationId);
  if (!conv) throw new Error('目标聊天不存在');
  await runChatTurn(toConversationId, conv.agent_id, message);
  const msgs = store.messages.list(toConversationId);
  const last = msgs.filter(m => m.role === 'assistant').pop();
  return last ? last.content : '';
}

async function runChatTurn(conversationId, agentId, userMessage) {
  const agent = getAgentFull(agentId);
  const conv = store.conversations.get(conversationId);
  const project = conv && conv.project_id ? store.projects.get(conv.project_id) : null;
  const projectRoot = project ? project.root_path : (currentProjectId ? store.projects.get(currentProjectId)?.root_path : null);
  if (!agent) { emit('error', { conversationId, message: 'Agent 不存在' }); return; }

  if (agent.type === 'external') {
    store.messages.create({ conversation_id: conversationId, role: 'user', content: userMessage });
    emit('assistant_status', { conversationId, status: '调用外部 Agent ' + agent.name });
    const res = await extAgents.runExternalAgent(agent, userMessage, { store, computerManager: computer.manager });
    store.messages.create({ conversation_id: conversationId, role: 'assistant', content: res, model: agent.name });
    emit('assistant_message', { conversationId, content: res });
    return;
  }
  if (!projectRoot) { emit('error', { conversationId, message: '未打开项目，无法执行本地工具' }); return; }

  const ac = new AbortController();
  activeRuns.set(conversationId, ac);
  const pe = new PermissionEngine();
  const deps = {
    store, project, projectRoot, abortSignal: ac.signal,
    permissionEngine: pe, buildProvider, getTool,
    subAgentTool: (name) => { const id = subAgentIdFromToolName(name); return id ? getAgentFull(id) : null; },
    buildToolDefs: buildToolDefsFor,
    runSubAgent: (subDef, args, ctx) => runSubAgent(deps, subDef, args, ctx),
    sendChatTask, requestPermission, computerManager: computer.manager, emit,
    pinnedFacts: store.memories.list('project', project?.id).map(m => m.value)
  };
  store.messages.create({ conversation_id: conversationId, role: 'user', content: userMessage });
  try { await runAgentTurn(deps, { agent, conversationId, userMessage, history: store.messages.list(conversationId), toolDefs: buildToolDefsFor(agent) }); }
  finally { activeRuns.delete(conversationId); }
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
    const list = await providers.getProvider(conn).listModels();
    store.connections.setModels(id, list);
    return { models: list };
  });

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
    if (st.size > 2 * 1024 * 1024) return { path: relPath, truncated: true, content: '（文件过大，仅供 Agent 分段读取）' };
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
  ipcMain.handle('agent:send', (_e, { conversationId, agentId, message }) => {
    runChatTurn(conversationId, agentId, message).catch(err => emit('error', { conversationId, message: err.message }));
    return { accepted: true };
  });
  ipcMain.handle('agent:stop', (_e, { conversationId }) => {
    const ac = activeRuns.get(conversationId);
    if (ac) { ac.abort(); activeRuns.delete(conversationId); }
    return { stopped: !!ac };
  });
  ipcMain.handle('agent:permission-response', (_e, { reqId, decision, range }) => {
    const resolve = pendingPermissions.get(reqId);
    if (resolve) { pendingPermissions.delete(reqId); resolve({ decision, range }); }
    return { ok: true };
  });
}

// connect MCP servers marked connected at startup
async function initServices() {
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

module.exports = { register, initServices, runChatTurn, _internals: { getTool, mcpManager, browser: browser.manager, computer: computer.manager } };
