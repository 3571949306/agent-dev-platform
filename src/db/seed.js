'use strict';
/**
 * First-run seeding: default API connections, Main Agent (+ sub agents),
 * Computer agent, external agent templates (Codex / WorkBuddy), skills.
 * Idempotent — only fills what is empty, so migration + seeding coexist safely.
 */
const fs = require('fs');
const path = require('path');

function findLegacyDataJson(userDataPath, projectDir) {
  for (const p of [path.join(userDataPath, 'data.json'), path.join(projectDir || '.', 'data.json')]) {
    if (fs.existsSync(p)) {
      try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); if (d && (d.api_connections || d.agents || d.prompts)) return p; } catch {}
    }
  }
  return null;
}

const DEFAULT_TOOLS = [
  'list_directory', 'read_file', 'read_file_range', 'create_file', 'write_file', 'move_file', 'copy_file', 'delete_file', 'file_exists', 'get_file_metadata',
  'search_files', 'search_text', 'search_symbols', 'apply_patch',
  'terminal_run', 'terminal_cancel', 'terminal_status',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_add', 'git_commit', 'checkpoint_create', 'checkpoint_restore'
];

function seedDefaults(store) {
  // connections
  if (store.connections.list().length === 0) {
    store.connections.create({ name: 'OpenAI', provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: '' });
    store.connections.create({ name: '本地 Ollama', provider: 'ollama', base_url: 'http://localhost:11434', api_key: '' });
  }
  const openai = store.connections.list().find(c => c.provider === 'openai');
  const openaiId = openai ? openai.id : null;

  // prompts
  if (store.prompts.list().length === 0) {
    store.prompts.create({ name: '通用助手', content: '你是一个乐于助人的本地 AI 编程助手。', description: '基础系统提示词', tags: ['通用'] });
  }

  // agents
  if (store.agents.listNative().length === 0) {
    const reviewer = store.agents.create({
      name: '代码审查员', description: '专注代码审查，低温度保证稳定性', type: 'native',
      api_connection_id: openaiId, model: 'gpt-4o', temperature: 0.3, max_tokens: 4096,
      tools: ['read_file', 'search_text', 'search_symbols', 'list_directory'], is_main: false, sub_agent_ids: []
    });
    const computer = store.agents.create({
      name: 'Computer 操作员', description: '控制浏览器与 Windows 桌面完成 GUI 操作', type: 'computer',
      api_connection_id: openaiId, model: 'gpt-4o', tools: DEFAULT_TOOLS, is_main: false, sub_agent_ids: []
    });
    store.agents.create({
      name: '主智能体', description: '主调度智能体：读取项目、改代码、跑命令、调子智能体，直接完成用户的自然语言任务。',
      type: 'native', api_connection_id: openaiId, model: null, temperature: 0.5, max_tokens: 4096,
      max_steps: 40, timeout_ms: 600000, is_main: true,
      tools: DEFAULT_TOOLS,
      sub_agent_ids: [reviewer.id, computer.id]
    });
  }

  // external agents (templates)
  if (store.externalAgents.list().length === 0) {
    store.externalAgents.create({ name: 'Codex', description: 'OpenAI Codex 编程智能体（官方 HTTP/CLI）', adapter_type: 'codex', config: {} });
    store.externalAgents.create({ name: 'WorkBuddy', description: '通过桌面桥接驱动已登录的 WorkBuddy 桌面应用', adapter_type: 'workbuddy', config: {} });
  }

  // skills
  if (store.skills.list().length === 0) {
    const skills = [
      { name: 'Bug Hunter', description: '定位并分析 Bug 根因', prompt: '你是 Bug 猎手。先复现问题，再定位根因，给出最小修复方案。', recommended_tools: ['search_text', 'search_symbols', 'read_file', 'terminal_run'], capability: ['debug'], permission_preset: ['filesystem.read', 'terminal.write'] },
      { name: 'Code Reviewer', description: '多维度代码审查', prompt: '你是资深审查专家，从规范、Bug、性能、安全角度审查代码。', recommended_tools: ['read_file', 'search_text'], capability: ['review'], permission_preset: ['filesystem.read'] },
      { name: 'Web Developer', description: '前端/全栈 Web 开发', prompt: '你是 Web 开发专家，熟悉 React/Vue/Node。', recommended_tools: DEFAULT_TOOLS, capability: ['coding', 'web'], permission_preset: ['filesystem.write', 'terminal.write'] },
      { name: 'Android Developer', description: 'Android / Kotlin 开发', prompt: '你是 Android 开发专家。', recommended_tools: DEFAULT_TOOLS, capability: ['coding', 'android'], permission_preset: ['filesystem.write', 'terminal.write'] },
      { name: 'Researcher', description: '资料检索与研究', prompt: '你是研究助手，善于检索与归纳。', recommended_tools: ['search_text', 'search_files'], capability: ['research'], permission_preset: ['filesystem.read'] },
      { name: 'Computer Operator', description: '桌面 / 浏览器自动化操作', prompt: '你是电脑操作专家，优先用 API/CLI，其次浏览器 DOM，再次 UI 自动化。', recommended_tools: ['terminal_run'], capability: ['computer', 'terminal'], permission_preset: ['computer', 'browser', 'terminal.write'] }
    ];
    skills.forEach(s => store.skills.create(s));
  }

  // default settings
  if (store.settings.get('theme') === undefined) store.settings.set('theme', 'dark');
  if (store.settings.get('sendOnEnter') === undefined) store.settings.set('sendOnEnter', true);
}

module.exports = { seedDefaults, findLegacyDataJson, DEFAULT_TOOLS };
