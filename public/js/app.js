// Renderer entry point. Wires the IDE shell to the main process over IPC.
import { api, onEvent } from './api.js';
import { state } from './state.js';
import { $, $$, esc, toast, openModal, closeModal, onModalOk, confirmBox, fmtTime } from './util.js';
import { ZH } from './i18n.js';
import * as chat from './chat.js';
import * as panels from './panels.js';
import * as files from './files.js';
import * as pages from './pages.js';
import { initOrchestration } from './orchestration.js';
import * as theme from './theme.js';
import * as palette from './palette.js';
import * as workspace from './workspace.js';
import * as runs from './runs.js';
import { ingestRunEvent } from './runViewModel.js';

let modelListenersBound = false;

/* ---------------- B74 — 界面缩放（真话：全局 CSS zoom，持久化在 settings） ----------------
 * Ctrl+= / Ctrl+加号 放大 · Ctrl+- 缩小 · Ctrl+0 重置 · Ctrl+滚轮 缩放；
 * 主进程菜单同样下发 zoom:in/out/reset 事件（见 main.js），两条路径同一 applyZoom。 */
const ZOOM_MIN = 0.6, ZOOM_MAX = 1.8, ZOOM_STEP = 0.1;
let currentZoom = 1;
export function applyZoom(z, { persist = true, silent = false } = {}) {
  currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  document.documentElement.style.zoom = String(currentZoom);
  if (persist) { try { api.settingsSet('ui.zoom', currentZoom).catch(() => {}); } catch { /* 不阻塞 */ } }
  if (!silent) toast(`缩放 ${Math.round(currentZoom * 100)}%`, 'info');
}
export const zoomIn = () => applyZoom(currentZoom + ZOOM_STEP);
export const zoomOut = () => applyZoom(currentZoom - ZOOM_STEP);
export const zoomReset = () => applyZoom(1);
export const getZoom = () => currentZoom;

function initZoom() {
  // 恢复持久化缩放（静默，不打扰启动）
  api.settingsGet('ui.zoom', 1).then(z => {
    const n = Number(z);
    if (Number.isFinite(n) && n !== 1) applyZoom(n, { persist: false, silent: true });
  }).catch(() => {});
  // 键盘：Ctrl/Cmd + =/+ 放大，- 缩小，0 重置（菜单加速器消费时不会重复触发）
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key;
    if (k === '=' || k === '+') { e.preventDefault(); zoomIn(); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomOut(); }
    else if (k === '0') { e.preventDefault(); zoomReset(); }
  });
  // Ctrl+滚轮缩放（阻止页面默认滚动）
  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else if (e.deltaY > 0) zoomOut();
  }, { passive: false });
}

async function boot() {
  // v2.9.9 Phase B Final（B37）— 全局错误边界：window.error / unhandledrejection
  // 统一进 backend Problems（去重、持久化），Renderer 绝不整死；
  // 重要 UI 路径不允许 silent catch{} 吞错（由各模块 console.error + 上报保证）。
  window.addEventListener('error', (event) => {
    console.error('window.error', event && event.message);
    try {
      api.problemsReport({
        code: 'RENDERER_ERROR',
        severity: 'ERROR',
        message: String((event && event.message) || 'unknown renderer error'),
        relatedKey: 'window.error'
      }).catch(() => {});
    } catch { /* backend 不可用时只留 console */ }
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    const message = String((reason && reason.message) || reason || 'unhandled rejection');
    console.error('unhandledrejection', reason);
    try {
      api.problemsReport({
        code: 'RENDERER_UNHANDLED_REJECTION',
        severity: 'WARNING',
        message,
        relatedKey: 'unhandledrejection:' + message.slice(0, 80)
      }).catch(() => {});
    } catch { /* noop */ }
  });

  // v2.9.9 Phase B（B2/B31）— apply persisted appearance as early as possible.
  theme.init().catch(() => {});
  try {
    if (window.__adpBootStage) window.__adpBootStage('runtime');
    await api.systemInfo();
  } catch (e) {
    // B30 — BOOT_FAILED：component + error + 重试，绝不永久白屏
    if (window.__adpBootFailed) window.__adpBootFailed('IPC / SystemInfo', e.message);
    else document.body.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#eee">BOOT_FAILED · ${esc(e.message)}</div>`;
    return;
  }

  panels.init();
  workspace.initWorkspace();
  wireShell();
  initZoom(); // B74 — 缩放：恢复持久化值 + 快捷键/滚轮绑定
  chat.bindComposerDraft(); // B27.4 — 草稿自动持久化（debounce 写 settings 真源）
  palette.init(); // v2.9.9 Phase B（B24/B25）— 命令面板 + 全局快捷键
  initOrchestration(); // v2.9.0 — 编排 Run Tree / Delegation Card（隔离激活）
  onEvent(ev => {
    // B74 — 主进程菜单下发的缩放事件（与本地快捷键同一 applyZoom，绝不双套实现）
    if (ev && (ev.type === 'zoom:in' || ev.type === 'zoom:out' || ev.type === 'zoom:reset')) {
      if (ev.type === 'zoom:in') zoomIn();
      else if (ev.type === 'zoom:out') zoomOut();
      else zoomReset();
      return;
    }
    try { ingestRunEvent(ev); } catch (err) { console.error('run view event error', err, ev); }
    try { chat.handleEvent(ev); } catch (err) { console.error('event error', err, ev); }
    try { pages.handleDiagEvent(ev); } catch (err) { console.error('diag event error', err, ev); }
    try { pages.handleProbeEvent(ev); } catch (err) { console.error('probe event error', err, ev); }
    // v2.9.9 Phase B（B11）— Workflow 状态事件 → 徽标 + Problems（不只 toast）
    try { pages.handleWorkflowEvent(ev); } catch (err) { console.error('workflow event error', err, ev); }
    // v2.9.9 Phase B Final（B21）— backend Problems Center 事件 → 面板/徽标刷新
    try { panels.handleProblemEvent(ev); } catch (err) { console.error('problem event error', err, ev); }
  });

  if (window.__adpBootStage) window.__adpBootStage('project');
  await refreshAgents();
  await restoreProject();
  if (window.__adpBootStage) window.__adpBootStage('interface');
  await chat.loadConversations();
  renderAgentsPanel();

  // open the most recent conversation of this project, if any
  if (state.conversations.length) {
    // B48 — 优先恢复上次会话（按项目隔离的真源）；找不到则回退最新会话
    let target = null;
    if (state.project && state.project.id) {
      try {
        const lastConvId = await api.settingsGet(`ui.lastConversation.${state.project.id}`, null);
        if (lastConvId && state.conversations.some(c => c.id === lastConvId)) target = lastConvId;
      } catch { /* 回退最新 */ }
    }
    await chat.openConversation(target || state.conversations[0].id);
  }
  else {
    $('#messages').innerHTML = `<div class="chat-empty"><h2>开始一个任务</h2><p class="muted">先打开一个项目，然后用自然语言描述你要做的事。</p></div>`;
    await chat.restoreComposerDraft(); // B27.4 — 无会话时恢复新任务草稿
  }

  // B48 — 恢复上次活动页（仅管理页；绝不恢复任何密钥数据）
  try {
    const lastPage = await api.settingsGet('ui.lastPage', null);
    const KNOWN = ['dashboard', 'connections', 'agents', 'mcp', 'skills', 'workflows', 'generator', 'diagnostics', 'settings'];
    if (lastPage && KNOWN.includes(lastPage)) pages.open(lastPage);
  } catch { /* 恢复失败保持默认视图 */ }

  // v2.9.9 Phase B Final（B22）— Recovery Center：仅展示真实中断记录；
  // 没有断点续跑 Runtime，绝不提供 Resume/Continue execution 按钮。
  let recoveryShown = false;
  try {
    const recovery = await api.recoverySummary();
    if (recovery) { showRecoveryCenter(recovery); recoveryShown = true; }
  } catch { /* backend 不可用时不打断启动 */ }

  // B30 — 启动完成：移除 splash（此前各阶段已如实展示）
  const splash = $('#boot-splash');
  if (splash) splash.remove();

  // B35 — 性能基线：workbench ready 标记 + 真实渲染路径测量钩子（只记机器结果）
  window.__adpPerfWorkbenchReady = performance.now();
  window.__adpBench = {
    bootMs: () => (window.__adpPerfWorkbenchReady || 0) - (window.__adpPerfBootStart || 0),
    // 打开 2000 行文件（真实 openFile 渲染路径）
    async openLargeFile(lines = 2000) {
      const content = Array.from({ length: lines }, (_, i) => `bench line ${i + 1} — content`).join('\n');
      const t0 = performance.now();
      await workspace.openFile('bench/large.txt', {
        path: 'bench/large.txt', size: content.length, language: 'Plain Text',
        lineCount: lines, content, binary: false, truncated: false
      });
      return performance.now() - t0;
    },
    // 500 条终端更新（bounded DOM 真实路径）
    terminalUpdates: (n = 500) => panels.benchTerminalUpdates(n),
    // 1000 条 timeline 事件（runViewModel 去重 + 真实 ingest 路径）
    ingestTimelineEvents(n = 1000) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        ingestRunEvent({ type: 'mainAgent:timeline', runId: 'bench-run', eventId: `bench-ev-${i}`, timestamp: i });
      }
      return performance.now() - t0;
    }
  };

  // v2.9.9 Phase B Final（B29）— Onboarding 2.0：智能检测已完成步骤，
  // 全部就绪则跳过；不强制（可 Skip，Settings 可重开）。与 Recovery 弹窗互斥。
  try {
    const ob = await api.onboardingStatus();
    if (!recoveryShown && ob && !ob.completed && !ob.skipped && !ob.allReady) showOnboarding(ob);
  } catch { /* onboarding 失败不阻塞产品 */ }

  // B29 — Settings 可重开引导（不强制，随时可触发）
  window.addEventListener('adp-reopen-onboarding', async () => {
    try { const ob = await api.onboardingStatus(); showOnboarding(ob); } catch (e) { toast(e.message, 'error'); }
  });

  // B44/B47 — 全局产品状态 + 活动栏徽标（确定性优先级映射，绝不永远 Ready）
  refreshGlobalStatus();
  setInterval(refreshGlobalStatus, 7000);

  window.addEventListener('agents-changed', () => refreshAgents().then(renderAgentsPanel));
}

/* B44 — 全局产品状态：Critical Error > 等待权限 > 活跃 Run > 锁占用 > 连接异常 > 就绪。
 * 所有输入来自真实 backend；无高优先条件时保留终态标签（由 setRunning 写入）。 */
function applyGlobalStatus(text, kind) {
  const el = $('#status-text');
  if (el) el.textContent = text;
  const dot = $('#status-dot');
  if (dot) dot.className = 'dot' + (kind === 'busy' ? ' busy' : (kind === 'warn' ? ' warn' : ''));
}
let statusRefreshBusy = false;
async function refreshGlobalStatus() {
  if (statusRefreshBusy) return;
  statusRefreshBusy = true;
  try {
    const [perms, problemsActive, locks, runsResp] = await Promise.all([
      api.permissionsList().catch(() => []),
      api.problemsCountActive().catch(() => 0),
      api.lockListBusy().catch(() => []),
      api.runs({}).catch(() => null)
    ]);
    const pendingPerms = Array.isArray(perms) ? perms.length : 0;
    const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'];
    const runsArr = Array.isArray(runsResp) ? runsResp : ((runsResp && runsResp.items) || []);
    const activeRuns = runsArr.filter(r => !TERMINAL.includes(r.status)).length;
    const degraded = (state.connections || []).filter(c => c.status && ['UNAVAILABLE', 'ERROR', 'DEGRADED'].includes(c.status.status)).length;

    // B47 — 徽标：权限等待 / Workflow 审批 / Generator READY / 未解决问题
    panels.setBadge('permission', pendingPerms);
    panels.setBadge('problems', Number(problemsActive) || 0);
    try {
      const wfRuns = await api.workflowListRuns(50);
      const waiting = Array.isArray(wfRuns) ? wfRuns.filter(r => r.status === 'WAITING_APPROVAL').length : 0;
      panels.setBadge('workflow', waiting);
    } catch { /* workflow 徽标缺省 */ }
    try {
      const drafts = await api.generatorListDrafts(50);
      const ready = Array.isArray(drafts) ? drafts.filter(d => d.status === 'READY').length : 0;
      panels.setBadge('generator', ready);
    } catch { /* generator 徽标缺省 */ }

    if (Number(problemsActive) > 0) { applyGlobalStatus(`系统降级 · ${problemsActive} 个未解决问题`, 'warn'); return; }
    if (pendingPerms > 0) { applyGlobalStatus('等待权限', 'warn'); return; }
    if (activeRuns > 0) { applyGlobalStatus(`${activeRuns} 个任务运行中`, 'busy'); return; }
    if (Array.isArray(locks) && locks.length > 0) { applyGlobalStatus('项目写锁占用', 'warn'); return; }
    if (degraded > 0) { applyGlobalStatus(`${degraded} 个模型连接异常`, 'warn'); return; }
    if (!state.running) {
      // 无高优先条件时保留终态标签（setRunning 写入的 已完成/已失败/…），绝不覆盖成真话之外的文案
      const TERMINAL_LABELS = ['已完成', '已失败', '已取消', '超时', '已中断', '就绪'];
      const cur = ($('#status-text') ? $('#status-text').textContent : '').trim();
      if (!TERMINAL_LABELS.includes(cur)) applyGlobalStatus('就绪', '');
    }
  } catch { /* backend 不可用时保持当前状态 */ }
  finally { statusRefreshBusy = false; }
}

/* B29 — Onboarding 2.0：五步清单（智能检测已完成项），允许随时跳过。
 * 绝不把引导写入 localStorage 保存原始密钥；配置动作全部走各自页面的既有安全路径。 */
export function showOnboarding(ob) {
  const steps = (ob && ob.steps) || {};
  const item = (done, label, hint) => `
    <div class="prob">
      <span class="chip ${done ? 'ok' : ''} small">${done ? '✓ 已完成' : '待完成'}</span>
      <span><b>${esc(label)}</b><div class="muted small">${esc(hint)}</div></span>
    </div>`;
  openModal('开始使用 Agent Dev Platform', `
    ${item(steps.openProject, '1. 打开项目', '左上角「未打开项目」选择本地代码文件夹。')}
    ${item(steps.configureModel, '2. 配置模型连接', '在 API 连接页添加连接（密钥加密存储，只显示掩码）。')}
    ${item(steps.testConnection, '3. 测试连接', '在 API 连接页点「测试连接」，状态词汇只来自真实结果。')}
    ${item(steps.verifyMainAgent, '4. 确认主智能体', '智能体页需存在 is_main 的平台主智能体。')}
    ${item(steps.runFirstTask, '5. 运行第一个任务', '在对话框用自然语言发起任务，由 Run Center 全程可观察。')}
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="ob-goto">去配置</button>
      <button class="btn" id="ob-skip">跳过引导</button>
    </div>
  `, { noFooter: true });
  $('#ob-goto').onclick = async () => {
    try { await api.onboardingComplete(false).catch(() => {}); } catch { /* ignore */ }
    closeModal();
    if (!steps.openProject) { const b = $('#btn-project'); if (b) b.click(); }
    else if (!steps.testConnection) { pages.open('connections'); }
    else if (!steps.verifyMainAgent) { pages.open('agents'); }
    else { const input = $('#input'); if (input) input.focus(); }
  };
  $('#ob-skip').onclick = async () => {
    try { await api.onboardingComplete(true); } catch { /* ignore */ }
    closeModal();
  };
}

/* B22 — Recovery Center：上一次会话中断的真话展示。
 * 动作只有：View Run / View Changes / Start New Task（新 runId）/ Dismiss。 */
async function showRecoveryCenter(rec) {
  const runs = (rec.snapshot && rec.snapshot.interruptedRuns) || [];
  const wfs = (rec.snapshot && rec.snapshot.interruptedWorkflows) || [];
  const drafts = (rec.snapshot && rec.snapshot.interruptedDrafts) || [];
  openModal('Previous Session Interrupted', `
    <div class="warn-box">上一次会话被中断。平台没有断点续跑运行时，不会自动恢复执行；你可以查看中断现场，或新建一个全新任务（新 runId，绝不复活旧 Run）。</div>
    ${runs.map(r => `
      <div class="prob">
        <span class="chip warn small">Run</span>
        <span class="mono small">${esc(String(r.runId || '').slice(0, 8))}</span>
        <span class="small">Last stage: ${esc(r.lastStage || 'unknown')}</span>
        <span class="small">Verification: ${esc(r.verification || 'UNKNOWN')}</span>
        <span class="small muted">Files changed: UNKNOWN（以 Diff 页真实 git 状态为准）</span>
      </div>`).join('')}
    ${wfs.map(w => `
      <div class="prob"><span class="chip warn small">Workflow</span>
        <span class="mono small">${esc(String(w.workflowRunId || '').slice(0, 8))}</span>
        <span class="small">中断前状态：${esc(w.lastStatus || 'unknown')}</span>
        <span class="small">Step: ${esc(w.currentStepId || '—')}</span></div>`).join('')}
    ${drafts.map(d => `
      <div class="prob"><span class="chip warn small">Generator</span>
        <span class="mono small">${esc(String(d.draftId || '').slice(0, 8))}</span>
        <span class="small">${esc(d.artifactType || '')} · 中断前 ${esc(d.lastStatus || 'unknown')}</span></div>`).join('')}
    <div class="row" style="margin-top:10px">
      ${runs.length ? `<button class="btn" id="rec-view-run">View Run</button><button class="btn" id="rec-view-changes">View Changes</button><button class="btn primary" id="rec-new-task">Start New Task</button>` : ''}
      <button class="btn" id="rec-dismiss">Dismiss</button>
    </div>
  `, { noFooter: true });
  const dismiss = async () => { try { await api.recoveryDismiss(); } catch { /* 忽略 */ } closeModal(); };
  $('#rec-dismiss').onclick = dismiss;
  if (runs.length) {
    $('#rec-view-run').onclick = () => { closeModal(); workspace.openRun(runs[0].runId); };
    $('#rec-view-changes').onclick = () => {
      closeModal();
      const diffTab = document.querySelector('.btab[data-btab="diff"]');
      if (diffTab) diffTab.click();
    };
    $('#rec-new-task').onclick = async () => {
      try {
        const r = await api.recoveryNewTaskDraft(runs[0].runId);
        const input = $('#input');
        if (input && r && r.draft) { input.value = r.draft; input.focus(); }
      } catch { /* 草稿失败不阻塞 */ }
      closeModal();
    };
  }
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
    $('#composer-hint').textContent = v.startsWith('@') ? '用 @智能体名 前缀可把这条消息交给指定智能体' : '';
  });

  $$('.ltab').forEach(b => b.onclick = async () => {
    $$('.ltab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#left-chats').classList.toggle('hidden', b.dataset.ltab !== 'chats');
    $('#left-files').classList.toggle('hidden', b.dataset.ltab !== 'files');
    $('#left-runs').classList.add('hidden');
    if (b.dataset.ltab === 'files') await files.render();
  });

  // v2.9.9 Phase B（B1）— Activity Bar：管理页走 pages.open；
  // Chat/Files 切左侧栏内容，Runs/Computer 切底部面板。不再顶部横向堆叠页面。
  $$('#activity-bar .abtn').forEach(b => {
    b.onclick = async () => {
      if (b.dataset.page) { pages.open(b.dataset.page); return; }
      $$('#activity-bar .abtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const act = b.dataset.act;
      const left = $('#left');
      if (left) left.classList.remove('hidden');
      if (act === 'chat' || act === 'files') {
        const tab = act === 'chat' ? 'chats' : 'files';
        $$('.ltab').forEach(x => x.classList.toggle('active', x.dataset.ltab === tab));
        $('#left-chats').classList.toggle('hidden', tab !== 'chats');
        $('#left-files').classList.toggle('hidden', tab !== 'files');
        $('#left-runs').classList.add('hidden');
        if (act === 'chat') workspace.showTask('chat');
        if (tab === 'files') await files.render();
      } else if (act === 'runs') {
        $('#left-chats').classList.add('hidden');
        $('#left-files').classList.add('hidden');
        $('#left-runs').classList.remove('hidden');
        await runs.render();
      } else if (act === 'computer') {
        const bottom = $('#bottom'); if (bottom) bottom.classList.remove('hidden');
        panels.activate('computer');
      }
    };
  });

  $('#agent-select').onchange = e => { state.agentId = e.target.value; renderModelSelect(); chat.renderComposerChips(); };
  $('#model-select').onchange = async e => {
    const a = state.agents.find(x => x.id === state.agentId);
    if (!a || !e.target.value || a.type === 'external') return;
    // 值为 "connectionId::modelId"，允许跨 API 连接自由切换模型
    const raw = e.target.value;
    const sep = raw.indexOf('::');
    const connId = sep > 0 ? raw.slice(0, sep) : null;
    const model = sep > 0 ? raw.slice(sep + 2) : raw;
    await api.agentUpdate(a.id, { model, ...(connId ? { api_connection_id: connId } : {}) });
    a.model = model;
    if (connId) a.api_connection_id = connId;
    const c = (state.connections || []).find(x => x.id === connId);
    toast('已切换模型：' + model + (c ? '（' + c.name + '）' : ''), 'ok');
    renderModelSelect();
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
  workspace.refreshGitStatus();
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
    if (!await confirmBox('移除项目', {
      target: '项目列表中的该项目条目',
      consequence: 'Agent Dev Platform 将停止显示此项目。磁盘中的项目文件不会被删除。',
      reversibility: '可逆：随时可重新打开同一文件夹。'
    })) return;
    await api.projectRemove(b.dataset.pr);
    closeModal(); projectMenu();
  });
}

/* ---------------- agents ---------------- */
async function refreshAgents() {
  state.agents = await api.agents();
  const sel = $('#agent-select');
  if (!state.agents.length) {
    sel.innerHTML = `<option value="">（无智能体，请到「智能体」页创建）</option>`;
    return;
  }
  const main = state.agents.find(a => a.is_main) || state.agents[0];
  if (!state.agentId || !state.agents.find(a => a.id === state.agentId)) state.agentId = main.id;
  sel.innerHTML = state.agents.map(a => `<option value="${a.id}" ${a.id === state.agentId ? 'selected' : ''}>${esc(a.name)}${a.is_main ? '（主）' : ''}${a.type === 'external' ? '（外部）' : ''}</option>`).join('');
  await renderModelSelect();

  // 监听 connections-updated 事件，实时刷新模型列表
  if (!modelListenersBound) window.addEventListener('connections-updated', async () => {
    state.connections = await api.connections();
    await renderModelSelect();
    if (pages.refreshIfOpen) pages.refreshIfOpen();
  });
  if (!modelListenersBound) window.addEventListener('models-updated', async (e) => {
    state.connections = await api.connections();
    await renderModelSelect();
    if (pages.refreshIfOpen) pages.refreshIfOpen();
  });
  modelListenersBound = true;
}

async function renderModelSelect() {
  const sel = $('#model-select');
  const a = state.agents.find(x => x.id === state.agentId);
  if (!a || a.type === 'external') { sel.innerHTML = `<option>—</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  let connName = '';
  let groups = [];
  try {
    const conns = state.connections.length ? state.connections : (state.connections = await api.connections());
    const cur = conns.find(x => x.id === a.api_connection_id);
    connName = cur ? cur.name : '';
    // 聚合所有 API 连接的模型，按连接分组（optgroup），支持跨连接自由切换
    groups = conns.map(c => ({
      conn: c,
      models: ((c.models || []).map(m => (typeof m === 'string' ? m : (m && m.id) || '')).filter(Boolean))
    })).filter(g => g.models.length);
  } catch {}
  const curValue = (a.api_connection_id && a.model) ? `${a.api_connection_id}::${a.model}` : '';
  // 保证当前模型始终可选
  let found = groups.some(g => g.models.some(m => `${g.conn.id}::${m}` === curValue));
  if (curValue && !found) {
    const target = groups.find(g => g.conn.id === a.api_connection_id) || groups[0];
    if (target) target.models = [a.model, ...target.models];
    else groups = [{ conn: { id: a.api_connection_id, name: connName || '当前连接' }, models: [a.model] }];
  }
  if (!groups.length) groups = [{ conn: { id: a.api_connection_id || '', name: connName || '未连接' }, models: [a.model || '未设置模型'] }];
  sel.innerHTML = groups.map(g =>
    `<optgroup label="${esc(g.conn.name || g.conn.id)}">` +
    g.models.map(m => {
      const v = `${g.conn.id}::${m}`;
      return `<option value="${esc(v)}" ${v === curValue ? 'selected' : ''}>${esc(m)}</option>`;
    }).join('') + `</optgroup>`
  ).join('');
  if ($('#topbar-model')) $('#topbar-model').textContent = a.model || '';
  try { chat.renderComposerChips(); } catch { /* chips 更新失败不阻塞 */ }
  // 更新 composer-hint 显示当前模型信息
  const hint = $('#composer-hint');
  if (hint) {
    if (a.model && a.model !== '未设置模型') {
      hint.textContent = `${a.name} · ${a.model} · ${connName || '未连接'}`;
      hint.className = 'hint';
    } else {
      hint.textContent = `${a.name} · 尚未选择模型`;
      hint.className = 'hint warn-text';
    }
  }
}

function renderAgentsPanel() {
  const box = $('#agents-list');
  if (!box) return;
  if (!state.agents.length) { box.innerHTML = `<div class="empty small">还没有智能体</div>`; return; }
  box.innerHTML = state.agents.slice(0, 10).map(a => {
    const typeLabel = a.type === 'external' ? '外部' : (a.type === 'computer' ? '电脑操作' : '编码');
    const modelInfo = a.type === 'external' ? '' : (a.model ? ` · ${esc(a.model)}` : ' · 未设置模型');
    return `<div class="ra ${a.id === state.agentId ? 'active' : ''}" data-a="${a.id}">
      <div class="ra-name">${esc(a.name)}</div>
      <div class="ra-sub">${a.is_main ? '主智能体 · ' : ''}${typeLabel} · ${(a.tools || []).length} 工具${modelInfo}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.ra').forEach(n => n.onclick = () => {
    state.agentId = n.dataset.a;
    $('#agent-select').value = n.dataset.a;
    renderModelSelect();
    renderAgentsPanel();
  });
}

boot();
