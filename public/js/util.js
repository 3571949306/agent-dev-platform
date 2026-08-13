// DOM / formatting helpers. No external libraries.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function h(tag, attrs = {}, html = '') {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  if (html) n.innerHTML = html;
  return n;
}

let toastTimer = null;
export function toast(msg, type = 'info') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

export function openModal(title, bodyHtml, opts = {}) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  modal.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" title="关闭">&times;</button></div>
    <div class="modal-body">${bodyHtml}</div>
    ${opts.noFooter ? '' : `<div class="modal-foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn primary" data-act="ok">${esc(opts.okText || '确定')}</button>
    </div>`}`;
  overlay.classList.remove('hidden');
  modal.querySelector('.modal-x').onclick = closeModal;
  const cancel = modal.querySelector('[data-act="cancel"]');
  if (cancel) cancel.onclick = closeModal;
  if (opts.onMount) opts.onMount(modal);
  return modal;
}
export function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal').innerHTML = '';
}
export function onModalOk(fn) {
  const b = $('#modal [data-act="ok"]');
  if (b) b.onclick = fn;
}

/**
 * B42 — 统一破坏性确认：目标 / 后果 / 可逆性三要素。
 * 兼容旧签名 confirmBox(title, '文本')；新签名传 { target, consequence, reversibility }。
 */
export function confirmBox(title, messageOrSpec) {
  let html;
  if (messageOrSpec && typeof messageOrSpec === 'object') {
    const s = messageOrSpec;
    html = `<div class="confirm-spec">
      <div class="confirm-row"><b>目标</b><div class="muted">${esc(s.target || '—')}</div></div>
      <div class="confirm-row"><b>后果</b><div class="muted">${esc(s.consequence || '—')}</div></div>
      <div class="confirm-row"><b>可逆性</b><div class="muted">${esc(s.reversibility || '—')}</div></div>
    </div>`;
  } else {
    html = `<p class="muted">${esc(messageOrSpec)}</p>`;
  }
  return new Promise(resolve => {
    openModal(title, html, { okText: '确认' });
    onModalOk(() => { closeModal(); resolve(true); });
    const c = $('#modal [data-act="cancel"]');
    if (c) c.onclick = () => { closeModal(); resolve(false); };
  });
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Minimal, safe markdown: fenced code, inline code, bold, headings, lists, links. */
export function md(text) {
  const src = String(text || '');
  const blocks = [];
  let s = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre class="code"><div class="code-lang">${esc(lang || 'text')}</div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => `<code class="inline">${c}</code>`);
  s = s.replace(/^######\s?(.+)$/gm, '<h6>$1</h6>')
       .replace(/^#####\s?(.+)$/gm, '<h5>$1</h5>')
       .replace(/^####\s?(.+)$/gm, '<h4>$1</h4>')
       .replace(/^###\s?(.+)$/gm, '<h3>$1</h3>')
       .replace(/^##\s?(.+)$/gm, '<h3>$1</h3>')
       .replace(/^#\s?(.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="1">$1</a>');
  s = s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  s = '<p>' + s + '</p>';
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return s;
}

/** Render a unified diff string into colored HTML. */
export function renderDiff(diffText) {
  if (!diffText) return '<div class="muted">（无差异）</div>';
  const lines = String(diffText).split(/\r?\n/);
  let add = 0, del = 0;
  const rows = lines.map(l => {
    let cls = 'ctx';
    if (l.startsWith('+++') || l.startsWith('---')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) { cls = 'add'; add++; }
    else if (l.startsWith('-')) { cls = 'del'; del++; }
    return `<div class="dl ${cls}">${esc(l) || '&nbsp;'}</div>`;
  }).join('');
  return `<div class="diff-stat"><span class="add">+${add}</span> <span class="del">-${del}</span></div><div class="diff">${rows}</div>`;
}

export function prettyJson(v) {
  try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2); }
  catch { return String(v); }
}

export function truncate(s, n = 400) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + ' …' : str;
}
