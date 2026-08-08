'use strict';
/**
 * Anthropic Messages API: /v1/messages
 * Handles system, content blocks, streaming, tool_use / tool_result.
 */
const { baseUrlOf, streamSSE, NODE_TIMEOUT } = require('./http');

function headers(conn) {
  const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (conn.api_key && String(conn.api_key).trim() !== '') h['x-api-key'] = conn.api_key;
  if (conn.headers && typeof conn.headers === 'object') Object.assign(h, conn.headers);
  return h;
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
    } else {
      out.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    }
  }
  return out;
}

function createAnthropic(conn) {
  async function testConnection() {
    const url = baseUrlOf(conn) + '/messages';
    const body = { model: conn.model || 'claude-3-5-sonnet-latest', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: resp.ok, status: resp.status, message: resp.ok ? '连接成功' : `连接失败 (${resp.status})` };
    } catch (e) { return { ok: false, status: 0, message: `无法连接: ${e.message}` }; }
  }
  async function listModels() {
    // Anthropic has no public models endpoint; return common models
    return ['claude-opus-4-', 'claude-sonnet-4-', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'];
  }
  async function streamResponse({ system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall }) {
    const url = baseUrlOf(conn) + '/messages';
    const body = {
      model: conn.model || 'claude-3-5-sonnet-latest',
      max_tokens: maxTokens ?? 4096,
      system: system || undefined,
      messages: toAnthropicMessages(messages),
      temperature: temperature ?? 0.7,
      stream: true
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters || { type: 'object', properties: {} } }));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NODE_TIMEOUT);
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!resp.ok) { const txt = await resp.text(); throw new Error(`Anthropic 返回 ${resp.status}: ${txt.slice(0, 300)}`); }

    let full = '';
    const toolUses = {};   // index -> {id,name,input_text}
    let usage = null;
    for await (const ev of streamSSE(resp)) {
      if (signal && signal.aborted) throw new Error('aborted');
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b?.type === 'tool_use') toolUses[ev.index] = { id: b.id, name: b.name, input_text: '' };
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta') { full += d.text; if (onChunk) onChunk(d.text); }
        else if (d?.type === 'input_json_delta') { if (toolUses[ev.index]) toolUses[ev.index].input_text += d.partial_json; }
      } else if (ev.type === 'message_delta') {
        if (ev.usage) usage = ev.usage;
      }
    }
    const toolCalls = Object.values(toolUses).map(t => ({ id: t.id, name: t.name, arguments: t.input_text || '{}' }));
    if (toolCalls.length && onToolCall) onToolCall(toolCalls);
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage };
  }
  return { protocol: 'anthropic', testConnection, listModels, streamResponse };
}

module.exports = { createAnthropic, toAnthropicMessages };
