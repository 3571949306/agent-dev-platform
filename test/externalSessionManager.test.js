'use strict';
/**
 * v2.8.0 — test/externalSessionManager.test.js（spec §39/§40/§107/§109/§110/§111）。
 *
 * 关键约束：
 *   - Session ≠ Run：一个 Session 可挂多个 Run（linkRun），sessionId 与 runId 不得硬绑定
 *   - persistence 钩子（upsert/remove）异常不得影响 Run
 *   - toPersistable 只输出可落库字段，绝不写凭据
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  createExternalAgentSessionManager,
  createDbSessionPersistence
} = require('../src/agents/session/externalAgentSessionManager');

test('create：生成独立记录 id，sessionId 与 runId 不硬绑定', () => {
  const mgr = createExternalAgentSessionManager();
  const rec = mgr.create({
    agentId: 'fake-acp',
    externalSessionId: 'sess-1',
    parentRunId: 'run-1',
    transport: 'acp',
    resumable: true
  });
  assert.ok(rec.id && rec.id !== 'sess-1' && rec.id !== 'run-1', 'record.id 独立于 sessionId / runId');
  assert.strictEqual(rec.agentId, 'fake-acp');
  assert.strictEqual(rec.transport, 'acp');
  assert.strictEqual(rec.resumable, true);
  assert.strictEqual(rec.lastStatus, 'created');
});

test('Session ≠ Run：同一个 Session 可承载多个 Run（spec §109）', () => {
  const mgr = createExternalAgentSessionManager();
  mgr.create({ agentId: 'a', externalSessionId: 's-1', parentRunId: 'run-1' });
  mgr.linkRun('run-2', 'a', 's-1');

  const r1 = mgr.getByRun('run-1');
  const r2 = mgr.getByRun('run-2');
  assert.ok(r1 && r2);
  assert.strictEqual(r1.id, r2.id, '两个 Run 指向同一个 Session 记录');
  assert.strictEqual(mgr.list().length, 1, '仍然只有一条 Session');
  assert.strictEqual(mgr.getByExternal('a', 's-1').id, r1.id);
});

test('setStatus / touch 更新状态与时间并触发持久化', () => {
  const upserts = [];
  const mgr = createExternalAgentSessionManager({ persistence: { upsert: (r) => upserts.push(r) } });
  mgr.create({ agentId: 'a', externalSessionId: 's-1', parentRunId: 'run-1' });
  const before = upserts.length;

  mgr.setStatus('run-1', 'running');
  assert.strictEqual(mgr.getByRun('run-1').lastStatus, 'running');
  mgr.touch('run-1');
  assert.ok(upserts.length > before, 'setStatus/touch 都会写 persistence');
});

test('deleteByRun：内存移除 + persistence.remove；未知 run 返回 false', () => {
  const removed = [];
  const mgr = createExternalAgentSessionManager({
    persistence: { upsert: () => {}, remove: (id) => removed.push(id) }
  });
  const rec = mgr.create({ agentId: 'a', externalSessionId: 's-1', parentRunId: 'run-1' });

  assert.strictEqual(mgr.deleteByRun('run-1'), true);
  assert.strictEqual(mgr.getByExternal('a', 's-1'), null);
  assert.deepStrictEqual(removed, [rec.id]);
  assert.strictEqual(mgr.deleteByRun('run-nope'), false);
});

test('persistence 抛错不得影响 Run（DB 只是展示层）', () => {
  const mgr = createExternalAgentSessionManager({
    persistence: {
      upsert: () => { throw new Error('DB down'); },
      remove: () => { throw new Error('DB down'); }
    }
  });
  const rec = mgr.create({ agentId: 'a', externalSessionId: 's-1', parentRunId: 'run-1' });
  mgr.setStatus('run-1', 'running');
  mgr.touch('run-1');
  assert.strictEqual(mgr.deleteByRun('run-1'), true);
  assert.ok(rec.id, '全程无异常冒泡，Run 路径不受影响');
});

test('toPersistable：snake_case 落库形状，不含凭据字段', () => {
  const mgr = createExternalAgentSessionManager();
  const rec = mgr.create({
    agentId: 'codex',
    externalSessionId: 's-9',
    projectId: 'p-1',
    projectRoot: 'C:/proj',
    parentRunId: 'run-9',
    transport: 'native',
    resumable: false
  });
  const p = mgr.toPersistable(rec);
  assert.strictEqual(p.agent_id, 'codex');
  assert.strictEqual(p.external_session_id, 's-9');
  assert.strictEqual(p.transport, 'native');
  assert.strictEqual(p.resumable, false);
  assert.strictEqual(typeof p.metadata_json, 'string');
  const dump = Object.keys(p).join(',');
  for (const bad of ['token', 'cookie', 'secret', 'credential', 'password']) {
    assert.ok(!dump.includes(bad), `落库字段不得出现 ${bad}`);
  }
  assert.strictEqual(mgr.toPersistable(null), null);
});

test('createDbSessionPersistence：非法 repo 返回 null（保持纯内存）', () => {
  assert.strictEqual(createDbSessionPersistence(null), null);
  assert.strictEqual(createDbSessionPersistence({}), null);
  const repo = { upsert: () => {}, remove: () => {} };
  const backend = createDbSessionPersistence(repo);
  assert.ok(backend && typeof backend.upsert === 'function' && typeof backend.remove === 'function');
});
