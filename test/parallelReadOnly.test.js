'use strict';
/**
 * v2.9.9 体验对标 Phase 2 — 并行只读 Action 测试。
 *
 *  - adapter：一轮 3 个只读 toolCalls → 返回 actions 数组（并发语义）
 *  - adapter：只读+写类混合 → 不并发，回退单 action（写仍单轮单个）
 *  - agentLoop：FakeModel 一次返回 3 个 read_file → executeAction 被并发调用（maxInFlight=3），
 *    toolResults/onToolResult 记录 3 条（任一失败不丢失其它成功结果）
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { runAgentLoop } = require('../src/agent/runtime/agentLoop');
const { createLimits } = require('../src/agent/runtime/retryPolicy');

const rd = (p) => ({ type: 'read_file', args: { path: p } });

test('adapter：3 个只读 toolCalls → actions 数组', async () => {
  const provider = {
    protocol: 'anthropic',
    streamResponse: async () => ({ content: '', toolCalls: [
      { id: '1', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      { id: '2', name: 'read_file', arguments: JSON.stringify({ path: 'b.js' }) },
      { id: '3', name: 'search', arguments: JSON.stringify({ query: 'x' }) }
    ] })
  };
  const adapter = createProviderModelAdapter({ buildProvider: async () => provider, agent: { model: 'm' } });
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.ok(Array.isArray(d.actions) && d.actions.length === 3, '应返回 3 个并发只读 action');
});

test('adapter：只读+写类混合 → 不并发，单 action', async () => {
  const provider = {
    protocol: 'anthropic',
    streamResponse: async () => ({ content: '', toolCalls: [
      { id: '1', name: 'read_file', arguments: JSON.stringify({ path: 'a.js' }) },
      { id: '2', name: 'write_file', arguments: JSON.stringify({ path: 'b.js', content: 'x' }) }
    ] })
  };
  const adapter = createProviderModelAdapter({ buildProvider: async () => provider, agent: { model: 'm' } });
  const d = await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(d.actions, undefined, '含写类不得并发');
  assert.ok(d.action, '回退单 action');
  assert.strictEqual(d.action.type, 'read_file');
});

test('agentLoop：一轮 3 个 read_file 并发执行且结果全保留', async () => {
  let inFlight = 0, maxInFlight = 0, execCount = 0, toolResultCount = 0;
  let call = 0;
  const model = {
    decide: async () => {
      call++;
      if (call === 1) return { actions: [rd('a'), rd('b'), rd('c')], action: rd('a') };
      return { action: { type: 'complete', args: { summary: 'done' } } };
    }
  };
  const getTool = (name) => name === 'read_file' ? {
    name, permission: 'filesystem.read',
    exec: async () => {
      execCount++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return { ok: true, data: { content: 'c', size: 1 } };
    }
  } : null;
  const deps = {
    model, getTool,
    ctx: { projectRoot: '/tmp', projectId: 'p', taskId: 't', abortSignal: null },
    limits: createLimits({ maxIterations: 2 }),
    plan: { tasks: [] },
    blackboard: { goal: 'g', problems: [], completed: [], importantFiles: [], facts: [], confirmed: [], pending: [] },
    emit: () => {}, runManager: { finishRun: () => {} }, runId: 'r',
    setState: () => {}, systemPrompt: '', projectSummary: '',
    onToolResult: () => { toolResultCount++; }
  };
  await runAgentLoop(deps);
  assert.strictEqual(execCount, 3, 'executeAction 应被调用 3 次');
  assert.strictEqual(maxInFlight, 3, '3 个只读应真正并发');
  assert.strictEqual(toolResultCount, 3, 'onToolResult 应记录 3 条');
});

test('agentLoop：并发只读中一个失败不丢失其它结果', async () => {
  let call = 0, toolResultCount = 0;
  const okSet = [];
  const model = {
    decide: async () => {
      call++;
      if (call === 1) return { actions: [rd('good'), rd('bad')], action: rd('good') };
      return { action: { type: 'complete', args: { summary: 'done' } } };
    }
  };
  const getTool = (name) => name === 'read_file' ? {
    name, permission: 'filesystem.read',
    exec: async (ctx, args) => args.path === 'bad'
      ? (() => { throw new Error('boom'); })()
      : { ok: true, data: { content: 'c', size: 1 } }
  } : null;
  const deps = {
    model, getTool,
    ctx: { projectRoot: '/tmp', projectId: 'p', taskId: 't', abortSignal: null },
    limits: createLimits({ maxIterations: 2 }),
    plan: { tasks: [] },
    blackboard: { goal: 'g', problems: [], completed: [], importantFiles: [], facts: [], confirmed: [], pending: [] },
    emit: () => {}, runManager: { finishRun: () => {} }, runId: 'r',
    setState: () => {}, systemPrompt: '', projectSummary: '',
    onToolResult: (a, r) => { toolResultCount++; okSet.push(r.ok); }
  };
  await runAgentLoop(deps);
  assert.strictEqual(toolResultCount, 2, '两条结果都应保留');
  assert.ok(okSet.includes(true) && okSet.includes(false), '一个成功一个失败，互不丢失');
});
