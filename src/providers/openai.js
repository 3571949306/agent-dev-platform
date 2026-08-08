'use strict';
/**
 * OpenAI-compatible provider: /v1/chat/completions  AND  /v1/responses
 */
const { authHeaders, baseUrlOf, postJson, getJson, streamSSE, interpretError, NODE_TIMEOUT } = require('./http');

function toChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }))
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
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
  async function testConnection() {
    const t0 = Date.now();
    const url = baseUrlOf(conn) + '/chat/completions';
    const body = { model: (conn.models && conn.models[0]) || 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
    try {
      const resp = await postJson(url, body, conn, 15000);
      const latency = Date.now() - t0;
      if (resp.ok) return { ok: true, status: resp.status, message: '连接成功', latency };
      const txt = await resp.text();
      return { ok: false, status: resp.status, message: interpretError(resp.status, txt), latency };
    } catch (e) {
      return { ok: false, status: 0, message: `无法连接: ${e.message}`, latency: Date.now() - t0 };
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

  async function streamResponse({ system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall }) {
    const url = baseUrlOf(conn) + '/chat/completions';
    const body = {
      model: conn.model || (conn.models && conn.models[0]),
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
    for await (const chunk of streamSSE(resp)) {
      if (signal && signal.aborted) throw new Error('aborted');
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
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage };
  }

  return { protocol: 'openai-chat', testConnection, listModels, streamResponse };
}

// ---------------- /v1/responses ----------------
function createOpenAIResponses(conn) {
  async function testConnection() {
    // Responses providers still expose chat/completions for a minimal probe
    const url = baseUrlOf(conn) + '/chat/completions';
    const body = { model: conn.model || (conn.models && conn.models[0]) || 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
    try {
      const resp = await postJson(url, body, conn, 15000);
      return { ok: resp.ok, status: resp.status, message: resp.ok ? '连接成功' : interpretError(resp.status, await resp.text()) };
    } catch (e) { return { ok: false, status: 0, message: `无法连接: ${e.message}` }; }
  }
  async function listModels() { return createOpenAIChat(conn).listModels(); }

  function toResponsesInput(messages) {
    const out = [];
    for (const m of messages || []) {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) out.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '' });
        if (m.content) out.push({ role: 'assistant', content: m.content });
      } else if (m.role === 'tool') {
        out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  async function streamResponse({ system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall }) {
    const url = baseUrlOf(conn) + '/responses';
    const input = toResponsesInput(messages);
    if (system) input.unshift({ role: 'system', content: system });
    const body = {
      model: conn.model || (conn.models && conn.models[0]),
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
    for await (const ev of streamSSE(resp)) {
      if (signal && signal.aborted) throw new Error('aborted');
      const type = ev.type;
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
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage };
  }

  return { protocol: 'openai-responses', testConnection, listModels, streamResponse };
}

module.exports = { createOpenAIChat, createOpenAIResponses, toChatMessages, toOpenAITools };
