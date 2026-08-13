// Bottom dock: Terminal / Diff / Problems / Tasks / Timeline / Computer / Logs / Usage
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, renderDiff, fmtTime, truncate, toast, prettyJson } from './util.js';
import { eventName, ZH } from './i18n.js';
import { openFile, selectInspector, appendProgress } from './workspace.js';

let activeConv = null;
const problems = [];
let diffRenderRevision = 0;
let diffSelectionRevision = 0;

// v2.9.9 Phase B（B10/B11/B12/B14）— Activity Bar Notification Badges：
// Permission waiting / Workflow waiting approval / Generator READY / Agent error。
// count <= 0 清除徽标；徽标只是提示，不是执行真话。
const BADGE_TARGETS = Object.freeze({
  permission: '[data-act="runs"]',
  workflow: '[data-page="workflows"]',
  generator: '[data-page="generator"]',
  agent: '[data-page="agents"]'
});
export function setBadge(kind, count) {
  const selector = BADGE_TARGETS[kind];
  if (!selector) return;
  const button = document.querySelector(`#activity-bar ${selector}`);
  if (!button) return;
  const n = Number(count) || 0;
  let badge = button.querySelector('.ab-badge');
  if (n <= 0) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'ab-badge';
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
  }
  badge.textContent = n > 99 ? '99+' : String(n);
}

// v2.6.0 — 运行时间线（紧凑视图，bottom tab + 右侧栏）
const timeline = []; // [{ runId, entry: {kind, icon, text, detail, t} }]

export function setActiveConversation(id) { activeConv = id; }

/* ---------------- init ---------------- */
export function init() {
  $$('.btab').forEach(b => {
    b.onclick = () => {
      $$('.btab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $$('.bottom-pane').forEach(p => p.classList.add('hidden'));
      $('#bottom-' + b.dataset.btab).classList.remove('hidden');
      onShow(b.dataset.btab);
    };
  });
  renderTerminal();
  renderTasks();
  renderDiffPane();
  renderProblems();
  renderTimeline();
  renderComputer();
  renderLogs();
}

function onShow(tab) {
  if (tab === 'tasks') refreshTasks();
  if (tab === 'usage') refreshUsage();
  if (tab === 'diff') renderDiffPane();
  if (tab === 'timeline') renderTimeline();
  if (tab === 'computer') renderComputer();
}

export function activate(tab) {
  const b = $(`.btab[data-btab="${tab}"]`);
  if (b) b.click();
}

/* ---------------- Terminal ---------------- */
let termBuf = [];
function renderTerminal() {
  const pane = $('#bottom-terminal');
  pane.innerHTML = `
    <div class="term-wrap">
      <div class="term-out" id="term-out"><div class="muted">终端输出会在智能体运行命令时实时显示。你也可以在下面直接执行命令（工作目录 = 项目根目录）。</div></div>
      <div class="term-in">
        <span class="prompt">&gt;</span>
        <input id="term-cmd" placeholder="例如：npm test（Enter 执行）" autocomplete="off">
        <button class="btn small" id="term-clear">清空</button>
      </div>
    </div>`;
  $('#term-clear').onclick = () => { termBuf = []; $('#term-out').innerHTML = ''; };
  $('#term-cmd').onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    const cmd = e.target.value.trim();
    if (!cmd) return;
    if (!state.project) { toast('请先打开项目', 'warn'); return; }
    e.target.value = '';
    termWrite(`\n> ${cmd}\n`, 'cmd');
    try {
      const r = await api.termRun(cmd);
      if (r && r.error) termWrite('错误：' + (r.error.message || JSON.stringify(r.error)) + '\n', 'err');
      else termWrite(`\n[exit ${r.exit_code}]\n`, r.exit_code === 0 ? 'ok' : 'err');
    } catch (err) { termWrite('错误：' + err.message + '\n', 'err'); }
  };
}

function termWrite(text, cls = '') {
  const out = $('#term-out');
  if (!out) return;
  const span = document.createElement('span');
  span.className = 'tl ' + cls;
  span.textContent = text;
  out.appendChild(span);
  termBuf.push(text);
  if (termBuf.length > 4000) { termBuf = termBuf.slice(-2000); }
  out.scrollTop = out.scrollHeight;
}

export function onTerminalEvent(ev) {
  if (ev.type === 'terminal_start') { termWrite(`\n> ${ev.command}\n`, 'cmd'); flashTab('terminal'); }
  else if (ev.type === 'terminal_output') termWrite(ev.chunk || '', ev.stream === 'err' ? 'err' : '');
  else if (ev.type === 'terminal_exit') termWrite(`\n[exit ${ev.exitCode}]\n`, ev.exitCode === 0 ? 'ok' : 'err');
}

function flashTab(name) {
  const b = $(`.btab[data-btab="${name}"]`);
  if (b && !b.classList.contains('active')) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 1500); }
}

/* ---------------- Diff ---------------- */
export function addDiff(ev) {
  state.diffs.unshift({ path: ev.path, diff: ev.diff, at: new Date().toISOString() });
  if (state.diffs.length > 100) state.diffs.pop();
  renderDiffPane();
  flashTab('diff');
}

export async function renderDiffPane() {
  const renderRevision = ++diffRenderRevision;
  diffSelectionRevision++;
  const pane = $('#bottom-diff');
  pane.innerHTML = '<div class="empty">Loading working tree changes…</div>';
  let truth = { label: 'Working Tree Changes', files: [] };
  if (state.project) {
    try { truth = await api.gitChangedFiles(); } catch { /* non-git fallback below */ }
  }
  if (renderRevision !== diffRenderRevision) return;
  if (!truth.files.length && state.diffs.length) {
    truth.files = state.diffs.map(item => ({ path: item.path, status: 'M', added: 0, deleted: 0, diff: item.diff }));
  }
  if (!truth.files.length) { pane.innerHTML = '<div class="empty">暂无文件改动</div>'; return; }
  const rows = truth.files.slice(0, 200);
  pane.innerHTML = `<div class="diff-workbench"><aside class="changed-files"><div class="changed-title">${esc(truth.label || 'Working Tree Changes')}</div>${rows.map((file, index) => `<button class="changed-file ${index === 0 ? 'active' : ''}" data-diff-file="${esc(file.path)}"><span class="change-status status-${esc(file.status)}">${esc(file.status)}</span><span class="change-path" title="${esc(file.path)}">${esc(file.path)}</span><span class="change-stat"><i>+${Number(file.added || 0)}</i> <b>-${Number(file.deleted || 0)}</b></span></button>`).join('')}</aside><section class="diff-viewer"><div id="diff-viewer-body" class="empty">Select a changed file</div></section></div>`;
  const open = async path => {
    const selectionRevision = ++diffSelectionRevision;
    pane.querySelectorAll('.changed-file').forEach(button => button.classList.toggle('active', button.dataset.diffFile === path));
    const fallback = rows.find(file => file.path === path);
    let data = fallback;
    try { data = await api.gitDiff(path); } catch {}
    if (selectionRevision !== diffSelectionRevision || renderRevision !== diffRenderRevision) return;
    renderDiffFile(data || { path, diff: '' }, rows);
    selectInspector('file', { path, size: 0, language: 'Diff', gitStatus: fallback && fallback.status });
  };
  pane.querySelectorAll('[data-diff-file]').forEach(button => button.onclick = () => open(button.dataset.diffFile));
  await open(rows[0].path);
}

function renderDiffFile(file, rows) {
  const body = $('#diff-viewer-body');
  const index = rows.findIndex(row => row.path === file.path);
  body.className = 'diff-viewer-body';
  // v2.9.9 Phase B PART A（A4）— Rename truth：后端报告的 rename 必须在头部呈现 old → new，
  // 即使内容未变化也展示改名事实。
  const renameHeader = file.oldPath && file.oldPath !== file.path
    ? `<div class="diff-rename-head"><span class="chip">R</span><span class="mono">${esc(file.oldPath)}</span><span class="muted">→</span><span class="mono">${esc(file.path)}</span></div>`
    : '';
  body.innerHTML = `${renameHeader}<div class="diff-view-head"><strong class="mono">${esc(file.path)}</strong><span class="grow"></span><button class="btn tiny" data-prev-change>Previous Change</button><button class="btn tiny" data-next-change>Next Change</button><button class="btn tiny" data-open-source>Open File</button><button class="btn tiny" data-copy-path>Copy File Path</button><button class="btn tiny" data-copy-diff>Copy Diff</button></div>${renderUnifiedDiffBounded(file.diff, 5000)}`;
  body.querySelector('[data-prev-change]').onclick = () => rows[(index - 1 + rows.length) % rows.length] && $(`[data-diff-file="${cssEscape(rows[(index - 1 + rows.length) % rows.length].path)}"]`)?.click();
  body.querySelector('[data-next-change]').onclick = () => rows[(index + 1) % rows.length] && $(`[data-diff-file="${cssEscape(rows[(index + 1) % rows.length].path)}"]`)?.click();
  body.querySelector('[data-open-source]').onclick = () => openFile(file.path);
  body.querySelector('[data-copy-path]').onclick = () => navigator.clipboard.writeText(file.path).then(() => toast('Path copied', 'ok'));
  body.querySelector('[data-copy-diff]').onclick = () => navigator.clipboard.writeText(file.diff || '').then(() => toast('Diff copied', 'ok'));
}

function cssEscape(value) { return String(value).replace(/(["\\])/g, '\\$1'); }

function renderUnifiedDiffBounded(diffText, maxLines) {
  const all = String(diffText || '').split(/\r?\n/);
  const lines = all.slice(0, maxLines);
  let oldLine = 0; let newLine = 0;
  const html = lines.map(line => {
    let cls = 'ctx'; let oldText = ''; let newText = '';
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); cls = 'hunk'; }
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta';
    else if (line.startsWith('+')) { cls = 'add'; newText = String(newLine++); }
    else if (line.startsWith('-')) { cls = 'del'; oldText = String(oldLine++); }
    else { oldText = String(oldLine++ || ''); newText = String(newLine++ || ''); }
    return `<div class="diff-line ${cls}"><span class="diff-ln">${oldText}</span><span class="diff-ln">${newText}</span><code>${esc(line) || '&nbsp;'}</code></div>`;
  }).join('');
  const note = all.length > maxLines ? `<div class="diff-truncated">Diff truncated in UI (${maxLines}/${all.length} lines)</div>` : '';
  return `<div class="unified-diff">${html}</div>${note}`;
}

/* ---------------- Problems ---------------- */
export function addProblem(msg) {
  problems.unshift({ msg, at: new Date().toISOString() });
  renderProblems();
  flashTab('problems');
}
export function onToolResult(ev) {
  try {
    const o = JSON.parse(ev.result);
    if (o && o.ok === false && o.error) addProblem(`${ev.name}: ${o.error.code || ''} ${o.error.message || ''}`);
  } catch {}
}
function renderProblems() {
  const pane = $('#bottom-problems');
  if (!problems.length) { pane.innerHTML = `<div class="empty">没有问题</div>`; return; }
  pane.innerHTML = problems.slice(0, 100).map(p =>
    `<div class="prob"><span class="pdot"></span><span>${esc(p.msg)}</span><span class="muted">${esc(fmtTime(p.at))}</span></div>`).join('');
}

/* ---------------- Tasks ---------------- */
export function addTask(t) {
  state.tasks.unshift(t);
  renderTasks();
  renderRightTasks();
}
export function updateTask(id, status) {
  const t = state.tasks.find(x => x.id === id);
  if (t) t.status = status;
  renderTasks();
  renderRightTasks();
}
export async function refreshTasks() {
  if (!state.project) return renderTasks();
  try {
    const list = await api.tasks(state.project.id);
    state.tasks = list.map(t => ({ id: t.id, title: t.title, status: t.status, at: t.created_at, error: t.error }));
  } catch {}
  renderTasks();
  renderRightTasks();
}
function statusChip(s) {
  const map = { running: ['运行中', 'run'], completed: ['已完成', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', 'warn'], max_steps: ['达上限', 'warn'], queued: ['排队中', ''], stopped: ['已中止', 'warn'] };
  const [txt, cls] = map[s] || [s, ''];
  return `<span class="chip ${cls}">${esc(txt)}</span>`;
}
function renderTasks() {
  const pane = $('#bottom-tasks');
  if (!state.tasks.length) { pane.innerHTML = `<div class="empty">暂无任务</div>`; return; }
  pane.innerHTML = `<table class="tbl"><thead><tr><th>任务</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>${
    state.tasks.slice(0, 60).map(t => `<tr><td>${esc(truncate(t.title || '', 90))}</td><td>${statusChip(t.status)}</td><td class="muted">${esc(fmtTime(t.at))}</td><td><button class="btn tiny" data-steps="${t.id}">步骤</button></td></tr>`).join('')
    }</tbody></table>`;
  pane.querySelectorAll('[data-steps]').forEach(b => {
    b.onclick = async () => {
      const steps = await api.taskSteps(b.dataset.steps);
      const html = steps.length ? `<ol class="steps">${steps.map(s => `<li>${esc(s.label)} <span class="muted">${esc(s.status)}</span></li>`).join('')}</ol>` : '<div class="muted">无步骤记录</div>';
      const { openModal } = await import('./util.js');
      openModal('任务步骤', html, { noFooter: true });
    };
  });
}
export function renderRightTasks() {
  const box = $('#tasks-list');
  if (!box) return;
  const list = state.tasks.slice(0, 8);
  if (!list.length) { box.innerHTML = `<div class="empty small">暂无任务</div>`; return; }
  box.innerHTML = list.map(t => `<div class="rt"><div class="rt-title">${esc(truncate(t.title || '', 40))}</div>${statusChip(t.status)}</div>`).join('');
}

/* ---------------- Timeline (v2.6.0 Main Agent) ---------------- */
const TL_KIND_LABEL = {
  analyze: '分析', read: '读取', plan: '规划', edit: '修改', run: '运行',
  'test-fail': '测试失败', repair: '修复', 'test-pass': '测试通过',
  complete: '完成', error: '错误', info: '信息'
};
const TL_KIND_CLASS = {
  analyze: 'tl-info', read: 'tl-info', plan: 'tl-info', edit: 'tl-edit', run: 'tl-run',
  'test-fail': 'tl-fail', repair: 'tl-repair', 'test-pass': 'tl-ok',
  complete: 'tl-ok', error: 'tl-fail', info: 'tl-info'
};

export function addTimelineEntry(runId, entry) {
  if (!entry) return;
  timeline.unshift({ runId, entry });
  if (timeline.length > 200) timeline.length = 200;
  renderTimeline();
  renderRightTimeline();
  flashTab('timeline');
  const row = h('div', { class: `task-timeline-entry ${TL_KIND_CLASS[entry.kind] || 'tl-info'}`, dataset: { runId: runId || '' } });
  row.innerHTML = `<span>${esc(entry.icon || '•')}</span><strong>${esc(TL_KIND_LABEL[entry.kind] || entry.kind || '信息')}</strong><span>${esc(truncate(entry.text || '', 160))}</span>`;
  appendProgress(row);
}

export function clearTimeline() {
  timeline.length = 0;
  renderTimeline();
  renderRightTimeline();
}

function renderTimeline() {
  const pane = $('#bottom-timeline');
  if (!pane) return;
  if (!timeline.length) {
    pane.innerHTML = `<div class="empty">暂无时间线（运行主智能体时会实时显示每一步）</div>`;
    return;
  }
  pane.innerHTML = `<div class="tl-list">${timeline.slice(0, 100).map(item => {
    const e = item.entry || {};
    const kind = e.kind || 'info';
    const label = TL_KIND_LABEL[kind] || kind;
    const cls = TL_KIND_CLASS[kind] || 'tl-info';
    const t = e.t ? new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const detail = e.detail ? `<div class="tl-detail">${esc(truncate(e.detail, 200))}</div>` : '';
    return `<div class="tl-row ${cls}">
      <span class="tl-icon">${esc(e.icon || '•')}</span>
      <span class="tl-time">${esc(t)}</span>
      <span class="tl-label">${esc(label)}</span>
      <span class="tl-text">${esc(truncate(e.text || '', 120))}</span>
      ${detail}
    </div>`;
  }).join('')}</div>`;
}

function renderRightTimeline() {
  const box = $('#timeline-list');
  if (!box) return;
  const list = timeline.slice(0, 10);
  if (!list.length) { box.innerHTML = `<div class="empty small">暂无时间线</div>`; return; }
  box.innerHTML = list.map(item => {
    const e = item.entry || {};
    const kind = e.kind || 'info';
    const cls = TL_KIND_CLASS[kind] || 'tl-info';
    return `<div class="rtl ${cls}"><span class="rtl-ico">${esc(e.icon || '•')}</span><span class="rtl-text">${esc(truncate(e.text || '', 36))}</span></div>`;
  }).join('');
}

/* ---------------- Computer ---------------- */
async function renderComputer() {
  const pane = $('#bottom-computer');
  pane.innerHTML = `<div class="cp">
      <div class="cp-bar">
        <button class="btn small" id="cp-win">列出窗口</button>
        <button class="btn small" id="cp-shot">截屏</button>
        <span class="muted" id="cp-browser"></span>
      </div>
      <div class="cp-out" id="cp-out"><div class="muted">用于查看主智能体的「电脑操作」能力：窗口列表、屏幕截图。智能体执行 computer_* 工具时需要你授权。</div></div>
    </div>`;
  $('#cp-win').onclick = async () => {
    $('#cp-out').innerHTML = '<div class="muted">读取中…</div>';
    try {
      const r = await api.computerWindows();
      const arr = Array.isArray(r) ? r : (r && r.windows) || (r && r.data) || [];
      const list = Array.isArray(arr) ? arr : [arr];
      $('#cp-out').innerHTML = `<table class="tbl"><thead><tr><th>窗口标题</th><th>PID</th><th></th></tr></thead><tbody>${
        list.map(w => `<tr><td>${esc(w.Title || w.title || '')}</td><td>${esc(w.Id || w.pid || '')}</td><td><button class="btn tiny" data-focus="${esc(w.Title || w.title || '')}">聚焦</button></td></tr>`).join('')
        }</tbody></table>`;
      $('#cp-out').querySelectorAll('[data-focus]').forEach(b => b.onclick = () => api.computerFocus(b.dataset.focus).then(() => toast('已聚焦')).catch(e => toast(e.message, 'error')));
    } catch (e) { $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $('#cp-shot').onclick = async () => {
    $('#cp-out').innerHTML = '<div class="muted">截屏中…</div>';
    try {
      const r = await api.computerShot();
      const url = r.data_url || (r.data && r.data.data_url);
      $('#cp-out').innerHTML = url ? `<img class="shot" src="${url}">` : `<pre>${esc(prettyJson(r))}</pre>`;
    } catch (e) { $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  try {
    const b = await api.browserStatus();
    $('#cp-browser').textContent = `浏览器：${b.installed ? 'Playwright 已安装' : '未安装 playwright'}${b.launched ? '（已启动）' : ''}`;
  } catch {}
}

/* ---------------- Logs ---------------- */
export function pushLog(ev) {
  state.logs.unshift({ t: new Date().toISOString(), type: ev.type, payload: ev });
  if (state.logs.length > 500) state.logs.pop();
  const pane = $('#bottom-logs');
  if (pane && !pane.classList.contains('hidden')) renderLogs();
}
function renderLogs() {
  const pane = $('#bottom-logs');
  if (!pane) return;
  if (!state.logs.length) { pane.innerHTML = `<div class="empty">暂无事件</div>`; return; }
  pane.innerHTML = `<div class="logs">${state.logs.slice(0, 200).map(l =>
    `<div class="log"><span class="lt">${esc(l.t.slice(11, 19))}</span><span class="lty">${esc(eventName(l.type))}</span><span class="lp">${esc(truncate(JSON.stringify(l.payload), 200))}</span></div>`).join('')}</div>`;
}

/* ---------------- Usage ---------------- */
async function refreshUsage() {
  const pane = $('#bottom-usage');
  try {
    const [list, sum] = await Promise.all([api.usage(), api.usageSummary()]);
    pane.innerHTML = `<div class="usage-sum">累计 tokens：<b>${sum.total || 0}</b>　记录数：<b>${list.length}</b></div>
      <table class="tbl"><thead><tr><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>合计</th><th>延迟</th></tr></thead><tbody>${
      list.slice(0, 100).map(u => `<tr><td class="muted">${esc(fmtTime(u.created_at))}</td><td>${esc(u.model)}</td><td>${u.input_tokens}</td><td>${u.output_tokens}</td><td>${u.total_tokens}</td><td>${u.latency_ms}ms</td></tr>`).join('')
      }</tbody></table>`;
  } catch (e) { pane.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
