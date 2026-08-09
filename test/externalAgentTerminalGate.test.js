'use strict';
/**
 * ExternalAgentTerminalGate unit tests（spec §14 / §19 / §23 / §61）。
 *
 * 验证：
 *   - 终态集合 COMPLETED / FAILED / CANCELLED / TIMEOUT
 *   - terminal once：达到终态后，任何晚期转移都被忽略，terminalCount 恒为 1
 *   - 重复终态（completed → failed / cancelled → completed / timeout → completed）都被忽略
 */
const test = require('node:test');
const assert = require('node:assert');
const { createExternalAgentTerminalGate, isTerminalState, TERMINAL_STATES } =
  require('../src/agents/runtime/externalTerminalGate');
const { LIFECYCLE } = require('../src/agents/hub/types');

test('terminal state set includes the four terminal states', () => {
  for (const s of [LIFECYCLE.COMPLETED, LIFECYCLE.FAILED, LIFECYCLE.CANCELLED, LIFECYCLE.TIMEOUT]) {
    assert.strictEqual(isTerminalState(s), true);
  }
  assert.strictEqual(isTerminalState(LIFECYCLE.RUNNING), false);
  assert.strictEqual(isTerminalState(LIFECYCLE.STARTING), false);
  assert.strictEqual(TERMINAL_STATES.size, 4);
});

test('first transition to COMPLETED is accepted and terminal', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  const tr = g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, true);
  assert.strictEqual(tr.terminal, true);
  assert.strictEqual(tr.terminalCount, 1);
  assert.strictEqual(tr.status, LIFECYCLE.COMPLETED);
});

test('late FAILED after COMPLETED is ignored (terminal once)', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  const tr = g.transition('r1', LIFECYCLE.FAILED, 'AGENT_PROTOCOL_ERROR');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.late, true);
  assert.strictEqual(tr.status, LIFECYCLE.COMPLETED);
  assert.strictEqual(tr.terminalCount, 1);
});

test('late COMPLETED after CANCELLED is ignored', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  g.transition('r1', LIFECYCLE.CANCELLED, 'AGENT_CANCELLED');
  const tr = g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.status, LIFECYCLE.CANCELLED);
});

test('late COMPLETED after TIMEOUT is ignored', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  g.transition('r1', LIFECYCLE.TIMEOUT, 'AGENT_TIMEOUT');
  const tr = g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.status, LIFECYCLE.TIMEOUT);
});

test('duplicate terminal of same kind is ignored', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  g.transition('r1', LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR');
  const tr = g.transition('r1', LIFECYCLE.FAILED, 'AGENT_REMOTE_ERROR');
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(tr.terminalCount, 1);
});

test('non-terminal -> terminal -> non-terminal ignored', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1', LIFECYCLE.STARTING);
  g.transition('r1', LIFECYCLE.RUNNING);
  assert.strictEqual(g.isTerminal('r1'), false);
  g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(g.isTerminal('r1'), true);
  const tr = g.transition('r1', LIFECYCLE.RUNNING);
  assert.strictEqual(tr.accepted, false);
  assert.strictEqual(g.getStatus('r1'), LIFECYCLE.COMPLETED);
});

test('unknown runId auto-inits on transition', () => {
  const g = createExternalAgentTerminalGate();
  const tr = g.transition('new', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(tr.accepted, true);
  assert.strictEqual(g.isTerminal('new'), true);
});

test('onTerminal callback fires exactly once', () => {
  let count = 0;
  let last = null;
  const g = createExternalAgentTerminalGate({ onTerminal: (id, st, reason) => { count++; last = { id, st, reason }; } });
  g.init('r1');
  g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  g.transition('r1', LIFECYCLE.FAILED, 'x'); // late
  assert.strictEqual(count, 1);
  assert.strictEqual(last.st, LIFECYCLE.COMPLETED);
  assert.strictEqual(last.reason, 'AGENT_DONE');
});

test('remove clears state', () => {
  const g = createExternalAgentTerminalGate();
  g.init('r1');
  g.transition('r1', LIFECYCLE.COMPLETED, 'AGENT_DONE');
  assert.strictEqual(g.isTerminal('r1'), true);
  g.remove('r1');
  assert.strictEqual(g.getStatus('r1'), null);
});
