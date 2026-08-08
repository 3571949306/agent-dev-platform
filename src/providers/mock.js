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
function createMock(conn) {
  async function testConnection() { return { ok: true, status: 200, message: 'Mock 连接成功（本地测试）', latency: 1 }; }
  async function listModels() { return ['mock-fast', 'mock-reason']; }

  // Scripted mode: conn.mockScript = [{ toolCalls:[{name,arguments}] } | { text:'...' }]
  // consumed one entry per loop step, so the full Agent Loop can be tested offline.
  let scriptIndex = 0;

  async function streamResponse({ messages, tools, onChunk, onToolCall, signal }) {
    if (signal && signal.aborted) throw new Error('aborted');

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
        return { content: step.text || '', toolCalls: tc, usage: { total_tokens: 8 } };
      }
      const txt = step.text || '';
      if (txt && onChunk) onChunk(txt);
      return { content: txt, toolCalls: null, usage: { total_tokens: txt.length } };
    }

    if (conn.mockToolCall && tools && tools.length) {
      const tc = [{ id: 'call_mock_1', name: tools[0].name, arguments: JSON.stringify(conn.mockArgs || {}) }];
      if (onToolCall) onToolCall(tc);
      return { content: '', toolCalls: tc, usage: { total_tokens: 5 } };
    }
    const text = conn.mockText || '这是来自 Mock Provider 的回复，用于本地协议测试。';
    const parts = text.match(/.{1,6}/g) || [text];
    for (const p of parts) {
      if (signal && signal.aborted) throw new Error('aborted');
      if (onChunk) onChunk(p);
      await new Promise(r => setTimeout(r, 5));
    }
    return { content: text, toolCalls: null, usage: { total_tokens: text.length } };
  }
  return { protocol: 'mock', testConnection, listModels, streamResponse };
}

module.exports = { createMock };
