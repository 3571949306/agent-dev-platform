'use strict';
/**
 * Provider registry. Maps an API connection (with decrypted api_key) to a
 * protocol-specific provider implementing: testConnection / listModels / streamResponse.
 *
 * v2.1.0 — model routing is explicit. `streamResponse` MUST be given the model
 * the Agent selected; providers are no longer allowed to silently substitute
 * `conn.models[0]`. `resolveModel()` is the single place where any fallback may
 * happen, and it always reports what it did so the UI/telemetry can show it.
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

/** Last-resort default per protocol; only used when nothing else is configured. */
const PROTOCOL_DEFAULT_MODEL = {
  anthropic: 'claude-3-5-sonnet-latest',
  ollama: 'qwen2.5:7b',
  mock: 'mock-fast'
};

/**
 * Decide which model id actually goes on the wire.
 *
 * Priority: explicit override → agent.model → connection.default_model →
 *           connection.models[0] → protocol default.
 *
 * @returns {{requested:string|null, model:string|null, source:string, fellBack:boolean}}
 */
function resolveModel({ agent, conn, override } = {}) {
  const requested = (override || (agent && agent.model) || '').trim() || null;
  if (requested) return { requested, model: requested, source: 'agent', fellBack: false };

  const connDefault = conn && (conn.default_model || conn.model);
  if (connDefault) return { requested: null, model: connDefault, source: 'connection.default_model', fellBack: true };

  const first = conn && Array.isArray(conn.models) && conn.models[0];
  if (first) return { requested: null, model: first, source: 'connection.models[0]', fellBack: true };

  const proto = conn && (PROTOCOL_DEFAULT_MODEL[conn.provider] || null);
  if (proto) return { requested: null, model: proto, source: 'protocol.default', fellBack: true };

  return { requested: null, model: null, source: 'none', fellBack: true };
}

/**
 * Capability record. `state` distinguishes what we actually know:
 *   declared — the vendor documents it
 *   tested   — we probed the live endpoint and it worked
 *   inferred — guessed from the model id
 *   unknown  — we genuinely do not know
 */
function cap(value, state) { return { value, state }; }

/** Build a capability note from a model id (conservative: unknown unless known). */
function guessCapabilities(modelId) {
  const id = (modelId || '').toLowerCase();
  const caps = { text: true, streaming: true, tools: true, vision: false, reasoning: false, json_schema: false, computer_use: false, context_window: null, max_output: null };
  if (/gpt-4o|gpt-4-turbo|claude|gemini|qwen-vl|llava|vision/.test(id)) caps.vision = /vision|vl|llava/.test(id) || /gpt-4o/.test(id);
  if (/o1|o3|reasoning|deepseek-r1/.test(id)) caps.reasoning = true;
  if (/claude-3-|gpt-4o/.test(id)) caps.json_schema = true;
  return caps;
}

/** Known-vision model families. Used for the `inferred` capability state. */
const VISION_PATTERNS = [
  /gpt-4o/, /gpt-4\.1/, /gpt-4-turbo/, /gpt-5/, /o3/, /o4-mini/,
  /claude-3/, /claude-sonnet-4/, /claude-opus-4/, /claude-haiku-4/,
  /gemini/, /qwen[\d.]*-?vl/, /qwen2\.5vl/, /llava/, /llama3\.2-vision/,
  /minicpm-v/, /internvl/, /pixtral/, /-vision/, /moondream/
];

function inferVision(modelId) {
  const id = (modelId || '').toLowerCase();
  if (!id) return cap(false, 'unknown');
  return VISION_PATTERNS.some(re => re.test(id)) ? cap(true, 'inferred') : cap(false, 'inferred');
}

/**
 * Structured capability report for a (connection, model) pair, before any live probe.
 * `detectCapabilities` in ./capabilities.js upgrades entries to state='tested'.
 */
function describeCapabilities(conn, modelId) {
  const protocol = conn ? conn.provider : null;
  const g = guessCapabilities(modelId);
  return {
    model: modelId || null,
    protocol,
    text: cap(true, 'declared'),
    streaming: cap(true, protocol === 'anthropic' || protocol === 'openai' || protocol === 'ollama' ? 'declared' : 'unknown'),
    tools: cap(g.tools, 'inferred'),
    vision: inferVision(modelId),
    reasoning: cap(g.reasoning, 'inferred'),
    json_schema: cap(g.json_schema, 'inferred')
  };
}

module.exports = { getProvider, guessCapabilities, resolveModel, describeCapabilities, inferVision, PROTOCOL_DEFAULT_MODEL };
