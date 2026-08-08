const express = require('express');
const path = require('path');
const { prompts, agents, tools, conversations, messages, settings, dashboard, backup, api_connections } = require('./store');
const { streamChat, executeTool, testConnection, fetchModels } = require('./llm');

const app = express();
const PORT = parseInt(process.env.PORT) || 3456;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Dashboard ----
app.get('/api/dashboard', (req, res) => {
  res.json({ stats: dashboard.stats(), todo: dashboard.todo() });
});

// ---- API Connections ----
app.get('/api/connections', (req, res) => res.json(api_connections.list()));
app.post('/api/connections', (req, res) => res.json(api_connections.create(req.body)));
app.get('/api/connections/:id', (req, res) => {
  const item = api_connections.get(req.params.id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.put('/api/connections/:id', (req, res) => {
  const item = api_connections.update(req.params.id, req.body);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.delete('/api/connections/:id', (req, res) => {
  res.json({ success: api_connections.remove(req.params.id) });
});

// Connection test — CCswitch style (minimal request, status interpretation)
app.post('/api/connections/:id/test', async (req, res) => {
  const conn = api_connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: '连接不存在' });
  try {
    const result = await testConnection(conn);
    api_connections.update(req.params.id, {
      tested: result.ok,
      tested_at: result.ok ? new Date().toISOString() : conn.tested_at
    });
    res.json(result);
  } catch (e) {
    res.json({ ok: false, status: 0, message: e.message });
  }
});

// Fetch model list — CCswitch style (GET /v1/models)
app.post('/api/connections/:id/models', async (req, res) => {
  const conn = api_connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: '连接不存在' });
  try {
    const list = await fetchModels(conn);
    api_connections.update(req.params.id, { models: list });
    res.json({ models: list });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Prompts ----
app.get('/api/prompts', (req, res) => res.json(prompts.list()));
app.post('/api/prompts', (req, res) => res.json(prompts.create(req.body)));
app.get('/api/prompts/:id', (req, res) => {
  const item = prompts.get(req.params.id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.put('/api/prompts/:id', (req, res) => {
  const item = prompts.update(req.params.id, req.body);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.delete('/api/prompts/:id', (req, res) => {
  res.json({ success: prompts.remove(req.params.id) });
});

// ---- Agents ----
app.get('/api/agents', (req, res) => res.json(agents.list()));
app.post('/api/agents', (req, res) => res.json(agents.create(req.body)));
app.get('/api/agents/:id', (req, res) => {
  const item = agents.get(req.params.id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.put('/api/agents/:id', (req, res) => {
  const item = agents.update(req.params.id, req.body);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.delete('/api/agents/:id', (req, res) => {
  res.json({ success: agents.remove(req.params.id) });
});

// ---- Tools ----
app.get('/api/tools', (req, res) => res.json(tools.list()));
app.post('/api/tools', (req, res) => res.json(tools.create(req.body)));
app.get('/api/tools/:id', (req, res) => {
  const item = tools.get(req.params.id);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.put('/api/tools/:id', (req, res) => {
  const item = tools.update(req.params.id, req.body);
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});
app.delete('/api/tools/:id', (req, res) => {
  res.json({ success: tools.remove(req.params.id) });
});

// ---- Conversations ----
app.get('/api/conversations', (req, res) => res.json(conversations.list()));
app.post('/api/conversations', (req, res) => res.json(conversations.create(req.body)));
app.get('/api/conversations/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: '未找到' });
  const msgs = messages.list(req.params.id);
  res.json({ ...conv, messages: msgs });
});
app.delete('/api/conversations/:id', (req, res) => {
  res.json({ success: conversations.remove(req.params.id) });
});

// ---- Messages ----
app.get('/api/conversations/:id/messages', (req, res) => {
  res.json(messages.list(req.params.id));
});
app.put('/api/messages/:id/rating', (req, res) => {
  const item = messages.update(req.params.id, { rating: req.body.rating });
  if (!item) return res.status(404).json({ error: '未找到' });
  res.json(item);
});

// ---- Helpers ----
function parseTaskArg(argsStr) {
  try {
    const o = JSON.parse(argsStr || '{}');
    return o.task || argsStr || '';
  } catch {
    return argsStr || '';
  }
}

// Run a sub-agent to completion, returning its final text.
// Sub-agents may use their own (non-sub) tools but cannot spawn further sub-agents.
async function callSubAgent(subAgent, task) {
  const conn = api_connections.get(subAgent.api_connection_id);
  if (!conn) throw new Error(`子 Agent「${subAgent.name}」未绑定 API 连接`);

  const msgs = [];
  if (subAgent.system_prompt_id) {
    const sp = prompts.get(subAgent.system_prompt_id);
    if (sp) msgs.push({ role: 'system', content: sp.content });
  } else if (subAgent.description) {
    msgs.push({ role: 'system', content: subAgent.description });
  }
  msgs.push({ role: 'user', content: task });

  const subTools = (subAgent.tool_ids || [])
    .map(id => tools.get(id))
    .filter(Boolean)
    .filter(t => t.type === 'mock' || t.type === 'webhook');

  let content = '';
  let loop = 0;
  while (loop < 3) {
    loop++;
    const r = await streamChat({
      baseUrl: conn.base_url,
      apiKey: conn.api_key,
      provider: conn.provider,
      model: subAgent.model,
      messages: msgs,
      temperature: subAgent.temperature,
      maxTokens: subAgent.max_tokens,
      tools: subTools.length ? subTools : undefined
    });
    content = r.content || '';
    if (!r.toolCalls || !r.toolCalls.length) break;

    msgs.push({
      role: 'assistant',
      content: r.content || null,
      tool_calls: r.toolCalls.map(tc => ({
        id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments }
      }))
    });
    for (const tc of r.toolCalls) {
      const tool = subTools.find(t => t.name === tc.name);
      if (tool) {
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch {}
        const tr = await executeTool(tool, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: tr });
      }
    }
  }
  return content || '(子 Agent 未返回内容)';
}

// ---- Chat (Streaming + Agent-as-Tool orchestration) ----
app.post('/api/chat', async (req, res) => {
  const { agent_id, conversation_id, message } = req.body;

  const agent = agents.get(agent_id);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });

  const conn = api_connections.get(agent.api_connection_id);
  if (!conn) {
    return res.status(400).json({ error: `Agent「${agent.name}」未绑定 API 连接，请先到「API 连接」中绑定` });
  }

  let convId = conversation_id;
  if (!convId) {
    const conv = conversations.create({ agent_id, title: (message || '').slice(0, 30) || '新对话' });
    convId = conv.id;
  }
  if (message) messages.create({ conversation_id: convId, role: 'user', content: message });

  const history = messages.list(convId);
  const llmMessages = [];

  if (agent.system_prompt_id) {
    const sp = prompts.get(agent.system_prompt_id);
    if (sp) llmMessages.push({ role: 'system', content: sp.content });
  } else if (agent.description) {
    llmMessages.push({ role: 'system', content: agent.description });
  }

  const recentHistory = history.slice(-20);
  for (const m of recentHistory) {
    if (m.role === 'user' || m.role === 'assistant') {
      llmMessages.push({ role: m.role, content: m.content });
    }
  }

  // Build tool definitions: this agent's own tools + sub-agents as callable tools
  const agentToolDefs = (agent.tool_ids || []).map(id => tools.get(id)).filter(Boolean);
  const subAgentDefs = (agent.sub_agent_ids || [])
    .map(id => agents.get(id))
    .filter(a => a && a.id !== agent.id);

  const allTools = [...agentToolDefs];
  subAgentDefs.forEach(sa => {
    allTools.push({
      name: 'subagent_' + sa.id.replace(/-/g, '_'),
      description: `调用子 Agent「${sa.name}」：${sa.description || '专用 Agent'}。把要交给它处理的具体任务描述传给它，它会返回处理结果。`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: `交给「${sa.name}」的具体任务或问题` }
        },
        required: ['task']
      },
      _isSubAgent: true,
      _subAgentId: sa.id
    });
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  send({ type: 'conversation', conversation_id: convId });

  try {
    let totalContent = '';
    let totalToolCalls = null;
    let usage = null;
    let loopCount = 0;
    const maxLoops = 5;

    while (loopCount < maxLoops) {
      loopCount++;

      const result = await streamChat({
        baseUrl: conn.base_url,
        apiKey: conn.api_key,
        provider: conn.provider,
        model: agent.model,
        messages: llmMessages,
        temperature: agent.temperature,
        maxTokens: agent.max_tokens,
        tools: allTools.length > 0 ? allTools : undefined
      },
      (chunk) => {
        totalContent += chunk;
        send({ type: 'chunk', content: chunk });
      },
      (toolCalls) => {
        totalToolCalls = toolCalls;
      });

      usage = result.usage;

      if (!result.toolCalls || result.toolCalls.length === 0) {
        break;
      }

      send({ type: 'tool_calls', tool_calls: result.toolCalls });

      llmMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });

      for (const tc of result.toolCalls) {
        const def = allTools.find(t => t.name === tc.name);
        if (def && def._isSubAgent) {
          const sub = agents.get(def._subAgentId);
          if (sub) {
            send({ type: 'subagent_start', agent_id: sub.id, name: sub.name });
            let subResult;
            try {
              subResult = await callSubAgent(sub, parseTaskArg(tc.arguments));
            } catch (e) {
              subResult = '子 Agent 调用失败：' + e.message;
            }
            send({ type: 'subagent_result', agent_id: sub.id, name: sub.name, result: subResult });
            llmMessages.push({ role: 'tool', tool_call_id: tc.id, content: subResult });
          }
        } else {
          const tool = agentToolDefs.find(t => t.name === tc.name);
          if (tool) {
            let args = {};
            try { args = JSON.parse(tc.arguments || '{}'); } catch {}
            send({ type: 'tool_executing', name: tc.name, args });
            const toolResult = await executeTool(tool, args);
            send({ type: 'tool_result', name: tc.name, result: toolResult });
            llmMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
          }
        }
      }

      totalContent = '';
      totalToolCalls = null;
    }

    const finalContent = totalContent || '';

    const msg = messages.create({
      conversation_id: convId,
      role: 'assistant',
      content: finalContent,
      tool_calls: totalToolCalls,
      model: agent.model,
      tokens: usage?.total_tokens || null
    });

    if (agent.system_prompt_id) {
      prompts.update(agent.system_prompt_id, { tested: true });
    }

    send({ type: 'done', message_id: msg.id, tokens: usage?.total_tokens || 0, model: agent.model });

  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ---- Settings ----
app.get('/api/settings', (req, res) => res.json(settings.get()));
app.put('/api/settings', (req, res) => res.json(settings.update(req.body)));

// ---- Backup ----
app.get('/api/backup', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="agent-platform-backup.json"');
  res.json(backup.export());
});
app.post('/api/backup', (req, res) => {
  backup.import(req.body);
  res.json({ success: true });
});

// ---- SPA fallback ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start Server ----
function start(preferredPort) {
  const p = preferredPort || PORT;
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(p, () => {
      console.log(`\n  Agent Dev Platform running at http://localhost:${p}\n`);
      resolve({ server: httpServer, port: p });
    });
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && p < 3500) {
        httpServer.close();
        start(p + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

// Auto-start when run directly (not inside Electron)
if (!process.versions.electron) {
  start();
}

module.exports = { app, start };
