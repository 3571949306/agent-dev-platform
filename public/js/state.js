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
  logs: []
};

export function findAgent(id) { return state.agents.find(a => a.id === id) || null; }
