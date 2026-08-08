'use strict';
/**
 * Ollama native provider: /api/chat + /api/tags
 * Software auto-detects http://localhost:11434 but must not fail if Ollama absent.
 */
const { baseUrlOf, request, streamNDJSON, releaseResponse, throwIfAborted, NODE_TIMEOUT } = require('./http');
const { partsOf, plainText } = require('./content');

function headers(conn) {
  const h = { 'Content-Type': 'application/json' };
  if (conn.headers && typeof conn.headers === 'object') Object.assign(h, conn.headers);
  return h;
}

/** `opts.model` wins; no hard-coded substitution (see providers/index resolveModel). */
function wireModel(opts, conn) {
  const m = (opts && opts.model) || conn.default_model || conn.model || (conn.models && conn.models[0]) || null;
  if (!m) throw new Error('未指定模型：请在 Agent 或 API 连接中选择一个 Ollama 模型');
  return m;
}

/**
 * Ollama /api/chat carries images out-of-band: message.images is an array of
 * raw base64 strings (no data: prefix), while content stays plain text.
 */
function toOllamaMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      out.push({ role: 'assistant', content: plainText(m.content) || '', tool_calls: m.tool_calls.map(t => ({ function: { name: t.name, arguments: t.arguments || '{}' } })) });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', content: typeof m.content === 'string' ? m.content : plainText(m.content) });
    } else {
      const parts = partsOf(m.content);
      const images = parts.filter(p => p.type === 'image').map(p => p.data);
      const msg = { role: m.role, content: parts.filter(p => p.type === 'text').map(p => p.text).join('\n') };
      if (images.length) msg.images = images;
      out.push(msg);
    }
  }
  return out;
}

function createOllama(conn) {
  async function testConnection(opts = {}) {
    const url = baseUrlOf(conn) + '/api/tags';
    try {
      const resp = await request(url, { method: 'GET', headers: headers(conn) }, null,
        { timeoutMs: opts.timeoutMs || 8000, signal: opts.signal });
      releaseResponse(resp);
      return { ok: resp.ok, status: resp.status, message: resp.ok ? 'Ollama 已连接' : `Ollama 返回 ${resp.status}（请确认已启动 Ollama）` };
    } catch (e) { return { ok: false, status: 0, message: `无法连接 Ollama: ${e.message}（若未安装 Ollama 可忽略）` }; }
  }
  async function listModels(opts = {}) {
    const url = baseUrlOf(conn) + '/api/tags';
    const resp = await request(url, { method: 'GET', headers: headers(conn) }, null,
      { timeoutMs: opts.timeoutMs || 15000, signal: opts.signal });
    if (!resp.ok) { releaseResponse(resp); throw new Error(`获取模型失败 (${resp.status})`); }
    const json = await resp.json();
    releaseResponse(resp);
    return (json.models || []).map(m => m.name).filter(Boolean);
  }
  /** P1-7: uniform detailed shape; Ollama returns locally installed model names. */
  async function listModelsDetailed(opts = {}) {
    const models = await listModels(opts);
    return { models, source: 'remote' };
  }
  async function streamResponse(opts) {
    const { system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall } = opts;
    const model = wireModel(opts, conn);
    const url = baseUrlOf(conn) + '/api/chat';
    const omsg = toOllamaMessages(messages);
    if (system) omsg.unshift({ role: 'system', content: system });
    const body = {
      model,
      messages: omsg,
      stream: true,
      options: { temperature: temperature ?? 0.7 }
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } }));
    }
    throwIfAborted(signal);
    const resp = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body) }, null,
      { timeoutMs: opts.timeoutMs || NODE_TIMEOUT, signal });
    if (!resp.ok) {
      const txt = await resp.text();
      releaseResponse(resp);
      throw new Error(`Ollama 返回 ${resp.status}: ${txt.slice(0, 200)}`);
    }

    let full = '';
    let toolCalls = [];
    for await (const chunk of streamNDJSON(resp)) {
      if (chunk.message?.content) { full += chunk.message.content; if (onChunk) onChunk(chunk.message.content); }
      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          toolCalls.push({
            id: 'call_' + Math.random().toString(36).slice(2),
            name: tc.function?.name,
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
          });
        }
      }
    }
    if (toolCalls.length && onToolCall) onToolCall(toolCalls);
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage: null, model, responseModel: model };
  }
  return { protocol: 'ollama', endpoint: '/api/chat', supportsVision: true, testConnection, listModels, listModelsDetailed, streamResponse };
}

module.exports = { createOllama, toOllamaMessages };
