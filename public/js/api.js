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
  createFile: (p) => call('files:create', p),
  createDir: (p) => call('files:createDir', p),
  renameFile: (from, to) => call('files:rename', { from, to }),
  requestDeleteFile: (p) => call('files:deleteRequest', p),
  deleteFile: (relPath, token) => call('files:delete', { relPath, token }),
  revealFile: (p) => call('files:reveal', p),
  openFileExternal: (p) => call('files:openExternal', p),
  listAllFiles: () => call('files:listAll'),
  showItem: (p) => call('shell:showItem', p),
  openExternal: (u) => call('shell:openExternal', u),

  // connections
  connections: () => call('connections:list'),
  connCreate: (b) => call('connections:create', b),
  connUpdate: (id, b) => call('connections:update', id, b),
  connRemove: (id) => call('connections:remove', id),
  connTest: (id) => call('connections:test', id),
  connModels: (id) => call('connections:models', id),
  // v2.9.9 Phase B Final（B15.9）— 默认连接/模型（偏好，绝不旁路 Model Router）
  connGetDefaults: () => call('connections:getDefaults'),
  connSetDefault: (connectionId, modelId) => call('connections:setDefault', connectionId, modelId),

  // onboarding (v2.4.0 Smart API)
  onboardingPresets: () => call('onboarding:presets'),
  onboardingParse: (text) => call('onboarding:parse', text),
  onboardingProbe: (candidate, opts) => call('onboarding:probe', candidate, opts),
  onboardingProbeStart: (candidate, opts) => call('onboarding:probe:start', candidate, opts),
  onboardingProbeCancel: (probeId) => call('onboarding:probe:cancel', probeId),
  onboardingProbeGet: (probeId) => call('onboarding:probe:get', probeId),
  onboardingImport: (candidate, opts) => call('onboarding:import', candidate, opts),
  onboardingCcswitch: (text) => call('onboarding:ccswitch', text),
  onboardingDuplicate: (baseUrl, provider) => call('onboarding:duplicate', baseUrl, provider),
  diagListActiveProbes: () => call('diagnostics:listActiveProbes'),

  // external import (v2.5.0 External Config Import)
  externalImportListSources: () => call('externalImport:listSources'),
  externalImportDiscover: (sourceType) => call('externalImport:discover', sourceType),
  externalImportDiscoverAll: () => call('externalImport:discoverAll'),
  externalImportParse: (sourceType, opts) => call('externalImport:parse', sourceType, opts),
  externalImportResolveConflicts: (candidates) => call('externalImport:resolveConflicts', candidates),
  externalImportImportBatch: (items) => call('externalImport:importBatch', items),
  externalImportSelectFile: () => call('externalImport:selectFile'),
  externalImportParseFile: (filePath) => call('externalImport:parseFile', filePath),

  // diagnostics (P1-5) — live capability probing + call-record audit
  diagCapabilities: (connId, modelId, which) => call('diagnostics:capabilities', connId, modelId, which),
  diagKnown: (connId, modelId) => call('diagnostics:known', connId, modelId),
  diagDescribe: (connId, modelId) => call('diagnostics:describe', connId, modelId),
  diagModelCalls: (limit) => call('diagnostics:modelCalls', limit),
  diagMismatches: () => call('diagnostics:mismatches'),
  diagProduct: (options) => call('diagnostics:product', options),
  // v2.9.9 Phase B Final（B20.2）— 产品自检（safe / bounded / 0 paid calls）
  diagSelfTest: () => call('diagnostics:selfTest'),

  // v2.9.9 Phase B Final（B22）— Recovery Center（无 Resume Runtime，绝无复活旧 Run）
  recoverySummary: () => call('recovery:summary'),
  recoveryDismiss: () => call('recovery:dismiss'),
  recoveryNewTaskDraft: (runId) => call('recovery:newTaskDraft', runId),

  // v2.9.9 Phase B Final（B29）— Onboarding 2.0（智能检测，可跳过，可重开）
  onboardingStatus: () => call('onboarding:status'),
  onboardingComplete: (skipped) => call('onboarding:complete', skipped),

  // v2.9.9 Phase B Final（B21）— Problems Center（持久化真源，dismiss != resolved）
  problemsList: (options) => call('problems:list', options),
  problemsCountActive: () => call('problems:countActive'),
  problemsDismiss: (id) => call('problems:dismiss', id),
  problemsResolve: (id) => call('problems:resolve', id),
  problemsReport: (input) => call('problems:report', input),

  // v2.9.9 Phase B Final（B16）— Run Model Routing Inspector
  runModelRouting: (runId) => call('runs:modelRouting', runId),

  // prompts / skills
  prompts: () => call('prompts:list'),
  promptCreate: (b) => call('prompts:create', b),
  promptUpdate: (id, b) => call('prompts:update', id, b),
  promptRemove: (id) => call('prompts:remove', id),
  skills: () => call('skills:list'),

  // v2.9.3 — Skill Engine（R2/R3）
  skillList: () => call('skill:list'),
  skillGet: (id) => call('skill:get', id),
  skillCreate: (definition) => call('skill:create', definition),
  skillUpdate: (id, patch) => call('skill:update', id, patch),
  skillDelete: (id) => call('skill:delete', id),
  skillEnable: (id) => call('skill:enable', id),
  skillDisable: (id) => call('skill:disable', id),
  skillResolve: (skillIds, agentContext, projectContext) => call('skill:resolve', { skillIds, agentContext, projectContext }),

  // v2.9.4 — HookDefinition management (trusted handlers are never exposed)
  hookList: () => call('hook:list'),
  hookGet: (id) => call('hook:get', id),
  hookCreate: (definition) => call('hook:create', definition),
  hookUpdate: (id, patch) => call('hook:update', id, patch),
  hookDelete: (id) => call('hook:delete', id),
  hookEnable: (id) => call('hook:enable', id),
  hookDisable: (id) => call('hook:disable', id),
  hookAudit: (limit) => call('hook:audit:list', limit),
  // v2.9.9 Phase B Final（B17.6）— 受信 handler 只能选择，不能输入脚本
  hookHandlersList: () => call('hook:handlers:list'),
  // v2.9.9 Phase B Final（B17.1/B17.4）— Skill/Hook Used By
  artifactUsage: () => call('artifactUsage'),

  // v2.9.5 Workflow Engine
  workflowList: () => call('workflow:list'),
  workflowGet: (id) => call('workflow:get', id),
  workflowCreate: (definition) => call('workflow:create', definition),
  workflowUpdate: (id, patch) => call('workflow:update', id, patch),
  workflowDelete: (id) => call('workflow:delete', id),
  workflowEnable: (id) => call('workflow:enable', id),
  workflowDisable: (id) => call('workflow:disable', id),
  workflowRun: (id, input, runtime) => call('workflow:run', id, input, runtime),
  workflowGetRun: (workflowRunId) => call('workflow:getRun', workflowRunId),
  workflowListRuns: (limit) => call('workflow:listRuns', limit),
  workflowCancel: (workflowRunId) => call('workflow:cancel', workflowRunId),
  workflowApprove: (workflowRunId) => call('workflow:approve', workflowRunId),
  workflowReject: (workflowRunId) => call('workflow:reject', workflowRunId),

  // v2.9.6 AI Generator drafts (generation never saves or executes).
  generatorGenerate: (request) => call('generator:generate', request),
  generatorGetDraft: (draftId) => call('generator:getDraft', draftId),
  generatorListDrafts: (limit) => call('generator:listDrafts', limit),
  generatorValidate: (draftId) => call('generator:validate', draftId),
  generatorSave: (draftId) => call('generator:save', draftId),
  generatorDiscard: (draftId) => call('generator:discard', draftId),
  generatorCancel: (draftId) => call('generator:cancel', draftId),

  // agents
  agents: () => call('agents:list'),
  agentGet: (id) => call('agents:get', id),
  agentCreate: (b) => call('agents:create', b),
  agentUpdate: (id, b) => call('agents:update', id, b),
  agentRemove: (id) => call('agents:remove', id),
  // v2.9.9 Phase B（B13）— Dynamic Agent Definitions（持久化定义 ≠ 临时实例）
  dynDefList: () => call('dynamicAgent:def:list'),
  dynDefCreate: (definition) => call('dynamicAgent:def:create', definition),
  dynDefUpdate: (id, patch) => call('dynamicAgent:def:update', id, patch),
  dynDefDelete: (id) => call('dynamicAgent:def:delete', id),
  dynInstanceList: () => call('dynamicAgent:instance:list'),
  externalAgents: () => call('externalAgents:list'),
  extCreate: (b) => call('externalAgents:create', b),
  extUpdate: (id, b) => call('externalAgents:update', id, b),
  extRemove: (id) => call('externalAgents:remove', id),

  // v2.6.0 — Agent Integration Hub（注册表 / 路由 / 健康）
  hubAvailable: () => call('hub:available'),
  hubManifests: () => call('hub:manifests'),
  hubRoute: (task) => call('hub:route', task),
  hubHealth: (opts) => call('hub:health', opts),

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
  // v2.9.9 Phase B（#1）— canonical Main Agent product entry（ProductEntry Main）。
  // 主聊天框选中 is_main 平台主智能体时走这条；legacy/external/general chat 仍用 send/stop。
  mainRun: (b) => call('mainAgent:run', b),
  mainStop: (b) => call('mainAgent:stop', b),
  permissionRespond: (reqId, decision, range) => call('agent:permission-response', { reqId, decision, range }),
  // v2.9.9 Phase B（B10）— Permission Request Center 队列元数据
  permissionsList: () => call('permissions:list'),

  // panels
  tasks: (projectId) => call('tasks:list', projectId),
  taskSteps: (id) => call('tasks:steps', id),
  fileChanges: (projectId) => call('fileChanges:list', projectId),
  checkpoints: (projectId) => call('checkpoints:list', projectId),
  events: (convId) => call('events:list', convId),
  runs: (options) => call('runs:list', options),
  runGet: (id) => call('runs:get', id),
  runChildren: (id) => call('runs:children', id),
  runEvents: (id) => call('runs:events', id),
  gitStatus: () => call('project:gitStatus'),
  gitChangedFiles: () => call('git:changedFiles'),
  gitDiff: (p) => call('git:diff', p),
  usage: () => call('usage:list'),
  usageSummary: () => call('usage:summary'),
  audit: () => call('audit:list'),
  memories: (layer, projectId) => call('memories:list', layer, projectId),

  // terminal / computer / browser
  termRun: (cmd, opts) => call('terminal:run', cmd, opts),
  termCancel: (id) => call('terminal:cancel', id),
  // v2.9.9 Phase B Final（B19）— Terminal Workspace 2.0
  termRiskCheck: (cmd) => call('terminal:riskCheck', cmd),
  termActive: () => call('terminal:active'),
  termHistory: (limit) => call('terminal:history', limit),
  termOutput: (runId) => call('terminal:output', runId),
  computerWindows: () => call('computer:windows'),
  computerShot: () => call('computer:screenshot'),
  computerFocus: (t) => call('computer:focus', t),
  // v2.9.9 Phase B Final（B18）— Computer Workspace 2.0
  computerAvailability: () => call('computer:availability'),
  computerHistory: (limit) => call('computer:history', limit),
  computerActive: () => call('computer:active'),
  computerStop: () => call('computer:stop'),
  browserStatus: () => call('browser:status'),

  // v2.7.0 — Agent Integration Hub
  hubManifests: () => call('hub:manifests'),
  hubAvailable: () => call('hub:available'),
  hubDetect: () => call('hub:detect'),
  hubHealth: (opts) => call('hub:health', opts),
  hubRoute: (task) => call('hub:route', task),
  hubStart: (agentId, task) => call('hub:start', { agentId, task }),
  hubStartAuto: (task) => call('hub:startAuto', { task }),
  hubCancel: (runId) => call('hub:cancel', runId),
  hubStatus: (runId) => call('hub:status', runId),
  hubResult: (runId) => call('hub:result', runId),

  // v2.8.0 — 外部 Agent 会话 / 认证状态（仅展示值，不含凭据）
  hubSessions: () => call('hub:sessions'),

  // v2.8.1 — 验证级别（§44/§45：与 Health 分离，不可混用）
  hubVerification: () => call('hub:verification'),

  // v2.9.0 — Unified Main Agent Orchestrator（统一 Parent 入口为 mainAgent:run，不新增 orchestrator:start）
  orchCancel: (runId) => call('orchestrator:cancel', runId),
  orchCancelChild: (parentRunId, childRunId) => call('orchestrator:cancelChild', { parentRunId, childRunId }),
  orchStatus: (runId) => call('orchestrator:status', runId),
  orchResult: (runId) => call('orchestrator:result', runId),
  orchChildren: (runId) => call('orchestrator:children', runId),

  // v2.7.1 — External agent configs & project mutation lock
  extcfgGet: (agentId) => call('extcfg:get', agentId),
  extcfgSet: (agentId, config) => call('extcfg:set', agentId, config),
  extcfgGetAll: () => call('extcfg:getAll'),
  lockIsBusy: (projectRoot) => call('lock:isBusy', projectRoot),
  lockGetHolder: (projectRoot) => call('lock:getHolder', projectRoot),
  lockListBusy: () => call('lock:listBusy')
};
