'use strict';
/**
 * v2.6.0 Agent Integration Hub — WorkBuddy 桌面桥接适配器（spec §4.3）。
 *
 * 包装已有的 WorkBuddy 桌面桥接（src/services/externalAgents.js runWorkBuddyBridge
 * → DesktopAgentBridge），把"驱动已登录的 WorkBuddy 桌面应用"接入统一 AgentAdapter。
 *
 * 设计要点：
 *  - 不重写桌面自动化逻辑（已有 DesktopAgentBridge 处理窗口发现 / 输入链 / 完成检测
 *    / 视觉降级），只做接口归一化。
 *  - detect 通过 computerManager.listWindows() 找标题匹配的 WorkBuddy 窗口；
 *    healthCheck 进一步读 UIA 文本判定 healthy / degraded / unavailable。
 *  - 单并发（maxConcurrency=1）：桌面只有一个前台窗口，并行 Run 会互相抢焦点。
 *  - 取消通过 AbortSignal：runWorkBuddyBridge 内部已把 signal 透传给 bridge，
 *    bridge 在每个 poll 循环都检查 aborted，abort 即停。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { WORKBUDDY } = require('../manifests/builtinAgents');
const { runWorkBuddyBridge, TERMINAL_STATES } = require('../../services/externalAgents');

const DEFAULT_WINDOW_MATCH = /workbuddy/i;

/** 把 runWorkBuddyBridge 返回的 JSON 字符串解析为统一结果对象。 */
function parseWorkBuddyResult(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const status = TERMINAL_STATES.includes(parsed.status) ? parsed.status : 'failed';
    return {
      status,
      summary: parsed.summary || '',
      findings: parsed.findings || [],
      changedFiles: parsed.changedFiles || [],
      artifacts: parsed.artifacts || [],
      errors: parsed.errors || [],
      window: parsed.window || null,
      inputVia: parsed.inputVia || null,
      readVia: parsed.readVia || null,
      detection: parsed.detection || null,
      polls: parsed.polls || 0,
      elapsedMs: parsed.elapsedMs || 0,
      screenshot: parsed.screenshot || null,
      trace: parsed.trace || [],
      visionCalls: parsed.visionCalls || 0,
      visionModel: parsed.visionModel || null,
      confidence: parsed.confidence != null ? parsed.confidence : null,
      raw: parsed
    };
  } catch {
    return {
      status: 'failed',
      summary: String(raw || '').slice(0, 4000),
      errors: ['无法解析 WorkBuddy 返回结果'],
      findings: [], changedFiles: [], artifacts: []
    };
  }
}

class WorkBuddyAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} [opts.manifest]        workbuddy manifest（缺省取内置 WORKBUDDY）
   * @param {object} [opts.computerManager] ComputerManager 实例（listWindows / focusWindow / getWindowText / setClipboard / pressKeys / typeText / screenshotWindow）
   */
  constructor({ manifest, computerManager } = {}) {
    super({ manifest: manifest || WORKBUDDY });
    this.computerManager = computerManager || null;
    // runId -> { ac, status, result, startedAt }
    this._runs = new Map();
    // detect 缓存（避免每次都列举窗口）
    this._windowCache = null;
    this._windowCacheAt = 0;
  }

  getManifest() {
    return { ...this.manifest, maxConcurrency: this.manifest.maxConcurrency || 1 };
  }

  /** 列举窗口，按 manifest.windowMatch / windowTitle 找 WorkBuddy 窗口。 */
  async _findWindow() {
    if (!this.computerManager || typeof this.computerManager.listWindows !== 'function') {
      return { ok: false, error: 'computerManager 不可用', window: null };
    }
    let r;
    try { r = await this.computerManager.listWindows(); } catch (e) { return { ok: false, error: e.message, window: null }; }
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'listWindows 失败', window: null };
    const cfg = this.manifest.config || this.config || {};
    const match = cfg.windowMatch || (this.manifest.windowMatch) || DEFAULT_WINDOW_MATCH;
    const re = typeof match === 'string' ? new RegExp(match, 'i') : match;
    const wantedTitle = cfg.windowTitle || null;
    const list = (r.windows || []).filter(w => {
      const t = `${w.title || ''} ${w.name || ''}`;
      if (wantedTitle) return t.includes(wantedTitle);
      return re.test(t);
    });
    if (!list.length) return { ok: false, error: '未找到 WorkBuddy 窗口', window: null };
    return { ok: true, window: list[0] };
  }

  /**
   * 探测 WorkBuddy 窗口是否存在。
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
   *  - degraded    = 窗口存在但 UIA 文本为空（Electron accessibility off / Skia canvas）
   *  - healthy     = 窗口存在且 UIA 文本可读
   */
  async healthCheck() {
    const start = Date.now();
    const found = await this._findWindow();
    if (!found.ok) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: found.error
      };
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
   * 启动一次 WorkBuddy Run。
   * 立即返回 runId；runWorkBuddyBridge 在后台驱动桌面，结果回写 runState。
   *
   * @param {object} task    { goal, projectId, projectRoot, windowTitle, visionFallback, timeoutMs }
   * @param {object} context { signal, onState, onChunk, sleep, now, visionReader, projectRoot, projectId, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!this.computerManager) throw new Error('WorkBuddyAgentAdapter: computerManager 未注入');
    if (!task || !task.goal) throw new Error('WorkBuddyAgentAdapter.startTask: task.goal 必填');

    const runId = crypto.randomUUID();
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
      timeoutMs: task.timeoutMs || (this.config && this.config.timeoutMs) || 180000
    };
    const legacyAdapter = {
      id: this.manifest.id,
      name: this.manifest.displayName,
      adapter_type: 'workbuddy',
      config: cfg,
      model: null
    };

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      startedAt: Date.now(),
      taskText: task.goal,
      cfg
    };
    this._runs.set(runId, runState);

    this._executeWorkBuddy(runId, legacyAdapter, task.goal, ac.signal, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
    });

    return { runId };
  }

  async _executeWorkBuddy(runId, legacyAdapter, taskText, signal, context) {
    const runState = this._runs.get(runId);
    if (!runState) return;
    runState.status = LIFECYCLE.RUNNING;
    const raw = await runWorkBuddyBridge(legacyAdapter, taskText, this.computerManager, {
      signal,
      onState: context && context.onState,
      onChunk: context && context.onChunk,
      sleep: context && context.sleep,
      now: context && context.now,
      visionReader: context && context.visionReader,
      projectId: context && context.projectId,
      projectRoot: context && context.projectRoot,
      conversationId: context && context.conversationId,
      taskId: context && context.taskId
    });
    const result = parseWorkBuddyResult(raw);
    if (signal.aborted && result.status !== 'cancelled') {
      result.status = 'cancelled';
      if (!result.errors || !result.errors.length) result.errors = ['用户已停止'];
    }
    runState.status = this._mapToLifecycle(result.status);
    runState.result = result;
  }

  _mapToLifecycle(status) {
    switch (status) {
      case 'completed': return LIFECYCLE.COMPLETED;
      case 'failed': return LIFECYCLE.FAILED;
      case 'cancelled': return LIFECYCLE.CANCELLED;
      case 'timeout': return LIFECYCLE.TIMEOUT;
      case 'running': return LIFECYCLE.RUNNING;
      default: return LIFECYCLE.FAILED;
    }
  }

  /** sendMessage：桌面桥接一次性驱动，不支持运行中追加。 */
  async sendMessage(runId, message) {
    return { ok: false, error: 'workbuddy bridge does not support mid-run messages' };
  }

  /** 取消：abort signal，runWorkBuddyBridge 内部已透传给 bridge，每个 poll 循环都会检查。 */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    try { run.ac.abort(); } catch { /* already aborted */ }
    if (run.status !== LIFECYCLE.COMPLETED && run.status !== LIFECYCLE.FAILED &&
        run.status !== LIFECYCLE.CANCELLED && run.status !== LIFECYCLE.TIMEOUT) {
      run.status = LIFECYCLE.CANCELLED;
    }
    return { ok: true };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return { status: run.status, startedAt: run.startedAt };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：取消所有在跑的桌面 Run。 */
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

module.exports = { WorkBuddyAgentAdapter, parseWorkBuddyResult };
