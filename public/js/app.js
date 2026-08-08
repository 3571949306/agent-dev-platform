// Renderer entry point. Wires the IDE shell to the main process over IPC.
import { api, onEvent } from './api.js';
import { state } from './state.js';
import { $, $$, esc, toast, openModal, closeModal, onModalOk, confirmBox, fmtTime } from './util.js';
import * as chat from './chat.js';
import * as panels from './panels.js';
import * as files from './files.js';
import * as pages from './pages.js';

async function boot() {
  try {
    await api.systemInfo();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#eee">${esc(e.message)}</div>`;
    return;
  }

  panels.init();
  wireShell();
  onEvent(ev => {
    try { chat.handleEvent(ev); } catch (err) { console.error('event error', err, ev); }
    try { pages.handleDiagEvent(ev); } catch (err) { console.error('diag event error', err, ev); }
  });

  await refreshAgents();
  await restoreProject();
  await chat.loadConversations();
  renderAgentsPanel();

  // open the most recent conversation of this project, if any
  if (state.conversations.length) await chat.openConversation(state.conversations[0].id);
  else $('#messages').innerHTML = `<div class="chat-empty"><h2>开始一个任务</h2><p class="muted">先打开一个项目，然后用自然语言描述你要做的事。</p></div>`;

  window.addEventListener('agents-changed', () => refreshAgents().then(renderAgentsPanel));
}

/* ---------------- shell wiring ---------------- */
function wireShell() {
  $('#btn-project').onclick = projectMenu;
  $('#btn-newchat').onclick = () => chat.newChat();
  $('#btn-send').onclick = () => chat.send();
  $('#btn-stop').onclick = () => chat.stop();

  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chat.send(); }
  });
  $('#input').addEventListener('input', e => {
    const v = e.target.value;
    $('#composer-hint').textContent = v.startsWith('@') ? '用 @Agent名 前缀可把这条消息交给指定 Agent' : '';
  });

  $$('.ltab').forEach(b => b.onclick = async () => {
    $$('.ltab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#left-chats').classList.toggle('hidden', b.dataset.ltab !== 'chats');
    $('#left-files').classList.toggle('hidden', b.dataset.ltab !== 'files');
    if (b.dataset.ltab === 'files') await files.render();
  });

  $$('.topnav button').forEach(b => b.onclick = () => pages.open(b.dataset.page));

  $('#agent-select').onchange = e => { state.agentId = e.target.value; renderModelSelect(); };
  $('#model-select').onchange = async e => {
    const a = state.agents.find(x => x.id === state.agentId);
    if (a && e.target.value && a.type !== 'external') {
      await api.agentUpdate(a.id, { model: e.target.value });
      a.model = e.target.value;
      toast('已切换模型：' + e.target.value, 'ok');
    }
  };

  // clicking external links in rendered markdown
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-ext]');
    if (a) { e.preventDefault(); api.openExternal(a.getAttribute('href')); }
  });
}

/* ---------------- project ---------------- */
async function restoreProject() {
  let cur = await api.projectCurrent();
  if (!cur) {
    const last = await api.settingsGet('lastProjectId', null);
    if (last) { try { cur = await api.projectOpen(last); } catch {} }
  }
  if (cur) setProject(cur);
  else updateProjectButton();
}

function setProject(p) {
  state.project = p;
  updateProjectButton();
  api.settingsSet('lastProjectId', p.id).catch(() => {});
  panels.refreshTasks();
  panels.renderDiffPane();
}

function updateProjectButton() {
  const b = $('#btn-project');
  b.textContent = state.project ? state.project.name : '打开项目…';
  b.title = state.project ? state.project.root_path : '选择一个本地文件夹作为项目';
}

async function projectMenu() {
  const list = await api.projects();
  openModal('项目', `
    <div class="row"><button class="btn primary" id="pj-open">选择文件夹打开…</button></div>
    ${list.length ? `<table class="tbl"><tbody>${list.map(p => `<tr>
      <td><b>${esc(p.name)}</b><div class="muted small mono">${esc(p.root_path)}</div></td>
      <td class="muted small">${esc(fmtTime(p.last_opened_at))}</td>
      <td class="right"><button class="btn tiny" data-po="${p.id}">打开</button><button class="btn tiny danger" data-pr="${p.id}">移除</button></td>
    </tr>`).join('')}</tbody></table>` : '<div class="muted">还没有项目。选择一个本地代码文件夹开始。</div>'}
  `, { noFooter: true });

  $('#pj-open').onclick = async () => {
    const dir = await api.pickFolder();
    if (!dir) return;
    const existing = list.find(p => p.root_path === dir);
    const p = existing || await api.projectCreate({ name: dir.split(/[\\/]/).filter(Boolean).pop() || dir, rootPath: dir });
    const opened = await api.projectOpen(p.id);
    closeModal();
    setProject(opened);
    await chat.loadConversations();
    await files.render();
    toast('已打开项目：' + opened.name, 'ok');
  };
  $$('[data-po]').forEach(b => b.onclick = async () => {
    const opened = await api.projectOpen(b.dataset.po);
    closeModal(); setProject(opened);
    await chat.loadConversations();
    await files.render();
  });
  $$('[data-pr]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('移除项目', '仅从列表移除，不会删除磁盘上的文件。')) return;
    await api.projectRemove(b.dataset.pr);
    closeModal(); projectMenu();
  });
}

/* ---------------- agents ---------------- */
async function refreshAgents() {
  state.agents = await api.agents();
  const sel = $('#agent-select');
  if (!state.agents.length) {
    sel.innerHTML = `<option value="">（无 Agent，请到 Agents 页创建）</option>`;
    return;
  }
  const main = state.agents.find(a => a.is_main) || state.agents[0];
  if (!state.agentId || !state.agents.find(a => a.id === state.agentId)) state.agentId = main.id;
  sel.innerHTML = state.agents.map(a => `<option value="${a.id}" ${a.id === state.agentId ? 'selected' : ''}>${esc(a.name)}${a.is_main ? '（主）' : ''}${a.type === 'external' ? '（外部）' : ''}</option>`).join('');
  await renderModelSelect();
}

async function renderModelSelect() {
  const sel = $('#model-select');
  const a = state.agents.find(x => x.id === state.agentId);
  if (!a || a.type === 'external') { sel.innerHTML = `<option>—</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  let models = [];
  try {
    const conns = state.connections.length ? state.connections : (state.connections = await api.connections());
    const c = conns.find(x => x.id === a.api_connection_id);
    models = (c && c.models) || [];
  } catch {}
  if (a.model && !models.includes(a.model)) models = [a.model, ...models];
  if (!models.length) models = [a.model || '未设置模型'];
  sel.innerHTML = models.map(m => `<option value="${esc(m)}" ${m === a.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

function renderAgentsPanel() {
  const box = $('#agents-list');
  if (!state.agents.length) { box.innerHTML = `<div class="empty small">还没有 Agent</div>`; return; }
  box.innerHTML = state.agents.slice(0, 10).map(a => `
    <div class="ra ${a.id === state.agentId ? 'active' : ''}" data-a="${a.id}">
      <div class="ra-name">${esc(a.name)}</div>
      <div class="ra-sub">${a.is_main ? '主 Agent · ' : ''}${a.type === 'external' ? '外部' : (a.type === 'computer' ? '电脑操作' : '编码')} · ${(a.tools || []).length} 工具</div>
    </div>`).join('');
  box.querySelectorAll('.ra').forEach(n => n.onclick = () => {
    state.agentId = n.dataset.a;
    $('#agent-select').value = n.dataset.a;
    renderModelSelect();
    renderAgentsPanel();
  });
}

boot();
