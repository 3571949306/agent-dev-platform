import { api } from './api.js';
import { state } from './state.js';
import { $, esc, truncate } from './util.js';
import { statusLabel } from './uiStatus.js';
import { openRun } from './workspace.js';

let filter = 'all';
let search = '';

export async function render() {
  const box = $('#left-runs');
  box.innerHTML = `<div class="runs-toolbar"><input id="run-search" placeholder="Search goal, agent, runId" value="${esc(search)}"><div class="run-filters">${['all', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted'].map(value => `<button class="run-filter ${filter === value ? 'active' : ''}" data-run-filter="${value}">${value}</button>`).join('')}</div></div><div id="run-list"><div class="empty small">Loading…</div></div>`;
  $('#run-search').oninput = event => { search = event.target.value; clearTimeout(render.searchTimer); render.searchTimer = setTimeout(load, 150); };
  box.querySelectorAll('[data-run-filter]').forEach(button => button.onclick = () => { filter = button.dataset.runFilter; render(); });
  await load();
}

async function load() {
  const list = $('#run-list'); if (!list) return;
  try {
    const result = await api.runs({ limit: 50, status: filter, search, projectId: state.project && state.project.id });
    const items = result.items || [];
    list.innerHTML = items.length ? items.map(run => `<button class="run-list-item" data-run-id="${esc(run.id)}"><span class="run-list-status">${esc(statusLabel(run.status))}</span><strong title="${esc(run.goal || run.id)}">${esc(truncate(run.goal || run.id, 48))}</strong><span>${esc(run.agentName || '主智能体')}</span><span>${esc(run.type)}</span><span>${formatDuration(run.durationMs)} · ${esc(run.verification)}</span></button>`).join('') : '<div class="empty small">No runs</div>';
    list.querySelectorAll('[data-run-id]').forEach(button => button.onclick = () => openRun(button.dataset.runId));
  } catch (error) { list.innerHTML = `<div class="err small">${esc(error.message)}</div>`; }
}

function formatDuration(ms) { const seconds = Math.floor(Number(ms || 0) / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
