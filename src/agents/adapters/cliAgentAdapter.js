'use strict';
/**
 * v2.6.0 Agent Integration Hub — 通用 CLI 适配器（spec §4.3）。
 *
 * 为未来的 Claude Code、Gemini CLI、Aider 等命令行 Agent 提供统一接入。
 * Codex / WorkBuddy 各有专用适配器，本类面向"任何 spawn 出来就能用"的 CLI。
 *
 * 设计要点：
 *  - config 注入：{ executable, args, cwd, timeoutMs, versionCommand, outputFormat }
 *  - detect 用 resolveCliInPath 探测 PATH；可执行路径带分隔符时直接 fs.existsSync。
 *  - healthCheck 跑 versionCommand（默认 ['--version']），限时 5s。
 *  - startTask 用 child_process.spawn 启动，收集 stdout/stderr；exit code 0=completed，非0=failed。
 *  - 支持 JSON / JSONL 输出解析（outputFormat: 'text' | 'json' | 'jsonl'）。
 *  - 取消通过 killTree（来自 externalAgents.js）回收整个进程树，并 abort 信号。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { createCliProcessSupervisor, buildEnvAllowlist } = require('../runtime/cliProcessSupervisor');
const { createExternalAgentTerminalGate } = require('../runtime/externalTerminalGate');
const pathSecurity = require('../../security/pathSecurity');
const { buildExternalResult, sanitizeRaw } = require('../runtime/resultSanitizer');

const VERSION_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600000;

/** 把 stdout 按 outputFormat 解析；text 模式直接返回原字符串。 */
function parseOutput(stdout, outputFormat) {
  const text = String(stdout || '');
  if (outputFormat === 'json') {
    try { return { ok: true, value: JSON.parse(text), raw: text }; }
    catch (e) { return { ok: false, value: null, raw: text, error: 'JSON 解析失败: ' + e.message }; }
  }
  if (outputFormat === 'jsonl') {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const items = [];
    for (const line of lines) {
      try { items.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return { ok: true, value: items, raw: text };
  }
  return { ok: true, value: text, raw: text };
}

class CliAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest                  Agent manifest
   * @param {object} opts.config                    适配器配置
   * @param {string} opts.config.executable         可执行命令（如 'claude' / 'aider' / 绝对路径）
   * @param {string[]} [opts.config.args]           固定参数（task 文本会作为最后一个参数追加）
   * @param {string} [opts.config.cwd]              工作目录（缺省取 context.projectRoot）
   * @param {number} [opts.config.timeoutMs]        Run 超时（默认 600s）
   * @param {string[]|string} [opts.config.versionCommand] 版本探测命令参数（默认 ['--version']）
   * @param {'text'|'json'|'jsonl'} [opts.config.outputFormat] 输出解析模式（默认 text）
   */
  constructor({ manifest, config } = {}) {
    super({ manifest, config });
    if (!config || !config.executable) {
      throw new Error('CliAgentAdapter: config.executable 必填');
    }
    this.executable = config.executable;
    this.args = Array.isArray(config.args) ? config.args : [];
    this.cwd = config.cwd || null;
    this.timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.versionCommand = config.versionCommand
      ? (Array.isArray(config.versionCommand) ? config.versionCommand : [config.versionCommand])
      : ['--version'];
    this.outputFormat = config.outputFormat || 'text';
    this.passthroughEnv = Array.isArray(config.passthroughEnv) ? config.passthroughEnv : [];
    this.environment = config.environment || {};
    this.supervisor = config.supervisor || createCliProcessSupervisor();
    this._gate = createExternalAgentTerminalGate();
    // runId -> { ac, status, result, child, startedAt, timer }
    this._runs = new Map();
    this._detected = null;
  }

  getManifest() { return { ...this.manifest }; }

  /**
   * 探测可执行文件是否存在。
   *  - 带路径分隔符或 .exe 后缀 → fs.existsSync
   *  - 否则 → resolveCliInPath（which / where）
   */
  async detect() {
    if (this._detected) return this._detected;
    this._detected = await this.supervisor.detect(this.executable);
    return this._detected;
  }

  /** 健康检查：跑 versionCommand，限时 5s。 */
  async healthCheck() {
    const start = Date.now();
    const detected = await this.detect();
    if (!detected.available) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: `${this.executable} not found`
      };
    }
    try {
      const version = await this._runVersion(detected.path);
      return {
        status: HEALTH_STATE.HEALTHY,
        version,
        latencyMs: Date.now() - start,
        detail: `${this.executable} responsive`
      };
    } catch (e) {
      return {
        status: HEALTH_STATE.DEGRADED,
        version: null,
        latencyMs: Date.now() - start,
        detail: `version command failed: ${e.message}`
      };
    }
  }

  _runVersion(path) {
    return this.supervisor.readVersion(path, this.versionCommand, VERSION_TIMEOUT_MS);
  }

  /**
   * 启动一次 CLI Run。
   * @param {object} task    { goal, args (额外参数), cwd, timeoutMs, stdin }
   * @param {object} context { signal, onChunk, projectRoot, projectId, env, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('CliAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;
    const detected = await this.detect();
    if (!detected.available) {
      throw new Error(`CliAgentAdapter: executable "${this.executable}" not available`);
    }

    const requestedRoot = task.cwd || context.projectRoot || this.cwd || null;
    if (context.productionHub && !context.projectRoot) {
      throw Object.assign(new Error('CLI production run requires projectRoot'), { code: 'PROJECT_ROOT_REQUIRED' });
    }
    const cwd = context.productionHub
      ? pathSecurity.canonicalizeRoot(context.projectRoot)
      : requestedRoot || undefined;
    const runId = context.runId || crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const extraArgs = Array.isArray(task.args) ? task.args : [];
    const args = [...this.args, ...extraArgs, taskText];
    const timeoutMs = task.timeoutMs || this.timeoutMs;
    const env = buildEnvAllowlist(this.passthroughEnv, { ...this.environment, ...((context && context.env) || {}) });

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      child: null,
      handle: null,
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      context,
      actualCwd: cwd || null
    };
    this._runs.set(runId, runState);
    this._gate.init(runId, LIFECYCLE.STARTING);

    try {
      const handle = await this.supervisor.spawnProcess({
        command: detected.path, args, cwd, env, timeoutMs,
        signal: ac.signal, runId
      });
      runState.handle = handle;
      runState.child = handle.child;
    } catch (e) {
      this._finish(runState, LIFECYCLE.FAILED, {
        status: 'failed',
        summary: '',
        errors: [`spawn 失败: ${e.message}`],
        exitCode: null
      });
      return { runId };
    }
    runState.status = LIFECYCLE.RUNNING;

    // stdin 注入（可选）
    const child = runState.child;
    if (task.stdin && child.stdin) {
      try {
        child.stdin.write(typeof task.stdin === 'string' ? task.stdin : JSON.stringify(task.stdin));
        child.stdin.end();
      } catch { /* ignore stdin errors */ }
    } else if (child.stdin) {
      try { child.stdin.end(); } catch { /* noop */ }
    }

    if (child.stdout) child.stdout.on('data', d => {
      const chunk = d.toString();
      runState.stdout += chunk;
      if (context && context.onChunk) {
        try { context.onChunk(chunk); } catch { /* listener must not break the run */ }
      }
    });
    if (child.stderr) child.stderr.on('data', d => { runState.stderr += d.toString(); });

    runState.executionPromise = runState.handle.done.then(exit => {
      const stdout = runState.handle.stdout || runState.stdout;
      const stderr = runState.handle.stderr || runState.stderr;
      runState.stdout = stdout;
      runState.stderr = stderr;
      let lifecycle;
      let status;
      let errors = [];
      if (exit.aborted || ac.signal.aborted) {
        lifecycle = LIFECYCLE.CANCELLED; status = 'cancelled'; errors = ['用户已停止'];
      } else if (exit.timedOut) {
        lifecycle = LIFECYCLE.TIMEOUT; status = 'timeout'; errors = [`${this.executable} 超过 ${Math.round(timeoutMs / 1000)}s 未结束`];
      } else if (exit.code === 0) {
        lifecycle = LIFECYCLE.COMPLETED; status = 'completed';
      } else {
        lifecycle = LIFECYCLE.FAILED; status = 'failed';
        errors = [exit.error ? `进程错误: ${exit.error}` : `${this.executable} 退出码 ${exit.code}${stderr ? '：' + stderr.slice(0, 300) : ''}`];
      }
      const result = this._buildResult(status, stdout, stderr, { exitCode: exit.code, errors, quiesced: exit.quiesced !== false, residual: exit.residual || 0 });
      this._finish(runState, lifecycle, result);
      return result;
    });

    return { runId };
  }

  _finish(run, lifecycle, result) {
    const tr = this._gate.transition(run.runId, lifecycle);
    run.status = tr.status;
    if (!tr.accepted) return tr;
    run.result = result;
    if (run.context && typeof run.context.finishRun === 'function') {
      try { run.context.finishRun(lifecycle, result); } catch { /* noop */ }
    }
    return tr;
  }

  /** 按 outputFormat 构建统一结果对象。 */
  _buildResult(status, stdout, stderr, extra = {}) {
    const parsed = parseOutput(stdout, this.outputFormat);
    const result = buildExternalResult({
      agentId: this.id,
      status,
      summary: (stdout || stderr || '').slice(0, 4000),
      errors: extra.errors || [],
      provenance: { transport: 'cli', executable: this.executable }
    });
    result.exitCode = extra.exitCode != null ? extra.exitCode : null;
    result.quiesced = extra.quiesced !== false;
    result.residual = extra.residual || 0;
    result.sanitizedRaw = sanitizeRaw(parsed.ok ? parsed.value : { stdout, stderr, error: parsed.error });
    return result;
  }

  /** sendMessage：CLI 单次 exec 不支持运行中追加消息（无 stdin 通道复用）。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'cli agent does not support mid-run messages' };
  }

  /** 取消：killTree + abort。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    try { run.ac.abort(); } catch { /* already aborted */ }
    const q = await this.awaitQuiescence(runId, 5000);
    return { ok: q.quiesced, status: q.quiesced ? 'cancelled' : 'cancelling', quiesced: q.quiesced, residual: q.residual, detail: q.detail };
  }

  async awaitQuiescence(runId, timeoutMs = 5000) {
    const run = this._runs.get(runId);
    if (!run) return { quiesced: false, residual: 'unknown runId', detail: 'unknown runId' };
    if (!run.handle) return { quiesced: true, residual: 0, detail: 'CLI process was not started' };
    const q = await run.handle.awaitExit(timeoutMs);
    return { ...q, detail: q.quiesced ? 'CLI process tree exited' : 'CLI process tree exit unconfirmed' };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
      startedAt: run.startedAt,
      pid: run.child && run.child.pid != null ? run.child.pid : null
    };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：kill 所有在跑的进程。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try { run.ac.abort(); } catch { /* noop */ }
    }
    this.supervisor.dispose();
    this._runs.clear();
    this._gate.clear();
    this._detected = null;
  }
}

module.exports = { CliAgentAdapter, parseOutput };
