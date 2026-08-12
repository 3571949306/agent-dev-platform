'use strict';
/**
 * v2.9.8 Real Project Reliability — R8.
 *
 * Terminal Audit & Restart Truth（Reliability is observable behavior）:
 *  - 每个终态 run 必须可审计：terminalSource / durationMs / terminalAt / log 链
 *  - 失败 run 必须携带真实错误码与错误信息（无静默失败）
 *  - 冷启动诚实接管：数据库中的非终态 run 标记 interrupted（不假装仍在运行）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMainAgent } = require('../src/agent/runtime/mainAgentRuntime');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');
const { RunManager } = require('../src/agent/runManager');
const { PermissionEngine } = require('../src/security/permissions');
const { getBuiltin } = require('../src/tools/registry');
const { createLimits } = require('../src/agent/runtime/retryPolicy');
const { EVENTS } = require('../src/agent/runtime/runtimeEvents');
const store = require('../src/db/store');

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-audit-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function waitForTerminal(runManager, runId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const run = runManager.getRun(runId);
      if (run && ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) {
        clearInterval(timer); resolve(run); return;
      }
      if (Date.now() > deadline) { clearInterval(timer); resolve(runManager.getRun(runId)); }
    }, 15);
  });
}

function baseDeps(root, extra = {}) {
  const events = [];
  const pe = new PermissionEngine({ projectId: 'rpr-audit' });
  pe.grant('filesystem.read', 'always', { persist: false });
  pe.grant('filesystem.write', 'always', { persist: false });
  pe.grant('terminal.write', 'always', { persist: false });
  return {
    deps: {
      conversationId: 'rpr-audit-' + Math.random().toString(36).slice(2),
      agentId: 'native-main',
      goal: 'audit truth',
      projectRoot: root, projectId: 'rpr-audit',
      getTool: getBuiltin, store: null,
      emit: (type, payload) => { events.push({ type, payload }); },
      runManager: new RunManager(),
      permissionEngine: pe,
      requestPermission: async () => ({ decision: 'deny', range: 'once' }),
      timeoutMs: 20000,
      ...extra
    },
    events
  };
}

test('R8 completed run carries a full terminal audit trail', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps } = baseDeps(root);
    const t0 = Date.now();
    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([{ type: 'complete', args: { summary: 'quick done' } }])
    });
    const terminal = await waitForTerminal(deps.runManager, runId);

    assert.strictEqual(terminal.status, 'completed');
    assert.ok(terminal.terminalSource, 'terminalSource recorded (who settled the run)');
    assert.ok(Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0, 'durationMs recorded');
    assert.ok(terminal.terminalAt >= terminal.startedAt, 'terminalAt coherent');
    assert.ok(Date.now() - t0 < 10000);
    // 状态迁移链完整：preparing → … → completed，且终态条目携带 source
    const log = terminal.log;
    assert.strictEqual(log[0].status, 'preparing');
    assert.strictEqual(log[log.length - 1].status, 'completed');
    assert.ok(log[log.length - 1].source, 'terminal log entry carries its source');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R8 failed run is never silent: error message + RUN_FAILED errorCode are truthful', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps, events } = baseDeps(root, {
      timeoutMs: 60000,
      limits: createLimits({ maxIterations: 2, maxRuntimeMs: 60000 })
    });
    const reads = Array.from({ length: 10 }, () => ({ type: 'read_file', args: { path: 'note.txt' } }));
    const { runId } = runMainAgent({ ...deps, model: createFakeCodingModel(reads) });
    const terminal = await waitForTerminal(deps.runManager, runId);

    assert.strictEqual(terminal.status, 'failed');
    assert.ok(terminal.error && terminal.error.length > 0, 'failed run carries a real error message');
    assert.ok(terminal.terminalSource, 'terminalSource recorded');
    const failedEvent = events.find(e => e.type === EVENTS.RUN_FAILED);
    assert.ok(failedEvent, 'RUN_FAILED event emitted');
    assert.ok(failedEvent.payload.errorCode, 'RUN_FAILED carries an errorCode');
    assert.strictEqual(events.some(e => e.type === EVENTS.RUN_COMPLETED), false, 'no completion event for a failed run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R8 fatal permission denial fails honestly (no silent failure, no fake success)', async () => {
  const root = makeProject({ 'note.txt': 'fixture\n' });
  try {
    const { deps, events } = baseDeps(root);
    // filesystem.delete 保持默认 ask → requestPermission deny → PERMISSION_DENIED → fatal
    const { runId } = runMainAgent({
      ...deps,
      model: createFakeCodingModel([
        { type: 'delete_file', args: { path: 'note.txt' } },
        { type: 'complete', args: { summary: 'should not complete' } }
      ])
    });
    const terminal = await waitForTerminal(deps.runManager, runId);

    assert.strictEqual(terminal.status, 'failed');
    assert.ok(/权限/.test(terminal.error || ''), `permission denial surfaced, got: ${terminal.error}`);
    const failedEvent = events.find(e => e.type === EVENTS.RUN_FAILED);
    assert.ok(failedEvent);
    assert.strictEqual(failedEvent.payload.errorCode, 'FATAL');
    // 用户文件未被删除（权限拒绝发生在执行前）
    assert.ok(fs.existsSync(path.join(root, 'note.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R8 cold-start truth: durable nonterminal runs become interrupted, never resurrected', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-audit-db-'));
  store.init(dataRoot);
  try {
    // 上一次进程生命周期留下的非终态 run
    const oldManager = new RunManager({ store });
    const stale = oldManager.createRun({ conversationId: 'stale-audit-conversation', agentId: 'native-main' });
    oldManager.updateRun(stale.id, 'requesting_model');
    assert.strictEqual(store.runs.get(stale.id).status, 'requesting_model');

    // 冷启动：新的 RunManager 必须诚实标记 interrupted，而不是假装它还在运行
    const newManager = new RunManager({ store });
    const recovered = newManager.interruptStale();
    assert.strictEqual(recovered, 1);

    const record = store.runs.get(stale.id);
    assert.strictEqual(record.status, 'interrupted');
    const after = newManager.getRun(stale.id);
    assert.strictEqual(after.status, 'interrupted');
    assert.ok(after.message, 'interrupted run carries an honest explanation');
    // 终态审计同样存在（interruptStale 落库的对象具备 terminal 信息）
    assert.ok(after.terminalAt || record.updated_at || record.terminalAt, 'terminal timestamp present');

    // 已终态 run 不被重复处理
    const second = new RunManager({ store });
    assert.strictEqual(second.interruptStale(), 0);
  } finally {
    try { store.getDb().close(); } catch { /* best effort */ }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
