'use strict';
/**
 * v2.8.0 — `codex exec --json` 结构化运行器（spec §43 C / §44 / §59）。
 *
 * 这是 Codex 的 **fallback** 路径：当 app-server 不可用（老版本 / 缺少子命令 /
 * 方法探测失败）时使用。它依然是**结构化 JSON**，不是文本抓取 ——
 * spec §44 明确禁止把"正则分析自然语言终端输出"当作 production primary path，
 * 这里读的是官方 JSONL 事件流（exec_events.rs 的 ThreadEvent）。
 *
 * flag 来源（openai/codex @ 21aa552e，逐条核对，不臆造）：
 *   exec/src/cli.rs:59-65        --json（alias --experimental-json），global
 *   exec/src/cli.rs:76-77        [PROMPT] 位置参数；`-` 表示从 stdin 读
 *   exec/src/cli.rs:31-32        --skip-git-repo-check
 *   exec/src/cli.rs:147-156      子命令 resume / fork / review
 *   utils/cli/src/shared_options.rs:22-23  -m/--model
 *   utils/cli/src/shared_options.rs:40-41  -s/--sandbox
 *   utils/cli/src/shared_options.rs:67-68  -C/--cd <DIR>
 *   utils/cli/src/shared_options.rs:70-71  --add-dir <DIR>
 *   utils/cli/src/sandbox_mode_cli_arg.rs:14-18  read-only|workspace-write|danger-full-access
 *
 * 明确 **不使用** 的 flag：
 *   --dangerously-bypass-approvals-and-sandbox（yolo）
 *   --dangerously-bypass-hook-trust
 *   → spec §36：危险操作不得自动放行，平台不主动降级 Codex 自身的安全边界。
 */

const { createStructuredStreamDecoder } = require('../../runtime/structuredStreamDecoder');
const { createCliProcessSupervisor } = require('../../runtime/cliProcessSupervisor');
const { createCodexExecEventMapper } = require('./codexEventMapper');

/** 合法 sandbox 取值（超出集合的一律忽略，避免把 CLI 参数写坏）。 */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/**
 * 组装 `codex exec` 参数。
 * @param {object} o
 * @returns {string[]}
 */
function buildExecArgs(o = {}) {
  const args = ['exec'];

  // resume 是子命令，必须紧跟 exec
  if (o.resumeSessionId) {
    args.push('resume', String(o.resumeSessionId));
  }

  args.push('--json');

  if (o.cwd) args.push('--cd', o.cwd);
  if (o.model) args.push('--model', String(o.model));
  if (o.sandbox && SANDBOX_MODES.has(o.sandbox)) args.push('--sandbox', o.sandbox);
  if (Array.isArray(o.addDirs)) {
    for (const d of o.addDirs) { if (d) args.push('--add-dir', String(d)); }
  }
  if (o.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs.filter(a => typeof a === 'string'));

  // prompt 走 stdin（`-`），避免超长 prompt 触碰 Windows 命令行 32767 字符上限，
  // 也避免引号/换行在 shell 层被破坏。
  args.push('-');
  return args;
}

/**
 * 创建 exec 运行器。
 * @param {object} [opts]
 * @param {object} [opts.supervisor] 注入的 CliProcessSupervisor（单测用）
 */
function createCodexExecRunner({ supervisor } = {}) {
  const sup = supervisor || createCliProcessSupervisor();

  /**
   * 执行一次 codex exec 并返回统一结果。
   *
   * @param {object} o
   * @param {string} o.command codex 可执行路径
   * @param {string} o.prompt
   * @param {string} [o.cwd]
   * @param {object} [o.env] 已 allowlist 的 env
   * @param {number} [o.timeoutMs]
   * @param {AbortSignal} [o.signal]
   * @param {Function} [o.onEvent] (type, payload) => void
   * @param {string} [o.runId]
   * @param {string} [o.agentId]
   * @returns {Promise<{status:string, threadId:string|null, summary:string,
   *                    changedFiles:string[], diff:string, usage:object|null,
   *                    plan:*, errors:string[], exitCode:number|null}>}
   */
  async function run(o = {}) {
    const mapper = createCodexExecEventMapper({ emit: o.onEvent });
    const decoder = createStructuredStreamDecoder({ frameLimitBytes: o.frameLimitBytes });

    let threadId = null;
    let terminal = null;          // 来自事件流的终态（权威）
    const protocolErrors = [];

    decoder.on('message', evt => {
      const r = mapper.map(evt, { runId: o.runId, agentId: o.agentId });
      if (r && r.threadId) threadId = r.threadId;
      if (r && r.terminal) terminal = r.terminal;
    });
    decoder.on('malformed', info => {
      // 单条畸形不致命，只记录（spec §62）
      protocolErrors.push(`畸形事件（${info.error}）: ${String(info.preview || '').slice(0, 120)}`);
    });
    decoder.on('error', info => {
      protocolErrors.push(`协议流损坏: ${info.reason}`);
    });

    const handle = await sup.spawnProcess({
      command: o.command,
      args: buildExecArgs(o),
      cwd: o.cwd,
      env: o.env,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      captureOutput: false // stdout 是 JSONL 协议流，由 decoder 增量消费
    });

    if (handle.child.stdout) handle.child.stdout.on('data', chunk => decoder.push(chunk));

    // prompt 经 stdin 传入（args 末尾是 `-`）
    try {
      if (handle.child.stdin) {
        handle.child.stdin.write(String(o.prompt || ''));
        handle.child.stdin.end();
      }
    } catch { /* stdin 已关闭：由退出码路径兜底 */ }

    const exit = await handle.done;
    try { decoder.flush(); } catch { /* noop */ }

    const acc = mapper.finalize();
    const errors = [...acc.errors, ...protocolErrors];

    // 终态判定优先级（spec §65/§67）：
    //   1) 取消 / 超时是**外因**，优先于事件流
    //   2) 事件流给出的 turn.completed / turn.failed 是权威
    //   3) 没有任何终态事件却已退出 → FAILED（绝不当作 completed）
    let status;
    if (exit.aborted || (o.signal && o.signal.aborted)) {
      status = 'cancelled';
      if (!errors.length) errors.push('用户已停止');
    } else if (exit.timedOut) {
      status = 'timeout';
      errors.push(`执行超时（${o.timeoutMs} ms）`);
    } else if (terminal === 'completed') {
      status = 'completed';
    } else if (terminal === 'failed') {
      status = 'failed';
    } else if (exit.error) {
      status = 'failed';
      errors.push(`进程错误: ${exit.error}`);
    } else {
      status = 'failed';
      errors.push(
        exit.code === 0
          ? 'codex exec 退出但未产生终态事件（协议流不完整）'
          : `codex exec 异常退出（exit=${exit.code}${exit.signal ? `, signal=${exit.signal}` : ''}）`
      );
      // stderr 只在失败时纳入诊断，且截断，避免泄露/膨胀（spec §70/§127）
      const errTail = String(handle.stderr || '').trim().slice(-2000);
      if (errTail) errors.push(`stderr: ${errTail}`);
    }

    return {
      status,
      threadId,
      summary: acc.summary,
      changedFiles: acc.changedFiles,
      diff: acc.diff,
      usage: acc.usage,
      plan: acc.plan,
      errors,
      exitCode: exit.code != null ? exit.code : null
    };
  }

  return { run, buildExecArgs };
}

module.exports = {
  createCodexExecRunner,
  buildExecArgs,
  SANDBOX_MODES
};
