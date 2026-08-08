'use strict';
/**
 * v2.3.1 — P0-2/P0-3 回归测试：Run 唯一终态状态机。
 *
 * 验证：
 *  - 一个 Run 只能进入一次终态：failed 之后 completed 被忽略（不重复发终态事件）
 *  - cancelled / timeout 之后 completed 同样被忽略
 *  - 终态一旦确定，非终态阶段更新也被忽略
 *  - agent:stop 的 cancelByConversation 只发一次终态
 *  - interruptStale 把非终态 Run 标为 interrupted（不触发旧 Spinner）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { RunManager, isTerminal, TERMINAL } = require('../src/agent/runManager');

function makeManager() {
  const events = [];
  const rm = new RunManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  return { rm, events };
}

function terminalEvents(events) {
  return events.filter(e => e.type === 'run_completed' || e.type === 'run_failed' || e.type === 'run_cancelled' || e.type === 'run_timeout' || e.type === 'run_interrupted').map(e => e.type);
}

test('唯一终态：failed → completed 被忽略（P0-3 核心）', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.finishRun(run.id, 'failed', { error: '业务失败' });
  rm.finishRun(run.id, 'completed', {}); // 非法覆盖，必须被忽略
  const r = rm.getRun(run.id);
  assert.strictEqual(r.status, 'failed', 'failed 后不得变成 completed');
  assert.ok(r.terminalAt, '应有终态时间');
  assert.deepStrictEqual(terminalEvents(events), ['run_failed'], '只能发一次终态事件');
});

test('唯一终态：cancelled → completed 被忽略', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.finishRun(run.id, 'cancelled', {});
  rm.finishRun(run.id, 'completed', {});
  assert.strictEqual(rm.getRun(run.id).status, 'cancelled');
  assert.deepStrictEqual(terminalEvents(events), ['run_cancelled']);
});

test('唯一终态：timeout → completed 被忽略', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.finishRun(run.id, 'timeout', { error: '超时' });
  rm.finishRun(run.id, 'completed', {});
  assert.strictEqual(rm.getRun(run.id).status, 'timeout');
  assert.deepStrictEqual(terminalEvents(events), ['run_timeout']);
});

test('终态后阶段更新也被忽略（completed → streaming 无效）', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.finishRun(run.id, 'completed', {});
  rm.updateRun(run.id, 'streaming', {});
  assert.strictEqual(rm.getRun(run.id).status, 'completed');
  assert.strictEqual(rm.getRun(run.id).stage, 'completed');
});

test('合法迁移：preparing → requesting_model → streaming → executing_tool → completed', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.updateRun(run.id, 'requesting_model', {});
  rm.updateRun(run.id, 'streaming', {});
  rm.updateRun(run.id, 'executing_tool', {});
  rm.finishRun(run.id, 'completed', {});
  assert.strictEqual(rm.getRun(run.id).status, 'completed');
  assert.deepStrictEqual(terminalEvents(events), ['run_completed']);
});

test('非法非终态迁移被忽略（streaming → waiting_subagent 不在合法表）', () => {
  const { rm } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.updateRun(run.id, 'requesting_model', {});
  rm.updateRun(run.id, 'streaming', {});
  rm.updateRun(run.id, 'waiting_subagent', {}); // 非法，应忽略
  assert.strictEqual(rm.getRun(run.id).status, 'streaming');
});

test('cancelByConversation：agent:stop 路径只发一次 cancelled', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  const stopped = rm.cancelByConversation('c1');
  assert.ok(stopped, '应能按对话取消');
  // 再次取消（例如 runtime 也返回 cancelled）——终态已定，忽略
  rm.cancelByConversation('c1');
  assert.strictEqual(rm.getRun(run.id).status, 'cancelled');
  assert.deepStrictEqual(terminalEvents(events), ['run_cancelled']);
});

test('finishRun 只接受终态（非终态 status 被拒绝）', () => {
  const { rm, events } = makeManager();
  const run = rm.createRun({ conversationId: 'c1' });
  rm.finishRun(run.id, 'streaming', {});
  assert.strictEqual(rm.getRun(run.id).status, 'preparing', '非终态不能被 finishRun 接受');
  assert.deepStrictEqual(terminalEvents(events), []);
});

test('interruptStale：启动时非终态 Run → interrupted，且不重复触发', () => {
  const events = [];
  const fakeStore = {
    runs: {
      listNonTerminal: () => [{ id: 'r1', conversationId: 'c9', agentId: null, taskId: null, status: 'streaming', stage: 'streaming', startedAt: Date.now() - 60000 }]
    }
  };
  const rm = new RunManager({ store: fakeStore, emit: (type, payload) => events.push({ type, ...payload }) });
  const n = rm.interruptStale();
  assert.strictEqual(n, 1, '应处理 1 条非终态 Run');
  assert.strictEqual(rm.getRun('r1').status, 'interrupted');
  const term = events.filter(e => e.type === 'run_interrupted').length;
  assert.strictEqual(term, 1);
  // 再次调用（内存已有，不再重复）
  rm.interruptStale();
  assert.strictEqual(events.filter(e => e.type === 'run_interrupted').length, 1);
});

test('isTerminal / TERMINAL 枚举正确', () => {
  for (const s of TERMINAL) assert.strictEqual(isTerminal(s), true, s);
  for (const s of ['preparing', 'requesting_model', 'streaming', 'executing_tool', 'waiting_permission', 'waiting_subagent', 'waiting_external_agent', 'testing', 'bogus']) {
    assert.strictEqual(isTerminal(s), false, s);
  }
});
