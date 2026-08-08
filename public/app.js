/* ===== Agent Dev Platform — Frontend ===== */

// ---- State ----
const state = {
  prompts: [], agents: [], tools: [], connections: [],
  conversations: [], settings: {},
  currentConv: null,
  chatAgentId: null,
  chatStreaming: false,
  standaloneAgentId: null
};

// ---- Utils ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function showModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal').innerHTML = '';
}

$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('#modal-overlay')) closeModal();
});

// ---- API ----
const api = {
  get: (url) => fetch(url).then(r => r.json()),
  post: (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json()),
  put: (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json()),
  del: (url) => fetch(url, { method: 'DELETE' }).then(r => r.json())
};

// ---- Icons ----
const I = {
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  chat: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  box: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
  link: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  expand: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
  collapse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
};

function providerLabel(p) {
  return { openai: 'OpenAI 兼容', local: '本地', anthropic: 'Anthropic', other: '其他' }[p] || p;
}

// ---- Router ----
const routes = {
  '/': renderDashboard,
  '/prompts': renderPrompts,
  '/agents': renderAgents,
  '/tools': renderTools,
  '/connections': renderConnections,
  '/conversations': renderConversations,
  '/settings': renderSettings
};

function handleRoute() {
  const hash = location.hash.slice(1) || '/';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === hash));
  const view = routes[hash] || renderDashboard;
  view();
}

// ---- Dashboard ----
async function renderDashboard() {
  const { stats, todo } = await api.get('/api/dashboard');
  const agents = await api.get('/api/agents');
  const convs = await api.get('/api/conversations');
  const recent = convs.slice(-5).reverse();

  $('#view').innerHTML = `
    <div class="page-header"><h1>总览</h1></div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${stats.prompts}</div><div class="stat-label">Prompt</div></div>
      <div class="stat-card"><div class="stat-value">${stats.agents}</div><div class="stat-label">Agent</div></div>
      <div class="stat-card"><div class="stat-value">${stats.connections}</div><div class="stat-label">API 连接</div></div>
      <div class="stat-card"><div class="stat-value ${stats.mainAgents > 0 ? 'warning' : ''}">${stats.mainAgents}</div><div class="stat-label">主调度 Agent</div></div>
      <div class="stat-card"><div class="stat-value ${stats.agentsWithoutConn > 0 ? 'danger' : ''}">${stats.agentsWithoutConn}</div><div class="stat-label">未绑定连接</div></div>
      <div class="stat-card"><div class="stat-value">${stats.conversations}</div><div class="stat-label">对话</div></div>
      <div class="stat-card"><div class="stat-value ${stats.unrated > 0 ? 'warning' : ''}">${stats.unrated}</div><div class="stat-label">待评分</div></div>
      <div class="stat-card"><div class="stat-value">${stats.avgRating}</div><div class="stat-label">平均评分</div></div>
    </div>

    <div class="card">
      <div class="card-title">${I.warning} 待处理事项</div>
      ${todo.length === 0 ? '<p class="text-muted">暂无待处理事项</p>' :
        todo.map(t => `
          <div class="todo-item priority-${t.priority}">
            <span class="todo-label">${escapeHtml(t.label)}</span>
            <button class="btn btn-sm btn-secondary" onclick="handleTodo('${t.type}','${t.id||''}')">处理</button>
          </div>
        `).join('')
      }
    </div>

    <div class="card">
      <div class="card-title">最近对话</div>
      ${recent.length === 0 ? '<p class="text-muted">还没有对话，去 Agent 配置页测试一下吧</p>' :
        recent.map(c => {
          const agent = agents.find(a => a.id === c.agent_id);
          return `<div class="list-item selectable" onclick="location.hash='/conversations'; selectConversation('${c.id}')">
            <div class="list-item-info">
              <div class="list-item-name">${escapeHtml(c.title)}</div>
              <div class="list-item-meta">${agent ? escapeHtml(agent.name) : '未知'} · ${timeAgo(c.updated_at)}</div>
            </div>
          </div>`;
        }).join('')
      }
    </div>
  `;
}

window.handleTodo = function(type, id) {
  if (type === 'agent_conn') { location.hash = '/agents'; }
  else if (type === 'conn_test') { location.hash = '/connections'; }
  else if (type === 'prompt_test') { location.hash = '/conversations'; setTimeout(() => startNewChat(), 300); }
  else if (type === 'unrated') { location.hash = '/conversations'; }
};

// ---- Prompts ----
async function renderPrompts() {
  state.prompts = await api.get('/api/prompts');
  $('#view').innerHTML = `
    <div class="page-header">
      <h1>Prompt 管理</h1>
      <button class="btn btn-primary" onclick="showPromptModal()">${I.plus} 新建 Prompt</button>
    </div>
    <div class="list-header">
      <input class="search-input" id="prompt-search" placeholder="搜索 Prompt..." oninput="filterPrompts(this.value)">
    </div>
    <div id="prompts-list">${promptListHTML(state.prompts)}</div>
  `;
}

function promptListHTML(list) {
  if (list.length === 0) return `<div class="empty-state">${I.box}<p>还没有 Prompt，点击右上角创建</p></div>`;
  return list.map(p => `
    <div class="list-item">
      <div class="list-item-info">
        <div class="list-item-name">${escapeHtml(p.name)} <span class="text-xs text-muted">v${p.version}</span></div>
        <div class="list-item-desc">${escapeHtml(p.description || '无描述')}</div>
        <div class="list-item-meta">
          ${p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          <span class="tag ${p.tested ? 'tag-tested' : 'tag-untested'}">${p.tested ? '已测试' : '未测试'}</span>
          ${timeAgo(p.updated_at)}
        </div>
      </div>
      <div class="list-item-actions">
        <button class="btn-icon" title="编辑" onclick="showPromptModal('${p.id}')">${I.edit}</button>
        <button class="btn-icon" title="删除" onclick="deletePrompt('${p.id}')">${I.trash}</button>
      </div>
    </div>
  `).join('');
}

window.filterPrompts = function(q) {
  const filtered = state.prompts.filter(p =>
    p.name.toLowerCase().includes(q.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(q.toLowerCase()) ||
    p.tags.some(t => t.toLowerCase().includes(q.toLowerCase()))
  );
  $('#prompts-list').innerHTML = promptListHTML(filtered);
};

window.showPromptModal = async function(id) {
  const p = id ? state.prompts.find(x => x.id === id) : null;
  showModal(`
    <div class="modal-header">
      <h2>${p ? '编辑 Prompt' : '新建 Prompt'}</h2>
      <button class="modal-close" onclick="closeModal()">${I.close}</button>
    </div>
    <div class="form-group">
      <label class="form-label">名称</label>
      <input class="form-input" id="prompt-name" value="${p ? escapeHtml(p.name) : ''}" placeholder="如：代码审查专家">
    </div>
    <div class="form-group">
      <label class="form-label">描述</label>
      <input class="form-input" id="prompt-desc" value="${p ? escapeHtml(p.description) : ''}" placeholder="简要描述用途">
    </div>
    <div class="form-group">
      <label class="form-label">标签（逗号分隔）</label>
      <input class="form-input" id="prompt-tags" value="${p ? p.tags.join(', ') : ''}" placeholder="如：编程, 审查">
    </div>
    <div class="form-group">
      <label class="form-label">Prompt 内容</label>
      <textarea class="form-textarea" id="prompt-content" style="min-height:200px" placeholder="输入系统提示词...">${p ? escapeHtml(p.content) : ''}</textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="savePrompt('${id || ''}')">保存</button>
    </div>
  `);
};

window.savePrompt = async function(id) {
  const body = {
    name: $('#prompt-name').value.trim(),
    description: $('#prompt-desc').value.trim(),
    tags: $('#prompt-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    content: $('#prompt-content').value
  };
  if (!body.name) return showToast('请填写名称', 'error');
  if (id) { await api.put('/api/prompts/' + id, body); showToast('Prompt 已更新', 'success'); }
  else { await api.post('/api/prompts', body); showToast('Prompt 已创建', 'success'); }
  closeModal();
  renderPrompts();
};

window.deletePrompt = async function(id) {
  if (!confirm('确定删除此 Prompt？')) return;
  await api.del('/api/prompts/' + id);
  showToast('已删除', 'success');
  renderPrompts();
};

// ---- API Connections ----
async function renderConnections() {
  state.connections = await api.get('/api/connections');
  $('#view').innerHTML = `
    <div class="page-header">
      <h1>API 连接</h1>
      <button class="btn btn-primary" onclick="showConnectionModal()">${I.plus} 新建连接</button>
    </div>
    <p class="text-sm text-muted mb-4">统一管理 LLM 服务地址与密钥。每个 Agent 绑定一个连接，可随时测试连通性并自动拉取模型列表。本地服务（Ollama / LM Studio）通常无需密钥。</p>
    <div id="connections-list">${connectionListHTML(state.connections)}</div>
  `;
}

function connectionListHTML(list) {
  if (!list.length) return `<div class="empty-state">${I.box}<p>还没有 API 连接，点击右上角创建</p></div>`;
  return list.map(c => `
    <div class="list-item">
      <div class="list-item-info">
        <div class="list-item-name">
          ${escapeHtml(c.name)}
          <span class="tag tag-${c.provider}">${providerLabel(c.provider)}</span>
          <span class="badge ${c.tested ? 'badge-green' : 'badge-gray'}">${c.tested ? '已测试' + (c.tested_at ? ' · ' + timeAgo(c.tested_at) : '') : '未测试'}</span>
        </div>
        <div class="list-item-desc">${escapeHtml(c.base_url)}</div>
        <div class="list-item-meta">
          ${c.models && c.models.length ? `<span class="tag">${c.models.length} 个模型</span>` : '<span class="tag">无模型</span>'}
          ${c.api_key ? '<span class="tag">已配置密钥</span>' : `<span class="tag">${c.provider === 'local' ? '本地免密钥' : '未配置密钥'}</span>`}
        </div>
      </div>
      <div class="list-item-actions" style="flex-direction:column;gap:6px;align-items:flex-end">
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-secondary" onclick="testConnection('${c.id}')">${I.play} 测试</button>
          <button class="btn btn-sm btn-secondary" onclick="fetchModels('${c.id}')">${I.plus} 拉取模型</button>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-icon" title="编辑" onclick="showConnectionModal('${c.id}')">${I.edit}</button>
          <button class="btn-icon" title="删除" onclick="deleteConnection('${c.id}')">${I.trash}</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.testConnection = async function(id) {
  try {
    const r = await api.post('/api/connections/' + id + '/test', {});
    showToast(r.message, r.ok ? 'success' : 'error');
    renderConnections();
  } catch (e) {
    showToast('测试失败', 'error');
  }
};

window.fetchModels = async function(id) {
  try {
    const r = await api.post('/api/connections/' + id + '/models', {});
    showToast('已拉取 ' + (r.models ? r.models.length : 0) + ' 个模型', 'success');
    renderConnections();
  } catch (e) {
    showToast('拉取失败：' + (e.error || e.message || ''), 'error');
  }
};

window.showConnectionModal = async function(id) {
  const c = id ? state.connections.find(x => x.id === id) : null;
  const provider = c ? c.provider : 'openai';
  showModal(`
    <div class="modal-header">
      <h2>${c ? '编辑连接' : '新建连接'}</h2>
      <button class="modal-close" onclick="closeModal()">${I.close}</button>
    </div>
    <div class="form-group">
      <label class="form-label">名称</label>
      <input class="form-input" id="conn-name" value="${c ? escapeHtml(c.name) : ''}" placeholder="如：我的 OpenAI">
    </div>
    <div class="form-group">
      <label class="form-label">服务商类型</label>
      <select class="form-select" id="conn-provider" onchange="toggleConnKey()">
        <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
        <option value="local" ${provider === 'local' ? 'selected' : ''}>本地 (Ollama / LM Studio)</option>
        <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
        <option value="other" ${provider === 'other' ? 'selected' : ''}>其他</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">API Base URL</label>
      <input class="form-input" id="conn-baseurl" value="${c ? escapeHtml(c.base_url) : 'https://api.openai.com/v1'}" placeholder="https://api.openai.com/v1">
      <div class="form-hint">OpenAI 兼容服务通常以 /v1 结尾，例如 http://localhost:11434/v1</div>
    </div>
    <div class="form-group" id="conn-key-group" style="${provider === 'local' ? 'display:none' : ''}">
      <label class="form-label">API Key</label>
      <input class="form-input" id="conn-apikey" type="password" value="${c ? escapeHtml(c.api_key) : ''}" placeholder="sk-...">
      <div class="form-hint">本地服务 (Ollama / LM Studio) 通常不需要密钥</div>
    </div>
    <div class="form-group">
      <label class="form-label">模型列表（逗号分隔，可选）</label>
      <input class="form-input" id="conn-models" value="${c && c.models ? c.models.join(', ') : ''}" placeholder="gpt-4o-mini, gpt-4o">
      <div class="form-hint">留空可点击「拉取模型」自动获取（需服务支持 /models 端点）</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveConnection('${id || ''}')">保存</button>
    </div>
  `);
};

window.toggleConnKey = function() {
  const provider = $('#conn-provider').value;
  $('#conn-key-group').style.display = (provider === 'local') ? 'none' : '';
};

window.saveConnection = async function(id) {
  const provider = $('#conn-provider').value;
  const body = {
    name: $('#conn-name').value.trim(),
    provider,
    base_url: $('#conn-baseurl').value.trim(),
    api_key: provider === 'local' ? '' : $('#conn-apikey').value.trim(),
    models: $('#conn-models').value.split(',').map(s => s.trim()).filter(Boolean)
  };
  if (!body.name) return showToast('请填写名称', 'error');
  if (!body.base_url) return showToast('请填写 API 地址', 'error');
  if (id) { await api.put('/api/connections/' + id, body); showToast('连接已更新', 'success'); }
  else { await api.post('/api/connections', body); showToast('连接已创建', 'success'); }
  closeModal();
  renderConnections();
};

window.deleteConnection = async function(id) {
  if (!confirm('确定删除此连接？已绑定该连接的 Agent 将变为未绑定状态。')) return;
  await api.del('/api/connections/' + id);
  showToast('已删除', 'success');
  renderConnections();
};

// ---- Agents ----
async function renderAgents() {
  state.agents = await api.get('/api/agents');
  state.prompts = await api.get('/api/prompts');
  state.tools = await api.get('/api/tools');
  state.connections = await api.get('/api/connections');

  $('#view').innerHTML = `
    <div class="page-header">
      <h1>Agent 配置</h1>
      <button class="btn btn-primary" onclick="showAgentModal()">${I.plus} 新建 Agent</button>
    </div>
    <p class="text-sm text-muted mb-4">每个 Agent 绑定一个 API 连接。将某 Agent 设为「主调度」并勾选子 Agent，用户只需与它对话，由它来协调子 Agent 完成多步任务。</p>
    <div id="agents-list">${agentListHTML(state.agents)}</div>
  `;
}

function agentListHTML(list) {
  if (list.length === 0) return `<div class="empty-state">${I.box}<p>还没有 Agent，点击右上角创建</p></div>`;
  return list.map(a => {
    const sp = state.prompts.find(p => p.id === a.system_prompt_id);
    const conn = state.connections.find(c => c.id === a.api_connection_id);
    const toolCount = (a.tool_ids || []).length;
    const subCount = (a.sub_agent_ids || []).length;
    const bound = !!conn;
    return `
      <div class="list-item">
        <div class="list-item-info">
          <div class="list-item-name">
            ${escapeHtml(a.name)}
            ${a.is_main ? '<span class="badge badge-purple">主调度</span>' : ''}
            ${bound ? '<span class="badge badge-green">已绑定</span>' : '<span class="badge badge-red">未绑定连接</span>'}
          </div>
          <div class="list-item-desc">${escapeHtml(a.description || '无描述')}</div>
          <div class="list-item-meta">
            <span class="tag">${escapeHtml(a.model)}</span>
            ${conn ? `<span class="tag">${escapeHtml(conn.name)}</span>` : '<span class="tag">无连接</span>'}
            <span class="tag">temp: ${a.temperature}</span>
            ${sp ? `<span class="tag">Prompt: ${escapeHtml(sp.name)}</span>` : ''}
            ${toolCount > 0 ? `<span class="tag">${toolCount} 工具</span>` : ''}
            ${subCount > 0 ? `<span class="tag tag-purple">${subCount} 子Agent</span>` : ''}
          </div>
        </div>
        <div class="list-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="testAgent('${a.id}')">${I.play} 测试</button>
          <button class="btn-icon" title="编辑" onclick="showAgentModal('${a.id}')">${I.edit}</button>
          <button class="btn-icon" title="删除" onclick="deleteAgent('${a.id}')">${I.trash}</button>
        </div>
      </div>
    `;
  }).join('');
}

window.showAgentModal = async function(id) {
  const a = id ? state.agents.find(x => x.id === id) : null;
  const prompts = state.prompts;
  const allTools = state.tools;
  const connections = state.connections;
  const otherAgents = state.agents.filter(x => !id || x.id !== id);

  showModal(`
    <div class="modal-header">
      <h2>${a ? '编辑 Agent' : '新建 Agent'}</h2>
      <button class="modal-close" onclick="closeModal()">${I.close}</button>
    </div>
    <div class="form-group">
      <label class="form-label">名称</label>
      <input class="form-input" id="agent-name" value="${a ? escapeHtml(a.name) : ''}" placeholder="如：通用助手">
    </div>
    <div class="form-group">
      <label class="form-label">描述</label>
      <input class="form-input" id="agent-desc" value="${a ? escapeHtml(a.description) : ''}" placeholder="Agent 用途描述">
    </div>
    <div class="form-group">
      <label class="form-label">API 连接</label>
      <select class="form-select" id="agent-conn">
        <option value="">— 未绑定 —</option>
        ${connections.map(c => `<option value="${c.id}" ${a && a.api_connection_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.base_url)})</option>`).join('')}
      </select>
      <div class="form-hint">密钥与地址由连接统一管理。<a href="#/connections" onclick="closeModal()">去管理连接</a></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">模型</label>
        <input class="form-input" id="agent-model" value="${a ? escapeHtml(a.model) : state.settings.defaultModel || 'gpt-4o-mini'}" placeholder="gpt-4o-mini">
      </div>
      <div class="form-group">
        <label class="form-label">Temperature</label>
        <input class="form-input" id="agent-temp" type="number" step="0.1" min="0" max="2" value="${a ? a.temperature : 0.7}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Max Tokens</label>
        <input class="form-input" id="agent-maxtokens" type="number" value="${a ? a.max_tokens : 2000}">
      </div>
      <div class="form-group">
        <label class="form-label">系统提示词</label>
        <select class="form-select" id="agent-prompt">
          <option value="">— 无 —</option>
          ${prompts.map(p => `<option value="${p.id}" ${a && a.system_prompt_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">绑定工具</label>
      <div id="agent-tools-wrap" style="display:flex;flex-direction:column;gap:6px;">
        ${allTools.length === 0 ? '<span class="text-muted text-sm">暂无工具，请先在工具编排页创建</span>' :
          allTools.map(t => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" value="${t.id}" ${a && (a.tool_ids || []).includes(t.id) ? 'checked' : ''}>
              <span>${escapeHtml(t.name)}</span>
              <span class="text-muted text-xs">${escapeHtml(t.description || '')}</span>
            </label>
          `).join('')
        }
      </div>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="agent-ismain" ${a && a.is_main ? 'checked' : ''}>
        <span>作为主调度 Agent（可协调下方子 Agent）</span>
      </label>
    </div>
    <div class="form-group">
      <label class="form-label">子 Agent（主 Agent 在对话中可调用）</label>
      <div id="agent-subs-wrap" style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow:auto;">
        ${otherAgents.length === 0 ? '<span class="text-muted text-sm">暂无其他 Agent 可选作子 Agent</span>' :
          otherAgents.map(oa => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" class="agent-sub" value="${oa.id}" ${a && (a.sub_agent_ids || []).includes(oa.id) ? 'checked' : ''}>
              <span>${escapeHtml(oa.name)}</span>
              <span class="text-muted text-xs">${escapeHtml(oa.model)}</span>
            </label>
          `).join('')
        }
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveAgent('${id || ''}')">保存</button>
    </div>
  `);
};

window.saveAgent = async function(id) {
  const toolIds = [...$$('#agent-tools-wrap input:checked')].map(cb => cb.value);
  const subIds = [...$$('#agent-subs-wrap input.agent-sub:checked')].map(cb => cb.value);
  const body = {
    name: $('#agent-name').value.trim(),
    description: $('#agent-desc').value.trim(),
    api_connection_id: $('#agent-conn').value || null,
    model: $('#agent-model').value.trim(),
    temperature: parseFloat($('#agent-temp').value) || 0.7,
    max_tokens: parseInt($('#agent-maxtokens').value) || 2000,
    system_prompt_id: $('#agent-prompt').value || null,
    tool_ids: toolIds,
    is_main: !!($('#agent-ismain') && $('#agent-ismain').checked),
    sub_agent_ids: subIds
  };
  if (!body.name) return showToast('请填写名称', 'error');
  if (id) { await api.put('/api/agents/' + id, body); showToast('Agent 已更新', 'success'); }
  else { await api.post('/api/agents', body); showToast('Agent 已创建', 'success'); }
  closeModal();
  renderAgents();
};

window.deleteAgent = async function(id) {
  if (!confirm('确定删除此 Agent？关联的对话不会被删除。')) return;
  await api.del('/api/agents/' + id);
  showToast('已删除', 'success');
  renderAgents();
};

window.testAgent = function(id) {
  location.hash = '/conversations';
  state.chatAgentId = id;
  setTimeout(() => startNewChat(id), 300);
};

// ---- Tools ----
async function renderTools() {
  state.tools = await api.get('/api/tools');
  $('#view').innerHTML = `
    <div class="page-header">
      <h1>工具编排</h1>
      <button class="btn btn-primary" onclick="showToolModal()">${I.plus} 新建工具</button>
    </div>
    <div id="tools-list">${toolListHTML(state.tools)}</div>
  `;
}

function toolListHTML(list) {
  if (list.length === 0) return `<div class="empty-state">${I.box}<p>还没有工具，点击右上角创建</p></div>`;
  return list.map(t => `
    <div class="list-item">
      <div class="list-item-info">
        <div class="list-item-name">${escapeHtml(t.name)} <span class="tag tag-${t.type}">${t.type === 'mock' ? 'Mock' : 'Webhook'}</span></div>
        <div class="list-item-desc">${escapeHtml(t.description || '无描述')}</div>
        <div class="list-item-meta">
          <span class="text-xs text-muted">${t.type === 'webhook' ? escapeHtml(t.webhook_url) : '返回预设 Mock 响应'}</span>
        </div>
      </div>
      <div class="list-item-actions">
        <button class="btn-icon" title="编辑" onclick="showToolModal('${t.id}')">${I.edit}</button>
        <button class="btn-icon" title="删除" onclick="deleteTool('${t.id}')">${I.trash}</button>
      </div>
    </div>
  `).join('');
}

window.showToolModal = async function(id) {
  const t = id ? state.tools.find(x => x.id === id) : null;
  const params = t ? JSON.stringify(t.parameters, null, 2) : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';

  showModal(`
    <div class="modal-header">
      <h2>${t ? '编辑工具' : '新建工具'}</h2>
      <button class="modal-close" onclick="closeModal()">${I.close}</button>
    </div>
    <div class="form-group">
      <label class="form-label">名称</label>
      <input class="form-input" id="tool-name" value="${t ? escapeHtml(t.name) : ''}" placeholder="如：代码分析器">
    </div>
    <div class="form-group">
      <label class="form-label">描述</label>
      <input class="form-input" id="tool-desc" value="${t ? escapeHtml(t.description) : ''}" placeholder="工具功能描述，LLM 会根据此描述决定是否调用">
    </div>
    <div class="form-group">
      <label class="form-label">类型</label>
      <select class="form-select" id="tool-type" onchange="toggleToolType()">
        <option value="mock" ${t && t.type === 'mock' ? 'selected' : ''}>Mock（返回预设响应）</option>
        <option value="webhook" ${t && t.type === 'webhook' ? 'selected' : ''}>Webhook（调用外部 API）</option>
      </select>
    </div>
    <div class="form-group" id="mock-group" style="${t && t.type === 'webhook' ? 'display:none' : ''}">
      <label class="form-label">Mock 响应（JSON）</label>
      <textarea class="form-textarea" id="tool-mock" style="min-height:100px">${t ? escapeHtml(t.mock_response) : '{}'}</textarea>
    </div>
    <div class="form-group" id="webhook-group" style="${!t || t.type === 'mock' ? 'display:none' : ''}">
      <label class="form-label">Webhook URL</label>
      <input class="form-input" id="tool-webhook" value="${t ? escapeHtml(t.webhook_url) : ''}" placeholder="https://your-api.com/endpoint">
    </div>
    <div class="form-group">
      <label class="form-label">参数定义（JSON Schema）</label>
      <textarea class="form-textarea" id="tool-params" style="min-height:160px">${escapeHtml(params)}</textarea>
      <div class="form-hint">使用 OpenAI Function Calling 的 JSON Schema 格式定义参数</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveTool('${id || ''}')">保存</button>
    </div>
  `);
};

window.toggleToolType = function() {
  const type = $('#tool-type').value;
  $('#mock-group').style.display = type === 'mock' ? '' : 'none';
  $('#webhook-group').style.display = type === 'webhook' ? '' : 'none';
};

window.saveTool = async function(id) {
  let params;
  try { params = JSON.parse($('#tool-params').value); }
  catch { return showToast('参数 JSON 格式错误', 'error'); }

  const body = {
    name: $('#tool-name').value.trim(),
    description: $('#tool-desc').value.trim(),
    type: $('#tool-type').value,
    parameters: params,
    mock_response: $('#tool-mock') ? $('#tool-mock').value : '{}',
    webhook_url: $('#tool-webhook') ? $('#tool-webhook').value : ''
  };
  if (!body.name) return showToast('请填写名称', 'error');
  if (id) { await api.put('/api/tools/' + id, body); showToast('工具已更新', 'success'); }
  else { await api.post('/api/tools', body); showToast('工具已创建', 'success'); }
  closeModal();
  renderTools();
};

window.deleteTool = async function(id) {
  if (!confirm('确定删除此工具？')) return;
  await api.del('/api/tools/' + id);
  showToast('已删除', 'success');
  renderTools();
};

// ---- Conversations (Chat Playground) ----
async function renderConversations() {
  state.agents = await api.get('/api/agents');
  state.connections = await api.get('/api/connections');
  state.conversations = await api.get('/api/conversations');
  state.currentConv = null;

  $('#view').innerHTML = `
    <div class="page-header">
      <h1>对话记录 & 测试</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="toggleFullscreenChat()">${I.expand} 全屏</button>
        <button class="btn btn-secondary" onclick="openStandaloneChat()">${I.link} 独立窗口</button>
        <button class="btn btn-primary" onclick="startNewChat()">${I.plus} 新对话</button>
      </div>
    </div>
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-sidebar-header">
          <span class="text-sm text-muted">对话列表 (${state.conversations.length})</span>
        </div>
        <div class="chat-sidebar-list" id="conv-list">
          ${state.conversations.length === 0
            ? '<div class="empty-state text-sm">暂无对话</div>'
            : state.conversations.slice().reverse().map(c => {
                const agent = state.agents.find(a => a.id === c.agent_id);
                return `<div class="chat-conv-item" id="conv-item-${c.id}" onclick="selectConversation('${c.id}')">
                  <div style="font-weight:600">${escapeHtml(c.title)}</div>
                  <div class="text-xs text-muted">${agent ? escapeHtml(agent.name) : '未知'} · ${timeAgo(c.updated_at)}</div>
                </div>`;
              }).join('')
          }
        </div>
      </div>
      <div class="chat-main">
        <div class="chat-header">
          <select class="form-select" id="chat-agent-select" style="width:auto;min-width:160px">
            <option value="">选择 Agent...</option>
            ${state.agents.map(a => `<option value="${a.id}" ${state.chatAgentId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}${a.is_main ? ' (主调度)' : ''}</option>`).join('')}
          </select>
          <span class="text-sm text-muted" id="chat-status"></span>
        </div>
        <div class="chat-messages" id="chat-messages">
          <div class="chat-empty">
            ${I.chat}
            <p>选择一个 Agent，输入消息开始对话</p>
            <p class="text-xs">支持流式输出、工具调用、主 Agent 调度子 Agent</p>
          </div>
        </div>
        <div class="chat-input-area">
          <textarea class="chat-input" id="chat-input" placeholder="输入消息... (Ctrl+Enter 发送)" rows="1"></textarea>
          <button class="btn btn-primary" id="chat-send" onclick="sendMessage()">${I.send}</button>
        </div>
      </div>
    </div>
  `;

  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('#chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  });

  if (state.chatAgentId) {
    $('#chat-agent-select').value = state.chatAgentId;
    state.chatAgentId = null;
  } else if (state.standaloneAgentId) {
    $('#chat-agent-select').value = state.standaloneAgentId;
  }
}

window.openStandaloneChat = function() {
  const agentId = $('#chat-agent-select') ? $('#chat-agent-select').value : '';
  const url = location.origin + '/?standalone=1' + (agentId ? ('&agent=' + encodeURIComponent(agentId)) : '') + '#/conversations';
  window.open(url, '_blank', 'width=1024,height=760');
};

window.toggleFullscreenChat = function() {
  document.body.classList.toggle('fullscreen');
  const btn = event && event.currentTarget;
  if (btn) btn.innerHTML = document.body.classList.contains('fullscreen') ? (I.collapse + ' 退出全屏') : (I.expand + ' 全屏');
};

window.startNewChat = function(agentId) {
  if (agentId) {
    const sel = $('#chat-agent-select');
    if (sel) sel.value = agentId;
  }
  state.currentConv = null;
  $$('.chat-conv-item').forEach(el => el.classList.remove('active'));
  const msgArea = $('#chat-messages');
  if (msgArea) {
    msgArea.innerHTML = `<div class="chat-empty">${I.chat}<p>选择 Agent 后输入消息开始新对话</p></div>`;
  }
  $('#chat-input') && $('#chat-input').focus();
};

window.selectConversation = async function(id) {
  const data = await api.get('/api/conversations/' + id);
  state.currentConv = data;

  $$('.chat-conv-item').forEach(el => el.classList.remove('active'));
  const item = $('#conv-item-' + id);
  if (item) item.classList.add('active');

  const agent = state.agents.find(a => a.id === data.agent_id);
  if (agent) $('#chat-agent-select').value = agent.id;

  const msgArea = $('#chat-messages');
  if (data.messages.length === 0) {
    msgArea.innerHTML = `<div class="chat-empty">${I.chat}<p>这个对话还没有消息</p></div>`;
  } else {
    msgArea.innerHTML = data.messages.map(m => renderMessage(m)).join('');
    msgArea.scrollTop = msgArea.scrollHeight;
  }
};

function buildAssistantShell(id) {
  return `<div class="chat-message assistant" id="${id}">
    <div class="assistant-text"></div>
    <div class="assistant-tools"></div>
  </div>`;
}

function renderMessage(m) {
  if (m.role === 'user') {
    return `<div class="chat-message user">${escapeHtml(m.content)}</div>`;
  }
  const stars = [1,2,3,4,5].map(n =>
    `<button class="${m.rating === n ? 'active' : ''}" onclick="rateMessage('${m.id}', ${n})">${I.star}</button>`
  ).join('');
  const toolCallsHtml = m.tool_calls ? m.tool_calls.map(tc => `
    <div class="tool-call-block">
      <span class="tool-name">Tool: ${escapeHtml(tc.name)}</span>
      <div class="tool-args">${escapeHtml(tc.arguments || '{}')}</div>
    </div>
  `).join('') : '';
  const text = m.content || '';
  return `<div class="chat-message assistant">
    <div class="assistant-text">${escapeHtml(text) || '<span class="text-muted">(空回复)</span>'}</div>
    <div class="assistant-tools">
      ${toolCallsHtml}
      <div class="msg-meta">
        <span>${m.model || 'unknown'}</span>
        ${m.tokens ? `<span>${m.tokens} tokens</span>` : ''}
        <span>${timeAgo(m.created_at)}</span>
        <div class="msg-rating">${stars}</div>
      </div>
    </div>
  </div>`;
}

window.rateMessage = async function(id, rating) {
  await api.put('/api/messages/' + id + '/rating', { rating });
  showToast('已评分', 'success');
  if (state.currentConv) selectConversation(state.currentConv.id);
};

async function sendMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.chatStreaming) return;

  const agentId = $('#chat-agent-select').value;
  if (!agentId) return showToast('请先选择一个 Agent', 'error');

  const agent = state.agents.find(a => a.id === agentId);
  if (agent && !agent.api_connection_id) return showToast(`Agent「${agent.name}」未绑定 API 连接`, 'error');

  state.chatStreaming = true;
  $('#chat-send').disabled = true;
  input.value = '';
  input.style.height = 'auto';

  const msgArea = $('#chat-messages');
  if (msgArea.querySelector('.chat-empty')) msgArea.innerHTML = '';

  msgArea.insertAdjacentHTML('beforeend', `<div class="chat-message user">${escapeHtml(text)}</div>`);

  const assistantId = 'msg-' + Date.now();
  msgArea.insertAdjacentHTML('beforeend', buildAssistantShell(assistantId));
  $('#' + assistantId + ' .assistant-text').innerHTML = '<span class="text-muted">思考中...</span>';
  msgArea.scrollTop = msgArea.scrollHeight;

  const convId = state.currentConv?.id || null;
  let accumulated = '';
  const toolsEl = () => $('#' + assistantId + ' .assistant-tools');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, conversation_id: convId, message: text })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }

        switch (data.type) {
          case 'conversation':
            state.currentConv = { id: data.conversation_id };
            state.conversations = await api.get('/api/conversations');
            refreshConvList();
            break;
          case 'chunk':
            if (accumulated === '') $('#' + assistantId + ' .assistant-text').innerHTML = '';
            accumulated += data.content;
            $('#' + assistantId + ' .assistant-text').innerHTML = escapeHtml(accumulated);
            msgArea.scrollTop = msgArea.scrollHeight;
            break;
          case 'tool_calls':
            (data.tool_calls || []).forEach(tc => {
              toolsEl().insertAdjacentHTML('beforeend', `
                <div class="tool-call-block">
                  <span class="tool-name">Tool: ${escapeHtml(tc.name)}</span>
                  <div class="tool-args">${escapeHtml(tc.arguments || '{}')}</div>
                </div>`);
            });
            break;
          case 'tool_executing':
            toolsEl().insertAdjacentHTML('beforeend', `
              <div class="tool-call-block">
                <span class="tool-name">Executing: ${escapeHtml(data.name)}</span>
                <div class="tool-args">${escapeHtml(JSON.stringify(data.args, null, 2))}</div>
              </div>`);
            break;
          case 'tool_result':
            toolsEl().insertAdjacentHTML('beforeend', `
              <div class="tool-call-block">
                <span class="tool-name">Result: ${escapeHtml(data.name)}</span>
                <div class="tool-result">${escapeHtml(data.result)}</div>
              </div>`);
            break;
          case 'subagent_start':
            toolsEl().insertAdjacentHTML('beforeend', `
              <div class="tool-call-block subagent-block">
                <span class="tool-name">⚙ 调度子 Agent：${escapeHtml(data.name)}</span>
                <div class="tool-args text-muted">执行中...</div>
              </div>`);
            break;
          case 'subagent_result':
            toolsEl().insertAdjacentHTML('beforeend', `
              <div class="tool-call-block subagent-block">
                <span class="tool-name">✓ 子 Agent「${escapeHtml(data.name)}」返回</span>
                <div class="tool-result">${escapeHtml(data.result)}</div>
              </div>`);
            break;
          case 'done': {
            const msgEl = $('#' + assistantId);
            if (accumulated === '') msgEl.querySelector('.assistant-text').innerHTML = '<span class="text-muted">(空回复)</span>';
            const metaHtml = `
              <div class="msg-meta">
                <span>${escapeHtml(data.model || 'unknown')}</span>
                ${data.tokens ? `<span>${data.tokens} tokens</span>` : ''}
                <div class="msg-rating">
                  ${[1,2,3,4,5].map(n => `<button onclick="rateMessage('${data.message_id}', ${n})">${I.star}</button>`).join('')}
                </div>
              </div>`;
            toolsEl().insertAdjacentHTML('beforeend', metaHtml);
            msgArea.scrollTop = msgArea.scrollHeight;
            break;
          }
          case 'error':
            $('#' + assistantId + ' .assistant-text').innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(data.message)}</span>`;
            showToast(data.message, 'error');
            break;
        }
      }
    }
  } catch (err) {
    $('#' + assistantId + ' .assistant-text').innerHTML = `<span style="color:var(--red)">请求失败: ${escapeHtml(err.message)}</span>`;
    showToast('请求失败', 'error');
  } finally {
    state.chatStreaming = false;
    $('#chat-send').disabled = false;
    input.focus();
  }
}

function refreshConvList() {
  const list = $('#conv-list');
  if (!list) return;
  list.innerHTML = state.conversations.slice().reverse().map(c => {
    const agent = state.agents.find(a => a.id === c.agent_id);
    const active = state.currentConv?.id === c.id ? 'active' : '';
    return `<div class="chat-conv-item ${active}" id="conv-item-${c.id}" onclick="selectConversation('${c.id}')">
      <div style="font-weight:600">${escapeHtml(c.title)}</div>
      <div class="text-xs text-muted">${agent ? escapeHtml(agent.name) : '未知'} · ${timeAgo(c.updated_at)}</div>
    </div>`;
  }).join('');
}

window.sendMessage = sendMessage;

// ---- Settings ----
async function renderSettings() {
  state.settings = await api.get('/api/settings');
  const s = state.settings;

  $('#view').innerHTML = `
    <div class="page-header"><h1>设置</h1></div>

    <div class="card">
      <div class="card-title">默认配置</div>
      <div class="form-group">
        <label class="form-label">默认 API Base URL</label>
        <input class="form-input" id="setting-baseurl" value="${escapeHtml(s.defaultBaseUrl || '')}" placeholder="https://api.openai.com/v1">
      </div>
      <div class="form-group">
        <label class="form-label">默认模型</label>
        <input class="form-input" id="setting-model" value="${escapeHtml(s.defaultModel || '')}" placeholder="gpt-4o-mini">
      </div>
      <button class="btn btn-primary" onclick="saveSettings()">保存设置</button>
    </div>

    <div class="card">
      <div class="card-title">数据管理</div>
      <p class="text-sm text-muted mb-4">所有数据保存在本地 data.json 文件中（位于应用用户目录）。</p>
      <div class="flex gap-2" style="flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="exportData()">${I.plus} 导出 JSON 备份</button>
        <label class="btn btn-secondary" style="cursor:pointer">
          导入恢复
          <input type="file" accept=".json" onchange="importData(this)" hidden>
        </label>
        <button class="btn btn-danger" onclick="clearAllData()">清空所有数据</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">关于</div>
      <p class="text-sm text-muted">Agent Dev Platform v1.1</p>
      <p class="text-sm text-muted mt-2">本地运行的 Agent 开发平台，支持 Prompt 管理、Agent 配置测试、工具编排、主 Agent 调度子 Agent、对话评测。兼容 OpenAI API 格式。</p>
    </div>
  `;
}

window.saveSettings = async function() {
  const body = {
    defaultBaseUrl: $('#setting-baseurl').value.trim(),
    defaultModel: $('#setting-model').value.trim()
  };
  await api.put('/api/settings', body);
  state.settings = body;
  showToast('设置已保存', 'success');
};

window.exportData = function() {
  window.open('/api/backup', '_blank');
};

window.importData = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (!confirm('导入将覆盖当前所有数据，确定继续？')) { input.value = ''; return; }
  const text = await file.text();
  try {
    const json = JSON.parse(text);
    await api.post('/api/backup', json);
    showToast('数据已导入', 'success');
    handleRoute();
  } catch {
    showToast('文件格式错误', 'error');
  }
  input.value = '';
};

window.clearAllData = async function() {
  if (!confirm('确定清空所有数据？此操作不可恢复！建议先导出备份。')) return;
  if (!confirm('再次确认：所有 Prompt、Agent、工具、对话将被删除。')) return;
  const { defaultBaseUrl, defaultModel } = state.settings;
  await api.post('/api/backup', {
    prompts: [], agents: [], tools: [], conversations: [], messages: [],
    settings: { defaultBaseUrl, defaultModel }
  });
  showToast('数据已清空', 'success');
  handleRoute();
};

// ---- Export/Import (sidebar buttons) ----
$('#btn-export').addEventListener('click', () => window.open('/api/backup', '_blank'));
$('#btn-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('导入将覆盖当前所有数据，确定继续？')) { e.target.value = ''; return; }
  const text = await file.text();
  try {
    const json = JSON.parse(text);
    await api.post('/api/backup', json);
    showToast('数据已导入', 'success');
    handleRoute();
  } catch {
    showToast('文件格式错误', 'error');
  }
  e.target.value = '';
});

// ---- Init ----
window.addEventListener('hashchange', handleRoute);
window.addEventListener('DOMContentLoaded', async () => {
  state.settings = await api.get('/api/settings');

  // Standalone conversation window (opened via "独立窗口")
  const params = new URLSearchParams(location.search);
  if (params.get('standalone') === '1') document.body.classList.add('standalone');
  const agentParam = params.get('agent');
  if (agentParam) state.standaloneAgentId = agentParam;

  handleRoute();
});
