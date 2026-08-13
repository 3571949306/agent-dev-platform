// Bottom dock: Terminal / Diff / Problems / Tasks / Timeline / Computer / Logs / Usage
import { api } from './api.js';
import { state } from './state.js';
import { $, $$, esc, h, renderDiff, fmtTime, truncate, toast, prettyJson } from './util.js';
import { eventName, ZH } from './i18n.js';
import { openFile, openRun, selectInspector, appendProgress } from './workspace.js';

let activeConv = null;
let diffRenderRevision = 0;
let diffSelectionRevision = 0;

// v2.9.9 Phase B（B10/B11/B12/B14）— Activity Bar Notification Badges：
// Permission waiting / Workflow waiting approval / Generator READY / Agent error。
// count <= 0 清除徽标；徽标只是提示，不是执行真话。
const BADGE_TARGETS = Object.freeze({
  permission: '[data-act="runs"]',
  workflow: '[data-page="workflows"]',
  generator: '[data-page="generator"]',
  agent: '[data-page="agents"]',
  // B47 — 未解决问题徽标指向诊断页（Problems 真源在 backend，诊断页可查）
  problems: '[data-page="diagnostics"]'
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
      // B48 — last bottom tab 持久化（只存页签名，绝不存密钥类数据）
      api.settingsSet('ui.lastBottomTab', b.dataset.btab).catch(() => {});
    };
  });
  renderTerminal();
  renderTasks();
  renderDiffPane();
  refreshProblems();
  renderTimeline();
  renderComputer();
  renderLogs();
  // B48 — 恢复上次底部页签
  api.settingsGet('ui.lastBottomTab', null).then(tab => {
    if (tab) {
      const b = document.querySelector(`.btab[data-btab="${tab}"]`);
      if (b) b.click();
    }
  }).catch(() => {});
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

/* ---------------- Terminal（B19 Terminal Workspace 2.0） ----------------
 * 活动命令 / 历史 / 完整输出真话；Cancel 真实终止进程树；
 * 危险命令即使用户亲自输入也必须走既有确认规则（B19.6）；
 * 展示有界（≤ 200KB），完整数据仍可 backend 查询/审计。 */
let termBuf = [];
let termDomBytes = 0;
const TERM_DOM_LIMIT = 200 * 1024; // B19.4 — bounded DOM
const TERM_OWNER_LABEL = { USER: '用户', MAIN_AGENT: '主智能体', CHILD_AGENT: '子智能体', WORKFLOW: 'Workflow', UNKNOWN: '未知' };

async function refreshTermActive() {
  const box = $('#term-active');
  if (!box) return;
  try {
    const list = await api.termActive();
    if (!list.length) { box.innerHTML = '<div class="muted small">当前没有活动命令</div>'; return; }
    box.innerHTML = `<table class="tbl"><thead><tr><th>命令</th><th>CWD</th><th>Owner</th><th>耗时</th><th>状态</th><th></th></tr></thead><tbody>${
      list.map(a => `<tr>
        <td class="mono small">${esc(truncate(a.command || '', 80))}</td>
        <td class="mono small">${esc(a.cwd || '')}</td>
        <td><span class="chip small">${esc(TERM_OWNER_LABEL[a.owner] || a.owner)}</span></td>
        <td class="small">${Math.round((a.durationMs || 0) / 1000)}s</td>
        <td><span class="chip small">${esc(a.status)}</span></td>
        <td><button class="btn tiny danger" data-term-cancel="${esc(a.id)}">Cancel</button></td>
      </tr>`).join('')
    }</tbody></table>`;
    box.querySelectorAll('[data-term-cancel]').forEach(b => b.onclick = async () => {
      try { await api.termCancel(b.dataset.termCancel); toast('已请求终止（进程树 kill）', 'ok'); setTimeout(refreshTermActive, 500); }
      catch (e) { toast(e.message, 'error'); }
    });
  } catch { box.innerHTML = '<div class="muted small">活动命令不可用</div>'; }
}

async function showTermHistoryInto(box) {
  if (!box) return;
  try {
    const list = await api.termHistory(50);
    if (!list.length) { box.innerHTML = '<div class="muted small">还没有终端执行历史</div>'; return; }
    box.innerHTML = `<div class="muted small">最近 ${list.length} 条（有界）；完整输出点「输出」从 backend 查询。</div>` +
      `<table class="tbl"><thead><tr><th>时间</th><th>命令</th><th>Owner</th><th>exit</th><th>耗时</th><th>状态</th><th></th></tr></thead><tbody>${
      list.map(h => `<tr>
        <td class="small muted">${esc(fmtTime(h.startedAt))}</td>
        <td class="mono small">${esc(truncate(h.command || '', 60))}</td>
        <td><span class="chip small">${esc(TERM_OWNER_LABEL[h.owner] || h.owner)}</span></td>
        <td class="mono">${h.exitCode === null || h.exitCode === undefined ? '—' : esc(String(h.exitCode))}</td>
        <td class="small">${Math.round((h.durationMs || 0) / 1000)}s</td>
        <td><span class="chip small ${h.status === 'exited' && h.exitCode === 0 ? 'ok' : (h.cancelled ? 'warn' : '')}">${esc(h.cancelled ? 'cancelled' : (h.timeout ? 'timeout' : h.status))}</span></td>
        <td><button class="btn tiny" data-term-output="${esc(h.id)}">输出</button></td>
      </tr>`).join('')
    }</tbody></table>`;
    box.querySelectorAll('[data-term-output]').forEach(b => b.onclick = async () => {
      try {
        const o = await api.termOutput(b.dataset.termOutput);
        if (!o) { toast('记录不存在', 'error'); return; }
        const cap = (s) => { const t = String(s || ''); return t.length > TERM_DOM_LIMIT ? t.slice(0, TERM_DOM_LIMIT) + '\n…（展示已截断，backend 保留完整输出）' : t; };
        box.innerHTML = `<div class="muted small">命令：${esc(o.command)} · exit ${o.exitCode ?? '—'} · ${o.timeout ? 'timeout' : ''} ${o.cancelled ? 'cancelled' : ''} · ${Math.round((o.durationMs || 0) / 1000)}s</div>
          <pre class="term-pre">${esc(cap(o.stdout))}</pre>
          ${o.stderr ? `<pre class="term-pre term-err">${esc(cap(o.stderr))}</pre>` : ''}
          <button class="btn tiny" id="term-back">返回历史</button>`;
        $('#term-back').onclick = () => showTermHistoryInto(box);
      } catch (e) { toast(e.message, 'error'); }
    });
  } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function renderTerminal() {
  const pane = $('#bottom-terminal');
  pane.innerHTML = `
    <div class="term-wrap">
      <div class="term-tools">
        <button class="btn tiny" id="term-tab-out">输出</button>
        <button class="btn tiny" id="term-tab-active">活动命令</button>
        <button class="btn tiny" id="term-tab-history">历史</button>
        <span class="muted small">危险命令（删除/强推/格式化等）即使用户亲自输入也必须确认后执行。</span>
      </div>
      <div class="term-out" id="term-out"><div class="muted">终端输出会在智能体运行命令时实时显示。你也可以在下面直接执行命令（工作目录 = 项目根目录）。</div></div>
      <div id="term-active" class="hidden"></div>
      <div class="term-in">
        <span class="prompt">&gt;</span>
        <input id="term-cmd" placeholder="例如：npm test（Enter 执行）" autocomplete="off">
        <button class="btn small" id="term-clear">清空</button>
      </div>
    </div>`;
  $('#term-clear').onclick = () => { termBuf = []; termDomBytes = 0; $('#term-out').innerHTML = ''; };
  const showSection = (which) => {
    $('#term-out').classList.toggle('hidden', which !== 'out');
    $('#term-active').classList.toggle('hidden', which === 'out');
    if (which === 'active') refreshTermActive();
    if (which === 'history') showTermHistoryInto($('#term-active'));
  };
  $('#term-tab-out').onclick = () => showSection('out');
  $('#term-tab-active').onclick = () => showSection('active');
  $('#term-tab-history').onclick = () => showSection('history');
  $('#term-cmd').onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    const cmd = e.target.value.trim();
    if (!cmd) return;
    if (!state.project) { toast('请先打开项目', 'warn'); return; }
    e.target.value = '';
    // B19.6 — 危险命令即使用户亲自输入也必须先确认（backend 双重把关）
    try {
      const risk = await api.termRiskCheck(cmd);
      if (risk && risk.highRisk) {
        const confirmed = await confirmBox('危险命令确认',
          `目标：${cmd}\n\n后果：该命令被平台识别为高风险（删除/强推/格式化/系统级变更等）。\n可逆性：多数不可逆。确定执行？`);
        if (!confirmed) { termWrite('\n[已取消危险命令]\n', 'err'); return; }
        termWrite(`\n> ${cmd}\n`, 'cmd');
        const r = await api.termRun(cmd, { confirmDangerous: true });
        if (r && r.error) termWrite('错误：' + (r.error.message || JSON.stringify(r.error)) + '\n', 'err');
        else termWrite(`\n[exit ${r.exit_code}]\n`, r.exit_code === 0 ? 'ok' : 'err');
        return;
      }
    } catch { /* riskCheck 不可用时 backend 仍会把关 */ }
    termWrite(`\n> ${cmd}\n`, 'cmd');
    try {
      const r = await api.termRun(cmd);
      if (r && r.needsConfirmation) { termWrite('[backend 要求危险命令确认，已拒绝执行]\n', 'err'); }
      else if (r && r.error) termWrite('错误：' + (r.error.message || JSON.stringify(r.error)) + '\n', 'err');
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
  termDomBytes += text.length;
  // B19.4 — DOM 有界：超过 200KB 从头部丢弃（backend 仍保留完整输出）
  while (termDomBytes > TERM_DOM_LIMIT && out.firstChild) {
    termDomBytes -= (out.firstChild.textContent || '').length;
    out.firstChild.remove();
    termBuf.shift();
  }
  out.scrollTop = out.scrollHeight;
}

export function onTerminalEvent(ev) {
  if (ev.type === 'terminal_start') { termWrite(`\n> ${ev.command}${ev.owner ? ' [' + (TERM_OWNER_LABEL[ev.owner] || ev.owner) + ']' : ''}\n`, 'cmd'); flashTab('terminal'); refreshTermActive(); }
  else if (ev.type === 'terminal_output') termWrite(ev.chunk || '', ev.stream === 'err' ? 'err' : '');
  else if (ev.type === 'terminal_exit') { termWrite(`\n[exit ${ev.exitCode}]\n`, ev.exitCode === 0 ? 'ok' : 'err'); refreshTermActive(); }
}

/* B35 — 性能基线专用：批量终端更新的真实渲染路径（bounded DOM 生效验证）。 */
export function benchTerminalUpdates(n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) termWrite(`bench terminal line ${i}\n`);
  return performance.now() - t0;
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
  pane.innerHTML = '<div class="empty" data-page-state="empty">Loading working tree changes…</div>';
  let truth = { label: 'Working Tree Changes', files: [] };
  if (state.project) {
    try { truth = await api.gitChangedFiles(); } catch { /* non-git fallback below */ }
  }
  if (renderRevision !== diffRenderRevision) return;
  if (!truth.files.length && state.diffs.length) {
    truth.files = state.diffs.map(item => ({ path: item.path, status: 'M', added: 0, deleted: 0, diff: item.diff }));
  }
  if (!truth.files.length) { pane.innerHTML = '<div class="empty" data-page-state="empty">暂无文件改动</div>'; return; }
  const rows = truth.files.slice(0, 200);
  pane.innerHTML = `<div class="diff-workbench"><aside class="changed-files"><div class="changed-title">${esc(truth.label || 'Working Tree Changes')}</div>${rows.map((file, index) => `<button class="changed-file ${index === 0 ? 'active' : ''}" data-diff-file="${esc(file.path)}"><span class="change-status status-${esc(file.status)}">${esc(file.status)}</span><span class="change-path" title="${esc(file.path)}">${esc(file.path)}</span><span class="change-stat"><i>+${Number(file.added || 0)}</i> <b>-${Number(file.deleted || 0)}</b></span></button>`).join('')}</aside><section class="diff-viewer"><div id="diff-viewer-body" class="empty" data-page-state="empty">Select a changed file</div></section></div>`;
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

/* ---------------- Problems（B21 后端真源） ----------------
 * 问题持久化在 backend Problems Center：去重（同一稳定问题只累计计数），
 * dismiss != resolved（只有真实条件消失才标 RESOLVED）。 */
let problemsCache = [];
const PROBLEM_SEVERITY_CLASS = { INFO: '', WARNING: 'warn', ERROR: 'bad', CRITICAL: 'bad' };

export async function refreshProblems() {
  try { problemsCache = await api.problemsList({ limit: 200 }); }
  catch { problemsCache = []; }
  renderProblems();
  const active = problemsCache.filter(p => p.status === 'ACTIVE').length;
  setBottomBadge('problems', active);
}

/** Renderer 侧观测到的错误统一上报后端 Problems（去重 + 持久化，绝不停留在 toast）。 */
export function addProblem(msg, opts = {}) {
  api.problemsReport({
    code: opts.code || 'UI_EVENT',
    message: String(msg || ''),
    severity: opts.severity || 'ERROR',
    relatedKey: opts.relatedKey || null
  }).then(() => refreshProblems()).catch(() => { /* backend 不可用时不阻塞 UI */ });
}

/** backend problem 事件 → 刷新面板（problem:new / problem:updated） */
export function handleProblemEvent(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'problem:new' || ev.type === 'problem:updated') { refreshProblems(); flashTab('problems'); }
}

function setBottomBadge(tab, count) {
  const button = document.querySelector(`.btab[data-btab="${tab}"]`);
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

export function onToolResult(ev) {
  try {
    const o = JSON.parse(ev.result);
    if (o && o.ok === false && o.error) addProblem(`${ev.name}: ${o.error.code || ''} ${o.error.message || ''}`, { code: 'TOOL_ERROR', relatedKey: ev.name });
  } catch {}
}

function renderProblems() {
  const pane = $('#bottom-problems');
  if (!pane) return;
  const open = problemsCache;
  if (!open.length) { pane.innerHTML = `<div class="empty" data-page-state="empty">没有问题</div>`; return; }
  pane.innerHTML = open.slice(0, 100).map(p => `
    <div class="prob prob-${String(p.status || '').toLowerCase()}">
      <span class="chip ${PROBLEM_SEVERITY_CLASS[p.severity] || ''} small">${esc(p.severity)}</span>
      <span class="chip small">${esc(p.source)}</span>
      <span class="mono small">${esc(p.code)}</span>
      <span class="prob-msg">${esc(p.message)}</span>
      ${p.occur_count > 1 ? `<span class="chip small" title="同一稳定问题去重后的发生次数">×${p.occur_count}</span>` : ''}
      ${p.status === 'DISMISSED' ? '<span class="chip small" title="dismiss != resolved：仅隐藏，未解决">已隐藏</span>' : ''}
      <span class="muted small">${esc(fmtTime(p.last_seen_at || p.time))}</span>
      ${p.run_id ? `<button class="btn tiny" data-prob-run="${esc(p.run_id)}">查看 Run</button>` : ''}
      ${p.status === 'ACTIVE' ? `<button class="btn tiny" data-prob-dismiss="${esc(p.id)}">隐藏</button>` : ''}
      <button class="btn tiny" data-prob-resolve="${esc(p.id)}" title="只有真实条件消失才标记已解决">标记解决</button>
    </div>`).join('');
  pane.querySelectorAll('[data-prob-dismiss]').forEach(b => b.onclick = async () => {
    try { await api.problemsDismiss(b.dataset.probDismiss); await refreshProblems(); }
    catch (e) { toast(e.message, 'error'); }
  });
  pane.querySelectorAll('[data-prob-resolve]').forEach(b => b.onclick = async () => {
    try { await api.problemsResolve(b.dataset.probResolve); await refreshProblems(); toast('已标记为解决', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  pane.querySelectorAll('[data-prob-run]').forEach(b => b.onclick = () => openRun(b.dataset.probRun));
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
  if (!state.tasks.length) { pane.innerHTML = `<div class="empty" data-page-state="empty">暂无任务</div>`; return; }
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
  if (!list.length) { box.innerHTML = `<div class="empty small" data-page-state="empty">暂无任务</div>`; return; }
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
    pane.innerHTML = `<div class="empty" data-page-state="empty">暂无时间线（运行主智能体时会实时显示每一步）</div>`;
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
  if (!list.length) { box.innerHTML = `<div class="empty small" data-page-state="empty">暂无时间线</div>`; return; }
  box.innerHTML = list.map(item => {
    const e = item.entry || {};
    const kind = e.kind || 'info';
    const cls = TL_KIND_CLASS[kind] || 'tl-info';
    return `<div class="rtl ${cls}"><span class="rtl-ico">${esc(e.icon || '•')}</span><span class="rtl-text">${esc(truncate(e.text || '', 36))}</span></div>`;
  }).join('');
}

/* ---------------- Computer（B18 Computer Workspace 2.0） ----------------
 * 可用性只来自真实探测；页面存在 != Main 拥有 Computer 能力（普通编码
 * 任务的 computer/browser exposure 仍为 OFF，仅委派 Computer Specialist 时开启）。 */
const COMPUTER_STATUS_LABEL = {
  AVAILABLE: '可用', UNAVAILABLE: '不可用', UNSUPPORTED: '不支持', UNKNOWN: '未知', ERROR: '异常'
};
let computerAvailability = null;

async function renderComputer() {
  const pane = $('#bottom-computer');
  pane.innerHTML = `<div class="cp">
      <div class="cp-bar">
        <span class="chip" id="cp-status">检测中…</span>
        <button class="btn small" id="cp-win">列出窗口</button>
        <button class="btn small" id="cp-shot">刷新截图</button>
        <button class="btn small" id="cp-history">动作历史</button>
        <button class="btn small danger" id="cp-stop" disabled>Stop</button>
        <span class="muted" id="cp-browser"></span>
      </div>
      <div class="cp-out" id="cp-out"><div class="muted">用于查看「电脑操作」能力：窗口列表、截图、动作历史。本页面的存在不代表主智能体拥有 Computer 能力：普通编码任务的 Computer/Browser exposure 为 OFF，只有委派 Computer Specialist 时才按 Definition/Permission 策略提供。</div></div>
    </div>`;

  const refreshActive = async () => {
    try {
      const a = await api.computerActive();
      const btn = $('#cp-stop'); if (btn) btn.disabled = !(a && a.active > 0);
      if (btn) btn.title = a && a.active > 0 ? `当前有 ${a.active} 个活动 computer 操作，Stop 将真实终止` : '当前没有活动 computer 操作';
    } catch { /* backend 不可用时按钮保持禁用 */ }
  };

  // B18.1 — 真实探测可用性（未知就是未知）
  try {
    computerAvailability = await api.computerAvailability();
    const st = (computerAvailability && computerAvailability.status) || 'UNKNOWN';
    const chip = $('#cp-status');
    if (chip) {
      chip.textContent = `Computer：${COMPUTER_STATUS_LABEL[st] || st}`;
      chip.className = `chip ${st === 'AVAILABLE' ? 'ok' : (st === 'UNKNOWN' ? '' : 'bad')}`;
      chip.title = computerAvailability.reason || '';
    }
    if (st !== 'AVAILABLE') {
      $('#cp-out').innerHTML = `<div class="err">Computer 能力当前不可用（${COMPUTER_STATUS_LABEL[st] || st}）：${esc(computerAvailability.reason || '未知原因')}</div>`;
    }
  } catch (e) {
    const chip = $('#cp-status');
    if (chip) { chip.textContent = 'Computer：异常'; chip.className = 'chip bad'; }
    $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    // B43 — Computer 错误不只 toast：进 Problems 持久真源
    addProblem(`Computer 能力异常：${e.message}`, { code: 'COMPUTER_PANEL_ERROR', relatedKey: 'computer-panel' });
  }

  $('#cp-win').onclick = async () => {
    $('#cp-out').innerHTML = '<div class="muted">读取中…</div>';
    try {
      const r = await api.computerWindows();
      const arr = Array.isArray(r) ? r : (r && r.windows) || (r && r.data) || [];
      const list = Array.isArray(arr) ? arr : [arr];
      $('#cp-out').innerHTML = `<table class="tbl"><thead><tr><th>窗口标题</th><th>进程</th><th>PID</th><th>前台</th><th></th></tr></thead><tbody>${
        list.map(w => `<tr><td>${esc(w.Title || w.title || '')}</td><td class="mono small">${esc(w.Process || w.process || '')}</td><td>${esc(w.Id || w.pid || '')}</td><td>${(w.Focused || w.focused) ? '<span class="chip ok small">focused</span>' : ''}</td><td><button class="btn tiny" data-focus="${esc(w.Title || w.title || '')}">聚焦</button></td></tr>`).join('')
        }</tbody></table>`;
      $('#cp-out').querySelectorAll('[data-focus]').forEach(b => b.onclick = () => api.computerFocus(b.dataset.focus).then(() => { toast('已聚焦'); refreshActive(); }).catch(e => toast(e.message, 'error')));
      refreshActive();
    } catch (e) { $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $('#cp-shot').onclick = async () => {
    $('#cp-out').innerHTML = '<div class="muted">截屏中…</div>';
    try {
      const r = await api.computerShot();
      const url = r.data_url || (r.data && r.data.data_url);
      $('#cp-out').innerHTML = url ? `<img class="shot" src="${url}">` : `<pre>${esc(prettyJson(r))}</pre>`;
      refreshActive();
    } catch (e) { $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  // B18.4 — 动作历史（Focus/Click/Input/Key/Screenshot…）
  $('#cp-history').onclick = async () => {
    $('#cp-out').innerHTML = '<div class="muted">读取中…</div>';
    try {
      const list = await api.computerHistory(100);
      $('#cp-out').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>时间</th><th>动作</th><th>目标</th><th>结果</th></tr></thead><tbody>${
        list.map(h => `<tr><td class="small muted">${esc(fmtTime(h.at))}</td><td class="mono small">${esc(h.action)}</td><td class="small">${esc(h.detail && h.detail.title || (h.detail && h.detail.x !== undefined ? `(${h.detail.x},${h.detail.y})` : '') || '—')}</td><td>${h.ok ? '<span class="chip ok small">ok</span>' : `<span class="chip bad small" title="${esc(h.error || '')}">failed</span>`}</td></tr>`).join('')
      }</tbody></table>` : '<div class="empty" data-page-state="empty">还没有 computer 动作记录</div>';
    } catch (e) { $('#cp-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  // B18.5 — Stop 必须真实 cancel（终止活动子进程）
  $('#cp-stop').onclick = async () => {
    try {
      const r = await api.computerStop();
      toast(`已终止 ${r.stopped} 个活动 computer 操作`, 'ok');
      refreshActive();
    } catch (e) { toast(e.message, 'error'); }
  };
  refreshActive();
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
  if (!state.logs.length) { pane.innerHTML = `<div class="empty" data-page-state="empty">暂无事件</div>`; return; }
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
