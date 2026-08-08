// Bottom dock: Terminal / Diff / Problems / Tasks / Computer / Logs / Usage
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, renderDiff, fmtTime, truncate, toast, prettyJson } from './util.js';
import { eventName, ZH } from './i18n.js';

let activeConv = null;
const problems = [];

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
  renderComputer();
  renderLogs();
}

function onShow(tab) {
  if (tab === 'tasks') refreshTasks();
  if (tab === 'usage') refreshUsage();
  if (tab === 'diff') renderDiffPane();
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
  const pane = $('#bottom-diff');
  let rows = state.diffs;
  if (!rows.length && state.project) {
    try {
      const list = await api.fileChanges(state.project.id);
      rows = list.map(r => ({ path: r.path, diff: r.diff, at: r.created_at }));
    } catch {}
  }
  if (!rows.length) { pane.innerHTML = `<div class="empty">暂无文件改动</div>`; return; }
  pane.innerHTML = `<div class="diff-list">${rows.slice(0, 50).map((d, i) => `
    <div class="diff-item">
      <div class="di-head" data-i="${i}"><b>${esc(d.path)}</b><span class="muted">${esc(fmtTime(d.at))}</span><span class="di-toggle">▾</span></div>
      <div class="di-body hidden">${renderDiff(d.diff)}</div>
    </div>`).join('')}</div>`;
  pane.querySelectorAll('.di-head').forEach(hd => {
    hd.onclick = () => hd.parentElement.querySelector('.di-body').classList.toggle('hidden');
  });
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
