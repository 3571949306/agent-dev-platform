const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

// Default API connections (used by first-run seed AND by the upgrade migration)
function defaultConnections() {
  const t = now();
  const connOpenAI = {
    id: uuid(), name: 'OpenAI', provider: 'openai',
    base_url: 'https://api.openai.com/v1', api_key: '',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'], tested: false, tested_at: null,
    created_at: t, updated_at: t
  };
  const connOllama = {
    id: uuid(), name: '本地 Ollama', provider: 'local',
    base_url: 'http://localhost:11434/v1', api_key: '',
    models: ['qwen2.5:7b', 'llama3.1:8b'], tested: false, tested_at: null,
    created_at: t, updated_at: t
  };
  return { list: [connOpenAI, connOllama], openaiId: connOpenAI.id };
}

// Seed data — first-run examples so the platform isn't empty
function seedData() {
  const t = now();
  const { list: connList, openaiId } = defaultConnections();

  return {
    api_connections: connList,
    prompts: [
      {
        id: uuid(), name: '通用助手', version: 1,
        content: '你是一个乐于助人的AI助手。请用清晰、准确的方式回答用户的问题。如果不确定，请如实告知。',
        description: '基础系统提示词，适用于日常问答场景',
        tags: ['通用', '日常'], tested: false,
        created_at: t, updated_at: t
      },
      {
        id: uuid(), name: '代码审查专家', version: 2,
        content: '你是一个资深代码审查专家。请对用户提交的代码进行以下维度的审查：\n1. 代码规范与可读性\n2. 潜在 Bug 与边界情况\n3. 性能问题\n4. 安全风险\n\n请给出具体的改进建议和代码示例。',
        description: '用于代码审查场景，支持多维度分析',
        tags: ['编程', '审查'],
        tested: true,
        created_at: t, updated_at: t
      },
      {
        id: uuid(), name: '产品需求分析', version: 1,
        content: '你是一个产品经理助手。请帮用户将模糊的需求描述转化为结构化的产品需求文档，包含：背景、目标、用户故事、验收标准、优先级。',
        description: '将需求描述转化为 PRD',
        tags: ['产品', '文档'],
        tested: false,
        created_at: t, updated_at: t
      }
    ],
    agents: (() => {
      const aGeneral = {
        id: uuid(), name: '通用助手', description: '日常问答 Agent',
        api_connection_id: openaiId, model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 2000,
        system_prompt_id: null, tool_ids: [], is_main: false, sub_agent_ids: [],
        created_at: t, updated_at: t
      };
      const aReviewer = {
        id: uuid(), name: '代码审查员', description: '专注代码审查，低温度保证稳定性',
        api_connection_id: openaiId, model: 'gpt-4o', temperature: 0.3, max_tokens: 4000,
        system_prompt_id: null, tool_ids: [], is_main: false, sub_agent_ids: [],
        created_at: t, updated_at: t
      };
      const aMain = {
        id: uuid(), name: '主调度 Agent', description: '协调各专用 Agent 完成复杂任务。当用户需要多领域协作时，调用对应的子 Agent。',
        api_connection_id: openaiId, model: 'gpt-4o', temperature: 0.5, max_tokens: 4000,
        system_prompt_id: null, tool_ids: [], is_main: true,
        sub_agent_ids: [aGeneral.id, aReviewer.id],
        created_at: t, updated_at: t
      };
      return [aMain, aGeneral, aReviewer];
    })(),
    tools: [
      {
        id: uuid(), name: '代码分析器', description: '分析代码质量，返回问题列表',
        type: 'mock',
        parameters: { type: 'object', properties: { code: { type: 'string', description: '要分析的代码' }, language: { type: 'string', description: '编程语言' } }, required: ['code'] },
        mock_response: '{"issues": 3, "severity": "medium", "details": ["未处理空指针异常", "循环复杂度过高", "缺少输入验证"]}',
        webhook_url: '',
        created_at: t, updated_at: t
      },
      {
        id: uuid(), name: '网络搜索', description: '搜索互联网获取最新信息',
        type: 'mock',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
        mock_response: '{"results": ["相关结果1", "相关结果2"], "source": "mock"}',
        webhook_url: '',
        created_at: t, updated_at: t
      }
    ],
    conversations: [],
    messages: [],
    settings: {
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini'
    }
  };
}

// Load or initialize data
let data;
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  data = JSON.parse(raw);
  // Backfill missing collections for backward compatibility
  if (!data.api_connections) data.api_connections = [];
  if (!data.agents) data.agents = [];
  data.agents.forEach(a => {
    if (a.is_main === undefined) a.is_main = false;
    if (!a.sub_agent_ids) a.sub_agent_ids = [];
    if (!a.api_connection_id) a.api_connection_id = null;
  });
  // Upgrade migration: builds from before Phase 4 have no API connections at all.
  // Seed the default OpenAI / Ollama connections once and bind any unbound agents.
  if (data.api_connections.length === 0 && !data.settings._seededConnections) {
    const { list: conns, openaiId } = defaultConnections();
    data.api_connections.push(...conns);
    data.agents.forEach(a => { if (!a.api_connection_id) a.api_connection_id = openaiId; });
    data.settings._seededConnections = true;
    save();
  }
} catch {
  data = seedData();
  save();
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---- API Connections ----
const api_connections = {
  list: () => data.api_connections,
  get: (id) => data.api_connections.find(c => c.id === id),
  create: (body) => {
    const t = now();
    const item = {
      id: uuid(), name: body.name || '新连接', provider: body.provider || 'openai',
      base_url: body.base_url || 'https://api.openai.com/v1', api_key: body.api_key || '',
      models: body.models || [], tested: false, tested_at: null,
      created_at: t, updated_at: t
    };
    data.api_connections.push(item); save();
    return item;
  },
  update: (id, body) => {
    const item = data.api_connections.find(c => c.id === id);
    if (!item) return null;
    for (const k of ['name','provider','base_url','api_key','models','tested','tested_at']) {
      if (body[k] !== undefined) item[k] = body[k];
    }
    item.updated_at = now(); save();
    return item;
  },
  remove: (id) => {
    const i = data.api_connections.findIndex(c => c.id === id);
    if (i === -1) return false;
    data.api_connections.splice(i, 1); save();
    return true;
  }
};

// ---- Prompts ----
const prompts = {
  list: () => data.prompts,
  get: (id) => data.prompts.find(p => p.id === id),
  create: (body) => {
    const t = now();
    const item = {
      id: uuid(), name: body.name || '未命名', version: 1,
      content: body.content || '', description: body.description || '',
      tags: body.tags || [], tested: false,
      created_at: t, updated_at: t
    };
    data.prompts.push(item); save();
    return item;
  },
  update: (id, body) => {
    const item = data.prompts.find(p => p.id === id);
    if (!item) return null;
    if (body.name !== undefined) item.name = body.name;
    if (body.content !== undefined) { item.content = body.content; item.version = (item.version || 1) + 1; }
    if (body.description !== undefined) item.description = body.description;
    if (body.tags !== undefined) item.tags = body.tags;
    if (body.tested !== undefined) item.tested = body.tested;
    item.updated_at = now(); save();
    return item;
  },
  remove: (id) => {
    const i = data.prompts.findIndex(p => p.id === id);
    if (i === -1) return false;
    data.prompts.splice(i, 1); save();
    return true;
  }
};

// ---- Agents ----
const agents = {
  list: () => data.agents,
  get: (id) => data.agents.find(a => a.id === id),
  create: (body) => {
    const t = now();
    const item = {
      id: uuid(), name: body.name || '新 Agent',
      description: body.description || '',
      api_connection_id: body.api_connection_id || null,
      model: body.model || data.settings.defaultModel,
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens ?? 2000,
      system_prompt_id: body.system_prompt_id || null,
      tool_ids: body.tool_ids || [],
      is_main: !!body.is_main,
      sub_agent_ids: body.sub_agent_ids || [],
      created_at: t, updated_at: t
    };
    data.agents.push(item); save();
    return item;
  },
  update: (id, body) => {
    const item = data.agents.find(a => a.id === id);
    if (!item) return null;
    for (const k of ['name','description','api_connection_id','model','temperature','max_tokens','system_prompt_id','tool_ids','is_main','sub_agent_ids']) {
      if (body[k] !== undefined) item[k] = body[k];
    }
    item.updated_at = now(); save();
    return item;
  },
  remove: (id) => {
    const i = data.agents.findIndex(a => a.id === id);
    if (i === -1) return false;
    data.agents.splice(i, 1); save();
    return true;
  }
};

// ---- Tools ----
const tools = {
  list: () => data.tools,
  get: (id) => data.tools.find(t => t.id === id),
  create: (body) => {
    const t = now();
    const item = {
      id: uuid(), name: body.name || '新工具',
      description: body.description || '',
      type: body.type || 'mock',
      parameters: body.parameters || { type: 'object', properties: {} },
      mock_response: body.mock_response || '{}',
      webhook_url: body.webhook_url || '',
      created_at: t, updated_at: t
    };
    data.tools.push(item); save();
    return item;
  },
  update: (id, body) => {
    const item = data.tools.find(t => t.id === id);
    if (!item) return null;
    for (const k of ['name','description','type','parameters','mock_response','webhook_url']) {
      if (body[k] !== undefined) item[k] = body[k];
    }
    item.updated_at = now(); save();
    return item;
  },
  remove: (id) => {
    const i = data.tools.findIndex(t => t.id === id);
    if (i === -1) return false;
    data.tools.splice(i, 1); save();
    return true;
  }
};

// ---- Conversations ----
const conversations = {
  list: () => data.conversations,
  get: (id) => data.conversations.find(c => c.id === id),
  create: (body) => {
    const t = now();
    const item = {
      id: uuid(), agent_id: body.agent_id || null,
      title: body.title || '新对话',
      created_at: t, updated_at: t
    };
    data.conversations.push(item); save();
    return item;
  },
  update: (id, body) => {
    const item = data.conversations.find(c => c.id === id);
    if (!item) return null;
    if (body.title !== undefined) item.title = body.title;
    if (body.agent_id !== undefined) item.agent_id = body.agent_id;
    item.updated_at = now(); save();
    return item;
  },
  remove: (id) => {
    const i = data.conversations.findIndex(c => c.id === id);
    if (i === -1) return false;
    data.conversations.splice(i, 1);
    data.messages = data.messages.filter(m => m.conversation_id !== id);
    save();
    return true;
  }
};

// ---- Messages ----
const messages = {
  list: (conversationId) => data.messages.filter(m => m.conversation_id === conversationId),
  create: (body) => {
    const item = {
      id: uuid(), conversation_id: body.conversation_id,
      role: body.role, content: body.content || '',
      tool_calls: body.tool_calls || null,
      tool_call_id: body.tool_call_id || null,
      rating: body.rating || null,
      model: body.model || null,
      tokens: body.tokens || null,
      created_at: now()
    };
    data.messages.push(item); save();
    const conv = data.conversations.find(c => c.id === body.conversation_id);
    if (conv) { conv.updated_at = now(); save(); }
    return item;
  },
  update: (id, body) => {
    const item = data.messages.find(m => m.id === id);
    if (!item) return null;
    if (body.rating !== undefined) item.rating = body.rating;
    if (body.content !== undefined) item.content = body.content;
    save();
    return item;
  },
  getUnrated: () => data.messages.filter(m => m.role === 'assistant' && !m.rating)
};

// ---- Settings ----
const settings = {
  get: () => data.settings,
  update: (body) => {
    Object.assign(data.settings, body);
    save();
    return data.settings;
  }
};

// ---- Dashboard ----
const dashboard = {
  stats: () => {
    const convs = data.conversations;
    const msgs = data.messages;
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    const ratedMsgs = assistantMsgs.filter(m => m.rating);
    const avgRating = ratedMsgs.length
      ? (ratedMsgs.reduce((s, m) => s + m.rating, 0) / ratedMsgs.length).toFixed(1)
      : '—';
    return {
      prompts: data.prompts.length,
      agents: data.agents.length,
      tools: data.tools.length,
      connections: data.api_connections.length,
      mainAgents: data.agents.filter(a => a.is_main).length,
      conversations: convs.length,
      messages: msgs.length,
      unrated: assistantMsgs.filter(m => !m.rating).length,
      avgRating,
      agentsWithoutConn: data.agents.filter(a => !a.api_connection_id || !api_connections.get(a.api_connection_id)).length,
      untestedPrompts: data.prompts.filter(p => !p.tested).length,
      untestedConns: data.api_connections.filter(c => !c.tested).length
    };
  },
  todo: () => {
    const items = [];
    data.agents.forEach(a => {
      if (!a.api_connection_id || !api_connections.get(a.api_connection_id)) {
        items.push({ type: 'agent_conn', id: a.id, label: `Agent「${a.name}」未绑定 API 连接`, priority: 'high' });
      }
    });
    data.api_connections.forEach(c => {
      if (!c.tested) items.push({ type: 'conn_test', id: c.id, label: `API 连接「${c.name}」未测试`, priority: 'medium' });
    });
    data.prompts.forEach(p => {
      if (!p.tested) items.push({ type: 'prompt_test', id: p.id, label: `Prompt「${p.name}」尚未测试`, priority: 'medium' });
    });
    const unrated = data.messages.filter(m => m.role === 'assistant' && !m.rating);
    if (unrated.length > 0) {
      items.push({ type: 'unrated', id: null, label: `${unrated.length} 条助手回复待评分`, priority: 'low' });
    }
    return items;
  }
};

// ---- Backup ----
const backup = {
  export: () => data,
  import: (imported) => {
    data = imported;
    // Backfill for safety
    if (!data.api_connections) data.api_connections = [];
    save();
    return true;
  }
};

module.exports = {
  api_connections, prompts, agents, tools, conversations, messages, settings, dashboard, backup
};
