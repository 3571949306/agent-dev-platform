// Thin IPC wrapper. The renderer never touches node APIs — everything goes
// through window.api (contextBridge) into the main process.

function bridge() {
  if (!window.api || typeof window.api.invoke !== 'function') {
    throw new Error('IPC 桥接不可用（请在 Electron 中运行本应用，而不是直接用浏览器打开）');
  }
  return window.api;
}

export async function call(channel, ...args) {
  const r = await bridge().invoke(channel, ...args);
  if (r && r.ok === false) throw new Error(r.error || '操作失败');
  if (r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'data')) return r.data;
  return r;
}

export function onEvent(cb) { return bridge().onEvent(cb); }

export const api = {
  // system
  systemInfo: () => call('system:info'),
  dashboard: () => call('dashboard:stats'),
  settingsGet: (k, d) => call('settings:get', k, d),
  settingsSet: (k, v) => call('settings:set', k, v),

  // projects
  projects: () => call('projects:list'),
  projectCreate: (b) => call('projects:create', b),
  projectOpen: (id) => call('projects:open', id),
  projectCurrent: () => call('projects:current'),
  projectRemove: (id) => call('projects:remove', id),
  pickFolder: () => call('dialog:pickFolder'),

  // files
  tree: (dir) => call('files:tree', dir),
  readFile: (p) => call('files:read', p),
  showItem: (p) => call('shell:showItem', p),
  openExternal: (u) => call('shell:openExternal', u),

  // connections
  connections: () => call('connections:list'),
  connCreate: (b) => call('connections:create', b),
  connUpdate: (id, b) => call('connections:update', id, b),
  connRemove: (id) => call('connections:remove', id),
  connTest: (id) => call('connections:test', id),
  connModels: (id) => call('connections:models', id),

  // prompts / skills
  prompts: () => call('prompts:list'),
  promptCreate: (b) => call('prompts:create', b),
  promptUpdate: (id, b) => call('prompts:update', id, b),
  promptRemove: (id) => call('prompts:remove', id),
  skills: () => call('skills:list'),

  // agents
  agents: () => call('agents:list'),
  agentGet: (id) => call('agents:get', id),
  agentCreate: (b) => call('agents:create', b),
  agentUpdate: (id, b) => call('agents:update', id, b),
  agentRemove: (id) => call('agents:remove', id),
  externalAgents: () => call('externalAgents:list'),
  extCreate: (b) => call('externalAgents:create', b),
  extUpdate: (id, b) => call('externalAgents:update', id, b),
  extRemove: (id) => call('externalAgents:remove', id),

  // conversations
  conversations: (projectId) => call('conversations:list', projectId),
  convCreate: (b) => call('conversations:create', b),
  convGet: (id) => call('conversations:get', id),
  convRemove: (id) => call('conversations:remove', id),
  messages: (id) => call('messages:list', id),

  // tools / mcp
  tools: () => call('tools:list'),
  mcpList: () => call('mcp:list'),
  mcpCreate: (b) => call('mcp:create', b),
  mcpRemove: (id) => call('mcp:remove', id),
  mcpConnect: (id) => call('mcp:connect', id),
  mcpDisconnect: (id) => call('mcp:disconnect', id),

  // runtime
  send: (conversationId, agentId, message) => call('agent:send', { conversationId, agentId, message }),
  stop: (conversationId) => call('agent:stop', { conversationId }),
  permissionRespond: (reqId, decision, range) => call('agent:permission-response', { reqId, decision, range }),

  // panels
  tasks: (projectId) => call('tasks:list', projectId),
  taskSteps: (id) => call('tasks:steps', id),
  fileChanges: (projectId) => call('fileChanges:list', projectId),
  checkpoints: (projectId) => call('checkpoints:list', projectId),
  events: (convId) => call('events:list', convId),
  usage: () => call('usage:list'),
  usageSummary: () => call('usage:summary'),
  audit: () => call('audit:list'),
  memories: (layer, projectId) => call('memories:list', layer, projectId),

  // terminal / computer / browser
  termRun: (cmd) => call('terminal:run', cmd),
  termCancel: (id) => call('terminal:cancel', id),
  computerWindows: () => call('computer:windows'),
  computerShot: () => call('computer:screenshot'),
  computerFocus: (t) => call('computer:focus', t),
  browserStatus: () => call('browser:status')
};
