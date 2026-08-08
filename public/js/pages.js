// Full-screen management pages: Dashboard / API / Agents / MCP / Settings
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, toast, fmtTime, truncate, confirmBox, openModal, closeModal, onModalOk, prettyJson } from './util.js';

const PROVIDERS = [
  ['openai', 'OpenAI 兼容 /chat/completions'],
  ['openai-responses', 'OpenAI Responses /responses'],
  ['anthropic', 'Anthropic /v1/messages'],
  ['ollama', 'Ollama 本地 /api/chat'],
  ['local', 'LM Studio / 本地 OpenAI 兼容'],
  ['custom', '自定义 OpenAI 兼容'],
  ['mock', 'Mock（离线自测用）']
];

let overlay = null;
let current = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = h('div', { class: 'page-overlay hidden' });
  overlay.innerHTML = `<div class="page-head"><h2 id="page-title"></h2><button class="btn" id="page-close">← 返回工作台</button></div><div class="page-body" id="page-body"></div>`;
  document.getElementById('app').appendChild(overlay);
  overlay.querySelector('#page-close').onclick = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
  return overlay;
}

export function close() {
  if (overlay) overlay.classList.add('hidden');
  current = null;
  $$('.topnav button').forEach(b => b.classList.remove('active'));
}

export async function open(page) {
  ensureOverlay();
  current = page;
  overlay.classList.remove('hidden');
  $$('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const title = { dashboard: '总览', connections: 'API 连接', agents: 'Agents', mcp: 'MCP 服务器', settings: '设置' }[page] || page;
  $('#page-title').textContent = title;
  const body = $('#page-body');
  body.innerHTML = '<div class="muted">加载中…</div>';
  try {
    if (page === 'dashboard') await renderDashboard(body);
    else if (page === 'connections') await renderConnections(body);
    else if (page === 'agents') await renderAgents(body);
    else if (page === 'mcp') await renderMcp(body);
    else if (page === 'settings') await renderSettings(body);
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

export function refreshIfOpen() { if (current) open(current); }

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */
async function renderDashboard(body) {
  const [stats, info, projects] = await Promise.all([api.dashboard(), api.systemInfo(), api.projects()]);
  const card = (n, label) => `<div class="stat"><div class="stat-n">${n}</div><div class="stat-l">${esc(label)}</div></div>`;
  body.innerHTML = `
    <div class="stats">
      ${card(stats.projects, '项目')}
      ${card(stats.connections, 'API 连接')}
      ${card(stats.agents, 'Agents')}
      ${card(stats.externalAgents, '外部 Agent')}
      ${card(stats.conversations, '对话')}
      ${card(stats.mcpServers, 'MCP 服务器')}
    </div>
    <div class="grid2">
      <section class="panel">
        <h3>最近项目</h3>
        ${projects.length ? `<table class="tbl"><tbody>${projects.slice(0, 8).map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.root_path)}</div></td><td class="muted">${esc(fmtTime(p.last_opened_at))}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">还没有项目</div>'}
      </section>
      <section class="panel">
        <h3>运行环境</h3>
        <table class="tbl kv">
          <tr><td>应用版本</td><td>${esc(info.version)}</td></tr>
          <tr><td>Electron</td><td>${esc(info.electron)}</td></tr>
          <tr><td>Node</td><td>${esc(info.node)}</td></tr>
          <tr><td>Chromium</td><td>${esc(info.chrome)}</td></tr>
          <tr><td>数据库</td><td class="mono small">${esc(info.dbPath)}</td></tr>
          <tr><td>密钥存储</td><td>${esc(info.secretBackend)}</td></tr>
          <tr><td>浏览器自动化</td><td>${info.browser && info.browser.installed ? 'Playwright 已安装' : '未安装（browser_* 工具不可用）'}</td></tr>
        </table>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* API connections                                                     */
/* ------------------------------------------------------------------ */
async function renderConnections(body) {
  const list = await api.connections();
  body.innerHTML = `
    <div class="page-actions"><button class="btn primary" id="conn-add">+ 新建连接</button>
      <span class="muted">API Key 使用 Windows DPAPI（safeStorage）加密后存入本地数据库，界面只显示掩码。</span></div>
    ${list.length ? `<table class="tbl"><thead><tr><th>名称</th><th>协议</th><th>Base URL</th><th>Key</th><th>状态</th><th>模型</th><th></th></tr></thead><tbody>
      ${list.map(c => `<tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc((PROVIDERS.find(p => p[0] === c.provider) || [c.provider, c.provider])[1])}</td>
        <td class="mono small">${esc(c.base_url)}</td>
        <td class="mono small">${esc(c.api_key_masked || '未设置')}</td>
        <td>${c.tested ? '<span class="chip ok">已连通</span>' : (c.last_error ? `<span class="chip bad" title="${esc(c.last_error)}">失败</span>` : '<span class="chip">未测试</span>')}</td>
        <td>${(c.models || []).length}</td>
        <td class="right">
          <button class="btn tiny" data-test="${c.id}">测试</button>
          <button class="btn tiny" data-models="${c.id}">拉取模型</button>
          <button class="btn tiny" data-edit="${c.id}">编辑</button>
          <button class="btn tiny danger" data-del="${c.id}">删除</button>
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">还没有 API 连接，点击「新建连接」开始。</div>'}`;

  $('#conn-add').onclick = () => connForm(null);
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => connForm(list.find(c => c.id === b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除连接', '删除后使用该连接的 Agent 将无法运行，确定？')) return;
    await api.connRemove(b.dataset.del); toast('已删除'); open('connections');
  });
  body.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
    b.textContent = '测试中…'; b.disabled = true;
    try { const r = await api.connTest(b.dataset.test); toast(r.ok ? `连通，延迟 ${r.latency}ms` : '失败：' + r.message, r.ok ? 'ok' : 'error'); }
    catch (e) { toast(e.message, 'error'); }
    open('connections');
  });
  body.querySelectorAll('[data-models]').forEach(b => b.onclick = async () => {
    b.textContent = '拉取中…'; b.disabled = true;
    try { const r = await api.connModels(b.dataset.models); toast(`拉取到 ${r.models.length} 个模型`, 'ok'); }
    catch (e) { toast(e.message, 'error'); }
    open('connections');
  });
}

function connForm(conn) {
  const c = conn || { name: '', provider: 'openai', base_url: 'https://api.openai.com/v1', headers: {} };
  openModal(conn ? '编辑连接' : '新建连接', `
    <label>名称<input id="f-name" value="${esc(c.name)}"></label>
    <label>协议
      <select id="f-provider">${PROVIDERS.map(p => `<option value="${p[0]}" ${p[0] === c.provider ? 'selected' : ''}>${esc(p[1])}</option>`).join('')}</select>
    </label>
    <label>Base URL<input id="f-url" value="${esc(c.base_url)}" placeholder="https://api.openai.com/v1"></label>
    <label>API Key<input id="f-key" type="password" placeholder="${conn && conn.api_key_masked ? esc(conn.api_key_masked) + '（留空表示不修改）' : 'sk-...'}"></label>
    <label>额外请求头（JSON，可留空）<textarea id="f-headers" rows="3">${esc(Object.keys(c.headers || {}).length ? JSON.stringify(c.headers, null, 2) : '')}</textarea></label>
  `, { okText: '保存' });
  onModalOk(async () => {
    let headers = {};
    const raw = $('#f-headers').value.trim();
    if (raw) { try { headers = JSON.parse(raw); } catch { toast('请求头不是合法 JSON', 'error'); return; } }
    const payload = { name: $('#f-name').value.trim() || '新连接', provider: $('#f-provider').value, base_url: $('#f-url').value.trim(), headers };
    const key = $('#f-key').value;
    if (key) payload.api_key = key;
    try {
      if (conn) await api.connUpdate(conn.id, payload); else await api.connCreate(payload);
      closeModal(); toast('已保存', 'ok'); open('connections');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */
async function renderAgents(body) {
  const [agents, conns, prompts, tools, ext] = await Promise.all([api.agents(), api.connections(), api.prompts(), api.tools(), api.externalAgents()]);
  const native = agents.filter(a => a.type !== 'external');
  body.innerHTML = `
    <div class="page-actions">
      <button class="btn primary" id="agent-add">+ 新建 Agent</button>
      <button class="btn" id="ext-add">+ 接入外部 Agent</button>
    </div>
    <h3>本地 Agent</h3>
    <div class="cards">${native.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b>${a.is_main ? '<span class="chip ok">主 Agent</span>' : ''}${a.type === 'computer' ? '<span class="chip">电脑操作</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta">
          <span>模型：${esc(a.model || '未设置')}</span>
          <span>工具：${(a.tools || []).length}</span>
          <span>最大步数：${a.max_steps}</span>
          <span>子 Agent：${(a.sub_agent_ids || []).length}</span>
        </div>
        <div class="acard-f"><button class="btn tiny" data-ae="${a.id}">编辑</button><button class="btn tiny danger" data-ad="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty">还没有 Agent</div>'}</div>
    <h3>外部 Agent（Codex / WorkBuddy Desktop / HTTP）</h3>
    <div class="cards">${ext.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b><span class="chip">${esc(a.adapter_type)}</span></div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta"><span class="mono small">${esc(a.command || a.endpoint || '')}</span></div>
        <div class="acard-f"><button class="btn tiny" data-ee="${a.id}">编辑</button><button class="btn tiny danger" data-ed="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty">没有外部 Agent</div>'}</div>`;

  $('#agent-add').onclick = () => agentForm(null, { conns, prompts, tools, agents: native });
  $('#ext-add').onclick = () => extForm(null, conns);
  body.querySelectorAll('[data-ae]').forEach(b => b.onclick = () => agentForm(native.find(a => a.id === b.dataset.ae), { conns, prompts, tools, agents: native }));
  body.querySelectorAll('[data-ad]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除 Agent', '确定删除该 Agent？')) return;
    await api.agentRemove(b.dataset.ad); toast('已删除'); open('agents');
  });
  body.querySelectorAll('[data-ee]').forEach(b => b.onclick = () => extForm(ext.find(a => a.id === b.dataset.ee), conns));
  body.querySelectorAll('[data-ed]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除外部 Agent', '确定删除？')) return;
    await api.extRemove(b.dataset.ed); toast('已删除'); open('agents');
  });
}

function agentForm(agent, ctx) {
  const a = agent || { name: '', description: '', max_steps: 40, temperature: 0.7, max_tokens: 4096, tools: [], sub_agent_ids: [], is_main: false, type: 'native' };
  const conn = ctx.conns.find(c => c.id === a.api_connection_id);
  const models = conn ? (conn.models || []) : [];
  const toolNames = [...new Set(ctx.tools.map(t => t.name))].sort();
  openModal(agent ? '编辑 Agent' : '新建 Agent', `
    <div class="form2">
      <label>名称<input id="a-name" value="${esc(a.name)}"></label>
      <label>类型<select id="a-type"><option value="native" ${a.type !== 'computer' ? 'selected' : ''}>普通（编码）</option><option value="computer" ${a.type === 'computer' ? 'selected' : ''}>电脑操作</option></select></label>
      <label>API 连接<select id="a-conn"><option value="">未选择</option>${ctx.conns.map(c => `<option value="${c.id}" ${c.id === a.api_connection_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>模型<input id="a-model" list="a-models" value="${esc(a.model || '')}" placeholder="gpt-4o-mini"><datalist id="a-models">${models.map(m => `<option value="${esc(m)}">`).join('')}</datalist></label>
      <label>系统提示词<select id="a-prompt"><option value="">（用下面的描述）</option>${ctx.prompts.map(p => `<option value="${p.id}" ${p.id === a.system_prompt_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>最大步数<input id="a-steps" type="number" min="1" max="200" value="${a.max_steps ?? 40}"></label>
      <label>temperature<input id="a-temp" type="number" step="0.1" min="0" max="2" value="${a.temperature ?? 0.7}"></label>
      <label>max_tokens<input id="a-maxtok" type="number" min="256" max="128000" value="${a.max_tokens ?? 4096}"></label>
    </div>
    <label>描述 / 角色设定<textarea id="a-desc" rows="3">${esc(a.description || '')}</textarea></label>
    <label class="ck"><input type="checkbox" id="a-main" ${a.is_main ? 'checked' : ''}> 设为主 Agent（新对话默认使用）</label>
    <details open><summary>工具（${toolNames.length}）</summary>
      <div class="chkgrid">${toolNames.map(n => `<label class="ck"><input type="checkbox" class="a-tool" value="${esc(n)}" ${(a.tools || []).includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <div class="row"><button class="btn tiny" id="a-tool-all">全选</button><button class="btn tiny" id="a-tool-none">全不选</button></div>
    </details>
    <details><summary>子 Agent</summary>
      <div class="chkgrid">${ctx.agents.filter(x => x.id !== a.id).map(x => `<label class="ck"><input type="checkbox" class="a-sub" value="${x.id}" ${(a.sub_agent_ids || []).includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="muted">无</span>'}</div>
    </details>
  `, { okText: '保存' });

  $('#a-tool-all').onclick = () => $$('.a-tool').forEach(c => c.checked = true);
  $('#a-tool-none').onclick = () => $$('.a-tool').forEach(c => c.checked = false);
  $('#a-conn').onchange = async () => {
    const c = ctx.conns.find(x => x.id === $('#a-conn').value);
    $('#a-models').innerHTML = (c ? c.models || [] : []).map(m => `<option value="${esc(m)}">`).join('');
  };

  onModalOk(async () => {
    const payload = {
      name: $('#a-name').value.trim() || '新 Agent',
      type: $('#a-type').value,
      description: $('#a-desc').value,
      api_connection_id: $('#a-conn').value || null,
      model: $('#a-model').value.trim(),
      provider: (ctx.conns.find(c => c.id === $('#a-conn').value) || {}).provider || null,
      system_prompt_id: $('#a-prompt').value || null,
      max_steps: Number($('#a-steps').value) || 40,
      temperature: Number($('#a-temp').value),
      max_tokens: Number($('#a-maxtok').value) || 4096,
      is_main: $('#a-main').checked,
      tools: $$('.a-tool').filter(c => c.checked).map(c => c.value),
      sub_agent_ids: $$('.a-sub').filter(c => c.checked).map(c => c.value)
    };
    try {
      if (agent) await api.agentUpdate(agent.id, payload); else await api.agentCreate(payload);
      closeModal(); toast('已保存', 'ok'); open('agents');
      window.dispatchEvent(new CustomEvent('agents-changed'));
    } catch (e) { toast(e.message, 'error'); }
  });
}

function extForm(agent, conns) {
  const a = agent || { name: '', description: '', adapter_type: 'codex', command: '', endpoint: '', config: {} };
  openModal(agent ? '编辑外部 Agent' : '接入外部 Agent', `
    <label>名称<input id="e-name" value="${esc(a.name)}"></label>
    <label>适配器
      <select id="e-type">
        <option value="codex" ${a.adapter_type === 'codex' ? 'selected' : ''}>Codex CLI / OpenAI 兼容</option>
        <option value="workbuddy" ${a.adapter_type === 'workbuddy' ? 'selected' : ''}>WorkBuddy Desktop 桥接（窗口自动化）</option>
        <option value="http" ${a.adapter_type === 'http' ? 'selected' : ''}>HTTP 端点</option>
      </select></label>
    <label>可执行命令（codex 适配器用，如 codex）<input id="e-cmd" value="${esc(a.command || '')}"></label>
    <label>HTTP 端点（http 适配器用）<input id="e-ep" value="${esc(a.endpoint || '')}" placeholder="http://127.0.0.1:8080/run"></label>
    <label>绑定 API 连接（codex 走 OpenAI 兼容时用）
      <select id="e-conn"><option value="">不使用</option>${conns.map(c => `<option value="${c.id}" ${(a.config || {}).connectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>说明<textarea id="e-desc" rows="2">${esc(a.description || '')}</textarea></label>
    <div class="warn-box">外部 Agent 通过命令行或窗口自动化调用，不会读取或转发你的 API 密钥；桥接不会递归调用本应用自身。</div>
  `, { okText: '保存' });
  onModalOk(async () => {
    const payload = {
      name: $('#e-name').value.trim() || '外部 Agent',
      adapter_type: $('#e-type').value,
      command: $('#e-cmd').value.trim(),
      endpoint: $('#e-ep').value.trim(),
      description: $('#e-desc').value,
      config: { connectionId: $('#e-conn').value || null }
    };
    try {
      if (agent) await api.extUpdate(agent.id, payload); else await api.extCreate(payload);
      closeModal(); toast('已保存', 'ok'); open('agents');
      window.dispatchEvent(new CustomEvent('agents-changed'));
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */
async function renderMcp(body) {
  const list = await api.mcpList();
  body.innerHTML = `
    <div class="page-actions"><button class="btn primary" id="mcp-add">+ 添加 MCP 服务器</button>
      <span class="muted">支持 stdio（本地进程）与 http（SSE）两种传输。连接后其工具会自动进入 Agent 可用工具列表。</span></div>
    ${list.length ? list.map(s => `
      <section class="panel">
        <div class="panel-h"><b>${esc(s.name)}</b>
          <span class="chip ${s.status === 'connected' ? 'ok' : (s.status === 'error' ? 'bad' : '')}">${esc(s.status)}</span>
          <span class="mono small">${esc(s.transport === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.url)}</span>
          <span class="grow"></span>
          <button class="btn tiny" data-c="${s.id}">连接</button>
          <button class="btn tiny" data-dc="${s.id}">断开</button>
          <button class="btn tiny danger" data-rm="${s.id}">删除</button>
        </div>
        ${(s.tools || []).length ? `<div class="taglist">${s.tools.map(t => `<span class="tag" title="${esc(t.description || '')}">${esc(t.name)}</span>`).join('')}</div>` : '<div class="muted small">未获取到工具（先点击连接）</div>'}
      </section>`).join('') : '<div class="empty">还没有 MCP 服务器</div>'}`;

  $('#mcp-add').onclick = () => mcpForm();
  body.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
    b.textContent = '连接中…'; b.disabled = true;
    try { const r = await api.mcpConnect(b.dataset.c); toast(`已连接，${r.tools.length} 个工具`, 'ok'); }
    catch (e) { toast(e.message, 'error'); }
    open('mcp');
  });
  body.querySelectorAll('[data-dc]').forEach(b => b.onclick = async () => { await api.mcpDisconnect(b.dataset.dc); open('mcp'); });
  body.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除服务器', '确定删除？')) return;
    await api.mcpRemove(b.dataset.rm); open('mcp');
  });
}

function mcpForm() {
  openModal('添加 MCP 服务器', `
    <label>名称<input id="m-name" placeholder="filesystem"></label>
    <label>传输<select id="m-tr"><option value="stdio">stdio（本地进程）</option><option value="http">http（SSE）</option></select></label>
    <label>命令（stdio）<input id="m-cmd" placeholder="npx"></label>
    <label>参数（空格分隔）<input id="m-args" placeholder="-y @modelcontextprotocol/server-filesystem ."></label>
    <label>URL（http）<input id="m-url" placeholder="http://127.0.0.1:3001/sse"></label>
  `, { okText: '添加' });
  onModalOk(async () => {
    const payload = {
      name: $('#m-name').value.trim() || 'mcp',
      transport: $('#m-tr').value,
      command: $('#m-cmd').value.trim(),
      args: $('#m-args').value.trim() ? $('#m-args').value.trim().split(/\s+/) : [],
      url: $('#m-url').value.trim()
    };
    try { await api.mcpCreate(payload); closeModal(); open('mcp'); } catch (e) { toast(e.message, 'error'); }
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
async function renderSettings(body) {
  const [prompts, skills, audit, info, mems] = await Promise.all([
    api.prompts(), api.skills(), api.audit(), api.systemInfo(),
    state.project ? api.memories('project', state.project.id) : Promise.resolve([])
  ]);
  body.innerHTML = `
    <section class="panel">
      <div class="panel-h"><h3>提示词库</h3><span class="grow"></span><button class="btn tiny" id="p-add">+ 新建</button></div>
      ${prompts.length ? `<table class="tbl"><tbody>${prompts.map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(truncate(p.content, 120))}</div></td><td class="right"><button class="btn tiny" data-pe="${p.id}">编辑</button><button class="btn tiny danger" data-pd="${p.id}">删除</button></td></tr>`).join('')}</tbody></table>` : '<div class="muted">暂无</div>'}
    </section>

    <section class="panel">
      <h3>技能包（Skills）</h3>
      ${skills.length ? `<div class="taglist">${skills.map(s => `<span class="tag" title="${esc(s.description || '')}">${esc(s.name)}</span>`).join('')}</div>` : '<div class="muted">暂无</div>'}
    </section>

    <section class="panel">
      <h3>项目记忆（会注入到系统提示）</h3>
      ${state.project ? `
        <div class="row"><input id="mem-k" placeholder="键，如 构建命令"><input id="mem-v" placeholder="值，如 npm run build"><button class="btn tiny" id="mem-add">添加</button></div>
        ${mems.length ? `<table class="tbl"><tbody>${mems.map(m => `<tr><td><b>${esc(m.key)}</b></td><td>${esc(m.value)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">暂无记忆</div>'}`
      : '<div class="muted">未打开项目</div>'}
    </section>

    <section class="panel">
      <h3>权限审计（最近 ${audit.length} 条）</h3>
      ${audit.length ? `<table class="tbl"><thead><tr><th>时间</th><th>Agent</th><th>工具</th><th>目标</th><th>权限</th><th>结果</th></tr></thead><tbody>
        ${audit.slice(0, 60).map(a => `<tr><td class="muted small">${esc(fmtTime(a.time))}</td><td>${esc(a.agent)}</td><td>${esc(a.tool)}</td><td class="mono small">${esc(truncate(a.target, 40))}</td><td>${esc(a.permission)}</td><td>${a.result === 'ok' ? '<span class="chip ok">ok</span>' : '<span class="chip bad">fail</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="muted">暂无记录</div>'}
    </section>

    <section class="panel">
      <h3>数据与安全</h3>
      <table class="tbl kv">
        <tr><td>数据库文件</td><td class="mono small">${esc(info.dbPath)}</td></tr>
        <tr><td>密钥加密</td><td>${esc(info.secretBackend)}</td></tr>
        <tr><td>本地服务</td><td>仅绑定 127.0.0.1，随机端口，不对外暴露</td></tr>
      </table>
      <div class="muted small">默认权限策略：读文件/写文件/普通命令/网络 自动放行；删除文件、危险命令、Git 写入、浏览器、电脑操作 需要你确认。</div>
    </section>`;

  $('#p-add').onclick = () => promptForm(null);
  body.querySelectorAll('[data-pe]').forEach(b => b.onclick = () => promptForm(prompts.find(p => p.id === b.dataset.pe)));
  body.querySelectorAll('[data-pd]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除提示词', '确定？')) return;
    await api.promptRemove(b.dataset.pd); open('settings');
  });
  const memAdd = $('#mem-add');
  if (memAdd) memAdd.onclick = async () => {
    const k = $('#mem-k').value.trim(), v = $('#mem-v').value.trim();
    if (!k || !v) return toast('请填写键和值', 'warn');
    await window.api.invoke('memories:set', { layer: 'project', projectId: state.project.id, key: k, value: v });
    toast('已保存', 'ok'); open('settings');
  };
}

function promptForm(p) {
  const it = p || { name: '', content: '', description: '' };
  openModal(p ? '编辑提示词' : '新建提示词', `
    <label>名称<input id="pf-name" value="${esc(it.name)}"></label>
    <label>说明<input id="pf-desc" value="${esc(it.description || '')}"></label>
    <label>内容<textarea id="pf-content" rows="12">${esc(it.content)}</textarea></label>
  `, { okText: '保存' });
  onModalOk(async () => {
    const payload = { name: $('#pf-name').value.trim() || '未命名', description: $('#pf-desc').value, content: $('#pf-content').value };
    try {
      if (p) await api.promptUpdate(p.id, payload); else await api.promptCreate(payload);
      closeModal(); toast('已保存', 'ok'); open('settings');
    } catch (e) { toast(e.message, 'error'); }
  });
}
