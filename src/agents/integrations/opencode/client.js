'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenCode HTTP / SSE 客户端（spec §4.3）。
 *
 * 封装 OpenCode server 的 REST + SSE API：
 *   - 所有请求带 Basic Auth（`Authorization: Basic base64(opencode:password)`）
 *   - 所有请求带超时（默认 30s，可配置）+ 支持 AbortSignal
 *   - 复用 providers/http.js 的 linkSignals 合并 timeout + 外部 abort，确保
 *     Stop 按钮能真正切断 socket，而不是等下一个 SSE chunk
 *
 * API 端点（OpenCode serve）：
 *   GET  /global/health            → { healthy, version }
 *   POST /session                  → Session  (body: { parentID?, title? })
 *   POST /session/:id/prompt_async → 204      (body: { messageID?, model?, agent?, parts })
 *   POST /session/:id/message      → { info, parts }   (sync prompt)
 *   GET  /session/:id/message      → Message[]
 *   POST /session/:id/abort        → boolean
 *   GET  /session/:id/diff?messageID= → FileDiff[]
 *   DELETE /session/:id            → boolean
 *   GET  /event (SSE)              → 第一个事件 server.connected
 */

const { linkSignals, streamSSE, attachLink, releaseResponse } = require('../../../providers/http');
const { basicAuthHeader } = require('./serverManager');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 创建 OpenCode 客户端。
 * @param {object} opts
 * @param {string} opts.baseUrl  服务基地址（如 http://127.0.0.1:4096）
 * @param {string} [opts.password] Basic Auth 口令（不设则不带认证头）
 * @param {number} [opts.timeoutMs] 单次请求超时（默认 30s）
 * @returns {object} client 实例
 */
function createOpenCodeClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('createOpenCodeClient: opts.baseUrl 必填');
  const password = opts.password || '';
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  /** 构造请求头：Basic Auth + JSON。 */
  function headers(extra) {
    const h = { Accept: 'application/json' };
    if (password) h['Authorization'] = basicAuthHeader(password);
    return Object.assign(h, extra || {});
  }

  /**
   * 统一请求入口：合并 timeout + 外部 signal，返回 Response。
   * link 附着在 response 上，由 parseJson / releaseResponse 在读完 body 后释放，
   * 确保 body 读取期间超时 / abort 仍然生效。
   * @param {string} path
   * @param {object} init fetch init
   * @param {object} [callOpts] { timeoutMs, signal }
   */
  async function request(path, init, callOpts = {}) {
    const ms = Number(callOpts.timeoutMs) || timeoutMs;
    const link = linkSignals(ms, callOpts.signal || null);
    try {
      const resp = await fetch(baseUrl + path, {
        ...init,
        headers: headers(init.headers),
        signal: link.signal
      });
      return attachLink(resp, link);
    } catch (err) {
      link.dispose();
      if (link.timedOut) {
        const e = new Error(`opencode request timed out (${Math.round(ms / 1000)}s): ${path}`);
        e.timeout = true;
        throw e;
      }
      throw err;
    }
  }

  /** 解析 JSON 响应；非 JSON 时返回 { _text }。读完即释放 link。 */
  async function parseJson(resp) {
    try {
      const txt = await resp.text();
      if (!txt) return null;
      try { return JSON.parse(txt); } catch { return { _text: txt }; }
    } finally {
      releaseResponse(resp);
    }
  }

  /** 读取错误响应文本并释放 link（错误路径专用）。 */
  async function errorText(resp) {
    try {
      const t = await resp.text();
      return t || '';
    } catch {
      return '';
    } finally {
      releaseResponse(resp);
    }
  }

  /** 不需要 body 的早返回路径：释放 link。 */
  function discardBody(resp) {
    releaseResponse(resp);
  }

  /** GET /global/health → { healthy, version }。 */
  async function health(callOpts = {}) {
    const resp = await request('/global/health', { method: 'GET' }, callOpts);
    const body = await parseJson(resp);
    return {
      healthy: resp.ok && !!(body && body.healthy !== false),
      version: (body && body.version) || null,
      httpStatus: resp.status
    };
  }

  /** POST /session → Session。 */
  async function createSession({ title, parentID } = {}, callOpts = {}) {
    const body = {};
    if (title != null) body.title = title;
    if (parentID != null) body.parentID = parentID;
    const resp = await request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw new Error(`createSession failed: HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    return parseJson(resp);
  }

  /**
   * POST /session/:id/prompt_async → 204。
   * @param {string} sessionId
   * @param {object} payload { parts, model?, agent?, messageID? }
   */
  async function sendPromptAsync(sessionId, payload = {}, callOpts = {}) {
    const body = { parts: payload.parts || [] };
    if (payload.model != null) body.model = payload.model;
    if (payload.agent != null) body.agent = payload.agent;
    if (payload.messageID != null) body.messageID = payload.messageID;
    const resp = await request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw new Error(`sendPromptAsync failed: HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    // 204 无 body
    discardBody(resp);
    return { ok: true, httpStatus: resp.status };
  }

  /** POST /session/:id/message → { info, parts }（同步 prompt）。 */
  async function sendPromptSync(sessionId, payload = {}, callOpts = {}) {
    const body = { parts: payload.parts || [] };
    if (payload.model != null) body.model = payload.model;
    if (payload.agent != null) body.agent = payload.agent;
    if (payload.messageID != null) body.messageID = payload.messageID;
    const resp = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw new Error(`sendPromptSync failed: HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    return parseJson(resp);
  }

  /** GET /session/:id/message → Message[]。 */
  async function getMessages(sessionId, callOpts = {}) {
    const resp = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'GET'
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw new Error(`getMessages failed: HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    return parseJson(resp);
  }

  /** POST /session/:id/abort → boolean。 */
  async function abort(sessionId, callOpts = {}) {
    const resp = await request(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST'
    }, callOpts);
    if (!resp.ok) { discardBody(resp); return false; }
    const body = await parseJson(resp);
    return body !== false && body !== 0;
  }

  /** GET /session/:id/diff?messageID= → FileDiff[]。 */
  async function getDiff(sessionId, messageID, callOpts = {}) {
    let path = `/session/${encodeURIComponent(sessionId)}/diff`;
    if (messageID != null) path += `?messageID=${encodeURIComponent(messageID)}`;
    const resp = await request(path, { method: 'GET' }, callOpts);
    if (!resp.ok) { discardBody(resp); return []; }
    const body = await parseJson(resp);
    return Array.isArray(body) ? body : (body && body.diffs) || [];
  }

  /** DELETE /session/:id → boolean。 */
  async function deleteSession(sessionId, callOpts = {}) {
    const resp = await request(`/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    }, callOpts);
    const ok = resp.ok;
    discardBody(resp);
    return ok;
  }

  /**
   * GET /event (SSE) — 异步生成器，逐个 yield 解析后的事件对象。
   *
   * OpenCode 的 /event 是一个长期 SSE 连接，第一个事件是 server.connected。
   * 用 streamSSE 解析 data: 行为 JSON。
   *
   * @param {object} [callOpts] { signal, timeoutMs }
   * @returns {AsyncGenerator<object>}
   *
   * 注意：SSE 是长连接，timeoutMs 仅作为 idle 参考——这里不设硬超时
   * （传 null 表示无超时），由调用方通过 signal 控制生命周期。
   */
  async function* events(callOpts = {}) {
    const externalSignal = callOpts.signal || null;
    // SSE 长连接：不设硬超时，靠 signal 终止
    const link = linkSignals(null, externalSignal);
    let resp;
    try {
      resp = await fetch(baseUrl + '/event', {
        method: 'GET',
        headers: headers({ Accept: 'text/event-stream' }),
        signal: link.signal
      });
    } catch (err) {
      link.dispose();
      if (link.timedOut) {
        const e = new Error('opencode SSE connection timed out');
        e.timeout = true;
        throw e;
      }
      throw err;
    }
    if (!resp.ok) {
      releaseResponse(resp);
      link.dispose();
      throw new Error(`opencode SSE /event failed: HTTP ${resp.status}`);
    }
    // attachLink 后 streamSSE → streamLines 会用 linkOf(resp) 取到 link，
    // 在流结束 / abort 时自动 dispose；无需再手动 dispose。
    attachLink(resp, link);
    for await (const evt of streamSSE(resp)) {
      yield evt;
    }
  }

  return {
    health,
    createSession,
    sendPromptAsync,
    sendPromptSync,
    getMessages,
    abort,
    getDiff,
    deleteSession,
    events
  };
}

module.exports = { createOpenCodeClient, DEFAULT_TIMEOUT_MS };
