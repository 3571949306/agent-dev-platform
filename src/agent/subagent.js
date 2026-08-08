'use strict';
/**
 * Sub-Agent execution. Runs a sub-agent to completion in its own conversation/session,
 * with its own tools (no further nesting), and returns a STRUCTURED result.
 */
const { runAgentTurn } = require('./runtime');
const { PermissionEngine } = require('../security/permissions');
const extAgents = require('../services/externalAgents');

function parseArgs(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

async function runSubAgent(deps, subDef, argsStr, parentRunCtx) {
  const taskText = parseArgs(argsStr).task || argsStr || '（未提供任务）';

  // External agents (Codex / WorkBuddy Desktop Bridge) run outside the local loop
  if (subDef.type === 'external') {
    const res = await extAgents.runExternalAgent(subDef, taskText, { store: deps.store, computerManager: deps.computerManager });
    return res;
  }

  const store = deps.store;

  // own conversation + session
  const conv = store.conversations.create({ projectId: parentRunCtx.projectId, agentId: subDef.id, title: taskText.slice(0, 40) });
  store.messages.create({ conversation_id: conv.id, role: 'user', content: taskText });

  // autonomous permission engine for delegated work (audit still recorded)
  const subPE = new PermissionEngine();
  ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write', 'git.read', 'git.write', 'network', 'mcp', 'search'].forEach(s => subPE.grant(s, 'always'));

  const subDeps = {
    store,
    project: deps.project,
    projectRoot: deps.projectRoot,
    permissionEngine: subPE,
    buildProvider: deps.buildProvider,
    getTool: deps.getTool,
    subAgentTool: () => null,           // no nested sub-agents (prevents recursion)
    runSubAgent: () => Promise.resolve(JSON.stringify({ ok: false, error: { code: 'NO_NESTED_SUBAGENT', message: '子 Agent 不可再派生子 Agent' } })),
    sendChatTask: deps.sendChatTask,
    requestPermission: async () => ({ decision: 'allow', range: 'always' }),
    // surface sub-agent activity inside the parent chat (shadow), DB stays in sub conversation
    emit: (type, payload) => deps.emit(type, { ...payload, conversationId: parentRunCtx.conversationId, subAgentId: subDef.id }),
    pinnedFacts: []
  };

  const history = store.messages.list(conv.id);
  const toolDefs = deps.buildToolDefs(subDef);
  const res = await runAgentTurn(subDeps, { agent: subDef, conversationId: conv.id, userMessage: taskText, history, toolDefs });

  const changed = store.fileChanges.list(parentRunCtx.projectId).filter(fc => fc.task_id === res.taskId);
  const resultObj = {
    status: res.aborted ? 'cancelled' : (res.ok ? 'completed' : 'failed'),
    summary: (res.content || '').slice(0, 600),
    findings: [],
    changedFiles: changed.map(c => ({ path: c.path })),
    artifacts: [],
    errors: res.ok ? [] : [res.error]
  };
  return JSON.stringify(resultObj);
}

module.exports = { runSubAgent };
