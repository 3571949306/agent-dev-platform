// Chat view: history rendering, live agent event stream, send / stop.
import { api } from './api.js';
import { state, findAgent } from './state.js';
import { $, esc, h, md, toast, renderDiff, prettyJson, truncate, fmtTime, confirmBox } from './util.js';
import { toolName, eventName, runStatus, isTerminal } from './i18n.js';
import * as panels from './panels.js';
import * as pages from './pages.js';

const msgsEl = () => $('#messages');

/* ------------------------------------------------------------------ */
/* conversation list + history                                         */
/* ------------------------------------------------------------------ */

export async function loadConversations() {
  const pid = state.project ? state.project.id : undefined;
  state.conversations = await api.conversations(pid);
  renderChatList();
}

function renderChatList() {
  const box = $('#left-chats');
  if (!state.conversations.length) {
    box.innerHTML = `<div class="empty">还没有对话<br><span class="muted">点击「+ 新对话」开始</span></div>`;
    return;
  }
  box.innerHTML = state.conversations.map(c => {
    const a = findAgent(c.agent_id);
    const active = state.conv && state.conv.id === c.id ? ' active' : '';
    return `<div class="chat-item${active}" data-id="${c.id}">
      <div class="ci-title">${esc(c.title || '新对话')}</div>
      <div class="ci-sub">${esc(a ? a.name : '未指定 Agent')} · ${esc(fmtTime(c.updated_at))}</div>
      <button class="ci-del" data-del="${c.id}" title="删除">&times;</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.chat-item').forEach(n => {
    n.onclick = (e) => {
      if (e.target.dataset.del) return;
      openConversation(n.dataset.id);
    };
  });
  box.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!await confirmBox('删除对话', '该对话及其消息将被永久删除，确定？')) return;
      await api.convRemove(b.dataset.del);
      if (state.conv && state.conv.id === b.dataset.del) { state.conv = null; msgsEl().innerHTML = emptyChat(); }
      await loadConversations();
    };
  });
}

function emptyChat() {
  return `<div class="chat-empty">
    <h2>开始一个任务</h2>
    <p class="muted">用自然语言描述你要做的事，主 Agent 会自己读文件、改代码、跑命令、验证结果。</p>
    <div class="samples">
      <button class="sample">分析这个项目的结构，告诉我它是干什么的</button>
      <button class="sample">运行构建，如果失败就修复直到通过</button>
      <button class="sample">在 README 里补一节「快速开始」</button>
      <button class="sample">找出项目里所有 TODO 并列成清单</button>
    </div>
  </div>`;
}

export async function newChat() {
  if (!state.project) { toast('请先打开一个项目', 'warn'); return; }
  const agentId = state.agentId || (state.agents.find(a => a.is_main) || state.agents[0] || {}).id;
  if (!agentId) { toast('请先在 Agents 页创建一个 Agent', 'warn'); return; }
  const conv = await api.convCreate({ projectId: state.project.id, agentId, title: '新对话' });
  await loadConversations();
  await openConversation(conv.id);
}

export async function openConversation(id) {
  const conv = await api.convGet(id);
  if (!conv) return;
  state.conv = conv;
  if (conv.agent_id) {
    state.agentId = conv.agent_id;
    const sel = $('#agent-select');
    if (sel) sel.value = conv.agent_id;
  }
  renderChatList();
  await renderHistory(conv);
  panels.setActiveConversation(id);
}

async function renderHistory(conv) {
  const box = msgsEl();
  box.innerHTML = '';
  const msgs = conv.messages || [];
  if (!msgs.length) { box.innerHTML = emptyChat(); bindSamples(); return; }

  let events = [];
  try { events = await api.events(conv.id); } catch {}
  const results = events.filter(e => e.type === 'tool_result').map(e => {
    try { return JSON.parse(e.payload_json || '{}'); } catch { return {}; }
  });
  let ri = 0;

  for (const m of msgs) {
    if (m.role === 'user') { box.appendChild(userBubble(m.content)); continue; }
    if (m.role !== 'assistant') continue;
    if ((m.content || '').trim()) box.appendChild(assistantBubble(m.content));
    const tcs = m.tool_calls || [];
    for (const tc of tcs) {
      const card = toolCard(tc.name, safeArgs(tc.arguments));
      box.appendChild(card);
      const r = results[ri++];
      if (r) fillToolCard(card, r.result);
      else fillToolCard(card, null, '（无记录）');
    }
  }
  scrollBottom();
}

function safeArgs(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

function bindSamples() {
  msgsEl().querySelectorAll('.sample').forEach(b => {
    b.onclick = () => { $('#input').value = b.textContent; $('#input').focus(); };
  });
}

/* ------------------------------------------------------------------ */
/* bubbles / cards                                                     */
/* ------------------------------------------------------------------ */

function userBubble(text) {
  return h('div', { class: 'msg user' }, `<div class="avatar">你</div><div class="bubble">${esc(text).replace(/\n/g, '<br>')}</div>`);
}

function assistantBubble(text) {
  const agent = findAgent(state.agentId);
  return h('div', { class: 'msg assistant' },
    `<div class="avatar ai">AI</div><div class="bubble"><div class="who">${esc(agent ? agent.name : 'Agent')}</div><div class="md">${md(text)}</div></div>`);
}

function toolCard(name, args) {
  const card = h('div', { class: 'tool-card running', dataset: { tool: name } });
  const displayName = toolName(name);
  card.innerHTML = `
    <div class="tc-head">
      <span class="tc-ico">${toolIcon(name)}</span>
      <span class="tc-name" title="${esc(name)}">${esc(displayName)}</span>
      <span class="tc-args">${esc(truncate(argSummary(args), 120))}</span>
      <span class="tc-status">运行中…</span>
      <button class="tc-toggle" title="展开/折叠">▾</button>
    </div>
    <div class="tc-body hidden"><pre class="tc-in">${esc(prettyJson(args))}</pre><div class="tc-out"></div></div>`;
  card.querySelector('.tc-toggle').onclick = () => card.querySelector('.tc-body').classList.toggle('hidden');
  card.querySelector('.tc-head').onclick = (e) => {
    if (e.target.classList.contains('tc-toggle')) return;
    card.querySelector('.tc-body').classList.toggle('hidden');
  };
  return card;
}

function argSummary(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.path) return a.path;
  if (a.command) return a.command;
  if (a.query || a.pattern) return a.query || a.pattern;
  if (a.url) return a.url;
  if (a.task) return truncate(a.task, 80);
  const k = Object.keys(a)[0];
  return k ? `${k}=${truncate(String(a[k]), 60)}` : '';
}

function toolIcon(name) {
  const svg = (p) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">${p}</svg>`;
  if (/^read_file|^list_directory|^file_exists|^get_file_metadata/.test(name)) return svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>');
  if (/^write_file|^create_file|^apply_patch|^move_file|^copy_file/.test(name)) return svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>');
  if (/^delete_file/.test(name)) return svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>');
  if (/^terminal_/.test(name)) return svg('<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>');
  if (/^search_/.test(name)) return svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>');
  if (/^git_/.test(name)) return svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/><circle cx="18" cy="6" r="3"/>');
  if (/^browser_/.test(name)) return svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>');
  if (/^computer_/.test(name)) return svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/>');
  if (/^agent_/.test(name)) return svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>');
  return svg('<path d="M14.7 6.3a4 4 0 1 0 3 3L21 6l-3-3z"/>');
}

function fillToolCard(card, resultStr, note) {
  card.classList.remove('running');
  const out = card.querySelector('.tc-out');
  const status = card.querySelector('.tc-status');
  if (note && !resultStr) { status.textContent = note; card.classList.add('done'); return; }
  let obj = null;
  try { obj = JSON.parse(resultStr); } catch { obj = null; }
  const failed = obj && obj.ok === false;
  card.classList.add(failed ? 'failed' : 'done');
  if (failed) {
    const e = obj.error || {};
    status.textContent = '失败：' + (e.code || '');
    out.innerHTML = `<div class="tc-err">${esc(e.message || JSON.stringify(obj))}</div>`;
    card.querySelector('.tc-body').classList.remove('hidden');
  } else {
    status.textContent = '完成';
    const text = obj ? prettyJson(obj) : String(resultStr || '');
    out.innerHTML = `<pre class="tc-res">${esc(truncate(text, 4000))}</pre>`;
    if (obj && obj.data_url) out.innerHTML += `<img class="shot" src="${obj.data_url}" alt="screenshot">`;
  }
}

function statusLine(text) {
  let el = $('#status-line');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = h('div', { class: 'status-line', id: 'status-line' });
    msgsEl().appendChild(el);
  }
  el.innerHTML = `<span class="spinner"></span>${esc(text)}`;
  msgsEl().appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const b = msgsEl();
  b.scrollTop = b.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* send / stop                                                         */
/* ------------------------------------------------------------------ */

export async function send() {
  const input = $('#input');
  let text = input.value.trim();
  if (!text) return;
  if (!state.project) { toast('请先打开一个项目（左上角）', 'warn'); return; }

  // @AgentName prefix routes this message to a specific agent
  const at = text.match(/^@([^\s]+)\s+([\s\S]+)$/);
  let agentId = state.agentId;
  if (at) {
    const found = state.agents.find(a => a.name === at[1] || a.name.startsWith(at[1]));
    if (found) { agentId = found.id; text = at[2].trim(); $('#agent-select').value = found.id; state.agentId = found.id; }
  }
  if (!agentId) { toast('请选择一个智能体', 'warn'); return; }

  // ---- Agent Preflight ----
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) { toast('智能体不存在', 'warn'); return; }

  // 外部 Agent 不需要模型检查
  if (agent.type !== 'external') {
    // 检查 API Connection
    if (!agent.api_connection_id) {
      showPreflightBlock('no_conn');
      return;
    }
    // 确保 connections 已加载
    if (!state.connections.length) {
      try { state.connections = await api.connections(); } catch {}
    }
    const conn = state.connections.find(c => c.id === agent.api_connection_id);
    if (!conn) {
      showPreflightBlock('no_conn');
      return;
    }
    // 检查模型
    if (!agent.model || !agent.model.trim()) {
      const models = (conn.models || []);
      showPreflightBlock('no_model', { conn, models });
      return;
    }
    // 检查连接是否有模型列表
    if (!models.length) {
      showPreflightBlock('no_models_in_conn', { conn });
      return;
    }
  }

  if (!state.conv) {
    const conv = await api.convCreate({ projectId: state.project.id, agentId, title: text.slice(0, 30) });
    state.conv = { ...conv, messages: [] };
    await loadConversations();
    msgsEl().innerHTML = '';
  }
  if (msgsEl().querySelector('.chat-empty')) msgsEl().innerHTML = '';

  msgsEl().appendChild(userBubble(text));
  input.value = '';
  const runId = crypto.randomUUID();
  startRun(state.conv.id, runId);
  startWatchdog(state.conv.id);
  statusLine('准备中…');
  scrollBottom();

  try {
    const result = await api.send(state.conv.id, agentId, text);
    // 如果返回了 runId，更新跟踪
    if (result && result.runId && result.runId !== runId) {
      activeRuns.get(state.conv.id).runId = result.runId;
    }
    touchActivity(state.conv.id);
  } catch (e) {
    updateRunStatus(state.conv.id, 'failed', e.message);
    statusLine('');
    errorCard(e.message);
  }
}

/** Preflight 阻塞 — 不进入 Running，直接给用户解决入口 */
function showPreflightBlock(code, ctx = {}) {
  let html = '';
  if (code === 'no_conn') {
    html = `<div class="preflight-block">
      <div class="pf-icon">⚠</div>
      <div class="pf-msg">主智能体尚未配置 API 连接。</div>
      <button class="btn primary" id="pf-goto-api">配置 API</button>
    </div>`;
  } else if (code === 'no_model') {
    const connName = ctx.conn ? esc(ctx.conn.name) : '';
    const modelCount = ctx.models ? ctx.models.length : 0;
    html = `<div class="preflight-block">
      <div class="pf-icon">⚠</div>
      <div class="pf-msg">主智能体尚未选择模型。</div>
      <div class="pf-info">API 连接：${connName}　当前连接已获取：${modelCount} 个模型</div>
      <button class="btn primary" id="pf-select-model">选择模型</button>
      <button class="btn" id="pf-open-settings">打开智能体设置</button>
    </div>`;
  } else if (code === 'no_models_in_conn') {
    const connName = ctx.conn ? esc(ctx.conn.name) : '';
    html = `<div class="preflight-block">
      <div class="pf-icon">⚠</div>
      <div class="pf-msg">当前 API 连接尚未获取模型列表。</div>
      <div class="pf-info">API 连接：${connName}</div>
      <button class="btn primary" id="pf-fetch-models">立即获取模型</button>
      <button class="btn" id="pf-add-model">手动添加模型</button>
    </div>`;
  }
  const el = h('div', { class: 'preflight-wrap' }, html);
  msgsEl().appendChild(el);
  scrollBottom();
  const pf = el.querySelector('.preflight-block');
  if (pf) {
    const gotoApi = pf.querySelector('#pf-goto-api');
    if (gotoApi) gotoApi.onclick = () => { pages.open('connections'); };
    const selectModel = pf.querySelector('#pf-select-model');
    if (selectModel) selectModel.onclick = () => { pages.open('agents'); };
    const openSettings = pf.querySelector('#pf-open-settings');
    if (openSettings) openSettings.onclick = () => { pages.open('agents'); };
    const fetchModels = pf.querySelector('#pf-fetch-models');
    if (fetchModels && ctx.conn) fetchModels.onclick = async () => {
      el.remove();
      try { await api.connModels(ctx.conn.id); toast('已获取模型列表', 'ok'); state.connections = await api.connections(); }
      catch (e) { toast(e.message, 'error'); }
    };
    const addModel = pf.querySelector('#pf-add-model');
    if (addModel && ctx.conn) addModel.onclick = () => {
      el.remove();
      pages.open('connections');
    };
  }
}

export async function stop() {
  if (!state.conv) return;
  await api.stop(state.conv.id);
  toast('已发送停止指令', 'warn');
}

function setRunning(v) {
  state.running = v;
  $('#btn-stop').classList.toggle('hidden', !v);
  $('#btn-send').disabled = v;
  $('#status-dot').className = 'dot' + (v ? ' busy' : '');
  $('#status-text').textContent = v ? '运行中' : '就绪';
}

// Run 状态管理 — P0: 绑定 Spinner 到 Run 终态
const activeRuns = new Map(); // conversationId -> { runId, status, startedAt, lastActivityAt, watchdog }

export function getRun(convId) { return activeRuns.get(convId) || null; }

function startRun(convId, runId) {
  const now = Date.now();
  const run = { runId, status: 'preparing', startedAt: now, lastActivityAt: now, watchdog: null };
  activeRuns.set(convId, run);
  setRunning(true);
  return run;
}

function updateRunStatus(convId, status, message) {
  const run = activeRuns.get(convId);
  if (!run) return;
  run.status = status;
  run.lastActivityAt = Date.now();
  if (message) run.message = message;
  // 终态 → 停止 Spinner
  if (isTerminal(status)) {
    if (run.watchdog) { clearInterval(run.watchdog); run.watchdog = null; }
    activeRuns.delete(convId);
    setRunning(false);
    statusLine('');
  }
}

function startWatchdog(convId) {
  const run = activeRuns.get(convId);
  if (!run) return;
  if (run.watchdog) clearInterval(run.watchdog);
  run.watchdog = setInterval(() => {
    const elapsed = Date.now() - run.lastActivityAt;
    if (elapsed > 15000) {
      // 超过 15 秒无活动 — 不立刻失败，显示等待提示
      const secs = Math.floor(elapsed / 1000);
      const sl = $('#status-line');
      if (sl && state.conv && state.conv.id === convId) {
        sl.innerHTML = `<span class="spinner"></span>模型暂时没有返回。已经等待：${secs} 秒`;
      }
    }
  }, 5000);
}

function touchActivity(convId) {
  const run = activeRuns.get(convId);
  if (run) run.lastActivityAt = Date.now();
}

function errorCard(message) {
  msgsEl().appendChild(h('div', { class: 'err-card' }, `<strong>出错了</strong><div>${esc(message)}</div>`));
  scrollBottom();
}

/* ------------------------------------------------------------------ */
/* live event stream                                                   */
/* ------------------------------------------------------------------ */

export function handleEvent(ev) {
  const mine = !ev.conversationId || (state.conv && ev.conversationId === state.conv.id);
  panels.pushLog(ev);

  // 更新活动时间
  if (mine && ev.conversationId) touchActivity(ev.conversationId);

  // Run 状态事件 — 终态直接停止 Spinner
  if (ev.type === 'run_state_changed' || ev.type === 'run_completed' || ev.type === 'run_failed' || ev.type === 'run_cancelled' || ev.type === 'run_timeout') {
    if (mine && ev.conversationId) {
      const status = ev.type === 'run_completed' ? 'completed' :
                     ev.type === 'run_failed' ? 'failed' :
                     ev.type === 'run_cancelled' ? 'cancelled' :
                     ev.type === 'run_timeout' ? 'timeout' :
                     ev.status || 'completed';
      updateRunStatus(ev.conversationId, status, ev.message);
      if (status === 'completed') { statusLine(''); loadConversations(); }
      else if (status === 'failed') { statusLine(''); if (ev.message) errorCard(ev.message); }
      else if (status === 'cancelled') { statusLine(''); appendNote('已停止'); loadConversations(); }
      else if (status === 'timeout') { statusLine(''); errorCard('模型服务响应超时。'); }
    }
    return;
  }

  switch (ev.type) {
    case 'assistant_status':
      if (mine) { statusLine(ev.status || ''); touchActivity(ev.conversationId); }
      break;

    case 'assistant_text':
      if (!mine) break;
      touchActivity(ev.conversationId);
      if (!state.streamEl) {
        state.streamBuf = '';
        state.streamEl = assistantBubble('');
        const sl = $('#status-line');
        if (sl) msgsEl().insertBefore(state.streamEl, sl); else msgsEl().appendChild(state.streamEl);
      }
      state.streamBuf += ev.chunk || '';
      state.streamEl.querySelector('.md').innerHTML = md(state.streamBuf);
      scrollBottom();
      break;

    case 'assistant_message': {
      if (!mine) break;
      touchActivity(ev.conversationId);
      const content = (ev.content || '').trim();
      if (state.streamEl) {
        if (content) state.streamEl.querySelector('.md').innerHTML = md(ev.content);
        else state.streamEl.remove();
        state.streamEl = null;
        state.streamBuf = '';
      } else if (content) {
        const b = assistantBubble(ev.content);
        const sl = $('#status-line');
        if (sl) msgsEl().insertBefore(b, sl); else msgsEl().appendChild(b);
      }
      if (!ev.tool_calls || !ev.tool_calls.length) {
        // 没有 tool_calls → 本次回复完成
        if (mine) { updateRunStatus(ev.conversationId, 'completed'); loadConversations(); }
        statusLine('');
      }
      scrollBottom();
      break;
    }

    case 'tool_call': {
      if (!mine) break;
      touchActivity(ev.conversationId);
      const card = toolCard(ev.name, ev.args || {});
      if (ev.subAgentId) card.classList.add('from-sub');
      const sl = $('#status-line');
      if (sl) msgsEl().insertBefore(card, sl); else msgsEl().appendChild(card);
      state.pendingTools.push({ name: ev.name, el: card });
      scrollBottom();
      break;
    }

    case 'tool_result': {
      if (!mine) break;
      touchActivity(ev.conversationId);
      const idx = state.pendingTools.findIndex(p => p.name === ev.name);
      const p = idx >= 0 ? state.pendingTools.splice(idx, 1)[0] : null;
      if (p) fillToolCard(p.el, ev.result);
      panels.onToolResult(ev);
      scrollBottom();
      break;
    }

    case 'subagent_start': {
      if (!mine) break;
      touchActivity(ev.conversationId);
      const card = h('div', { class: 'agent-card running', dataset: { sub: ev.agentId } },
        `<div class="ac-head"><span class="ac-dot"></span><b>子智能体：${esc(ev.name)}</b><span class="ac-status">执行中…</span></div><div class="ac-body"></div>`);
      const sl = $('#status-line');
      if (sl) msgsEl().insertBefore(card, sl); else msgsEl().appendChild(card);
      scrollBottom();
      break;
    }

    case 'subagent_result': {
      if (!mine) break;
      touchActivity(ev.conversationId);
      const card = msgsEl().querySelector(`.agent-card.running[data-sub="${ev.agentId}"]`);
      if (card) {
        card.classList.remove('running');
        card.querySelector('.ac-status').textContent = '完成';
        let obj = null; try { obj = JSON.parse(ev.result); } catch {}
        card.querySelector('.ac-body').innerHTML = obj
          ? `<div class="ac-sum">${esc(obj.summary || obj.status || '')}</div>${(obj.changedFiles || []).length ? `<div class="muted">改动文件：${esc((obj.changedFiles || []).join(', '))}</div>` : ''}`
          : `<pre>${esc(truncate(ev.result, 1200))}</pre>`;
      }
      scrollBottom();
      break;
    }

    case 'file_changed':
      panels.addDiff(ev);
      break;

    case 'terminal_start':
    case 'terminal_output':
    case 'terminal_exit':
      panels.onTerminalEvent(ev);
      break;

    case 'task_start':
      touchActivity(ev.conversationId);
      panels.addTask({ id: ev.taskId, title: ev.title, status: 'running' });
      break;
    case 'task_complete':
      panels.updateTask(ev.taskId, ev.status || 'completed');
      if (mine) { updateRunStatus(ev.conversationId, 'completed'); loadConversations(); }
      break;
    case 'task_cancelled':
      panels.updateTask(ev.taskId, 'cancelled');
      if (mine) { updateRunStatus(ev.conversationId, 'cancelled'); appendNote('已停止'); loadConversations(); }
      break;

    case 'permission_request':
      askPermission(ev);
      break;

    case 'error':
      if (mine) { updateRunStatus(ev.conversationId, 'failed', ev.message); errorCard(ev.message); }
      panels.addProblem(ev.message);
      break;

    default:
      break;
  }
}

function appendNote(text) {
  msgsEl().appendChild(h('div', { class: 'note' }, esc(text)));
  scrollBottom();
}

/* ------------------------------------------------------------------ */
/* permission prompt                                                   */
/* ------------------------------------------------------------------ */

const SCOPE_LABEL = {
  'filesystem.read': '读取文件', 'filesystem.write': '写入文件', 'filesystem.delete': '删除文件',
  'filesystem.outside_workspace': '访问工作区外的路径', 'terminal.read': '运行只读命令',
  'terminal.write': '运行命令', 'terminal.dangerous': '运行高风险命令', 'terminal.admin': '以管理员运行',
  'git.read': '读取 Git', 'git.write': '写入 Git（提交/分支）', 'network': '访问网络',
  'browser': '控制浏览器', 'computer': '控制本机（键鼠/窗口）', 'clipboard': '访问剪贴板',
  'mcp': '调用 MCP 工具', 'subagent': '调用子 Agent'
};

function askPermission(ev) {
  const label = SCOPE_LABEL[ev.scope] || ev.scope;
  const argsText = prettyJson(ev.args || {});
  const body = `
    <div class="perm">
      <div class="perm-title">Agent「${esc(ev.agent || '')}」请求：<b>${esc(label)}</b></div>
      <div class="perm-tool">工具：<code>${esc(ev.tool)}</code>　权限域：<code>${esc(ev.scope)}</code></div>
      <pre class="perm-args">${esc(truncate(argsText, 1500))}</pre>
      <div class="perm-opts">
        <button class="btn" data-d="allow" data-r="once">仅本次允许</button>
        <button class="btn" data-d="allow" data-r="task">本任务内允许</button>
        <button class="btn" data-d="allow" data-r="project">本项目内允许</button>
        <button class="btn" data-d="allow" data-r="always">始终允许</button>
        <button class="btn danger" data-d="deny">拒绝</button>
      </div>
    </div>`;
  const modal = openPermModal(body);
  modal.querySelectorAll('.perm-opts .btn').forEach(b => {
    b.onclick = async () => {
      await api.permissionRespond(ev.reqId, b.dataset.d, b.dataset.r || 'once');
      closePermModal();
    };
  });
}

function openPermModal(bodyHtml) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  modal.innerHTML = `<div class="modal-head"><h3>需要你的确认</h3></div><div class="modal-body">${bodyHtml}</div>`;
  overlay.classList.remove('hidden');
  return modal;
}
function closePermModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal').innerHTML = '';
}
