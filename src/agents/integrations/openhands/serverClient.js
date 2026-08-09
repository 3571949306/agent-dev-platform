'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenHands Agent Server 客户端（spec §4.3）。
 *
 * OpenHands Agent Server（FastAPI + uvicorn）提供 HTTP + WebSocket 两套接口。
 * 本客户端封装：
 *
 * HTTP:
 *   GET    /health
 *   POST   /conversations                 → { conversation_id, ... }
 *   GET    /conversations/:id/events      → Event[]
 *   POST   /conversations/:id/events      (body: {"type":"message","content":...})
 *   DELETE /conversations/:id
 *   GET    /conversations/search
 *
 * WebSocket:
 *   ws://<host>:<port>/conversations/:id/events/socket
 *   客户端发 {"type":"message","content":"..."}，服务端推送 Action/Observation 事件
 *
 * 鉴权：OH_SESSION_API_KEY 环境变量，通过 X-Session-API-Key 头或
 *       Authorization: Bearer 发送。本客户端用 X-Session-API-Key。
 *
 * WebSocket 实现策略：
 *   - 优先用全局 WebSocket（Node 22+ / Electron renderer 内置）
 *   - 不可用时降级为 HTTP 轮询（getEvents 循环），保证功能可用、无外部依赖
 *
 * 复用 providers/http.js 的 linkSignals 合并 timeout + abort。
 */

const { linkSignals, attachLink, releaseResponse } = require('../../../providers/http');

const DEFAULT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
// v2.7.2 §13/§28：轮询连续失败上限。超过后抛错，绝不无限空转伪装「还在跑」。
const MAX_POLL_FAILURES = 5;

/** 探测全局 WebSocket 是否可用（Node 22+ / Electron）。 */
function getWebSocketImpl() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  return null;
}

/**
 * 创建 OpenHands 客户端。
 * @param {object} opts
 * @param {string} opts.baseUrl   HTTP 基地址（如 http://127.0.0.1:8000）
 * @param {string} [opts.apiKey]  OH_SESSION_API_KEY（不设则不带鉴权头）
 * @param {number} [opts.timeoutMs] 单次请求超时（默认 30s）
 * @returns {object} client 实例
 */
function createOpenHandsClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('createOpenHandsClient: opts.baseUrl 必填');
  const apiKey = opts.apiKey || '';
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  /** 构造鉴权头。 */
  function authHeaders(extra) {
    const h = { Accept: 'application/json' };
    if (apiKey) h['X-Session-API-Key'] = apiKey;
    return Object.assign(h, extra || {});
  }

  /** 把 http(s):// baseUrl 转成 ws(s)://。 */
  function toWsUrl(path) {
    return baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + path;
  }

  /**
   * 统一请求入口：合并 timeout + 外部 signal。
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
        headers: authHeaders(init.headers),
        signal: link.signal
      });
      return attachLink(resp, link);
    } catch (err) {
      link.dispose();
      if (link.timedOut) {
        const e = new Error(`openhands request timed out (${Math.round(ms / 1000)}s): ${path}`);
        e.timeout = true;
        throw e;
      }
      throw err;
    }
  }

  async function parseJson(resp) {
    try {
      const txt = await resp.text();
      if (!txt) return null;
      try { return JSON.parse(txt); } catch { return { _text: txt }; }
    } finally {
      releaseResponse(resp);
    }
  }

  /** 读取错误响应文本并释放 link。 */
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

  /** v2.7.2 §27/§36：带 httpStatus 的错误，供适配器分类（401/403/404/5xx）。 */
  function httpError(message, status) {
    const e = new Error(message);
    e.httpStatus = status;
    return e;
  }

  /** GET /health → { healthy, ... }。 */
  async function health(callOpts = {}) {
    const resp = await request('/health', { method: 'GET' }, callOpts);
    const body = await parseJson(resp);
    return {
      healthy: resp.ok,
      version: (body && (body.version || body.v)) || null,
      httpStatus: resp.status,
      detail: body
    };
  }

  /** POST /conversations → { conversation_id, ... }。 */
  async function createConversation({ working_dir } = {}, callOpts = {}) {
    const body = {};
    if (working_dir != null) body.working_dir = working_dir;
    const resp = await request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw httpError(`createConversation failed: HTTP ${resp.status} ${t.slice(0, 200)}`, resp.status);
    }
    return parseJson(resp);
  }

  /** POST /conversations/:id/events（发消息）。 */
  async function sendMessage(conversationId, content, callOpts = {}) {
    const body = { type: 'message', content: String(content) };
    const resp = await request(`/conversations/${encodeURIComponent(conversationId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw httpError(`sendMessage failed: HTTP ${resp.status} ${t.slice(0, 200)}`, resp.status);
    }
    return parseJson(resp);
  }

  /** GET /conversations/:id/events → Event[]。 */
  async function getEvents(conversationId, callOpts = {}) {
    const resp = await request(`/conversations/${encodeURIComponent(conversationId)}/events`, {
      method: 'GET'
    }, callOpts);
    if (!resp.ok) {
      const t = await errorText(resp);
      throw httpError(`getEvents failed: HTTP ${resp.status} ${t.slice(0, 200)}`, resp.status);
    }
    const body = await parseJson(resp);
    return Array.isArray(body) ? body : (body && body.events) || [];
  }

  /** DELETE /conversations/:id → boolean。 */
  async function deleteConversation(conversationId, callOpts = {}) {
    const resp = await request(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE'
    }, callOpts);
    const ok = resp.ok;
    discardBody(resp);
    return ok;
  }

  /** GET /conversations/search。 */
  async function search(query, callOpts = {}) {
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    const resp = await request(`/conversations/search${qs}`, { method: 'GET' }, callOpts);
    if (!resp.ok) { discardBody(resp); return []; }
    const body = await parseJson(resp);
    return Array.isArray(body) ? body : (body && body.results) || [];
  }

  /**
   * WebSocket 事件流（异步生成器）。
   *
   * 连接 ws://<host>:<port>/conversations/:id/events/socket，发送初始消息，
   * 逐个 yield 服务端推送的事件。支持 signal 取消（close socket）。
   *
   * 若全局 WebSocket 不可用，降级为 HTTP 轮询 getEvents()：先 sendMessage，
   * 再周期性拉取新事件。
   *
   * @param {string} conversationId
   * @param {object} [opts2] { content, signal, timeoutMs }
   * @returns {AsyncGenerator<object>}
   */
  async function* websocketEvents(conversationId, opts2 = {}) {
    const content = opts2.content != null ? opts2.content : null;
    const signal = opts2.signal || null;
    const WsImpl = getWebSocketImpl();

    if (WsImpl) {
      try {
        yield* websocketStream(WsImpl, conversationId, { content, signal });
        return;
      } catch (e) {
        // WebSocket 连接失败（如服务端未启用 WS）→ 降级 HTTP 轮询。
        // 若已被取消则不再降级，直接抛出。
        if (signal && signal.aborted) throw e;
      }
    }
    // 降级：HTTP 轮询
    yield* pollingStream(conversationId, { content, signal });
  }

  /** WebSocket 实现：连接 → 发消息 → yield 事件 → close。 */
  async function* websocketStream(WsImpl, conversationId, { content, signal }) {
    const url = toWsUrl(`/conversations/${encodeURIComponent(conversationId)}/events/socket`);
    // 协议头带 api key（如果 WebSocket 实现支持子协议则用，否则靠 URL 查询参数兜底）
    const wsUrl = apiKey ? `${url}?api_key=${encodeURIComponent(apiKey)}` : url;

    const queue = [];
    let done = false;
    let waiters = [];
    let closeError = null;

    let ws;
    try {
      ws = new WsImpl(wsUrl);
    } catch (e) {
      throw new Error(`openhands WebSocket connect failed: ${e.message}`);
    }

    const onMessage = (ev) => {
      let parsed;
      try {
        const data = typeof ev === 'string' ? ev : (ev && ev.data);
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
      } catch {
        parsed = { _raw: ev && ev.data };
      }
      queue.push(parsed);
      const w = waiters.shift();
      if (w) w();
    };
    const onClose = (ev) => {
      done = true;
      if (ev && ev.code && ev.code !== 1000 && ev.code !== 1001) {
        closeError = new Error(`openhands WebSocket closed: code ${ev.code}`);
      }
      // 唤醒所有等待者
      while (waiters.length) waiters.shift()();
    };
    const onError = () => {
      done = true;
      closeError = closeError || new Error('openhands WebSocket error');
      while (waiters.length) waiters.shift()();
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);

    // 等待 open
    await new Promise((resolve, reject) => {
      if (ws.readyState === 1 /* OPEN */) return resolve();
      const onOpen = () => { cleanup(); resolve(); };
      const onOpenErr = (e) => { cleanup(); reject(new Error(`openhands WebSocket open failed: ${e.message || 'error'}`)); };
      const onOpenClose = (e) => { cleanup(); reject(new Error(`openhands WebSocket closed before open: code ${e.code}`)); };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onOpenErr);
        ws.removeEventListener('close', onOpenClose);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onOpenErr);
      ws.addEventListener('close', onOpenClose);
    });

    // 发送初始消息
    if (content != null && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'message', content: String(content) }));
      } catch { /* ignore send error */ }
    }

    // signal 取消 → close
    const onAbort = () => {
      done = true;
      try { ws.close(); } catch { /* noop */ }
      while (waiters.length) waiters.shift()();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else { try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ } }
    }

    try {
      while (!done) {
        if (signal && signal.aborted) break;
        if (queue.length) {
          yield queue.shift();
        } else {
          // 等下一个事件
          await new Promise((resolve) => {
            waiters.push(resolve);
            // 兜底超时，避免永久挂起（每 15s 醒来检查 signal）
            const t = setTimeout(() => {
              const idx = waiters.indexOf(resolve);
              if (idx >= 0) waiters.splice(idx, 1);
              resolve();
            }, 15000);
            if (typeof t.unref === 'function') t.unref();
          });
          if (closeError && !queue.length) throw closeError;
        }
      }
      // 排空残留
      while (queue.length) yield queue.shift();
    } finally {
      try { ws.removeEventListener('message', onMessage); } catch { /* noop */ }
      try { ws.removeEventListener('close', onClose); } catch { /* noop */ }
      try { ws.removeEventListener('error', onError); } catch { /* noop */ }
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
      try { if (ws.readyState === 1 || ws.readyState === 0) ws.close(); } catch { /* noop */ }
    }
  }

  /** 降级实现：HTTP 轮询 getEvents。无轮询上限，靠 signal 终止。 */
  async function* pollingStream(conversationId, { content, signal }) {
    // 先发消息
    if (content != null) {
      try { await sendMessage(conversationId, content, { signal }); }
      catch (e) { if (signal && signal.aborted) return; throw e; }
    }
    let seen = 0;
    let consecutiveFailures = 0;
    while (true) {
      if (signal && signal.aborted) return;
      let events;
      try {
        events = await getEvents(conversationId, { signal });
        consecutiveFailures = 0;
      } catch (e) {
        if (signal && signal.aborted) return;
        // conversation 已不存在：不再空转轮询，交由上层裁定终态（v2.7.2 §13）
        if (e && e.httpStatus === 404) throw e;
        // 网络瞬断：退避重试，但连续失败超过阈值必须抛出（绝不无限伪装「运行中」）
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          const err = new Error(
            `openhands event polling failed ${consecutiveFailures} times in a row: ${e && e.message ? e.message : String(e)}`
          );
          if (e && e.httpStatus) err.httpStatus = e.httpStatus;
          err.streamEnded = true;
          throw err;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (Array.isArray(events) && events.length > seen) {
        for (const evt of events.slice(seen)) {
          yield evt;
          seen++;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  function sleep(ms) {
    return new Promise(r => {
      const t = setTimeout(r, ms);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  return {
    health,
    createConversation,
    sendMessage,
    getEvents,
    deleteConversation,
    search,
    websocketEvents,
    hasWebSocket: !!getWebSocketImpl()
  };
}

module.exports = { createOpenHandsClient, getWebSocketImpl, DEFAULT_TIMEOUT_MS, MAX_POLL_FAILURES };
