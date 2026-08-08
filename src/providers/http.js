'use strict';
/**
 * Shared HTTP helpers for provider adapters: JSON POST, SSE streaming parser.
 */
const NODE_TIMEOUT = 120000;

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

async function postJson(url, body, conn, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || NODE_TIMEOUT);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: authHeaders(conn),
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, conn, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || NODE_TIMEOUT);
  try {
    const resp = await fetch(url, { method: 'GET', headers: authHeaders(conn), signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async generator yielding parsed SSE JSON objects from a fetch Response.
 */
async function* streamSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (d === '[DONE]') continue;
      try { yield JSON.parse(d); } catch { /* ignore malformed */ }
    }
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

module.exports = { authHeaders, baseUrlOf, postJson, getJson, streamSSE, interpretError, NODE_TIMEOUT };
