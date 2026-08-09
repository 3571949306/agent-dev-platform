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
    'ollama': 'ollama'
  };

  const providerId = providerMap[connection.protocol] || providerMap[connection.provider] || connection.protocol;

  return {
    providerId,
    modelId: model || connection.model || '',
    apiKey: connection.apiKey || connection.key || '',
    baseUrl: connection.baseUrl || connection.endpoint || undefined,
    headers: connection.headers || undefined
  };
}

module.exports = { mapConnection };
