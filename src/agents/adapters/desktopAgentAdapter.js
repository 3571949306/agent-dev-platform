'use strict';
/**
 * v2.6.0 Agent Integration Hub — 通用桌面桥接适配器（spec §4.3）。
 *
 * 直接复用 DesktopAgentBridge（src/services/desktopBridge.js）驱动任意桌面 AI 应用
 * （WorkBuddy / ChatGPT 桌面 / 任意 chat-style 窗口）。WorkBuddy 适配器是本类的特化：
 * WorkBuddy 通过 runWorkBuddyBridge() 间接走 DesktopAgentBridge，
 * 本类则直接构造 DesktopAgentBridge，manifest 决定匹配哪个窗口。
 *
 * 设计要点：
 *  - manifest.config.windowMatch / windowTitle 决定目标窗口。
 *  - detect 通过 computerManager.listWindows() 找窗口；
 *    healthCheck 进一步读 UIA 文本，区分 healthy / degraded / unavailable
 *    （degraded = 窗口存在但 UIA 文本为空，需要 vision 降级）。
 *  - startTask 构造 DesktopAgentBridge 并调用 bridge.run(task.goal)，
 *    完整支持输入链（UIA ValuePattern → clipboard → SendKeys）、
 *    完成检测（sentinel / 文本稳定 / busy indicator / 超时）、
 *    视觉降级（visionReader 注入）。
 *  - 单并发：桌面只有一个前台窗口，并行 Run 会互相抢焦点。
 *  - 取消通过 AbortSignal：bridge 在每个 poll 循环都检查 aborted。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { DesktopAgentBridge, DEFAULTS } = require('../../services/desktopBridge');
const { buildExternalResult, stripSecrets } = require('../runtime/resultSanitizer');

const DEFAULT_WINDOW_MATCH = /workbuddy/i;
const DEFAULT_TIMEOUT_MS = 180000;

class DesktopAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest             Agent manifest（manifest.config.windowMatch / windowTitle）
   * @param {object} [opts.computerManager]    ComputerManager 实例
   * @param {object} [opts.config]             额外适配器配置（覆盖 manifest.config）
   * @param {object} [opts.visionReader]       DesktopVisionReader 实例（UIA 失效时降级用）
   */
  constructor({ manifest, computerManager, config, visionReader } = {}) {
    super({ manifest, config });
    this.computerManager = computerManager || null;
    this.visionReader = visionReader || null;
    // runId -> { ac, status, result, bridge, startedAt }
    this._runs = new Map();
  }

  getManifest() {
    return { ...this.manifest, maxConcurrency: this.manifest.maxConcurrency || 1 };
  }

  /** manifest 驱动的窗口匹配规则。 */
  _windowMatcher() {
    const cfg = { ...(this.manifest.config || {}), ...(this.config || {}) };
    const match = cfg.windowMatch || DEFAULT_WINDOW_MATCH;
    return {
      match: typeof match === 'string' ? new RegExp(match, 'i') : match,
      wantedTitle: cfg.windowTitle || null
    };
  }

  /** 列举窗口，按 manifest 的 match / windowTitle 找目标窗口。 */
  async _findWindow() {
    if (!this.computerManager || typeof this.computerManager.listWindows !== 'function') {
      return { ok: false, error: 'computerManager 不可用', window: null };
    }
    let r;
    try { r = await this.computerManager.listWindows(); } catch (e) { return { ok: false, error: e.message, window: null }; }
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'listWindows 失败', window: null };
    const { match, wantedTitle } = this._windowMatcher();
    const list = (r.windows || []).filter(w => {
      const t = `${w.title || ''} ${w.name || ''}`;
      if (wantedTitle) return t.includes(wantedTitle);
      return match.test(t);
    });
    if (!list.length) return { ok: false, error: '未找到目标桌面窗口', window: null };
    if (list.length !== 1) {
      return { ok: false, error: `AMBIGUOUS_EXTERNAL_AGENT_WINDOW: matched ${list.length} windows`, window: null, matches: list.length };
    }
    const window = list[0];
    if (window.hwnd == null || window.pid == null) {
      return { ok: false, error: 'External desktop window lacks stable HWND+PID identity', window: null };
    }
    return { ok: true, window };
  }

  /**
   * 探测目标窗口是否存在。
   * @returns {Promise<{ available: boolean, window: string|null, detail: string }>}
   */
  async detect() {
    const found = await this._findWindow();
    return {
      available: found.ok,
      window: found.window ? found.window.title : null,
      detail: found.ok ? 'window found' : found.error
    };
  }

  /**
   * 健康检查：
   *  - unavailable = 窗口不存在
   *  - degraded    = 窗口存在但 UIA 文本为空（需要 vision 降级）
   *  - healthy     = 窗口存在且 UIA 文本可读
   */
  async healthCheck() {
    const start = Date.now();
    const found = await this._findWindow();
    if (!found.ok) {
      return { status: HEALTH_STATE.UNAVAILABLE, version: null, latencyMs: Date.now() - start, detail: found.error };
    }
    const title = found.window.title;
    let text = null;
    if (this.computerManager && typeof this.computerManager.getWindowText === 'function') {
      try {
        const r = await this.computerManager.getWindowText(title);
        if (r && r.ok !== false && typeof r.text === 'string') text = r.text;
      } catch { /* treat as degraded */ }
    }
    const latencyMs = Date.now() - start;
    if (text && text.trim().length > 0) {
      return { status: HEALTH_STATE.HEALTHY, version: null, latencyMs, detail: `window "${title}" readable (${text.length} chars)` };
    }
    return { status: HEALTH_STATE.DEGRADED, version: null, latencyMs, detail: `window "${title}" exists but UIA text empty (vision fallback required)` };
  }

  /**
   * 启动一次桌面 Run：构造 DesktopAgentBridge 并调用 bridge.run(task.goal)。
   * @param {object} task    { goal, projectId, projectRoot, windowTitle, visionFallback, timeoutMs }
   * @param {object} context { signal, onState, onChunk, sleep, now, visionReader, projectRoot, projectId, conversationId, taskId }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!this.computerManager) throw new Error('DesktopAgentAdapter: computerManager 未注入');
    if (!task || !task.goal) throw new Error('DesktopAgentAdapter.startTask: task.goal 必填');

    const runId = context.runId || crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const cfg = {
      ...(this.manifest.config || {}),
      ...(this.config || {}),
      ...(task.config || {}),
      windowTitle: task.windowTitle || (this.config && this.config.windowTitle) || null,
      visionFallback: task.visionFallback != null ? task.visionFallback : (this.config && this.config.visionFallback),
      timeoutMs: task.timeoutMs || (this.config && this.config.timeoutMs) || DEFAULT_TIMEOUT_MS
    };
    // windowMatch 字符串 → RegExp
    if (typeof cfg.windowMatch === 'string') cfg.windowMatch = new RegExp(cfg.windowMatch, 'i');

    const bridge = new DesktopAgentBridge({
      computer: this.computerManager,
      config: cfg,
      signal: ac.signal,
      sleep: context && context.sleep,
      now: context && context.now,
      visionReader: (context && context.visionReader) || this.visionReader || null,
      requireExactWindow: context.productionHub === true,
      onState: (state, detail) => {
        if (context && context.onState) {
          try { context.onState(state, detail); } catch { /* listener must not break the run */ }
        }
      }
    });

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      bridge,
      startedAt: Date.now(),
      taskText: task.goal,
      cfg,
      context
    };
    this._runs.set(runId, runState);

    runState.executionPromise = this._executeDesktop(runId, task.goal).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      if (typeof context.finishRun === 'function') context.finishRun('failed', runState.result);
      return runState.result;
    });

    return { runId };
  }

  async _executeDesktop(runId, taskText) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.status = LIFECYCLE.RUNNING;
    const res = await runState.bridge.run(taskText);
    // DesktopAgentBridge.run 返回 { status, summary, errors, window, inputVia, readVia, ... }
    const status = res.status || 'failed';
    let lifecycle;
    switch (status) {
      case 'completed': lifecycle = LIFECYCLE.COMPLETED; break;
      case 'failed': lifecycle = LIFECYCLE.FAILED; break;
      case 'cancelled': lifecycle = LIFECYCLE.CANCELLED; break;
      case 'timeout': lifecycle = LIFECYCLE.TIMEOUT; break;
      default: lifecycle = LIFECYCLE.FAILED;
    }
    // signal 已 abort 但 bridge 仍返回其他状态时统一改写为 cancelled
    if (runState.ac.signal.aborted && lifecycle !== LIFECYCLE.CANCELLED) {
      lifecycle = LIFECYCLE.CANCELLED;
      if (!res.errors || !res.errors.length) res.errors = ['用户已停止'];
    }
    runState.status = lifecycle;
    runState.result = {
      ...buildExternalResult({
        agentId: this.id, runId, status,
        summary: res.summary || '', findings: res.findings,
        changedFiles: res.changedFiles, artifacts: res.artifacts,
        errors: res.errors, startedAt: runState.startedAt
      }),
      window: res.window || null,
      inputVia: res.inputVia || null,
      readVia: res.readVia || null,
      detection: res.detection || null,
      polls: res.polls || 0,
      elapsedMs: res.elapsedMs || 0,
      trace: stripSecrets(Array.isArray(res.trace) ? res.trace.slice(-100) : []),
      visionCalls: res.visionCalls || 0,
      visionModel: res.visionModel || null,
      confidence: res.confidence != null ? res.confidence : null
    };
    if (runState.context && typeof runState.context.finishRun === 'function') {
      try { runState.context.finishRun(lifecycle, runState.result); } catch { /* noop */ }
    }
    return runState.result;
  }

  /** sendMessage：桌面桥接一次性驱动，不支持运行中追加。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'desktop bridge does not support mid-run messages' };
  }

  /** 取消：abort signal，bridge 在每个 poll 循环都会检查。 */
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
    if (!run.executionPromise) return { quiesced: true, residual: 0, detail: 'Desktop run not active' };
    let timer;
    const settled = await Promise.race([
      run.executionPromise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
    return settled
      ? { quiesced: true, residual: 0, detail: 'Desktop automation stopped' }
      : { quiesced: false, residual: { runId }, detail: 'Desktop automation still active' };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
      bridgeState: run.bridge ? run.bridge.state : null,
      startedAt: run.startedAt
    };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：abort 所有在跑的桌面 Run。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try {
        if (run.status === LIFECYCLE.RUNNING || run.status === LIFECYCLE.STARTING) {
          run.ac.abort();
        }
      } catch { /* non-fatal */ }
    }
    this._runs.clear();
  }
}

module.exports = { DesktopAgentAdapter, DEFAULT_TIMEOUT_MS, DEFAULT_WINDOW_MATCH };
