// Full-screen management pages: Dashboard / API / Agents / MCP / Settings
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, toast, fmtTime, truncate, confirmBox, openModal, closeModal, onModalOk, prettyJson } from './util.js';
import { ZH, sourceName } from './i18n.js';

// v2.3.0: External Agent 状态卡 —— 把最近一次运行结果展示在列表卡片上
function extStatusBase(s) { return String(s || '').split(':')[0].trim(); }
function extStatusText(s) { return ZH.run[extStatusBase(s)] || extStatusBase(s) || '未知'; }
function extStatusClass(s) {
  const b = extStatusBase(s);
  return b === 'completed' ? 'ok' : (b === 'failed' || b === 'timeout' ? 'bad' : '');
}

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

// P1-5 — Diagnostics page: holds the live body + the (conn,model) being probed
// so streaming `diagnostics_progress` events from the main process can update
// the right rows without a full re-render.
let diagBody = null;
let diagActive = null;

const CAP_LABELS = { text: '文本生成', streaming: '流式输出', tools: '工具调用', vision: '视觉 / 多模态' };
const CAP_ORDER = ['text', 'streaming', 'tools', 'vision'];
const stateShort = s => ({ tested: '测', inferred: '推', declared: '声', unknown: '?' }[s] || s);

function stateBadge(state) {
  const map = { tested: ['ok', '已探测'], inferred: ['', '推断'], declared: ['', '声明'], unknown: ['warn', '未知'] };
  const [cls, label] = map[state] || ['', state];
  return `<span class="chip ${cls}">${label}</span>`;
}
function resultChip(cap) {
  if (!cap || cap.value === null || cap.value === undefined) return '<span class="muted">—</span>';
  if (cap.value === true) return '<span class="chip ok">✓ 支持</span>';
  return '<span class="chip bad">✗ 不支持</span>';
}
function fillCapsRows(rows, caps) {
  for (const name of CAP_ORDER) {
    const c = caps && caps[name];
    const tr = rows.querySelector(`[data-cap="${name}"]`);
    if (!tr) continue;
    tr.querySelector('.cap-state').innerHTML = c ? stateBadge(c.state) : '<span class="chip">未探测</span>';
    tr.querySelector('.cap-result').innerHTML = c ? resultChip(c) : '<span class="muted">—</span>';
    tr.querySelector('.cap-detail').textContent = c && c.detail ? c.detail : '';
  }
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = h('div', { class: 'page-overlay hidden' });
  overlay.innerHTML = `<div class="page-head"><h2 id="page-title"></h2><button class="btn" id="page-close">← 返回工作台</button></div><div class="page-body" id="page-body"></div>`;
  // v2.3.1: overlay 只覆盖工作区（#body），不能盖住 topbar — 否则页间导航被自己的 overlay 挡住
  (document.getElementById('body') || document.getElementById('app')).appendChild(overlay);
  overlay.querySelector('#page-close').onclick = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close(); });
  return overlay;
}

export function close() {
  if (overlay) overlay.classList.add('hidden');
  current = null;
  diagActive = null;
  $$('.topnav button').forEach(b => b.classList.remove('active'));
}

/**
 * P1-5 — live capability diagnostics page.
 * Lets the user pick a (connection, model) pair, fire a real probe against the
 * endpoint, watch each capability flip from 探测中 → 已探测 as the main process
 * streams `diagnostics_progress` events, and inspect the persisted probe log
 * plus the model-call audit (requested vs actual model, fallbacks).
 */
export function handleDiagEvent(ev) {
  if (!ev || ev.type !== 'diagnostics_progress') return;
  if (!diagBody || !diagActive) return;
  if (ev.connectionId !== diagActive.connectionId || ev.model !== diagActive.model) return;
  const rows = $('#diag-rows', diagBody);
  if (!rows) return;
  const tr = rows.querySelector(`[data-cap="${ev.name}"]`);
  if (!tr) return;
  if (ev.phase === 'running') {
    tr.querySelector('.cap-state').innerHTML = '<span class="chip run">探测中…</span>';
  } else if (ev.phase === 'done') {
    const c = ev.result;
    tr.querySelector('.cap-state').innerHTML = c ? stateBadge(c.state) : '<span class="chip">未探测</span>';
    tr.querySelector('.cap-result').innerHTML = c ? resultChip(c) : '<span class="muted">—</span>';
    tr.querySelector('.cap-detail').textContent = c && c.detail ? c.detail : '';
  }
}

async function renderDiagnostics(body) {
  diagActive = null;
  const connections = await api.connections();
  if (!connections.length) {
    body.innerHTML = `<div class="empty">还没有 API 连接。<a href="#" id="diag-goto-api">先到 API 页创建一个连接</a>。</div>`;
    const g = $('#diag-goto-api', body);
    if (g) g.onclick = e => { e.preventDefault(); open('connections'); };
    return;
  }
  body.innerHTML = `
    <div class="page-actions">
      <select id="diag-conn">${connections.map(c => `<option value="${c.id}">${esc(c.name)}（${esc(c.provider)}）</option>`).join('')}</select>
      <select id="diag-model"></select>
      <button class="btn primary" id="diag-run">开始探测</button>
      <span id="diag-status" class="muted small"></span>
    </div>
    <div class="warn-box">探测会对选中的连接发起真实请求：一段短文本、一次流式计数、一个工具定义、一张 1×1 图片。结果写入本地数据库，供运行时判断模型能力（如是否支持视觉）。</div>
    <section class="panel">
      <h3>能力矩阵</h3>
      <table class="tbl" id="diag-matrix"><thead><tr><th>能力</th><th>状态</th><th>结果</th><th>说明</th></tr></thead>
        <tbody id="diag-rows"><tr><td colspan="4" class="muted">选择连接与模型后点击「开始探测」。</td></tr></tbody></table>
    </section>
    <div class="grid2">
      <section class="panel">
        <h3>已探测记录（本地）</h3>
        <div id="diag-known"><div class="muted small">尚未加载。</div></div>
      </section>
      <section class="panel">
        <h3>模型调用记录</h3>
        <div id="diag-calls"><div class="muted small">尚未加载。</div></div>
        <h3 style="margin-top:12px">模型回退 / 不匹配</h3>
        <div id="diag-mismatch"><div class="muted small">尚无记录。</div></div>
      </section>
    </div>`;

  const connSel = $('#diag-conn', body), modelSel = $('#diag-model', body);
  function fillModels() {
    const c = connections.find(x => x.id === connSel.value);
    const models = (c && c.models && c.models.length) ? c.models : (c && c.default_model ? [c.default_model] : []);
    modelSel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') || '<option value="">（该连接无模型，先去 API 页拉取）</option>';
  }
  fillModels();
  connSel.onchange = fillModels;

  diagBody = body;
  await loadDiagExtras(body, connSel.value);
  $('#diag-run', body).onclick = () => runDiag(body);
}

async function runDiag(body) {
  const connId = $('#diag-conn', body).value;
  const model = $('#diag-model', body).value;
  if (!connId || !model) { toast('请先选择连接和模型', 'warn'); return; }
  diagActive = { connectionId: connId, model };
  const rows = $('#diag-rows', body);
  rows.innerHTML = CAP_ORDER.map(name => `<tr data-cap="${name}"><td><b>${CAP_LABELS[name]}</b></td><td class="cap-state"><span class="chip run">就绪</span></td><td class="cap-result"><span class="muted">—</span></td><td class="cap-detail muted small"></td></tr>`).join('');
  $('#diag-status', body).textContent = '探测中…（每个能力依次发起真实请求）';
  const btn = $('#diag-run', body);
  btn.disabled = true;
  try {
    const final = await api.diagCapabilities(connId, model);
    fillCapsRows(rows, final);
    $('#diag-status', body).textContent = `完成 · 耗时 ${final.durationMs != null ? final.durationMs : '?'}ms`;
    await loadDiagExtras(body, connId);
    toast('探测完成', 'ok');
  } catch (e) {
    $('#diag-status', body).textContent = '探测失败：' + e.message;
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadDiagExtras(body, connId) {
  const knownBox = $('#diag-known', body);
  const callsBox = $('#diag-calls', body);
  const misBox = $('#diag-mismatch', body);
  const fmtCap = (cap) => cap ? `${cap.value ? '✓' : '✗'}(${stateShort(cap.state)})` : '—';

  try {
    const known = await api.diagKnown(connId);
    knownBox.innerHTML = (known && known.length) ? `<table class="tbl"><thead><tr><th>模型</th><th>文本</th><th>流式</th><th>工具</th><th>视觉</th><th>探测时间</th></tr></thead><tbody>
      ${known.map(r => { const c = r.capabilities || {}; return `<tr><td class="mono small">${esc(r.model_id)}</td><td>${fmtCap(c.text)}</td><td>${fmtCap(c.streaming)}</td><td>${fmtCap(c.tools)}</td><td>${fmtCap(c.vision)}</td><td class="muted small">${esc(fmtTime(r.created_at))}</td></tr>`; }).join('')}</tbody></table>`
      : '<div class="muted small">该连接还没有任何探测记录。</div>';
  } catch (e) { knownBox.innerHTML = `<div class="muted small">加载失败：${esc(e.message)}</div>`; }

  try {
    const calls = await api.diagModelCalls(60);
    callsBox.innerHTML = calls.length ? `<table class="tbl"><thead><tr><th>时间</th><th>智能体</th><th>连接</th><th>请求模型</th><th>实际模型</th><th>来源</th><th>回退</th><th>图</th><th>延迟</th><th>结果</th></tr></thead><tbody>
      ${calls.map(r => `<tr class="${r.fell_back ? 'row-warn' : ''}">
        <td class="muted small">${esc(fmtTime(r.created_at))}</td>
        <td>${esc(r.agent_name || '—')}</td>
        <td>${esc(r.connection_name || '—')}</td>
        <td class="mono small">${esc(r.requested_model || '—')}</td>
        <td class="mono small">${esc(r.actual_model || '—')}</td>
        <td class="muted small">${esc(r.model_source || '—')}</td>
        <td>${r.fell_back ? '<span class="chip warn">回退</span>' : '—'}</td>
        <td class="muted small">${r.image_parts || 0}</td>
        <td class="muted small">${r.latency_ms != null ? r.latency_ms + 'ms' : '—'}</td>
        <td>${r.ok ? '<span class="chip ok">ok</span>' : '<span class="chip bad">fail</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="muted small">暂无调用记录。</div>';
  } catch (e) { callsBox.innerHTML = `<div class="muted small">加载失败：${esc(e.message)}</div>`; }

  try {
    const mis = await api.diagMismatches();
    misBox.innerHTML = mis.length ? `<table class="tbl"><thead><tr><th>时间</th><th>智能体</th><th>请求</th><th>实际</th><th>来源</th></tr></thead><tbody>
      ${mis.map(r => `<tr><td class="muted small">${esc(fmtTime(r.created_at))}</td><td>${esc(r.agent_name || '—')}</td><td class="mono small">${esc(r.requested_model)}</td><td class="mono small">${esc(r.actual_model)}</td><td class="muted small">${esc(r.model_source)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted small">没有模型回退或不匹配。</div>';
  } catch (e) { misBox.innerHTML = `<div class="muted small">加载失败：${esc(e.message)}</div>`; }
}

export async function open(page) {
  ensureOverlay();
  current = page;
  overlay.classList.remove('hidden');
  // v2.3.1: 每次打开页都把页面滚动复位到顶部，避免 sticky topbar 与 overlay 互相遮挡
  const body = $('#page-body');
  if (body) body.scrollTop = 0;
  $$('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const title = { dashboard: '总览', connections: 'API 连接', agents: '智能体', mcp: 'MCP 服务器', diagnostics: '能力诊断', settings: '设置' }[page] || page;
  $('#page-title').textContent = title;
  body.innerHTML = '<div class="muted">加载中…</div>';
  try {
    if (page === 'dashboard') await renderDashboard(body);
    else if (page === 'connections') await renderConnections(body);
    else if (page === 'agents') await renderAgents(body);
    else if (page === 'mcp') await renderMcp(body);
    else if (page === 'diagnostics') await renderDiagnostics(body);
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
      ${card(stats.agents, '智能体')}
      ${card(stats.externalAgents, '外部智能体')}
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
  state.connections = list;
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
          <button class="btn tiny" data-models="${c.id}">拉取模型</button>
          <button class="btn tiny" data-view="${c.id}">查看模型</button>
          <button class="btn tiny" data-test="${c.id}">测试</button>
          <button class="btn tiny" data-edit="${c.id}">编辑</button>
          <button class="btn tiny danger" data-del="${c.id}">删除</button>
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">还没有 API 连接，点击「新建连接」开始。</div>'}`;

  $('#conn-add').onclick = () => connForm(null);
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => connForm(list.find(c => c.id === b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除连接', '删除后使用该连接的智能体将无法运行，确定？')) return;
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
    try {
      const r = await api.connModels(b.dataset.models);
      toast(`已成功获取 ${r.models.length} 个模型`, 'ok');
      // 触发全局刷新
      window.dispatchEvent(new CustomEvent('models-updated', { detail: { connectionId: b.dataset.models } }));
    } catch (e) { toast(e.message, 'error'); }
    open('connections');
  });
  body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => modelManager(list.find(c => c.id === b.dataset.view)));
}

/** 模型管理弹窗 — v2.3.1: per-model source、真实来源筛选、收藏持久化(SQLite) */
function modelManager(conn) {
  if (!conn) return;
  // models 统一为对象数组 [{id, source, favorite, addedAt}]（store 已归一化）
  let models = (conn.models || []).map(m => (typeof m === 'string' ? { id: m, source: 'cached', favorite: false } : m));
  let filter = 'all';
  let search = '';
  const mid = (m) => (typeof m === 'string' ? m : (m && m.id) || '');

  // 统一渲染状态：从当前 conn 拉最新（收藏以 SQLite 为准，不用 localStorage）
  async function reload(connId) {
    const list = await api.connections();
    const c = list.find(x => x.id === connId);
    state.connections = list;
    if (c) models = (c.models || []).map(m => (typeof m === 'string' ? { id: m, source: 'cached', favorite: false } : m));
    return c;
  }

  function renderModelList() {
    const box = $('#mm-list');
    if (!box) return;
    let filtered = models;
    if (search) filtered = filtered.filter(m => mid(m).toLowerCase().includes(search.toLowerCase()));
    if (filter === 'fav') filtered = filtered.filter(m => m.favorite);
    else if (filter !== 'all') filtered = filtered.filter(m => (m.source || 'cached') === filter);

    if (!filtered.length) {
      box.innerHTML = `<div class="empty">没有匹配的模型</div>`;
      return;
    }

    box.innerHTML = filtered.map(m => {
      const id = mid(m);
      const src = m.source || 'cached';
      const isFav = !!m.favorite;
      return `<div class="mm-item">
        <div class="mm-name mono">${esc(id)}</div>
        <div class="mm-source"><span class="chip src-${esc(src)}">${esc(sourceName(src))}</span></div>
        <div class="mm-actions">
          <button class="btn tiny" data-copy="${esc(id)}" title="复制模型 ID">复制</button>
          <button class="btn tiny ${isFav ? 'fav-active' : ''}" data-fav="${esc(id)}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '★' : '☆'}</button>
        </div>
      </div>`;
    }).join('');

    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('已复制：' + b.dataset.copy, 'ok')).catch(() => toast('复制失败', 'error'));
    });
    box.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
      const m = b.dataset.fav;
      const old = models.find(x => mid(x) === m);
      const nv = old ? !old.favorite : true;
      try {
        await window.api.invoke('connections:setModelFavorite', conn.id, m, nv);
        await reload(conn.id);
        window.dispatchEvent(new CustomEvent('models-updated', { detail: { connectionId: conn.id } }));
        renderModelList();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  const presetNote = models.some(m => m.source === 'preset')
    ? `<div class="warn-box">以下包含内置推荐模型（可能不是当前账号全部可用模型）。</div>` : '';

  openModal(`模型管理 — ${conn.name}`, `
    <div class="mm-info">
      <span>已获取模型：<b>${models.length}</b> 个</span>
      <span class="muted">每模型独立来源：API 获取 / 手动添加 / 内置推荐 / 本地缓存</span>
    </div>
    ${presetNote}
    <div class="mm-toolbar">
      <input id="mm-search" placeholder="搜索模型" autocomplete="off">
      <div class="mm-filter">
        <button class="btn tiny ${filter === 'all' ? 'active' : ''}" data-filter="all">全部</button>
        <button class="btn tiny ${filter === 'remote' ? 'active' : ''}" data-filter="remote">API 获取</button>
        <button class="btn tiny ${filter === 'manual' ? 'active' : ''}" data-filter="manual">手动添加</button>
        <button class="btn tiny ${filter === 'preset' ? 'active' : ''}" data-filter="preset">内置推荐</button>
        <button class="btn tiny ${filter === 'cached' ? 'active' : ''}" data-filter="cached">本地缓存</button>
        <button class="btn tiny ${filter === 'fav' ? 'active' : ''}" data-filter="fav">收藏</button>
      </div>
      <button class="btn tiny" id="mm-refresh">刷新模型</button>
      <button class="btn tiny" id="mm-add">+ 手动添加</button>
    </div>
    <div id="mm-list" class="mm-list"></div>
  `, { noFooter: true });

  $('#mm-search').oninput = (e) => { search = e.target.value; renderModelList(); };
  $$('.mm-filter button').forEach(b => b.onclick = () => {
    filter = b.dataset.filter;
    $$('.mm-filter button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderModelList();
  });
  $('#mm-refresh').onclick = async () => {
    const btn = $('#mm-refresh');
    btn.textContent = '获取中…'; btn.disabled = true;
    try {
      // v2.3.1: merge 语义 —— 远端结果进 remote，手动添加的模型保留
      const r = await api.connModels(conn.id);
      await reload(conn.id);
      toast(`已成功获取 ${r.models.length} 个模型（手动添加的模型已保留）`, 'ok');
      window.dispatchEvent(new CustomEvent('models-updated', { detail: { connectionId: conn.id } }));
      closeModal();
      open('connections');
    } catch (e) { toast(e.message, 'error'); btn.textContent = '刷新模型'; btn.disabled = false; }
  };
  $('#mm-add').onclick = () => {
    openModal('手动添加模型', `
      <label>模型 ID<input id="mm-add-input" placeholder="例如：gpt-4o-2024-08-06"></label>
      <div class="muted small">手动添加的模型将标记为「手动添加」来源，刷新模型时不会被删除。</div>
    `, { okText: '添加' });
    onModalOk(async () => {
      const m = $('#mm-add-input').value.trim();
      if (!m) { toast('请输入模型 ID', 'warn'); return; }
      try {
        await window.api.invoke('connections:addModel', conn.id, m);
        await reload(conn.id);
        closeModal();
        modelManager({ ...conn, models });
        window.dispatchEvent(new CustomEvent('models-updated', { detail: { connectionId: conn.id } }));
      } catch (e) { toast(e.message, 'error'); }
    });
  };

  renderModelList();
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
      <button class="btn primary" id="agent-add">+ 新建智能体</button>
      <button class="btn" id="ext-add">+ 接入外部智能体</button>
    </div>
    <h3>本地智能体</h3>
    <div class="cards">${native.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b>${a.is_main ? '<span class="chip ok">主智能体</span>' : ''}${a.type === 'computer' ? '<span class="chip">电脑操作</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta">
          <span>模型：${esc(a.model || '未设置')}</span>
          <span>工具：${(a.tools || []).length}</span>
          <span>最大步数：${a.max_steps}</span>
          <span>子智能体：${(a.sub_agent_ids || []).length}</span>
        </div>
        <div class="acard-f"><button class="btn tiny" data-ae="${a.id}">编辑</button><button class="btn tiny danger" data-ad="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty">还没有智能体</div>'}</div>
    <h3>外部智能体（Codex / WorkBuddy / HTTP）</h3>
    <div class="cards">${ext.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b><span class="chip">${esc(a.adapter_type)}</span>${a.online ? '<span class="chip ok">在线</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta"><span class="mono small">${esc(a.command || a.endpoint || (a.config && a.config.cliPath) || '')}</span></div>
        ${a.last_status ? `<div class="acard-meta"><span class="chip ${extStatusClass(a.last_status)}">${esc(extStatusText(a.last_status))}</span>${a.last_run_at ? `<span class="muted small">${esc(fmtTime(a.last_run_at))}</span>` : ''}</div>` : ''}
        <div class="acard-f"><button class="btn tiny" data-ee="${a.id}">编辑</button><button class="btn tiny danger" data-ed="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty">没有外部智能体</div>'}</div>`;

  $('#agent-add').onclick = () => agentForm(null, { conns, prompts, tools, agents: native, extAgents: ext });
  $('#ext-add').onclick = () => extForm(null, conns);
  body.querySelectorAll('[data-ae]').forEach(b => b.onclick = () => agentForm(native.find(a => a.id === b.dataset.ae), { conns, prompts, tools, agents: native, extAgents: ext }));
  body.querySelectorAll('[data-ad]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除智能体', '确定删除该智能体？')) return;
    await api.agentRemove(b.dataset.ad); toast('已删除'); open('agents');
  });
  body.querySelectorAll('[data-ee]').forEach(b => b.onclick = () => extForm(ext.find(a => a.id === b.dataset.ee), conns));
  body.querySelectorAll('[data-ed]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除外部智能体', '确定删除？')) return;
    await api.extRemove(b.dataset.ed); toast('已删除'); open('agents');
  });
}

function agentForm(agent, ctx) {
  const a = agent || { name: '', description: '', max_steps: 40, temperature: 0.7, max_tokens: 4096, tools: [], sub_agent_ids: [], is_main: false, type: 'native' };
  const conn = ctx.conns.find(c => c.id === a.api_connection_id);
  const models = conn ? (conn.models || []) : [];
  const toolNames = [...new Set(ctx.tools.map(t => t.name))].sort();
  // 获取外部 Agent 列表，允许作为子智能体
  const extAgentsList = ctx.extAgents || [];
  openModal(agent ? '编辑智能体' : '新建智能体', `
    <div class="form2">
      <label>名称<input id="a-name" value="${esc(a.name)}"></label>
      <label>类型<select id="a-type"><option value="native" ${a.type !== 'computer' ? 'selected' : ''}>普通（编码）</option><option value="computer" ${a.type === 'computer' ? 'selected' : ''}>电脑操作</option></select></label>
      <label>API 连接<select id="a-conn"><option value="">未选择</option>${ctx.conns.map(c => `<option value="${c.id}" ${c.id === a.api_connection_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>模型
        <div class="model-picker" id="a-model-picker">
          <input id="a-model" value="${esc(a.model || '')}" placeholder="点击选择或输入模型 ID" autocomplete="off">
          <div class="model-dropdown hidden" id="a-model-dropdown"></div>
        </div>
      </label>
      <label>系统提示词<select id="a-prompt"><option value="">（用下面的描述）</option>${ctx.prompts.map(p => `<option value="${p.id}" ${p.id === a.system_prompt_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>最大步数<input id="a-steps" type="number" min="1" max="200" value="${a.max_steps ?? 40}"></label>
      <label>temperature<input id="a-temp" type="number" step="0.1" min="0" max="2" value="${a.temperature ?? 0.7}"></label>
      <label>max_tokens<input id="a-maxtok" type="number" min="256" max="128000" value="${a.max_tokens ?? 4096}"></label>
    </div>
    <label>描述 / 角色设定<textarea id="a-desc" rows="3">${esc(a.description || '')}</textarea></label>
    <label class="ck"><input type="checkbox" id="a-main" ${a.is_main ? 'checked' : ''}> 设为主智能体（新对话默认使用）</label>
    <details open><summary>工具（${toolNames.length}）</summary>
      <div class="chkgrid">${toolNames.map(n => `<label class="ck"><input type="checkbox" class="a-tool" value="${esc(n)}" ${(a.tools || []).includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <div class="row"><button class="btn tiny" id="a-tool-all">全选</button><button class="btn tiny" id="a-tool-none">全不选</button></div>
    </details>
    <details><summary>子智能体</summary>
      <div class="muted small">本地智能体：</div>
      <div class="chkgrid">${ctx.agents.filter(x => x.id !== a.id).map(x => `<label class="ck"><input type="checkbox" class="a-sub" value="${x.id}" ${(a.sub_agent_ids || []).includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="muted">无</span>'}</div>
      ${extAgentsList.length ? `<div class="muted small" style="margin-top:8px">外部智能体：</div><div class="chkgrid">${extAgentsList.map(x => `<label class="ck"><input type="checkbox" class="a-sub-ext" value="${x.id}" ${(a.sub_agent_ids || []).includes(x.id) ? 'checked' : ''}> ${esc(x.name)}（${esc(x.adapter_type)}）</label>`).join('')}</div>` : ''}
    </details>
  `, { okText: '保存' });

  $('#a-tool-all').onclick = () => $$('.a-tool').forEach(c => c.checked = true);
  $('#a-tool-none').onclick = () => $$('.a-tool').forEach(c => c.checked = false);

  // 模型选择器 — 替代 datalist（v2.3.1: models 为对象数组，统一取 id）
  const modelInput = $('#a-model');
  const modelDropdown = $('#a-model-dropdown');
  let currentModels = models;
  const mid = (m) => (typeof m === 'string' ? m : (m && m.id) || '');

  function renderModelDropdown(filter = '') {
    const f = (filter || '').toLowerCase();
    const filtered = f
      ? currentModels.filter(m => mid(m).toLowerCase().includes(f))
      : currentModels;

    if (!filtered.length) {
      modelDropdown.innerHTML = `<div class="mm-empty">${currentModels.length ? '没有匹配的模型' : '当前连接尚未获取模型。'} ${currentModels.length ? '' : '<button class="btn tiny" id="a-fetch-models">立即获取模型</button>'}</div>`;
      const fetchBtn = $('#a-fetch-models');
      if (fetchBtn) fetchBtn.onclick = async () => {
        const connId = $('#a-conn').value;
        if (!connId) return;
        try { const r = await api.connModels(connId); toast(`已获取 ${r.models.length} 个模型`, 'ok'); currentModels = r.models; renderModelDropdown(filter); window.dispatchEvent(new CustomEvent('models-updated')); } catch (e) { toast(e.message, 'error'); }
      };
      return;
    }

    modelDropdown.innerHTML = filtered.slice(0, 100).map(m => `<div class="mm-option" data-model="${esc(mid(m))}">${esc(mid(m))}${m.source ? `<span class="muted">（${esc(sourceName(m.source))}）</span>` : ''}</div>`).join('');
    modelDropdown.querySelectorAll('.mm-option').forEach(opt => opt.onclick = () => {
      modelInput.value = opt.dataset.model;
      modelDropdown.classList.add('hidden');
    });
  }

  modelInput.onfocus = () => {
    if (!currentModels.length && $('#a-conn').value) {
      // 无模型时提示获取
    }
    renderModelDropdown(modelInput.value);
    modelDropdown.classList.remove('hidden');
  };
  modelInput.oninput = () => renderModelDropdown(modelInput.value);
  modelInput.onblur = () => setTimeout(() => modelDropdown.classList.add('hidden'), 200);

  $('#a-conn').onchange = async () => {
    const c = ctx.conns.find(x => x.id === $('#a-conn').value);
    currentModels = c ? (c.models || []) : [];
    modelInput.value = '';
    // 如果该连接没有模型，尝试提示获取
    if (c && !currentModels.length) {
      renderModelDropdown('');
      modelDropdown.classList.remove('hidden');
    }
  };

  onModalOk(async () => {
    const payload = {
      name: $('#a-name').value.trim() || '新智能体',
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
      sub_agent_ids: [...$$('.a-sub').filter(c => c.checked).map(c => c.value), ...$$('.a-sub-ext').filter(c => c.checked).map(c => c.value)]
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
  const cfg = a.config || {};
  // 旧数据迁移：如果 command 有值但 config.cliPath 为空，自动迁移
  const cliPath = cfg.cliPath || a.command || '';
  const cliMode = cfg.cliMode || (cliPath ? 'path' : 'auto');
  openModal(agent ? '编辑外部智能体' : '接入外部智能体', `
    <label>名称<input id="e-name" value="${esc(a.name)}"></label>
    <label>适配器
      <select id="e-type">
        <option value="codex" ${a.adapter_type === 'codex' ? 'selected' : ''}>Codex CLI / OpenAI 兼容</option>
        <option value="workbuddy" ${a.adapter_type === 'workbuddy' ? 'selected' : ''}>WorkBuddy 桥接（窗口自动化）</option>
        <option value="http" ${a.adapter_type === 'http' ? 'selected' : ''}>HTTP 端点</option>
      </select></label>

    <div id="e-codex-section" ${a.adapter_type !== 'codex' ? 'class="hidden"' : ''}>
      <label>调用方式
        <select id="e-cli-mode">
          <option value="auto" ${cliMode === 'auto' ? 'selected' : ''}>自动检测 Codex CLI</option>
          <option value="path" ${cliMode === 'path' ? 'selected' : ''}>指定 Codex CLI 路径</option>
          <option value="api" ${cliMode === 'api' ? 'selected' : ''}>API 模式（通过 API 连接调用）</option>
        </select></label>
      <label id="e-cliPath-label">Codex CLI 路径<input id="e-cliPath" value="${esc(cliPath)}" placeholder="codex 或 C:\\...\\codex.exe"></label>
      <div id="e-api-section" class="${cliMode === 'api' ? '' : 'hidden'}">
        <label>API 连接<select id="e-conn"><option value="">不使用</option>${conns.map(c => `<option value="${c.id}" ${cfg.connectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>模型
          <div class="model-picker" id="e-model-picker">
            <input id="e-model" value="${esc(cfg.model || '')}" placeholder="点击选择模型" autocomplete="off">
            <div class="model-dropdown hidden" id="e-model-dropdown"></div>
          </div>
        </label>
      </div>
    </div>

    <div id="e-workbuddy-section" ${a.adapter_type !== 'workbuddy' ? 'class="hidden"' : ''}>
      <label>窗口标题<input id="e-wb-title" value="${esc(cfg.windowTitle || 'WorkBuddy')}" placeholder="WorkBuddy"></label>
      <label class="ck"><input type="checkbox" id="e-wb-vision" ${cfg.visionFallback !== false ? 'checked' : ''}> 视觉降级（UIA 读不到时自动截图+视觉模型）</label>
      <label>超时时间（秒）<input id="e-wb-timeout" type="number" min="30" max="600" value="${cfg.timeoutSec || 180}"></label>
      <details><summary>高级设置</summary>
        <label>Input AutomationId<input id="e-wb-input" value="${esc(cfg.inputAutomationId || '')}" placeholder="（留空自动检测）"></label>
        <label>Output AutomationId<input id="e-wb-output" value="${esc(cfg.outputAutomationId || '')}" placeholder="（留空自动检测）"></label>
        <label>Submit AutomationId<input id="e-wb-submit" value="${esc(cfg.submitAutomationId || '')}" placeholder="（留空自动检测）"></label>
        <label>Submit Keys<input id="e-wb-keys" value="${esc(cfg.submitKeys || '')}" placeholder="（留空使用回车）"></label>
        <label>轮询间隔（毫秒）<input id="e-wb-poll" type="number" min="500" max="10000" value="${cfg.pollIntervalMs || 1200}"></label>
      </details>
      <div class="row"><button class="btn" id="e-wb-test">测试 WorkBuddy 桥接</button></div>
      <div id="e-wb-test-result"></div>
    </div>

    <label>HTTP 端点（http 适配器用）<input id="e-ep" value="${esc(a.endpoint || '')}" placeholder="http://127.0.0.1:8080/run"></label>
    <label>说明<textarea id="e-desc" rows="2">${esc(a.description || '')}</textarea></label>
    <div class="warn-box">外部智能体通过命令行或窗口自动化调用，不会读取或转发你的 API 密钥；桥接不会递归调用本应用自身。</div>
  `, { okText: '保存' });

  // 适配器切换
  $('#e-type').onchange = (e) => {
    const v = e.target.value;
    $('#e-codex-section').classList.toggle('hidden', v !== 'codex');
    $('#e-workbuddy-section').classList.toggle('hidden', v !== 'workbuddy');
  };

  // Codex CLI 模式切换
  $('#e-cli-mode').onchange = (e) => {
    const mode = e.target.value;
    $('#e-cliPath-label').classList.toggle('hidden', mode === 'auto' || mode === 'api');
    $('#e-api-section').classList.toggle('hidden', mode !== 'api');
  };

  // Codex API 模式 — 模型选择器
  const eModelInput = $('#e-model');
  const eModelDropdown = $('#e-model-dropdown');
  const mid2 = (m) => (typeof m === 'string' ? m : (m && m.id) || '');
  if (eModelInput) {
    const renderEModels = (models, filter = '') => {
      const f = (filter || '').toLowerCase();
      const list = f ? models.filter(m => mid2(m).toLowerCase().includes(f)) : models;
      if (!list.length) { eModelDropdown.innerHTML = '<div class="mm-empty">没有匹配的模型</div>'; return; }
      eModelDropdown.innerHTML = list.slice(0, 100).map(m => `<div class="mm-option" data-model="${esc(mid2(m))}">${esc(mid2(m))}</div>`).join('');
    };
    eModelInput.onfocus = () => {
      const connId = $('#e-conn').value;
      if (!connId) { eModelDropdown.innerHTML = '<div class="mm-empty">请先选择 API 连接</div>'; eModelDropdown.classList.remove('hidden'); return; }
      const conn = conns.find(c => c.id === connId);
      const models = conn ? (conn.models || []) : [];
      if (!models.length) { eModelDropdown.innerHTML = '<div class="mm-empty">该连接尚未获取模型</div>'; eModelDropdown.classList.remove('hidden'); return; }
      renderEModels(models);
      eModelDropdown.classList.remove('hidden');
    };
    eModelInput.oninput = () => {
      const connId = $('#e-conn').value;
      if (!connId) return;
      const conn = conns.find(c => c.id === connId);
      const models = (conn ? conn.models : []) || [];
      renderEModels(models, eModelInput.value);
      eModelDropdown.classList.remove('hidden');
    };
    eModelInput.onblur = () => setTimeout(() => eModelDropdown && eModelDropdown.classList.add('hidden'), 200);
    eModelDropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.mm-option');
      if (opt) { eModelInput.value = opt.dataset.model; eModelDropdown.classList.add('hidden'); }
    });
  }

  // WorkBuddy 测试按钮
  const wbTestBtn = $('#e-wb-test');
  if (wbTestBtn) wbTestBtn.onclick = async () => {
    const result = $('#e-wb-test-result');
    result.innerHTML = '<div class="muted">正在查找 WorkBuddy…</div>';
    try {
      // 使用一个简单的测试命令
      const r = await window.api.invoke('externalAgents:test', a.id || 'workbuddy-test', { adapter_type: 'workbuddy', config: { windowTitle: $('#e-wb-title').value, visionFallback: $('#e-wb-vision').checked } });
      if (r.ok) result.innerHTML = `<div class="chip ok">WorkBuddy 桥接正常</div><div class="muted small">读取方式：${r.readVia || 'Windows UI 自动化'}　耗时：${r.elapsed || '?'} 秒</div>`;
      else result.innerHTML = `<div class="chip bad">失败</div><div class="err small">${esc(r.error || r.message || '')}</div>`;
    } catch (e) {
      result.innerHTML = `<div class="chip bad">失败</div><div class="err small">${esc(e.message)}</div>`;
    }
  };

  onModalOk(async () => {
    const adapterType = $('#e-type').value;
    const payload = {
      name: $('#e-name').value.trim() || '外部智能体',
      adapter_type: adapterType,
      endpoint: $('#e-ep').value.trim(),
      description: $('#e-desc').value,
    };
    // Codex: 保存到 config.cliPath，而非 command（修复配置不一致 Bug）
    if (adapterType === 'codex') {
      const cliMode = $('#e-cli-mode').value;
      const config = { cliMode };
      if (cliMode === 'path') config.cliPath = $('#e-cliPath').value.trim();
      if (cliMode === 'api') {
        config.connectionId = $('#e-conn').value || null;
        config.model = $('#e-model').value.trim();
      }
      payload.config = config;
      // 同时保留 command 字段以兼容旧 Runtime（如果存在）
      payload.command = cliMode === 'path' ? config.cliPath : '';
    } else if (adapterType === 'workbuddy') {
      payload.config = {
        windowTitle: $('#e-wb-title').value.trim() || 'WorkBuddy',
        visionFallback: $('#e-wb-vision').checked,
        timeoutSec: Number($('#e-wb-timeout').value) || 180,
        inputAutomationId: $('#e-wb-input').value.trim(),
        outputAutomationId: $('#e-wb-output').value.trim(),
        submitAutomationId: $('#e-wb-submit').value.trim(),
        submitKeys: $('#e-wb-keys').value.trim(),
        pollIntervalMs: Number($('#e-wb-poll').value) || 1200,
      };
      payload.command = '';
    } else {
      payload.config = { connectionId: $('#e-conn').value || null };
      payload.command = '';
    }
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
      <span class="muted">支持 stdio（本地进程）与 http（SSE）两种传输。连接后其工具会自动进入智能体可用工具列表。</span></div>
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
      ${audit.length ? `<table class="tbl"><thead><tr><th>时间</th><th>智能体</th><th>工具</th><th>目标</th><th>权限</th><th>结果</th></tr></thead><tbody>
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
