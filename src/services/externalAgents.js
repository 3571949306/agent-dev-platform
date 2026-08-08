'use strict';
/**
 * External Agent adapters — Codex (official HTTP/CLI) and WorkBuddy Desktop Bridge.
 * Both implement the same ExternalAgentAdapter contract: connect/run/result.
 * The WorkBuddy bridge drives the user's already-logged-in desktop app via the
 * Computer runtime (no credential theft, no recursion).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const providers = require('../providers');
// NOTE: do NOT require('../agent/subagent') here — subagent.js requires this
// module, so a top-level require creates a cycle and yields `undefined`
// bindings at load time. External adapters never recurse into sub-agents.

function structured(status, summary, extra = {}) {
  return JSON.stringify({ status, summary: (summary || '').slice(0, 800), findings: [], changedFiles: [], artifacts: [], errors: [], ...extra });
}

async function runCodex(adapter, taskText, store) {
  const cfg = adapter.config || {};
  // Option A: official CLI
  if (cfg.cliPath && fs.existsSync(cfg.cliPath)) {
    return new Promise((resolve) => {
      const child = spawn(cfg.cliPath, ['exec', '--', taskText], { windowsHide: true });
      let out = '', settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => out += d.toString());
      // An unhandled 'error' event on a ChildProcess throws and kills the app.
      child.on('error', e => done(structured('failed', '', { errors: ['Codex CLI 启动失败: ' + e.message] })));
      child.on('close', code => done(structured(code === 0 ? 'completed' : 'failed', out.slice(0, 800), { exitCode: code })));
    });
  }
  // Option B: OpenAI-compatible model (e.g. codex-mini via Responses/Chat)
  if (cfg.connectionId) {
    const conn = store.connections.getDecrypted(cfg.connectionId);
    if (!conn) return structured('failed', '', { errors: ['Codex 未配置 API 连接'] });
    const provider = providers.getProvider(conn);
    let text = '';
    const r = await provider.streamResponse({
      system: 'You are Codex, an autonomous coding agent. Complete the task by producing the necessary code/changes. Reply concisely with the result.',
      messages: [{ role: 'user', content: taskText }], tools: undefined, onChunk: () => {}
    });
    text = r.content || '';
    return structured('completed', text);
  }
  return structured('failed', '', { errors: ['Codex 适配器未配置 CLI 路径或 API 连接'] });
}

async function runWorkBuddyBridge(adapter, taskText, computerManager) {
  // Desktop Agent Bridge — drive the user's logged-in WorkBuddy app.
  const wins = await computerManager.listWindows();
  const list = (wins.windows || []).filter(w => /workbuddy/i.test((w.title || '') + ' ' + (w.name || '')));
  if (!list.length) {
    return structured('failed', '', { errors: ['未找到 WorkBuddy 窗口，请先打开 WorkBuddy 桌面应用'] });
  }
  const title = list[0].title;
  await computerManager.focusWindow(title);
  // type the task and send (Enter ~ in SendKeys)
  const safe = String(taskText).replace(/[+^%(){}\[\]]/g, '');
  await computerManager.pressKeys(safe + '~');
  await new Promise(r => setTimeout(r, 3000));
  const shot = await computerManager.screenshot();
  return structured('completed', '已通过桌面桥接将任务发送给 WorkBuddy（窗口：' + title + '），请在工作台查看结果。', {
    screenshot: shot.ok ? shot.data_url : null
  });
}

async function runHttpAgent(adapter, taskText) {
  const cfg = adapter.config || {};
  try {
    const resp = await fetch(cfg.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: taskText, ...(cfg.payload || {}) })
    });
    const txt = await resp.text();
    return structured(resp.ok ? 'completed' : 'failed', txt.slice(0, 800));
  } catch (e) {
    return structured('failed', '', { errors: [e.message] });
  }
}

/**
 * @param adapter external agent record (type='external')
 * @param taskText the task string
 * @param ctx { store, computerManager }
 */
async function runExternalAgent(adapter, taskText, ctx) {
  switch (adapter.adapter_type) {
    case 'codex': return runCodex(adapter, taskText, ctx.store);
    case 'workbuddy': return runWorkBuddyBridge(adapter, taskText, ctx.computerManager);
    case 'http': return runHttpAgent(adapter, taskText);
    default: return structured('failed', '', { errors: ['未知外部 Agent 类型：' + adapter.adapter_type] });
  }
}

module.exports = { runExternalAgent, runCodex, runWorkBuddyBridge };
