// v2.9.9 Phase B（B24/B25/B26）— Command Palette + Quick Open + 全局键盘快捷键。
// 两种模式复用同一 UI / 键位：
//   - commands：命令面板（Ctrl+Shift+P），导航/既有用户动作，绝不绕过 Permission；
//   - files：Quick Open（Ctrl+P），项目内文件搜索并打开只读预览。
// 全部动作复用既有能力（pages.open / panels.activate / files.preview / files:listAll），不引入第二套 IPC。
import { $ } from './util.js';
import { api } from './api.js';
import * as panels from './panels.js';
import * as pages from './pages.js';
import * as files from './files.js';
import { zoomIn, zoomOut, zoomReset } from './app.js';

let inputEl = null;
let listEl = null;
let isOpen = false;
let mode = 'commands';           // 'commands' | 'files'
let commands = [];
let items = [];                  // 当前模式过滤后的条目
let selIndex = 0;
let fileCache = null;            // Quick Open 文件列表缓存（B36：只在打开时拉取一次）

/* ---------------- layout helpers ---------------- */
function toggleBottom(tab) {
  window.dispatchEvent(new CustomEvent('layout-toggle-bottom', { detail: { tab } }));
}
function toggleSidebar() {
  window.dispatchEvent(new CustomEvent('layout-toggle-sidebar'));
}
function activateLeft(tab) {
  const b = $(`.ltab[data-ltab="${tab}"]`);
  if (b) b.click();
}
function clickIfVisible(sel) {
  const el = $(sel);
  if (el && !el.classList.contains('hidden')) el.click();
}

function buildCommands() {
  return [
    { id: 'project.open', label: '打开项目', run: () => $('#btn-project') && $('#btn-project').click() },
    { id: 'chat.new', label: '新对话', hint: 'Ctrl+N', run: () => $('#btn-newchat') && $('#btn-newchat').click() },
    { id: 'run.stop', label: '停止当前运行', run: () => clickIfVisible('#btn-stop') },
    { id: 'quickopen', label: '快速打开文件…', hint: 'Ctrl+P', run: () => openFiles() },
    { id: 'page.dashboard', label: '打开 总览', run: () => pages.open('dashboard') },
    { id: 'page.connections', label: '打开 API 连接', run: () => pages.open('connections') },
    { id: 'page.agents', label: '打开 智能体', run: () => pages.open('agents') },
    { id: 'page.mcp', label: '打开 MCP', run: () => pages.open('mcp') },
    { id: 'page.skills', label: '打开 Skills', run: () => pages.open('skills') },
    { id: 'page.workflows', label: '打开 Workflows', run: () => pages.open('workflows') },
    { id: 'page.generator', label: '打开 AI Generator', run: () => pages.open('generator') },
    { id: 'page.diagnostics', label: '打开 能力诊断', run: () => pages.open('diagnostics') },
    { id: 'page.settings', label: '打开 设置', run: () => pages.open('settings') },
    { id: 'panel.terminal', label: '切换 终端面板', hint: 'Ctrl+J', run: () => toggleBottom('terminal') },
    { id: 'panel.diff', label: '切换 文件更改面板', run: () => toggleBottom('diff') },
    { id: 'panel.problems', label: '切换 问题面板', hint: 'Ctrl+Shift+R', run: () => toggleBottom('problems') },
    { id: 'view.sidebar', label: '切换 左侧边栏', hint: 'Ctrl+B', run: () => toggleSidebar() },
    { id: 'view.leftFiles', label: '左侧切换到 文件', hint: 'Ctrl+Shift+E', run: () => activateLeft('files') },
    { id: 'view.leftChats', label: '左侧切换到 对话', run: () => activateLeft('chats') },
    // B74 — 界面缩放（与快捷键同一实现，不引入第二套逻辑）
    { id: 'view.zoomIn', label: '放大界面', hint: 'Ctrl+=', run: () => zoomIn() },
    { id: 'view.zoomOut', label: '缩小界面', hint: 'Ctrl+-', run: () => zoomOut() },
    { id: 'view.zoomReset', label: '重置缩放 (100%)', hint: 'Ctrl+0', run: () => zoomReset() }
  ];
}

/* ---------------- DOM ---------------- */
function ensureDom() {
  if ($('#cmd-palette')) return;
  const wrap = document.createElement('div');
  wrap.id = 'cmd-palette';
  wrap.className = 'hidden';
  wrap.innerHTML = `
    <div class="cp-box" role="dialog" aria-label="命令面板">
      <input id="cp-input" type="text" autocomplete="off" spellcheck="false" aria-label="搜索">
      <div id="cp-list" role="listbox"></div>
      <div id="cp-hint" class="muted small">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>`;
  document.body.appendChild(wrap);
  inputEl = $('#cp-input');
  listEl = $('#cp-list');
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  inputEl.addEventListener('input', () => { selIndex = 0; renderList(); });
}

/* ---------------- data source ---------------- */
async function loadFiles() {
  if (fileCache) return fileCache;
  try {
    const r = await api.listAllFiles();
    fileCache = (r && r.files) || [];
  } catch { fileCache = []; }
  return fileCache;
}

function applyFilter() {
  const q = (inputEl.value || '').trim().toLowerCase();
  if (mode === 'files') {
    const src = fileCache || [];
    items = (q ? src.filter(p => p.toLowerCase().includes(q)) : src).slice(0, 80)
      .map(p => ({ id: p, label: p, isFile: true }));
  } else {
    items = q ? commands.filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : commands.slice();
  }
  if (selIndex >= items.length) selIndex = 0;
}

function renderList() {
  applyFilter();
  listEl.innerHTML = items.length
    ? items.map((c, i) => `<div class="cp-item${i === selIndex ? ' sel' : ''}" role="option" data-i="${i}">
        <span class="cp-label">${c.label}</span>${c.hint ? `<span class="cp-kbd">${c.hint}</span>` : ''}
      </div>`).join('')
    : `<div class="cp-empty muted">${mode === 'files' ? '无匹配文件' : '无匹配命令'}</div>`;
  listEl.querySelectorAll('.cp-item').forEach(n => {
    n.onclick = () => exec(items[Number(n.dataset.i)]);
    n.onmouseenter = () => { selIndex = Number(n.dataset.i); paintSel(); };
  });
}
function paintSel() {
  listEl.querySelectorAll('.cp-item').forEach((n, i) => n.classList.toggle('sel', i === selIndex));
  const sel = listEl.querySelector('.cp-item.sel');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}

/* ---------------- open / close ---------------- */
async function openCommands() {
  ensureDom();
  mode = 'commands';
  isOpen = true;
  $('#cmd-palette').classList.remove('hidden');
  inputEl.placeholder = '输入命令…（Esc 关闭）';
  inputEl.value = '';
  selIndex = 0;
  renderList();
  inputEl.focus();
}
async function openFiles() {
  ensureDom();
  mode = 'files';
  isOpen = true;
  $('#cmd-palette').classList.remove('hidden');
  inputEl.placeholder = '搜索项目文件…（Esc 关闭）';
  inputEl.value = '';
  selIndex = 0;
  listEl.innerHTML = '<div class="cp-empty muted">加载文件列表…</div>';
  inputEl.focus();
  await loadFiles();
  if (isOpen && mode === 'files') renderList();
}
function close() {
  isOpen = false;
  const el = $('#cmd-palette');
  if (el) el.classList.add('hidden');
}

async function exec(item) {
  if (!item) return;
  close();
  try {
    if (item.isFile) await files.preview(item.id);
    else if (typeof item.run === 'function') item.run();
  } catch (e) { console.error('palette exec failed', item.id, e); }
}

/* ---------------- keyboard ---------------- */
function isTyping(e) {
  const t = e.target;
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}
function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  // 面板已打开：优先处理导航/执行键（Enter / 箭头 / Esc 无需修饰键）。
  if (isOpen) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selIndex = Math.min(selIndex + 1, items.length - 1); paintSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selIndex = Math.max(selIndex - 1, 0); paintSel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); exec(items[selIndex]); return; }
    if (mod && e.shiftKey && String(e.key || '').toLowerCase() === 'p') { e.preventDefault(); close(); return; }
    return; // 其余按键（输入字符）交给输入框用于过滤
  }
  // 面板未打开：仅处理带修饰键的全局快捷键。
  if (!mod) return;
  const k = String(e.key || '').toLowerCase();
  if (e.shiftKey && k === 'p') { e.preventDefault(); e.stopPropagation(); openCommands(); return; } // Ctrl+Shift+P 命令面板
  if (!e.shiftKey && k === 'p') { if (!isTyping(e)) { e.preventDefault(); openFiles(); } return; }   // Ctrl+P Quick Open
  if (!e.shiftKey && k === 'j') { e.preventDefault(); toggleBottom('terminal'); return; }            // Ctrl+J 底部面板
  if (!e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }                     // Ctrl+B 侧边栏
  if (e.shiftKey && k === 'e') { if (!isTyping(e)) { e.preventDefault(); activateLeft('files'); } return; } // Ctrl+Shift+E 文件
  if (e.shiftKey && k === 'r') { e.preventDefault(); toggleBottom('problems'); return; }             // Ctrl+Shift+R 问题/Runs
  if (!e.shiftKey && k === 'n') { if (!isTyping(e)) { e.preventDefault(); $('#btn-newchat') && $('#btn-newchat').click(); } return; } // Ctrl+N 新对话
}

export function init() {
  commands = buildCommands();
  ensureDom();
  document.addEventListener('keydown', onKey, true);
}

export function toggle() { isOpen ? close() : openCommands(); }
