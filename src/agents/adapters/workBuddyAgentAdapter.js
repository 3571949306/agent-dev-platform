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
const { buildExternalResult, stripSecrets } = require('../runtime/resultSanitizer');

const DEFAULT_WINDOW_MATCH = /workbuddy/i;

/** 把 runWorkBuddyBridge 返回的 JSON 字符串解析为统一结果对象。 */
function parseWorkBuddyResult(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    const status = TERMINAL_STATES.includes(parsed.status) ? parsed.status : 'failed';
    return {
      ...buildExternalResult({
        agentId: 'workbuddy', status,
        summary: parsed.summary || '', findings: parsed.findings,
        changedFiles: parsed.changedFiles, artifacts: parsed.artifacts,
        errors: parsed.errors
      }),
      window: parsed.window || null,
      inputVia: parsed.inputVia || null,
      readVia: parsed.readVia || null,
      detection: parsed.detection || null,
      polls: parsed.polls || 0,
      elapsedMs: parsed.elapsedMs || 0,
      trace: stripSecrets(Array.isArray(parsed.trace) ? parsed.trace.slice(-100) : []),
      visionCalls: parsed.visionCalls || 0,
      visionModel: parsed.visionModel || null,
      confidence: parsed.confidence != null ? parsed.confidence : null
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
    if (list.length !== 1) {
      return { ok: false, error: `AMBIGUOUS_EXTERNAL_AGENT_WINDOW: matched ${list.length} WorkBuddy windows`, code: 'AMBIGUOUS_EXTERNAL_AGENT_WINDOW', window: null, matches: list.length };
    }
    const window = list[0];
    if (!window.hwnd || !window.pid) {
      return { ok: false, error: 'WorkBuddy window lacks stable HWND+PID identity', code: 'TARGET_IDENTITY_REQUIRED', window: null };
    }
    return { ok: true, window };
  }

  /**
   * 探测 WorkBuddy 窗口是否存在。
   * @returns {Promise<{ available: boolean, window: string|null, detail: string }>}
   */
  async detect() {
    const found = await this._findWindow();
    return {
      available: found.ok,
      installed: found.ok,
      configured: found.ok,
      window: found.window ? found.window.title : null,
      windowIdentity: found.window ? { hwnd: found.window.hwnd, pid: found.window.pid } : null,
      ambiguous: found.code === 'AMBIGUOUS_EXTERNAL_AGENT_WINDOW',
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
      timeoutMs: task.timeoutMs || (this.config && this.config.timeoutMs) || 180000
    };
    const found = await this._findWindow();
    if (!found.ok) throw Object.assign(new Error(found.error), { code: found.code || 'AGENT_UNAVAILABLE' });

    if (context.productionHub) {
      if (typeof context.requestPermission !== 'function') {
        throw Object.assign(new Error('WorkBuddy desktop mutation requires the platform permission channel'), { code: 'AGENT_PERMISSION_DENIED' });
      }
      const decision = await context.requestPermission({
        scope: 'computer', tool: 'workbuddy.desktop',
        args: { hwnd: Number(found.window.hwnd), pid: Number(found.window.pid) },
        agent: this.manifest.displayName || this.id, runId,
        conversationId: context.conversationId || null,
        risk: 'External desktop Agent will type into the selected WorkBuddy window'
      });
      if (!decision || !['allow', 'approved', 'accept'].includes(String(decision.decision || decision).toLowerCase())) {
        throw Object.assign(new Error('WorkBuddy desktop permission denied'), { code: 'AGENT_PERMISSION_DENIED' });
      }
    }

    let computerSession = null;
    if (this.computerManager.sessions) {
      const created = this.computerManager.sessions.create({
        runId,
        ownerAgentId: this.id,
        conversationId: context.conversationId || null,
        allowedTargets: [found.window]
      });
      if (!created.ok) throw Object.assign(new Error(created.error), { code: created.code });
      computerSession = created.session;
      if (computerSession.status === 'CREATED') this.computerManager.sessions.setStatus(computerSession.sessionId, 'ACTIVE');
      this.computerManager.sessions.bindTarget(computerSession.sessionId, found.window);
    } else if (context.productionHub) {
      throw Object.assign(new Error('WorkBuddy production run requires a P3 ComputerSession registry'), { code: 'WORKBUDDY_UNOWNED_COMPUTER_EXEC' });
    }
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
      cfg,
      context,
      windowRef: found.window,
      computerSessionId: computerSession && computerSession.sessionId || null,
      inputAfterCancel: 0
    };
    this._runs.set(runId, runState);

    runState.executionPromise = this._executeWorkBuddy(runId, legacyAdapter, task.goal, ac.signal, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      return runState.result;
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
      computerSessionId: runState.computerSessionId,
      windowRef: runState.windowRef,
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
    let cleanup = { ok: true, quiesced: true, residual: 0 };
    if (runState.computerSessionId) {
      cleanup = result.status === 'completed'
        ? await this.computerManager.completeSession(runState.computerSessionId, { reason: 'WorkBuddy run completed' })
        : await this.computerManager.cancelSession(runState.computerSessionId, { reason: `WorkBuddy run ${result.status}` });
    }
    runState.quiescence = {
      quiesced: cleanup.quiesced !== false && Number(cleanup.residual || 0) === 0,
      residual: cleanup.residual || 0
    };
    if (runState.context && typeof runState.context.finishRun === 'function') {
      try { runState.context.finishRun(runState.status, result); } catch { /* noop */ }
    }
    return result;
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
    let sessionCleanup = { ok: true, quiesced: true, residual: 0 };
    if (run.computerSessionId && typeof this.computerManager.cancelSession === 'function') {
      sessionCleanup = await this.computerManager.cancelSession(run.computerSessionId, { reason: 'WorkBuddy user cancel' });
    }
    const q = await this.awaitQuiescence(runId, 10000);
    const quiesced = q.quiesced && sessionCleanup.quiesced !== false && Number(sessionCleanup.residual || 0) === 0;
    return { ok: quiesced, status: quiesced ? 'cancelled' : 'cancelling', quiesced, residual: quiesced ? 0 : (q.residual || sessionCleanup.residual), detail: quiesced ? 'WorkBuddy ComputerSession and bridge quiesced' : 'WorkBuddy cleanup incomplete' };
  }

  async awaitQuiescence(runId, timeoutMs = 10000) {
    const run = this._runs.get(runId);
    if (!run) return { quiesced: false, residual: 'unknown runId', detail: 'unknown runId' };
    if (run.executionPromise) {
      let timer;
      const settled = await Promise.race([
        run.executionPromise.then(() => true, () => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) return { quiesced: false, residual: { runId, computerSessionId: run.computerSessionId }, detail: 'WorkBuddy bridge still active' };
    }
    if (run.computerSessionId && this.computerManager.sessions) {
      const session = this.computerManager.sessions.get(run.computerSessionId);
      if (session && !['CANCELLED', 'COMPLETED', 'FAILED'].includes(session.status)) {
        return { quiesced: false, residual: { computerSessionId: run.computerSessionId }, detail: 'WorkBuddy ComputerSession still active' };
      }
    }
    const q = run.quiescence || { quiesced: true, residual: 0 };
    return { quiesced: q.quiesced !== false, residual: q.residual || 0, detail: q.quiesced === false ? 'WorkBuddy residue remains' : 'WorkBuddy quiesced' };
  }

  async safeVerify() {
    const startedAt = Date.now();
    const found = await this._findWindow();
    return {
      agentId: this.id,
      paidCalls: 0,
      protocolAttempted: true,
      // Detecting a unique window is not a P3 ownership/bind probe. Safe Test
      // must not upgrade this to REAL_PROTOCOL without a real owned session.
      protocolVerified: false,
      runtime: 'p3-computer-session',
      version: null,
      reason: found.ok ? 'P3_SESSION_BIND_NOT_ATTEMPTED' : (found.error || 'WINDOW_NOT_FOUND'),
      detection: { available: found.ok, windowIdentity: found.window ? { hwnd: found.window.hwnd, pid: found.window.pid } : null, detail: found.error || 'unique window detected' },
      health: found.ok ? HEALTH_STATE.HEALTHY : HEALTH_STATE.UNAVAILABLE,
      auth: { state: 'UNKNOWN', detail: 'WorkBuddy login state is not inspected' },
      durationMs: Date.now() - startedAt
    };
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
