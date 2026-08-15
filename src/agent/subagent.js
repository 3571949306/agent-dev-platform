'use strict';
/**
 * Sub-Agent execution. Runs a sub-agent to completion in its own conversation/session,
 * with its own tools (no further nesting), and returns a STRUCTURED result.
 */
const { runAgentTurn } = require('./runtime');
const { PermissionEngine } = require('../security/permissions');
const extAgents = require('../services/externalAgents');

function parseArgs(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/**
 * The one object every external adapter receives.
 *
 * P0-2 / P0-3 / P1-5: the old call site passed only `{store, computerManager}`,
 * so an external agent had no abort signal (Stop did nothing), no permission
 * engine (nothing was gated) and no project root (Codex ran in the app's cwd).
 * Building it in a single place means adding a field can't be forgotten by one
 * of the three adapters.
 */
function buildExternalContext(deps, subDef, parentRunCtx, extra = {}) {
  return {
    // identity
    projectId: parentRunCtx.projectId || deps.project?.id || null,
    projectRoot: parentRunCtx.projectRoot || deps.projectRoot || null,
    conversationId: parentRunCtx.conversationId || null,
    taskId: parentRunCtx.taskId || null,
    parentAgentId: parentRunCtx.agentId || null,
    parentAgentName: parentRunCtx.agentName || null,
    adapterId: subDef.id || null,
    adapterName: subDef.name || null,
    // control
    signal: parentRunCtx.abortSignal || deps.abortSignal || null,
    timeoutMs: parentRunCtx.toolTimeoutMs,
    // capabilities
    store: deps.store,
    computerManager: deps.computerManager,
    permissionEngine: parentRunCtx.permissionEngine || deps.permissionEngine || null,
    requestPermission: deps.requestPermission || null,
    // observability
    emit: deps.emit || (() => {}),
    onState: (state, detail) => {
      if (!deps.emit) return;
      deps.emit('external_agent_state', {
        conversationId: parentRunCtx.conversationId,
        taskId: parentRunCtx.taskId,
        agentId: subDef.id, name: subDef.name, state, detail
      });
    },
    onChunk: (text) => {
      if (!deps.emit) return;
      deps.emit('external_agent_output', {
        conversationId: parentRunCtx.conversationId,
        taskId: parentRunCtx.taskId,
        agentId: subDef.id, name: subDef.name, chunk: text
      });
    },
    ...extra
  };
}

async function runSubAgent(deps, subDef, argsStr, parentRunCtx) {
  const taskText = parseArgs(argsStr).task || argsStr || '（未提供任务）';

  // External agents (Codex / WorkBuddy Desktop Bridge) run outside the local loop
  if (subDef.type === 'external') {
    const ctx = buildExternalContext(deps, subDef, parentRunCtx, {
      sleep: deps.sleep, now: deps.now,
      bridgeOptions: deps.bridgeOptions,
      // P0-4: an adapter may pin its own vision model, so resolve per adapter
      // and fall back to whatever the host injected.
      visionReader: (deps.visionReaderFor && deps.visionReaderFor(subDef)) || deps.visionReader || null
    });
    if (typeof deps.runExternalAgentHub === 'function') {
      return deps.runExternalAgentHub(subDef, taskText, ctx);
    }
    if (deps.externalExecutionMode === 'legacy-fixture') {
      return extAgents.runExternalAgent(subDef, taskText, ctx);
    }
    return JSON.stringify({
      ok: false,
      status: 'failed',
      errorCode: 'EXTERNAL_AGENT_HUB_REQUIRED',
      errors: ['EXTERNAL_AGENT_HUB_REQUIRED']
    });
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
    // P0-3: Stop on the main chat must cancel delegated work too. Without this
    // the sub-agent opened its own AbortController and kept running after the
    // parent turn had already returned `cancelled`.
    abortSignal: parentRunCtx.abortSignal,
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
    // P1-6: a sub-agent delegating to a chat must inherit the parent's chain,
    // otherwise A→(sub)→A looks like a fresh delegation.
    delegationPath: Array.isArray(parentRunCtx.delegationPath) ? parentRunCtx.delegationPath.slice() : [],
    isChatBusy: deps.isChatBusy,
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

module.exports = { runSubAgent, buildExternalContext };
