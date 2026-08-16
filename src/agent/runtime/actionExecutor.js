'use strict';
/**
 * v2.6.0 Main Agent Runtime — Action Executor（spec §8/§9/§11/§12/§26）。
 *
 * 把结构化 Action 映射到现有工具（filesystem / terminal / git / patch），
 * 复用 v2.5.1 PathGuard 沙箱与现有 tool.exec(runCtx, args) 接口，
 * 不重复造第二套文件系统。
 *
 * 返回丰富的 Tool Result Feedback（§26），供 Main Agent 下一轮修复。
 * stdout/stderr 有长度上限，防止 Context 被巨大日志撑爆（§11）。
 */

const { isHighRisk } = require('../../tools/terminal');
const { getAgentHub } = require('../../agents/hub/agentHub');
const { dispatchRuntimeHook } = require('../../hooks/runtimeDispatch');
const { authorize } = require('../../security/permissionRuntime');

const MAX_OUTPUT = 20000;   // 单条 stdout/stderr 摘要上限
const MAX_ERRORS = 20;      // errors 列表上限

/** Action 类型 → 工具名映射。 */
const ACTION_TO_TOOL = {
  read_file: 'read_file',
  read_files: 'read_file',       // 多文件：executor 内循环
  list_directory: 'list_directory',
  search: 'search',
  find_text: 'search',
  write_file: 'write_file',
  patch_file: 'apply_patch',
  create_file: 'create_file',
  delete_file: 'delete_file',
  run_command: 'terminal_run',
  run_tests: 'terminal_run',
  git_status: 'git_status',
  git_diff: 'git_diff'
};

/** 判断 Action 是否为「测试类」（结果会影响 Test→Repair Loop）。 */
function isTestAction(action) {
  return action && (action.type === 'run_tests' ||
    (action.type === 'run_command' && isTestCommand(action.args && action.args.command)));
}

function isTestCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return /\b(npm\s+(test|run\s+(test|e2e|smoke))|node\s+--test|pytest|jest|mocha|tsc)\b/i.test(cmd);
}

/** 判断 Action 是否会修改文件（用于 checkpoint / diff 跟踪）。 */
function isMutatingAction(action) {
  return action && ['write_file', 'patch_file', 'create_file', 'delete_file'].includes(action.type);
}

/**
 * 执行一个 Action。
 * @param {object} ctx runCtx（projectRoot, projectId, taskId, agentId, store, emit, abortSignal）
 * @param {object} action { type, args, thought }
 * @param {Function} getTool (name) => tool def（含 exec）
 * @returns {Promise<object>} Tool Result（§26 结构）
 */
async function executeAction(ctx, action, getTool) {
  const { type, args } = action;

  // complete / ask_permission 由 loop 处理
  if (type === 'complete' || type === 'ask_permission') {
    return { ok: true, tool: type, data: { handledByLoop: true } };
  }

  // v2.7.0 — delegate：经 AgentHub 路由到合适的 Agent；Hub 未初始化时回退原行为
  if (type === 'delegate') {
    return await executeDelegate(ctx, action, args);
  }

  // read_files：循环 read_file
  if (type === 'read_files') {
    return await executeReadFiles(ctx, args, getTool);
  }

  // find_text → search 工具的 query 参数
  if (type === 'find_text') {
    return await runTool(ctx, 'search', { query: args.query || args.pattern || args.text || '' }, getTool, action);
  }
  if (type === 'search') {
    return await runTool(ctx, 'search', { query: args.query || args.pattern || '' }, getTool, action);
  }

  const toolName = ACTION_TO_TOOL[type];
  if (!toolName) {
    return { ok: false, tool: type, error: { code: 'UNKNOWN_ACTION', message: `未知 action 类型: ${type}` } };
  }

  // 危险命令分级（§12 / v2.9.8 R1）：High Risk 必须确认。这里只标记，
  // 实际权限由 permissionEngine 的 terminal.dangerous 域裁决。
  if (type === 'run_command' || type === 'run_tests') {
    const cmd = args.command || '';
    if (isHighRisk(cmd)) {
      // 权限引擎会拦截；这里在结果里标注风险等级供诊断
      return await runTool(ctx, toolName, args, getTool, action, { highRisk: true });
    }
  }

  return await runTool(ctx, toolName, args, getTool, action);
}

/**
 * v2.7.0 — delegate action：经 AgentHub 路由到合适的 Agent 并等待结果。
 *
 * AgentHub 未初始化（getAgentHub() === null）时回退到原行为
 * （{ handledByLoop: true }，交由 agentLoop 自行处理），保证旧测试不受影响。
 *
 * delegate args: { task, requiredCapabilities, agentId? }
 *   - agentId 指定 → hub.start(agentId, task)
 *   - 未指定      → hub.startAuto(task)（按 requiredCapabilities 自动路由）
 *
 * @param {object} ctx    runCtx
 * @param {object} action { type, args, thought }
 * @param {object} args   { task, requiredCapabilities, agentId? }
 * @returns {Promise<object>} Tool Result
 */
async function executeDelegate(ctx, action, args) {
  const before = await dispatchRuntimeHook(ctx, 'before_delegate', {
    toolName: 'delegate',
    actionType: 'delegate',
    toolArgs: args || {}
  });
  if (!before.ok) {
    return {
      ok: false,
      tool: 'delegate',
      action,
      error: { code: before.errorCode, message: before.error || before.errorCode, retryable: true },
      hookId: before.hookId || null
    };
  }
  const result = await executeDelegateCore(ctx, action, args);
  await dispatchRuntimeHook(ctx, 'after_delegate', {
    toolName: 'delegate',
    actionType: 'delegate',
    outcome: { ok: result.ok, status: result.data && result.data.status }
  });
  return result;
}

async function executeDelegateCore(ctx, action, args) {
  if (ctx && ctx.canDelegate === false) {
    return {
      ok: false,
      tool: 'delegate',
      action,
      error: { code: 'PERMISSION_DENIED', message: 'Dynamic Agent delegation is disabled by policy', retryable: false }
    };
  }
  // v2.9.0 §7A 修复：优先用 orchestrator（如注入）走完整闭环
  //   Orchestrator → AgentHubBridge → AgentHub.route/start → Child Run → wait → Blackboard
  //   含 delegationPath/depth、fallback policy、no-bypass、Blackboard 写入。
  if (ctx && ctx.orchestrator && typeof ctx.orchestrator.delegate === 'function') {
    try {
      // v2.9.8 R3 — Preserve original delegate error identity：
      // Orchestrator 返回的 result 已经携带明确 errorCode（DYNAMIC_AGENT_DEFINITION_NOT_FOUND、
      // SELF_DELEGATION_BLOCKED、DELEGATION_DEPTH_EXCEEDED、PROJECT_LOCKED、PERMISSION_DENIED 等）。
      // 这些是「Child 从未启动」的 pre-start 失败，必须保持原始 error code，不得统一重写为
      // DELEGATE_FAILED。只有 Child 真实启动并到达失败终态时才使用 DELEGATE_* 系列 code。
      const result = await ctx.orchestrator.delegate(args || {}, {
        abortSignal: ctx.abortSignal,
        conversationId: ctx.conversationId,
        taskId: ctx.taskId,
        delegationPath: ctx.delegationPath || []
      });
      const childSummary = (result && (result.summary || (result.errors && result.errors[0]))) || '';

      // Pre-start policy/configuration failure：保持 errorCode 原样
      // v2.9.8 Final Closure（A2）：data.executionStarted 显式携带，区分「Run 已创建」与「execution 真实开始」
      if (result && result.ok === false && result.errorCode) {
        return {
          ok: false,
          tool: 'delegate',
          action,
          summary: childSummary ? `child=${result.agentId || '?'} status=${result.status || '?'}: ${childSummary}` : undefined,
          data: { runId: result.runId, agentId: result.agentId, status: result.status, executionStarted: result.executionStarted === true, result },
          error: {
            code: result.errorCode,
            message: (result.errors && result.errors[0]) || result.summary || 'delegate 未完成',
            retryable: ['TIMEOUT', 'UNAVAILABLE'].includes(result.errorCode) || result.errorCode === 'DELEGATE_TIMEOUT' || result.errorCode === 'DELEGATE_UNAVAILABLE'
          }
        };
      }

      return {
        ok: !!result.ok,
        tool: 'delegate',
        action,
        summary: childSummary ? `child=${result.agentId || '?'} status=${result.status || '?'}: ${childSummary}` : undefined,
        data: { runId: result.runId, agentId: result.agentId, status: result.status, executionStarted: result.executionStarted === true, result },
        error: result.ok ? null : {
          code: `DELEGATE_${String(result.status || 'FAILED').toUpperCase()}`,
          message: (result.errors && result.errors[0]) || result.summary || 'delegate 未完成',
          retryable: result.status === 'timeout' || result.status === 'unavailable'
        }
      };
    } catch (e) {
      return { ok: false, tool: 'delegate', action, error: { code: 'DELEGATE_START_FAILED', message: e.message, retryable: true } };
    }
  }
  const hub = getAgentHub();
  if (!hub) {
    return { ok: true, tool: 'delegate', data: { handledByLoop: true } };
  }
  const { task: delegateTask, requiredCapabilities, agentId } = args || {};
  const required = Array.isArray(requiredCapabilities) ? requiredCapabilities : [];
  const requestedScopes = new Set(['filesystem.read']);
  if (required.includes('coding') || required.includes('filesystem')) requestedScopes.add('filesystem.write');
  if (required.includes('terminal') || required.includes('coding')) {
    requestedScopes.add('terminal.read');
    requestedScopes.add('terminal.write');
  }
  if (required.includes('research')) requestedScopes.add('network');
  if (required.includes('mcp')) requestedScopes.add('mcp');
  if (required.includes('computer')) requestedScopes.add('computer');
  const permissionContext = { taskId: ctx.taskId, runId: ctx.runId, projectId: ctx.projectId };
  // v2.9.9 CU2-A §22：ASK != DENY 且 ASK != ALLOW。
  //   parent deny  → scope 不可委派；
  //   parent ask   → Child 可进入 permission gate（实际动作仍须向用户询问）；
  //   parent allow → Child 可执行。
  const verdictOf = (s) => (ctx.permissionEngine ? ctx.permissionEngine.evaluate(s, permissionContext) : 'allow');
  const allowedScopes = [...requestedScopes].filter(s => verdictOf(s) !== 'deny');
  const promptScopes = [...requestedScopes].filter(s => verdictOf(s) === 'ask');
  const hubTask = {
    goal: typeof delegateTask === 'string' ? delegateTask : ((delegateTask && delegateTask.goal) || String(delegateTask || '')),
    required,
    allowedScopes,
    promptScopes,
    projectRoot: ctx.projectRoot,
    projectId: ctx.projectId,
    conversationId: ctx.conversationId,
    taskId: ctx.taskId
  };
  let startResult;
  try {
    startResult = agentId ? await hub.start(agentId, hubTask) : await hub.startAuto(hubTask);
  } catch (e) {
    return { ok: false, tool: 'delegate', action, error: { code: 'DELEGATE_START_FAILED', message: e.message, retryable: true } };
  }
  if (startResult.error) {
    return { ok: false, tool: 'delegate', action, error: { code: startResult.errorCode || 'DELEGATE_FAILED', message: startResult.error, retryable: !!startResult.runId } };
  }
  const runId = startResult.runId;
  // 轮询等待终态结果（adapter.startTask 立即返回 runId，后台异步执行）
  const POLL_MS = 500;
  const deadline = Date.now() + 600000;
  let last = null;
  while (Date.now() < deadline) {
    if (ctx.abortSignal && ctx.abortSignal.aborted) {
      try { await hub.cancel(runId); } catch { /* noop */ }
      return { ok: false, tool: 'delegate', action, error: { code: 'ABORTED', message: 'delegate 已取消' } };
    }
    try { last = await hub.result(runId); } catch { last = null; }
    if (last && /^(completed|failed|cancelled|timeout|interrupted)$/.test(last.status)) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  const status = last && last.status;
  const ok = status === 'completed';
  return {
    ok,
    tool: 'delegate',
    action,
    // hub.start 成功返回后 adapter 已真实启动（executionStarted=true）
    data: { runId, agentId: startResult.agentId, status, executionStarted: true, result: last && last.result },
    error: ok ? null : { code: `DELEGATE_${(status || 'TIMEOUT').toUpperCase()}`, message: (last && last.error) || 'delegate 未完成' }
  };
}

async function executeReadFiles(ctx, args, getTool) {
  const paths = Array.isArray(args.paths) ? args.paths : (args.path ? [args.path] : []);
  const results = [];
  let allOk = true;
  for (const p of paths) {
    const r = await runTool(ctx, 'read_file', { path: p }, getTool, { type: 'read_file', args: { path: p } });
    // shapeResult 把 read_file 的内容放在 r.content（顶层），不是 r.data.content。
    results.push({ path: p, ok: r.ok, content: r.ok ? r.content : null, error: r.error });
    if (!r.ok) allOk = false;
  }
  return {
    ok: allOk,
    tool: 'read_files',
    data: { files: results, count: results.length }
  };
}

async function runTool(ctx, toolName, args, getTool, action, meta = {}) {
  const before = await dispatchRuntimeHook(ctx, 'before_tool', {
    toolName,
    actionType: action && action.type,
    toolArgs: args || {}
  });
  if (!before.ok) {
    return {
      ok: false,
      tool: toolName,
      action,
      error: { code: before.errorCode, message: before.error || before.errorCode, retryable: true },
      hookId: before.hookId || null
    };
  }
  const tool = typeof getTool === 'function' ? getTool(toolName) : null;
  if (!tool) {
    return { ok: false, tool: toolName, error: { code: 'TOOL_NOT_FOUND', message: `工具 ${toolName} 不可用` } };
  }
  // v2.9.0 Real Runtime Closure（R4）：生产 PermissionEngine 闸门。Main Agent 工具执行
  // 前必须过权限评估：deny → 拒绝；ask → 走 requestPermission（无交互通道时 fail-safe 拒绝）。
  if (ctx && ctx.permissionEngine) {
    const scope = tool.permissionFor ? tool.permissionFor(args) : tool.permission;
    if (scope) {
      // v2.9.9 CU2-A：统一经 permissionRuntime.authorize 完整消费 range
      // （once/task/project/always/deny），不再只看 decision==='allow'。
      const auth = await authorize({
        engine: ctx.permissionEngine,
        scope,
        context: { taskId: ctx.taskId, runId: ctx.runId, projectId: ctx.projectId },
        requestPermission: ctx.requestPermission,
        requestMeta: { tool: toolName, args, conversationId: ctx.conversationId, runId: ctx.runId || null, agentId: ctx.agentId || null }
      });
      if (!auth.allowed) {
        const code = auth.code === 'PERMISSION_RANGE_INVALID' ? 'PERMISSION_RANGE_INVALID' : 'PERMISSION_DENIED';
        return { ok: false, tool: toolName, action, error: { code, message: `权限未批准: ${scope} (${auth.decision}${auth.range ? '/' + auth.range : ''})` } };
      }
    }
  }
  let raw;
  try {
    raw = await tool.exec(ctx, args);
  } catch (e) {
    return {
      ok: false, tool: toolName, action,
      error: { code: 'TOOL_ERROR', message: e.message, retryable: true }
    };
  }
  const result = shapeResult(toolName, action, raw, meta);
  await dispatchRuntimeHook(ctx, 'after_tool', {
    toolName,
    actionType: action && action.type,
    outcome: { ok: result.ok, errorCode: result.error && result.error.code }
  });
  return result;
}

/**
 * 把工具原始返回 shape 成 §26 的 Tool Result Feedback。
 * 给 Main Agent 下一轮足够上下文做修复。
 */
function shapeResult(toolName, action, raw, meta) {
  if (!raw) return { ok: false, tool: toolName, error: { code: 'EMPTY_RESULT', message: '工具无返回' } };
  const ok = raw.ok !== false;
  const result = {
    ok,
    tool: toolName,
    action,
    highRisk: meta.highRisk || false
  };

  if (!ok) {
    result.error = raw.error || { code: 'TOOL_FAILED', message: '工具执行失败' };
    return result;
  }

  const data = raw.data || {};
  // 终端命令：提取 exitCode / stdout / stderr 摘要
  if (toolName === 'terminal_run') {
    const stdout = String(data.stdout || '');
    const stderr = String(data.stderr || '');
    result.command = action && action.args && action.args.command;
    result.exitCode = data.exit_code;
    result.cwd = data.cwd;
    result.timedOut = data.exit_code === null && /timeout/i.test(raw.error && raw.error.code || '');
    result.stdoutSummary = truncate(stdout, MAX_OUTPUT);
    result.stderrSummary = truncate(stderr, MAX_OUTPUT);
    result.passed = data.exit_code === 0;
    result.errors = extractErrors(stdout, stderr);
    return result;
  }

  // 文件写入 / patch：返回 path + diff 摘要
  if (['write_file', 'create_file', 'apply_patch', 'delete_file'].includes(toolName)) {
    result.path = (action && action.args && action.args.path) || data.written || data.created || data.applied || data.deleted;
    result.applied = data.applied || data.written || data.created || data.deleted || null;
    if (data.added !== undefined) result.linesAdded = data.added;
    return result;
  }

  // 读文件：返回 content 长度（不放全文进 result，全文已在 ctx 里）
  if (toolName === 'read_file') {
    result.path = action && action.args && action.args.path;
    result.bytes = data.size || (data.content ? data.content.length : 0);
    result.content = data.content; // executor 消费方决定是否进 context
    return result;
  }

  // list_directory
  if (toolName === 'list_directory') {
    result.path = action && action.args && action.args.path;
    result.items = data.items || [];
    return result;
  }

  // search / git
  if (toolName === 'search') {
    result.matches = data.matches || data.results || [];
    return result;
  }
  if (toolName === 'git_status') { result.status = data.status; return result; }
  if (toolName === 'git_diff') { result.diff = data.diff; return result; }

  result.data = data;
  return result;
}

function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[截断，共 ${s.length} 字节]`;
}

/** 从 stdout/stderr 提取错误行（测试失败摘要）。 */
function extractErrors(stdout, stderr) {
  const errors = [];
  const sources = [stderr, stdout];
  for (const src of sources) {
    if (!src) continue;
    const lines = String(src).split(/\r?\n/);
    for (const line of lines) {
      if (errors.length >= MAX_ERRORS) break;
      if (/^\s*(not ok|FAIL|Error|AssertionError|expected|✕|✗|✘)/i.test(line) ||
          /\b\d+\s+failing\b/i.test(line) ||
          /tests?\s+\d+\s+failed/i.test(line)) {
        errors.push(line.slice(0, 200));
      }
    }
  }
  return errors;
}

// Workflow Engine entry for an already-resolved tool name. This deliberately
// reuses the same Hook, Tool Registry, PermissionEngine, PathSecurity, and tool
// execution gate as Main Agent actions; it is not a second tool runtime.
async function executeTool(ctx, toolName, args, getTool) {
  if (typeof toolName !== 'string' || !toolName) {
    return { ok: false, tool: toolName, error: { code: 'TOOL_NOT_FOUND', message: 'toolName is required' } };
  }
  return runTool(ctx, toolName, args || {}, getTool, { type: toolName, args: args || {} });
}

module.exports = {
  executeAction, executeTool, isTestAction, isMutatingAction, isTestCommand,
  ACTION_TO_TOOL, MAX_OUTPUT
};
