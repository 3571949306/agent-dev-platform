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

  // Delegated work runs semi-autonomously, but it may NEVER be more privileged
  // than the parent: `parent` makes evaluate() return strictest(sub, parent), so
  // anything the user denied (or never granted) upstream stays blocked here.
  const parentPE = deps.permissionEngine || parentRunCtx.permissionEngine || null;
  const subPE = new PermissionEngine({
    store,
    projectId: parentRunCtx.projectId || deps.project?.id || null,
    parent: parentPE
  });
  ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write', 'git.read', 'git.write', 'network', 'mcp']
    .forEach(s => subPE.grantSession(s));    // in-memory only — never written to the user's saved policy

  const subDeps = {
    store,
    project: deps.project,
    projectRoot: deps.projectRoot,
    permissionEngine: subPE,
    buildProvider: deps.buildProvider,
    getTool: deps.getTool,
    resolveModel: deps.resolveModel,
    visionSupport: deps.visionSupport,
    artifactsDir: deps.artifactsDir,
    subAgentTool: () => null,           // no nested sub-agents (prevents recursion)
    runSubAgent: () => Promise.resolve(JSON.stringify({ ok: false, error: { code: 'NO_NESTED_SUBAGENT', message: '子 Agent 不可再派生子 Agent' } })),
    sendChatTask: deps.sendChatTask,
    chatDepth: parentRunCtx.chatDepth || 0,
    maxChatDelegationDepth: parentRunCtx.maxChatDelegationDepth ?? 2,
    // The parent already answered the permission prompt; asking again here would
    // pop a second dialog for the same scope. A scope the parent DENIED never
    // reaches this point (strictest() short-circuits it to 'deny').
    requestPermission: deps.requestPermission
      ? (req) => deps.requestPermission({ ...req, viaSubAgent: subDef.name })
      : async () => ({ decision: 'allow', range: 'once' }),
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
