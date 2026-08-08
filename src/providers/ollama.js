'use strict';
/**
 * Ollama native provider: /api/chat + /api/tags
 * Software auto-detects http://localhost:11434 but must not fail if Ollama absent.
 */
const { baseUrlOf, NODE_TIMEOUT } = require('./http');

function headers(conn) {
  const h = { 'Content-Type': 'application/json' };
  if (conn.headers && typeof conn.headers === 'object') Object.assign(h, conn.headers);
  return h;
}

function toOllamaMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map(t => ({ function: { name: t.name, arguments: t.arguments || '{}' } })) });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function createOllama(conn) {
  async function testConnection() {
    const url = baseUrlOf(conn) + '/api/tags';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, { method: 'GET', headers: headers(conn), signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: resp.ok, status: resp.status, message: resp.ok ? 'Ollama 已连接' : `Ollama 返回 ${resp.status}（请确认已启动 Ollama）` };
    } catch (e) { return { ok: false, status: 0, message: `无法连接 Ollama: ${e.message}（若未安装 Ollama 可忽略）` }; }
  }
  async function listModels() {
    const url = baseUrlOf(conn) + '/api/tags';
    const resp = await fetch(url, { method: 'GET', headers: headers(conn) });
    if (!resp.ok) throw new Error(`获取模型失败 (${resp.status})`);
    const json = await resp.json();
    return (json.models || []).map(m => m.name).filter(Boolean);
  }
  async function streamResponse({ system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall }) {
    const url = baseUrlOf(conn) + '/api/chat';
    const omsg = toOllamaMessages(messages);
    if (system) omsg.unshift({ role: 'system', content: system });
    const body = {
      model: conn.model || (conn.models && conn.models[0]) || 'qwen2.5:7b',
      messages: omsg,
      stream: true,
      options: { temperature: temperature ?? 0.7 }
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } }));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NODE_TIMEOUT);
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!resp.ok) { const txt = await resp.text(); throw new Error(`Ollama 返回 ${resp.status}: ${txt.slice(0, 200)}`); }

    let full = '';
    let toolCalls = [];
    const reader = resp.body.getReader();
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
        if (!t) continue;
        try {
          const chunk = JSON.parse(t);
          if (chunk.message?.content) { full += chunk.message.content; if (onChunk) onChunk(chunk.message.content); }
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              toolCalls.push({ id: 'call_' + Math.random().toString(36).slice(2), name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}) });
            }
          }
        } catch {}
      }
      if (signal && signal.aborted) throw new Error('aborted');
    }
    if (toolCalls.length && onToolCall) onToolCall(toolCalls);
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage: null };
  }
  return { protocol: 'ollama', testConnection, listModels, streamResponse };
}

module.exports = { createOllama };
