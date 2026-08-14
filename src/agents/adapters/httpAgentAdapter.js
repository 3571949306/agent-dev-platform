'use strict';
/**
 * v2.6.0 Agent Integration Hub — 通用 HTTP 适配器（spec §4.3）。
 *
 * 为未来的 OpenCode / OpenHands / 自建 HTTP Agent 提供统一接入。
 * 复用 providers/http.js 的 linkSignals 模式管理超时 + abort，确保 Stop 按钮
 * 真的能切断 socket（fetch + AbortController），而不是等下一个 SSE chunk。
 *
 * 设计要点：
 *  - config 注入：{ baseUrl, healthPath, startTaskPath, pollPath, cancelPath, resultPath, timeoutMs, headers }
 *  - 三种响应模式：
 *      A. text/event-stream → 边读边累积，结束即 completed
 *      B. JSON { taskId }   → 轮询 pollPath 直到终态，再取 resultPath
 *      C. JSON / 文本       → 直接当结果
 *  - cancel：有 remoteTaskId 时 POST cancelPath；同时 abort fetch 连接。
 *  - detect / healthCheck 都用 linkSignals 限时 5s。
 */

const crypto = require('crypto');
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { HEALTH_STATE, LIFECYCLE } = require('../hub/types');
const { linkSignals, streamSSE } = require('../../providers/http');

const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 2000;

/** 路径模板替换：{id} → remoteTaskId。 */
function resolvePath(template, remoteTaskId) {
  if (!template) return null;
  if (!remoteTaskId) return template;
  return String(template).replace(/\{id\}|:id|\{taskId\}/g, encodeURIComponent(remoteTaskId));
}

class HttpAgentAdapter extends BaseAgentAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.manifest
   * @param {object} opts.config
   * @param {string} opts.config.baseUrl       服务基地址（尾部斜杠会被去掉）
   * @param {string} [opts.config.healthPath]  健康检查路径（默认 /health）
   * @param {string} [opts.config.startTaskPath] 启动任务路径（默认 /task）
   * @param {string} [opts.config.pollPath]    轮询路径模板（默认 /task/{id}）
   * @param {string} [opts.config.cancelPath]  取消路径模板（默认 /task/{id}/cancel）
   * @param {string} [opts.config.resultPath]  取结果路径模板（默认 /task/{id}/result）
   * @param {number} [opts.config.timeoutMs]   单次 Run 超时（默认 120s）
   * @param {object} [opts.config.headers]     附加请求头（如 Authorization）
   */
  constructor({ manifest, config } = {}) {
    super({ manifest, config });
    if (!config || !config.baseUrl) {
      throw new Error('HttpAgentAdapter: config.baseUrl 必填');
    }
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    this.healthPath = config.healthPath || '/health';
    this.startTaskPath = config.startTaskPath || '/task';
    this.pollPath = config.pollPath || '/task/{id}';
    this.cancelPath = config.cancelPath || '/task/{id}/cancel';
    this.resultPath = config.resultPath || '/task/{id}/result';
    this.timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.headers = config.headers || {};
    // runId -> { ac, status, result, remoteTaskId, startedAt, link }
    this._runs = new Map();
  }

  getManifest() { return { ...this.manifest }; }

  /** 探测服务是否可达（HEAD/GET healthPath，5s 超时）。 */
  async detect() {
    const link = linkSignals(HEALTH_TIMEOUT_MS, null);
    try {
      const resp = await fetch(this.baseUrl + this.healthPath, {
        method: 'GET',
        headers: this.headers,
        signal: link.signal
      });
      return { available: resp.ok, httpStatus: resp.status, baseUrl: this.baseUrl };
    } catch (e) {
      return { available: false, error: e.message, baseUrl: this.baseUrl };
    } finally { link.dispose(); }
  }

  /** 健康检查：GET healthPath，返回 status / latencyMs。 */
  async healthCheck() {
    const start = Date.now();
    const link = linkSignals(HEALTH_TIMEOUT_MS, null);
    try {
      const resp = await fetch(this.baseUrl + this.healthPath, {
        method: 'GET',
        headers: this.headers,
        signal: link.signal
      });
      const latencyMs = Date.now() - start;
      if (resp.ok) {
        let version = null;
        try {
          const body = await resp.json();
          version = body.version || body.v || null;
        } catch { /* non-JSON health body is fine */ }
        return { status: HEALTH_STATE.HEALTHY, version, latencyMs, detail: 'health check ok' };
      }
      return { status: HEALTH_STATE.UNAVAILABLE, version: null, latencyMs, detail: `HTTP ${resp.status}` };
    } catch (e) {
      return {
        status: HEALTH_STATE.UNAVAILABLE,
        version: null,
        latencyMs: Date.now() - start,
        detail: link.timedOut ? 'health check timed out' : e.message
      };
    } finally { link.dispose(); }
  }

  /**
   * 启动一次 HTTP Run。
   * @param {object} task    { goal, payload, projectId, projectRoot }
   * @param {object} context { signal, onChunk, onState, projectId, projectRoot, ... }
   * @returns {Promise<{ runId: string }>}
   */
  async startTask(task, context = {}) {
    if (!task || (!task.goal && typeof task !== 'string')) {
      throw new Error('HttpAgentAdapter.startTask: task.goal 必填');
    }
    const taskText = typeof task === 'string' ? task : task.goal;

    const runId = context.runId || crypto.randomUUID();
    const ac = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) ac.abort();
      else {
        try { context.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch { /* noop */ }
      }
    }

    const body = {
      task: taskText,
      goal: taskText,
      projectId: task.projectId || (context && context.projectId) || null,
      projectRoot: task.projectRoot || (context && context.projectRoot) || null,
      ...(task.payload || {})
    };

    const runState = {
      runId,
      ac,
      status: LIFECYCLE.STARTING,
      result: null,
      remoteTaskId: null,
      startedAt: Date.now(),
      taskText
    };
    this._runs.set(runId, runState);

    runState.context = context;
    runState.executionPromise = this._executeHttp(runId, body, context).catch(err => {
      runState.status = LIFECYCLE.FAILED;
      runState.result = {
        status: 'failed',
        summary: '',
        errors: [err && err.message ? err.message : String(err)],
        findings: [], changedFiles: [], artifacts: []
      };
      return runState.result;
    }).finally(() => {
      if (typeof context.finishRun === 'function' && runState.result) {
        try { context.finishRun(runState.status, runState.result); } catch { /* noop */ }
      }
    });

    return { runId };
  }

  async _executeHttp(runId, body, context) {
    const run = this._runs.get(runId);
    if (!run) return;
    run.status = LIFECYCLE.RUNNING;

    // linkSignals 同时合并 timeout + 外部 abort，交给 fetch 的 signal
    const link = linkSignals(this.timeoutMs, run.ac.signal);
    run.link = link;
    try {
      const resp = await fetch(this.baseUrl + this.startTaskPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
        signal: link.signal
      });

      const ct = resp.headers.get('content-type') || '';

      // A. SSE 流式响应
      if (ct.includes('text/event-stream')) {
        await this._streamResponse(run, resp, context);
        return;
      }

      const txt = await resp.text();
      if (!resp.ok) {
        run.status = LIFECYCLE.FAILED;
        run.result = {
          status: 'failed',
          summary: txt.slice(0, 4000),
          errors: [`HTTP ${resp.status}`],
          httpStatus: resp.status,
          findings: [], changedFiles: [], artifacts: []
        };
        return;
      }

      // B. JSON 返回 taskId → 轮询
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { /* not JSON */ }
      const remoteId = parsed && (parsed.taskId || parsed.task_id || parsed.id || parsed.runId);
      if (parsed && remoteId) {
        run.remoteTaskId = remoteId;
        await this._pollUntilDone(run, context);
        return;
      }

      // C. 直接返回结果
      run.status = LIFECYCLE.COMPLETED;
      run.result = {
        status: 'completed',
        summary: txt.slice(0, 4000),
        errors: [],
        httpStatus: resp.status,
        parsed,
        findings: [], changedFiles: [], artifacts: []
      };
    } catch (e) {
      if (link.timedOut) {
        run.status = LIFECYCLE.TIMEOUT;
        run.result = {
          status: 'timeout',
          summary: '',
          errors: [`HTTP 智能体超过 ${Math.round(this.timeoutMs / 1000)}s 未响应`],
          findings: [], changedFiles: [], artifacts: []
        };
      } else if (run.ac.signal.aborted) {
        run.status = LIFECYCLE.CANCELLED;
        run.result = {
          status: 'cancelled',
          summary: '',
          errors: ['用户已停止'],
          findings: [], changedFiles: [], artifacts: []
        };
      } else {
        run.status = LIFECYCLE.FAILED;
        run.result = {
          status: 'failed',
          summary: '',
          errors: [e.message],
          findings: [], changedFiles: [], artifacts: []
        };
      }
    } finally {
      link.dispose();
      run.link = null;
    }
  }

  /** SSE 流式：边读边累积，onChunk 转发，结束即 completed。 */
  async _streamResponse(run, resp, context) {
    let buf = '';
    try {
      for await (const evt of streamSSE(resp, { signal: run.ac.signal })) {
        // 兼容两种字段：{ content } / { chunk } / { delta }
        const piece = evt.content || evt.chunk || evt.delta || evt.text || (typeof evt === 'string' ? evt : '');
        if (piece) {
          buf += String(piece);
          if (context && context.onChunk) {
            try { context.onChunk(String(piece)); } catch { /* listener must not break */ }
          }
        }
        // 透传状态事件
        if (context && context.onState && evt.status) {
          try { context.onState(evt.status, evt); } catch { /* noop */ }
        }
        if (evt.done === true || evt.status === 'completed') break;
      }
      run.status = LIFECYCLE.COMPLETED;
      run.result = {
        status: 'completed',
        summary: buf.slice(0, 4000),
        errors: [],
        findings: [], changedFiles: [], artifacts: []
      };
    } catch (e) {
      if (run.ac.signal.aborted) {
        run.status = LIFECYCLE.CANCELLED;
        run.result = { status: 'cancelled', summary: buf.slice(0, 4000), errors: ['用户已停止'], findings: [], changedFiles: [], artifacts: [] };
      } else {
        run.status = LIFECYCLE.FAILED;
        run.result = { status: 'failed', summary: buf.slice(0, 4000), errors: [e.message], findings: [], changedFiles: [], artifacts: [] };
      }
    }
  }

  /** 轮询 pollPath 直到终态，再取 resultPath。 */
  async _pollUntilDone(run, context) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (run.ac.signal.aborted) {
        run.status = LIFECYCLE.CANCELLED;
        run.result = { status: 'cancelled', summary: '', errors: ['用户已停止'], findings: [], changedFiles: [], artifacts: [] };
        return;
      }
      const link = linkSignals(HEALTH_TIMEOUT_MS, run.ac.signal);
      let pollResp;
      try {
        pollResp = await fetch(resolvePath(this.baseUrl + this.pollPath, run.remoteTaskId), {
          method: 'GET',
          headers: this.headers,
          signal: link.signal
        });
      } catch (e) {
        link.dispose();
        if (run.ac.signal.aborted) {
          run.status = LIFECYCLE.CANCELLED;
          run.result = { status: 'cancelled', summary: '', errors: ['用户已停止'], findings: [], changedFiles: [], artifacts: [] };
          return;
        }
        // 网络瞬断：退避后重试
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      let body = null;
      try { body = await pollResp.json(); } catch { /* ignore */ }
      link.dispose();

      if (pollResp.ok && body) {
        const status = String(body.status || body.state || '').toLowerCase();
        if (context && context.onState) {
          try { context.onState(status, body); } catch { /* noop */ }
        }
        if (['completed', 'succeeded', 'done', 'success'].includes(status)) {
          // 取最终结果
          const finalResult = await this._fetchResult(run);
          run.status = LIFECYCLE.COMPLETED;
          run.result = finalResult || {
            status: 'completed',
            summary: String(body.summary || body.output || '').slice(0, 4000),
            errors: [],
            parsed: body,
            findings: [], changedFiles: [], artifacts: []
          };
          return;
        }
        if (['failed', 'error'].includes(status)) {
          run.status = LIFECYCLE.FAILED;
          run.result = {
            status: 'failed',
            summary: String(body.summary || body.error || '').slice(0, 4000),
            errors: [String(body.error || `remote task ${run.remoteTaskId} failed`)],
            parsed: body,
            findings: [], changedFiles: [], artifacts: []
          };
          return;
        }
        if (['cancelled', 'canceled', 'aborted'].includes(status)) {
          run.status = LIFECYCLE.CANCELLED;
          run.result = {
            status: 'cancelled',
            summary: '',
            errors: ['远端任务已取消'],
            parsed: body,
            findings: [], changedFiles: [], artifacts: []
          };
          return;
        }
        if (['timeout', 'timed_out'].includes(status)) {
          run.status = LIFECYCLE.TIMEOUT;
          run.result = {
            status: 'timeout',
            summary: '',
            errors: ['远端任务超时'],
            parsed: body,
            findings: [], changedFiles: [], artifacts: []
          };
          return;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    // 轮询用尽 timeoutMs
    run.status = LIFECYCLE.TIMEOUT;
    run.result = {
      status: 'timeout',
      summary: '',
      errors: [`轮询超过 ${Math.round(this.timeoutMs / 1000)}s 未结束`],
      findings: [], changedFiles: [], artifacts: []
    };
  }

  async _fetchResult(run) {
    if (!this.resultPath) return null;
    const link = linkSignals(HEALTH_TIMEOUT_MS, run.ac.signal);
    try {
      const resp = await fetch(resolvePath(this.baseUrl + this.resultPath, run.remoteTaskId), {
        method: 'GET',
        headers: this.headers,
        signal: link.signal
      });
      if (!resp.ok) return null;
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { /* not JSON */ }
      return {
        status: 'completed',
        summary: (parsed && (parsed.summary || parsed.output || parsed.result)) || txt.slice(0, 4000),
        errors: [],
        parsed,
        findings: (parsed && parsed.findings) || [],
        changedFiles: (parsed && parsed.changedFiles) || [],
        artifacts: (parsed && parsed.artifacts) || []
      };
    } catch { return null; }
    finally { link.dispose(); }
  }

  /** sendMessage：可通过 POST startTaskPath/{id}/message 转发（如果配置支持）。 */
  async sendMessage(runId, message) {
    const run = this._runs.get(runId);
    if (!run || !run.remoteTaskId) return { ok: false, error: 'no remote task to message' };
    // 默认不实现具体路径，子类可覆盖。这里只透传 abort 检查。
    if (run.ac.signal.aborted) return { ok: false, error: 'run aborted' };
    return { ok: false, error: 'sendMessage not configured for this HTTP agent' };
  }

  /**
   * 取消：有 remoteTaskId 时 POST cancelPath；同时 abort fetch 连接。
   */
  async cancel(runId) {
    const run = this._runs.get(runId);
    if (!run) return { ok: false, error: 'unknown runId' };
    let cancelled = false;
    if (run.remoteTaskId && this.cancelPath) {
      const link = linkSignals(HEALTH_TIMEOUT_MS, null);
      try {
        const resp = await fetch(resolvePath(this.baseUrl + this.cancelPath, run.remoteTaskId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.headers },
          body: JSON.stringify({ reason: 'user_cancelled' }),
          signal: link.signal
        });
        cancelled = resp.ok;
      } catch { /* fall through to abort */ }
      finally { link.dispose(); }
    }
    // 无论如何都 abort 本地 fetch 连接
    try { run.ac.abort(); } catch { /* already aborted */ }
    const q = await this.awaitQuiescence(runId, 5000);
    return { ok: q.quiesced, cancelled, status: q.quiesced ? 'cancelled' : 'cancelling', quiesced: q.quiesced, residual: q.residual, detail: q.detail };
  }

  async awaitQuiescence(runId, timeoutMs = 5000) {
    const run = this._runs.get(runId);
    if (!run) return { quiesced: false, residual: 'unknown runId', detail: 'unknown runId' };
    if (!run.executionPromise) return { quiesced: true, residual: 0, detail: 'HTTP run not active' };
    let timer;
    const settled = await Promise.race([
      run.executionPromise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
    return settled
      ? { quiesced: true, residual: 0, detail: 'HTTP stream/poll stopped' }
      : { quiesced: false, residual: { runId, remoteTaskId: run.remoteTaskId }, detail: 'HTTP stream/poll still active' };
  }

  async getStatus(runId) {
    const run = this._runs.get(runId);
    if (!run) return { status: LIFECYCLE.IDLE, detail: 'unknown runId' };
    return {
      status: run.status,
      remoteTaskId: run.remoteTaskId,
      startedAt: run.startedAt
    };
  }

  async getResult(runId) {
    const run = this._runs.get(runId);
    if (!run) return null;
    return run.result;
  }

  /** 释放：abort 所有在飞的 HTTP 请求。 */
  async dispose() {
    for (const [, run] of this._runs) {
      try { run.ac.abort(); } catch { /* noop */ }
      if (run.link) { try { run.link.dispose(); } catch { /* noop */ } }
    }
    this._runs.clear();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { HttpAgentAdapter, resolvePath };
