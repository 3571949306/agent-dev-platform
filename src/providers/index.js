'use strict';
/**
 * Provider registry. Maps an API connection (with decrypted api_key) to a
 * protocol-specific provider implementing: testConnection / listModels / streamResponse.
 */
const { createOpenAIChat, createOpenAIResponses } = require('./openai');
const { createAnthropic } = require('./anthropic');
const { createOllama } = require('./ollama');
const { createMock } = require('./mock');

function getProvider(conn) {
  if (!conn) throw new Error('未提供 API 连接');
  switch (conn.provider) {
    case 'openai': return createOpenAIChat(conn);
    case 'openai-responses': return createOpenAIResponses(conn);
    case 'anthropic': return createAnthropic(conn);
    case 'ollama': return createOllama(conn);
    case 'local': return createOpenAIChat(conn);     // LM Studio / Ollama-compat (/v1)
    case 'mock': return createMock(conn);
    case 'custom':
    default: return createOpenAIChat(conn);          // assume OpenAI-compatible
  }
}

/** Build a capability note from a model id (conservative: unknown unless known). */
function guessCapabilities(modelId) {
  const id = (modelId || '').toLowerCase();
  const caps = { text: true, streaming: true, tools: true, vision: false, reasoning: false, json_schema: false, computer_use: false, context_window: null, max_output: null };
  if (/gpt-4o|gpt-4-turbo|claude|gemini|qwen-vl|llava|vision/.test(id)) caps.vision = /vision|vl|llava/.test(id) || /gpt-4o/.test(id);
  if (/o1|o3|reasoning|deepseek-r1/.test(id)) caps.reasoning = true;
  if (/claude-3-|gpt-4o/.test(id)) caps.json_schema = true;
  return caps;
}

module.exports = { getProvider, guessCapabilities };
