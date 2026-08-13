// Workbench File Explorer. Every filesystem operation crosses guarded IPC.
import { api } from './api.js';
import { state } from './state.js';
import { $, esc, h, fmtBytes, toast, openModal, closeModal, onModalOk, confirmBox } from './util.js';
import { openFile, selectInspector } from './workspace.js';

const expanded = new Set();

export async function render() {
  const box = $('#left-files');
  if (!state.project) { box.innerHTML = '<div class="empty">未打开项目</div>'; return; }
  box.innerHTML = `<div class="file-toolbar"><button class="icon-btn" data-file-refresh title="Refresh">↻</button><button class="icon-btn" data-file-collapse title="Collapse all">⊟</button><button class="icon-btn" data-file-new title="Create File">+F</button><button class="icon-btn" data-folder-new title="Create Folder">+D</button></div><div class="tree-root"><div class="tree-head" title="${esc(state.project.root_path)}">${esc(state.project.name)}</div><div id="tree"></div></div>`;
  box.querySelector('[data-file-refresh]').onclick = () => render();
  box.querySelector('[data-file-collapse]').onclick = () => { expanded.clear(); render(); };
  box.querySelector('[data-file-new]').onclick = () => createPrompt('file', '.');
  box.querySelector('[data-folder-new]').onclick = () => createPrompt('folder', '.');
  await renderDir('.', $('#tree'), 0);
}

async function renderDir(dir, container, depth) {
  let data;
  try { data = await api.tree(dir); }
  catch (error) { container.innerHTML = `<div class="err small">${esc(error.message)}</div>`; return; }
  container.innerHTML = '';
  for (const item of data.items) {
    const row = h('div', { class: `tnode${item.dir ? ' dir' : ''}${state.activeFilePath === item.path ? ' active' : ''}`, style: `padding-left:${8 + depth * 12}px`, title: item.path });
    row.innerHTML = `${item.dir ? '<span class="tcaret">▸</span><span class="file-icon">📁</span>' : `<span class="tcaret ghost">·</span><span class="file-icon">${fileIcon(item.name)}</span>`}<span class="tname">${esc(item.name)}</span>${item.dir ? '' : `<span class="tsize">${esc(fmtBytes(item.size))}</span>`}`;
    const child = h('div', { class: 'tchildren' });
    row.onclick = async event => {
      event.stopPropagation();
      if (item.dir) {
        const open = expanded.has(item.path);
        if (open) { expanded.delete(item.path); child.innerHTML = ''; row.querySelector('.tcaret').textContent = '▸'; }
        else { expanded.add(item.path); row.querySelector('.tcaret').textContent = '▾'; await renderDir(item.path, child, depth + 1); }
      } else await preview(item.path);
    };
    row.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); openContextMenu(event.clientX, event.clientY, item); };
    container.append(row, child);
    if (item.dir && expanded.has(item.path)) { row.querySelector('.tcaret').textContent = '▾'; await renderDir(item.path, child, depth + 1); }
  }
  if (!data.items.length) container.innerHTML = `<div class="muted small" style="padding-left:${8 + depth * 12}px">(empty)</div>`;
}

function fileIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'JS';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '{}';
  if (['md', 'txt'].includes(ext)) return '¶';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(ext)) return '▧';
  return '·';
}

function openContextMenu(x, y, item) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'file-context-menu'; menu.className = 'context-menu'; menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  menu.innerHTML = item.dir
    ? '<button data-new-file>New File</button><button data-new-folder>New Folder</button><hr><button data-copy-path>Copy Relative Path</button><button data-reveal>Reveal in Explorer</button><button data-rename>Rename</button><button class="danger" data-delete>Delete</button>'
    : '<button data-open>Open</button><button data-copy-path>Copy Relative Path</button><button data-reveal>Reveal in Explorer</button><button data-rename>Rename</button><button class="danger" data-delete>Delete</button>';
  document.body.appendChild(menu);
  bind(menu, '[data-open]', () => preview(item.path));
  bind(menu, '[data-new-file]', () => createPrompt('file', item.path));
  bind(menu, '[data-new-folder]', () => createPrompt('folder', item.path));
  bind(menu, '[data-copy-path]', () => navigator.clipboard.writeText(item.path).then(() => toast('Relative path copied', 'ok')));
  bind(menu, '[data-reveal]', () => api.revealFile(item.path));
  bind(menu, '[data-rename]', () => renamePrompt(item));
  bind(menu, '[data-delete]', () => deletePrompt(item));
}

function bind(root, selector, fn) {
  const button = root.querySelector(selector);
  if (button) button.onclick = async () => { closeContextMenu(); try { await fn(); } catch (error) { toast(error.message, 'error'); } };
}
function closeContextMenu() { const menu = $('#file-context-menu'); if (menu) menu.remove(); }

function inputPrompt(title, initial, okText) {
  return new Promise(resolve => {
    openModal(title, `<label>Relative path<input id="file-op-path" value="${esc(initial || '')}" autocomplete="off"></label>`, { okText });
    const input = $('#file-op-path'); input.focus(); input.select();
    const finish = () => { const value = input.value.trim(); closeModal(); resolve(value || null); };
    onModalOk(finish); input.onkeydown = event => { if (event.key === 'Enter') finish(); };
  });
}

async function createPrompt(type, parent) {
  const prefix = parent && parent !== '.' ? parent.replace(/\/$/, '') + '/' : '';
  const relPath = await inputPrompt(type === 'file' ? 'Create File' : 'Create Folder', prefix, 'Create');
  if (!relPath) return;
  try { if (type === 'file') await api.createFile(relPath); else await api.createDir(relPath); expanded.add(parent); await render(); toast('Created: ' + relPath, 'ok'); }
  catch (error) { toast(error.message, 'error'); }
}

async function renamePrompt(item) {
  const next = await inputPrompt('Rename', item.path, 'Rename');
  if (!next || next === item.path) return;
  try { await api.renameFile(item.path, next); await render(); toast('Renamed', 'ok'); }
  catch (error) { toast(error.message, 'error'); }
}

async function deletePrompt(item) {
  const request = await api.requestDeleteFile(item.path);
  const confirmed = await confirmBox('Delete', `Delete ${item.path}? This cannot be undone.`);
  if (!confirmed) return;
  try { await api.deleteFile(request.path, request.token); await render(); toast('Deleted: ' + item.path, 'ok'); }
  catch (error) { toast(error.message, 'error'); }
}

export async function preview(relPath) {
  try {
    const file = await api.readFile(relPath);
    await openFile(relPath, file);
    selectInspector('file', file);
  } catch (error) { toast(error.message, 'error'); }
}

document.addEventListener('click', event => { if (!event.target.closest('#file-context-menu')) closeContextMenu(); });
window.addEventListener('workspace-file-changed', () => { const box = $('#left-files'); if (box && !box.classList.contains('hidden')) render(); });
