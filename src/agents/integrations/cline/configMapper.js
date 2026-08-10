'use strict';

/**
 * Agent Dev Platform API Connection → Cline SDK provider/model config.
 */
function mapConnection(connection, model) {
  if (!connection) return null;

  // Map provider name to Cline providerId
  const providerMap = {
    'anthropic': 'anthropic',
    'openai': 'openai',
    'openrouter': 'openrouter',
    'google': 'gemini',
    'gemini': 'gemini',
    'deepseek': 'deepseek',
    'mistral': 'mistral',
    'groq': 'groq',
    'xai': 'xai',
    'moonshot': 'moonshot',
    'bedrock': 'bedrock',
    'azure': 'azure',
    'ollama': 'ollama',
    // The platform stores generic/local OpenAI-compatible endpoints under
    // these provider names. ClineCore expects the OpenAI provider plus baseUrl.
    'local': 'openai',
    'custom': 'openai',
    'mock': 'openai',
    'openai-responses': 'openai'
  };

  const provider = connection.protocol || connection.provider || '';
  const providerId = providerMap[provider] || provider;
  const models = Array.isArray(connection.models) ? connection.models : [];
  const firstModel = models.length
    ? (typeof models[0] === 'string' ? models[0] : models[0]?.id)
    : '';

  return {
    providerId,
    modelId: model || connection.model || firstModel || '',
    apiKey: connection.apiKey || connection.api_key || connection.key || '',
    baseUrl: connection.baseUrl || connection.base_url || connection.endpoint || undefined,
    headers: connection.headers || undefined
  };
}

module.exports = { mapConnection };
