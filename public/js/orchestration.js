// v2.9.0 — Unified Main Agent Orchestrator GUI
// Renders the Run Tree (Main Agent → Delegate → Child) and Delegation Cards
// from the backend `run_state_changed` / `delegation.*` event stream.
// Isolated & additive: only acts when #orchestration-list exists; never throws
// on events it does not recognise.

import { api, onEvent } from './api.js';
import { ZH } from './i18n.js';
import { esc, toast } from './util.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'unavailable', 'rejected']);

function statusLabel(s) {
  switch (s) {
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'timeout': return '超时';
    case 'unavailable': return '不可用';
    case 'running': case 'tool': case 'requesting_model': case 'thinking': return '运行中';
    case 'preparing': return '准备中';
    default: return s || '未知';
  }
}

export function initOrchestration() {
  const mount = document.getElementById('orchestration-list');
  if (!mount) return; // 容器不存在时不激活（保持向后兼容）

  const runs = new Map(); // runId -> node

  function upsert(ev) {
    const id = ev.runId;
    if (!id) return;
    const prev = runs.get(id) || {};
    const node = {
      runId: id,
      agentId: ev.agentId || prev.agentId || null,
      adapterId: ev.adapterId || prev.adapterId || null,
      parentRunId: ev.parentRunId != null ? ev.parentRunId : prev.parentRunId || null,
      rootRunId: ev.rootRunId != null ? ev.rootRunId : prev.rootRunId || null,
      depth: ev.depth != null ? ev.depth : prev.depth || 0,
      status: ev.status || prev.status || 'preparing',
      stage: ev.stage || prev.stage || '',
      startedAt: prev.startedAt || ev.timestamp || Date.now(),
      terminalAt: TERMINAL.has(ev.status) ? (ev.timestamp || Date.now()) : prev.terminalAt || null,
      routeReason: prev.routeReason || null,
      goal: prev.goal || null
    };
    runs.set(id, node);
  }

  function onDelegation(ev) {
    if (ev.type === 'delegation.started' && ev.runId) {
      const n = runs.get(ev.runId) || {};
      n.routeReason = ev.routeReason || ev.reason || null;
      n.goal = ev.goal || n.goal;
      n.agentId = n.agentId || ev.agentId;
      n.parentRunId = n.parentRunId != null ? n.parentRunId : ev.parentRunId;
      runs.set(ev.runId, n);
    }
  }

  function agentName(node) {
    if (node.depth === 0) return 'Main Agent';
    return node.adapterId || node.agentId || '子智能体';
  }

  function duration(node) {
    if (!node.startedAt) return '';
    const end = node.terminalAt || Date.now();
    const ms = Math.max(0, end - node.startedAt);
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  function render() {
    // 仅显示当前会话相关（rootRunId 一致）的树；简化：显示所有 depth 0 为根
    const roots = [];
    for (const n of runs.values()) {
      if (!n.parentRunId || !runs.has(n.parentRunId)) roots.push(n);
    }
    roots.sort((a, b) => a.startedAt - b.startedAt);

    if (roots.length === 0) {
      mount.innerHTML = '<div class="orch-empty">暂无编排运行</div>';
      return;
    }

    const childrenOf = (id) => {
      const c = [];
      for (const n of runs.values()) if (n.parentRunId === id) c.push(n);
      c.sort((a, b) => a.startedAt - b.startedAt);
      return c;
    };

    let html = '';
    const renderNode = (node, prefix, isLast) => {
      const connector = prefix === '' ? '' : (isLast ? '└─ ' : '├─ ');
      const cls = node.depth === 0 ? 'orch-root' : 'orch-child';
      html += `<div class="orch-line ${cls}">${esc(prefix + connector)}<b>${esc(agentName(node))}</b> <span class="orch-status">${esc(statusLabel(node.status))}</span></div>`;
      const kids = childrenOf(node.runId);
      const childPrefix = prefix === '' ? '' : prefix + (isLast ? '   ' : '│  ');
      kids.forEach((k, i) => renderNode(k, childPrefix, i === kids.length - 1));
    };
    roots.forEach((r, i) => renderNode(r, '', i === roots.length - 1));

    // Delegation Cards（仅 depth > 0）
    const delegated = [...runs.values()].filter((n) => n.depth > 0 || n.parentRunId);
    if (delegated.length) {
      html += '<div class="orch-cards">';
      for (const n of delegated) {
        const running = !TERMINAL.has(n.status);
        html += `<div class="orch-card">
          <div class="orch-card-row"><span class="orch-k">Agent:</span><span class="orch-v">${esc(agentName(n))}</span></div>
          <div class="orch-card-row"><span class="orch-k">Reason:</span><span class="orch-v">${esc(n.routeReason || n.goal || '—')}</span></div>
          <div class="orch-card-row"><span class="orch-k">Mode:</span><span class="orch-v">${n.routeReason && /read.only/i.test(n.routeReason) ? 'Read-only' : 'Default'}</span></div>
          <div class="orch-card-row"><span class="orch-k">Status:</span><span class="orch-v">${esc(statusLabel(n.status))}</span></div>
          <div class="orch-card-row"><span class="orch-k">Duration:</span><span class="orch-v">${esc(duration(n))}</span></div>
          <div class="orch-card-actions">
            <button class="orch-btn" data-view="${esc(n.runId)}">查看</button>
            <button class="orch-btn danger" data-stop="${esc(n.runId)}" ${running ? '' : 'disabled'}>停止</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }

    mount.innerHTML = html;

    mount.querySelectorAll('[data-view]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-view');
        const n = runs.get(id);
        toast(`Run ${id}\nAgent: ${agentName(n)}\nStatus: ${statusLabel(n.status)}\n${n.routeReason ? 'Reason: ' + n.routeReason : ''}`);
      });
    });
    mount.querySelectorAll('[data-stop]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-stop');
        try { await api.orchCancel(id); toast('已发送停止指令'); }
        catch (e) { toast('停止失败: ' + e.message); }
      });
    });
  }

  onEvent((ev) => {
    try {
      if (!ev || !ev.type) return;
      if (ev.type === 'run_state_changed') { upsert(ev); render(); }
      else if (ev.type.startsWith('delegation.')) { onDelegation(ev); render(); }
    } catch (err) { /* 隔离：不影响其他事件处理 */ }
  });
}
