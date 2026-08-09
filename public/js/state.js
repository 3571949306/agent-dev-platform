// Shared renderer state (single source of truth for the UI).
export const state = {
  project: null,
  agents: [],
  connections: [],
  conversations: [],
  conv: null,          // current conversation object
  agentId: null,       // selected agent for the current chat
  running: false,
  streamEl: null,      // current streaming assistant bubble
  streamBuf: '',
  pendingTools: [],    // [{name, el}]
  terminalRuns: new Map(),
  diffs: [],           // live file changes this session
  tasks: [],
  logs: [],
  // v2.6.0 Main Agent — 当前 Run 的 UI 跟踪
  mainAgent: {
    runId: null,           // 当前 Run ID
    pendingActionEl: null, // 等待 toolResult 的 action card
    planEl: null,          // 当前 plan card（用于 taskUpdated 更新）
    planTasks: []          // plan 中的任务列表 [{taskId, title, status}]
  }
};

export function findAgent(id) { return state.agents.find(a => a.id === id) || null; }
