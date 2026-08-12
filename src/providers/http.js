'use strict';
/**
 * Shared HTTP helpers for provider adapters.
 *
 * Abort contract (v2.2.0 / P0-1 + P1-8):
 *  - Every request helper accepts an optional external AbortSignal.
 *  - The external signal is *linked* with the timeout signal and the merged
 *    signal is handed to fetch(), so aborting really tears down the socket
 *    instead of waiting for the next SSE chunk to arrive.
 *  - streamSSE() also cancels the reader the moment the signal fires, so a
 *    server that holds the connection open without sending data can still be
 *    stopped instantly.
 *  - Abort vs. timeout are distinguishable: aborts throw AbortError
 *    (err.aborted === true), timeouts throw TimeoutError (err.timeout === true).
 */
const NODE_TIMEOUT = 120000;
const LINK = Symbol.for('adp.httpLink');

class AbortError extends Error {
  constructor(message) {
    super(message || 'aborted');
    this.name = 'AbortError';
    this.aborted = true;
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message || '请求超时');
    this.name = 'TimeoutError';
    this.timeout = true;
  }
}

function isAbortError(err) {
  if (!err) return false;
  if (err.aborted === true) return true;
  if (err.name === 'AbortError') return true;
  const m = String(err.message || '');
  return /\baborted\b|The operation was aborted|This operation was aborted/i.test(m);
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.timeout === true) return true;
  return err.name === 'TimeoutError';
}

/**
 * Merge a timeout with an optional external AbortSignal into one signal.
 * Returns a handle: { signal, timedOut, aborted, dispose() }.
 */
function linkSignals(timeoutMs, externalSignal) {
  const ctrl = new AbortController();
  const ms = timeoutMs == null ? NODE_TIMEOUT : Number(timeoutMs);
  const state = { timedOut: false, externallyAborted: false };
  let timer = null;
  let onExternal = null;

  const abortExternal = () => {
    state.externallyAborted = true;
    try { ctrl.abort(new AbortError('aborted')); } catch { /* already aborted */ }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortExternal();
    } else {
      onExternal = abortExternal;
      try { externalSignal.addEventListener('abort', onExternal, { once: true }); } catch { onExternal = null; }
    }
  }

  if (Number.isFinite(ms) && ms > 0 && !ctrl.signal.aborted) {
    timer = setTimeout(() => {
      state.timedOut = true;
      try { ctrl.abort(new TimeoutError('请求超时')); } catch { /* already aborted */ }
    }, ms);
    // Never keep the event loop alive just for a request timeout.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    signal: ctrl.signal,
    get timedOut() { return state.timedOut; },
    get externallyAborted() { return state.externallyAborted; },
    abort(reason) {
      state.externallyAborted = true;
      try { ctrl.abort(reason || new AbortError('aborted')); } catch { /* noop */ }
    },
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (onExternal && externalSignal) {
        try { externalSignal.removeEventListener('abort', onExternal); } catch { /* noop */ }
        onExternal = null;
      }
    }
  };
}

/** Normalise a fetch/stream rejection into AbortError / TimeoutError when applicable. */
function normalizeAbort(err, link) {
  if (link && link.timedOut && (isAbortError(err) || isTimeoutError(err))) return new TimeoutError('请求超时');
  if (isTimeoutError(err)) return err;
  if (isAbortError(err)) return new AbortError('aborted');
  return err;
}

/** Accept legacy `timeoutMs` number or the new `{ timeoutMs, signal }` options object. */
function normalizeOpts(opts) {
  if (opts == null) return { timeoutMs: NODE_TIMEOUT, signal: null };
  if (typeof opts === 'number') return { timeoutMs: opts, signal: null };
  return { timeoutMs: opts.timeoutMs == null ? NODE_TIMEOUT : opts.timeoutMs, signal: opts.signal || null };
}

// ---------------------------------------------------------------------------
// v2.9.8 R5 — Bounded Transient Failure Recovery.
//
// 可靠不等于无限重试：每个 decision 最多 2 次 provider 尝试（初始 + 1 次重试）。
// 仅当（1）请求未被取消、（2）错误被分类为瞬态可重试、（3）仍有有界额度时才重试。
// 超时与用户 abort 永不重试；重试前等待 200ms（abort 可立即打断等待）。
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 200;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS = Symbol.for('adp.httpAttempts');

/** 瞬态网络错误分类（连接重置 / 传输层瞬态失败）。abort/timeout 不可重试。 */
function isRetryableNetworkError(err) {
  if (!err || isAbortError(err) || isTimeoutError(err)) return false;
  const m = String(err.message || '');
  const cause = err.cause || null;
  const cm = cause ? String(cause.message || '') + ' ' + String(cause.code || '') : '';
  return /fetch failed|socket hang up|network socket disconnected|other side closed/i.test(m)
    || /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT/i.test(m + ' ' + cm);
}

async function retryDelay(link) {
  const deadline = Date.now() + RETRY_DELAY_MS;
  while (Date.now() < deadline) {
    if (link.signal.aborted) return;
    await new Promise(r => setTimeout(r, 25));
  }
}

function attachAttempts(resp, attempts) {
  try { Object.defineProperty(resp, ATTEMPTS, { value: attempts, enumerable: false, configurable: true }); } catch { /* noop */ }
  return resp;
}

/** 该响应经历的 provider 尝试次数（可观测的重试元数据）。 */
function attemptsOf(resp) {
  return resp && resp[ATTEMPTS] ? resp[ATTEMPTS] : 1;
}

function authHeaders(conn) {
  const h = { 'Content-Type': 'application/json' };
  const skipAuth = conn.provider === 'local' || conn.provider === 'ollama';
  if (conn.api_key && String(conn.api_key).trim() !== '' && !skipAuth) {
    h['Authorization'] = `Bearer ${conn.api_key}`;
  }
  // merge custom headers
  if (conn.headers && typeof conn.headers === 'object') {
    for (const [k, v] of Object.entries(conn.headers)) h[k] = v;
  }
  return h;
}

function baseUrlOf(conn) {
  return (conn.base_url || '').replace(/\/+$/, '');
}

function attachLink(resp, link) {
  try {
    Object.defineProperty(resp, LINK, { value: link, enumerable: false, configurable: true });
  } catch { /* frozen response, ignore */ }
  return resp;
}

function linkOf(resp) {
  return resp && resp[LINK] ? resp[LINK] : null;
}

/**
 * Release the timeout/listener attached to a response.
 * Call it once the body has been fully consumed (streamSSE does it for you).
 */
function releaseResponse(resp) {
  const link = linkOf(resp);
  if (link) link.dispose();
}

/**
 * Low-level request. Pass `conn = null` to skip the default Bearer auth headers
 * (Anthropic uses x-api-key and must not receive a stray Authorization header).
 *
 * v2.9.8 R5：有界瞬态重试——最多 MAX_ATTEMPTS 次尝试（初始 + 1 次重试），
 * 仅对 RETRYABLE_STATUS 与瞬态网络错误生效；取消 / 超时 / 其他错误不重试。
 */
async function request(url, init, conn, opts) {
  const { timeoutMs, signal } = normalizeOpts(opts);
  const link = linkSignals(timeoutMs, signal);
  const base = conn ? authHeaders(conn) : { 'Content-Type': 'application/json' };
  let attempt = 0;
  const canRetry = () => attempt < MAX_ATTEMPTS && !link.externallyAborted && !link.timedOut && !(link.signal.aborted);
  for (;;) {
    attempt += 1;
    try {
      const resp = await fetch(url, {
        ...init,
        headers: { ...base, ...(init.headers || {}) },
        signal: link.signal
      });
      // HTTP 408/429/5xx：瞬态服务端错误 → 有界重试（响应体尚未消费，安全）
      if (!resp.ok && RETRYABLE_STATUS.has(resp.status) && canRetry()) {
        try { resp.body && resp.body.cancel && Promise.resolve(resp.body.cancel()).catch(() => {}); } catch { /* noop */ }
        await retryDelay(link);
        continue;
      }
      // The link stays alive: the body may still be streaming and must remain
      // abortable. streamSSE()/releaseResponse() disposes it.
      return attachAttempts(attachLink(resp, link), attempt);
    } catch (err) {
      const normalized = normalizeAbort(err, link);
      if (isRetryableNetworkError(normalized) && canRetry()) {
        await retryDelay(link);
        continue;
      }
      link.dispose();
      throw normalized;
    }
  }
}

async function postJson(url, body, conn, opts) {
  return request(url, { method: 'POST', body: JSON.stringify(body) }, conn, opts);
}

async function getJson(url, conn, opts) {
  return request(url, { method: 'GET' }, conn, opts);
}

/**
 * Async generator yielding raw text lines from a fetch Response body.
 *
 * The whole point of this helper is abort responsiveness: the moment the linked
 * signal fires we cancel the reader, so a pending read() on a server that is
 * holding the connection open settles immediately instead of hanging until the
 * next chunk (which may never come).
 */
async function* streamLines(response, opts) {
  const link = linkOf(response);
  const extra = normalizeOpts(opts).signal;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cancelled = false;

  const signals = [];
  if (link) signals.push(link.signal);
  if (extra && (!link || extra !== link.signal)) signals.push(extra);

  const onAbort = () => {
    cancelled = true;
    // Force the pending read() to settle right away. cancel() returns a promise
    // that rejects once the stream is already errored — swallow it here, or it
    // resurfaces as an unhandledRejection long after the caller moved on.
    try { Promise.resolve(reader.cancel(new AbortError('aborted'))).catch(() => {}); } catch { /* noop */ }
  };
  for (const s of signals) {
    if (s.aborted) { onAbort(); break; }
  }
  if (!cancelled) {
    for (const s of signals) {
      try { s.addEventListener('abort', onAbort, { once: true }); } catch { /* noop */ }
    }
  }

  const throwIfCancelled = () => {
    if (!cancelled) return;
    if (link && link.timedOut) throw new TimeoutError('请求超时');
    throw new AbortError('aborted');
  };

  try {
    throwIfCancelled();
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throwIfCancelled();
        throw normalizeAbort(err, link);
      }
      throwIfCancelled();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        yield line;
        throwIfCancelled();
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    for (const s of signals) {
      try { s.removeEventListener('abort', onAbort); } catch { /* noop */ }
    }
    try { await reader.cancel(); } catch { /* noop */ }
    if (link) link.dispose();
  }
}

/** Async generator yielding parsed SSE JSON objects from a fetch Response. */
async function* streamSSE(response, opts) {
  for await (const line of streamLines(response, opts)) {
    const t = line.trim();
    if (!t || !t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (d === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(d); } catch { continue; }
    yield parsed;
  }
}

/** Async generator yielding parsed NDJSON objects (Ollama /api/chat). */
async function* streamNDJSON(response, opts) {
  for await (const line of streamLines(response, opts)) {
    const t = line.trim();
    if (!t) continue;
    let parsed;
    try { parsed = JSON.parse(t); } catch { continue; }
    yield parsed;
  }
}

function interpretError(status, bodyText) {
  let msg = `API 返回 ${status}`;
  try {
    const b = JSON.parse(bodyText);
    msg = b.error?.message || b.message || msg;
  } catch {}
  if (status === 401 || status === 403) msg = 'API Key 无效或已过期 (401/403)';
  if (status === 429) msg = '请求过于频繁或额度不足 (429)';
  if (status === 404) msg = '模型不存在或接口地址错误 (404)';
  return msg;
}

/** Throw a normalised AbortError if the signal already fired. */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortError('aborted');
}

module.exports = {
  authHeaders,
  baseUrlOf,
  postJson,
  getJson,
  request,
  streamSSE,
  streamNDJSON,
  streamLines,
  interpretError,
  linkSignals,
  attachLink,
  releaseResponse,
  normalizeAbort,
  throwIfAborted,
  isAbortError,
  isTimeoutError,
  isRetryableNetworkError,
  attemptsOf,
  MAX_ATTEMPTS,
  RETRYABLE_STATUS,
  AbortError,
  TimeoutError,
  NODE_TIMEOUT
};
