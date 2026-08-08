/**
 * LLM Client — OpenAI-compatible API
 * Supports: streaming, function/tool calling, multi-turn conversations
 * Plus: connection testing + model-list discovery (CCswitch-style)
 */

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * `provider` may be 'local' (Ollama / LM Studio / llama.cpp) which usually
 * needs no API key — in that case the Authorization header is omitted.
 */
async function streamChat(params, onChunk, onToolCall) {
  const { baseUrl, apiKey, model, messages, temperature, maxTokens, tools, provider } = params;

  if (!baseUrl) throw new Error('未配置 API 地址，请先绑定 API 连接');

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body = {
    model,
    messages,
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 2000,
    stream: true
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  const headers = { 'Content-Type': 'application/json' };
  // Local providers (Ollama/LM Studio/llama.cpp) typically need no key.
  if (apiKey && String(apiKey).trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
  } catch (e) {
    throw new Error(`无法连接 API: ${e.message}`);
  }

  if (!response.ok) {
    let errMsg = `API 返回 ${response.status}`;
    try {
      const errBody = await response.json();
      errMsg = errBody.error?.message || errMsg;
    } catch {}
    if (response.status === 401) errMsg = 'API Key 无效或已过期 (401)';
    if (response.status === 429) errMsg = '请求过于频繁，请稍后重试 (429)';
    if (response.status === 404) errMsg = `模型 "${model}" 不存在或无权访问 (404)`;
    throw new Error(errMsg);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let fullContent = '';
  let toolCallAccumulator = [];
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6);
      if (jsonStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(jsonStr);
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          if (onChunk) onChunk(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator[idx]) {
              toolCallAccumulator[idx] = { index: idx, id: tc.id || '', name: '', arguments: '' };
            }
            if (tc.id) toolCallAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
          }
        }

        if (chunk.usage) {
          usage = chunk.usage;
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  const toolCalls = toolCallAccumulator.filter(tc => tc && tc.name);
  if (toolCalls.length > 0 && onToolCall) {
    onToolCall(toolCalls);
  }

  return {
    content: fullContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage: usage
  };
}

/**
 * Connection test — CCswitch style.
 * Sends a minimal completion request (max_tokens:1) and interprets the HTTP
 * status. Local providers (Ollama/LM Studio) skip the API key when absent.
 *
 * Returns: { ok, status, message }
 */
async function testConnection(conn) {
  const base = (conn.base_url || '').replace(/\/+$/, '');
  if (!base) return { ok: false, status: 0, message: '未配置 API 地址 (base_url)' };

  const url = base + '/chat/completions';
  const body = {
    model: (conn.models && conn.models[0]) || 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false
  };

  const headers = { 'Content-Type': 'application/json' };
  if (conn.api_key && String(conn.api_key).trim() !== '' && conn.provider !== 'local') {
    headers['Authorization'] = `Bearer ${conn.api_key}`;
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    return { ok: false, status: 0, message: `无法连接: ${e.message}` };
  }

  if (resp.ok) {
    return { ok: true, status: resp.status, message: '连接成功，密钥有效' };
  }

  let message;
  switch (resp.status) {
    case 401:
    case 403: message = 'API Key 无效或权限不足'; break;
    case 404: message = '接口地址不存在，请检查 base_url 或模型名'; break;
    case 429: message = '请求过于频繁或额度不足'; break;
    default:
      if (resp.status >= 500) message = `服务端错误 (${resp.status})`;
      else message = `连接可达但请求被拒绝 (${resp.status})`;
  }
  return { ok: false, status: resp.status, message };
}

/**
 * Fetch model list — CCswitch style.
 * GET {base_url}/models returns { "data": [ { "id": "model1" }, ... ] }
 * (OpenAI format). Local providers (Ollama/LM Studio) skip the API key.
 *
 * Returns: string[] of model ids.
 */
async function fetchModels(conn) {
  const base = (conn.base_url || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址 (base_url)');

  const url = base + '/models';
  const headers = {};
  if (conn.api_key && String(conn.api_key).trim() !== '' && conn.provider !== 'local') {
    headers['Authorization'] = `Bearer ${conn.api_key}`;
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new Error(`无法连接: ${e.message}`);
  }

  if (!resp.ok) {
    let msg = `获取模型列表失败 (${resp.status})`;
    if (resp.status === 401 || resp.status === 403) msg = 'API Key 无效，无法获取模型列表';
    if (resp.status === 404) msg = '该接口不支持 /models 端点';
    throw new Error(msg);
  }

  const json = await resp.json();
  const list = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(list)) {
    throw new Error('返回数据格式不支持（期望 { data: [...] }）');
  }
  const models = list.map(m => m.id || m.name).filter(Boolean);
  return models;
}

/**
 * Execute a tool call (mock or webhook).
 */
async function executeTool(tool, args) {
  if (tool.type === 'mock') {
    let response = tool.mock_response || '{}';
    if (response.includes('{{args}}')) {
      response = response.replace('{{args}}', JSON.stringify(args));
    }
    return response;
  }

  if (tool.type === 'webhook' && tool.webhook_url) {
    try {
      const resp = await fetch(tool.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      });
      const text = await resp.text();
      return text;
    } catch (err) {
      return JSON.stringify({ error: `Webhook 调用失败: ${err.message}` });
    }
  }

  return JSON.stringify({ error: '未知工具类型或未配置' });
}

module.exports = { streamChat, testConnection, fetchModels, executeTool };
