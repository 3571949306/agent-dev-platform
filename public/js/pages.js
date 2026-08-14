// Full-screen management pages: Dashboard / API / Agents / MCP / Settings
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, toast, fmtTime, truncate, confirmBox, openModal, closeModal, onModalOk, prettyJson } from './util.js';
import { ZH, sourceName } from './i18n.js';
import * as theme from './theme.js';
import * as panels from './panels.js';
import { selectInspector } from './workspace.js';
// v2.9.9 Phase B（B40）— 统一状态词汇单一真源（不在页面内各写各的）
import { WORKFLOW_STEP_LABELS as WF_STEP_LABEL, WORKFLOW_RUN_LABELS as WF_RUN_LABEL, GENERATOR_STATUS_LABELS as GENERATOR_STATUS_LABEL } from './uiStatus.js';

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

// v2.4.1 — Smart Onboarding probe event handler (probeId-scoped).
// §48: Renderer binds currentProbeId; all events must match before processing.
let currentProbeId = null;
let probeEventCb = null;

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
  // v2.9.9 Phase B（B1）— 关闭管理页时清除活动栏中管理页按钮的选中态
  $$('#activity-bar .abtn[data-page]').forEach(b => b.classList.remove('active'));
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

/**
 * v2.4.1 — Smart Onboarding probe event handler。
 * §48: 所有事件必须确认 event.probeId === currentProbeId，否则忽略。
 * §47: Late Result Guard —— cancel 后迟到的事件不处理。
 */
export function handleProbeEvent(ev) {
  if (!ev || ev.type !== 'onboarding:probe:event') return;
  if (!probeEventCb) return;
  probeEventCb(ev);
}

async function renderDiagnostics(body) {
  diagActive = null;
  const [connections, product] = await Promise.all([
    api.connections(),
    api.diagProduct({ probeExternal: true, probeComputer: true })
  ]);
  // B20 — Health Center：每个子系统 Status / Reason / Last Checked / Action；未知就是 UNKNOWN
  const healthRow = (label, status, reason, lastChecked, action) => {
    const cls = ['OK', 'READY', 'AVAILABLE', 'FREE', 'OPEN', 'ACTIVE'].includes(status) ? 'ok'
      : (['UNKNOWN', 'NONE', 'UNSUPPORTED'].includes(status) ? '' : 'bad');
    return `<tr><td><b>${esc(label)}</b></td><td><span class="chip ${cls}">${esc(status == null ? 'UNKNOWN' : status)}</span></td><td class="small muted">${esc(reason || '—')}</td><td class="small muted">${lastChecked ? esc(fmtTime(lastChecked)) : '—'}</td><td class="small">${action || ''}</td></tr>`;
  };
  const residue = product.runtimeResidue || {};
  const residueItem = (label, value) => `<span class="chip small" title="${esc(label)}">${esc(label)}：${value === null || value === undefined ? 'UNKNOWN' : esc(String(value))}</span> `;
  const productPanel = `<section class="panel">
    <h3>Product Health Center · ${esc(product.version)} <button class="btn tiny" id="diag-selftest" title="safe / bounded / 0 paid calls">运行产品自检</button></h3>
    <div id="diag-selftest-out"></div>
    <table class="tbl"><thead><tr><th>子系统</th><th>状态</th><th>原因</th><th>最近检查</th><th>建议动作</th></tr></thead><tbody>
      ${healthRow('Application', product.application && product.application.status, product.application && product.application.reason, product.application && product.application.lastCheckedAt)}
      ${healthRow('Database', product.database && product.database.status, product.database && product.database.error, product.database && product.database.lastCheckedAt, product.database && product.database.status === 'ERROR' ? '重启应用' : '')}
      ${healthRow('Project', product.project && product.project.status, product.project && (product.project.name || product.project.reason), product.project && product.project.lastCheckedAt, product.project && product.project.status === 'NONE' ? '<a href="#" data-goto="connections">打开项目</a>' : '')}
      ${healthRow('主智能体', product.mainAgent && product.mainAgent.status, product.mainAgent && product.mainAgent.reason, product.mainAgent && product.mainAgent.lastCheckedAt, product.mainAgent && product.mainAgent.status === 'ERROR' ? '<a href="#" data-goto="agents">创建主智能体</a>' : '')}
      ${healthRow('Model Router', product.modelRouter && product.modelRouter.status, product.modelRouter && product.modelRouter.reason, product.modelRouter && product.modelRouter.lastCheckedAt, product.modelRouter && product.modelRouter.status === 'DEGRADED' ? '<a href="#" data-goto="connections">配置可用连接</a>' : '')}
      ${healthRow('Connections', product.modelConnections ? `${product.modelConnections.available}可用/${product.modelConnections.unavailable}不可用/${product.modelConnections.unknown}未知` : 'UNKNOWN', '状态只来自真实测试结果', product.modelConnections && product.modelConnections.lastCheckedAt, '<a href="#" data-goto="connections">管理连接</a>')}
      ${healthRow('Skills', product.skills && (product.skills.status || 'READY'), product.skills ? `${product.skills.count} 个，${product.skills.invalid == null ? 'UNKNOWN' : product.skills.invalid} 个无效` : '', product.skills && product.skills.lastCheckedAt, '<a href="#" data-goto="skills">管理 Skills</a>')}
      ${healthRow('Hooks', product.hooks && (product.hooks.status || 'READY'), product.hooks ? `${product.hooks.count} 个，${product.hooks.invalid == null ? 'UNKNOWN' : product.hooks.invalid} 个无效` : '', product.hooks && product.hooks.lastCheckedAt, '<a href="#" data-goto="skills">管理 Hooks</a>')}
      ${healthRow('Workflow', product.workflowRuntime && product.workflowRuntime.status, product.workflowRuntime && (product.workflowRuntime.error || `活跃 ${product.workflowRuntime.activeRuns} / 待审批 ${product.workflowRuntime.waitingApproval}`), product.workflowRuntime && product.workflowRuntime.lastCheckedAt, '<a href="#" data-goto="workflows">查看 Workflows</a>')}
      ${healthRow('Generator', product.generator && product.generator.status, product.generator ? `活动 ${product.generator.active || 0}` : '', product.generator && product.generator.lastCheckedAt, '<a href="#" data-goto="generator">打开 Generator</a>')}
      ${healthRow('AgentHub', product.agentHub && product.agentHub.status, product.agentHub ? `注册适配器 ${product.agentHub.registeredAdapters}` : '', product.agentHub && product.agentHub.lastCheckedAt, '<a href="#" data-goto="agents">查看智能体</a>')}
      ${healthRow('外部智能体', product.externalAgents && product.externalAgents.length ? product.externalAgents.map(e2 => `${e2.id}:${e2.status}`).join(' · ') : 'UNKNOWN', product.externalAgents && product.externalAgents.length ? '' : '未注册外部智能体', null, '<a href="#" data-goto="agents">管理外部智能体</a>')}
      ${healthRow('Computer', product.computerUse && product.computerUse.status, product.computerUse && (product.computerUse.error || (product.computerUse.windowCount != null ? `窗口 ${product.computerUse.windowCount}` : '')), product.computerUse && product.computerUse.lastCheckedAt)}
      ${healthRow('Browser', product.browser && product.browser.status, product.browser ? `installed=${product.browser.installed} launched=${product.browser.launched}` : '', product.browser && product.browser.lastCheckedAt)}
      ${healthRow('MCP', product.mcp && product.mcp.status, product.mcp ? `已连接 ${product.mcp.connected}` : '', product.mcp && product.mcp.lastCheckedAt, '<a href="#" data-goto="mcp">管理 MCP</a>')}
      ${healthRow('Terminal', product.terminal && product.terminal.status, product.terminal && product.terminal.activeProcesses != null ? `活动进程 ${product.terminal.activeProcesses}` : '', product.terminal && product.terminal.lastCheckedAt)}
      ${healthRow('Project Locks', product.projectLock && product.projectLock.status, product.projectLock ? `锁计数 ${product.projectLock.count}` : '', product.projectLock && product.projectLock.lastCheckedAt)}
      ${healthRow('Processes', product.processes && product.processes.status, product.processes ? `main pid ${product.processes.mainPid} · terminal ${product.processes.terminalChildren} · computer ${product.processes.computerChildren}` : '', product.processes && product.processes.lastCheckedAt)}
    </tbody></table>
    <h3 style="margin-top:12px">Runtime Residue（真实残留，非估计）</h3>
    <div>${residueItem('Active Runs', residue.activeRuns)}${residueItem('Stale Runs', (residue.staleRuns || []).length)}${residueItem('Dynamic Instances', residue.dynamicInstances)}${residueItem('AgentHub Adapters', residue.agentHubAdapters)}${residueItem('Project Locks', residue.projectLocks)}${residueItem('Terminal Processes', residue.terminalProcesses)}${residueItem('Pending Permissions', residue.pendingPermissions)}${residueItem('Workflow Approval', residue.pendingWorkflowApproval)}${residueItem('Generator Active', residue.generatorActive)}</div>
  </section>`;
  if (!connections.length) {
    body.innerHTML = productPanel + `<div class="empty" data-page-state="empty">还没有 API 连接。<a href="#" id="diag-goto-api">先到 API 页创建一个连接</a>。</div>`;
    const g = $('#diag-goto-api', body);
    if (g) g.onclick = e => { e.preventDefault(); open('connections'); };
  } else {
    body.innerHTML = productPanel + `
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
      const models = (c && c.models && c.models.length) ? c.models.map(m => (typeof m === 'string' ? m : m.id)) : (c && c.default_model ? [c.default_model] : []);
      modelSel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') || '<option value="">（该连接无模型，先去 API 页拉取）</option>';
    }
    fillModels();
    connSel.onchange = fillModels;

    diagBody = body;
    await loadDiagExtras(body, connSel.value);
    $('#diag-run', body).onclick = () => runDiag(body);
  }
  // 页面内跳转链接（建议动作）
  body.querySelectorAll('[data-goto]').forEach(a => a.onclick = e => { e.preventDefault(); open(a.dataset.goto); });
  // B20.2 — Quick Self Test：safe / bounded / 0 paid calls
  const selfBtn = $('#diag-selftest', body);
  if (selfBtn) selfBtn.onclick = async () => {
    const out = $('#diag-selftest-out', body);
    selfBtn.disabled = true; out.innerHTML = '<div class="muted small">自检中…（不发起付费调用）</div>';
    try {
      const r = await api.diagSelfTest();
      out.innerHTML = `<div class="${r.ok ? 'muted' : 'error-box'} small">自检${r.ok ? '通过' : '发现 ' + r.failed + ' 个问题'} · ${r.durationMs}ms · paid calls: ${r.paidProviderCalls}</div>
        <table class="tbl"><thead><tr><th>检查项</th><th>结果</th><th>详情</th></tr></thead><tbody>
        ${r.results.map(x => `<tr><td>${esc(x.name)}</td><td>${x.ok ? '<span class="chip ok small">PASS</span>' : '<span class="chip bad small">FAIL</span>'}</td><td class="small muted">${esc(x.detail)}</td></tr>`).join('')}
        </tbody></table>`;
    } catch (e) { out.innerHTML = `<div class="error-box small">${esc(e.message)}</div>`; }
    finally { selfBtn.disabled = false; }
  };
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
  const title = { dashboard: '总览', connections: 'API 连接', agents: '智能体', mcp: 'MCP 服务器', skills: 'Skills', workflows: 'Workflows', generator: 'AI Generator', diagnostics: '能力诊断', settings: '设置' }[page] || page;
  $('#page-title').textContent = title;
  // B23 — LOADING 态：统一标记，机器可验
  body.innerHTML = '<div class="muted" data-page-state="loading">加载中…</div>';
  try {
    if (page === 'dashboard') await renderDashboard(body);
    else if (page === 'connections') await renderConnections(body);
    else if (page === 'agents') await renderAgents(body);
    else if (page === 'mcp') await renderMcp(body);
    else if (page === 'skills') await renderSkills(body);
    else if (page === 'workflows') await renderWorkflows(body);
    else if (page === 'generator') await renderGenerator(body);
    else if (page === 'diagnostics') await renderDiagnostics(body);
    else if (page === 'settings') await renderSettings(body);
    // B48 — last activity 持久化（绝不持久化任何密钥类数据）
    api.settingsSet('ui.lastPage', page).catch(() => {});
  } catch (e) {
    // B23 — ERROR 态：error code + 简短解释 + 安全时重试，绝不一闪而过
    const code = (e && e.code) || 'PAGE_ERROR';
    body.innerHTML = `<div class="page-error" data-page-state="error">
      <div class="err"><b>${esc(code)}</b>：${esc(e.message || '页面加载失败')}</div>
      <div class="muted small">页面数据来自 backend IPC；错误不影响其它页面。</div>
      <button class="btn" id="page-retry">重试</button>
    </div>`;
    $('#page-retry').onclick = () => open(page);
  }
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
/* ------------------------------------------------------------------ */
/* v2.9.9 Phase B Final（B15）— Connection Manager 3.0                 */
/* B15.1 状态词汇只来自真实测试真话；B15.3/B15.4 密钥/请求头值永远掩码；*/
/* B15.9 默认连接/模型只是偏好，绝不旁路 Model Router。                */
/* ------------------------------------------------------------------ */

const CONN_HEADER_MASK = '••••••••';

function connStatusChip(c) {
  const st = (c.status && c.status.status) || 'UNKNOWN';
  const label = ZH.connStatus[st] || st;
  const cls = st === 'AVAILABLE' ? 'ok' : (st === 'DEGRADED' ? 'warn' : (st === 'UNKNOWN' ? '' : 'bad'));
  const detail = [];
  if (c.status && typeof c.status.latencyMs === 'number') detail.push(`延迟 ${c.status.latencyMs}ms`);
  if (c.status && c.status.reason && (st === 'UNAVAILABLE' || st === 'ERROR')) detail.push(c.status.reason);
  return `<span class="chip ${cls}" title="${esc(detail.join(' · '))}">${esc(label)}</span>`;
}

function connLatencyCell(c) {
  const ms = c.status && typeof c.status.latencyMs === 'number' ? c.status.latencyMs : null;
  return ms === null ? '<span class="muted small">—</span>' : `<span class="mono small">${ms}ms</span>`;
}

function connDefaultPicker(conn) {
  // B15.9 — 设默认只写偏好（settings 真源）；实际运行仍由 Model Router 裁决
  const models = (conn.models || []).map(m => (typeof m === 'string' ? m : (m && m.id) || '')).filter(Boolean);
  const favs = (conn.models || []).filter(m => m && m.favorite).map(m => m.id);
  const ordered = [...new Set([...favs, ...models])];
  openModal(`设置默认连接 — ${conn.name}`, `
    <div class="muted small">默认连接/模型只是路由偏好：Main Run 仍会经过 Model Router 的硬约束与打分，绝不旁路。</div>
    <label>默认模型（可选）
      <select id="def-model">
        <option value="">不指定（由 Router 自动选择）</option>
        ${ordered.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
      </select>
    </label>
  `, { okText: '设为默认' });
  onModalOk(async () => {
    try {
      await api.connSetDefault(conn.id, $('#def-model').value || null);
      closeModal(); toast('已设为默认连接（路由偏好）', 'ok'); open('connections');
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function renderConnections(body) {
  const list = await api.connections();
  state.connections = list;
  body.innerHTML = `
    <div class="page-actions"><button class="btn primary" id="conn-smart">⚡ 快速接入</button><button class="btn" id="conn-external">📥 从其他工具导入</button><button class="btn" id="conn-add">+ 手动新建</button>
      <span class="muted">API Key 与自定义请求头均加密存储（Windows DPAPI），保存后界面只显示掩码。</span></div>
    ${list.length ? `<table class="tbl"><thead><tr><th>名称</th><th>协议</th><th>Base URL</th><th>认证</th><th>状态</th><th>延迟</th><th>模型</th><th>最近测试</th><th>来源</th><th></th></tr></thead><tbody>
      ${list.map(c => `<tr>
        <td><b>${esc(c.name)}</b>${c.is_default ? ' <span class="chip ok small" title="默认连接只是路由偏好，不旁路 Model Router">默认</span>' : ''}</td>
        <td>${esc((PROVIDERS.find(p => p[0] === c.provider) || [c.provider, c.provider])[1])}</td>
        <td class="mono small">${esc(c.base_url)}</td>
        <td><span class="chip small">${esc(ZH.connAuthMode[c.authMode] || c.authMode || '未知')}</span></td>
        <td>${connStatusChip(c)}</td>
        <td>${connLatencyCell(c)}</td>
        <td>${(c.models || []).length}</td>
        <td class="small muted">${c.status && c.status.lastTestedAt ? esc(fmtTime(c.status.lastTestedAt)) : '从未测试'}</td>
        <td>${c.import_source ? `<span class="chip small">${esc(c.import_source)}</span>` : '<span class="muted small">手动</span>'}</td>
        <td class="right">
          <button class="btn tiny" data-test="${c.id}">测试连接</button>
          <button class="btn tiny" data-models="${c.id}">获取模型</button>
          <button class="btn tiny" data-view="${c.id}">查看模型</button>
          <button class="btn tiny" data-edit="${c.id}">编辑</button>
          ${c.is_default
            ? `<button class="btn tiny" data-undef="${c.id}">取消默认</button>`
            : `<button class="btn tiny" data-def="${c.id}">设为默认</button>`}
          <button class="btn tiny danger" data-del="${c.id}">删除</button>
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty" data-page-state="empty">尚未配置模型连接。<br><br><button class="btn primary" id="conn-add-empty">添加连接</button></div>'}`;

  $('#conn-smart').onclick = () => smartOnboard();
  $('#conn-external').onclick = () => externalImport();
  $('#conn-add').onclick = () => connForm(null);
  const emptyBtn = $('#conn-add-empty'); if (emptyBtn) emptyBtn.onclick = () => connForm(null);
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => connForm(list.find(c => c.id === b.dataset.edit)));
  body.querySelectorAll('[data-def]').forEach(b => b.onclick = () => connDefaultPicker(list.find(c => c.id === b.dataset.def)));
  body.querySelectorAll('[data-undef]').forEach(b => b.onclick = async () => {
    try { await api.connSetDefault(null, null); toast('已取消默认连接', 'ok'); open('connections'); }
    catch (e) { toast(e.message, 'error'); }
  });
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除连接', {
      target: `连接「${(list.find(c => c.id === b.dataset.del) || {}).name || b.dataset.del}」`,
      consequence: '使用该连接的智能体将无法运行；连接配置与其模型列表将被删除。',
      reversibility: '不可逆：密钥密文一并删除，需重新创建并重新测试。'
    })) return;
    await api.connRemove(b.dataset.del); toast('已删除'); open('connections');
  });
  body.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
    // B15.5 — 真实调用 provider test contract；结果刷新后由状态词汇如实呈现
    b.textContent = ZH.connStatus.testing + '…'; b.disabled = true;
    try {
      const r = await api.connTest(b.dataset.test);
      if (r.ok) toast(`可用，延迟 ${r.latency}ms`, 'ok');
      else {
        toast('不可用：' + r.message, 'error');
        // B43 — 连接失败绝不只 toast：同步进 Problems 持久真源
        panels.addProblem(`连接测试失败：${r.message}`, { code: 'CONNECTION_TEST_FAILED', relatedKey: b.dataset.test });
      }
    } catch (e) {
      toast(e.message, 'error');
      panels.addProblem(`连接测试异常：${e.message}`, { code: 'CONNECTION_TEST_ERROR', relatedKey: b.dataset.test });
    }
    open('connections');
  });
  body.querySelectorAll('[data-models]').forEach(b => b.onclick = async () => {
    b.textContent = '获取中…'; b.disabled = true;
    try {
      const r = await api.connModels(b.dataset.models);
      // B15.6 — 来源真话：回退模型不得被描述成刚从 API 获取；其余保持既有成功文案
      if (r.source === 'preset') toast(`已成功获取 ${r.models.length} 个模型（回退：内置推荐，非 API 实时获取）`, 'warn');
      else toast(`已成功获取 ${r.models.length} 个模型`, 'ok');
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
      box.innerHTML = `<div class="empty" data-page-state="empty">没有匹配的模型</div>`;
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
    ? `<div class="warn-box">回退模型来自内置推荐列表，不是刚从 API 获取；可能不是你账号的全部可用模型。</div>` : '';

  // B15.6 — 数据来源真话：REMOTE / MANUAL / FALLBACK / UNKNOWN 分别计数，绝不混淆
  const srcCount = (s) => models.filter(m => (m.source || 'cached') === s).length;
  const srcSummary = `API 获取 ${srcCount('remote')} · 手动 ${srcCount('manual')} · 回退 ${srcCount('preset')} · 未知 ${srcCount('cached')}`;

  openModal(`模型管理 — ${conn.name}`, `
    <div class="mm-info">
      <span>模型总数：<b>${models.length}</b> 个</span>
      <span class="muted">${esc(srcSummary)}</span>
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

/* B15.2 — Add Connection Wizard：Provider / Base URL / API Key / No-auth / Custom Headers / Protocol。
 * B15.3/B15.4 — API Key 与 Header 值保存后绝不再回显明文；编辑时只给掩码占位，
 * 保留掩码 = 沿用已存密文，重新输入 = 替换，清空 = 删除。 */
function connHeaderRow(name = '', value = '') {
  return `<div class="hdr-row">
    <input class="hdr-name" placeholder="Header 名称（如 X-Api-Token）" value="${esc(name)}" autocomplete="off">
    <input class="hdr-value" placeholder="${name ? CONN_HEADER_MASK + '（保留掩码=不修改，清空=删除）' : 'Header 值'}" value="${esc(value)}" autocomplete="off">
    <button class="btn tiny hdr-del" title="删除此请求头">×</button>
  </div>`;
}

function connForm(conn) {
  const c = conn || { name: '', provider: 'openai', base_url: 'https://api.openai.com/v1', headers: {}, api_key_masked: '' };
  const existingHeaders = Object.entries(c.headers || {}); // 值已是掩码（后端投影，绝不含明文）
  openModal(conn ? '编辑连接' : '新建连接', `
    <label>名称<input id="f-name" value="${esc(c.name)}"></label>
    <label>协议
      <select id="f-provider">${PROVIDERS.map(p => `<option value="${p[0]}" ${p[0] === c.provider ? 'selected' : ''}>${esc(p[1])}</option>`).join('')}</select>
    </label>
    <label>Base URL<input id="f-url" value="${esc(c.base_url)}" placeholder="https://api.openai.com/v1"></label>
    <label>API Key（可留空 = ${conn ? '不修改' : '无认证'}）<input id="f-key" type="password" placeholder="${conn && c.api_key_masked ? esc(c.api_key_masked) + '（留空表示不修改）' : 'sk-…（本地服务可留空）'}"></label>
    <div class="f-block">
      <div class="muted small">自定义请求头（可选，值加密存储，保存后只显示掩码）</div>
      <div id="f-headers-rows">${existingHeaders.length
        ? existingHeaders.map(([k, v]) => connHeaderRow(k, v)).join('')
        : ''}</div>
      <button class="btn tiny" id="f-headers-add">+ 添加请求头</button>
    </div>
  `, { okText: '保存' });
  const bindRowDelete = () => $$('#f-headers-rows .hdr-del').forEach(b => b.onclick = () => b.closest('.hdr-row').remove());
  bindRowDelete();
  $('#f-headers-add').onclick = () => {
    $('#f-headers-rows').insertAdjacentHTML('beforeend', connHeaderRow());
    bindRowDelete();
  };
  onModalOk(async () => {
    const headers = {};
    for (const row of $$('#f-headers-rows .hdr-row')) {
      const name = row.querySelector('.hdr-name').value.trim();
      const value = row.querySelector('.hdr-value').value;
      if (!name) { if (value.trim()) { toast('请求头缺少名称', 'error'); return; } continue; }
      headers[name] = value; // 掩码占位 = 保留；空 = 删除；其余 = 新值
    }
    const payload = { name: $('#f-name').value.trim() || '新连接', provider: $('#f-provider').value, base_url: $('#f-url').value.trim(), headers };
    const key = $('#f-key').value;
    if (key) payload.api_key = key;
    try {
      if (conn) await api.connUpdate(conn.id, payload); else await api.connCreate(payload);
      closeModal(); toast('已保存（密钥与请求头值仅显示掩码）', 'ok'); open('connections');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ------------------------------------------------------------------ */
/* v2.4.0 Smart API Onboarding — 快速接入                              */
/* ------------------------------------------------------------------ */

/** §15: 前端 mask 显示，真实 key 只存在 JS 变量里供 probe/import 使用 */
function maskKey(k) {
  if (!k) return '未设置';
  const s = String(k);
  if (s.length <= 8) return s[0] + '••••' + s[s.length - 1];
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

const PROTOCOL_LABELS = {
  'openai': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses',
  'anthropic': 'Anthropic', 'ollama': 'Ollama', 'local': 'LM Studio / 本地',
  'custom': '自定义', 'mock': 'Mock'
};
function protoLabel(p) { return PROTOCOL_LABELS[p] || p || '未识别'; }

const SOURCE_LABELS = {
  'plain-text': '普通文本', 'env': 'ENV 配置', 'json': 'JSON',
  'toml': 'TOML', 'curl': 'curl 命令', 'code-snippet': '代码片段',
  'ccswitch-deeplink': 'CC Switch Deep Link', 'ccswitch-config': 'CC Switch 配置'
};

/**
 * 快速接入大弹窗 —— spec §7/§36/§37/§38 全流程：
 *   粘贴 → 预览 → 检测 → 确认 → 保存（可选分配主智能体）
 */
function smartOnboard() {
  let candidate = null;     // 真实候选（含明文 key，仅内存）
  let probeReport = null;   // 检测报告

  // v2.4.1: 设置 probe 事件处理器（probeId 绑定 + late result guard）
  probeEventCb = (ev) => {
    // §48: 只处理当前 probe 的事件
    if (ev.probeId !== currentProbeId) return;
    // §47: cancelled 事件由取消按钮本地处理，忽略
    if (ev.state === 'cancelled') return;
    // 处理 result 事件
    if (ev.state === 'completed') {
      probeReport = ev.report;
      currentProbeId = null;
      renderResultStep();
    } else if (ev.state === 'failed' || ev.state === 'timeout') {
      currentProbeId = null;
      const errMsg = ev.report ? ev.report.error : (ev.error || '检测失败');
      const errCode = ev.report ? ev.report.errorCode : null;
      $('#modal').querySelector('.modal-body').innerHTML = `
        <h3>检测${ev.state === 'timeout' ? '超时' : '失败'}</h3>
        <p class="error">${esc(errMsg)}</p>
        ${errCode ? `<p class="muted small">错误码：${esc(errCode)}</p>` : ''}
        <div class="ob-actions"><button class="btn primary" id="ob-back">返回</button></div>`;
      $('#ob-back').onclick = renderPreviewStep;
    }
  };

  // 清理函数：取消活跃 probe + 清除事件处理器
  function cleanupProbe() {
    if (currentProbeId) {
      api.onboardingProbeCancel(currentProbeId).catch(() => {});
      currentProbeId = null;
    }
  }

  openModal('智能 API 快速接入', '', { noFooter: true });
  // 拦截 modal-x 关闭按钮，确保取消活跃 probe
  const xBtn = $('#modal .modal-x');
  if (xBtn) xBtn.onclick = () => { cleanupProbe(); probeEventCb = null; closeModal(); };
  renderPasteStep();

  // ─── Step 1: 粘贴 ───────────────────────────────────────────────────
  function renderPasteStep() {
    const modal = $('#modal');
    modal.querySelector('.modal-body').innerHTML = `
      <p class="muted">把 API 地址、密钥、配置或代码粘贴到这里，自动识别 URL / Key / Provider / 协议。支持：URL / Key / JSON / ENV / curl / 代码 / TOML / CC Switch。</p>
      <textarea id="ob-paste" rows="7" placeholder="例如：&#10;接口地址：https://api.example.com/v1&#10;API Key：sk-xxxx&#10;&#10;或 curl 命令、OPENAI_API_KEY=... 、JSON 配置等"></textarea>
      <div class="ob-presets" style="margin:10px 0">
        <span class="muted small">常用服务（点击后只需填 API Key）：</span>
        <div id="ob-preset-btns" style="margin-top:6px"></div>
      </div>
      <div class="ob-actions" style="margin-top:10px">
        <button class="btn primary" id="ob-parse">识别配置</button>
        <button class="btn" id="ob-ccswitch">从 CC Switch 导入</button>
        <button class="btn" id="ob-cancel">取消</button>
      </div>`;
    $('#ob-cancel').onclick = closeModal;
    $('#ob-parse').onclick = onParse;
    $('#ob-ccswitch').onclick = onCcswitch;
    // 渲染常用服务按钮
    api.onboardingPresets().then(presets => {
      $('#ob-preset-btns').innerHTML = presets.filter(p => p.id !== 'custom').map(p =>
        `<button class="btn tiny" data-preset="${p.id}" title="${esc(p.defaultBaseUrl || '')}">${esc(p.name)}</button>`).join('') +
        `<button class="btn tiny" data-preset="custom">自定义</button>`;
      $('#ob-preset-btns').querySelectorAll('[data-preset]').forEach(b => b.onclick = () => onPresetPick(b.dataset.preset, presets));
    }).catch(() => {});
    // Ctrl+Enter 识别
    $('#ob-paste').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onParse(); });
    $('#ob-paste').focus();
  }

  // 选 preset → 填好 baseUrl/protocol，让用户补 key
  function onPresetPick(id, presets) {
    const p = presets.find(x => x.id === id);
    if (!p) return;
    candidate = {
      name: p.name, providerHint: p.id, protocolHint: p.protocol,
      baseUrl: p.defaultBaseUrl, apiKey: null, defaultModel: null, models: [], headers: {},
      source: { type: 'preset', parser: 'preset', confidence: 1, rawLength: 0 }
    };
    renderPreviewStep();
  }

  async function onParse() {
    const text = $('#ob-paste').value.trim();
    if (!text) { toast('请先粘贴 API 配置', 'warn'); return; }
    try {
      const r = await api.onboardingParse(text);
      if (r && r.batch) { renderBatchStep(r.batch, text); return; }
      if (!r || !r.candidate) { toast('无法识别输入，请检查格式', 'warn'); return; }
      candidate = r.candidate;
      renderPreviewStep();
    } catch (e) { toast('识别失败：' + e.message, 'error'); }
  }

  async function onCcswitch() {
    const text = $('#ob-paste').value.trim();
    if (!text) { toast('请先粘贴 CC Switch Deep Link 或配置 JSON', 'warn'); return; }
    try {
      const r = await api.onboardingCcswitch(text);
      if (!r.batch || !r.batch.length) { toast('未解析到 CC Switch Provider', 'warn'); return; }
      renderBatchStep(r.batch, text);
    } catch (e) { toast('CC Switch 导入失败：' + e.message, 'error'); }
  }

  // ─── Step 2: 预览（§36）─────────────────────────────────────────────
  async function renderPreviewStep() {
    const c = candidate;
    if (!c) return;
    // §47 重复检测
    let dupNote = '';
    try {
      const dup = await api.onboardingDuplicate(c.baseUrl, c.protocolHint);
      if (dup) dupNote = `<div class="warn-box">检测到可能重复的连接：<b>${esc(dup.name)}</b>（同地址 + 同协议）。继续将覆盖该连接。</div>`;
    } catch { /* ignore */ }

    $('#modal').querySelector('.modal-body').innerHTML = `
      <h3>检测到 API 配置</h3>
      <div class="ob-preview">
        <label>名称<input id="ob-name" value="${esc(c.name || '')}" placeholder="连接名称"></label>
        <label>接口地址<input id="ob-url" value="${esc(c.baseUrl || '')}"></label>
        <label>密钥<span class="mono">${esc(maskKey(c.apiKey))}</span></label>
        <label>推测协议<span class="chip">${esc(protoLabel(c.protocolHint))}</span> <span class="muted small">（来源：${esc(SOURCE_LABELS[c.source.type] || c.source.type || '未知')}，可信度 ${Math.round((c.source.confidence || 0) * 100)}%）</span></label>
        ${c.defaultModel ? `<label>默认模型<span class="mono">${esc(c.defaultModel)}</span></label>` : ''}
      </div>
      ${dupNote}
      <div class="ob-actions" style="margin-top:12px">
        <button class="btn primary" id="ob-probe">开始检测</button>
        <button class="btn" id="ob-back">重新粘贴</button>
      </div>`;
    $('#ob-back').onclick = renderPasteStep;
    $('#ob-probe').onclick = renderProbeStep;
  }

  // ─── 批量导入（CC Switch 多 Provider §45/§46）──────────────────────
  function renderBatchStep(batch, sourceText) {
    const items = batch.map((c, i) => ({ c, checked: true, i }));
    const refresh = () => {
      $('#modal').querySelector('.modal-body').innerHTML = `
        <h3>从 CC Switch 导入</h3>
        <p class="muted small">发现 ${batch.length} 个 Provider，勾选要导入的项。</p>
        <div class="ob-batch">${items.map(it => `
          <label class="ob-batch-item"><input type="checkbox" data-idx="${it.i}" ${it.checked ? 'checked' : ''}>
            <span><b>${esc(it.c.name || '未命名')}</b> <span class="muted small">${esc(protoLabel(it.c.protocolHint))} · ${esc(it.c.baseUrl || '无地址')}</span><br><span class="mono small">${esc(maskKey(it.c.apiKey))}</span></span>
          </label>`).join('')}</div>
        <div class="ob-actions" style="margin-top:12px">
          <button class="btn primary" id="ob-batch-import">导入选中的 ${items.filter(x => x.checked).length} 项</button>
          <button class="btn" id="ob-back">返回</button>
        </div>`;
      $('#modal').querySelectorAll('[data-idx]').forEach(cb => cb.onchange = () => {
        items[cb.dataset.idx].checked = cb.checked;
        $('#ob-batch-import').textContent = `导入选中的 ${items.filter(x => x.checked).length} 项`;
      });
      $('#ob-back').onclick = renderPasteStep;
      $('#ob-batch-import').onclick = async () => {
        const picked = items.filter(x => x.checked).map(x => x.c);
        if (!picked.length) { toast('请至少勾选一项', 'warn'); return; }
        let ok = 0, fail = 0;
        for (const c of picked) {
          try { await api.onboardingImport(c, {}); ok++; } catch { fail++; }
        }
        toast(`已导入 ${ok} 个连接${fail ? '，失败 ' + fail : ''}`, fail ? 'warn' : 'ok');
        closeModal(); open('connections');
      };
    };
    refresh();
  }

  // ─── Step 3: 检测（§37）—— v2.4.1: probe:start / probe:cancel 真实 abort ──
  function renderProbeStep() {
    // 从预览表单读回用户可能改过的 name/url
    const nameEl = $('#ob-name'), urlEl = $('#ob-url');
    if (nameEl && nameEl.value.trim()) candidate.name = nameEl.value.trim();
    if (urlEl && urlEl.value.trim()) candidate.baseUrl = urlEl.value.trim();
    if (!candidate.baseUrl) { toast('缺少接口地址，无法检测', 'warn'); return; }

    $('#modal').querySelector('.modal-body').innerHTML = `
      <h3>连接检测中…</h3>
      <div class="ob-probing">
        <p>正在检测 <span class="mono">${esc(candidate.baseUrl)}</span></p>
        <p class="muted small">探测模型发现 + 协议端点，最多 6 个请求。</p>
        <button class="btn" id="ob-abort">取消检测</button>
      </div>`;

    // v2.4.1: 立即启动 probe，获取 probeId
    currentProbeId = null;
    api.onboardingProbeStart(candidate, { timeoutMs: 15000 })
      .then(r => {
        // §48: 绑定 currentProbeId，后续事件按此过滤
        currentProbeId = r.probeId;
      })
      .catch(e => {
        $('#modal').querySelector('.modal-body').innerHTML = `
          <h3>检测启动失败</h3><p class="error">${esc(e.message)}</p>
          <div class="ob-actions"><button class="btn primary" id="ob-back">返回</button></div>`;
        $('#ob-back').onclick = renderPreviewStep;
      });

    // §49: 取消按钮 → 真实 abort fetch → 回到预览页（不显示检测失败/AbortError）
    $('#ob-abort').onclick = async () => {
      const pid = currentProbeId;
      currentProbeId = null; // §47: 清除绑定，迟到结果被忽略
      if (pid) {
        try { await api.onboardingProbeCancel(pid); } catch { /* noop */ }
      }
      renderPreviewStep();
    };
  }

  // ─── Step 4: 检测结果 + 最终确认（§37/§38）—— v2.4.1: 新报告结构 ──────
  async function renderResultStep() {
    const r = probeReport;
    // v2.4.1: 使用 modelDiscovery + protocols 新结构（向后兼容旧 candidates）
    const md = r.modelDiscovery || { status: 'unknown', models: [] };
    const protos = r.protocols || r.candidates || [];
    const supported = protos.filter(p => p.status === 'supported').map(p => p.protocol);
    const unsupported = protos.filter(p => p.status === 'unsupported').map(p => p.protocol);
    const models = (md.models && md.models.length) ? md.models : (r.models || []);
    const hasModels = md.status === 'supported' && models.length > 0;
    const hasProtocol = supported.length > 0;
    // 默认协议用推荐值；用户可改
    let chosenProto = r.recommendedProtocol || candidate.protocolHint || 'custom';
    // 协议选项：supported 优先，加上候选本身的 hint
    const protoOptions = Array.from(new Set([...supported, candidate.protocolHint, 'custom'].filter(Boolean)));
    let chosenModel = candidate.defaultModel || (models.length ? models[0] : '');

    // §40: 主智能体当前配置（异步获取 agents + connections）
    let mainInfo = '';
    let agents = [];
    try { agents = await api.agents(); } catch { agents = []; }
    const main = agents.find(a => a.is_main);
    let conns = [];
    try { conns = await api.connections(); } catch { conns = []; }
    if (main) {
      const curConn = conns.find(c => c.id === main.api_connection_id);
      mainInfo = `<div class="warn-box" id="ob-main-warn">主智能体当前使用：${curConn ? esc(curConn.name) : '未配置'} / ${esc(main.model || '未设置模型')}</div>`;
    }

    // §28/§34: Models-only 不误判 Chat；显示模型发现 + 协议各自独立状态
    const protocolRows = protos.map(p => {
      const label = protoLabel(p.protocol);
      if (p.status === 'supported') {
        const isRec = p.protocol === r.recommendedProtocol;
        return `<div><span class="chip ok">✓ ${esc(label)}</span>${isRec ? ' <span class="chip ok">推荐</span>' : ''}</div>`;
      }
      if (p.status === 'unsupported') return `<div><span class="chip bad">✕ ${esc(label)}</span></div>`;
      return `<div><span class="chip warn">? ${esc(label)}（未知）</span></div>`;
    }).join('');

    const refresh = () => {
      $('#modal').querySelector('.modal-body').innerHTML = `
        <h3>连接检测结果</h3>
        <div class="ob-result">
          <div>${r.reachable ? '<span class="chip ok">✓ 网络可达</span>' : '<span class="chip bad">✕ 网络不可达</span>'} ${r.latencyMs != null ? `<span class="muted small">${r.latencyMs}ms</span>` : ''}</div>
          <div>${hasModels
            ? `<span class="chip ok">✓ 模型列表：${models.length} 个</span>`
            : md.status === 'auth_failed'
              ? '<span class="chip warn">模型列表：密钥无效（401/403）</span>'
              : '<span class="chip warn">模型列表不可用（可手动输入）</span>'}</div>
          ${protocolRows}
          ${!hasProtocol && hasModels ? '<div class="warn-box">发现模型列表，但没有确认可用的生成协议。请手动选择协议或检查接口文档。</div>' : ''}
          ${r.aborted ? '<div class="warn-box">检测已被取消，结果可能不完整。</div>' : ''}
          ${r.error && r.state !== 'completed' ? `<div class="error small">${esc(r.error)}</div>` : ''}
        </div>
        <h3 style="margin-top:14px">确认保存</h3>
        <div class="ob-confirm">
          <label>连接名称<input id="ob-final-name" value="${esc(candidate.name || '')}"></label>
          <label>协议<select id="ob-final-proto">${protoOptions.map(p => `<option value="${p}" ${p === chosenProto ? 'selected' : ''}>${esc(protoLabel(p))}</option>`).join('')}</select></label>
          <label>默认模型
            ${models.length
              ? `<select id="ob-final-model">${models.map(m => `<option value="${esc(m)}" ${m === chosenModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`
              : `<input id="ob-final-model" value="${esc(chosenModel || '')}" placeholder="手动输入模型 id">`}
          </label>
          <div class="muted small">将保存 ${models.length} 个模型（来源：${hasModels ? '远端获取' : '手动输入'}）</div>
          ${mainInfo}
          <label class="ob-check"><input type="checkbox" id="ob-assign-main" ${main ? 'checked' : ''}> 分配给主智能体</label>
        </div>
        <div class="ob-actions" style="margin-top:12px">
          <button class="btn primary" id="ob-finish">完成</button>
          <button class="btn" id="ob-reprobe">重新检测</button>
          <button class="btn" id="ob-back">返回粘贴</button>
        </div>`;
      $('#ob-final-proto').onchange = e => { chosenProto = e.target.value; };
      if (models.length) { $('#ob-final-model').onchange = e => { chosenModel = e.target.value; }; }
      else { $('#ob-final-model').oninput = e => { chosenModel = e.target.value; }; }
      $('#ob-back').onclick = renderPasteStep;
      $('#ob-reprobe').onclick = renderProbeStep;
      $('#ob-finish').onclick = onFinish;
    };
    refresh();

    function onFinish() {
      candidate.name = $('#ob-final-name').value.trim() || candidate.name || '新连接';
      candidate.protocolHint = $('#ob-final-proto').value;
      candidate.defaultModel = typeof $('#ob-final-model').value === 'string' ? $('#ob-final-model').value.trim() : '';
      if (models.length) candidate.models = models;
      const assignMain = $('#ob-assign-main') && $('#ob-assign-main').checked;
      // §40: 主智能体已有配置时二次确认
      if (assignMain && main && main.api_connection_id) {
        confirmBox('切换主智能体 API', `主智能体当前已配置 API，确定切换到新连接「${candidate.name}」？`).then(ok => {
          if (ok) doImport(true);
        });
      } else {
        doImport(assignMain);
      }
    }

    async function doImport(assignMain) {
      try {
        const r = await api.onboardingImport(candidate, { assignToMain: assignMain, forceOverwrite: true });
        if (r.duplicate && !r.assigned) {
          toast('检测到重复连接，已覆盖更新', 'warn');
        } else {
          toast(assignMain && r.assigned ? '已保存并分配给主智能体' : '已保存', 'ok');
        }
        closeModal();
        open('connections');
        if (assignMain) window.dispatchEvent(new CustomEvent('models-updated'));
      } catch (e) { toast('保存失败：' + e.message, 'error'); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* v2.5.0 External Config Import — 从其他工具导入                       */
/* ------------------------------------------------------------------ */

const EXT_SOURCE_LABELS = {
  'codex': 'Codex',
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
  'ccswitch': 'CC Switch',
  'environment': '环境变量',
  'env-file': '.env 文件',
  'json-file': 'JSON 文件',
  'toml-file': 'TOML 文件'
};

/** §35/§43 冲突状态 → chip 样式 + 中文 */
const CONFLICT_CHIP = {
  NEW: '<span class="chip ok">新增</span>',
  DUPLICATE: '<span class="chip warn">重复</span>',
  CONFLICT: '<span class="chip bad">冲突</span>',
  MISSING_SECRET: '<span class="chip warn">缺少密钥</span>',
  UNSUPPORTED: '<span class="chip bad">不支持凭据</span>',
  INVALID: '<span class="chip bad">无效</span>'
};

/**
 * spec §33: 从其他工具导入弹窗 ——
 *   Step 1: 选择来源（按钮列表）
 *   Step 2: 自动发现 / 选择文件
 *   Step 3: 预览候选 + 冲突检测 + 手动补 key
 *   Step 4: 批量导入 + 结果展示
 *   Step 5: 可选分配给主智能体
 */
function externalImport() {
  /** @type {{sourceType:string, sourceName:string, candidates:any[], conflicts:any[], items:Map<number,{checked:boolean,manualKey:string,action:string}>}} */
  const ctx = { sourceType: null, sourceName: null, candidates: [], conflicts: [], items: new Map() };

  openModal('从其他工具导入 API', '', { noFooter: true });
  renderSourceStep();

  // ─── Step 1: 选择来源 ───────────────────────────────────────────────
  async function renderSourceStep() {
    const modal = $('#modal');
    let sources = [];
    try { sources = await api.externalImportListSources(); }
    catch (e) { toast('加载导入源失败：' + e.message, 'error'); closeModal(); return; }

    const tools = sources.filter(s => !s.requiresFile);
    const fileSources = sources.filter(s => s.requiresFile);

    modal.querySelector('.modal-body').innerHTML = `
      <p class="muted">选择已安装的工具，自动发现本机可导入的 API 配置；或选择文件手动导入。所有导入仅读取公开配置，不迁移账号登录态、OAuth 或会员凭据。</p>
      <h3 style="margin-top:12px">已安装工具</h3>
      <div class="ext-source-grid">${tools.map(s => `
        <button class="btn ext-source-btn" data-src="${esc(s.id)}">
          <div class="ext-source-name">${esc(s.name)}</div>
          <div class="muted small">${esc(s.description || '')}</div>
        </button>`).join('') || '<div class="muted">无可用工具</div>'}</div>
      <h3 style="margin-top:14px">从文件导入</h3>
      <div class="ext-source-grid">${fileSources.map(s => `
        <button class="btn ext-source-btn" data-file="${esc(s.id)}">
          <div class="ext-source-name">${esc(s.name)}</div>
          <div class="muted small">${esc(s.description || '')}</div>
        </button>`).join('')}</div>
      <div class="ob-actions" style="margin-top:14px">
        <button class="btn" id="ext-cancel">取消</button>
      </div>`;
    $('#ext-cancel').onclick = closeModal;
    modal.querySelectorAll('[data-src]').forEach(b => b.onclick = () => onPickSource(b.dataset.src, sources));
    modal.querySelectorAll('[data-file]').forEach(b => b.onclick = () => onPickFile(b.dataset.file));
  }

  // ─── Step 2a: 选择工具后自动发现 + 解析 ─────────────────────────────
  async function onPickSource(sourceType, sources) {
    const src = sources.find(s => s.id === sourceType);
    ctx.sourceType = sourceType;
    ctx.sourceName = src ? src.name : sourceType;
    const modal = $('#modal');
    modal.querySelector('.modal-body').innerHTML = `
      <h3>正在检查 ${esc(ctx.sourceName)} 配置…</h3>
      <div class="muted small" id="ext-status">发现中…</div>
      <div id="ext-warnings"></div>`;
    try {
      const r = await api.externalImportParse(sourceType, {});
      ctx.candidates = (r && r.candidates) || [];
      const src2 = r && r.source;
      const warnings = (r && r.warnings) || (src2 && src2.warnings) || [];
      const errors = (src2 && src2.errors) || [];
      if (errors.length) {
        $('#ext-status').textContent = '发现失败：' + errors.join('; ');
      } else if (!ctx.candidates.length) {
        $('#ext-status').textContent = '未发现可导入的 API 配置';
      } else {
        $('#ext-status').textContent = `发现 ${ctx.candidates.length} 个 Provider`;
      }
      const wbox = $('#ext-warnings');
      const wHtml = warnings.map(w => {
        if (w.type === 'unsupported_credential') return `<div class="warn-box">${esc(w.message)}</div>`;
        if (w.type === 'parse_warning') return `<div class="warn-box">解析警告：${esc(w.message)}</div>`;
        return `<div class="muted small">${esc(w.message || '')}</div>`;
      }).join('') + errors.map(e => `<div class="error small">${esc(e)}</div>`).join('');
      wbox.innerHTML = wHtml;
      if (!ctx.candidates.length) {
        wbox.innerHTML += `<div class="ob-actions" style="margin-top:12px">
          <button class="btn primary" id="ext-back">返回</button>
          ${src && src.requiresFile === false && src.supportsDiscovery !== false ? `<button class="btn" id="ext-manual">手动选择文件</button>` : ''}
        </div>`;
        $('#ext-back').onclick = renderSourceStep;
        const mb = $('#ext-manual'); if (mb) mb.onclick = onPickFileInCtx;
        return;
      }
      // 进入预览步骤
      await runConflictCheckAndRender();
    } catch (e) {
      $('#ext-status').textContent = '错误：' + e.message;
      $('#ext-warnings').innerHTML = `<div class="ob-actions"><button class="btn primary" id="ext-back">返回</button></div>`;
      $('#ext-back').onclick = renderSourceStep;
    }
  }

  // ─── Step 2b: 用户手动选择文件 ──────────────────────────────────────
  async function onPickFile(fileSourceType) {
    ctx.sourceType = fileSourceType;
    ctx.sourceName = EXT_SOURCE_LABELS[fileSourceType] || fileSourceType;
    const modal = $('#modal');
    modal.querySelector('.modal-body').innerHTML = `
      <h3>选择文件</h3>
      <p class="muted small">支持的格式：.env / .json / .toml</p>
      <div class="ob-actions"><button class="btn primary" id="ext-pick">选择文件…</button><button class="btn" id="ext-back">返回</button></div>`;
    $('#ext-back').onclick = renderSourceStep;
    $('#ext-pick').onclick = async () => {
      try {
        const pick = await api.externalImportSelectFile();
        if (!pick || pick.canceled) return;
        const r = await api.externalImportParseFile(pick.filePath);
        ctx.candidates = (r && r.candidates) || [];
        const warnings = (r && r.warnings) || [];
        if (!ctx.candidates.length) {
          modal.querySelector('.modal-body').innerHTML = `
            <h3>未发现可导入配置</h3>
            <div id="ext-warnings">${warnings.map(w => `<div class="warn-box">${esc(w.message || '')}</div>`).join('')}</div>
            <div class="ob-actions"><button class="btn primary" id="ext-back">返回</button></div>`;
          $('#ext-back').onclick = renderSourceStep;
          return;
        }
        await runConflictCheckAndRender(warnings);
      } catch (e) { toast('文件解析失败：' + e.message, 'error'); }
    };
  }

  /** 用户在工具发现失败时手动选择文件（沿用当前 sourceType 的 importer） */
  async function onPickFileInCtx() {
    try {
      const pick = await api.externalImportSelectFile();
      if (!pick || pick.canceled) return;
      const r = await api.externalImportParse(ctx.sourceType, { filePath: pick.filePath, userSelected: true });
      ctx.candidates = (r && r.candidates) || [];
      const warnings = (r && r.warnings) || [];
      if (!ctx.candidates.length) {
        const modal = $('#modal');
        modal.querySelector('.modal-body').innerHTML = `
          <h3>未发现可导入配置</h3>
          <div id="ext-warnings">${warnings.map(w => `<div class="warn-box">${esc(w.message || '')}</div>`).join('')}</div>
          <div class="ob-actions"><button class="btn primary" id="ext-back">返回</button></div>`;
        $('#ext-back').onclick = renderSourceStep;
        return;
      }
      await runConflictCheckAndRender(warnings);
    } catch (e) { toast('文件解析失败：' + e.message, 'error'); }
  }

  // ─── Step 3: 预览 + 冲突检测 + 手动补 key ──────────────────────────
  async function runConflictCheckAndRender(extraWarnings = []) {
    try {
      const r = await api.externalImportResolveConflicts(ctx.candidates);
      ctx.conflicts = Array.isArray(r) ? r : [];
    } catch (e) {
      ctx.conflicts = ctx.candidates.map(c => ({ candidate: c, conflict: { state: 'NEW', reason: '冲突检测失败：' + e.message } }));
    }
    // 初始化 items map
    ctx.items = new Map();
    ctx.conflicts.forEach((row, i) => {
      const st = (row.conflict && row.conflict.state) || 'NEW';
      let action = 'import';
      if (st === 'DUPLICATE') action = 'skip';        // §39 默认跳过重复
      if (st === 'CONFLICT') action = 'skip';          // §40 默认跳过冲突
      if (st === 'UNSUPPORTED') action = 'skip';       // §32 默认跳过不支持凭据
      if (st === 'INVALID') action = 'skip';
      // v2.5.1 §32：UNSUPPORTED 和 INVALID 一样不可勾选
      ctx.items.set(i, { checked: (st !== 'INVALID' && st !== 'UNSUPPORTED'), manualKey: '', action });
    });
    renderPreviewStep(extraWarnings);
  }

  function renderPreviewStep(extraWarnings = []) {
    const modal = $('#modal');
    const rows = ctx.conflicts.map((row, i) => {
      const c = row.candidate || {};
      const cf = row.conflict || { state: 'NEW' };
      const st = cf.state;
      const item = ctx.items.get(i) || { checked: false, manualKey: '', action: 'skip' };
      const srcMeta = c.source || {};
      // v2.5.1 §32：UNSUPPORTED 时 apiKey 已被分类器丢弃（null），显示「已拒绝」
      const showKey = (st === 'UNSUPPORTED')
        ? '<span class="muted">已拒绝</span>'
        : (c.apiKey ? maskKey(c.apiKey) : '<span class="muted">无</span>');
      const dupName = cf.duplicateName ? `<div class="muted small">现有连接：<b>${esc(cf.duplicateName)}</b></div>` : '';
      const dupActions = (st === 'DUPLICATE' || st === 'CONFLICT') ? `
        <select data-dup-act="${i}">
          <option value="skip" ${item.action === 'skip' ? 'selected' : ''}>跳过</option>
          <option value="import" ${item.action === 'import' ? 'selected' : ''}>另存为新连接</option>
          <option value="overwrite" ${item.action === 'overwrite' ? 'selected' : ''}>更新现有连接</option>
        </select>` : '';
      const missingKeyInput = (st === 'MISSING_SECRET') ? `
        <input type="password" data-manual-key="${i}" value="${esc(item.manualKey)}" placeholder="输入 API Key…">` : '';
      const reason = cf.reason ? `<div class="muted small">${esc(cf.reason)}</div>` : '';
      return `<tr class="ext-row" data-row="${i}">
        <td><input type="checkbox" data-check="${i}" ${item.checked ? 'checked' : ''} ${(st === 'INVALID' || st === 'UNSUPPORTED') ? 'disabled' : ''}></td>
        <td><b>${esc(c.name || '未命名')}</b>
          <div class="muted small">${esc(protoLabel(c.protocolHint))} · 可信度 ${Math.round((srcMeta.confidence || 0) * 100)}%</div>
        </td>
        <td class="mono small">${esc(c.baseUrl || '无地址')}</td>
        <td class="mono small">${showKey}${missingKeyInput}</td>
        <td>${CONFLICT_CHIP[st] || st}${dupName}${reason}</td>
        <td>${dupActions}</td>
      </tr>`;
    }).join('');

    const warnHtml = extraWarnings.map(w => `<div class="warn-box">${esc(w.message || '')}</div>`).join('');

    modal.querySelector('.modal-body').innerHTML = `
      <h3>预览候选配置</h3>
      <p class="muted small">来源：${esc(ctx.sourceName)} · 共 ${ctx.candidates.length} 个候选。勾选要导入的项，缺少密钥的可手动补充，重复/冲突可选择跳过 / 另存 / 覆盖。</p>
      ${warnHtml}
      <table class="tbl" id="ext-preview-tbl"><thead><tr>
        <th></th><th>名称</th><th>Base URL</th><th>密钥</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <div class="ob-actions" style="margin-top:12px">
        <button class="btn primary" id="ext-import">导入选中</button>
        <button class="btn" id="ext-back">返回</button>
        <button class="btn" id="ext-cancel">取消</button>
      </div>`;

    $('#ext-back').onclick = renderSourceStep;
    $('#ext-cancel').onclick = closeModal;
    modal.querySelectorAll('[data-check]').forEach(cb => cb.onchange = () => {
      const i = Number(cb.dataset.check);
      const it = ctx.items.get(i) || {};
      it.checked = cb.checked;
      ctx.items.set(i, it);
    });
    modal.querySelectorAll('[data-manual-key]').forEach(inp => inp.oninput = () => {
      const i = Number(inp.dataset.manualKey);
      const it = ctx.items.get(i) || {};
      it.manualKey = inp.value;
      ctx.items.set(i, it);
    });
    modal.querySelectorAll('[data-dup-act]').forEach(sel => sel.onchange = () => {
      const i = Number(sel.dataset.dupAct);
      const it = ctx.items.get(i) || {};
      it.action = sel.value;
      // 选 overwrite/import 时自动勾选
      if (it.action === 'overwrite' || it.action === 'import') {
        it.checked = true;
        const cb = modal.querySelector(`[data-check="${i}"]`);
        if (cb) cb.checked = true;
      }
      ctx.items.set(i, it);
    });
    $('#ext-import').onclick = onImportBatch;
  }

  // ─── Step 4: 批量导入 + 结果 ────────────────────────────────────────
  async function onImportBatch() {
    const items = [];
    ctx.conflicts.forEach((row, i) => {
      const it = ctx.items.get(i);
      if (!it || !it.checked) return;
      items.push({
        candidate: row.candidate,
        action: it.action || 'import',
        manualKey: it.manualKey || null
      });
    });
    if (!items.length) { toast('请至少勾选一项', 'warn'); return; }

    const modal = $('#modal');
    modal.querySelector('.modal-body').innerHTML = `
      <h3>正在导入 ${items.length} 个配置…</h3>
      <div class="muted small" id="ext-import-status">处理中…</div>`;

    let results;
    try {
      results = await api.externalImportImportBatch(items);
    } catch (e) {
      modal.querySelector('.modal-body').innerHTML = `
        <h3>导入失败</h3><p class="error">${esc(e.message)}</p>
        <div class="ob-actions"><button class="btn primary" id="ext-back">返回</button></div>`;
      $('#ext-back').onclick = renderPreviewStep;
      return;
    }

    renderResultStep(results);
  }

  function renderResultStep(results) {
    const modal = $('#modal');
    const rows = results.map(r => {
      const ok = r.result && r.result.ok;
      const skipped = r.result && r.result.skipped;
      const conn = r.result && r.result.connection;
      const err = r.result && r.result.error;
      const dup = r.result && r.result.duplicate;
      const name = (r.candidate && r.candidate.name) || '未命名';
      let chip;
      if (skipped) chip = '<span class="chip">⊘ 跳过</span>';
      else if (ok && conn) chip = '<span class="chip ok">✓ 已导入</span>';
      else if (dup && conn) chip = '<span class="chip warn">↻ 已更新</span>';
      else if (err) chip = '<span class="chip bad">⚠ 失败</span>';
      else chip = '<span class="chip">未知</span>';
      const detail = err ? `<div class="error small">${esc(err)}</div>` :
        (conn ? `<div class="muted small">${esc(conn.provider)} · ${esc(conn.base_url)}</div>` : '');
      return `<tr><td><b>${esc(name)}</b></td><td>${chip}</td><td>${detail}</td></tr>`;
    }).join('');

    const okCount = results.filter(r => r.result && r.result.ok && !r.result.skipped).length;
    const skipCount = results.filter(r => r.result && r.result.skipped).length;
    const failCount = results.filter(r => !r.result || !r.result.ok).length;

    modal.querySelector('.modal-body').innerHTML = `
      <h3>导入完成</h3>
      <p class="muted small">成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount}</p>
      <table class="tbl"><thead><tr><th>名称</th><th>结果</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table>
      <div id="ext-assign-area"></div>
      <div class="ob-actions" style="margin-top:12px">
        <button class="btn primary" id="ext-done">完成</button>
        <button class="btn" id="ext-back">返回来源选择</button>
      </div>`;
    $('#ext-back').onclick = renderSourceStep;
    $('#ext-done').onclick = () => { closeModal(); open('connections'); };

    // §48: 可选分配主智能体（只展示已导入连接的下拉）
    renderAssignStep(results);
  }

  async function renderAssignStep(results) {
    const area = $('#ext-assign-area');
    if (!area) return;
    const importedConns = results
      .map(r => r.result && r.result.connection)
      .filter(c => c && c.id);
    if (!importedConns.length) { area.innerHTML = ''; return; }

    let agents = [], main = null;
    try { agents = await api.agents(); main = agents.find(a => a.is_main) || null; }
    catch { /* ignore */ }

    if (!main) { area.innerHTML = '<div class="muted small">未找到主智能体，可稍后在「智能体」页面手动分配。</div>'; return; }

    const curConn = main.api_connection_id ? importedConns.find(c => c.id === main.api_connection_id) : null;
    area.innerHTML = `
      <h3 style="margin-top:14px">分配给主智能体（可选）</h3>
      <div class="warn-box" id="ext-main-warn">主智能体当前使用：${curConn ? esc(curConn.name) : (main.api_connection_id ? '其他连接' : '未配置')} / ${esc(main.model || '未设置模型')}</div>
      <div class="form2" style="margin-top:8px">
        <label>连接<select id="ext-assign-conn">
          ${importedConns.map(c => `<option value="${c.id}" ${curConn && curConn.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
        <label>模型<input id="ext-assign-model" value="${esc(main.model || '')}" placeholder="模型 ID"></label>
      </div>
      <div class="ob-actions" style="margin-top:8px">
        <button class="btn primary" id="ext-assign-btn">分配给主智能体</button>
      </div>`;
    $('#ext-assign-btn').onclick = async () => {
      const connId = $('#ext-assign-conn').value;
      const model = $('#ext-assign-model').value.trim();
      // 切换主智能体已有连接时二次确认
      if (main.api_connection_id && main.api_connection_id !== connId) {
        const ok = await confirmBox('切换主智能体 API', '主智能体当前已配置 API，确定切换？');
        if (!ok) return;
      }
      try {
        await api.agentUpdate(main.id, { api_connection_id: connId, model: model || main.model });
        toast('已分配给主智能体', 'ok');
        window.dispatchEvent(new CustomEvent('models-updated'));
        closeModal(); open('connections');
      } catch (e) { toast('分配失败：' + e.message, 'error'); }
    };
  }
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */
async function renderAgents(body) {
  const [agents, conns, prompts, tools, ext, dynDefs] = await Promise.all([
    api.agents(), api.connections(), api.prompts(), api.tools(), api.externalAgents(),
    api.dynDefList().catch(() => [])
  ]);
  const native = agents.filter(a => a.type !== 'external');
  // B13.1/B13.2 — 分类：Main Agents 与普通本地智能体分开呈现
  const mains = native.filter(a => a.is_main);
  const others = native.filter(a => !a.is_main);
  const connName = id => { const c = conns.find(x => x.id === id); return c ? c.name : (id || 'Auto'); };
  body.innerHTML = `
    <div class="page-actions">
      <button class="btn primary" id="agent-add">+ 新建智能体</button>
      <button class="btn" id="dyn-add">+ 新建 Dynamic Agent 定义</button>
      <button class="btn" id="ext-add">+ 接入外部智能体</button>
    </div>
    <h3>Agent Integration Hub</h3>
    <div class="cards" id="hub-cards"><div class="muted small">正在加载注册表…</div></div>
    <div id="hub-router-preview" style="margin-top:16px">
      <h4>任务路由测试</h4>
      <div style="display:flex;gap:8px">
        <input type="text" id="hub-route-input" placeholder="输入任务描述..." style="flex:1">
        <button class="btn" id="hub-route-btn">路由测试</button>
      </div>
      <div id="hub-route-results" style="margin-top:8px"></div>
    </div>
    <h3>主智能体</h3>
    <div class="cards">${mains.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b><span class="chip ok">Main</span>${a.type === 'computer' ? '<span class="chip">电脑操作</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta">
          <span>模型：${esc(a.model || 'Auto（Model Router）')}</span>
          <span>连接：${esc(connName(a.api_connection_id))}</span>
          <span>默认 Skills：${(a.skill_ids || a.defaultSkillIds || []).length}</span>
          <span>默认 Hooks：${(a.hook_ids || a.defaultHookIds || []).length}</span>
          <span>状态：Available</span>
        </div>
        <div class="muted small">主智能体不作为普通 Dynamic Definition 编辑。</div>
        <div class="acard-f"><button class="btn tiny" data-ae="${a.id}">编辑</button></div>
      </div>`).join('') || '<div class="empty" data-page-state="empty">没有主智能体</div>'}</div>
    <h3>本地智能体</h3>
    <div class="cards">${others.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b>${a.type === 'computer' ? '<span class="chip">电脑操作</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta">
          <span>模型：${esc(a.model || '未设置')}</span>
          <span>工具：${(a.tools || []).length}</span>
          <span>最大步数：${a.max_steps}</span>
          <span>子智能体：${(a.sub_agent_ids || []).length}</span>
        </div>
        <div class="acard-f"><button class="btn tiny" data-ae="${a.id}">编辑</button><button class="btn tiny danger" data-ad="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty" data-page-state="empty">还没有智能体</div>'}</div>
    <h3>Dynamic Agent Definitions</h3>
    <div class="muted small">持久化定义库。内联临时子智能体（ephemeral children）只在 Run Detail 可见，不会写入此库。</div>
    <div class="cards">${dynDefs.map(d => {
      const builtin = d.source === 'builtin' || (d.metadata && d.metadata.source === 'builtin');
      const readOnly = d.permissionPolicy && d.permissionPolicy.readOnly;
      return `
      <div class="acard">
        <div class="acard-h"><b>${esc(d.name || d.id)}</b><span class="chip">${esc(d.role || 'dynamic')}</span>${builtin ? '<span class="chip ok">Built-in</span>' : ''}${readOnly ? '<span class="chip">Read Only</span>' : ''}${d.canDelegate ? '<span class="chip">Can Delegate</span>' : ''}</div>
        <div class="muted small">${esc(truncate(d.description || '', 120))}</div>
        <div class="acard-meta">
          <span>Runtime：${esc(d.runtime && d.runtime.kind || 'native')}</span>
          <span>Model：${esc(d.modelPolicy && d.modelPolicy.mode || 'inherit_parent')}</span>
          <span>Tools：${((d.toolPolicy && d.toolPolicy.allow) || []).length || 'policy'}</span>
          <span>Skills：${((d.skills && d.skills.required) || []).length}</span>
          <span>Hooks：${((d.hooks && d.hooks.required) || []).length}</span>
        </div>
        <div class="muted small">Used By：UNKNOWN（无可靠引用索引，不猜测）</div>
        <div class="acard-f"><button class="btn tiny" data-dyn-edit="${esc(d.id)}">编辑</button>${builtin ? '' : `<button class="btn tiny danger" data-dyn-del="${esc(d.id)}">删除</button>`}</div>
      </div>`; }).join('') || '<div class="empty" data-page-state="empty">还没有 Dynamic Agent 定义</div>'}</div>
    <h3>外部智能体</h3>
    <div class="cards">${ext.map(a => `
      <div class="acard">
        <div class="acard-h"><b>${esc(a.name)}</b><span class="chip">${esc(a.adapter_type)}</span>${a.online ? '<span class="chip ok">在线</span>' : ''}</div>
        <div class="muted small">${esc(truncate(a.description || '', 120))}</div>
        <div class="acard-meta"><span class="mono small">${esc(a.command || a.endpoint || (a.config && a.config.cliPath) || '')}</span></div>
        ${a.last_status ? `<div class="acard-meta"><span class="chip ${extStatusClass(a.last_status)}">${esc(extStatusText(a.last_status))}</span>${a.last_run_at ? `<span class="muted small">${esc(fmtTime(a.last_run_at))}</span>` : ''}</div>` : ''}
        <div class="acard-f"><button class="btn tiny" data-ee="${a.id}">编辑</button><button class="btn tiny danger" data-ed="${a.id}">删除</button></div>
      </div>`).join('') || '<div class="empty" data-page-state="empty">没有外部智能体</div>'}</div>`;

  $('#agent-add').onclick = () => agentForm(null, { conns, prompts, tools, agents: native, extAgents: ext });
  $('#dyn-add').onclick = () => dynAgentForm(null);
  $('#ext-add').onclick = () => extForm(null, conns);
  body.querySelectorAll('[data-ae]').forEach(b => b.onclick = () => agentForm(native.find(a => a.id === b.dataset.ae), { conns, prompts, tools, agents: native, extAgents: ext }));
  body.querySelectorAll('[data-ad]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除智能体', {
      target: '该智能体配置',
      consequence: '依赖它的对话/委派将失去执行者。',
      reversibility: '不可逆：需重新创建。'
    })) return;
    await api.agentRemove(b.dataset.ad); toast('已删除'); open('agents');
  });
  body.querySelectorAll('[data-dyn-edit]').forEach(b => b.onclick = () => dynAgentForm(dynDefs.find(d => d.id === b.dataset.dynEdit)));
  body.querySelectorAll('[data-dyn-del]').forEach(b => b.onclick = async () => {
    const def = dynDefs.find(d => d.id === b.dataset.dynDel);
    // B13.5 — Built-in 禁止删除（UI 隐藏按钮 + 这里双保险）
    if (def && (def.source === 'builtin' || (def.metadata && def.metadata.source === 'builtin'))) {
      return toast('Built-in 定义不可删除', 'warn');
    }
    if (!await confirmBox('删除 Dynamic Agent 定义', {
      target: `定义「${b.dataset.dynDel}」`,
      consequence: '引用该定义的委派将 fail closed。',
      reversibility: '不可逆：需重新创建。'
    })) return;
    try { await api.dynDefDelete(b.dataset.dynDel); toast('已删除'); open('agents'); }
    catch (error) { toast(error.message, 'error'); panels.addProblem(`Agent 定义删除失败：${error.message}`); }
  });
  body.querySelectorAll('[data-ee]').forEach(b => b.onclick = () => extForm(ext.find(a => a.id === b.dataset.ee), conns));
  body.querySelectorAll('[data-ed]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除外部智能体', {
      target: '该外部智能体注册项',
      consequence: '其适配器与会话记录不再可用。',
      reversibility: '不可逆：需重新注册。'
    })) return;
    await api.extRemove(b.dataset.ed); toast('已删除'); open('agents');
  });

  // v2.6.0 — Agent Integration Hub：从注册表加载统一视图 + 路由预览
  loadHubCards(body);
  const routeBtn = $('#hub-route-btn', body);
  if (routeBtn) routeBtn.onclick = () => runHubRoutePreview(body);
}

/**
 * B13.3/B13.4 — Dynamic Agent 定义表单：所有保存一律走 backend
 * AgentDefinition validator（dynamicAgent:def:* → normalizeAgentDefinition），
 * Renderer 不做任何绕过。
 */
function dynAgentForm(existing) {
  const d = existing || {};
  const content = `<div class="form-grid">
    <label>名称<input type="text" id="dyn-name" value="${esc(d.name || '')}" placeholder="例如：Code Reviewer"></label>
    <label>Role<input type="text" id="dyn-role" value="${esc(d.role || '')}" placeholder="例如：review"></label>
    <label>Lifetime<select id="dyn-lifetime">${['run', 'task', 'session', 'persistent'].map(v => `<option value="${v}" ${d.lifetime === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Model Policy<select id="dyn-model-mode">${['inherit_parent', 'auto', 'explicit'].map(v => `<option value="${v}" ${d.modelPolicy && d.modelPolicy.mode === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
  </div>
  <label>Description<input type="text" id="dyn-desc" value="${esc(d.description || '')}"></label>
  <label>System Prompt<textarea id="dyn-prompt" rows="4">${esc(d.systemPrompt || '')}</textarea></label>
  <div class="form-grid">
    <label>Tool Allow（逗号分隔）<input type="text" id="dyn-tool-allow" value="${esc(((d.toolPolicy && d.toolPolicy.allow) || []).join(', '))}"></label>
    <label>Tool Deny（逗号分隔）<input type="text" id="dyn-tool-deny" value="${esc(((d.toolPolicy && d.toolPolicy.deny) || []).join(', '))}"></label>
    <label>Skills Required（逗号分隔）<input type="text" id="dyn-skills" value="${esc(((d.skills && d.skills.required) || []).join(', '))}"></label>
    <label>Hooks Required（逗号分隔）<input type="text" id="dyn-hooks" value="${esc(((d.hooks && d.hooks.required) || []).join(', '))}"></label>
  </div>
  <div class="form-grid">
    <label><input type="checkbox" id="dyn-readonly" ${d.permissionPolicy && d.permissionPolicy.readOnly ? 'checked' : ''}> Read Only（只读，禁止文件修改）</label>
    <label><input type="checkbox" id="dyn-delegate" ${d.canDelegate ? 'checked' : ''}> Can Delegate（可委派子智能体）</label>
  </div>
  <div class="actions"><button class="btn primary" id="dyn-save">保存（走 AgentDefinition 校验）</button></div>
  <div id="dyn-errors"></div>`;
  openModal(existing ? 'Edit Dynamic Agent: ' + esc(existing.id) : 'New Dynamic Agent Definition', content);
  const splitList = value => String(value || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  $('#dyn-save').onclick = async () => {
    const definition = {
      ...(existing ? { id: existing.id } : {}),
      name: $('#dyn-name').value.trim(),
      role: $('#dyn-role').value.trim(),
      description: $('#dyn-desc').value.trim(),
      systemPrompt: $('#dyn-prompt').value,
      lifetime: $('#dyn-lifetime').value,
      modelPolicy: { ...(d.modelPolicy || {}), mode: $('#dyn-model-mode').value },
      toolPolicy: {
        allow: splitList($('#dyn-tool-allow').value),
        deny: splitList($('#dyn-tool-deny').value)
      },
      skills: { ...(d.skills || {}), required: splitList($('#dyn-skills').value) },
      hooks: { ...(d.hooks || {}), required: splitList($('#dyn-hooks').value) },
      permissionPolicy: { ...(d.permissionPolicy || {}), readOnly: $('#dyn-readonly').checked },
      canDelegate: $('#dyn-delegate').checked
    };
    try {
      if (existing) await api.dynDefUpdate(existing.id, definition);
      else await api.dynDefCreate(definition);
      closeModal();
      toast('Definition saved', 'ok');
      open('agents');
    } catch (error) {
      $('#dyn-errors').innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
      panels.addProblem(`Agent 定义校验失败：${error.message}`);
    }
  };
}

/** 健康状态 → chip CSS class */
function hubHealthClass(status) {
  if (status === 'healthy') return 'ok';
  if (status === 'degraded') return '';
  if (status === 'unavailable') return 'bad';
  return '';
}

/**
 * v2.8.1 §44/§45 — 验证级别 → chip 配色。
 * 刻意与 Health 用不同判据：只有「真实协议 / 真实任务」才给绿色，
 * 静态实现级 / Fixture 级一律中性，避免用户误以为跑通过真东西。
 */
function hubVerificationClass(level) {
  if (level === 'real_agent_task_verified' || level === 'real_protocol_verified') return 'ok';
  if (level === 'not_verified') return 'bad';
  return '';
}

/** 健康状态 → 展示文本 */
function hubHealthText(status) {
  return ({ healthy: '健康', degraded: '降级', unavailable: '不可用', checking: '检查中…', disabled: '已禁用', unknown: '未知' })[status] || '未知';
}

/**
 * B14.2 — External Agent 可用性词汇（严格）：AVAILABLE / UNAVAILABLE / UNKNOWN / ERROR。
 * 未安装/未检测到 → UNAVAILABLE，绝不显示为 ERROR；
 * ERROR 只保留给「已安装但协议/集成真实出错」；无证据 → UNKNOWN。
 */
function hubAvailability(healthStatus) {
  const s = String(healthStatus || '').toLowerCase();
  if (s === 'healthy' || s === 'degraded') return 'AVAILABLE';
  if (s === 'unavailable' || s === 'disabled' || s === 'not_installed') return 'UNAVAILABLE';
  if (s === 'error' || s === 'failed') return 'ERROR';
  return 'UNKNOWN';
}
function hubAvailabilityClass(v) {
  return v === 'AVAILABLE' ? 'ok' : v === 'UNAVAILABLE' || v === 'ERROR' ? 'bad' : '';
}

/** 能力键 → 展示标签（首字母大写 camelCase） */
function hubCapLabel(cap) {
  const map = { coding: 'Coding', planning: 'Planning', research: 'Research', review: 'Review', filesystem: 'Filesystem', terminal: 'Terminal', git: 'Git', browser: 'Browser', computer: 'Computer', vision: 'Vision', mcp: 'MCP', longRunning: 'LongRunning', parallel: 'Parallel', streaming: 'Streaming', resume: 'Resume', diff: 'Diff', sandbox: 'Sandbox', session: 'Session', approval: 'Approval', interrupt: 'Interrupt', reasoning: 'Reasoning', web: 'Web', subagent: 'Subagent' };
  return map[cap] || cap;
}

/**
 * v2.8.0 spec §79/§80 — 认证状态 chip。只展示状态机文本，
 * 绝不展示 Token / Cookie / Refresh Token 本体（spec §79 红线）。
 */
function hubAuthChip(auth) {
  if (!auth) return '';
  if (auth.authenticated) {
    const label = auth.mode === 'api_key' ? '已认证 (API Key)' : '已认证';
    return `<span class="chip ok" title="${esc(auth.detail || '')}">${label}</span>`;
  }
  if (auth.state === 'AUTH_REQUIRED' || auth.state === 'FAILED') {
    return `<span class="chip bad" title="${esc(auth.detail || '')}">需要登录</span>`;
  }
  return `<span class="chip" title="${esc(auth.detail || '')}">认证状态未知</span>`;
}

/** v2.8.0 spec §81 — 会话短标识：只显示尾 4 位，不暴露完整 UUID。 */
function hubSessionShort(externalSessionId) {
  const s = String(externalSessionId || '').replace(/[^a-zA-Z0-9]/g, '');
  return '#' + (s.slice(-4) || '????').toUpperCase();
}

/** 从 Agent Integration Hub 注册表加载并渲染统一卡片视图 */
async function loadHubCards(body) {
  const cardsEl = $('#hub-cards', body);
  if (!cardsEl) return;
  let available = [];
  let manifests = [];
  let connections = [];
  let clineConfig = {};
  let sessionData = { sessions: [], authStates: [] };
  let verification = {};
  try {
    [available, manifests, connections, clineConfig, sessionData, verification] = await Promise.all([
      api.hubAvailable(), api.hubManifests(), api.connections(), api.extcfgGet('cline'),
      (typeof api.hubSessions === 'function' ? api.hubSessions() : Promise.resolve({ sessions: [], authStates: [] })),
      (typeof api.hubVerification === 'function' ? api.hubVerification().catch(() => ({})) : Promise.resolve({}))
    ]);
  } catch (e) {
    cardsEl.innerHTML = `<div class="muted small">注册表不可用：${esc(e.message)}</div>`;
    return;
  }
  // v2.7.1 — 渲染所有已注册 Agent（来自 manifests），而不仅是当前可用的。
  // 不可用的 Agent 显示 "不可用" 健康状态，但仍展示卡片（spec §37 要求）。
  if (!Array.isArray(manifests) || !manifests.length) {
    cardsEl.innerHTML = '<div class="empty" data-page-state="empty">注册表中没有已注册 Agent</div>';
    return;
  }
  const availById = new Map((available || []).map(a => [a.id, a]));
  const sessionsByAgent = new Map();
  for (const s of (sessionData && sessionData.sessions) || []) {
    if (!sessionsByAgent.has(s.agent_id)) sessionsByAgent.set(s.agent_id, []);
    sessionsByAgent.get(s.agent_id).push(s);
  }
  cardsEl.innerHTML = manifests.map(m => {
    const a = availById.get(m.id) || {};
    const name = esc(m.displayName || m.id);
    // v2.8.0 spec §77：优先用人类可读 transport 标签（如 Codex App Server / ClineCore Sidecar）
    const transport = esc(a.transportLabel || (m.transport || a.transport || a.adapterType || 'unknown').toUpperCase());
    const caps = (m.capabilities && typeof m.capabilities === 'object')
      ? Object.keys(m.capabilities).filter(k => m.capabilities[k])
      : (Array.isArray(a.capabilities) ? a.capabilities : []);
    const healthStatus = availById.has(m.id)
      ? ((a.health && a.health.status) || a.healthStatus || 'unknown')
      : 'unavailable';
    // B14.2 — 可用性词汇与 Health 分开展示：未安装 = UNAVAILABLE（非 ERROR）
    const availability = hubAvailability(healthStatus);
    const clineHealth = m.id === 'cline' ? (a.health || {}) : null;
    const clineSidecarReady = !!(clineHealth?.sidecar?.ready || (clineHealth?.runtime?.probe && clineHealth?.runtime?.coreConstructible));
    const clineApiReady = !!clineHealth?.api?.configured;
    const clineWorkspaceReady = !!clineHealth?.workspace?.ready;
    const clineRuntime = clineHealth
      ? `<div class="small" style="margin-top:8px;line-height:1.55">
          <div><b>Integration:</b> ClineCore Sidecar</div>
          <div><b>Node Runtime:</b> ${esc(clineHealth.runtime?.nodeVersion || 'not detected')}</div>
          <div><b>SDK:</b> @cline/sdk ${esc(clineHealth.runtime?.clineSdkVersion || clineHealth.runtime?.sdkVersion || clineHealth.version || a.version || 'not detected')}</div>
          <div><b>Sidecar:</b> ${clineSidecarReady ? 'Ready' : 'Not ready'}</div>
          <div><b>API:</b> ${clineApiReady ? `Configured (${esc(clineHealth.api?.providerId || '')} / ${esc(clineHealth.api?.modelId || '')})` : `Not configured${clineHealth.api?.error ? ` — ${esc(clineHealth.api.error)}` : ''}`}</div>
          <div><b>Workspace:</b> ${clineWorkspaceReady ? `Ready (${esc(clineHealth.workspace?.path || '')})` : `Not ready${clineHealth.workspace?.error ? ` — ${esc(clineHealth.workspace.error)}` : ''}`}</div>
          <div><b>Health:</b> ${esc(hubHealthText(healthStatus))}${clineHealth.detail ? ` — ${esc(clineHealth.detail)}` : ''}</div>
        </div>`
      : '';
    // v2.8.1 §44/§45/§82 — 运行状态 / 认证状态 / 验证级别三者分开展示，
    // 避免一个绿色 Healthy 让用户以为所有东西都真跑过。
    const ver = (verification && verification[m.id]) || null;
    const verChip = ver
      ? `<span class="chip ${hubVerificationClass(ver.level)}" title="验证级别（≠ 运行状态）">验证：${esc(ver.levelLabel || '')}</span>`
      : '';
    const verRows = ver && Array.isArray(ver.dimensions) && ver.dimensions.length
      ? `<div class="ver-grid">${ver.dimensions.map(d =>
          `<div class="ver-row"><span class="ver-k">${esc(d.label)}</span><span class="ver-v ${d.value === '已验证' || d.value === '是' ? 'ok' : (d.value === '未验证' || d.value === '未检测到' ? 'no' : '')}">${esc(d.value)}</span></div>`
        ).join('')}</div>`
      : '';
    const external = m.source === 'external';
    const verificationFacts = ver ? `<div class="small" style="margin-top:8px;line-height:1.55">
      <div><b>Installed:</b> ${ver.installed ? 'Yes' : 'No'} · <b>Configured:</b> ${ver.configured ? 'Yes' : 'No'}</div>
      <div><b>Availability:</b> ${esc(ver.availability || 'UNKNOWN')} · <b>Health:</b> ${esc(ver.health || 'unknown')}</div>
      <div><b>Transport:</b> ${esc(ver.transport || a.transportLabel || 'unknown')} · <b>Runtime:</b> ${esc(ver.runtime || a.runtime || 'unknown')}</div>
      <div><b>Last Verified:</b> ${esc(ver.lastVerified || 'Never')} · <b>Real Task Verified:</b> ${ver.realTaskVerified ? 'Yes' : 'No'}</div>
      ${ver.lastFailure ? `<div class="err"><b>Last Failure:</b> ${esc(ver.lastFailure.reason || ver.lastFailure.status || 'unknown')}</div>` : ''}
    </div>` : '';
    return `<div class="acard" data-hub-id="${esc(m.id)}">
      <div class="acard-h"><b>${name}</b><span class="chip">${transport}</span><span class="chip ${hubAvailabilityClass(availability)}">状态：${esc(availability)}</span><span class="chip ${hubHealthClass(healthStatus)}">运行：${esc(hubHealthText(healthStatus))}</span>${hubAuthChip(a.auth)}${verChip}</div>
      <div class="acard-meta">${caps.map(c => `<span class="chip">${esc(hubCapLabel(c))}</span>`).join('') || '<span class="muted small">无能力声明</span>'}</div>
      ${verRows}
      ${verificationFacts}
      ${a.version || a.auth || (sessionsByAgent.get(m.id) || []).length ? `
      <div class="small" style="margin-top:8px;line-height:1.55">
        ${a.version ? `<div><b>Version:</b> ${esc(a.version)}</div>` : ''}
        ${a.auth ? `<div><b>Authentication:</b> ${esc(a.auth.detail || a.auth.state || '')}</div>` : ''}
        ${(sessionsByAgent.get(m.id) || []).slice(0, 3).map(s => `<div><b>Session:</b> ${esc(hubSessionShort(s.external_session_id))} · ${esc(s.transport || '')}${s.resumable ? ' · 可继续' : ''} · ${esc(s.last_status || '')}</div>`).join('')}
      </div>` : ''}
      ${clineRuntime}
      <div class="acard-f">${m.id === 'cline' ? '<button class="btn tiny" data-cline-config>Configure Cline</button>' : ''}${external ? `<button class="btn tiny" data-hub-safe="${esc(m.id)}" title="0 quota / 0 model calls">Safe Test</button><button class="btn tiny danger" data-hub-real="${esc(m.id)}">Real Verification</button>` : ''}</div>
    </div>`;
  }).join('');
  const clineConfigButton = cardsEl.querySelector('[data-cline-config]');
  if (clineConfigButton) clineConfigButton.onclick = () => openClineConfigModal(body, connections, clineConfig);
  cardsEl.querySelectorAll('[data-hub-safe]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = '检测中…';
    try {
      const result = await api.hubVerifySafe(b.dataset.hubSafe);
      await loadHubCards(body);
      toast(`Safe Test 完成：${result.verificationLevel || 'NOT_VERIFIED'}（0 model calls）`, 'ok');
    } catch (e) {
      toast('健康检查失败：' + e.message, 'error');
    } finally {
      b.disabled = false;
      b.textContent = orig;
    }
  });
  cardsEl.querySelectorAll('[data-hub-real]').forEach(b => b.onclick = async () => {
    const confirmed = window.confirm('将向真实外部智能体发送一个最小验证任务。\n这可能消耗该智能体的订阅/API 使用额度。\n验证使用临时项目，不会修改你的开发项目。');
    if (!confirmed) return;
    b.disabled = true;
    const orig = b.textContent;
    b.textContent = '验证中…';
    try {
      const result = await api.hubVerifyReal(b.dataset.hubReal, true);
      await loadHubCards(body);
      toast(result.ok ? 'Real Verification 通过' : `Real Verification 失败：${result.errorCode || result.error || 'unknown'}`, result.ok ? 'ok' : 'error');
    } catch (e) {
      toast('Real Verification 失败：' + e.message, 'error');
    } finally {
      b.disabled = false;
      b.textContent = orig;
    }
  });
}

function openClineConfigModal(body, connections, config = {}) {
  const modelIds = [...new Set((connections || []).flatMap(connection =>
    (connection.models || []).map(model => typeof model === 'string' ? model : model?.id).filter(Boolean)
  ))];
  openModal('Configure ClineCore Sidecar', `
    <div class="form2">
      <label>API connection
        <select id="cline-connection"><option value="">Not selected</option>${(connections || []).map(connection =>
          `<option value="${esc(connection.id)}" ${connection.id === config.connectionId ? 'selected' : ''}>${esc(connection.name || connection.id)}</option>`
        ).join('')}</select>
      </label>
      <label>Model
        <input id="cline-model" list="cline-models" value="${esc(config.model || '')}" placeholder="Model ID">
        <datalist id="cline-models">${modelIds.map(id => `<option value="${esc(id)}"></option>`).join('')}</datalist>
      </label>
    </div>
    <p class="muted small">The API credential stays in the encrypted API connection store and is passed to the sidecar only in memory for an authorized run.</p>
  `);
  const connectionEl = $('#cline-connection');
  const modelEl = $('#cline-model');
  connectionEl.onchange = () => {
    const selected = (connections || []).find(connection => connection.id === connectionEl.value);
    const first = selected?.models?.[0];
    if (!modelEl.value && first) modelEl.value = typeof first === 'string' ? first : (first.id || '');
  };
  onModalOk(async () => {
    if (!connectionEl.value) throw new Error('Select an API connection for Cline');
    if (!modelEl.value.trim()) throw new Error('Enter a model ID for Cline');
    await api.extcfgSet('cline', { connectionId: connectionEl.value, model: modelEl.value.trim() });
    await api.hubHealth({ force: true });
    closeModal();
    toast('Cline configuration saved', 'ok');
    await loadHubCards(body);
  });
}

/** 任务路由预览：输入任务描述 → 调用 hub:route → 展示评分排序结果 */
async function runHubRoutePreview(body) {
  const input = $('#hub-route-input', body);
  const results = $('#hub-route-results', body);
  const btn = $('#hub-route-btn', body);
  if (!input || !results) return;
  const desc = input.value.trim();
  results.innerHTML = '<div class="muted small">路由计算中…</div>';
  if (btn) { btn.disabled = true; }
  try {
    const ranked = await api.hubRoute({ required: ['coding', 'filesystem'], preferred: ['git'], description: desc });
    if (!Array.isArray(ranked) || !ranked.length) {
      results.innerHTML = '<div class="muted small">没有匹配的 Agent</div>';
      return;
    }
    results.innerHTML = ranked.map((r, i) => {
      const reasons = (r.reasons || []).map(x => `<li>${esc(x)}</li>`).join('');
      const penalties = (r.penalties || []).map(x => `<li class="muted small">${esc(x)}</li>`).join('');
      return `<div class="acard" style="margin-bottom:8px">
        <div class="acard-h"><b>#${i + 1} ${esc(r.agentId)}</b><span class="chip">score ${r.score}</span></div>
        ${reasons ? `<ul class="small" style="margin:4px 0 0 16px">${reasons}</ul>` : ''}
        ${penalties ? `<ul class="small" style="margin:4px 0 0 16px">${penalties}</ul>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    results.innerHTML = `<div class="err small">${esc(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; }
  }
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
      </section>`).join('') : '<div class="empty" data-page-state="empty">还没有 MCP 服务器</div>'}`;

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
/* Workflows (v2.9.5 serial Workflow Engine)                           */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* B12 — Artifact Builder（AI Generator UX 2.0）                        */
/* Draft only：生成 ≠ 验证，READY ≠ SAVED，SAVED ≠ EXECUTED。           */
/* 保存/验证一律走 backend 真实 validator；Renderer 不绕过任何边界。      */
/* ------------------------------------------------------------------ */
/* B12 状态标签统一来自 uiStatus.js（GENERATOR_STATUS_LABELS）。 */

/** B12.6 — Human View：把 JSON 草稿转成人可读摘要（按 artifact 类型）。 */
function generatorHumanView(draft) {
  const candidate = (draft && draft.candidate) || {};
  const type = draft && draft.artifactType;
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]); };
  if (type === 'agent') {
    add('Name', candidate.name || candidate.id);
    add('ID', candidate.id);
    add('Role', candidate.dynamicRole || candidate.role);
    add('Prompt', candidate.dynamicSystemPrompt || candidate.systemPrompt || candidate.prompt);
    const policy = candidate.toolPolicy || {};
    add('Tools', { allow: policy.allow, deny: policy.deny });
    add('Permissions', candidate.permissionPolicy);
    add('Model Policy', candidate.modelPolicy);
    add('Skills', candidate.skillIds);
    add('Hooks', candidate.hookIds);
    add('Lifetime', candidate.lifetime);
    add('Can Delegate', candidate.canDelegate);
  } else if (type === 'workflow') {
    add('Name', candidate.name || candidate.id);
    add('Description', candidate.description);
    add('Steps', Array.isArray(candidate.steps) ? candidate.steps.map(s => `${s.id} (${s.type})`).join(' → ') : null);
    add('Inputs', candidate.inputs);
  } else {
    add('Name', candidate.name || candidate.id);
    add('Description', candidate.description);
    for (const [key, value] of Object.entries(candidate)) {
      if (!['name', 'id', 'description'].includes(key)) add(key, value);
    }
  }
  return rows.length
    ? `<table class="tbl kv"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="small">${esc(truncate(v, 300))}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">无可展示的草稿内容。</div>';
}

async function refreshGeneratorBadge() {
  try {
    const drafts = await api.generatorListDrafts(50);
    panels.setBadge('generator', drafts.filter(d => d.status === 'READY').length);
  } catch { /* runtime 不可用时徽标缺省 */ }
}

async function renderGenerator(body) {
  const [connections, drafts] = await Promise.all([api.connections(), api.generatorListDrafts(20)]);
  refreshGeneratorBadge();
  const modelOptions = [];
  for (const connection of connections.filter(item => item.enabled !== 0)) {
    for (const model of connection.models || []) {
      const modelId = typeof model === 'string' ? model : model.id;
      if (modelId) modelOptions.push({ connectionId: connection.id, modelId, label: `${connection.name} / ${modelId}` });
    }
  }
  // B12.12 — Generator History（最近 Drafts 状态）
  const historyRows = drafts.map(d => `<tr><td class="mono small">${esc(truncate(d.draftId, 12))}</td><td>${esc(d.artifactType || '')}</td><td><span class="chip ${d.status === 'READY' ? 'warn' : d.status === 'SAVED' ? 'ok' : d.status === 'FAILED' ? 'bad' : ''}">${esc(GENERATOR_STATUS_LABEL[d.status] || d.status)}</span></td><td class="muted small">${esc(fmtTime(d.updatedAt || d.createdAt))}</td><td class="right"><button class="btn tiny" data-gen-open="${esc(d.draftId)}">Open</button></td></tr>`).join('');
  body.innerHTML = `
    <div class="card">
      <h3>Artifact Builder</h3>
      <p class="muted">生成配置草稿。Draft only：生成 ≠ 验证；READY ≠ SAVED；SAVED ≠ EXECUTED（保存不会自动运行）。</p>
      <div class="form-grid">
        <label>Artifact Type<select id="generator-type"><option value="agent">Agent</option><option value="skill">Skill</option><option value="hook">Hook</option><option value="workflow">Workflow</option></select></label>
        <label>Model<select id="generator-model"><option value="">Auto（Selected by Model Router）</option>${modelOptions.map(item => `<option value="${esc(JSON.stringify({ connectionId: item.connectionId, modelId: item.modelId }))}">${esc(item.label)}</option>`).join('')}</select></label>
      </div>
      <label>描述你希望生成的组件<textarea id="generator-intent" rows="7" maxlength="12000" placeholder="例如：创建一个只读安全审查 Agent，可以读取源码和运行测试，但不能修改文件。"></textarea></label>
      <div class="actions"><button class="primary" id="generator-generate">Generate Draft</button><button id="generator-regenerate" disabled>Regenerate</button><button id="generator-cancel" disabled>Cancel</button></div>
    </div>
    <div class="card">
      <h3>Draft <span id="generator-status-chip"></span></h3>
      <div id="generator-meta" class="muted">${drafts.length ? 'Select Generate Draft to create a new draft.' : 'No drafts yet.'}</div>
      <div id="generator-boundary"></div>
      <div class="task-tabs" id="generator-tabs" style="display:none">
        <button class="task-tab active" data-gen-tab="human">Human View</button>
        <button class="task-tab" data-gen-tab="json">Raw Definition</button>
      </div>
      <div id="generator-human"></div>
      <pre id="generator-json" style="max-height:420px;overflow:auto;display:none"></pre>
      <div id="generator-errors"></div>
      <div class="actions"><button id="generator-validate" disabled>Validate</button><button class="primary" id="generator-save" disabled>Save</button><button id="generator-discard" disabled>Discard</button></div>
    </div>
    <div class="card">
      <h3>Recent Drafts</h3>
      ${historyRows ? `<table class="tbl"><thead><tr><th>Draft</th><th>Type</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${historyRows}</tbody></table>` : '<div class="muted">No drafts yet.</div>'}
    </div>`;

  let currentDraft = null;
  let lastRequest = null;
  let genTab = 'human';
  let failedNotified = new Set();
  const renderDraft = draft => {
    currentDraft = draft;
    if (draft) { try { selectInspector('generatorDraft', draft); } catch { /* inspector 不可用时缺省 */ } }
    const selected = draft && draft.selectedModel;
    const chip = $('#generator-status-chip');
    if (draft) {
      const active = ['GENERATING', 'VALIDATING', 'REPAIRING'].includes(draft.status);
      const attemptText = (draft.attempts || 0) > 0 ? ` · Attempt ${draft.attempts}` : '';
      chip.innerHTML = `<span class="chip ${draft.status === 'READY' ? 'warn' : draft.status === 'SAVED' ? 'ok' : draft.status === 'FAILED' ? 'bad' : ''}">${esc(GENERATOR_STATUS_LABEL[draft.status] || draft.status)}</span>`;
      $('#generator-meta').textContent =
        `type: ${draft.artifactType} · attempts: ${draft.attempts || 0}${attemptText} · repairs: ${draft.repairCount || 0} · model: ${selected ? `${selected.connectionId} / ${selected.modelId}` : (draft.mode === 'auto' || !selected ? 'Auto（Model Router）' : 'pending')}${active ? ' · ' + esc(GENERATOR_STATUS_LABEL[draft.status] || draft.status) : ''}`;
    } else { chip.innerHTML = ''; $('#generator-meta').textContent = 'No draft.'; }
    // B12.10 — Save Boundary 明确提示
    const boundary = $('#generator-boundary');
    if (draft && draft.status === 'READY') boundary.innerHTML = '<div class="perm-destructive" style="border-color:rgba(210,153,34,.6);background:rgba(210,153,34,.08)">Draft only · Not saved · Not executed</div>';
    else if (draft && draft.status === 'SAVED') boundary.innerHTML = '<div class="perm-destructive" style="border-color:rgba(63,185,80,.6);background:rgba(63,185,80,.08)">Saved · 不会自动运行（SAVED ≠ EXECUTED）</div>';
    else boundary.innerHTML = '';
    // tabs
    const hasCandidate = draft && draft.candidate;
    $('#generator-tabs').style.display = hasCandidate ? '' : 'none';
    $('#generator-human').style.display = hasCandidate && genTab === 'human' ? '' : 'none';
    $('#generator-json').style.display = hasCandidate && genTab === 'json' ? '' : 'none';
    if (hasCandidate) {
      $('#generator-human').innerHTML = generatorHumanView(draft);
      $('#generator-json').textContent = JSON.stringify(draft.candidate, null, 2);
    }
    // B12.8 — Validation truth（VALID / INVALID + 错误码）
    const validation = draft && draft.validation;
    const errors = validation && validation.errors || [];
    const validationChip = validation
      ? (validation.valid
        ? '<span class="chip ok">VALID</span>'
        : '<span class="chip bad">INVALID</span>')
      : '';
    $('#generator-errors').innerHTML =
      (validation ? `<div style="margin:6px 0">${validationChip}</div>` : '') +
      (errors.length ? `<div class="error-box">${errors.map(error => `<div>${esc(error.code)}: ${esc(error.message)}</div>`).join('')}</div>` : '') +
      (draft && draft.error ? `<div class="error-box">${esc(draft.errorCode || '')}: ${esc(draft.error)}</div>` : '');
    if (draft && draft.status === 'FAILED' && !failedNotified.has(draft.draftId)) {
      failedNotified.add(draft.draftId);
      panels.addProblem(`Generator 失败：${draft.errorCode || 'GENERATOR_FAILED'} ${draft.error || ''}`);
      refreshGeneratorBadge();
    }
    if (draft && draft.status === 'READY' && !failedNotified.has('ready:' + draft.draftId)) {
      failedNotified.add('ready:' + draft.draftId);
      refreshGeneratorBadge();
    }
    const active = draft && ['GENERATING', 'VALIDATING', 'REPAIRING'].includes(draft.status);
    // B12.9 — Save 只对 READY 且 VALID 可用；INVALID 一律阻断
    const valid = !validation || validation.valid !== false;
    $('#generator-validate').disabled = !hasCandidate || active;
    $('#generator-save').disabled = !draft || draft.status !== 'READY' || !valid;
    $('#generator-discard').disabled = !draft || draft.status === 'SAVED' || draft.status === 'DISCARDED';
    $('#generator-regenerate').disabled = !lastRequest || active;
    $('#generator-cancel').disabled = !active;
  };
  $('#generator-tabs').querySelectorAll('[data-gen-tab]').forEach(b => {
    b.onclick = () => { genTab = b.dataset.genTab; renderDraft(currentDraft); };
  });
  const poll = async draftId => {
    for (;;) {
      const draft = await api.generatorGetDraft(draftId);
      if (!draft || currentDraft && currentDraft.draftId !== draftId) return;
      renderDraft(draft);
      if (!['GENERATING', 'VALIDATING', 'REPAIRING'].includes(draft.status)) return;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  };
  const generate = async request => {
    try {
      lastRequest = request;
      const draft = await api.generatorGenerate(request);
      renderDraft(draft);
      await poll(draft.draftId);
    } catch (error) { toast(error.message, 'error'); }
  };
  $('#generator-generate').onclick = () => {
    const intent = $('#generator-intent').value.trim();
    if (!intent) return toast('请先描述你希望生成的组件。', 'error');
    const rawModel = $('#generator-model').value;
    const explicitModel = rawModel ? JSON.parse(rawModel) : null;
    return generate({
      schemaVersion: 1,
      artifactType: $('#generator-type').value,
      intent,
      mode: explicitModel ? 'explicit_model' : 'auto',
      explicitModel,
      context: { projectId: null, projectSummary: null }
    });
  };
  $('#generator-regenerate').onclick = () => lastRequest && generate(lastRequest);
  $('#generator-cancel').onclick = async () => { if (currentDraft) renderDraft(await api.generatorCancel(currentDraft.draftId)); };
  $('#generator-validate').onclick = async () => {
    if (!currentDraft) return;
    try { renderDraft(await api.generatorValidate(currentDraft.draftId)); }
    catch (error) { toast(error.message, 'error'); renderDraft(await api.generatorGetDraft(currentDraft.draftId)); }
  };
  $('#generator-save').onclick = async () => {
    try { const result = await api.generatorSave(currentDraft.draftId); renderDraft(result.draft); toast('Definition saved (not enabled or executed).', 'ok'); refreshGeneratorBadge(); }
    catch (error) { toast(error.message, 'error'); panels.addProblem(`Generator 保存失败：${error.message}`); renderDraft(await api.generatorGetDraft(currentDraft.draftId)); }
  };
  $('#generator-discard').onclick = async () => { if (currentDraft) { renderDraft(await api.generatorDiscard(currentDraft.draftId)); refreshGeneratorBadge(); } };
  body.querySelectorAll('[data-gen-open]').forEach(button => {
    button.onclick = async () => {
      try { renderDraft(await api.generatorGetDraft(button.dataset.genOpen)); }
      catch (error) { toast(error.message, 'error'); }
    };
  });
}

/* ------------------------------------------------------------------ */
/* B11 — Workflow Operations Workspace                                  */
/* 定义库 / 详情（Overview · Definition · Runs）/ 简单图形 /            */
/* Run 表单 / 实时步骤视图 / Approval / Cancel。所有执行真话在 backend    */
/* Workflow Runtime；Renderer 只呈现与发决策请求，绝不自动 approve。      */
/* ------------------------------------------------------------------ */
const WF_STEP_CLASS = Object.freeze({
  PENDING: '', READY: '', RUNNING: 'run', WAITING_APPROVAL: 'warn',
  COMPLETED: 'ok', FAILED: 'bad', SKIPPED: 'warn', CANCELLED: 'warn'
});

function wfStepChip(status) {
  return `<span class="chip ${WF_STEP_CLASS[status] || ''}">${esc(WF_STEP_LABEL[status] || status)}</span>`;
}

/** B11.3 — 纯 HTML/CSS 步骤图（不引入 DAG 库；runtime 是串行执行，不呈现 parallel）。 */
function workflowDiagram(def) {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  if (!steps.length) return '<div class="muted">无步骤。</div>';
  const nodes = [];
  steps.forEach((step, index) => {
    const config = step.config || {};
    let detail = '';
    let kind = step.type;
    if (step.type === 'agent') detail = `目标：${config.goal || ''}` + (config.target && config.target.mode !== 'main' ? ` · ${config.target.mode}` : '');
    else if (step.type === 'tool') detail = `工具：${config.toolName || ''}`;
    else if (step.type === 'condition') detail = `${config.source || ''} ${config.operator || ''} ${config.value !== undefined ? JSON.stringify(config.value) : ''}`;
    else if (step.type === 'approval') detail = config.message || '需要人工批准';
    const retry = step.retry && step.retry.maxAttempts > 1 ? ` · retry ×${step.retry.maxAttempts}` : '';
    nodes.push(`<div class="wf-node wf-node-${esc(step.type)}"><div class="wf-node-head"><span class="wf-node-kind">${esc(kind)}</span><b class="mono">${esc(step.id)}</b><span class="muted small">${esc(detail)}${esc(retry)}</span></div>${step.type === 'condition' ? '<div class="wf-cond-branches"><span>├ true → 继续</span><span>└ false → 跳过后续依赖步骤</span></div>' : ''}</div>`);
    if (index < steps.length - 1) nodes.push('<div class="wf-arrow">↓</div>');
  });
  return `<div class="wf-diagram">${nodes.join('')}</div>`;
}

/** B11.4 — 输入表单：definition.inputs 有字段则逐键输入，否则 JSON Input。 */
function workflowInputForm(def) {
  const inputs = (def && def.inputs && typeof def.inputs === 'object') ? def.inputs : {};
  const keys = Object.keys(inputs);
  if (keys.length) {
    return `<div class="form-grid">${keys.map(key => {
      const spec = inputs[key] || {};
      const description = typeof spec === 'string' ? spec : (spec.description || '');
      const defVal = spec && spec.default !== undefined ? JSON.stringify(spec.default) : '';
      return `<label>${esc(key)}${description ? ` <span class="muted small">(${esc(description)})</span>` : ''}<input type="text" data-wf-input="${esc(key)}" value="${esc(defVal)}" placeholder="JSON 或文本"></label>`;
    }).join('')}</div>`;
  }
  return `<label>JSON Input<textarea id="wf-json-input" rows="6" placeholder='{}'></textarea></label>`;
}

function parseWorkflowInput(def, body) {
  const inputs = (def && def.inputs && typeof def.inputs === 'object') ? def.inputs : {};
  const keys = Object.keys(inputs);
  if (keys.length) {
    const out = {};
    for (const key of keys) {
      const el = body.querySelector(`[data-wf-input="${key}"]`);
      const raw = el ? el.value.trim() : '';
      if (!raw) continue;
      try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
    }
    return out;
  }
  const jsonEl = $('#wf-json-input');
  const raw = jsonEl ? jsonEl.value.trim() : '';
  if (!raw) return {};
  const parsed = JSON.parse(raw); // 无效 JSON 由调用方捕获提示
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('输入必须是 JSON 对象');
  return parsed;
}

/** B11.5/B11.6/B11.8 — 实时步骤视图（状态词汇统一，retry attempt 来自 runtime 真实数据）。 */
function workflowRunSteps(run, def) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const defSteps = def && Array.isArray(def.steps) ? def.steps : [];
  return steps.map(step => {
    const definition = defSteps.find(s => s.id === step.stepId) || {};
    const maxAttempts = definition.retry && definition.retry.maxAttempts > 1 ? definition.retry.maxAttempts : null;
    const attempt = step.attempt > 0 && maxAttempts ? ` <span class="muted small">Attempt ${step.attempt} / ${maxAttempts}</span>` : '';
    const error = step.error ? `<div class="muted small">${esc(truncate(String(step.error), 160))}</div>` : '';
    return `<div class="wf-run-step"><span class="mono">${esc(step.stepId)}</span>${wfStepChip(step.status)}${attempt}${error}</div>`;
  }).join('');
}

function workflowRunResult(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const completed = steps.filter(s => s.status === 'COMPLETED').length;
  const failed = steps.filter(s => s.status === 'FAILED').length;
  const duration = run.startedAt && run.terminalAt ? Math.max(0, Math.round((new Date(run.terminalAt).getTime() - new Date(run.startedAt).getTime()) / 1000)) : null;
  const output = run.output && Object.keys(run.output).length ? `<pre class="skill-pre">${esc(JSON.stringify(run.output, null, 2))}</pre>` : '';
  return `<div class="wf-result"><span class="chip ${run.status === 'COMPLETED' ? 'ok' : run.status === 'FAILED' ? 'bad' : 'warn'}">${esc(WF_RUN_LABEL[run.status] || run.status)}</span><span class="muted small">步骤完成 ${completed} · 失败 ${failed}${duration !== null ? ` · ${duration}s` : ''}</span>${output}</div>`;
}

async function refreshWorkflowBadge() {
  try {
    const runs = await api.workflowListRuns(50);
    const waiting = runs.filter(r => r.status === 'WAITING_APPROVAL').length;
    panels.setBadge('workflow', waiting);
  } catch { /* runtime 不可用时徽标缺省 */ }
}

/** app.js 事件总线接入：workflow 状态/步骤事件 → 徽标 + Problems（不只 toast）。 */
export function handleWorkflowEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'workflow:state') {
    if (ev.status === 'WAITING_APPROVAL') refreshWorkflowBadge();
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(ev.status)) {
      refreshWorkflowBadge();
      if (ev.status === 'FAILED') panels.addProblem(`Workflow 失败：${ev.workflowId || ev.workflowRunId || ''} ${ev.error || ''}`);
    }
  }
}

async function renderWorkflows(body) {
  const [definitions, runs] = await Promise.all([api.workflowList(), api.workflowListRuns(50)]);
  refreshWorkflowBadge();
  const lastRunByWorkflow = new Map();
  for (const run of runs) {
    if (run.workflowId && !lastRunByWorkflow.has(run.workflowId)) lastRunByWorkflow.set(run.workflowId, run);
  }
  // B11.1 — Workflow Library
  const definitionRows = definitions.map(w => {
    const last = lastRunByWorkflow.get(w.id);
    return '<tr><td><b>' + esc(w.name) + '</b><div class="muted small mono">' + esc(w.id) + '</div>' +
      (w.description ? '<div class="muted small">' + esc(truncate(w.description, 80)) + '</div>' : '') +
      '</td><td>' + w.steps.length + '</td><td><span class="chip ' + (w.enabled ? 'ok' : '') + '">' + (w.enabled ? 'enabled' : 'disabled') + '</span></td>' +
      '<td class="small muted">' + (last ? esc(WF_RUN_LABEL[last.status] || last.status) + ' · ' + esc(fmtTime(last.updatedAt || last.startedAt)) : '—') + '</td>' +
      '<td class="right">' +
      '<button class="btn tiny" data-wf-open="' + esc(w.id) + '">Open</button>' +
      '<button class="btn tiny primary" data-wf-run="' + esc(w.id) + '"' + (w.enabled ? '' : ' disabled') + '>Run</button>' +
      '<button class="btn tiny" data-wf-dup="' + esc(w.id) + '">Duplicate</button>' +
      '<button class="btn tiny" data-wf-toggle="' + esc(w.id) + '">' + (w.enabled ? 'Disable' : 'Enable') + '</button>' +
      '<button class="btn tiny danger" data-wf-del="' + esc(w.id) + '">Delete</button></td></tr>';
  }).join('');
  // B11.5 — Recent Runs（实时状态 + 批准/取消入口）
  const runRows = runs.slice(0, 30).map(run => {
    const steps = (run.steps || []).map(step =>
      '<span class="tag">' + esc(step.stepId) + ': ' + esc(WF_STEP_LABEL[step.status] || step.status) + '</span>'
    ).join('');
    const actions = ['RUNNING', 'WAITING_APPROVAL'].includes(run.status)
      ? '<button class="btn tiny danger" data-wr-cancel="' + esc(run.workflowRunId) + '">Cancel</button>'
      : '';
    const approval = run.status === 'WAITING_APPROVAL'
      ? '<button class="btn tiny primary" data-wr-approve="' + esc(run.workflowRunId) + '">Approve</button>' +
        '<button class="btn tiny" data-wr-reject="' + esc(run.workflowRunId) + '">Reject</button>'
      : '';
    return '<tr><td class="mono small">' + esc(truncate(run.workflowRunId, 12)) + '</td><td class="small mono">' + esc(run.workflowId || '') + '</td><td>' +
      '<span class="chip ' + (run.status === 'COMPLETED' ? 'ok' : run.status === 'FAILED' ? 'bad' : run.status === 'WAITING_APPROVAL' ? 'warn' : '') + '">' + esc(WF_RUN_LABEL[run.status] || run.status) + '</span>' +
      '<div class="taglist">' + steps + '</div></td><td class="right">' +
      '<button class="btn tiny" data-wr-view="' + esc(run.workflowRunId) + '">View</button>' + approval + actions + '</td></tr>';
  }).join('');
  body.innerHTML =
    '<div class="page-actions"><button class="btn" id="workflow-refresh">Refresh</button></div>' +
    '<section class="panel"><h3>Workflow Library</h3>' +
    (definitionRows ? '<table class="tbl"><thead><tr><th>Workflow</th><th>Steps</th><th>Status</th><th>Last Run</th><th></th></tr></thead><tbody>' +
      definitionRows + '</tbody></table>' : '<div class="muted">No workflows defined.</div>') +
    '</section><section class="panel"><h3>Recent Runs</h3>' +
    (runRows ? '<table class="tbl"><thead><tr><th>Run</th><th>Workflow</th><th>State / Steps</th><th></th></tr></thead><tbody>' +
      runRows + '</tbody></table>' : '<div class="muted">No workflow runs.</div>') + '</section>';
  $('#workflow-refresh').onclick = () => open('workflows');
  body.querySelectorAll('[data-wf-open]').forEach(button => { button.onclick = () => renderWorkflowDetail(body, button.dataset.wfOpen); });
  body.querySelectorAll('[data-wf-toggle]').forEach(button => {
    button.onclick = async () => {
      const value = definitions.find(item => item.id === button.dataset.wfToggle);
      if (value.enabled) await api.workflowDisable(value.id);
      else await api.workflowEnable(value.id);
      open('workflows');
    };
  });
  body.querySelectorAll('[data-wf-dup]').forEach(button => {
    button.onclick = async () => {
      const source = definitions.find(item => item.id === button.dataset.wfDup);
      if (!source) return;
      try {
        const copy = JSON.parse(JSON.stringify(source));
        delete copy.enabled;
        copy.id = `${source.id}-copy-${Date.now().toString(36)}`;
        copy.name = `${source.name} (Copy)`;
        await api.workflowCreate(copy);
        toast('Workflow duplicated', 'ok');
        open('workflows');
      } catch (error) { toast(error.message, 'error'); }
    };
  });
  body.querySelectorAll('[data-wf-del]').forEach(button => {
    button.onclick = async () => {
      const confirmed = await confirmBox(`删除 Workflow 「${button.dataset.wfDel}」？此操作不可撤销。`);
      if (!confirmed) return;
      try { await api.workflowDelete(button.dataset.wfDel); open('workflows'); } catch (error) { toast(error.message, 'error'); }
    };
  });
  body.querySelectorAll('[data-wf-run]').forEach(button => {
    button.onclick = () => {
      const def = definitions.find(item => item.id === button.dataset.wfRun);
      if (def) openWorkflowRunDialog(def);
    };
  });
  body.querySelectorAll('[data-wr-view]').forEach(button => {
    button.onclick = () => renderWorkflowRunDetail(body, button.dataset.wrView);
  });
  bindWorkflowRunActions(body, () => open('workflows'));
}

/** B11.7 — Approval / Cancel 统一绑定：只发决策请求，最终由 runtime 裁决；绝不自动 approve。 */
function bindWorkflowRunActions(scope, after) {
  scope.querySelectorAll('[data-wr-cancel]').forEach(button => {
    button.onclick = async () => {
      try { await api.workflowCancel(button.dataset.wrCancel); toast('Workflow cancel requested', 'ok'); } catch (error) { toast(error.message, 'error'); }
      after();
    };
  });
  scope.querySelectorAll('[data-wr-approve]').forEach(button => {
    button.onclick = async () => {
      try { await api.workflowApprove(button.dataset.wrApprove); toast('Approved', 'ok'); } catch (error) { toast(error.message, 'error'); }
      after();
    };
  });
  scope.querySelectorAll('[data-wr-reject]').forEach(button => {
    button.onclick = async () => {
      try { await api.workflowReject(button.dataset.wrReject); toast('Rejected', 'ok'); } catch (error) { toast(error.message, 'error'); }
      after();
    };
  });
}

function openWorkflowRunDialog(def) {
  if (!state.project) return toast('Open a project before running a Workflow.', 'warn');
  const content = `<div class="wf-run-form">${workflowInputForm(def)}<div class="actions"><button class="btn primary" id="wf-run-start">Run Workflow</button></div></div>`;
  openModal('Run Workflow: ' + esc(def.name || def.id), content);
  $('#wf-run-start').onclick = async () => {
    try {
      const input = parseWorkflowInput(def, $('#modal'));
      const execution = await api.workflowRun(def.id, input, {
        projectId: state.project.id,
        projectRoot: state.project.root_path
      });
      closeModal();
      toast('Workflow started', 'ok');
      if (execution && execution.workflowRunId) renderWorkflowRunDetail($('#page-body'), execution.workflowRunId);
    } catch (error) { toast(error.message, 'error'); }
  };
}

/** B11.2 — Workflow Detail（Overview / Definition / Runs tabs）。 */
async function renderWorkflowDetail(body, workflowId) {
  const [def, runs] = await Promise.all([api.workflowGet(workflowId), api.workflowListRuns(50)]);
  if (!def) { toast('Workflow not found', 'error'); return open('workflows'); }
  const ownRuns = runs.filter(r => r.workflowId === workflowId);
  let tab = 'overview';
  const renderTab = () => {
    const tabButton = name => `<button class="task-tab ${tab === name ? 'active' : ''}" data-wf-tab="${name}">${{ overview: 'Overview', definition: 'Definition', runs: 'Runs' }[name]}</button>`;
    let content = '';
    if (tab === 'overview') {
      content = `<div class="wf-overview"><table class="tbl kv"><tbody>
        <tr><td>Name</td><td>${esc(def.name)}</td></tr>
        <tr><td>ID</td><td class="mono">${esc(def.id)}</td></tr>
        <tr><td>Description</td><td>${esc(def.description || '—')}</td></tr>
        <tr><td>Steps</td><td>${def.steps.length}</td></tr>
        <tr><td>Enabled</td><td>${def.enabled ? 'yes' : 'no'}</td></tr>
        <tr><td>Inputs</td><td>${Object.keys(def.inputs || {}).length ? esc(Object.keys(def.inputs).join(', ')) : '—'}</td></tr>
      </tbody></table><h4>Diagram</h4>${workflowDiagram(def)}</div>`;
    } else if (tab === 'definition') {
      content = `<pre class="skill-pre" style="max-height:60vh;overflow:auto">${esc(JSON.stringify(def, null, 2))}</pre>`;
    } else {
      content = ownRuns.length
        ? '<table class="tbl"><thead><tr><th>Run</th><th>State</th><th>Steps</th><th></th></tr></thead><tbody>' + ownRuns.map(run =>
            '<tr><td class="mono small">' + esc(truncate(run.workflowRunId, 12)) + '</td><td>' +
            '<span class="chip ' + (run.status === 'COMPLETED' ? 'ok' : run.status === 'FAILED' ? 'bad' : '') + '">' + esc(WF_RUN_LABEL[run.status] || run.status) + '</span></td><td class="small">' +
            (run.steps || []).map(s => esc(s.stepId) + ':' + esc(s.status)).join(' · ') + '</td><td class="right">' +
            '<button class="btn tiny" data-wr-view="' + esc(run.workflowRunId) + '">View</button></td></tr>').join('') + '</tbody></table>'
        : '<div class="muted">No runs for this workflow.</div>';
    }
    body.innerHTML = `<div class="page-actions"><button class="btn" id="wf-back">← Back</button>
      <button class="btn primary" id="wf-run-now" ${def.enabled ? '' : 'disabled'}>Run Workflow</button></div>
      <div class="task-tabs">${tabButton('overview')}${tabButton('definition')}${tabButton('runs')}</div>
      <section class="panel">${content}</section>`;
    $('#wf-back').onclick = () => open('workflows');
    $('#wf-run-now').onclick = () => openWorkflowRunDialog(def);
    body.querySelectorAll('[data-wf-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.wfTab; renderTab(); }; });
    body.querySelectorAll('[data-wr-view]').forEach(b => { b.onclick = () => renderWorkflowRunDetail(body, b.dataset.wrView); });
  };
  renderTab();
}

/** B11.5/B11.7/B11.9/B11.10 — Workflow Run View（轮询 runtime 真实状态，bounded）。 */
async function renderWorkflowRunDetail(body, workflowRunId) {
  if (!body) return;
  let revision = (renderWorkflowRunDetail.revision = (renderWorkflowRunDetail.revision || 0) + 1);
  let timer = null;
  const render = async () => {
    let run = null;
    try { run = await api.workflowGetRun(workflowRunId); } catch { /* transient */ }
    if (revision !== renderWorkflowRunDetail.revision) return;
    if (!run) { body.innerHTML = '<div class="muted">Workflow run not found.</div><div class="page-actions"><button class="btn" id="wf-back">← Back</button></div>'; $('#wf-back').onclick = () => open('workflows'); return; }
    let def = null;
    try { def = await api.workflowGet(run.workflowId); } catch { /* definition may be removed */ }
    const waitingApproval = run.status === 'WAITING_APPROVAL';
    const approvalStep = waitingApproval ? (run.steps || []).find(s => s.status === 'WAITING_APPROVAL') : null;
    const approvalDef = def && approvalStep && Array.isArray(def.steps) ? def.steps.find(s => s.id === approvalStep.stepId) : null;
    const approvalCard = waitingApproval
      ? `<div class="wf-approval-card"><div class="perm-sec-label">Workflow Approval</div>
          <table class="perm-meta"><tbody>
          <tr><td>Workflow</td><td class="mono">${esc(run.workflowId || '')}</td></tr>
          <tr><td>Step</td><td class="mono">${esc(approvalStep ? approvalStep.stepId : '')}</td></tr>
          <tr><td>Reason</td><td>${esc(approvalDef && approvalDef.config && approvalDef.config.message || '人工批准节点')}</td></tr>
          <tr><td>Input</td><td class="mono small">${esc(truncate(JSON.stringify(run.input || {}), 300))}</td></tr>
          </tbody></table>
          <div class="perm-opts"><button class="btn primary" data-wr-approve="${esc(run.workflowRunId)}">Approve</button>
          <button class="btn danger" data-wr-reject="${esc(run.workflowRunId)}">Reject</button></div></div>`
      : '';
    const cancelBtn = ['RUNNING', 'WAITING_APPROVAL'].includes(run.status)
      ? `<button class="btn danger" data-wr-cancel="${esc(run.workflowRunId)}">Cancel Workflow</button>` : '';
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status);
    body.innerHTML = `<div class="page-actions"><button class="btn" id="wf-back">← Back</button>${cancelBtn}</div>
      <section class="panel"><h3>Workflow Run <span class="mono small">${esc(truncate(workflowRunId, 16))}</span></h3>
      ${terminal ? workflowRunResult(run) : `<div class="chip ${run.status === 'WAITING_APPROVAL' ? 'warn' : ''}">${esc(WF_RUN_LABEL[run.status] || run.status)}</div>`}
      ${approvalCard}
      <h4>Steps</h4><div class="wf-run-steps">${workflowRunSteps(run, def) || '<div class="muted">No steps.</div>'}</div>
      ${def ? `<h4>Diagram</h4>${workflowDiagram(def)}` : ''}
      </section>`;
    $('#wf-back').onclick = () => { if (timer) clearTimeout(timer); open('workflows'); };
    bindWorkflowRunActions(body, () => open('workflows'));
    // B39 — Workflow Step → Inspector
    body.querySelectorAll('.wf-run-step').forEach((el, index) => {
      el.style.cursor = 'pointer';
      el.onclick = () => { const step = (run.steps || [])[index]; if (step) selectInspector('workflowStep', step); };
    });
    refreshWorkflowBadge();
    if (!terminal && revision === renderWorkflowRunDetail.revision) {
      timer = setTimeout(render, 1000); // bounded 轮询：终态即停，页面切换由 revision 失效
    }
  };
  await render();
}

/* ------------------------------------------------------------------ */
/* Skills (v2.9.3 Skill Engine — R2/R3/R6)                             */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* v2.9.9 Phase B Final（B17）— Skills + Hooks Workbench                */
/* 权威边界：Skill 可以要求 authority，但绝不得授予 authority；         */
/* Hook 只能选择受信 handler，绝无脚本/HTTP 输入；GUI 不提供任何        */
/* “Grant Permission”类选项。                                            */
/* ------------------------------------------------------------------ */

const HOOK_EVENTS = ['run_start', 'before_model', 'after_model', 'before_tool', 'after_tool', 'before_delegate', 'after_delegate', 'run_end'];
const HOOK_KINDS = ['observer', 'guard', 'context'];

async function renderSkills(body) {
  const [list, hooks, usage] = await Promise.all([
    api.skillList(),
    api.hookList().catch(() => []),
    api.artifactUsage().catch(() => ({ skills: {}, hooks: {} }))
  ]);
  body.innerHTML = `
    <div class="page-actions">
      <button class="btn primary" id="skill-add">+ 新建 Skill</button>
      <button class="btn" id="hook-add">+ 新建 Hook</button>
      <span class="muted">Skill 只能要求工具/权限/模型能力，绝不能授予能力；Hook 只能选择受信 handler。</span>
    </div>
    <h3>Skills</h3>
    ${list.length ? `<table class="tbl"><thead><tr><th>名称</th><th>启用</th><th>描述</th><th>工具要求</th><th>模型要求</th><th>兼容性</th><th>Used By</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr>
        <td><b>${esc(s.name)}</b>${s.source === 'builtin' ? ' <span class="chip small">内置</span>' : ''}<div class="mono muted small">${esc(s.id)}</div></td>
        <td>${s.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip">禁用</span>'}</td>
        <td class="small">${esc(truncate(s.description || '', 80))}</td>
        <td class="small">${[...(s.toolRequirements.required || []), ...(s.toolRequirements.denied || []).map(t => '禁 ' + t)].map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">无</span>'}</td>
        <td class="small">${s.modelRequirements && s.modelRequirements.required && s.modelRequirements.required.vision ? '<span class="tag">vision</span>' : ''}${s.modelRequirements && s.modelRequirements.required && s.modelRequirements.required.nativeTools ? '<span class="tag">tools</span>' : ''}${!(s.modelRequirements && s.modelRequirements.required && (s.modelRequirements.required.vision || s.modelRequirements.required.nativeTools)) ? '<span class="muted">无</span>' : ''}</td>
        <td class="small muted">${esc(((s.compatibility && s.compatibility.agentTypes) || []).join('/') || 'native')}</td>
        <td class="small">${((usage.skills || {})[s.id] || []).map(u => `<span class="chip small">${esc(u)}</span>`).join('') || '<span class="muted">未引用</span>'}</td>
        <td class="right">
          <button class="btn tiny" data-view="${esc(s.id)}">查看</button>
          ${s.source === 'builtin' ? '' : `<button class="btn tiny" data-edit-skill="${esc(s.id)}">编辑</button>`}
          ${s.enabled ? `<button class="btn tiny" data-disable="${esc(s.id)}">禁用</button>` : `<button class="btn tiny" data-enable="${esc(s.id)}">启用</button>`}
          ${s.source === 'builtin' ? '' : `<button class="btn tiny danger" data-del="${esc(s.id)}">删除</button>`}
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty" data-page-state="empty">还没有 Skill，点击「+ 新建 Skill」创建。</div>'}
    <h3 style="margin-top:18px">Hooks</h3>
    ${hooks.length ? `<table class="tbl"><thead><tr><th>名称</th><th>Event</th><th>Kind</th><th>Handler</th><th>启用</th><th>Filters</th><th>Used By</th><th></th></tr></thead><tbody>
      ${hooks.map(hk => `<tr>
        <td><b>${esc(hk.name)}</b><div class="mono muted small">${esc(hk.id)}</div></td>
        <td class="mono small">${esc(hk.event)}</td>
        <td><span class="chip small ${hk.kind === 'guard' ? 'warn' : ''}">${esc(hk.kind)}</span></td>
        <td class="mono small">${esc(hk.handlerId)}</td>
        <td>${hk.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip">禁用</span>'}</td>
        <td class="small muted">${esc(truncate(JSON.stringify(hk.filters || {}), 60))}</td>
        <td class="small">${((usage.hooks || {})[hk.id] || []).map(u => `<span class="chip small">${esc(u)}</span>`).join('') || '<span class="muted">未引用</span>'}</td>
        <td class="right">
          <button class="btn tiny" data-hook-view="${esc(hk.id)}">查看</button>
          ${hk.enabled ? `<button class="btn tiny" data-hook-disable="${esc(hk.id)}">禁用</button>` : `<button class="btn tiny" data-hook-enable="${esc(hk.id)}">启用</button>`}
          <button class="btn tiny danger" data-hook-del="${esc(hk.id)}">删除</button>
        </td></tr>`).join('')}
    </tbody></table>` : '<div class="empty" data-page-state="empty">还没有 Hook。Hook 只能绑定受信 handler，不接受任何脚本输入。</div>'}`;

  $('#skill-add').onclick = () => skillForm(null);
  $('#hook-add').onclick = () => hookForm();
  body.querySelectorAll('[data-view]').forEach(b => b.onclick = () => skillView(b.dataset.view));
  body.querySelectorAll('[data-edit-skill]').forEach(b => b.onclick = async () => skillForm(await api.skillGet(b.dataset.editSkill)));
  body.querySelectorAll('[data-enable]').forEach(b => b.onclick = async () => { await api.skillEnable(b.dataset.enable); open('skills'); });
  body.querySelectorAll('[data-disable]').forEach(b => b.onclick = async () => { await api.skillDisable(b.dataset.disable); open('skills'); });
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除 Skill', {
      target: `Skill「${b.dataset.del}」`,
      consequence: '已引用它的 Agent/Workflow 将解析失败（fail closed）。',
      reversibility: '不可逆：需重新创建。'
    })) return;
    try { await api.skillDelete(b.dataset.del); toast('已删除', 'ok'); open('skills'); } catch (e) { toast(e.message, 'error'); }
  });
  body.querySelectorAll('[data-hook-view]').forEach(b => b.onclick = async () => hookView(await api.hookGet(b.dataset.hookView)));
  body.querySelectorAll('[data-hook-enable]').forEach(b => b.onclick = async () => { try { await api.hookEnable(b.dataset.hookEnable); open('skills'); } catch (e) { toast(e.message, 'error'); } });
  body.querySelectorAll('[data-hook-disable]').forEach(b => b.onclick = async () => { try { await api.hookDisable(b.dataset.hookDisable); open('skills'); } catch (e) { toast(e.message, 'error'); } });
  body.querySelectorAll('[data-hook-del]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('删除 Hook', {
      target: `Hook「${b.dataset.hookDel}」`,
      consequence: '引用它的 Agent/Workflow 会 fail closed。',
      reversibility: '不可逆：需重新创建。'
    })) return;
    try { await api.hookDelete(b.dataset.hookDel); toast('已删除', 'ok'); open('skills'); } catch (e) { toast(e.message, 'error'); }
  });
}

/* B17.2 — Skill Detail Tabs：Overview / Instructions / Requirements / Compatibility / References */
async function skillView(id) {
  const s = await api.skillGet(id);
  if (!s) { toast('Skill 不存在', 'error'); return; }
  const req = s.toolRequirements || {};
  const perm = s.permissionRequirements || {};
  const model = s.modelRequirements || {};
  const compat = s.compatibility || {};
  const vision = model.required && model.required.vision;
  const tabs = ['Overview', 'Instructions', 'Requirements', 'Compatibility', 'References'];
  const sections = {
    overview: `<div class="muted small">${esc(s.description || '')}</div>
      <table class="tbl kv"><tbody>
        <tr><td>ID</td><td class="mono">${esc(s.id)}</td></tr>
        <tr><td>启用</td><td>${s.enabled ? '是' : '否'}</td></tr>
        <tr><td>来源</td><td>${esc(s.source || 'custom')}</td></tr>
        <tr><td>依赖 Skill</td><td>${(s.requiresSkills || []).map(esc).join(', ') || '无'}</td></tr>
      </tbody></table>
      <div class="warn-box">Skill 可以要求 authority，但绝不得授予 authority。此处没有任何“授予权限”选项。</div>`,
    instructions: `<pre class="skill-pre">${esc(s.instructions || '（无 instructions）')}</pre>`,
    requirements: `<h4>工具要求</h4>
      <div class="taglist">
        ${(req.required || []).map(t => `<span class="tag">需 ${esc(t)}</span>`).join('')}
        ${(req.optional || []).map(t => `<span class="tag muted">可选 ${esc(t)}</span>`).join('')}
        ${(req.denied || []).map(t => `<span class="tag bad">禁 ${esc(t)}</span>`).join('')}
      </div>
      <h4>权限要求（仅要求，运行时仍由 PermissionEngine 裁决）</h4>
      <div class="taglist">${(perm.required || []).map(p => `<span class="tag">需 ${esc(p)}</span>`).join('') || '<span class="muted small">无</span>'}</div>
      <h4>模型要求</h4>
      <div class="muted small">${esc(JSON.stringify(model) || '无')}</div>
      ${vision ? '<div class="muted small">⚠ 要求 vision 模型：路由时强制淘汰纯文本模型（R6）。</div>' : ''}`,
    compatibility: `<table class="tbl kv"><tbody>
        <tr><td>Agent 类型</td><td>${esc(((compat.agentTypes) || []).join(', ') || 'native')}</td></tr>
        <tr><td>平台</td><td>${esc(((compat.platforms) || []).join(', ') || 'windows')}</td></tr>
        <tr><td>项目信号</td><td>${esc(((compat.projectSignals) || []).join(', ') || '无')}</td></tr>
      </tbody></table>`,
    references: `<div class="muted small">依赖 Skill：${(s.requiresSkills || []).map(esc).join(', ') || '无'}</div>
      <pre class="small">${esc(truncate(JSON.stringify(s, null, 2), 3000))}</pre>`
  };
  openModal(`Skill: ${esc(s.id)}` + (s.enabled ? '' : '（已禁用）'), `
    <div class="run-detail-tabs">${tabs.map((t, i) => `<button class="run-detail-tab ${i === 0 ? 'active' : ''}" data-skill-tab="${t.toLowerCase()}">${t}</button>`).join('')}</div>
    <div id="skill-tab-body">${sections.overview}</div>
  `, { noFooter: true });
  document.querySelectorAll('[data-skill-tab]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-skill-tab]').forEach(x => x.classList.toggle('active', x === b));
    $('#skill-tab-body').innerHTML = sections[b.dataset.skillTab];
  });
}

/* B17.3 — Skill 编辑（新建/更新）：一律经现有 Skill validator；无权限授予选项 */
function skillForm(existing) {
  const s = existing || {};
  const req = s.toolRequirements || {};
  const perm = s.permissionRequirements || {};
  const compat = s.compatibility || {};
  openModal(existing ? `编辑 Skill：${existing.id}` : '新建 Skill', `
    ${existing ? '' : '<label>ID<input id="s-id" placeholder="my-skill"></label>'}
    <label>名称<input id="s-name" value="${esc(s.name || '')}" placeholder="My Skill"></label>
    <label>描述<input id="s-desc" value="${esc(s.description || '')}" placeholder="简短描述"></label>
    <label>Instructions<textarea id="s-ins" rows="6" placeholder="专家指导文本，将注入 Agent 的 system prompt（位于 Safety Contract 之下）">${esc(s.instructions || '')}</textarea></label>
    <label>必需工具（逗号分隔）<input id="s-req" value="${esc((req.required || []).join(', '))}" placeholder="read_file, search"></label>
    <label>禁用工具（逗号分隔）<input id="s-den" value="${esc((req.denied || []).join(', '))}" placeholder="write_file, apply_patch"></label>
    <label>必需权限（逗号分隔，仅要求不授予）<input id="s-perm" value="${esc((perm.required || []).join(', '))}" placeholder="filesystem.read"></label>
    <label>兼容 Agent 类型（逗号分隔）<input id="s-compat" value="${esc((compat.agentTypes || ['native']).join(', '))}" placeholder="native"></label>
  `, { okText: existing ? '保存' : '创建' });
  onModalOk(async () => {
    const split = (v) => (v && v.trim() ? v.split(/\s*,\s*/).filter(Boolean) : []);
    const definition = {
      ...(existing ? {} : { id: $('#s-id').value.trim() }),
      name: $('#s-name').value.trim(),
      description: $('#s-desc').value.trim(),
      instructions: $('#s-ins').value,
      tags: s.tags || [],
      toolRequirements: { required: split($('#s-req').value), optional: req.optional || [], denied: split($('#s-den').value) },
      permissionRequirements: { required: split($('#s-perm').value) },
      modelRequirements: s.modelRequirements || {},
      compatibility: { agentTypes: split($('#s-compat').value), platforms: compat.platforms || ['windows'], projectSignals: compat.projectSignals || [] },
      metadata: s.metadata || {}
    };
    try {
      // 校验与落库全部由现有 Skill validator/registry 完成；失败会报错并保留原状
      if (existing) await api.skillUpdate(existing.id, definition);
      else await api.skillCreate(definition);
      toast(existing ? '已保存（经 Skill validator 校验）' : '已创建', 'ok'); closeModal(); open('skills');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* B17.5/B17.7 — Hook Detail：真实事件词汇 + Guard 可视化（可阻断执行，不可授予权限） */
async function hookView(hk) {
  if (!hk) { toast('Hook 不存在', 'error'); return; }
  const filters = hk.filters || {};
  openModal(`Hook: ${esc(hk.id)}` + (hk.enabled ? '' : '（已禁用）'), `
    <table class="tbl kv"><tbody>
      <tr><td>名称</td><td>${esc(hk.name)}</td></tr>
      <tr><td>Event</td><td class="mono">${esc(hk.event)}</td></tr>
      <tr><td>Kind</td><td>${esc(hk.kind)}</td></tr>
      <tr><td>Handler（受信）</td><td class="mono">${esc(hk.handlerId)}</td></tr>
      <tr><td>Priority / Timeout</td><td>${hk.priority ?? 0} / ${hk.timeoutMs ?? 5000}ms</td></tr>
    </tbody></table>
    ${hk.kind === 'guard' ? '<div class="warn-box">Guard Hook：可以阻断执行（block），但绝不能授予权限。</div>' : ''}
    <div class="warn-box">所有 Hook 只能观察 / 阻断 / 追加有界上下文，永远不能授予能力或权限。</div>
    <h4>Filters</h4>
    <pre class="small">${esc(JSON.stringify(filters, null, 2) || '{}')}</pre>
  `);
}

/* B17.6 — Hook 编辑器：handler 只能从受信列表选择；无 JavaScript/eval/shell/HTTP 输入 */
async function hookForm() {
  let handlers = [];
  try { handlers = await api.hookHandlersList(); } catch { handlers = []; }
  if (!handlers.length) { toast('当前没有已注册的受信 handler，无法创建 Hook', 'warn'); return; }
  openModal('新建 Hook', `
    <label>ID<input id="h-id" placeholder="my-hook"></label>
    <label>名称<input id="h-name" placeholder="My Hook"></label>
    <label>描述<input id="h-desc" placeholder="简短描述"></label>
    <label>Event
      <select id="h-event">${HOOK_EVENTS.map(ev => `<option value="${ev}">${ev}</option>`).join('')}</select>
    </label>
    <label>Kind
      <select id="h-kind">${HOOK_KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select>
    </label>
    <label>受信 Handler（只能选择，不能输入脚本）
      <select id="h-handler">${handlers.map(hd => `<option value="${esc(hd)}">${esc(hd)}</option>`).join('')}</select>
    </label>
    <div class="muted small">Hook 不接受 JavaScript / shell / HTTP webhook 输入；handler 只来自平台受信注册表。</div>
  `, { okText: '创建' });
  onModalOk(async () => {
    const definition = {
      id: $('#h-id').value.trim(),
      name: $('#h-name').value.trim(),
      description: $('#h-desc').value.trim(),
      event: $('#h-event').value,
      kind: $('#h-kind').value,
      handlerId: $('#h-handler').value,
      filters: {},
      config: {}
    };
    try { await api.hookCreate(definition); toast('已创建（仅受信 handler）', 'ok'); closeModal(); open('skills'); }
    catch (e) { toast(e.message, 'error'); }
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
  const curTheme = theme.getTheme();
  const curDensity = theme.getDensity();
  body.innerHTML = `
    <section class="panel">
      <h3>外观</h3>
      <div class="row">
        <label class="muted small" style="margin:0">主题
          <select id="set-theme" style="margin-left:8px">
            <option value="dark" ${curTheme === 'dark' ? 'selected' : ''}>深色</option>
            <option value="light" ${curTheme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="system" ${curTheme === 'system' ? 'selected' : ''}>跟随系统</option>
          </select>
        </label>
        <label class="muted small" style="margin:0">密度
          <select id="set-density" style="margin-left:8px">
            <option value="comfortable" ${curDensity === 'comfortable' ? 'selected' : ''}>舒适</option>
            <option value="compact" ${curDensity === 'compact' ? 'selected' : ''}>紧凑</option>
          </select>
        </label>
      </div>
    </section>

    <section class="panel">
      <h3>引导</h3>
      <div class="row">
        <span class="muted small">重新打开首次使用引导（打开项目 / 配置模型 / 测试连接 / 主智能体 / 首个任务）。</span>
        <button class="btn tiny" id="set-reopen-onboarding">重新打开引导</button>
      </div>
    </section>

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
  const reopenOnboarding = $('#set-reopen-onboarding');
  if (reopenOnboarding) reopenOnboarding.onclick = () => window.dispatchEvent(new CustomEvent('adp-reopen-onboarding'));
  const setThemeEl = $('#set-theme');
  if (setThemeEl) setThemeEl.onchange = async () => { await theme.setTheme(setThemeEl.value); toast('已应用主题', 'ok'); };
  const setDensityEl = $('#set-density');
  if (setDensityEl) setDensityEl.onchange = async () => { await theme.setDensity(setDensityEl.value); toast('已应用密度', 'ok'); };
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
