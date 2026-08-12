// v2.9.9 Phase B（B24/B25）— Command Palette + 全局键盘快捷键。
// Palette 只做「导航 / 既有用户动作」入口，绝不绕过 Permission，也不创造运行时事实。
// 全部命令复用既有 DOM 动作（点击按钮 / pages.open / panels.activate），不引入第二套 IPC。
import { $, $$ } from './util.js';
import * as panels from './panels.js';
import * as pages from './pages.js';

let inputEl = null;
let listEl = null;
let hintEl = null;
let commands = [];
let filtered = [];
let selIndex = 0;
let isOpen = false;

/* ---------------- layout helpers（B24 引用的面板切换） ---------------- */
function toggleBottom(tab) {
  const bottom = $('#bottom');
  if (!bottom) return;
  const nowHidden = bottom.classList.toggle('hidden');
  if (!nowHidden && tab) panels.activate(tab);
}
function toggleSidebar() {
  const left = $('#left');
  if (left) left.classList.toggle('hidden');
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
    { id: 'view.leftChats', label: '左侧切换到 对话', run: () => activateLeft('chats') }
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
      <input id="cp-input" type="text" autocomplete="off" spellcheck="false" placeholder="输入命令…（Esc 关闭）" aria-label="命令搜索">
      <div id="cp-list" role="listbox"></div>
      <div id="cp-hint" class="muted small">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>`;
  document.body.appendChild(wrap);
  inputEl = $('#cp-input');
  listEl = $('#cp-list');
  hintEl = $('#cp-hint');
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closePalette(); });
  inputEl.addEventListener('input', () => { selIndex = 0; renderList(); });
}

function renderList() {
  const q = (inputEl.value || '').trim().toLowerCase();
  filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : commands.slice();
  if (selIndex >= filtered.length) selIndex = 0;
  listEl.innerHTML = filtered.length
    ? filtered.map((c, i) => `<div class="cp-item${i === selIndex ? ' sel' : ''}" role="option" data-i="${i}">
        <span class="cp-label">${c.label}</span>${c.hint ? `<span class="cp-kbd">${c.hint}</span>` : ''}
      </div>`).join('')
    : '<div class="cp-empty muted">无匹配命令</div>';
  listEl.querySelectorAll('.cp-item').forEach(n => {
    n.onclick = () => exec(filtered[Number(n.dataset.i)]);
    n.onmouseenter = () => { selIndex = Number(n.dataset.i); paintSel(); };
  });
}
function paintSel() {
  listEl.querySelectorAll('.cp-item').forEach((n, i) => n.classList.toggle('sel', i === selIndex));
  const sel = listEl.querySelector('.cp-item.sel');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  ensureDom();
  isOpen = true;
  $('#cmd-palette').classList.remove('hidden');
  inputEl.value = '';
  selIndex = 0;
  renderList();
  inputEl.focus();
}
function closePalette() {
  isOpen = false;
  const el = $('#cmd-palette');
  if (el) el.classList.add('hidden');
}
function exec(cmd) {
  if (!cmd) return;
  closePalette();
  try { cmd.run(); } catch (e) { console.error('palette command failed', cmd.id, e); }
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
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selIndex = Math.min(selIndex + 1, filtered.length - 1); paintSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selIndex = Math.max(selIndex - 1, 0); paintSel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); exec(filtered[selIndex]); return; }
    if (mod && e.shiftKey && String(e.key || '').toLowerCase() === 'p') { e.preventDefault(); closePalette(); return; }
    return; // 其余按键（输入字符）交给 palette 输入框用于过滤
  }
  // 面板未打开：仅处理带修饰键的全局快捷键。
  if (!mod) return;
  const k = String(e.key || '').toLowerCase();
  if (e.shiftKey && k === 'p') { e.preventDefault(); e.stopPropagation(); openPalette(); return; }  // Ctrl+Shift+P 唤起
  if (!e.shiftKey && k === 'j') { e.preventDefault(); toggleBottom('terminal'); return; }          // Ctrl+J 底部面板
  if (!e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }                   // Ctrl+B 侧边栏
  if (e.shiftKey && k === 'e') { if (!isTyping(e)) { e.preventDefault(); activateLeft('files'); } return; } // Ctrl+Shift+E 文件
  if (e.shiftKey && k === 'r') { e.preventDefault(); toggleBottom('problems'); return; }           // Ctrl+Shift+R 问题/Runs
  if (!e.shiftKey && k === 'n') { if (!isTyping(e)) { e.preventDefault(); $('#btn-newchat') && $('#btn-newchat').click(); } return; } // Ctrl+N 新对话
}

export function init() {
  commands = buildCommands();
  ensureDom();
  document.addEventListener('keydown', onKey, true);
}

export function toggle() { isOpen ? closePalette() : openPalette(); }
