'use strict';
/**
 * v2.8.0 — 通用 JSON-RPC 会话层（spec §24/§94，复用原则见 §20/§34/§63）。
 *
 * 为什么需要"可配置信封"：
 *   - ACP 是**严格** JSON-RPC 2.0，报文必须带 "jsonrpc":"2.0"。
 *   - Codex App Server **故意不遵守** JSON-RPC 2.0。上游原文
 *     (codex-rs/app-server-protocol/src/rpc.rs:1-2)：
 *       "We do not do true JSON-RPC 2.0, as we neither send nor expect
 *        the \"jsonrpc\": \"2.0\" field."
 *     发过去带 jsonrpc 字段会被当成未知字段，收回来也不会有该字段 ——
 *     用现成的 JSON-RPC 客户端库会直接因缺字段而拒收。
 *
 * 与其为 Codex 复制一份传输层，不如把差异收敛成一个参数：
 *   envelopeVersion = '2.0'  → 严格模式（ACP）
 *   envelopeVersion = null   → 裸信封模式（Codex App Server）
 *
 * 本文件只负责 JSON-RPC 信封的收发与分发，不做进程管理、不做业务语义。
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 600000;

/** 标准 JSON-RPC 错误码（两种模式共用）。 */
const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

/**
 * 创建 JSON-RPC 会话。
 * @param {object} opts
 * @param {Function} opts.send (serializedJsonString) => void 把一帧消息投递给对端
 * @param {string|null} [opts.envelopeVersion='2.0'] '2.0'=严格；null=不带/不校验 jsonrpc 字段
 * @param {number} [opts.requestTimeoutMs]
 * @param {*} [opts.disposeErrorCode] dispose 时挂到 reject Error 上的 code
 * @param {*} [opts.timeoutErrorCode] 请求超时时挂到 reject Error 上的 code
 *   （调用方据此区分"超时"与"失败"，spec §67：超时 ≠ 取消 ≠ 失败）
 */
function createJsonRpcSession({
  send,
  envelopeVersion = '2.0',
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  disposeErrorCode,
  timeoutErrorCode
} = {}) {
  let nextId = 1;
  const pending = new Map();              // id -> { resolve, reject, timer, method }
  const notificationHandlers = new Map(); // method -> cb(params)
  const requestHandlers = new Map();      // method -> cb(params, { respond, respondError })
  let disposed = false;

  /** 组装信封：严格模式加 jsonrpc 字段，裸模式不加。 */
  function envelope(base) {
    return envelopeVersion ? { jsonrpc: envelopeVersion, ...base } : { ...base };
  }

  function _send(obj) {
    if (disposed) throw new Error('transport disposed');
    if (typeof send !== 'function') throw new Error('transport has no send function');
    send(JSON.stringify(obj));
  }

  function request(method, params, { timeoutMs = requestTimeoutMs } = {}) {
    if (disposed) return Promise.reject(new Error('transport disposed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            const err = new Error('request timeout: ' + method);
            if (timeoutErrorCode !== undefined) err.code = timeoutErrorCode;
            err.timeout = true;
            reject(err);
          }
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      pending.set(id, { resolve, reject, timer, method });
      try {
        _send(envelope({ id, method, params: params || {} }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  function notify(method, params) {
    _send(envelope({ method, params: params || {} }));
  }

  function respond(id, result) {
    _send(envelope({ id, result: result === undefined ? null : result }));
  }

  function respondError(id, code, message, data) {
    const err = { code, message };
    if (data !== undefined) err.data = data;
    _send(envelope({ id, error: err }));
  }

  /**
   * 处理从对端收到的一条 JSON-RPC 对象。
   * 严格模式下 jsonrpc 字段不匹配即丢弃；裸模式下不校验。
   */
  function receive(obj) {
    if (disposed || !obj || typeof obj !== 'object') return;
    if (envelopeVersion && obj.jsonrpc !== envelopeVersion) return;

    const hasId = obj.id !== undefined && obj.id !== null;

    // 1) 响应：有 id、无 method
    if (hasId && !obj.method) {
      const entry = pending.get(obj.id);
      if (!entry) return; // 未知 id（可能已超时清理）
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(obj.id);
      if (obj.error) {
        entry.reject(Object.assign(
          new Error((obj.error && obj.error.message) || 'rpc error'),
          { code: obj.error.code, data: obj.error.data }
        ));
      } else {
        entry.resolve(obj.result);
      }
      return;
    }

    // 2) 对端 → 我方请求：有 id、有 method → 必须回响应
    if (hasId && obj.method) {
      const handler = requestHandlers.get(obj.method);
      if (!handler) {
        respondError(obj.id, RPC_ERROR.METHOD_NOT_FOUND, 'Method not found: ' + obj.method);
        return;
      }
      Promise.resolve()
        .then(() => handler(obj.params || {}, {
          respond: (result) => respond(obj.id, result),
          respondError: (code, message, data) => respondError(obj.id, code, message, data)
        }))
        .catch(e => {
          try { respondError(obj.id, RPC_ERROR.INTERNAL_ERROR, (e && e.message) || 'internal error'); } catch { /* stream closed */ }
        });
      return;
    }

    // 3) 通知：有 method、无 id
    if (obj.method) {
      const handler = notificationHandlers.get(obj.method);
      if (handler) {
        try { handler(obj.params || {}); } catch { /* 单个 handler 抛错不得中断收流 */ }
      }
    }
  }

  function onNotification(method, cb) { notificationHandlers.set(method, cb); return api; }
  function onRequest(method, cb) { requestHandlers.set(method, cb); return api; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      const err = new Error('transport disposed');
      if (disposeErrorCode !== undefined) err.code = disposeErrorCode;
      try { entry.reject(err); } catch { /* noop */ }
    }
    pending.clear();
    notificationHandlers.clear();
    requestHandlers.clear();
  }

  const api = {
    request,
    notify,
    respond,
    respondError,
    receive,
    onNotification,
    onRequest,
    dispose,
    _isDisposed: () => disposed,
    _pendingCount: () => pending.size
  };
  return api;
}

module.exports = { createJsonRpcSession, DEFAULT_REQUEST_TIMEOUT_MS, RPC_ERROR };
