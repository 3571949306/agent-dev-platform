import { api } from './api.js';
import { state } from './state.js';
import { $, esc, fmtBytes, fmtTime, truncate, toast } from './util.js';
import { getRunView, listRunViews, subscribeRunView } from './runViewModel.js';
import { stageLabel, statusLabel, isTerminalStatus } from './uiStatus.js';

const fileTabs = new Map();
let activeView = { type: 'task', id: 'task' };
let unsubscribe = null;
let timer = null;

function setVisible(id) {
  ['task-workspace', 'workspace-file-view', 'workspace-run-view'].forEach(name => $(`#${name}`).classList.toggle('hidden', name !== id));
}

export function showTask(tab = 'chat') {
  activeView = { type: 'task', id: 'task' };
  setVisible('task-workspace');
  switchTaskTab(tab);
  renderTabs();
}

function switchTaskTab(tab) {
  document.querySelectorAll('.task-tab').forEach(button => button.classList.toggle('active', button.dataset.taskTab === tab));
  ['chat', 'progress', 'result'].forEach(name => $(`#task-${name}-pane`).classList.toggle('hidden', name !== tab));
}

function renderTabs() {
  const box = $('#workspace-tabs');
  const fileItems = [...fileTabs.values()].map(file => `<button class="workspace-tab ${activeView.type === 'file' && activeView.id === file.path ? 'active' : ''}" data-file-tab="${esc(file.path)}" title="${esc(file.path)}"><span>${esc(file.path)}</span><span class="tab-close" data-close-file="${esc(file.path)}">×</span></button>`).join('');
  box.innerHTML = `<button class="workspace-tab ${activeView.type === 'task' ? 'active' : ''}" data-workspace-task>Task</button>${fileItems}${activeView.type === 'run' ? `<button class="workspace-tab active" data-run-tab="${esc(activeView.id)}">Run ${esc(activeView.id.slice(0, 8))}</button>` : ''}`;
  box.querySelector('[data-workspace-task]').onclick = () => showTask();
  box.querySelectorAll('[data-file-tab]').forEach(button => {
    button.onclick = event => { if (!event.target.closest('[data-close-file]')) activateFile(button.dataset.fileTab); };
    button.oncontextmenu = event => { event.preventDefault(); openTabMenu(event.clientX, event.clientY, button.dataset.fileTab); };
  });
  box.querySelectorAll('[data-close-file]').forEach(button => button.onclick = event => { event.stopPropagation(); closeFile(button.dataset.closeFile); });
}

function openTabMenu(x, y, path) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'workbench-context-menu';
  menu.className = 'context-menu';
  menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  menu.innerHTML = `<button data-close-one>Close</button><button data-close-others>Close Others</button>`;
  document.body.appendChild(menu);
  menu.querySelector('[data-close-one]').onclick = () => { closeFile(path); closeContextMenu(); };
  menu.querySelector('[data-close-others]').onclick = () => { for (const key of [...fileTabs.keys()]) if (key !== path) fileTabs.delete(key); activateFile(path); closeContextMenu(); };
}

function closeContextMenu() { const old = $('#workbench-context-menu'); if (old) old.remove(); }

export async function openFile(path, fileData = null) {
  try {
    const file = fileData || await api.readFile(path);
    fileTabs.set(file.path || path, file);
    activateFile(file.path || path);
  } catch (error) { toast(error.message, 'error'); }
}

function activateFile(path) {
  const file = fileTabs.get(path);
  if (!file) return;
  activeView = { type: 'file', id: path };
  state.activeFilePath = path;
  setVisible('workspace-file-view');
  renderFile(file);
  renderTabs();
  selectInspector('file', file);
  window.dispatchEvent(new CustomEvent('workspace-file-changed', { detail: { path } }));
}

function closeFile(path) {
  fileTabs.delete(path);
  if (activeView.type === 'file' && activeView.id === path) {
    const next = [...fileTabs.keys()].pop();
    if (next) activateFile(next); else showTask();
  } else renderTabs();
}

function renderFile(file) {
  const box = $('#workspace-file-view');
  box.innerHTML = `<div class="file-view-head"><div class="file-title mono" title="${esc(file.path)}">${esc(file.path)}</div><div class="file-meta"><span>${esc(fmtBytes(file.size || 0))}</span><span>${esc(file.language || 'Plain Text')}</span>${file.lineCount !== null && file.lineCount !== undefined ? `<span>${file.lineCount} lines</span>` : ''}<span class="chip">READ ONLY</span></div><div class="file-actions"><button class="btn tiny" data-copy-file>Copy</button><button class="btn tiny" data-reveal-file>Reveal</button><button class="btn tiny" data-open-external>Open externally</button></div></div><div id="file-view-content" class="file-view-content"></div>`;
  const content = $('#file-view-content');
  if (file.binary) content.innerHTML = '<div class="preview-truth">Binary file</div>';
  else if (file.truncated) content.innerHTML = '<div class="preview-truth">File too large to preview</div>';
  else {
    const lines = String(file.content || '').split(/\r?\n/);
    const visible = lines.slice(0, 5000);
    const fragment = document.createDocumentFragment();
    visible.forEach((line, index) => {
      const row = document.createElement('div'); row.className = 'code-line';
      const number = document.createElement('span'); number.className = 'line-number'; number.textContent = String(index + 1);
      const text = document.createElement('span'); text.className = 'line-text'; text.textContent = line;
      row.append(number, text); fragment.appendChild(row);
    });
    content.appendChild(fragment);
    if (lines.length > visible.length) {
      const note = document.createElement('div'); note.className = 'preview-truth'; note.textContent = `Preview bounded to ${visible.length} lines`; content.appendChild(note);
    }
  }
  box.querySelector('[data-copy-file]').onclick = () => navigator.clipboard.writeText(file.content || '').then(() => toast('已复制', 'ok')).catch(error => toast(error.message, 'error'));
  box.querySelector('[data-reveal-file]').onclick = () => api.revealFile(file.path).catch(error => toast(error.message, 'error'));
  box.querySelector('[data-open-external]').onclick = () => api.openFileExternal(file.path).catch(error => toast(error.message, 'error'));
}

export async function openRun(runOrId) {
  const run = typeof runOrId === 'string' ? await api.runGet(runOrId) : runOrId;
  if (!run) return;
  activeView = { type: 'run', id: run.id || run.runId };
  setVisible('workspace-run-view');
  renderTabs();
  await renderRunDetail(run);
  selectInspector('run', run);
}

async function renderRunDetail(run) {
  const runId = run.id || run.runId;
  const [events, children] = await Promise.all([api.runEvents(runId).catch(() => []), api.runChildren(runId).catch(() => [])]);
  const box = $('#workspace-run-view');
  // v2.9.9 Phase B Final（B16）— Model Routing 页签：这次到底用了哪个模型
  const tabs = ['Overview', 'Timeline', 'Children', 'Tools', 'Files', 'Tests', 'Model', 'Audit'];
  box.innerHTML = `<div class="run-detail-head"><div><strong>${esc(run.goal || 'Run')}</strong><div class="mono muted">${esc(runId)}</div></div><span class="chip">${esc(statusLabel(run.status))}</span></div><div class="run-detail-tabs">${tabs.map((name, i) => `<button class="run-detail-tab ${i === 0 ? 'active' : ''}" data-run-detail="${name.toLowerCase()}">${name}</button>`).join('')}</div><div id="run-detail-body"></div>`;
  const data = { run, events, children };
  const show = async (name) => {
    box.querySelectorAll('.run-detail-tab').forEach(button => button.classList.toggle('active', button.dataset.runDetail === name));
    if (name === 'model') {
      $('#run-detail-body').innerHTML = '<div class="empty">加载中…</div>';
      $('#run-detail-body').innerHTML = await renderModelRoutingSection(runId);
      return;
    }
    $('#run-detail-body').innerHTML = renderRunSection(name, data);
    $('#run-detail-body').querySelectorAll('[data-child-run]').forEach(button => button.onclick = () => openRun(button.dataset.childRun));
  };
  box.querySelectorAll('.run-detail-tab').forEach(button => button.onclick = () => show(button.dataset.runDetail));
  await show('overview');
}

/* ---------------- B16 Model Router Inspector ---------------- */
const ROUTE_REASON_SIMPLE = {
  HIGHEST_DETERMINISTIC_SCORE: '自动选择：确定性打分最高',
  EXPLICIT_EXACT_MATCH: '指定模型：精确匹配',
  HARD_CONSTRAINTS_SATISFIED: '满足全部硬性约束',
  TOOL_CAPABILITY_REQUIRED: '满足工具调用要求',
  CAPABILITY_REQUIRED_TOOLS: '满足工具调用要求',
  COST_COMPARISON_SKIPPED_MIXED_BASIS: '价格单位不一致，跳过成本比较'
};
const CAPABILITY_EVIDENCE_LABEL = { tested: 'TESTED', declared: 'DECLARED', inferred: 'INFERRED', unknown: 'UNKNOWN' };

function routeSimpleReason(decision) {
  const codes = ((decision && decision.reasons) || []).map(r => r.code || r);
  const toolRelated = codes.some(c => /TOOL/.test(String(c)));
  if (decision && decision.mode === 'explicit') return '指定模型：精确匹配';
  if (toolRelated) return '自动选择：满足工具调用要求';
  const first = codes.find(c => ROUTE_REASON_SIMPLE[c]);
  return first ? ROUTE_REASON_SIMPLE[first] : '自动选择：确定性打分最高';
}

async function renderModelRoutingSection(runId) {
  let routing = null;
  try { routing = await api.runModelRouting(runId); } catch (e) { return `<div class="empty">无法加载路由信息：${esc(e.message)}</div>`; }
  if (!routing || !routing.decision) return '<div class="empty">本次 Run 没有 Model Router 决策记录（未经过 Router 的旧链路或尚未发起模型调用）。</div>';
  const d = routing.decision;
  const wire = routing.wire || {};
  const wireUnknown = wire.actual === null || wire.actual === undefined;
  const mismatch = wire.equal === false;
  const caps = routing.capabilities || {};
  const capBadge = (key, label) => {
    const cap = caps[key];
    if (!cap || cap.value === undefined || cap.value === null) return '';
    const evidence = CAPABILITY_EVIDENCE_LABEL[cap.state] || 'UNKNOWN';
    const on = cap.value === true;
    return `<span class="chip ${on ? 'ok' : ''} small" title="证据：${evidence}${cap.source ? ' · ' + esc(cap.source) : ''}">${esc(label)}${on ? ' ✓' : ' ✗'} · ${evidence}</span> `;
  };
  return `
  <table class="tbl kv"><tbody>
    <tr><td>Requested</td><td>${esc(d.requested || 'Auto')}</td></tr>
    <tr><td>Route Mode</td><td>${esc(d.mode)}</td></tr>
    <tr><td>Connection</td><td class="mono">${esc(d.connectionId || '—')}</td></tr>
    <tr><td>Selected Model</td><td class="mono">${esc(d.selectedModel || '—')}</td></tr>
    <tr><td>Actual Wire Model</td><td class="mono">${wireUnknown ? '<span class="muted">尚未产生真实调用</span>' : esc(wire.actual)}
      ${mismatch ? ' <span class="chip bad">MODEL MISMATCH</span>' : (wire.equal === true ? ' <span class="chip ok">SELECTED == WIRE</span>' : '')}</td></tr>
    <tr><td>Capabilities</td><td>${capBadge('text', 'Text')}${capBadge('vision', 'Vision')}${capBadge('nativeTools', 'Tools')}${capBadge('contextWindow', 'Context')}${Object.keys(caps).length ? '' : '<span class="muted">尚未探测（UNKNOWN）</span>'}</td></tr>
    <tr><td>Route Reason</td><td>${esc(routeSimpleReason(d))}</td></tr>
    <tr><td>Decision ID</td><td class="mono small">${esc(d.decisionId)}</td></tr>
    ${d.errorCode ? `<tr><td>Error</td><td><span class="chip bad">${esc(d.errorCode)}</span> ${d.mode === 'explicit' ? '<span class="muted small">（显式指定模型缺失时 FAIL CLOSED，绝不回退）</span>' : ''}</td></tr>` : ''}
  </tbody></table>
  <details class="route-advanced"><summary>Advanced（候选 / 硬过滤 / 打分）</summary>
    <div class="muted small">Score: ${d.score === null || d.score === undefined ? '—' : d.score} · Reasons: ${(d.reasons || []).map(r => esc(r.code || r)).join(', ') || '—'}</div>
    <pre class="small">${esc(truncate(JSON.stringify({ requirements: d.requirements, rejectedCandidates: d.rejectedCandidates }, null, 2), 4000))}</pre>
  </details>`;
}

function renderRunSection(name, { run, events, children }) {
  if (name === 'overview') return `<table class="tbl kv"><tbody><tr><td>Run ID</td><td class="mono">${esc(run.id || run.runId)}</td></tr><tr><td>Root Run ID</td><td class="mono">${esc(run.rootRunId || run.id)}</td></tr><tr><td>Parent Run ID</td><td class="mono">${esc(run.parentRunId || '—')}</td></tr><tr><td>智能体</td><td>${esc(run.agentName || run.agentId || '主智能体')}</td></tr><tr><td>Model</td><td>${esc(run.model || '—')}</td></tr><tr><td>Status</td><td>${esc(statusLabel(run.status))}</td></tr><tr><td>Start</td><td>${esc(fmtTime(run.startedAt))}</td></tr><tr><td>Duration</td><td>${formatDuration(run.durationMs)}</td></tr><tr><td>Verification</td><td>${esc(run.verification || '—')}</td></tr></tbody></table>`;
  if (name === 'children') return children.length ? children.map(child => `<button class="run-child-row" data-child-run="${esc(child.id)}"><span>${esc(child.agentName)}</span><span>${esc(statusLabel(child.status))}</span><span>${formatDuration(child.durationMs)}</span></button>`).join('') : '<div class="empty">No child runs</div>';
  let list = events;
  if (name === 'tools') list = events.filter(event => /action|tool/i.test(event.type));
  if (name === 'files') list = events.filter(event => /file/i.test(event.type));
  if (name === 'tests') list = events.filter(event => /test|verification/i.test(event.type));
  if (name === 'audit') list = events.filter(event => /permission|route|hook|error|fail/i.test(event.type));
  return list.length ? `<div class="run-event-list">${list.map(event => `<div class="run-event"><span class="mono">${esc(event.type)}</span><span>${esc(fmtTime(event.createdAt || event.timestamp))}</span><pre>${esc(truncate(JSON.stringify(event), 1000))}</pre></div>`).join('')}</div>` : '<div class="empty">No records</div>';
}

export function appendProgress(element) {
  const list = $('#task-progress-list');
  list.appendChild(element);
  while (list.children.length > 500) list.firstElementChild.remove();
}

export function renderResult(run) {
  const box = $('#task-result');
  const status = statusLabel(run.status);
  box.innerHTML = `<div class="execution-summary"><h2>${esc(status)}</h2><div class="summary-grid"><div><span>Duration</span><strong>${formatDuration((run.terminalAt || Date.now()) - run.startedAt)}</strong></div><div><span>Changed</span><strong>${run.files.length} files</strong></div><div><span>Tests</span><strong>${run.tests.length ? (run.tests.every(test => test.passed) ? 'PASS' : 'FAIL') : '—'}</strong></div><div><span>Verification</span><strong>${normalizeVerification(run)}</strong></div><div><span>Repairs</span><strong>${run.repairs}</strong></div><div><span>Children</span><strong>${logicalChildCount(run)}</strong></div></div>${run.result ? `<div class="result-summary">${esc(run.result)}</div>` : ''}<div class="row"><button class="btn" data-result-changes>View Changes</button><button class="btn" data-result-run>View Run</button><button class="btn" data-result-tests>View Tests</button></div></div>`;
  box.querySelector('[data-result-changes]').onclick = () => document.querySelector('.btab[data-btab="diff"]').click();
  box.querySelector('[data-result-run]').onclick = () => openRun(run.runId);
  box.querySelector('[data-result-tests]').onclick = () => showTask('progress');
}

function normalizeVerification(run) {
  // v2.9.9 Phase B PART A（A1）— Verification Truth：Renderer 不得从 run.status
  // 推导验证结论（completed != PASS）。只呈现 backend 机器证据；
  // 无 backend 值时用真实测试事件作证据；两者都没有则如实报告。
  const fromBackend = run.verificationStatus || run.verification;
  if (fromBackend && fromBackend !== '—') return fromBackend;
  if (run.tests && run.tests.length) return run.tests.every(test => test.passed) ? 'PASS' : 'FAIL';
  return isTerminalStatus(run.status) ? 'NOT_VERIFIED' : 'RUNNING';
}
function formatDuration(ms) { const s = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }

function logicalChildCount(run) {
  const runId = run.runId || run.id;
  const rootRunId = run.rootRunId || runId;
  const children = listRunViews().filter(candidate =>
    candidate.parentRunId === runId &&
    candidate.rootRunId === rootRunId &&
    Number(candidate.depth) > Number(run.depth || 0)
  );
  return new Set(children.map(child => child.agentId || child.adapterId || child.runId)).size;
}

function renderRunHeader(run) {
  const head = $('#run-header');
  head.classList.remove('hidden');
  $('#run-header-status').textContent = statusLabel(run.status);
  $('#run-header-status').className = `run-state status-${String(run.status).toLowerCase()}`;
  $('#run-header-agent').textContent = run.depth > 0 ? (run.adapterId || run.agentId || '子智能体') : '主智能体';
  $('#run-header-model').textContent = run.model || ($('#model-select') && $('#model-select').value) || '';
  $('#run-header-duration').textContent = formatDuration((run.terminalAt || Date.now()) - run.startedAt);
  $('#run-header-stage').textContent = stageLabel(run.stage);
  $('#run-header-children').textContent = `${logicalChildCount(run)} 个子智能体`;
  $('#run-header-files').textContent = `${run.files.length} files changed`;
  $('#run-header-verification').textContent = `Verification ${normalizeVerification(run)}`;
  $('#topbar-model').textContent = run.model || ($('#model-select') && $('#model-select').value) || '';
  if (isTerminalStatus(run.status)) renderResult(run);
}

export function selectInspector(type, value) {
  const box = $('#inspector-content');
  if (!box) return;
  if (type === 'file') box.innerHTML = inspectorSection('File', [['Path', value.path], ['Size', fmtBytes(value.size || 0)], ['Language', value.language || 'Plain Text'], ['Mode', 'Read only']]);
  else if (type === 'run') box.innerHTML = inspectorSection('Run', [['Run ID', value.id || value.runId], ['智能体', value.agentName || value.agentId || '主智能体'], ['Model', value.model || '—'], ['Status', statusLabel(value.status)], ['Verification', value.verificationStatus || value.verification || '—'], ['Children', value.children ? value.children.size : value.childCount || 0]]);
  else if (type === 'agent') box.innerHTML = inspectorSection('智能体', [['智能体名称', value.name || value.adapterId || value.agentId], ['Type', value.type || '动态子智能体'], ['Model', value.model || '—'], ['Run state', statusLabel(value.status)], ['Result', value.result || '—']]);
  else if (type === 'action') box.innerHTML = inspectorSection('Action', [['Type', value.type], ['Input', truncate(JSON.stringify(value.args || {}), 500)], ['Result', value.result || '—'], ['Duration', value.duration || '—'], ['Related Run', value.runId || '—']]);
  // v2.9.9 Phase B（B39）— Inspector 新增对象：Permission / Workflow / Workflow Step /
  // Generator Draft / Agent Definition / External Agent
  else if (type === 'permission') box.innerHTML = inspectorSection('Permission', [['Scope', value.scope || '—'], ['Risk', value.risk || '—'], ['Target', truncate(JSON.stringify(value.args || {}), 300)], ['Agent', value.agent || '—'], ['Run', value.runId || '—']]);
  else if (type === 'workflow') box.innerHTML = inspectorSection('Workflow Run', [['Run ID', value.workflowRunId || '—'], ['Workflow', value.workflowId || '—'], ['Status', value.status || '—'], ['Current Step', value.currentStepId || '—'], ['Error', value.error || '—']]);
  else if (type === 'workflowStep') box.innerHTML = inspectorSection('Workflow Step', [['Step', value.stepId || '—'], ['Status', value.status || '—'], ['Attempt', value.attempt || 0], ['Input', truncate(JSON.stringify(value.input || value.result || {}), 300)], ['Error', value.error || '—']]);
  else if (type === 'generatorDraft') box.innerHTML = inspectorSection('Generator Draft', [['Draft', value.draftId || '—'], ['Status', value.status || '—'], ['Type', value.artifactType || '—'], ['Model', value.selectedModel ? `${value.selectedModel.connectionId}/${value.selectedModel.modelId}` : 'Auto'], ['Attempts', value.attempts || 0], ['Validation', value.validation ? (value.validation.valid ? 'VALID' : 'INVALID') : '—']]);
  else if (type === 'agentDefinition') box.innerHTML = inspectorSection('Agent Definition', [['ID', value.id || '—'], ['Name', value.name || '—'], ['Role', value.role || '—'], ['Runtime', value.runtime && value.runtime.kind || 'native'], ['Model', value.modelPolicy && value.modelPolicy.mode || 'inherit_parent'], ['Tools', ((value.toolPolicy && value.toolPolicy.allow) || []).join(', ') || '—'], ['Skills', ((value.skills && value.skills.required) || []).join(', ') || '—'], ['Hooks', ((value.hooks && value.hooks.required) || []).join(', ') || '—']]);
  else if (type === 'externalAgent') box.innerHTML = inspectorSection('External Agent', [['Name', value.name || value.id || '—'], ['Transport', value.transport || '—'], ['Availability', value.availability || 'UNKNOWN'], ['Health', value.health || '—'], ['Version', value.version || '—'], ['Verification', value.verification || '—']]);
  else box.innerHTML = '<div class="empty small">Select a run, child agent, file, diff, or action.</div>';
}

function inspectorSection(title, rows) { return `<div class="inspector-section"><h3>${esc(title)}</h3>${rows.map(([key, value]) => `<div class="inspector-row"><span>${esc(key)}</span><strong title="${esc(String(value))}">${esc(String(value))}</strong></div>`).join('')}</div>`; }

async function initLayout() {
  const defaults = { leftWidth: 250, inspectorWidth: 300, bottomHeight: 210, sidebarCollapsed: false, inspectorCollapsed: false, bottomCollapsed: false };
  const saved = await api.settingsGet('ui.layout', defaults).catch(() => defaults);
  applyLayout({ ...defaults, ...(saved || {}) });
  wireResizer('resize-left', event => ({ key: 'leftWidth', value: event.clientX - $('#activity-bar').getBoundingClientRect().right, min: 180, max: 500 }));
  wireResizer('resize-inspector', event => ({ key: 'inspectorWidth', value: window.innerWidth - event.clientX, min: 240, max: 500 }));
  wireResizer('resize-bottom', event => ({ key: 'bottomHeight', value: window.innerHeight - event.clientY, min: 120, max: 500 }));
  $('#inspector-collapse').onclick = () => toggleInspector();
  window.addEventListener('layout-toggle-sidebar', () => toggleSidebar());
  window.addEventListener('layout-toggle-bottom', event => toggleBottom(event.detail && event.detail.tab));
  // B34 — 小桌面（≤ 1366 宽）自动收起 Inspector，中心工作区绝不消失；
  // 用户可手动重开。只自动收起，绝不自动展开（不代替用户决策）。
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const right = $('#right');
      if (window.innerWidth <= 1366 && right && !right.classList.contains('hidden')) {
        layout.inspectorCollapsed = true;
        applyLayout(layout);
        saveLayout();
      }
    }, 200);
  });
}

let layout = {};
function applyLayout(next) {
  layout = next;
  $('#left').style.width = `${Math.max(180, Math.min(500, next.leftWidth))}px`;
  $('#right').style.width = `${Math.max(240, Math.min(500, next.inspectorWidth))}px`;
  $('#bottom').style.height = `${Math.max(120, Math.min(500, next.bottomHeight))}px`;
  $('#left').classList.toggle('hidden', !!next.sidebarCollapsed);
  $('#resize-left').classList.toggle('hidden', !!next.sidebarCollapsed);
  $('#right').classList.toggle('hidden', !!next.inspectorCollapsed);
  $('#resize-inspector').classList.toggle('hidden', !!next.inspectorCollapsed);
  $('#bottom').classList.toggle('hidden', !!next.bottomCollapsed);
  $('#resize-bottom').classList.toggle('hidden', !!next.bottomCollapsed);
}
function saveLayout() { api.settingsSet('ui.layout', layout).catch(() => {}); }
function wireResizer(id, measure) {
  const handle = $(`#${id}`);
  handle.addEventListener('pointerdown', event => {
    const move = moveEvent => { const change = measure(moveEvent); layout[change.key] = Math.max(change.min, Math.min(change.max, change.value)); applyLayout(layout); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveLayout(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  });
}
function toggleSidebar() { layout.sidebarCollapsed = !$('#left').classList.contains('hidden'); applyLayout(layout); saveLayout(); }
function toggleInspector() { layout.inspectorCollapsed = !$('#right').classList.contains('hidden'); applyLayout(layout); saveLayout(); }
function toggleBottom(tab) { layout.bottomCollapsed = !$('#bottom').classList.contains('hidden'); applyLayout(layout); saveLayout(); if (!layout.bottomCollapsed && tab) document.querySelector(`.btab[data-btab="${tab}"]`)?.click(); }

export async function refreshGitStatus() {
  const box = $('#git-status');
  if (!state.project) { box.textContent = 'No Git'; return; }
  try { const git = await api.gitStatus(); box.textContent = git.isGit ? `${git.branch}  ${git.dirty ? '● dirty' : '✓ clean'}` : 'No Git'; box.classList.toggle('dirty', !!git.dirty); }
  catch { box.textContent = 'No Git'; }
}

export function initWorkspace() {
  document.querySelectorAll('.task-tab').forEach(button => button.onclick = () => switchTaskTab(button.dataset.taskTab));
  document.addEventListener('click', event => { if (!event.target.closest('#workbench-context-menu')) closeContextMenu(); });
  unsubscribe = subscribeRunView(({ event }) => {
    const run = getRunView(event.runId || event.parentRunId);
    if (!run || run.depth > 0) return;
    renderRunHeader(run);
    if (timer) clearInterval(timer);
    if (!isTerminalStatus(run.status)) timer = setInterval(() => renderRunHeader(run), 1000);
    else timer = null;
  });
  initLayout();
  renderTabs();
}

export function disposeWorkspace() { if (unsubscribe) unsubscribe(); if (timer) clearInterval(timer); }
