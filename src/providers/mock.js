'use strict';
/**
 * Mock provider — for LOCAL protocol/integration tests without a real API key.
 * Not a product feature. Emits streamed text and (optionally) a tool call so the
 * Agent Runtime loop + tool execution can be exercised offline.
 *
 * Behaviour:
 *  - if conn.mockToolCall and tools present → emit one tool_call to the first tool, no text
 *  - else → stream a canned assistant text in chunks
 */
const { AbortError } = require('./http');

function createMock(conn) {
  async function testConnection() { return { ok: true, status: 200, message: 'Mock 连接成功（本地测试）', latency: 1 }; }
  async function listModels() { return ['mock-fast', 'mock-reason']; }
  /** P1-7: uniform detailed shape; mock ids are hard-coded, never from a server. */
  async function listModelsDetailed() {
    return { models: ['mock-fast', 'mock-reason'], source: 'preset', note: '内置测试模型，不可用于真实调用' };
  }

  /** Resolve only when the signal fires — used by conn.mockHang to emulate a stalled server. */
  function waitForAbort(signal) {
    return new Promise((_, reject) => {
      if (!signal) return; // hangs forever on purpose
      if (signal.aborted) return reject(new AbortError('aborted'));
      signal.addEventListener('abort', () => reject(new AbortError('aborted')), { once: true });
    });
  }

  // Scripted mode: conn.mockScript = [{ toolCalls:[{name,arguments}] } | { text:'...' }]
  // consumed one entry per loop step, so the full Agent Loop can be tested offline.
  let scriptIndex = 0;
  /** Every streamResponse invocation, for assertions in tests. */
  const calls = [];

  async function streamResponse(opts) {
    const { messages, tools, onChunk, onToolCall, signal } = opts;
    if (signal && signal.aborted) throw new AbortError('aborted');
    // Record what the runtime asked for so model-routing tests can assert on it.
    const model = opts.model || conn.default_model || conn.model || (conn.models && conn.models[0]) || 'mock-fast';
    calls.push({ model, requested: opts.model || null, messages, tools, system: opts.system });
    if (typeof conn.onModelCall === 'function') conn.onModelCall({ model, requested: opts.model || null, messages });

    // Emulate a server that accepted the request and then went silent: the only
    // way out is a real abort. Used to prove Stop does not depend on chunks.
    if (conn.mockHang) {
      if (typeof conn.onMockHang === 'function') conn.onMockHang();
      await waitForAbort(signal);
    }

    if (Array.isArray(conn.mockScript)) {
      const step = conn.mockScript[scriptIndex] || { text: '（脚本已结束）' };
      scriptIndex++;
      // simulate network latency so abort/stop paths are actually exercised
      await new Promise(r => setTimeout(r, step.delay ?? 5));
      if (signal && signal.aborted) throw new Error('aborted');
      if (typeof conn.onMockStep === 'function') conn.onMockStep(scriptIndex, messages, tools);
      if (step.toolCalls && step.toolCalls.length) {
        const tc = step.toolCalls.map((t, i) => ({
          id: t.id || `call_mock_${scriptIndex}_${i}`,
          name: t.name,
          arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {})
        }));
        if (onToolCall) onToolCall(tc);
        return { content: step.text || '', toolCalls: tc, usage: { total_tokens: 8 }, model, responseModel: model };
      }
      const txt = step.text || '';
      if (txt && onChunk) onChunk(txt);
      return { content: txt, toolCalls: null, usage: { total_tokens: txt.length }, model, responseModel: model };
    }

    if (conn.mockToolCall && tools && tools.length) {
      const tc = [{ id: 'call_mock_1', name: tools[0].name, arguments: JSON.stringify(conn.mockArgs || {}) }];
      if (onToolCall) onToolCall(tc);
      return { content: '', toolCalls: tc, usage: { total_tokens: 5 }, model, responseModel: model };
    }
    const text = conn.mockText || '这是来自 Mock Provider 的回复，用于本地协议测试。';
    const parts = text.match(/.{1,6}/g) || [text];
    for (const p of parts) {
      if (signal && signal.aborted) throw new Error('aborted');
      if (onChunk) onChunk(p);
      await new Promise(r => setTimeout(r, 5));
    }
    return { content: text, toolCalls: null, usage: { total_tokens: text.length }, model, responseModel: model };
  }
  return { protocol: 'mock', endpoint: 'mock://chat', supportsVision: true, testConnection, listModels, listModelsDetailed, streamResponse, calls };
}

module.exports = { createMock };
