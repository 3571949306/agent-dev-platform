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
const fs = require('fs');
const { spawn } = require('child_process');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { killTree, resolveCliInPath } = require('../../services/externalAgents');

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
    const exe = this.executable;
    let path = null;
    if (exe.includes('/') || exe.includes('\\') || exe.toLowerCase().endsWith('.exe')) {
      path = fs.existsSync(exe) ? exe : null;
    } else {
      try { path = await resolveCliInPath(exe); } catch { path = null; }
    }
    this._detected = { available: !!path, path };
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
    return new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawn(path, this.versionCommand, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(new Error('spawn failed: ' + e.message));
      }
      const timer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        reject(new Error('version command timed out'));
      }, VERSION_TIMEOUT_MS);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`${this.executable} ${this.versionCommand.join(' ')} exited with code ${code}`));
      });
    });
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

    const runId = crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const extraArgs = Array.isArray(task.args) ? task.args : [];
    const args = [...this.args, ...extraArgs, taskText];
    const cwd = task.cwd || this.cwd || (context && context.projectRoot) || undefined;
    const timeoutMs = task.timeoutMs || this.timeoutMs;
    const env = (context && context.env) || undefined;

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      child: null,
      timer: null,
      startedAt: Date.now(),
      stdout: '',
      stderr: ''
    };
    this._runs.set(runId, runState);

    let child;
    try {
      child = spawn(detected.path, args, {
        windowsHide: true,
        cwd,
        env,
        // POSIX: 成为进程组 leader，killTree() 可一并回收子进程。
        detached: process.platform !== 'win32'
      });
    } catch (e) {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [`spawn 失败: ${e.message}`],
        exitCode: null
      };
      return { runId };
    }
    runState.child = child;
    runState.status = LIFECYCLE.RUNNING;

    // 超时定时器
    runState.timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      if (runState.status === LIFECYCLE.RUNNING || runState.status === LIFECYCLE.STARTING) {
        runState.status = LIFECYCLE.TIMEOUT;
        runState.result = this._buildResult('timeout', runState.stdout, runState.stderr, {
          errors: [`${this.executable} 超过 ${Math.round(timeoutMs / 1000)}s 未结束`]
        });
      }
    }, timeoutMs);
    if (typeof runState.timer.unref === 'function') runState.timer.unref();

    // abort 信号
    const onAbort = () => {
      killTree(child, 'SIGKILL');
      if (runState.status === LIFECYCLE.RUNNING || runState.status === LIFECYCLE.STARTING) {
        runState.status = LIFECYCLE.CANCELLED;
        runState.result = this._buildResult('cancelled', runState.stdout, runState.stderr, {
          errors: ['用户已停止']
        });
      }
    };
    if (ac.signal.aborted) onAbort();
    else {
      try { ac.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ }
    }

    // stdin 注入（可选）
    if (task.stdin && child.stdin) {
      try {
        child.stdin.write(typeof task.stdin === 'string' ? task.stdin : JSON.stringify(task.stdin));
        child.stdin.end();
      } catch { /* ignore stdin errors */ }
    } else if (child.stdin) {
      try { child.stdin.end(); } catch { /* noop */ }
    }

    child.stdout.on('data', d => {
      const chunk = d.toString();
      runState.stdout += chunk;
      if (context && context.onChunk) {
        try { context.onChunk(chunk); } catch { /* listener must not break the run */ }
      }
    });
    child.stderr.on('data', d => { runState.stderr += d.toString(); });

    child.on('error', e => {
      if (runState.timer) clearTimeout(runState.timer);
      if (runState.status === LIFECYCLE.RUNNING || runState.status === LIFECYCLE.STARTING) {
        runState.status = LIFECYCLE.FAILED;
        runState.result = this._buildResult('failed', runState.stdout, runState.stderr, {
          errors: [`进程错误: ${e.message}`]
        });
      }
    });

    child.on('close', code => {
      if (runState.timer) { clearTimeout(runState.timer); runState.timer = null; }
      // 已经被 timeout / cancel / error 抢先标记终态，保留第一个终态
      if (runState.status === LIFECYCLE.RUNNING || runState.status === LIFECYCLE.STARTING) {
        const ok = code === 0;
        runState.status = ok ? LIFECYCLE.COMPLETED : LIFECYCLE.FAILED;
        runState.result = this._buildResult(ok ? 'completed' : 'failed', runState.stdout, runState.stderr, {
          exitCode: code,
          errors: ok ? [] : [`${this.executable} 退出码 ${code}${runState.stderr ? '：' + runState.stderr.slice(0, 300) : ''}`]
        });
      }
    });

    return { runId };
  }

  /** 按 outputFormat 构建统一结果对象。 */
  _buildResult(status, stdout, stderr, extra = {}) {
    const parsed = parseOutput(stdout, this.outputFormat);
    return {
      status,
      summary: (stdout || stderr || '').slice(0, 4000),
      findings: [],
      changedFiles: [],
      artifacts: [],
      errors: [],
      exitCode: extra.exitCode != null ? extra.exitCode : null,
      stdout: stdout || '',
      stderr: stderr || '',
      parsed: parsed.ok ? parsed.value : null,
      ...extra
    };
  }

  /** sendMessage：CLI 单次 exec 不支持运行中追加消息（无 stdin 通道复用）。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'cli agent does not support mid-run messages' };
  }

  /** 取消：killTree + abort。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    if (run.child) {
      try { killTree(run.child, 'SIGKILL'); } catch { /* gone */ }
    }
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
      run.result = this._buildResult('cancelled', run.stdout, run.stderr, { errors: ['用户已停止'] });
    }
    return { ok: true };
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
      if (run.timer) { clearTimeout(run.timer); run.timer = null; }
      if (run.child) {
        try { killTree(run.child, 'SIGKILL'); } catch { /* gone */ }
      }
      try { run.ac.abort(); } catch { /* noop */ }
    }
    this._runs.clear();
    this._detected = null;
  }
}

module.exports = { CliAgentAdapter, parseOutput };
