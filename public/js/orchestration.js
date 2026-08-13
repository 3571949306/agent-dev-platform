// Real run lineage renderer. Presentation is derived from backend runId / parentRunId / rootRunId truth.
import { api } from './api.js';
import { esc, toast } from './util.js';
import { listRunViews, subscribeRunView } from './runViewModel.js';
import { statusLabel, isTerminalStatus } from './uiStatus.js';
import { selectInspector } from './workspace.js';

function duration(node) {
  const ms = Math.max(0, (node.terminalAt || Date.now()) - node.startedAt);
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function agentName(node) {
  if (!node.parentRunId) return '主智能体';
  return node.adapterId || node.agentId || '子智能体';
}

export function initOrchestration() {
  const mount = document.getElementById('orchestration-list');
  if (!mount) return () => {};

  function render() {
    const allNodes = listRunViews();
    const byId = new Map(allNodes.map(node => [node.runId, node]));
    // AgentHub may persist a transport wrapper Run and its native execution Run
    // as parent/child with the same adapter identity. They are two runtime
    // records but one user-facing Agent node, so collapse only that exact pair.
    const hidden = new Set(allNodes.filter(node => {
      const parent = byId.get(node.parentRunId);
      if (parent && node.adapterId && parent.adapterId === node.adapterId) return true;
      // Dynamic-agent execution can emit both a dispatch wrapper and its
      // canonical lineage Run.  The wrapper reports parentRunId but resets
      // rootRunId/depth, while the canonical record preserves the actual tree.
      // Prefer that canonical sibling without inventing any lineage in the UI.
      const canonicalSibling = allNodes.some(candidate =>
        candidate.runId !== node.runId &&
        candidate.parentRunId === node.parentRunId &&
        candidate.agentId && candidate.agentId === node.agentId &&
        candidate.rootRunId !== candidate.runId && Number(candidate.depth) > 0
      );
      return canonicalSibling && (node.rootRunId === node.runId || Number(node.depth) === 0);
    }).map(node => node.runId));
    const nodes = allNodes.filter(node => !hidden.has(node.runId));
    const visibleParent = node => {
      let id = node.parentRunId;
      const seen = new Set();
      while (id && hidden.has(id) && !seen.has(id)) { seen.add(id); id = byId.get(id) && byId.get(id).parentRunId; }
      return id;
    };
    const roots = nodes.filter(node => !visibleParent(node) || !nodes.some(candidate => candidate.runId === visibleParent(node)));
    if (!roots.length) { mount.innerHTML = '<div class="orch-empty">No run tree</div>'; return; }
    const children = id => nodes.filter(node => visibleParent(node) === id).sort((a, b) => a.startedAt - b.startedAt);
    let html = '<div class="run-tree">';
    const visit = node => {
      const active = !isTerminalStatus(node.status);
      html += `<div class="run-tree-node" data-run-node="${esc(node.runId)}" style="--depth:${Number(node.depth || 0)}"><button class="run-node-main" data-select-run="${esc(node.runId)}"><span class="run-node-state">${active ? '<span class="spinner"></span>' : statusIcon(node.status)}</span><strong>${esc(agentName(node))}</strong><span>${esc(statusLabel(node.status))}</span><span>${esc(node.model || '')}</span><span>${esc(duration(node))}</span></button>${node.parentRunId && active ? `<button class="run-node-cancel" data-cancel-child="${esc(node.runId)}" data-parent="${esc(node.parentRunId)}">Cancel</button>` : ''}${node.result ? `<div class="child-result">${esc(node.result)}</div>` : ''}</div>`;
      children(node.runId).forEach(visit);
    };
    roots.sort((a, b) => b.startedAt - a.startedAt).slice(0, 5).forEach(visit);
    html += '</div>';
    mount.innerHTML = html;
    mount.querySelectorAll('[data-select-run]').forEach(button => button.onclick = () => {
      const node = nodes.find(item => item.runId === button.dataset.selectRun);
      if (node) selectInspector(node.parentRunId ? 'agent' : 'run', node);
    });
    mount.querySelectorAll('[data-cancel-child]').forEach(button => button.onclick = async event => {
      event.stopPropagation();
      try { await api.orchCancelChild(button.dataset.parent, button.dataset.cancelChild); toast('Cancel requested', 'ok'); }
      catch (error) { toast(error.message, 'error'); }
    });
  }

  const unsubscribe = subscribeRunView(render);
  render();
  return unsubscribe;
}

function statusIcon(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return '✓';
  if (value === 'failed' || value === 'timeout') return '!';
  if (value === 'cancelled' || value === 'interrupted') return '■';
  return '•';
}
