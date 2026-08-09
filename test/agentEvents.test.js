'use strict';
/**
 * EventNormalizer tests.
 *
 * Verifies normalization of native / CLI / desktop / HTTP raw events into
 * unified AgentEvent, secret stripping, and emit pass-through.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createEventNormalizer, stripSecrets, SECRET_KEY_PATTERN } = require('../src/agents/hub/eventNormalizer');
const { TRANSPORT, AGENT_EVENT } = require('../src/agents/hub/types');

test('normalize: native mainAgent:stateChanged → agent.run.status', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'mainAgent:stateChanged', data: { state: 'running' } },
    TRANSPORT.NATIVE,
    'run-1',
    'native-main'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_STATUS);
  assert.strictEqual(evt.runId, 'run-1');
  assert.strictEqual(evt.agentId, 'native-main');
  assert.strictEqual(evt.rawType, 'mainAgent:stateChanged');
  assert.deepStrictEqual(evt.data, { state: 'running' });
});

test('normalize: native mainAgent:runStarted → agent.run.started', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'mainAgent:runStarted', data: {} },
    TRANSPORT.NATIVE,
    'run-1', 'native-main'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_STARTED);
});

test('normalize: native mainAgent:runCompleted → agent.run.completed', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'mainAgent:runCompleted', data: { result: 'done' } },
    TRANSPORT.NATIVE,
    'run-1', 'native-main'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_COMPLETED);
});

test('normalize: CLI stdout → agent.message', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'stdout', data: 'line of output' },
    TRANSPORT.CLI,
    'run-2', 'codex'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(evt.agentId, 'codex');
  assert.strictEqual(evt.data, 'line of output');
});

test('normalize: CLI string event 视为 stdout', () => {
  const en = createEventNormalizer();
  const evt = en.normalize('hello world', TRANSPORT.CLI, 'run-2', 'codex');
  assert.strictEqual(evt.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(evt.data, 'hello world');
  assert.strictEqual(evt.rawType, 'stdout');
});

test('normalize: CLI exit → agent.run.completed', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'exit', data: 0 }, TRANSPORT.CLI, 'r', 'codex');
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_COMPLETED);
});

test('normalize: CLI error → agent.run.failed', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'error', data: 'boom' }, TRANSPORT.CLI, 'r', 'codex');
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_FAILED);
});

test('normalize: desktop state → agent.run.status', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'state', data: { state: 'completed' } },
    TRANSPORT.DESKTOP,
    'run-3', 'workbuddy'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_STATUS);
});

test('normalize: desktop completed → agent.run.completed', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'completed' }, TRANSPORT.DESKTOP, 'r', 'workbuddy');
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_COMPLETED);
});

test('normalize: HTTP response → agent.message', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    { type: 'response', data: { chunk: 'partial' } },
    TRANSPORT.HTTP,
    'run-4', 'opencode'
  );
  assert.strictEqual(evt.type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(evt.agentId, 'opencode');
});

test('normalize: HTTP timeout → agent.run.timeout', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'timeout' }, TRANSPORT.HTTP, 'r', 'opencode');
  assert.strictEqual(evt.type, AGENT_EVENT.RUN_TIMEOUT);
});

test('normalize: 未知 type 默认归到 agent.message', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'unknown-evt', data: 'x' }, TRANSPORT.NATIVE, 'r', 'a');
  assert.strictEqual(evt.type, AGENT_EVENT.MESSAGE);
});

test('normalize: rawType 与 rawMetadata 保留', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    {
      type: 'mainAgent:stateChanged',
      data: { state: 'running' },
      metadata: { source: 'runtime', ts: 123 }
    },
    TRANSPORT.NATIVE,
    'r', 'a'
  );
  assert.strictEqual(evt.rawType, 'mainAgent:stateChanged');
  assert.deepStrictEqual(evt.rawMetadata, { source: 'runtime', ts: 123 });
});

test('normalize: rawMetadata 默认为空对象', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'stdout', data: 'x' }, TRANSPORT.CLI, 'r', 'a');
  assert.deepStrictEqual(evt.rawMetadata, {});
});

test('normalize: data 缺省回退到 payload 或整个 raw', () => {
  const en = createEventNormalizer();
  const e1 = en.normalize({ type: 'stdout', payload: 'p' }, TRANSPORT.CLI, 'r', 'a');
  assert.strictEqual(e1.data, 'p');
  const e2 = en.normalize({ type: 'stdout' }, TRANSPORT.CLI, 'r', 'a');
  assert.ok(e2.data && typeof e2.data === 'object');
});

test('normalize: 包含 timestamp', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'stdout', data: 'x', timestamp: 999 }, TRANSPORT.CLI, 'r', 'a');
  assert.strictEqual(evt.timestamp, 999);
  const evt2 = en.normalize({ type: 'stdout', data: 'x' }, TRANSPORT.CLI, 'r', 'a');
  assert.ok(typeof evt2.timestamp === 'number');
});

test('stripSecrets: 移除 token/key/auth/secret/password/bearer/session 字段', () => {
  const input = {
    name: 'agent',
    token: 'abc',
    apiKey: 'xxx',
    authHeader: 'Bearer y',
    secretData: 's',
    password: 'p',
    bearerToken: 'b',
    sessionId: 's1',
    safe: 'keep'
  };
  const out = stripSecrets(input);
  assert.strictEqual(out.safe, 'keep');
  assert.strictEqual(out.name, 'agent');
  for (const k of Object.keys(input)) {
    if (k === 'name' || k === 'safe') continue;
    assert.ok(!(k in out), `敏感字段 ${k} 应被移除`);
  }
});

test('stripSecrets: 不修改原对象', () => {
  const input = { token: 'abc', safe: 'keep' };
  const out = stripSecrets(input);
  assert.ok('token' in input, '原对象不应被修改');
  assert.strictEqual(out.safe, 'keep');
  assert.ok(!('token' in out));
});

test('stripSecrets: 非对象返回原值', () => {
  assert.strictEqual(stripSecrets(null), null);
  assert.strictEqual(stripSecrets(undefined), undefined);
  assert.strictEqual(stripSecrets('string'), 'string');
  assert.deepStrictEqual(stripSecrets([1, 2]), [1, 2]);
});

test('SECRET_KEY_PATTERN: 匹配所有敏感关键字（不区分大小写）', () => {
  for (const k of ['token', 'Token', 'TOKEN', 'apiKey', 'auth', 'secret', 'password', 'bearer', 'session']) {
    assert.ok(SECRET_KEY_PATTERN.test(k), `应匹配 ${k}`);
  }
  assert.ok(!SECRET_KEY_PATTERN.test('name'));
  assert.ok(!SECRET_KEY_PATTERN.test('safe'));
});

test('normalize: 自动剥离 rawMetadata 中的敏感字段', () => {
  const en = createEventNormalizer();
  const evt = en.normalize(
    {
      type: 'mainAgent:stateChanged',
      data: {},
      metadata: { token: 'leak', safe: 'ok', apiKey: 'leak' }
    },
    TRANSPORT.NATIVE,
    'r', 'a'
  );
  assert.strictEqual(evt.rawMetadata.safe, 'ok');
  assert.ok(!('token' in evt.rawMetadata));
  assert.ok(!('apiKey' in evt.rawMetadata));
});

test('emit: 通过注入的 emit 函数发射事件', () => {
  const emitted = [];
  const en = createEventNormalizer({ emit: (type, payload) => emitted.push({ type, payload }) });
  const evt = en.normalize({ type: 'stdout', data: 'hi' }, TRANSPORT.CLI, 'r', 'a');
  en.emit(evt);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].type, AGENT_EVENT.MESSAGE);
  assert.strictEqual(emitted[0].payload, evt);
});

test('emit: 没有 emit 函数时不抛错', () => {
  const en = createEventNormalizer();
  const evt = en.normalize({ type: 'stdout', data: 'hi' }, TRANSPORT.CLI, 'r', 'a');
  assert.doesNotThrow(() => en.emit(evt));
  assert.doesNotThrow(() => en.emit(null));
});

test('emit: emit 函数抛错被吞掉', () => {
  const en = createEventNormalizer({ emit: () => { throw new Error('boom'); } });
  const evt = en.normalize({ type: 'stdout', data: 'hi' }, TRANSPORT.CLI, 'r', 'a');
  assert.doesNotThrow(() => en.emit(evt));
});
