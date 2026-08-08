'use strict';
/**
 * OpenAI-compatible provider: /v1/chat/completions  AND  /v1/responses
 *
 * v2.1.0:
 *  - `streamResponse({ model })` is authoritative. The connection's model list is
 *    only consulted when the caller gave nothing (and that fact is reported).
 *  - multimodal content parts (text + image) are encoded per endpoint.
 *  - the Responses adapter probes /responses (NOT /chat/completions) — the two
 *    endpoints have independent availability on most gateways.
 */
const { authHeaders, baseUrlOf, postJson, getJson, streamSSE, interpretError, NODE_TIMEOUT } = require('./http');
const { partsOf, dataUrl } = require('./content');

/**
 * The model actually put on the wire.
 *
 * `opts.model` is authoritative — the runtime resolves it once (providers/index
 * resolveModel) and every fallback there is reported to the user. The connection
 * lookups below only exist for direct/legacy callers; there is deliberately NO
 * hard-coded model name, because silently sending `gpt-4o-mini` to someone's
 * private gateway is worse than a clear error.
 */
function wireModel(opts, conn) {
  const m = (opts && opts.model) || conn.default_model || conn.model || (conn.models && conn.models[0]) || null;
  if (!m) throw new Error('未指定模型：请在 Agent 或 API 连接中选择一个模型');
  return m;
}

function chatContent(content) {
  const parts = partsOf(content);
  if (!parts.some(p => p.type === 'image')) {
    return parts.map(p => p.text).join('\n');
  }
  return parts.map(p => (p.type === 'image'
    ? { type: 'image_url', image_url: { url: dataUrl(p) } }
    : { type: 'text', text: p.text }));
}

function toChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      out.push({
        role: 'assistant',
        content: typeof m.content === 'string' ? (m.content || null) : chatContent(m.content),
        tool_calls: m.tool_calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }))
      });
    } else if (m.role === 'tool') {
      // tool results must stay plain text on chat/completions
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : require('./content').plainText(m.content) });
    } else {
      out.push({ role: m.role, content: chatContent(m.content) });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  return (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } }
  }));
}

// ---------------- chat/completions ----------------
function createOpenAIChat(conn) {
  async function testConnection(opts = {}) {
    const t0 = Date.now();
    const url = baseUrlOf(conn) + '/chat/completions';
    const model = opts.model || (conn.models && conn.models[0]) || conn.default_model || 'gpt-4o-mini';
    const body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
    try {
      const resp = await postJson(url, body, conn, 15000);
      const latency = Date.now() - t0;
      if (resp.ok) return { ok: true, status: resp.status, message: '连接成功', latency, endpoint: '/chat/completions', model };
      const txt = await resp.text();
      return { ok: false, status: resp.status, message: interpretError(resp.status, txt), latency, endpoint: '/chat/completions', model };
    } catch (e) {
      return { ok: false, status: 0, message: `无法连接: ${e.message}`, latency: Date.now() - t0, endpoint: '/chat/completions', model };
    }
  }

  async function listModels() {
    const url = baseUrlOf(conn) + '/models';
    const resp = await getJson(url, conn, 15000);
    if (!resp.ok) {
      let msg = `获取模型失败 (${resp.status})`;
      if (resp.status === 401 || resp.status === 403) msg = 'API Key 无效';
      if (resp.status === 404) msg = '该接口不支持 /models';
      throw new Error(msg);
    }
    const json = await resp.json();
    const list = Array.isArray(json) ? json : json.data;
    if (!Array.isArray(list)) throw new Error('返回数据格式不支持');
    return list.map(m => m.id || m.name).filter(Boolean);
  }

  async function streamResponse(opts) {
    const { system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall } = opts;
    const model = wireModel(opts, conn);
    const url = baseUrlOf(conn) + '/chat/completions';
    const body = {
      model,
      messages: toChatMessages(system, messages),
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 4096,
      stream: true
    };
    const tls = toOpenAITools(tools);
    if (tls.length) body.tools = tls;

    const resp = await postJson(url, body, conn, NODE_TIMEOUT);
    if (!resp.ok) { const txt = await resp.text(); throw new Error(interpretError(resp.status, txt)); }

    let full = '';
    let acc = [];
    let usage = null;
    let respModel = null;
    for await (const chunk of streamSSE(resp)) {
      if (signal && signal.aborted) throw new Error('aborted');
      if (chunk.model && !respModel) respModel = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) { full += delta.content; if (onChunk) onChunk(delta.content); }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!acc[i]) acc[i] = { id: '', name: '', arguments: '' };
          if (tc.id) acc[i].id = tc.id;
          if (tc.function?.name) acc[i].name += tc.function.name;
          if (tc.function?.arguments) acc[i].arguments += tc.function.arguments;
        }
      }
      if (chunk.usage) usage = chunk.usage;
    }
    const toolCalls = acc.filter(t => t && t.name).map(t => ({ id: t.id, name: t.name, arguments: t.arguments }));
    if (toolCalls.length && onToolCall) onToolCall(toolCalls);
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage, model, responseModel: respModel || model };
  }

  return { protocol: 'openai-chat', endpoint: '/chat/completions', supportsVision: true, testConnection, listModels, streamResponse };
}

// ---------------- /v1/responses ----------------
function createOpenAIResponses(conn) {
  /**
   * Probe the endpoint this adapter actually uses. A gateway can expose
   * /chat/completions and still 404 on /responses, so testing the wrong path
   * reports a healthy connection that then fails on the first real message.
   */
  async function testConnection(opts = {}) {
    const t0 = Date.now();
    const url = baseUrlOf(conn) + '/responses';
    const model = opts.model || (conn.models && conn.models[0]) || conn.default_model || 'gpt-4o-mini';
    const body = { model, input: [{ role: 'user', content: 'hi' }], max_output_tokens: 16, stream: false };
    try {
      const resp = await postJson(url, body, conn, 15000);
      const latency = Date.now() - t0;
      if (resp.ok) return { ok: true, status: resp.status, message: '连接成功（/responses）', latency, endpoint: '/responses', model };
      const txt = await resp.text();
      let message = interpretError(resp.status, txt);
      if (resp.status === 404) message = '该服务不支持 /responses 接口（请改用 OpenAI Chat 协议）';
      return { ok: false, status: resp.status, message, latency, endpoint: '/responses', model };
    } catch (e) {
      return { ok: false, status: 0, message: `无法连接: ${e.message}`, latency: Date.now() - t0, endpoint: '/responses', model };
    }
  }
  async function listModels() { return createOpenAIChat(conn).listModels(); }

  function responsesContent(content, role) {
    const parts = partsOf(content);
    if (!parts.some(p => p.type === 'image')) return parts.map(p => p.text).join('\n');
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    return parts.map(p => (p.type === 'image'
      ? { type: 'input_image', image_url: dataUrl(p) }
      : { type: textType, text: p.text }));
  }

  function toResponsesInput(messages) {
    const out = [];
    for (const m of messages || []) {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) out.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '' });
        if (m.content) out.push({ role: 'assistant', content: responsesContent(m.content, 'assistant') });
      } else if (m.role === 'tool') {
        out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : require('./content').plainText(m.content) });
      } else {
        out.push({ role: m.role, content: responsesContent(m.content, m.role) });
      }
    }
    return out;
  }

  async function streamResponse(opts) {
    const { system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall } = opts;
    const model = wireModel(opts, conn);
    const url = baseUrlOf(conn) + '/responses';
    const input = toResponsesInput(messages);
    if (system) input.unshift({ role: 'system', content: system });
    const body = {
      model,
      input,
      temperature: temperature ?? 0.7,
      max_output_tokens: maxTokens ?? 4096,
      stream: true,
      tools: (tools || []).map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } }))
    };
    const resp = await postJson(url, body, conn, NODE_TIMEOUT);
    if (!resp.ok) { const txt = await resp.text(); throw new Error(interpretError(resp.status, txt)); }

    let full = '';
    let calls = {};      // item_id -> {id,name,arguments}
    let currentId = null;
    let toolCalls = [];
    let usage = null;
    let respModel = null;
    for await (const ev of streamSSE(resp)) {
      if (signal && signal.aborted) throw new Error('aborted');
      const type = ev.type;
      if (ev.response?.model && !respModel) respModel = ev.response.model;
      if (type === 'response.output_text.delta') { full += ev.delta; if (onChunk) onChunk(ev.delta); }
      else if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
        currentId = ev.item.id;
        calls[currentId] = { id: ev.item.call_id || ev.item.id, name: ev.item.name, arguments: '' };
      } else if (type === 'response.function_call_arguments.delta') {
        const cid = ev.item_id || currentId;
        if (calls[cid]) calls[cid].arguments += ev.delta || '';
      } else if (type === 'response.output_item.done' && ev.item?.type === 'function_call') {
        if (calls[ev.item.id]) { calls[ev.item.id].name = ev.item.name; calls[ev.item.id].arguments = ev.item.arguments || calls[ev.item.id].arguments; }
      } else if (type === 'response.completed') {
        if (ev.response?.usage) usage = ev.response.usage;
      }
    }
    toolCalls = Object.values(calls).filter(c => c.name);
    if (toolCalls.length && onToolCall) onToolCall(toolCalls);
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage, model, responseModel: respModel || model };
  }

  return { protocol: 'openai-responses', endpoint: '/responses', supportsVision: true, testConnection, listModels, streamResponse };
}

module.exports = { createOpenAIChat, createOpenAIResponses, toChatMessages, toOpenAITools, wireModel };
