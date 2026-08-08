'use strict';
/**
 * Anthropic Messages API: /v1/messages
 * Handles system, content blocks, streaming, tool_use / tool_result, images.
 */
const { baseUrlOf, streamSSE, request, releaseResponse, throwIfAborted, interpretError, NODE_TIMEOUT } = require('./http');
const { partsOf, plainText } = require('./content');

/**
 * P1-7: curated fallback list.
 *
 * The previous list shipped truncated ids like `claude-opus-4-` which are not
 * valid model names and fail with 404 the moment they are actually used. These
 * are real, complete ids. They are only used when the live /v1/models endpoint
 * is unavailable, and in that case the source is reported as `preset` — we do
 * NOT pretend a hard-coded list came from the server.
 */
const PRESET_MODELS = [
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest'
];

function headers(conn) {
  const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (conn.api_key && String(conn.api_key).trim() !== '') h['x-api-key'] = conn.api_key;
  if (conn.headers && typeof conn.headers === 'object') Object.assign(h, conn.headers);
  return h;
}

/** `opts.model` wins; no hard-coded substitution (see providers/index resolveModel). */
function wireModel(opts, conn, probeDefault) {
  const m = (opts && opts.model) || conn.default_model || conn.model || (conn.models && conn.models[0]) || probeDefault || null;
  if (!m) throw new Error('未指定模型：请在 Agent 或 API 连接中选择一个模型');
  return m;
}

/** Neutral parts → Anthropic content blocks. */
function toBlocks(content) {
  return partsOf(content).map(p => (p.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
    : { type: 'text', text: p.text }));
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push(...toBlocks(m.content).filter(b => b.type === 'text'));
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : plainText(m.content) }] });
    } else {
      const blocks = toBlocks(m.content);
      out.push({ role: m.role, content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    }
  }
  return out;
}

function createAnthropic(conn) {
  /**
   * Anthropic *does* have GET /v1/models on the official API. Try it first and
   * only fall back to the curated preset when the endpoint is unavailable
   * (self-hosted gateways, older proxies, no key). The caller is told which of
   * the two it got via `source`.
   */
  async function listModelsDetailed(opts = {}) {
    const url = baseUrlOf(conn) + '/models?limit=100';
    try {
      const resp = await request(url, { method: 'GET', headers: headers(conn) }, null,
        { timeoutMs: opts.timeoutMs || 15000, signal: opts.signal });
      if (resp.ok) {
        const json = await resp.json();
        releaseResponse(resp);
        const list = (Array.isArray(json) ? json : json.data || []).map(m => m.id || m.name).filter(Boolean);
        if (list.length) return { models: list, source: 'remote' };
      } else {
        releaseResponse(resp);
      }
    } catch { /* fall through to preset */ }
    return {
      models: PRESET_MODELS.slice(),
      source: 'preset',
      note: '未能从 Anthropic 获取模型列表，以下为内置推荐模型，可能不是你账号的完整可用列表'
    };
  }

  async function listModels(opts = {}) {
    return (await listModelsDetailed(opts)).models;
  }

  /** P1-71: no hard-coded probe model. */
  async function probeModel(opts = {}) {
    const m = (opts && opts.model) || conn.default_model || conn.model || (conn.models && conn.models[0]);
    if (m) return m;
    const d = await listModelsDetailed(opts);
    return (d.models && d.models[0]) || null;
  }

  async function testConnection(opts = {}) {
    const t0 = Date.now();
    const url = baseUrlOf(conn) + '/messages';
    const model = await probeModel(opts);
    if (!model) {
      return {
        ok: false, status: 0, endpoint: '/messages', model: null, latency: Date.now() - t0,
        message: '未指定模型：请先点击「获取模型」并选择一个模型，再测试连接'
      };
    }
    const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    try {
      const resp = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body) }, null,
        { timeoutMs: opts.timeoutMs || 15000, signal: opts.signal });
      const txt = resp.ok ? null : await resp.text().catch(() => '');
      releaseResponse(resp);
      return {
        ok: resp.ok,
        status: resp.status,
        message: resp.ok ? '连接成功' : interpretError(resp.status, txt),
        latency: Date.now() - t0,
        endpoint: '/messages',
        model
      };
    } catch (e) { return { ok: false, status: 0, message: `无法连接: ${e.message}`, latency: Date.now() - t0, endpoint: '/messages', model }; }
  }
  async function streamResponse(opts) {
    const { system, messages, tools, temperature, maxTokens, signal, onChunk, onToolCall } = opts;
    const model = wireModel(opts, conn);
    const url = baseUrlOf(conn) + '/messages';
    const body = {
      model,
      max_tokens: maxTokens ?? 4096,
      system: system || undefined,
      messages: toAnthropicMessages(messages),
      temperature: temperature ?? 0.7,
      stream: true
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters || { type: 'object', properties: {} } }));
    }
    throwIfAborted(signal);
    // P0-1: the caller's signal goes straight to fetch(), so Stop tears down the
    // connection instead of waiting for the next SSE event.
    const resp = await request(url, { method: 'POST', headers: headers(conn), body: JSON.stringify(body) }, null,
      { timeoutMs: opts.timeoutMs || NODE_TIMEOUT, signal });
    if (!resp.ok) {
      const txt = await resp.text();
      releaseResponse(resp);
      throw new Error(`Anthropic 返回 ${resp.status}: ${txt.slice(0, 300)}`);
    }

    let full = '';
    const toolUses = {};   // index -> {id,name,input_text}
    let usage = null;
    let respModel = null;
    for await (const ev of streamSSE(resp)) {
      if (ev.type === 'message_start' && ev.message?.model && !respModel) respModel = ev.message.model;
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
    return { content: full, toolCalls: toolCalls.length ? toolCalls : null, usage, model, responseModel: respModel || model };
  }
  return { protocol: 'anthropic', endpoint: '/messages', supportsVision: true, testConnection, listModels, listModelsDetailed, streamResponse };
}

module.exports = { createAnthropic, toAnthropicMessages };
