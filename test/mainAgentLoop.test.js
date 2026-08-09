'use strict';
/**
 * v2.6.0 — Main Agent Loop 集成测试（spec §34/§35/§36/§37）。
 *
 * 这是整个 v2.6.0 最核心集成测试。在 coding-agent fixture 临时副本上真实运行
 * Main Agent Loop + FakeCodingModel，验证完整闭环：
 *   读取代码 → 运行测试（FAIL）→ patch → 运行测试（PASS）→ 完成
 *
 * 覆盖 spec §33：简单任务完成 / tool failure / repair loop / max iterations /
 * cancel / timeout / invalid action / completion policy。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { runAgentLoop } = require('../src/agent/runtime/agentLoop');
const { createFakeCodingModel, buildFixAddScript, buildRepairLoopScript, buildPrematureCompleteScript, buildHangScript } = require('../src/agent/runtime/fakeCodingModel');
const { createLimits } = require('../src/agent/runtime/retryPolicy');
const { createPlan } = require('../src/agent/runtime/taskPlanner');
const { createBlackboard } = require('../src/agent/runtime/blackboard');
const { buildSystemPrompt } = require('../src/agent/runtime/prompts/mainCodingAgent');
const { copyFixture, cleanup, resetToBroken, BROKEN_MATH } = require('./fixtures/coding-agent/reset');
const registry = require('../src/tools/registry');

function getTool(name) {
  const b = registry.getBuiltin(name);
  if (!b) return null;
  return { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' };
}

// 轻量 mock RunManager：只记录终态，一个 runId 最多一个 terminal event
function mockRunManager() {
  const runs = new Map();
  return {
    runs,
    createRun({ conversationId }) { const id = 'run-' + Math.random().toString(36).slice(2, 8); runs.set(id, { id, conversationId, status: 'preparing' }); return runs.get(id); },
    updateRun(id, status) { const r = runs.get(id); if (r && !['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(r.status)) r.status = status; return r; },
    finishRun(id, status, extra) { const r = runs.get(id); if (r && !['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(r.status)) { r.status = status; r.terminal = true; Object.assign(r, extra || {}); } return r; },
    cancelByConversation() { return null; }
  };
}

function makeDeps(root, script, opts = {}) {
  const rm = mockRunManager();
  const run = rm.createRun({ conversationId: 'conv-test' });
  const ac = new AbortController();
  const ctx = {
    projectRoot: root, projectId: 'proj-test', taskId: 'task-test', agentId: 'agent-test', agentName: 'Main Agent',
    conversationId: 'conv-test', store: null, emit: () => {}, abortSignal: ac.signal
  };
  const model = createFakeCodingModel(script, { name: 'FakeCoding' });
  const plan = createPlan(opts.goal || '修复 add 函数并确保测试通过');
  const blackboard = createBlackboard(opts.goal || '修复 add 函数并确保测试通过');
  const limits = createLimits(opts.limits || { maxRuntimeMs: 30000, maxIterations: 20, maxRepairRounds: 5 });
  const events = [];
  const emit = (type, payload) => events.push({ type, ...payload });
  let currentState = 'IDLE';
  const statesMod = require('../src/agent/runtime/states');
  const setState = (next) => { if (statesMod.canTransition(currentState, next)) currentState = next; };
  return {
    deps: {
      model, getTool, ctx, limits, plan, blackboard, emit, runManager: rm, runId: run.id, setState,
      systemPrompt: buildSystemPrompt({ projectRoot: root }),
      projectSummary: '', requestPermission: null, onToolResult: null,
      verification: opts.verification || [], requiredFiles: opts.requiredFiles || []
    },
    rm, run, ac, ctx, events, model
  };
}

test('§37 主路径：读取 → 测试 FAIL → patch → 测试 PASS → completed', async () => {
  const root = await copyFixture();
  try {
    const { deps, rm, events } = makeDeps(root, buildFixAddScript());
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'completed', `应 completed，实际 ${result.status} ${result.error || ''}`);
    // 文件确实被修复
    const after = await fsp.readFile(path.join(root, 'src', 'math.js'), 'utf8');
    assert.ok(after.includes('return a + b'), 'add 函数应被修复为 a + b');
    // subtract 合法使用 `return a - b`，只检查 add 函数体不再返回 a - b。
    const addBody = after.match(/function add[\s\S]*?\}/)[0];
    assert.ok(!addBody.includes('return a - b'), 'add 不应再返回 a - b');
    // 修改文件记录
    assert.ok(result.changedFiles && result.changedFiles.includes('src/math.js'));
    // 测试最终 PASS
    assert.ok(result.tests && result.tests.some(t => t.passed));
    // timeline 事件：应包含 test-fail 和 test-pass
    const timelines = events.filter(e => e.type === 'mainAgent:timeline');
    const kinds = timelines.map(e => e.entry.kind);
    assert.ok(kinds.includes('test-fail'), '应有测试失败 timeline');
    assert.ok(kinds.includes('test-pass'), '应有测试通过 timeline');
    assert.ok(kinds.includes('complete'), '应有完成 timeline');
  } finally { await cleanup(root); }
});

test('§28 Repair Loop：第一次 patch 仍失败 → 第二次 patch 成功', async () => {
  const root = await copyFixture();
  try {
    const { deps, events } = makeDeps(root, buildRepairLoopScript());
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'completed');
    const after = await fsp.readFile(path.join(root, 'src', 'math.js'), 'utf8');
    assert.ok(after.includes('return a + b'));
    // repair rounds >= 1
    const repairs = events.filter(e => e.type === 'mainAgent:repairStart');
    assert.ok(repairs.length >= 1, '应至少有一次 repair');
  } finally { await cleanup(root); }
});

test('§30 Required Verification Fail：模型 complete 但 npm test 失败 → 不得 completed', async () => {
  const root = await copyFixture();
  try {
    // 模型改了一个错误版本（除法）然后 complete，但 verification 要求 npm test PASS
    const { deps, events } = makeDeps(root, buildPrematureCompleteScript(), {
      verification: [{ type: 'command', command: 'npm test', required: true }]
    });
    const result = await runAgentLoop(deps);
    // 模型 premature complete 后，verification 会运行 npm test → 失败 → 不得 completed
    // 应该是 failed 或 continued repair（这里脚本耗尽 → 最终 failed/limit）
    assert.notStrictEqual(result.status, 'completed', '测试失败时不得 completed');
    // 应有 repair 触发（完成策略未满足）
    const repairs = events.filter(e => e.type === 'mainAgent:repairStart');
    assert.ok(repairs.length >= 1, '完成策略未满足应触发 repair');
  } finally { await cleanup(root); }
});

test('cancel：abortSignal 中止 → cancelled', async () => {
  const root = await copyFixture();
  try {
    const { deps, ac } = makeDeps(root, buildHangScript(), { limits: { maxRuntimeMs: 60000, maxIterations: 5 } });
    // 异步触发 abort
    setTimeout(() => ac.abort(), 300);
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'cancelled');
  } finally { await cleanup(root); }
});

test('maxIterations：脚本循环不退出 → AGENT_LOOP_LIMIT', async () => {
  const root = await copyFixture();
  try {
    // 一个永远 read_file 的脚本（不 complete）
    const loopScript = [
      { type: 'read_file', args: { path: 'src/math.js' } },
      { type: 'read_file', args: { path: 'src/math.js' } },
      { type: 'read_file', args: { path: 'src/math.js' } },
      { type: 'read_file', args: { path: 'src/math.js' } },
      { type: 'read_file', args: { path: 'src/math.js' } }
    ];
    const { deps } = makeDeps(root, loopScript, { limits: { maxRuntimeMs: 30000, maxIterations: 3, maxRepairRounds: 5 } });
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.errorCode, 'AGENT_LOOP_LIMIT');
  } finally { await cleanup(root); }
});

test('invalid action：连续无效响应 → AGENT_RESPONSE_INVALID', async () => {
  const root = await copyFixture();
  try {
    // decideFn 返回非 JSON 文本，触发 parseAndValidate 失败
    const badModel = { decide: async () => ({ text: 'totally not json' }) };
    const { deps } = makeDeps(root, []);
    deps.model = badModel;
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.errorCode, 'AGENT_RESPONSE_INVALID');
  } finally { await cleanup(root); }
});

test('tool failure（read 不存在的文件）→ 不致命，继续 loop', async () => {
  const root = await copyFixture();
  try {
    const script = [
      { type: 'read_file', args: { path: 'nonexistent.js' }, thought: '读取不存在的文件' },
      { type: 'run_tests', args: { command: 'npm test' }, thought: '测试' },
      { type: 'patch_file', args: { path: 'src/math.js', patch: '@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a - b;\n+  return a + b;\n }' }, thought: '修复' },
      { type: 'run_tests', args: { command: 'npm test' }, thought: '再测' },
      { type: 'complete', args: { summary: '完成' } }
    ];
    const { deps } = makeDeps(root, script);
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'completed');
  } finally { await cleanup(root); }
});

test('路径逃逸 action → 致命失败（不假装完成）', async () => {
  const root = await copyFixture();
  try {
    const script = [
      { type: 'read_file', args: { path: '../../secret.txt' }, thought: '尝试逃逸' },
      { type: 'complete', args: { summary: '完成' } }
    ];
    const { deps } = makeDeps(root, script);
    const result = await runAgentLoop(deps);
    assert.notStrictEqual(result.status, 'completed');
    // 应该 failed（路径逃逸致命）
    assert.strictEqual(result.status, 'failed');
  } finally { await cleanup(root); }
});

test('blackboard 在 loop 中更新（latestTestStatus）', async () => {
  const root = await copyFixture();
  try {
    const { deps, deps: { blackboard } } = makeDeps(root, buildFixAddScript());
    await runAgentLoop(deps);
    // 测试至少运行过一次，blackboard.latestTestStatus 应有值
    assert.ok(blackboard.latestTestStatus, 'blackboard 应记录 latestTestStatus');
    assert.strictEqual(blackboard.latestTestStatus.passed, true);
  } finally { await cleanup(root); }
});

test('RunManager terminal gate：一个 runId 最多一个 terminal event', async () => {
  const root = await copyFixture();
  try {
    const { deps, rm, run } = makeDeps(root, buildFixAddScript());
    const result = await runAgentLoop(deps);
    assert.strictEqual(result.status, 'completed');
    // loop 已 finishRun(completed)；再尝试 finishRun(failed) 应被忽略
    rm.finishRun(run.id, 'failed', { source: 'late' });
    assert.strictEqual(rm.runs.get(run.id).status, 'completed', 'Late Result 不得覆盖终态');
  } finally { await cleanup(root); }
});

test('checkpoint：修改文件前建立 checkpoint', async () => {
  const root = await copyFixture();
  try {
    const { deps, events } = makeDeps(root, buildFixAddScript());
    await runAgentLoop(deps);
    const cps = events.filter(e => e.type === 'mainAgent:checkpoint');
    // fixture 非 git 项目 → manifest checkpoint
    assert.ok(cps.length >= 1, '应建立 checkpoint');
  } finally { await cleanup(root); }
});

test('requiredFiles 未修改 → 不得 completed', async () => {
  const root = await copyFixture();
  try {
    // 脚本修复了 math.js，但 requiredFiles 要求修改 other.js
    const { deps } = makeDeps(root, buildFixAddScript(), { requiredFiles: ['src/other.js'] });
    const result = await runAgentLoop(deps);
    assert.notStrictEqual(result.status, 'completed', 'required 文件未修改不得 completed');
  } finally { await cleanup(root); }
});
