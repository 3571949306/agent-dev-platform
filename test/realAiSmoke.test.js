'use strict';
/**
 * v2.9.0 Real Runtime Smoke Closure — Real AI Smoke 单元测试（不消耗任何 API）。
 *
 * 覆盖：
 *   §5  Connection 解析优先级（CLI → env-id → settings → store 唯一 DeepSeek → env-fallback）
 *   §6  Model 解析（REAL_AI_TEST_MODEL override / connection / native-main-agent）
 *   R3  生产 PathSecurity：inside write allowed / outside write denied（runSecurityAssertions）
 *   R4  生产 PermissionEngine：仅项目内 fs/terminal + subagent，其余 deny
 *   R8  Fixture 无条件清理：success / provider throws / model timeout / tool error → 0 残留
 *   R9  Budget：attempts/started/succeeded/failed 精确区分；调用前预检，超限拒绝且不发第 N+1 次
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rt = require('../scripts/lib/real-ai-runtime');
const { createRealAiFixture, sha256File } = require('../scripts/lib/real-ai-fixture');
const store = require('../src/db/store');
const { createFakeCodingModel } = require('../src/agent/runtime/fakeCodingModel');

// 独立 store（TEMP userData），用于 Connection / settings 解析测试
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-smoke-unit-'));
store.init(USER_DATA);

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture 基础
// ---------------------------------------------------------------------------

test('createRealAiFixture：字段齐全 + 初始测试 FAIL（fixture 真有 bug）+ cleanup 幂等', () => {
  const fx = createRealAiFixture();
  try {
    assert.ok(fs.existsSync(fx.sourcePath) && fs.existsSync(fx.testPath));
    assert.strictEqual(fx.sha256Test, sha256File(fx.testPath));
    assert.throws(() => require('child_process').execFileSync(process.execPath, [fx.testPath], { cwd: fx.root, stdio: 'pipe' }));
  } finally {
    fx.cleanup();
    fx.cleanup(); // 幂等
  }
  assert.strictEqual(fs.existsSync(fx.root), false);
});

// ---------------------------------------------------------------------------
// §5 Connection 解析优先级
// ---------------------------------------------------------------------------

test('§5 无任何 Connection / env → null（如实 SKIP，不得伪造）', () => {
  withEnv({ DEEPSEEK_API_KEY: undefined, REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
    assert.strictEqual(rt.resolveRealAiConnection(null, { store: null }), null);
  });
});

test('§5 env fallback：source 必须标记 env-fallback（不是 env）', () => {
  withEnv({ DEEPSEEK_API_KEY: 'sk-unit-placeholder', REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
    const r = rt.resolveRealAiConnection(null, { store: null });
    assert.ok(r);
    assert.strictEqual(r.source, 'env-fallback');
    assert.strictEqual(r.conn.api_key, 'sk-unit-placeholder');
  });
});

test('§5 优先级：settings.realAiTestConnectionId 优先于 env-fallback；store 唯一 DeepSeek 连接次之', () => {
  const c1 = store.connections.create({ name: 'DS One', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-one' });
  try {
    withEnv({ DEEPSEEK_API_KEY: 'sk-env', REAL_AI_TEST_CONNECTION_ID: undefined }, () => {
      // 未设置 settings 时：store 中恰好唯一 DeepSeek 连接 → 使用它（优先于 env）
      const r1 = rt.resolveRealAiConnection(null, { store });
      assert.ok(r1, '应解析出 store 连接');
      assert.strictEqual(r1.source, 'store-single-deepseek');
      assert.strictEqual(r1.connectionId, c1.id);
      assert.strictEqual(r1.conn.api_key, 'sk-one', '必须用平台绑定的 Connection，而非 env key');

      // 设置 settings 后：settings 优先
      store.settings.set('realAiTestConnectionId', c1.id);
      const r2 = rt.resolveRealAiConnection(null, { store });
      assert.strictEqual(r2.source, 'settings');
      assert.strictEqual(r2.connectionId, c1.id);
    });
  } finally {
    store.settings.set('realAiTestConnectionId', null);
  }
});

test('§5 explicit CLI connectionId 最高优先；REAL_AI_TEST_CONNECTION_ID 次之', () => {
  const c1 = store.connections.create({ name: 'DS CLI', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-cli' });
  const c2 = store.connections.create({ name: 'DS EnvId', provider: 'openai', base_url: 'https://api.deepseek.com', api_key: 'sk-envid' });
  try {
    withEnv({ DEEPSEEK_API_KEY: undefined, REAL_AI_TEST_CONNECTION_ID: c2.id }, () => {
      const rCli = rt.resolveRealAiConnection(c1.id, { store });
      assert.strictEqual(rCli.source, 'cli');
      assert.strictEqual(rCli.connectionId, c1.id);

      const rEnv = rt.resolveRealAiConnection(null, { store });
      assert.strictEqual(rEnv.source, 'env-id');
      assert.strictEqual(rEnv.connectionId, c2.id);
    });
  } finally { /* connections 保留不影响其他用例（唯一性测试已先执行） */ }
});

// ---------------------------------------------------------------------------
// §6 Model 解析
// ---------------------------------------------------------------------------

test('§6 REAL_AI_TEST_MODEL override 优先；无 override 时用 connection 模型', () => {
  const conn = { id: 'c', provider: 'deepseek', model: 'conn-model' };
  withEnv({ REAL_AI_TEST_MODEL: 'override-model' }, () => {
    const m1 = rt.resolveSmokeModel({ conn, store: null });
    assert.deepStrictEqual(m1, { model: 'override-model', source: 'env-override' });
  });
  const m2 = rt.resolveSmokeModel({ conn, store: null });
  assert.deepStrictEqual(m2, { model: 'conn-model', source: 'connection' });
});

// ---------------------------------------------------------------------------
// R9 Budget 精确计数
// ---------------------------------------------------------------------------

test('R9 budget：调用前预检，started 永不超 max；attempts/started/succeeded/failed 精确区分', () => {
  const b = rt.createRealAiBudget({ maxProviderCalls: 2, maxRuntimeMs: 60000 });
  b.recordAttempt(); b.beforeProviderCall(); b.recordSuccess();
  b.recordAttempt(); b.beforeProviderCall(); b.recordFailure();
  // 第 3 次必须在「发起前」被拒绝（不得先自增再称为实际 API call）
  assert.throws(() => b.beforeProviderCall(), /REAL_AI_BUDGET_EXCEEDED/);
  assert.deepStrictEqual(b.counts(), {
    modelCallAttempts: 2, providerCallsStarted: 2, providerCallsSucceeded: 1, providerCallsFailed: 1
  });
});

test('R9 wrapModelWithBudget：超限后内层 decide 绝不被调用', async () => {
  let innerCalls = 0;
  const inner = { name: 'inner', async decide() { innerCalls++; return { text: 'x' }; } };
  const b = rt.createRealAiBudget({ maxProviderCalls: 1, maxRuntimeMs: 60000 });
  const wrapped = rt.wrapModelWithBudget(inner, b);
  await wrapped.decide({});
  await assert.rejects(() => wrapped.decide({}), /REAL_AI_BUDGET_EXCEEDED/);
  assert.strictEqual(innerCalls, 1, '第 2 次不得真正调用内层（provider 请求不发出）');
  assert.strictEqual(b.counts().providerCallsStarted, 1);
});

test('R9 budget：运行时超限抛 REAL_AI_RUNTIME_EXCEEDED', () => {
  const b = rt.createRealAiBudget({ maxProviderCalls: 10, maxRuntimeMs: -1 });
  assert.throws(() => b.checkRuntime(), /REAL_AI_RUNTIME_EXCEEDED/);
});

// ---------------------------------------------------------------------------
// R3 生产 PathSecurity（inside allowed / outside denied）
// ---------------------------------------------------------------------------

test('R3 runSecurityAssertions：outside write 全部被生产 PathSecurity 拒绝（successfulOutsideWrites=0）', async () => {
  const { createPathSecurity } = require('../src/security/pathSecurity');
  const fixture = createRealAiFixture();
  try {
    const ps = createPathSecurity({ cacheRoots: true });
    const r = await rt.runSecurityAssertions(fixture, ps);
    assert.ok(r.attempts >= 2, '至少包含相对与绝对两种逃逸尝试');
    assert.strictEqual(r.successfulOutsideWrites, 0, 'outside 写入必须全部被拒绝');
    for (const d of r.details) {
      assert.strictEqual(d.denied, true, `${d.target} 必须被拒绝（code=${d.code}）`);
    }
    // 正常写：生产 write_file 工具在 projectRoot 内必须允许
    const writeTool = rt.builtinGetTool('write_file');
    const ctx = { projectRoot: fixture.root, pathSecurity: ps, store: null, emit: () => {}, projectId: null, taskId: null, agentId: 'unit' };
    const inside = await writeTool.exec(ctx, { path: 'src/inside-ok.txt', content: 'ok', record_change: false });
    assert.strictEqual(inside.ok, true, 'projectRoot 内写入必须允许');
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R4 生产 PermissionEngine 权限上下文
// ---------------------------------------------------------------------------

test('R4 createSmokePermissionEngine：仅授权项目内 fs/terminal + subagent，其余 deny', () => {
  const pe = rt.createSmokePermissionEngine();
  for (const scope of ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write', 'subagent']) {
    assert.strictEqual(pe.evaluate(scope, {}), 'allow', `${scope} 应 allow`);
  }
  for (const scope of ['filesystem.outside_workspace', 'terminal.dangerous', 'computer', 'browser', 'clipboard', 'network', 'mcp']) {
    assert.strictEqual(pe.evaluate(scope, {}), 'deny', `${scope} 应 deny`);
  }
});

test('R4 工具权限闸门：deny scope 的工具被 runTool 拒绝（PERMISSION_DENIED）', async () => {
  const { executeAction } = require('../src/agent/runtime/actionExecutor');
  const pe = rt.createSmokePermissionEngine();
  const ctx = { projectRoot: os.tmpdir(), permissionEngine: pe, requestPermission: null, projectId: null, taskId: null };
  // delete_file 需要 filesystem.delete（smoke PE 显式 deny）——必须在执行前被拒绝
  const r = await executeAction(ctx, { type: 'delete_file', args: { path: 'any.txt' } }, rt.builtinGetTool);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PERMISSION_DENIED');
  // ask scope 无交互通道 → fail-safe 拒绝（git_status 依赖 git.read=allow 不受影响）
  const rRead = await executeAction(ctx, { type: 'git_status', args: {} }, rt.builtinGetTool);
  assert.notStrictEqual(rRead.error && rRead.error.code, 'PERMISSION_DENIED', 'git.read 已授权，不应被权限闸门拦截');
});

// ---------------------------------------------------------------------------
// R8 Fixture 无条件清理（success / provider throws / model timeout / tool error）
// ---------------------------------------------------------------------------

async function runChainExpectFailure(opts) {
  let outcome = null;
  await rt.withRealAiFixture(async (fixture) => {
    outcome = await rt.executeRealAiChain({ fixture, timeoutMs: 30000, maxProviderCalls: 6, ...opts });
  });
  return outcome;
}

test('R8 success cleanup：deterministic 成功后 fixture 目录被清理', async () => {
  const { buildDelegateFixAddScript } = require('../src/agent/runtime/fakeCodingModel');
  const before = rt.countFixtureLeftovers();
  let rootSeen = null;
  await rt.withRealAiFixture(async (fixture) => {
    rootSeen = fixture.root;
    const { pass } = await rt.executeRealAiChain({
      fixture,
      modelAdapter: createFakeCodingModel(buildDelegateFixAddScript()),
      timeoutMs: 60000
    });
    assert.strictEqual(pass, true, 'deterministic 链应 PASS');
  });
  assert.strictEqual(fs.existsSync(rootSeen), false, 'cleanup 后目录必须删除');
  assert.ok(rt.countFixtureLeftovers() <= before, '不得新增 adp-real-orchestrator-* 残留');
});

test('R8 provider throws cleanup：model decide 抛错后 fixture 仍被清理', async () => {
  const before = rt.countFixtureLeftovers();
  const boomModel = { name: 'boom', async decide() { throw new Error('provider boom (simulated)'); } };
  const { report } = await runChainExpectFailure({ modelAdapter: boomModel });
  assert.strictEqual(report.parentStatus, 'failed', 'provider 抛错 → parent failed（不是 completed）');
  assert.ok(rt.countFixtureLeftovers() <= before, '异常路径不得泄漏 TEMP fixture');
});

test('R8 model timeout cleanup：runtime 预算超时后 fixture 仍被清理', async () => {
  const before = rt.countFixtureLeftovers();
  const slowModel = { name: 'slow', async decide() { return { text: '{}' }; } };
  const budget = rt.createRealAiBudget({ maxProviderCalls: 6, maxRuntimeMs: -1 }); // 立即超时
  const { report } = await runChainExpectFailure({ modelAdapter: slowModel, budget });
  assert.strictEqual(report.parentStatus, 'failed');
  assert.ok(rt.countFixtureLeftovers() <= before);
});

test('R8 tool error cleanup：工具错误路径结束后 fixture 仍被清理', async () => {
  const before = rt.countFixtureLeftovers();
  const model = createFakeCodingModel([
    { type: 'read_file', args: { path: 'no-such-file.js' }, thought: '读不存在的文件（tool error）' },
    { type: 'complete', args: { summary: '结束' } }
  ]);
  const outcome = await runChainExpectFailure({ modelAdapter: model });
  assert.ok(outcome.report, '链路必须跑完并出报告');
  const readEvent = outcome.evidence.toolEvents.find(t => t.tool === 'read_file');
  assert.ok(readEvent && readEvent.ok === false, 'read_file 应真实失败（生产工具返回错误）');
  assert.ok(rt.countFixtureLeftovers() <= before);
});
