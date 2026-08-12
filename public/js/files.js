// Left sidebar "Files" tab: lazy-loading project tree + quick preview.
import { api } from './api.js';
import { state } from './state.js';
import { $, esc, h, fmtBytes, toast, openModal } from './util.js';

const expanded = new Set();

export async function render() {
  const box = $('#left-files');
  if (!state.project) { box.innerHTML = `<div class="empty">未打开项目</div>`; return; }
  box.innerHTML = `<div class="tree-root"><div class="tree-head" title="${esc(state.project.root_path)}">${esc(state.project.name)}</div><div id="tree"></div></div>`;
  await renderDir('.', $('#tree'), 0);
}

async function renderDir(dir, container, depth) {
  let data;
  try { data = await api.tree(dir); }
  catch (e) { container.innerHTML = `<div class="err small">${esc(e.message)}</div>`; return; }
  container.innerHTML = '';
  for (const it of data.items) {
    const row = h('div', { class: 'tnode' + (it.dir ? ' dir' : ''), style: `padding-left:${8 + depth * 12}px` });
    row.innerHTML = `${it.dir ? '<span class="tcaret">▸</span>' : '<span class="tcaret ghost">·</span>'}<span class="tname">${esc(it.name)}</span>${it.dir ? '' : `<span class="tsize">${esc(fmtBytes(it.size))}</span>`}`;
    const child = h('div', { class: 'tchildren' });
    row.onclick = async (e) => {
      e.stopPropagation();
      if (it.dir) {
        const open = expanded.has(it.path);
        if (open) { expanded.delete(it.path); child.innerHTML = ''; row.querySelector('.tcaret').textContent = '▸'; }
        else { expanded.add(it.path); row.querySelector('.tcaret').textContent = '▾'; await renderDir(it.path, child, depth + 1); }
      } else {
        await preview(it.path);
      }
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const input = $('#input');
      input.value = (input.value ? input.value + ' ' : '') + it.path;
      input.focus();
      toast('已插入路径到输入框');
    };
    container.appendChild(row);
    container.appendChild(child);
    if (it.dir && expanded.has(it.path)) { row.querySelector('.tcaret').textContent = '▾'; await renderDir(it.path, child, depth + 1); }
  }
  if (!data.items.length) container.innerHTML = `<div class="muted small" style="padding-left:${8 + depth * 12}px">（空目录）</div>`;
}

export async function preview(relPath) {
  try {
    const f = await api.readFile(relPath);
    const body = f.binary || f.truncated
      ? `<div class="muted">${esc(f.content)}</div>`
      : `<pre class="code preview"><code>${esc(f.content)}</code></pre>`;
    openModal(relPath, body + `<div class="modal-tip muted">右键文件可把路径插入输入框，让 Agent 直接处理它。</div>`, { noFooter: true });
  } catch (e) { toast(e.message, 'error'); }
}
