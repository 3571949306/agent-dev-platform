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

const { isDangerous } = require('../../tools/terminal');
const { gitDestructive } = require('../../tools/git');

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

  // complete / ask_permission / delegate 不在此执行
  if (type === 'complete' || type === 'ask_permission' || type === 'delegate') {
    return { ok: true, tool: type, data: { handledByLoop: true } };
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

  // 危险命令分级（§12）：High Risk 必须确认。这里只标记，实际权限由 permissionEngine 处理。
  if (type === 'run_command' || type === 'run_tests') {
    const cmd = args.command || '';
    if (isDangerous(cmd) || gitDestructive(cmd)) {
      // 权限引擎会拦截；这里在结果里标注风险等级供诊断
      return await runTool(ctx, toolName, args, getTool, action, { highRisk: true });
    }
  }

  return await runTool(ctx, toolName, args, getTool, action);
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
  const tool = typeof getTool === 'function' ? getTool(toolName) : null;
  if (!tool) {
    return { ok: false, tool: toolName, error: { code: 'TOOL_NOT_FOUND', message: `工具 ${toolName} 不可用` } };
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
  return shapeResult(toolName, action, raw, meta);
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

module.exports = {
  executeAction, isTestAction, isMutatingAction, isTestCommand,
  ACTION_TO_TOOL, MAX_OUTPUT
};
