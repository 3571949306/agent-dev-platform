'use strict';
/**
 * AgentRouter tests.
 *
 * Verifies the deterministic scoring rules:
 *   - coding task → native/codex high score, workbuddy low
 *   - computer task → workbuddy high, codex doesn't match
 *   - unavailable agent gets penalized (-200)
 *   - disabled agent excluded entirely
 *   - busy agent gets penalty (-30)
 *   - manual override (task.agentId) gives +1000
 *   - delegation path prevents loops (excluded, not -1000 — hard filter)
 *   - results include reasons[] and penalties[]
 *   - results sorted by score descending
 */
const test = require('node:test');
const assert = require('node:assert');

const { createAgentRegistry } = require('../src/agents/hub/agentRegistry');
const { createAgentRouter, SCORES } = require('../src/agents/hub/agentRouter');
const { HEALTH_STATE } = require('../src/agents/hub/types');

function makeAdapter(id, capabilities, opts = {}) {
  return {
    id,
    manifest: { id, displayName: id },
    capabilities,
    transport: opts.transport || 'native',
    disabled: false,
    available: true,
    healthStatus: opts.healthStatus || HEALTH_STATE.HEALTHY,
    maxConcurrency: opts.maxConcurrency != null ? opts.maxConcurrency : 3,
    activeRunCount: opts.activeRunCount || 0
  };
}

function makeRegistry() {
  const r = createAgentRegistry();
  r.register(makeAdapter('native', ['coding', 'filesystem', 'terminal', 'git'], { maxConcurrency: 3 }));
  r.register(makeAdapter('codex', ['coding', 'filesystem', 'terminal', 'git', 'sandbox'], { maxConcurrency: 2 }));
  r.register(makeAdapter('workbuddy', ['coding', 'computer', 'vision'], { maxConcurrency: 1 }));
  return r;
}

test('createAgentRouter: registry 必填', () => {
  assert.throws(() => createAgentRouter({}), /registry 必填/);
});

test('coding 任务: native/codex 高分，workbuddy 低分', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding', 'filesystem', 'terminal'] });
  const byId = Object.fromEntries(res.map(x => [x.agentId, x.score]));
  // native: 3*40 (required) + 20 (healthy) + 10 (health bonus) = 150
  // codex: 3*40 + 20 + 10 = 150
  // workbuddy: 1*40 (coding) + 2*-100 (filesystem, terminal missing) + 20 + 10 = -130
  assert.ok(byId.native > byId.workbuddy, 'native should beat workbuddy');
  assert.ok(byId.codex > byId.workbuddy, 'codex should beat workbuddy');
  assert.ok(byId.workbuddy < 0, 'workbuddy should be negative');
});

test('computer 任务: workbuddy 高分，codex 缺能力', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['computer'] });
  const byId = Object.fromEntries(res.map(x => [x.agentId, x.score]));
  // workbuddy: 40 + 20 + 10 = 70
  // native: -100 + 20 + 10 = -70
  // codex: -100 + 20 + 10 = -70
  assert.ok(byId.workbuddy > byId.native, 'workbuddy should beat native on computer');
  assert.ok(byId.workbuddy > byId.codex, 'workbuddy should beat codex on computer');
});

test('unavailable agent 被扣 -200', () => {
  const r = createAgentRegistry();
  r.register(makeAdapter('native', ['coding'], { healthStatus: HEALTH_STATE.UNAVAILABLE }));
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding'] });
  // -100*0 + 40 (coding matched, only 1 required) ... wait required=['coding'] all matched
  // 40 (matched) -200 (unavailable) = -160
  assert.strictEqual(res[0].score, SCORES.REQUIRED_MATCH + SCORES.UNAVAILABLE_AVAIL);
  assert.ok(res[0].penalties.some(p => p.includes('不可用')));
});

test('disabled agent 完全不进入结果', () => {
  const r = createAgentRegistry();
  const disabled = makeAdapter('disabled-one', ['coding']);
  disabled.disabled = true;
  r.register(disabled);
  r.register(makeAdapter('native', ['coding']));
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding'] });
  const ids = res.map(x => x.agentId);
  assert.ok(!ids.includes('disabled-one'));
});

test('preferences.disabledAgents 中的 agent 被排除', () => {
  const r = createAgentRegistry();
  r.register(makeAdapter('native', ['coding']));
  r.register(makeAdapter('codex', ['coding']));
  const router = createAgentRouter({
    registry: r,
    preferences: { disabledAgents: ['codex'] }
  });
  const res = router.route({ required: ['coding'] });
  const ids = res.map(x => x.agentId);
  assert.ok(!ids.includes('codex'));
  assert.ok(ids.includes('native'));
});

test('busy agent (activeRunCount >= maxConcurrency) 被扣 -30', () => {
  const r = createAgentRegistry();
  r.register(makeAdapter('busy', ['coding'], { maxConcurrency: 1, activeRunCount: 1 }));
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding'] });
  // 40 + 20 (healthy) + 10 (health bonus) - 30 (busy) = 40
  assert.strictEqual(res[0].score, 40);
  assert.ok(res[0].penalties.some(p => p.includes('最大并发')));
});

test('manual override (task.agentId) 加 +1000', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding'], agentId: 'workbuddy' });
  // workbuddy: 40 (coding matched) + 20 + 10 + 1000 = 1070
  assert.strictEqual(res[0].agentId, 'workbuddy');
  assert.ok(res[0].score > 1000);
  assert.ok(res[0].reasons.some(r => r.includes('手动指定')));
});

test('delegation path 中的 agent 不进入结果（防环）', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding'], delegationPath: ['native', 'codex'] });
  const ids = res.map(x => x.agentId);
  assert.ok(!ids.includes('native'));
  assert.ok(!ids.includes('codex'));
  assert.ok(ids.includes('workbuddy'));
});

test('results 包含 reasons[] 和 penalties[]', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding', 'filesystem', 'terminal'], preferred: ['git'] });
  for (const item of res) {
    assert.ok(Array.isArray(item.reasons));
    assert.ok(Array.isArray(item.penalties));
  }
  // workbuddy 应该既有 reason (coding 匹配) 也有 penalty (filesystem/terminal 缺失)
  const wb = res.find(x => x.agentId === 'workbuddy');
  assert.ok(wb.reasons.length > 0);
  assert.ok(wb.penalties.length > 0);
});

test('results 按分数降序排列', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ required: ['coding', 'filesystem', 'terminal'] });
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].score >= res[i].score, `位置 ${i - 1} (${res[i - 1].score}) 应 >= 位置 ${i} (${res[i].score})`);
  }
});

test('preferred agent 加 +50', () => {
  const r = makeRegistry();
  const router = createAgentRouter({
    registry: r,
    preferences: { preferredAgent: 'codex' }
  });
  const res = router.route({ required: ['coding'] });
  const byId = Object.fromEntries(res.map(x => [x.agentId, x.score]));
  // native: 40 + 20 + 10 = 70
  // codex: 40 + 20 + 10 + 50 = 120
  assert.strictEqual(byId.codex, byId.native + SCORES.PREFERRED_AGENT);
});

test('route 空 task 返回所有未禁用 adapter', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({});
  assert.strictEqual(res.length, 3);
});

test('route 不存在 agent 的 task 也能返回所有候选', () => {
  const r = makeRegistry();
  const router = createAgentRouter({ registry: r });
  const res = router.route({ agentId: 'missing' });
  // manual override 仅匹配存在的 agent；不存在的 id 不会给加分
  assert.strictEqual(res.length, 3);
  for (const item of res) {
    assert.ok(item.score < 1000, '不存在的 agent 不应得到 +1000');
  }
});

test('Cline is excluded from auto routing until its full health is healthy', () => {
  const r = createAgentRegistry();
  r.register(makeAdapter('native', ['coding']));
  r.register(makeAdapter('cline', ['coding'], { healthStatus: HEALTH_STATE.DEGRADED }));
  const router = createAgentRouter({ registry: r });
  assert.ok(!router.route({ required: ['coding'] }).some(item => item.agentId === 'cline'));
  assert.ok(router.route({ required: ['coding'], agentId: 'cline' }).some(item => item.agentId === 'cline'));
  r.get('cline').healthStatus = HEALTH_STATE.HEALTHY;
  assert.ok(router.route({ required: ['coding'] }).some(item => item.agentId === 'cline'));
});
