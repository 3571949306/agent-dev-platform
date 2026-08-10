'use strict';
/**
 * v2.8.0 — codex exec --json 运行器测试（spec §43C/§44/§59/§65/§67）
 *
 * 这是 Codex 的 fallback 路径。两类风险各占一半：
 *   1) 参数拼装：flag 写错不会报错，只会"跑起来了但沙箱等级不是我们要的"。
 *      所以逐个 flag 与顺序都要断言（尤其 resume 必须紧跟 exec、prompt 必须走 stdin）。
 *   2) 终态判定：进程退了不等于任务成了。没有 turn.completed 事件却 exit 0，
 *      必须判 FAILED（spec §65）；超时与取消是两种不同终态（spec §67）。
 *
 * 测试用真实 CliProcessSupervisor + 注入 spawnImpl，这样进程句柄语义
 * （done / timedOut / aborted / stderr 采集）也一并被覆盖，而不是被 mock 掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const {
  createCodexExecRunner, buildExecArgs, SANDBOX_MODES
} = require('../src/agents/protocols/codex/codexExecRunner');
const { createCliProcessSupervisor } = require('../src/agents/runtime/cliProcessSupervisor');
const { AGENT_EVENT } = require('../src/agents/hub/types');

/**
 * 造一个可编排的假 codex 进程。
 * @param {object} o
 * @param {Array<object|string>} [o.stdoutLines] 依次写入 stdout 的 JSONL（对象自动序列化）
 * @param {number|null} [o.exitCode]
 * @param {string} [o.stderr]
 * @param {boolean} [o.autoClose=true] false = 永不自行退出（用于超时/取消场景）
 * @param {string} [o.spawnError] 非空则 spawnImpl 直接抛错
 */
function fakeCodex(o = {}) {
  const {
    stdoutLines = [], exitCode = 0, stderr = '', autoClose = true, spawnError = null
  } = o;
  const calls = [];
  const children = [];
  const kills = [];

  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (spawnError) throw new Error(spawnError);

    const child = new EventEmitter();
    child.pid = 9000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const stdinChunks = [];
    child.stdin = new Writable({
      write(chunk, enc, cb) { stdinChunks.push(chunk.toString()); cb(); }
    });
    child.stdinData = () => stdinChunks.join('');
    child.stdinEnded = false;
    child.stdin.on('finish', () => { child.stdinEnded = true; });

    child.kill = () => {};
    children.push(child);

    setImmediate(() => {
      for (const line of stdoutLines) {
        child.stdout.write(typeof line === 'string' ? line : JSON.stringify(line) + '\n');
      }
      if (stderr) child.stderr.write(stderr);
      if (autoClose) setImmediate(() => child.emit('close', exitCode, null));
    });

    return child;
  };

  const killTreeImpl = (child, sig) => { kills.push({ pid: child.pid, sig }); };

  return {
    spawnImpl,
    killTreeImpl,
    calls,
    children,
    kills,
    lastArgs: () => (calls[calls.length - 1] || {}).args || [],
    runner: () => createCodexExecRunner({
      supervisor: createCliProcessSupervisor({ spawnImpl, killTreeImpl, resolveImpl: async c => c })
    })
  };
}

const OK_STREAM = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'm1', item_type: 'agent_message', text: '搞定' } },
  { type: 'turn.completed', usage: { input_tokens: 12 } }
];

// ===========================================================================
// buildExecArgs — 参数拼装
// ===========================================================================

test('buildExecArgs：最小形态 = exec --json -（prompt 必须走 stdin）', () => {
  assert.deepStrictEqual(buildExecArgs({}), ['exec', '--json', '-']);
});

test('buildExecArgs：末位固定是 `-`，prompt 绝不进命令行（Windows 32767 上限 + 引号破坏）', () => {
  const args = buildExecArgs({ cwd: '/w', model: 'gpt-5', sandbox: 'read-only' });
  assert.strictEqual(args[args.length - 1], '-');
  assert.ok(!args.includes('prompt'), 'prompt 不得作为位置参数出现');
});

test('buildExecArgs：resume 是子命令，必须紧跟 exec 且在 --json 之前', () => {
  const args = buildExecArgs({ resumeSessionId: 'th-9' });
  assert.deepStrictEqual(args, ['exec', 'resume', 'th-9', '--json', '-']);
  assert.ok(args.indexOf('resume') < args.indexOf('--json'), 'resume 排在 --json 后面会被 CLI 当成参数值');
});

test('buildExecArgs：完整参数顺序与 flag 名逐字正确', () => {
  assert.deepStrictEqual(buildExecArgs({
    cwd: 'D:/w', model: 'gpt-5-codex', sandbox: 'workspace-write',
    addDirs: ['D:/lib', 'D:/shared'], skipGitRepoCheck: true
  }), [
    'exec', '--json',
    '--cd', 'D:/w',
    '--model', 'gpt-5-codex',
    '--sandbox', 'workspace-write',
    '--add-dir', 'D:/lib',
    '--add-dir', 'D:/shared',
    '--skip-git-repo-check',
    '-'
  ]);
});

test('buildExecArgs：非法 sandbox 值被丢弃，绝不透传到 CLI', () => {
  assert.ok(!buildExecArgs({ sandbox: 'yolo' }).includes('--sandbox'));
  assert.ok(!buildExecArgs({ sandbox: 'full-access' }).includes('--sandbox'));
  assert.ok(!buildExecArgs({ sandbox: '' }).includes('--sandbox'));
});

test('buildExecArgs：三种合法 sandbox 全部放行', () => {
  for (const mode of SANDBOX_MODES) {
    const args = buildExecArgs({ sandbox: mode });
    assert.deepStrictEqual(args, ['exec', '--json', '--sandbox', mode, '-'], mode);
  }
  assert.deepStrictEqual([...SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
});

test('buildExecArgs：绝不生成任何绕过审批/沙箱的危险 flag（spec §36）', () => {
  const args = buildExecArgs({
    cwd: '/w', sandbox: 'danger-full-access', skipGitRepoCheck: true,
    extraArgs: ['--foo'], addDirs: ['/x']
  }).join(' ');
  for (const banned of [
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--yolo'
  ]) {
    assert.ok(!args.includes(banned), '不得出现 ' + banned);
  }
});

test('buildExecArgs：addDirs 过滤空值，extraArgs 只接受字符串', () => {
  assert.deepStrictEqual(
    buildExecArgs({ addDirs: ['/a', '', null, undefined, '/b'] }),
    ['exec', '--json', '--add-dir', '/a', '--add-dir', '/b', '-']
  );
  assert.deepStrictEqual(
    buildExecArgs({ extraArgs: ['--ok', 42, null, { x: 1 }, '--also'] }),
    ['exec', '--json', '--ok', '--also', '-']
  );
});

test('buildExecArgs：非数组的 addDirs / extraArgs 被安全忽略', () => {
  assert.deepStrictEqual(buildExecArgs({ addDirs: 'not-array', extraArgs: 'nope' }), ['exec', '--json', '-']);
});

test('runner 同时暴露 buildExecArgs，便于适配器复用同一份拼装逻辑', () => {
  const f = fakeCodex();
  assert.strictEqual(typeof f.runner().buildExecArgs, 'function');
});

// ===========================================================================
// run — 正常路径
// ===========================================================================

test('run：完整成功流 → completed，threadId / summary / usage 全部回填', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  const out = await f.runner().run({ command: 'codex', prompt: '修个 bug', runId: 'r1', agentId: 'codex' });

  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.threadId, 'th-1');
  assert.strictEqual(out.summary, '搞定');
  assert.deepStrictEqual(out.usage, { input_tokens: 12 });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.exitCode, 0);
});

test('run：prompt 经 stdin 写入并显式 end（不 end 会让 codex 永久等待输入）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  await f.runner().run({ command: 'codex', prompt: '多行\nprompt "带引号"' });

  const child = f.children[0];
  assert.strictEqual(child.stdinData(), '多行\nprompt "带引号"');
  assert.strictEqual(child.stdinEnded, true, 'stdin 必须 end，否则子进程挂死');
});

test('run：onEvent 收到映射后的统一事件（而非原始 codex JSON）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  const events = [];
  await f.runner().run({
    command: 'codex', prompt: 'x', runId: 'r1', agentId: 'codex',
    onEvent: (type, payload) => events.push({ type, payload })
  });

  assert.ok(events.some(e => e.type === AGENT_EVENT.RUN_STATUS));
  const msg = events.find(e => e.type === AGENT_EVENT.MESSAGE);
  assert.strictEqual(msg.payload.content, '搞定');
  assert.strictEqual(msg.payload.runId, 'r1');
});

test('run：spawn 时传入 cwd/env 且 stdout 不被 supervisor 缓冲（captureOutput:false）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  await f.runner().run({ command: 'codex', prompt: 'x', cwd: 'D:/w', env: { PATH: '/usr/bin' } });

  const call = f.calls[0];
  assert.strictEqual(call.cmd, 'codex');
  assert.strictEqual(call.opts.cwd, 'D:/w');
  assert.deepStrictEqual(call.opts.env, { PATH: '/usr/bin' });
  assert.strictEqual(call.opts.windowsHide, true);
});

test('run：文件变更与 diff 汇总进结果（spec §47）', async () => {
  const f = fakeCodex({
    stdoutLines: [
      { type: 'thread.started', thread_id: 'th-2' },
      { type: 'item.completed', item: { id: 'f1', item_type: 'file_change', changes: [{ path: 'src/a.js' }, { path: 'src/b.js' }] } },
      { type: 'turn.completed' }
    ]
  });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'completed');
  assert.deepStrictEqual(out.changedFiles, ['src/a.js', 'src/b.js']);
});

test('run：JSONL 被拆成任意 chunk 也能正确解析（跨 chunk 半行）', async () => {
  const whole = OK_STREAM.map(x => JSON.stringify(x)).join('\n') + '\n';
  const mid = Math.floor(whole.length / 2);
  const f = fakeCodex({ stdoutLines: [whole.slice(0, mid), whole.slice(mid)] });

  const out = await f.runner().run({ command: 'codex', prompt: 'x' });
  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.threadId, 'th-1');
});

test('run：末行无换行也能被 flush 消费（进程直接退出场景）', async () => {
  const lines = OK_STREAM.map(x => JSON.stringify(x)).join('\n'); // 末尾故意不带 \n
  const f = fakeCodex({ stdoutLines: [lines] });

  const out = await f.runner().run({ command: 'codex', prompt: 'x' });
  assert.strictEqual(out.status, 'completed', '最后一条 turn.completed 不能因缺换行而丢失');
});

// ===========================================================================
// run — 终态判定（spec §65 / §67）
// ===========================================================================

test('run：exit 0 但无终态事件 → FAILED（进程退出 ≠ 任务成功，spec §65）', async () => {
  const f = fakeCodex({
    stdoutLines: [{ type: 'thread.started', thread_id: 'th-3' }],
    exitCode: 0
  });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.exitCode, 0);
  assert.ok(out.errors.some(e => e.includes('未产生终态事件')));
});

test('run：turn.failed → FAILED 且错误信息保留', async () => {
  const f = fakeCodex({
    stdoutLines: [
      { type: 'thread.started', thread_id: 'th-4' },
      { type: 'turn.failed', error: { message: '沙箱拒绝写入' } }
    ]
  });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'failed');
  assert.ok(out.errors.includes('沙箱拒绝写入'));
});

test('run：非零退出码 → FAILED，stderr 尾部纳入诊断', async () => {
  const f = fakeCodex({ stdoutLines: [], exitCode: 2, stderr: 'codex: unknown flag --bogus' });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.exitCode, 2);
  assert.ok(out.errors.some(e => e.includes('exit=2')));
  assert.ok(out.errors.some(e => e.includes('unknown flag --bogus')));
});

test('run：成功时不把 stderr 塞进 errors（避免噪声与潜在泄露，spec §70）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM, stderr: 'warning: 某些无害提示' });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'completed');
  assert.deepStrictEqual(out.errors, []);
});

test('run：stderr 超长时截断到 2000 字符尾部（防日志膨胀）', async () => {
  const f = fakeCodex({ stdoutLines: [], exitCode: 1, stderr: 'X'.repeat(5000) + 'TAIL_MARKER' });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  const line = out.errors.find(e => e.startsWith('stderr: '));
  assert.ok(line, '失败时必须带上 stderr 诊断');
  assert.ok(line.includes('TAIL_MARKER'), '保留的是尾部（最新报错），不是头部');
  assert.ok(line.length <= 'stderr: '.length + 2000);
});

test('run：已 abort 的 signal → cancelled，且与超时区分开（spec §67）', async () => {
  const f = fakeCodex({ stdoutLines: [], autoClose: false });
  const ac = new AbortController();
  ac.abort();

  const out = await f.runner().run({ command: 'codex', prompt: 'x', signal: ac.signal });

  assert.strictEqual(out.status, 'cancelled');
  assert.ok(out.errors.includes('用户已停止'));
  assert.ok(!out.errors.some(e => e.includes('超时')), '取消不得被报成超时');
});

test('run：运行中 abort → cancelled 并对本进程发 SIGKILL（只杀自己 spawn 的，spec §106）', async () => {
  const f = fakeCodex({ stdoutLines: [], autoClose: false });
  const ac = new AbortController();
  const p = f.runner().run({ command: 'codex', prompt: 'x', signal: ac.signal });

  await new Promise(r => setTimeout(r, 20));
  ac.abort();
  const out = await p;

  assert.strictEqual(out.status, 'cancelled');
  assert.strictEqual(f.kills.length, 1, '只应杀掉本次 spawn 的那一个进程');
  assert.strictEqual(f.kills[0].pid, f.children[0].pid);
  assert.strictEqual(f.kills[0].sig, 'SIGKILL');
});

test('run：超时 → status=timeout（不是 cancelled，也不是 failed）', async () => {
  const f = fakeCodex({ stdoutLines: [], autoClose: false });
  // supervisor 的超时计时器是 unref 的，测试期间自己拿一个 ref 计时器保活
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const out = await f.runner().run({ command: 'codex', prompt: 'x', timeoutMs: 30 });
    assert.strictEqual(out.status, 'timeout');
    assert.ok(out.errors.some(e => e.includes('执行超时（30 ms）')));
    assert.strictEqual(f.kills[0].sig, 'SIGKILL', '超时必须终止进程，不能留 zombie');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('run：超时优先于事件流终态（先收到 completed 也不能盖掉外因）', async () => {
  // 流里已经给了 turn.completed，但进程赖着不退出 → 仍应判超时
  const f = fakeCodex({ stdoutLines: OK_STREAM, autoClose: false });
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const out = await f.runner().run({ command: 'codex', prompt: 'x', timeoutMs: 40 });
    assert.strictEqual(out.status, 'timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('run：子进程 error 事件 → FAILED 并带上原始错误文本', async () => {
  const f = fakeCodex({ stdoutLines: [], autoClose: false });
  const p = f.runner().run({ command: 'codex', prompt: 'x' });
  await new Promise(r => setTimeout(r, 10));
  f.children[0].emit('error', new Error('ENOENT: codex not found'));

  const out = await p;
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.errors.some(e => e.includes('ENOENT: codex not found')));
  assert.strictEqual(out.exitCode, null);
});

test('run：spawn 直接抛错时向上抛出 SPAWN_FAILED（不静默返回假成功）', async () => {
  const f = fakeCodex({ spawnError: 'EACCES' });
  await assert.rejects(
    f.runner().run({ command: 'codex', prompt: 'x' }),
    (err) => {
      assert.match(err.message, /spawn failed: EACCES/);
      assert.strictEqual(err.code, 'SPAWN_FAILED');
      return true;
    }
  );
});

// ===========================================================================
// 协议流健壮性（spec §62）
// ===========================================================================

test('run：单条畸形行只记录不中断，后续事件照常处理', async () => {
  const f = fakeCodex({
    stdoutLines: [
      JSON.stringify({ type: 'thread.started', thread_id: 'th-5' }) + '\n',
      '{ 这不是 JSON }\n',
      JSON.stringify({ type: 'turn.completed' }) + '\n'
    ]
  });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'completed', '一条脏行不该拖垮整个 Run');
  assert.strictEqual(out.threadId, 'th-5');
  assert.ok(out.errors.some(e => e.startsWith('畸形事件')));
});

test('run：连续畸形超阈值 → 记录协议流损坏并判 FAILED', async () => {
  const junk = Array.from({ length: 15 }, (_, i) => `garbage-${i}\n`).join('');
  const f = fakeCodex({ stdoutLines: [junk], exitCode: 0 });

  const out = await f.runner().run({ command: 'codex', prompt: 'x' });
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.errors.some(e => e.includes('协议流损坏')));
});

test('run：非 JSONL 的纯文本输出不会被当成成功（§44 禁止文本抓取兜底）', async () => {
  const f = fakeCodex({
    stdoutLines: ['Codex is thinking...\nDone! All tests pass.\n'],
    exitCode: 0
  });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.strictEqual(out.status, 'failed', '自然语言里的 "Done" 绝不能被解读为成功');
  assert.strictEqual(out.summary, '');
});

test('run：结果形状稳定，字段齐全（供适配器直接映射 AgentResult）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  const out = await f.runner().run({ command: 'codex', prompt: 'x' });

  assert.deepStrictEqual(Object.keys(out).sort(), [
    'changedFiles', 'diff', 'errors', 'exitCode', 'plan', 'status', 'summary', 'threadId', 'usage'
  ]);
});

test('run：resume 场景把会话 id 拼进参数（Session ≠ Run，spec §109）', async () => {
  const f = fakeCodex({ stdoutLines: OK_STREAM });
  await f.runner().run({ command: 'codex', prompt: '继续', resumeSessionId: 'th-1' });

  const args = f.lastArgs();
  assert.deepStrictEqual(args.slice(0, 4), ['exec', 'resume', 'th-1', '--json']);
});
