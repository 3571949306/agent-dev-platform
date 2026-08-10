'use strict';
/**
 * v2.8.0 — test/cliProcessSupervisor.test.js（spec §26/§27/§28）。
 *
 * 通用 CLI 进程监督器。单测通过 spawnImpl / killTreeImpl / resolveImpl 注入
 * 假子进程（EventEmitter），不需要真实进程。核心语义：
 *   - spawnProcess 在 spawn 成功后立即返回 handle（不等退出，长驻协议服务不阻塞）
 *   - handle.done 永不 reject，退出结果（含错误）在 result 里
 *   - timeout → timedOut 打标 + killTree；abort → aborted 打标
 *   - env 白名单 + 显式注入，绝不整体复制 process.env
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const {
  createCliProcessSupervisor,
  buildEnvAllowlist,
  ENV_ALLOWLIST
} = require('../src/agents/runtime/cliProcessSupervisor');

/** 假子进程：stdout/stderr 是 EventEmitter，可手动 close/error/发数据。 */
function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeSupervisor() {
  const spawns = [];
  const kills = [];
  let nextChild = null;
  const sup = createCliProcessSupervisor({
    spawnImpl: (cmd, args, o) => {
      const child = nextChild || makeFakeChild();
      spawns.push({ cmd, args, o, child });
      return child;
    },
    killTreeImpl: (child, sig) => kills.push({ child, sig }),
    resolveImpl: async (cmd) => (cmd === 'codex' ? 'C:/bin/codex.exe' : null)
  });
  return { sup, spawns, kills, setNextChild: c => { nextChild = c; } };
}

test('spawnProcess：spawn 后立即返回 handle（此时进程尚未退出）', async () => {
  const { sup, spawns, setNextChild } = makeSupervisor();
  const child = makeFakeChild();
  setNextChild(child);
  const p = sup.spawnProcess({ command: 'codex', args: ['--version'], timeoutMs: 0 });
  // 还没喂 close 事件，handle 就必须已经可用 —— 长驻服务靠这一点避免死锁
  const handle = await p;
  assert.strictEqual(handle.pid, 4242);
  assert.strictEqual(handle.exited, false);
  assert.strictEqual(spawns.length, 1);

  child.emit('close', 0, null);
  const result = await handle.done;
  assert.strictEqual(result.code, 0);
  assert.strictEqual(handle.exited, true);
});

test('done 永不 reject：spawn error / 非零退出都以 result 形式给出', async () => {
  const { sup, setNextChild } = makeSupervisor();
  setNextChild(makeFakeChild(1));
  const h1 = await sup.spawnProcess({ command: 'x', timeoutMs: 0 });
  h1.child.emit('error', new Error('ENOENT no such file'));
  const r1 = await h1.done; // 不 reject
  assert.strictEqual(r1.code, null);
  assert.ok(String(r1.error).includes('ENOENT'));

  setNextChild(makeFakeChild(2));
  const h2 = await sup.spawnProcess({ command: 'x', timeoutMs: 0 });
  h2.child.emit('close', 3, null);
  const r2 = await h2.done;
  assert.strictEqual(r2.code, 3, '非零退出是正常事件，不是异常');
});

test('timeout：timedOut 打标 + killTree(SIGKILL)，绝不混淆为 cancel', async () => {
  const { sup, kills, setNextChild } = makeSupervisor();
  const child = makeFakeChild();
  setNextChild(child);
  // 内部超时定时器是 unref 的，另加 ref'd 定时保持事件循环存活
  const keepAlive = new Promise(r => setTimeout(r, 200));
  const handle = await sup.spawnProcess({ command: 'x', timeoutMs: 50 });
  const result = await handle.done;
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(handle.timedOut, true);
  assert.strictEqual(kills.length, 1);
  assert.strictEqual(kills[0].sig, 'SIGKILL');
  await keepAlive;
});

test('AbortSignal：abort 后 killTree 并把 done 标记 aborted', async () => {
  const { sup, kills, setNextChild } = makeSupervisor();
  setNextChild(makeFakeChild());
  const ac = new AbortController();
  const handle = await sup.spawnProcess({ command: 'x', timeoutMs: 0, signal: ac.signal });
  ac.abort();
  const result = await handle.done;
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(kills.length, 1);
});

test('stdout/stderr 捕获 + outputCapBytes 上限', async () => {
  const { sup, setNextChild } = makeSupervisor();
  const child = makeFakeChild();
  setNextChild(child);
  const handle = await sup.spawnProcess({ command: 'x', timeoutMs: 0, outputCapBytes: 10 });
  child.stdout.emit('data', Buffer.from('12345'));
  child.stdout.emit('data', Buffer.from('67890'));
  child.stdout.emit('data', Buffer.from('这行不该进来'));
  child.stderr.emit('data', Buffer.from('e'));
  child.emit('close', 0, null);
  const result = await handle.done;
  assert.strictEqual(result.stdout, '1234567890', '超过 cap 的数据必须丢弃');
  assert.strictEqual(result.stderr, '');
});

test('captureOutput=false：不累积 stdout，但 stderr 仍保留（诊断用）', async () => {
  const { sup, setNextChild } = makeSupervisor();
  const child = makeFakeChild();
  setNextChild(child);
  const handle = await sup.spawnProcess({ command: 'x', timeoutMs: 0, captureOutput: false });
  child.stdout.emit('data', Buffer.from('ignored'));
  child.stderr.emit('data', Buffer.from('diag'));
  child.emit('close', 0, null);
  const result = await handle.done;
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, 'diag');
});

test('detect：PATH 名走 resolveImpl；路径形态走 fs 存在性检查', async () => {
  const { sup } = makeSupervisor();
  const via = await sup.detect('codex');
  assert.strictEqual(via.available, true);
  assert.strictEqual(via.path, 'C:/bin/codex.exe');

  const missing = await sup.detect('C:/definitely/not/here.exe');
  assert.strictEqual(missing.available, false);

  const empty = await sup.detect('');
  assert.strictEqual(empty.available, false);
});

test('buildEnvAllowlist：只放行白名单 + 显式注入，绝不整体复制 process.env', () => {
  process.env.__ADP_LEAK_TEST__ = 'should-not-leak';
  try {
    const env = buildEnvAllowlist([], {});
    assert.ok(!('__ADP_LEAK_TEST__' in env), '非白名单变量绝不透传');
    for (const k of Object.keys(env)) {
      assert.ok(ENV_ALLOWLIST.includes(k), `意外的透传键: ${k}`);
    }

    const env2 = buildEnvAllowlist(['__ADP_LEAK_TEST__'], { OPENAI_API_KEY: 'k' });
    assert.strictEqual(env2.__ADP_LEAK_TEST__, 'should-not-leak', '审查过的 passthrough 才放行');
    assert.strictEqual(env2.OPENAI_API_KEY, 'k', '显式注入由调用方负责安全');
  } finally {
    delete process.env.__ADP_LEAK_TEST__;
  }
});

test('dispose：未结束的当前进程被 killTree', async () => {
  const { sup, kills, setNextChild } = makeSupervisor();
  setNextChild(makeFakeChild());
  await sup.spawnProcess({ command: 'x', timeoutMs: 0 });
  sup.dispose();
  assert.strictEqual(kills.length, 1);
  assert.strictEqual(sup._getCurrent(), null);
});
