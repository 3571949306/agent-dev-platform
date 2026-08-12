// Chat view: history rendering, live agent event stream, send / stop.
import { api } from './api.js';
import { state, findAgent } from './state.js';
import { $, esc, h, md, toast, renderDiff, prettyJson, truncate, fmtTime, confirmBox } from './util.js';
import { toolName, eventName, runStatus, isTerminal, mainAgentStateName, mainAgentActionName } from './i18n.js';
import { preflightCheck } from './preflight.js';
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
      <div class="ci-sub">${esc(a ? a.name : '未指定智能体')} · ${esc(fmtTime(c.updated_at))}</div>
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
    <p class="muted">用自然语言描述你要做的事，主智能体会自己读文件、改代码、跑命令、验证结果。</p>
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
  if (!agentId) { toast('请先在「智能体」页面创建智能体', 'warn'); return; }
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
    `<div class="avatar ai">AI</div><div class="bubble"><div class="who">${esc(agent ? agent.name : '智能体')}</div><div class="md">${md(text)}</div></div>`);
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

  // ---- Agent Preflight（纯函数，models 作用域收敛在 preflight.js 内，杜绝 ReferenceError）----
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) { toast('智能体不存在', 'warn'); return; }

  // 外部智能体不需要模型检查
  if (agent.type !== 'external') {
    // 确保 connections 已加载
    if (!state.connections.length) {
      try { state.connections = await api.connections(); } catch {}
    }
    const conn = state.connections.find(c => c.id === agent.api_connection_id);
    const pf = preflightCheck(agent, conn);
    if (!pf.ok) {
      if (pf.code === 'no_conn') showPreflightBlock('no_conn');
      else if (pf.code === 'no_model') showPreflightBlock('no_model', { conn, models: pf.modelIds });
      else showPreflightBlock('no_models_in_conn', { conn });
      return;
    }
    // Case D: 模型不在最新列表 — 允许继续，仅提示，不阻断
    if (pf.hint === 'model_not_in_list') {
      toast(`当前模型「${agent.model}」不在最新列表中，将继续使用。`, 'warn');
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
  // runId 以主进程返回的为准（本地不预生成，避免终态防重入误判）
  startRun(state.conv.id);
  startWatchdog(state.conv.id);
  statusLine('准备中…');
  scrollBottom();

  // v2.9.9 Phase B（#1）— canonical Main Agent product entry：
  // 选中的是平台主智能体（is_main 且非 external）时，主产品入口进入
  // mainAgent:run → MainAgentService → runMainAgent → Orchestrator → Model Router → ProviderModelAdapter。
  // legacy/external/general chat 仍用 agent:send（兼容保留，不再决定主编码体验）。
  const isCanonicalMain = agent.is_main === true && agent.type !== 'external';
  try {
    const result = isCanonicalMain
      ? await api.mainRun({ conversationId: state.conv.id, agentId, goal: text })
      : await api.send(state.conv.id, agentId, text);
    // 主进程返回 runId，更新跟踪（终态防重入依赖它）
    const tracked = activeRuns.get(state.conv.id);
    if (result && result.runId && tracked) tracked.runId = result.runId;
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
  // v2.9.9 Phase B（#7）— canonical Main 的 Stop 必须走 mainAgent:stop：
  // Abort → children cancellation → descendant quiescence → Project Lock release → RunManager cancelled。
  // legacy/external 仍用 agent:stop。路由判据与 send() 保持一致。
  const agent = state.agents.find(a => a.id === state.agentId);
  const isCanonicalMain = !!(agent && agent.is_main === true && agent.type !== 'external');
  if (isCanonicalMain) await api.mainStop({ conversationId: state.conv.id });
  else await api.stop(state.conv.id);
  toast('已发送停止指令', 'warn');
}

function setRunning(v, label) {
  state.running = v;
  $('#btn-stop').classList.toggle('hidden', !v);
  $('#btn-send').disabled = v;
  $('#status-dot').className = 'dot' + (v ? ' busy' : '');
  // v2.3.1: 终态时状态栏显示中文终态标签（已完成/失败/已取消/超时/已中断），否则就绪
  $('#status-text').textContent = v ? '运行中' : (label || '就绪');
}

// Run 状态管理 — P0: 绑定 Spinner 到 Run 终态
const activeRuns = new Map(); // conversationId -> { runId, status, startedAt, lastActivityAt, watchdog }

export function getRun(convId) { return activeRuns.get(convId) || null; }

function startRun(convId, runId) {
  const now = Date.now();
  // runId 主进程返回后才会填充；填充前不拦截任何终态事件（快任务可能先到终态）
  const run = { runId: runId || null, status: 'preparing', startedAt: now, lastActivityAt: now, watchdog: null };
  activeRuns.set(convId, run);
  setRunning(true);
  return run;
}

function updateRunStatus(convId, status, message, runId) {
  const run = activeRuns.get(convId);
  if (!run) return;
  // P0-3: 一个 Run 只能进入一次终态。旧 Run 的迟到终态事件（runId 不匹配）
  // 绝不能关掉新 Run 的 Spinner。
  if (runId && run.runId && run.runId !== runId) return;
  run.status = status;
  run.lastActivityAt = Date.now();
  if (message) run.message = message;
  // 终态 → 停止 Spinner（唯一入口：正式 Run Terminal 事件）
  if (isTerminal(status)) {
    if (run.watchdog) { clearInterval(run.watchdog); run.watchdog = null; }
    activeRuns.delete(convId);
    setRunning(false, runStatus(status));
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
      // 超过 15 秒无活动 — 只提示，不擅自把 Run 变成 failed（P0-12）
      const secs = Math.floor(elapsed / 1000);
      const sl = $('#status-line');
      if (sl && state.conv && state.conv.id === convId) {
        sl.innerHTML = `<span class="spinner"></span>模型暂时没有返回。已经等待：${secs} 秒
          <button class="btn tiny danger" id="wd-stop">停止任务</button>`;
        const btn = sl.querySelector('#wd-stop');
        if (btn) btn.onclick = () => { stop(); toast('正在停止…', 'warn'); };
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
/* v2.6.0 Main Agent — 富 UI 卡片                                       */
/* ------------------------------------------------------------------ */

/** 计划卡片：展示目标 + 任务列表（taskUpdated 时实时更新） */
function planCard(goal, tasks) {
  const card = h('div', { class: 'ma-plan-card', dataset: { runGoal: String(goal || '').slice(0, 60) } });
  renderPlanCardBody(card, goal, tasks || []);
  return card;
}
function renderPlanCardBody(card, goal, tasks) {
  const taskRows = tasks.map((t, i) => {
    const status = t.status || 'pending';
    const chip = status === 'completed' ? '<span class="chip ok">✓</span>'
      : status === 'failed' ? '<span class="chip bad">✕</span>'
      : status === 'running' ? '<span class="chip run">●</span>'
      : '<span class="chip">○</span>';
    return `<div class="mp-task" data-tid="${esc(t.taskId || '')}" data-idx="${i}">${chip}<span class="mp-title">${esc(truncate(t.title || '', 80))}</span></div>`;
  }).join('');
  card.innerHTML = `
    <div class="mp-head"><span class="mp-ico">📋</span><b>计划</b><span class="mp-goal">${esc(truncate(goal || '', 100))}</span></div>
    <div class="mp-tasks">${taskRows || '<div class="muted small">（无任务）</div>'}</div>`;
}
function updatePlanCardTask(card, taskId, status, title) {
  if (!card) return;
  const tasks = state.mainAgent.planTasks;
  let t = tasks.find(x => x.taskId === taskId);
  if (!t) { t = { taskId, title: title || '', status }; tasks.push(t); }
  else { t.status = status || t.status; if (title) t.title = title; }
  renderPlanCardBody(card, card.dataset.runGoal || '', tasks);
}

/** Action 卡片：展示模型动作（thought + type + args），toolResult 填充结果 */
function mainActionCard(action) {
  const a = action || {};
  const type = a.type || 'unknown';
  const displayName = mainAgentActionName(type);
  const card = h('div', { class: 'ma-action-card running', dataset: { type } });
  const thought = a.thought ? `<div class="ma-thought">${esc(truncate(a.thought, 400))}</div>` : '';
  const argsSummary = mainActionArgsSummary(a);
  card.innerHTML = `
    <div class="ma-ac-head">
      <span class="ma-ac-type">${esc(displayName)}</span>
      <span class="ma-ac-args">${esc(truncate(argsSummary, 100))}</span>
      <span class="ma-ac-status">运行中…</span>
      <button class="ma-ac-toggle" title="展开/折叠">▾</button>
    </div>
    ${thought}
    <div class="ma-ac-body hidden"><pre class="ma-ac-in">${esc(prettyJson(a.args || {}))}</pre><div class="ma-ac-out"></div></div>`;
  card.querySelector('.ma-ac-toggle').onclick = () => card.querySelector('.ma-ac-body').classList.toggle('hidden');
  card.querySelector('.ma-ac-head').onclick = (e) => {
    if (e.target.classList.contains('ma-ac-toggle')) return;
    card.querySelector('.ma-ac-body').classList.toggle('hidden');
  };
  return card;
}
function mainActionArgsSummary(a) {
  const args = a.args || {};
  if (a.type === 'run_command' && args.command) return args.command;
  if ((a.type === 'read_file' || a.type === 'read_file_range') && args.path) return args.path;
  if ((a.type === 'create_file' || a.type === 'write_file') && args.path) return args.path;
  if (a.type === 'apply_patch' && args.path) return args.path;
  if (a.type === 'delete_file' && args.path) return args.path;
  if (a.type === 'move_file' && (args.from || args.source)) return args.from || args.source;
  if ((a.type === 'list_directory' || a.type === 'search_files') && args.path) return args.path;
  if (a.type === 'search_text' && (args.pattern || args.query)) return args.pattern || args.query;
  if (a.type === 'git_commit' && args.message) return truncate(args.message, 60);
  if (a.type === 'finish' && args.summary) return truncate(args.summary, 80);
  if (a.type === 'delegate' && args.task) return truncate(args.task, 80);
  const k = Object.keys(args)[0];
  return k ? `${k}=${truncate(String(args[k]), 50)}` : '';
}
function fillMainActionCard(card, result) {
  if (!card) return;
  card.classList.remove('running');
  const out = card.querySelector('.ma-ac-out');
  const status = card.querySelector('.ma-ac-status');
  let obj = null;
  try { obj = typeof result === 'string' ? JSON.parse(result) : result; } catch { obj = null; }
  const ok = !(obj && obj.ok === false);
  card.classList.add(ok ? 'done' : 'failed');
  status.textContent = ok ? '完成' : '失败';
  if (!ok && obj && obj.error) {
    const e = obj.error;
    status.textContent = '失败：' + (e.code || '');
    out.innerHTML = `<div class="ma-ac-err">${esc(e.message || JSON.stringify(obj))}</div>`;
    card.querySelector('.ma-ac-body').classList.remove('hidden');
  } else {
    const text = obj ? prettyJson(obj) : String(result || '');
    out.innerHTML = `<pre class="ma-ac-res">${esc(truncate(text, 4000))}</pre>`;
  }
}

/** 测试结果行（嵌入到 action card 的 out 区） */
function fillMainActionTestResult(card, ev) {
  if (!card) return;
  card.classList.remove('running');
  const out = card.querySelector('.ma-ac-out');
  const status = card.querySelector('.ma-ac-status');
  const passed = !!ev.passed;
  card.classList.add(passed ? 'done' : 'failed');
  status.textContent = passed ? '测试通过' : (ev.required ? '必需验证失败' : '测试失败');
  const errs = ev.errors ? `<pre class="ma-ac-err">${esc(truncate(ev.errors, 3000))}</pre>` : '';
  const sum = ev.summary ? `<pre class="ma-ac-res">${esc(truncate(ev.summary, 2000))}</pre>` : '';
  out.innerHTML = `<div class="ma-test ${passed ? 'ok' : 'fail'}">
    <div class="ma-test-head"><b>${passed ? '✓ 通过' : '✕ 失败'}</b> ${ev.required ? '<span class="chip bad">必需</span>' : ''}</div>
    <code class="ma-test-cmd">${esc(truncate(ev.command || '', 120))}</code>
    ${sum}${errs}
  </div>`;
  if (!passed) card.querySelector('.ma-ac-body').classList.remove('hidden');
}

/** 修复横幅 */
function repairBanner(round, reason) {
  return h('div', { class: 'ma-repair-banner' },
    `<span class="mr-ico">↻</span><span class="mr-text">第 <b>${esc(String(round))}</b> 轮自动修复</span>${reason ? `<span class="mr-reason">${esc(truncate(reason, 200))}</span>` : ''}`);
}

/* ------------------------------------------------------------------ */
/* live event stream                                                   */
/* ------------------------------------------------------------------ */

export function handleEvent(ev) {
  const mine = !ev.conversationId || (state.conv && ev.conversationId === state.conv.id);
  panels.pushLog(ev);

  // 更新活动时间
  if (mine && ev.conversationId) touchActivity(ev.conversationId);

  // v2.6.0 Main Agent 事件（mainAgent:* 命名空间）
  // 终态事件（runCompleted/Failed/Cancelled/Timeout）由 RunManager 的 run_* 标准事件统一处理，
  // 这里只处理富 UI 事件（计划/动作/测试/修复/时间线/状态）。
  if (typeof ev.type === 'string' && ev.type.startsWith('mainAgent:')) {
    handleMainAgentEvent(ev, mine);
    return;
  }

  // Run 状态事件 — 只有正式 Run Terminal 事件有权停 Spinner。
  // assistant_message / task_complete / tool_result 一律无权完成 Run（P0-3）。
  if (ev.type === 'run_state_changed' || ev.type === 'run_completed' || ev.type === 'run_failed' || ev.type === 'run_cancelled' || ev.type === 'run_timeout' || ev.type === 'run_interrupted') {
    if (mine && ev.conversationId) {
      const status = ev.type === 'run_completed' ? 'completed' :
                     ev.type === 'run_failed' ? 'failed' :
                     ev.type === 'run_cancelled' ? 'cancelled' :
                     ev.type === 'run_timeout' ? 'timeout' :
                     ev.type === 'run_interrupted' ? 'interrupted' :
                     ev.status || 'running';
      // 非终态只更新跟踪（不触发 Spinner 收尾）；终态才收尾
      updateRunStatus(ev.conversationId, status, ev.message, ev.runId);
      if (isTerminal(status)) {
        if (status === 'completed') { statusLine(''); loadConversations(); }
        else if (status === 'failed') { statusLine(''); if (ev.message) errorCard(ev.message); }
        else if (status === 'cancelled') { statusLine(''); appendNote('已停止'); loadConversations(); }
        else if (status === 'timeout') { statusLine(''); errorCard('模型服务响应超时。'); }
        else if (status === 'interrupted') { statusLine(''); appendNote('运行已中断'); loadConversations(); }
      }
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
      // assistant_message 只是模型消息事件，不是 Run Terminal 事件（P0-3）。
      // Run 是否结束只由主进程 Run Manager 的正式终态事件决定，这里不完成 Run。
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
      // Task 与 Run 是不同层：task_complete 只更新 Task UI（P0-3）。
      // Run 完成状态只由 Run Manager 统一发送。
      panels.updateTask(ev.taskId, ev.status || 'completed');
      break;
    case 'task_cancelled':
      panels.updateTask(ev.taskId, 'cancelled');
      break;

    case 'permission_request':
      askPermission(ev);
      break;

    case 'error':
      // v2.3.1 (P0-3): error 只是错误消息事件，不是 Run Terminal 事件。
      // Run 终态（failed/timeout/cancelled）只由主进程 Run Manager 统一宣布，
      // 否则 runtime 先发 error、后发 run_timeout 时，error 会抢先占据终态。
      if (mine) { errorCard(ev.message); }
      panels.addProblem(ev.message);
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* v2.6.0 Main Agent 事件分发                                           */
/* ------------------------------------------------------------------ */

function handleMainAgentEvent(ev, mine) {
  // 时间线事件无论是否属于当前对话都推入时间线面板（便于跨对话查看）
  if (ev.type === 'mainAgent:timeline') {
    panels.addTimelineEntry(ev.runId, ev.entry);
    return;
  }
  if (!mine) return;
  touchActivity(ev.conversationId);

  switch (ev.type) {
    case 'mainAgent:runStarted': {
      // 新 Run 开始：清空旧的 plan/action 跟踪 + 时间线
      state.mainAgent.runId = ev.runId || null;
      state.mainAgent.pendingActionEl = null;
      state.mainAgent.planEl = null;
      state.mainAgent.planTasks = [];
      panels.clearTimeline();
      // 绑定 Spinner 到此 Run（mainAgent:run 可能不经 chat send() 触发，
      // 所以这里独立启动 Run 跟踪 + Watchdog，终态由 RunManager 的 run_* 事件收尾）
      if (ev.conversationId) {
        startRun(ev.conversationId, ev.runId);
        startWatchdog(ev.conversationId);
      }
      statusLine('运行中…');
      break;
    }

    case 'mainAgent:stateChanged': {
      // 状态迁移 → 更新状态栏
      const label = mainAgentStateName(ev.state);
      statusLine(label ? `主智能体：${label}` : '运行中…');
      break;
    }

    case 'mainAgent:planCreated': {
      // 计划卡片
      const plan = ev.plan || {};
      state.mainAgent.planTasks = (plan.tasks || []).map(t => ({ taskId: t.taskId || t.id || '', title: t.title || '', status: t.status || 'pending' }));
      const card = planCard(plan.goal || state.mainAgent.runId || '任务', state.mainAgent.planTasks);
      state.mainAgent.planEl = card;
      appendBeforeStatus(card);
      break;
    }

    case 'mainAgent:taskUpdated': {
      // 更新计划卡片中的任务状态
      if (state.mainAgent.planEl) {
        updatePlanCardTask(state.mainAgent.planEl, ev.taskId, ev.status, ev.title);
      }
      // 同步到 Tasks 面板（复用现有基础设施）
      if (ev.taskId) {
        if (ev.status === 'completed' || ev.status === 'failed' || ev.status === 'cancelled') {
          panels.updateTask(ev.taskId, ev.status);
        } else {
          panels.addTask({ id: ev.taskId, title: ev.title || '', status: ev.status || 'running' });
        }
      }
      break;
    }

    case 'mainAgent:action': {
      // 新动作卡片（finish/delegate 不创建卡片，单独处理）
      const action = ev.action || {};
      if (action.type === 'finish') {
        // finish 动作：显示为智能体总结气泡
        if (action.args && action.args.summary) {
          const sl = $('#status-line');
          const b = assistantBubble(action.args.summary);
          if (sl) msgsEl().insertBefore(b, sl); else msgsEl().appendChild(b);
        }
        state.mainAgent.pendingActionEl = null;
        break;
      }
      const card = mainActionCard(action);
      state.mainAgent.pendingActionEl = card;
      appendBeforeStatus(card);
      break;
    }

    case 'mainAgent:toolResult': {
      // 填充当前 action 卡片
      if (state.mainAgent.pendingActionEl) {
        fillMainActionCard(state.mainAgent.pendingActionEl, { ok: ev.ok, summary: ev.summary, tool: ev.tool });
        state.mainAgent.pendingActionEl = null;
      }
      break;
    }

    case 'mainAgent:testResult': {
      // 测试结果 → 填充当前 action 卡片 + Problems
      if (state.mainAgent.pendingActionEl) {
        fillMainActionTestResult(state.mainAgent.pendingActionEl, ev);
        state.mainAgent.pendingActionEl = null;
      }
      if (!ev.passed) {
        panels.addProblem(`测试失败：${ev.command || ''}${ev.required ? '（必需验证）' : ''}`);
      }
      break;
    }

    case 'mainAgent:repairStart': {
      // 修复横幅
      appendBeforeStatus(repairBanner(ev.round || 1, ev.reason));
      break;
    }

    case 'mainAgent:fileChanged': {
      // 文件改动 → Diff 面板
      panels.addDiff({ path: ev.path, diff: ev.diff });
      break;
    }

    case 'mainAgent:checkpoint': {
      // 检查点：仅在时间线显示（已由 timeline 事件处理）
      break;
    }

    case 'mainAgent:permission': {
      // 权限请求 → 复用权限弹窗
      askPermission({ ...ev, scope: ev.scope, tool: ev.tool, args: ev.args, reqId: ev.reqId, agent: ev.agent });
      break;
    }

    case 'mainAgent:assistantText': {
      // v2.9.9 Phase B（#4）简洁聊天：中间 thought_summary 不作为永久 Chat 气泡，
      // 进入 Run Timeline 作为短状态文本；最终回复以 runCompleted / finish 的 summary 为准。
      if (ev.text) {
        panels.addTimelineEntry(ev.runId, { kind: 'info', icon: '💭', text: truncate(ev.text, 160), detail: '', t: Date.now() });
      }
      break;
    }

    // runCompleted/Failed/Cancelled/Timeout：RunManager 的 run_* 标准事件已处理终态，
    // 这里只补充 Main Agent 专属的富展示
    case 'mainAgent:runCompleted': {
      if (ev.summary) {
        const sl = $('#status-line');
        const b = assistantBubble(ev.summary);
        if (sl) msgsEl().insertBefore(b, sl); else msgsEl().appendChild(b);
        scrollBottom();
      }
      break;
    }

    case 'mainAgent:runFailed': {
      if (ev.error && !ev.errorCode) {
        // 已有 error 事件处理，这里不重复
      }
      break;
    }

    case 'mainAgent:runCancelled':
    case 'mainAgent:runTimeout':
      // 终态由 run_* 标准事件处理
      break;

    default:
      break;
  }
}

/** 在 status-line 之前插入元素（保持 spinner 在最底） */
function appendBeforeStatus(el) {
  const sl = $('#status-line');
  if (sl) msgsEl().insertBefore(el, sl); else msgsEl().appendChild(el);
  scrollBottom();
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
  'mcp': '调用 MCP 工具', 'subagent': '调用子智能体'
};

/** v2.8.1 §29 — 风险等级的中文标签与后果说明（deterministic，不由模型生成）。 */
const RISK_LABEL = { low: '低', medium: '中', high: '高', critical: '极高' };
const RISK_IMPACT = {
  low: '影响可控，通常只读或限于当前项目',
  medium: '会修改项目内文件或运行本地工具',
  high: '可能改动项目外内容、安装依赖或丢弃工作区改动',
  critical: '可能永久丢失数据或改变系统状态，无法自动回滚'
};

/** §28 — 外部智能体只允许「仅本次」；平台不会替用户建立持久授权。 */
const RANGE_BUTTONS = [
  { r: 'once', text: '仅本次允许' },
  { r: 'task', text: '本任务内允许' },
  { r: 'project', text: '本项目内允许' },
  { r: 'always', text: '始终允许' }
];

function askPermission(ev) {
  const label = SCOPE_LABEL[ev.scope] || ev.scope;
  const argsText = prettyJson(ev.args || {});
  const risk = String(ev.risk || '').toLowerCase();
  const allowed = Array.isArray(ev.ranges) && ev.ranges.length ? ev.ranges : null;
  const buttons = RANGE_BUTTONS.filter(b => !allowed || allowed.includes(b.r));

  // §29：风险等级 + 影响 + 判定原因；全部走 esc()，绝不把命令当 HTML 执行（§30）。
  const riskBlock = risk ? `
      <div class="perm-risk risk-${esc(risk)}">
        <span class="perm-risk-badge">风险：${esc(RISK_LABEL[risk] || risk.toUpperCase())}</span>
        <span class="perm-risk-impact">${esc(RISK_IMPACT[risk] || '')}</span>
      </div>` : '';
  const reasons = Array.isArray(ev.riskReasons) ? ev.riskReasons.filter(Boolean) : [];
  const reasonBlock = reasons.length
    ? `<ul class="perm-reasons">${reasons.map(r => `<li>${esc(String(r))}</li>`).join('')}</ul>`
    : '';
  // §30：命令原文独立展示、完整可读（长命令允许滚动，而不是截到看不懂）。
  const cmdBlock = ev.command
    ? `<div class="perm-sec-label">将要执行</div><pre class="perm-cmd">${esc(String(ev.command))}</pre>`
    : '';
  const cwdBlock = ev.cwd
    ? `<div class="perm-tool">工作目录 <code>${esc(String(ev.cwd))}</code></div>`
    : '';
  const argsBlock = argsText && argsText !== '{}'
    ? `<div class="perm-sec-label">完整参数</div><pre class="perm-args">${esc(truncate(argsText, 4000))}</pre>`
    : '';

  const body = `
    <div class="perm">
      <div class="perm-title">智能体「${esc(ev.agent || '')}」请求权限：<b>${esc(label)}</b></div>
      ${riskBlock}
      ${cmdBlock}
      ${reasonBlock}
      <div class="perm-tool">详细信息：工具 <code>${esc(ev.tool)}</code>　权限域 <code>${esc(ev.scope)}</code></div>
      ${cwdBlock}
      ${argsBlock}
      <div class="perm-opts">
        ${buttons.map(b => `<button class="btn" data-d="allow" data-r="${b.r}">${b.text}</button>`).join('')}
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
