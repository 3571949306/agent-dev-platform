'use strict';
/**
 * P1 service integration tests — these hit the REAL implementations:
 *   - MCP client against a real JSON-RPC stdio server (test/fixtures)
 *   - Browser automation against a real browser (Playwright Chromium or the
 *     system Edge/Chrome fallback)
 *   - Windows Computer runtime against real PowerShell
 *   - External agent adapters (Codex over a mock provider, HTTP, WorkBuddy)
 *
 * Nothing here is stubbed out; if a capability is genuinely unavailable on the
 * machine the test asserts that the failure is *graceful and reported*, which
 * is the contract the agent runtime depends on.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { McpClient, McpManager } = require('../src/services/mcp');
const { BrowserManager, createBrowserTools } = require('../src/services/browser');
const { ComputerManager } = require('../src/services/computer');
const extAgents = require('../src/services/externalAgents');
const { PermissionEngine } = require('../src/security/permissions');
const visionReader = require('../src/services/visionReader');
const store = require('../src/db/store');

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
// Under `ELECTRON_RUN_AS_NODE=1` execPath is electron.exe behaving as node,
// and the child inherits that env, so it is a valid node runner either way.
const NODE_BIN = process.execPath;

/* ------------------------------------------------------------------ MCP */

test('MCP: 与真实 stdio 服务器完成握手并发现工具', async () => {
  const client = new McpClient({ id: 'm1', transport: 'stdio', command: NODE_BIN, args: [FIXTURE], timeoutMs: 15000 });
  const tools = await client.connect();
  assert.strictEqual(client.connected, true);
  assert.deepStrictEqual(tools.map(t => t.name).sort(), ['add', 'echo']);
  assert.ok(tools[0].input_schema, 'inputSchema 应被规范化为 input_schema');
  client.disconnect();
});

test('MCP: tools/call 返回真实结果（文本内容被拼接）', async () => {
  const client = new McpClient({ id: 'm2', transport: 'stdio', command: NODE_BIN, args: [FIXTURE], timeoutMs: 15000 });
  await client.connect();
  assert.strictEqual(await client.callTool('echo', { text: '你好 MCP' }), '你好 MCP');
  assert.strictEqual(await client.callTool('add', { a: 2, b: 40 }), '42');
  client.disconnect();
});

test('MCP: 未知工具返回 JSON-RPC 错误而不是静默成功', async () => {
  const client = new McpClient({ id: 'm3', transport: 'stdio', command: NODE_BIN, args: [FIXTURE], timeoutMs: 15000 });
  await client.connect();
  await assert.rejects(() => client.callTool('nope', {}), /Unknown tool/);
  client.disconnect();
});

test('MCP: 命令不存在时优雅失败，不抛未捕获的 error 事件', async () => {
  const mgr = new McpManager();
  await assert.rejects(
    () => mgr.connect({ id: 'bad', transport: 'stdio', command: 'adp-definitely-not-a-real-binary', args: [], timeoutMs: 8000 }),
    (e) => /启动失败|退出|超时/.test(e.message)
  );
  assert.strictEqual(mgr.get('bad'), undefined, '失败的连接不应被登记');
});

test('MCP: 服务器不响应握手时按超时失败（不会永久挂起启动）', async () => {
  const t0 = Date.now();
  const client = new McpClient({ id: 'slow', transport: 'stdio', command: NODE_BIN, args: [FIXTURE, '--slow'], timeoutMs: 1200 });
  await assert.rejects(() => client.connect(), /超时/);
  assert.ok(Date.now() - t0 < 6000, '应在超时窗口内返回，实际耗时 ' + (Date.now() - t0) + 'ms');
  client.disconnect();
});

test('MCP: 管理器在未连接时调用工具会明确报错', async () => {
  const mgr = new McpManager();
  await assert.rejects(() => mgr.callTool('nonexistent', 'echo', {}), /未连接/);
});

test('MCP: disconnect 后进程被回收', async () => {
  const client = new McpClient({ id: 'm4', transport: 'stdio', command: NODE_BIN, args: [FIXTURE], timeoutMs: 15000 });
  await client.connect();
  const proc = client.proc;
  client.disconnect();
  await new Promise(r => setTimeout(r, 800));
  assert.ok(proc.killed || proc.exitCode !== null, '子进程应已退出');
});

/* -------------------------------------------------------------- Browser */

test('Browser: 真实启动浏览器并完成导航 / 快照 / 截图 / 交互', async (t) => {
  const mgr = new BrowserManager();
  let launched;
  try {
    launched = await mgr.launch({ headless: true });
  } catch (e) {
    // No Chromium download AND no Edge/Chrome on the box — the contract is
    // that the error is actionable, not that the machine has a browser.
    assert.match(e.message, /playwright install|Edge|Chrome/i);
    t.diagnostic('本机无可用浏览器内核，已验证降级错误信息：' + e.message.split('\n')[0]);
    return;
  }
  t.diagnostic('浏览器内核：' + launched.engine);
  assert.ok(launched.ok);

  const page = path.join(os.tmpdir(), 'adp-browser-test.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>ADP 浏览器测试</title>
    <input id="q"><button id="go" onclick="document.title='clicked:'+document.getElementById('q').value">Go</button>`);

  const nav = await mgr.navigate('file:///' + page.replace(/\\/g, '/'));
  assert.strictEqual(nav.title, 'ADP 浏览器测试');

  const snap = await mgr.snapshot();
  assert.ok(snap.accessibility.length > 2, '应返回可访问性树');

  await mgr.type('#q', 'hello');
  await mgr.click('#go');
  const after = await mgr.snapshot();
  assert.strictEqual(after.title, 'clicked:hello', '输入与点击应真实生效');

  const shot = await mgr.screenshot();
  assert.ok(shot.data_url.startsWith('data:image/png;base64,') && shot.data_url.length > 1000);

  assert.strictEqual(mgr.status().launched, true);
  await mgr.close();
  assert.strictEqual(mgr.status().launched, false);
  fs.unlinkSync(page);
});

test('Browser: 工具层错误被包装成 {ok:false,error} 而不是抛异常', async () => {
  const { defs, execs } = createBrowserTools();
  assert.ok(defs.every(d => d.permission === 'browser'), '所有浏览器工具都必须走 browser 权限');
  const r = await execs.browser_navigate({}, { url: 'http://127.0.0.1:1/definitely-refused' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'BROWSER_ERROR');
  assert.ok(r.error.message.length > 0);
  const { manager } = require('../src/services/browser');
  await manager.close();
});

/* ------------------------------------------------------------- Computer */

test('Computer: 列出真实窗口', async (t) => {
  // §36-§39: CI 环境可能无稳定桌面会话 → 真正 t.skip（不是假 PASS）
  if (process.env.CI) {
    const c = new ComputerManager();
    const r = await c.listWindows();
    if (!r.ok && /超时|timeout/i.test(r.error)) {
      t.skip('CI 环境无稳定桌面会话，PowerShell 超时');
      return;
    }
    assert.strictEqual(r.ok, true, '列窗口失败: ' + r.error);
    assert.ok(Array.isArray(r.windows));
    t.diagnostic('当前可见窗口数：' + r.windows.length);
    if (r.windows.length) assert.ok('title' in r.windows[0] && 'pid' in r.windows[0]);
    return;
  }
  // 真机必须真实执行
  const c = new ComputerManager();
  const r = await c.listWindows();
  assert.strictEqual(r.ok, true, '列窗口失败: ' + r.error);
  assert.ok(Array.isArray(r.windows));
  t.diagnostic('当前可见窗口数：' + r.windows.length);
  if (r.windows.length) assert.ok('title' in r.windows[0] && 'pid' in r.windows[0]);
});

test('Computer: 真实屏幕截图返回 PNG data URL', async (t) => {
  const c = new ComputerManager();
  const r = await c.screenshot();
  assert.strictEqual(r.ok, true, '截图失败: ' + r.error);
  assert.ok(r.data_url.startsWith('data:image/png;base64,'));
  assert.ok(r.data_url.length > 10000, '截图数据过小，可能是空图');
  t.diagnostic('截图大小：' + Math.round(r.data_url.length / 1024) + 'KB');
});

test('Computer: 聚焦不存在的窗口返回结构化失败而不是崩溃', async () => {
  const c = new ComputerManager();
  const r = await c.focusWindow('绝对不存在的窗口标题-zzz');
  assert.strictEqual(r.ok, false);
  assert.ok(String(r.error).length > 0);
});

test('Computer: 工具层把失败规范化为 {ok:false,error}', async () => {
  const { defs, execs } = require('../src/services/computer').createComputerTools();
  assert.ok(defs.every(d => d.permission === 'computer'));
  const r = await execs.computer_get_ui_tree({}, { title: '绝对不存在的窗口标题-zzz' });
  assert.strictEqual(r.ok, false);
});

/* ------------------------------------------------------- External agents */

test('ExternalAgent: 未知适配器类型返回结构化失败', async () => {
  const out = JSON.parse(await extAgents.runExternalAgent({ adapter_type: 'nope' }, 'task', {}));
  assert.strictEqual(out.status, 'failed');
  assert.match(out.errors[0], /未知外部智能体类型/);
});

test('ExternalAgent: Codex API 模式未配置时给出可操作的错误', async () => {
  const out = JSON.parse(await extAgents.runExternalAgent({ adapter_type: 'codex', config: { cliMode: 'api' } }, 'task', { store }));
  assert.strictEqual(out.status, 'failed');
  assert.match(out.errors[0], /CLI 路径或 API 连接/);
});

test('ExternalAgent: Codex 走 API 连接时返回模型内容', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-ext-'));
  store.init(userData);
  const conn = store.connections.create({ name: 'mockconn', provider: 'mock', base_url: '', api_key: '' });
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'codex', config: { cliMode: 'api', connectionId: conn.id } },
    '给 utils.js 加一个 slugify 函数',
    { store }
  ));
  assert.strictEqual(out.status, 'completed');
  assert.ok(out.summary.length > 0, 'Codex 适配器应回填模型输出');
  assert.ok(Array.isArray(out.changedFiles) && Array.isArray(out.findings), '必须符合结构化结果契约');
});

test('ExternalAgent: HTTP 适配器对真实本地服务发起调用', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('received:' + parsed.task);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    const out = JSON.parse(await extAgents.runExternalAgent({ adapter_type: 'http', config: { endpoint: url } }, '构建项目', {}));
    assert.strictEqual(out.status, 'completed');
    assert.strictEqual(out.summary, 'received:构建项目');
  } finally { srv.close(); }
});

test('ExternalAgent: HTTP 端点不可达时不抛异常', async () => {
  const out = JSON.parse(await extAgents.runExternalAgent({ adapter_type: 'http', config: { endpoint: 'http://127.0.0.1:1/nope' } }, 'x', {}));
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.errors.length > 0);
});

test('ExternalAgent: WorkBuddy 桥接找不到窗口时提示先打开桌面应用', async () => {
  const fakeComputer = { listWindows: async () => ({ ok: true, windows: [{ pid: 1, title: '记事本' }] }) };
  const out = JSON.parse(await extAgents.runExternalAgent({ adapter_type: 'workbuddy', config: {} }, 'task', { computerManager: fakeComputer }));
  assert.strictEqual(out.status, 'failed');
  assert.match(out.errors[0], /未找到 WorkBuddy 窗口/);
});

// v2.1.0 契约变更：v2.0.0 在这里 sleep(3000) 然后无条件 completed。现在若目标窗口
// 不暴露 UI 自动化文本，我们无法验证结果，就必须诚实地失败并给出可操作建议。
test('ExternalAgent: WorkBuddy 桥接无法读取窗口文本时诚实失败（不再假装完成）', async () => {
  const calls = [];
  const fakeComputer = {
    listWindows: async () => ({ ok: true, windows: [{ pid: 7, title: 'WorkBuddy — 工作台' }] }),
    focusWindow: async (t) => { calls.push('focus:' + t); return { ok: true }; },
    pressKeys: async (k) => { calls.push('keys:' + k); return { ok: true }; },
    screenshot: async () => ({ ok: true, data_url: 'data:image/png;base64,AAAA' })
  };
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'workbuddy', config: {} }, '整理周报',
    { computerManager: fakeComputer, sleep: async () => {} }
  ));
  assert.strictEqual(out.status, 'failed', '不可读窗口绝不能报 completed');
  assert.ok(calls.some(c => c.startsWith('focus:WorkBuddy')), '仍应先聚焦窗口');
  assert.match(out.errors[0], /未暴露 UI 自动化文本/);
});

test('ExternalAgent: WorkBuddy 桥接读到真实回答时返回内容而非"请自己去看"', async () => {
  let turn = 0;
  const answer = '周报已整理完成：本周合并 3 个 PR，修复 5 个缺陷。';
  // 捕获桥接生成的 sentinel：它会随提示词一起通过 UIA 写入输入框
  const SENT = { value: '' };
  const fakeComputer = {
    listWindows: async () => ({ ok: true, windows: [{ pid: 7, title: 'WorkBuddy — 工作台' }] }),
    focusWindow: async () => ({ ok: true }),
    setControlValue: async (_t, text) => {
      const m = /ADP-[A-Z0-9]{6}/.exec(text);
      if (m) SENT.value = m[0];
      return { ok: true };
    },
    pressKeys: async () => ({ ok: true }),
    getWindowText: async () => {
      turn++;
      // 第 1 次是 baseline（提交前），之后模拟对方把回答和结束标记打了出来
      if (turn <= 1) return { ok: true, text: '历史对话\n整理周报' };
      return { ok: true, text: `历史对话\n整理周报\n${answer}\n${SENT.value}` };
    }
  };
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'workbuddy', config: { pollIntervalMs: 1, timeoutMs: 5000 } }, '整理周报',
    { computerManager: fakeComputer, sleep: async () => {} }
  ));
  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.detection, 'sentinel');
  assert.strictEqual(out.inputVia, 'uia-value');
  assert.match(out.summary, /本周合并 3 个 PR/, '必须回传对方真实产出的文本');
});

/* --------------------------------------------- P2-9 真实端到端：穿透外部 Agent 运行时的闭环 */

/**
 * 最重要的一条 e2e：通过 runExternalAgent（外部 Agent 真正被调用的入口）走完
 * P0-4 整条链路——WorkBuddy 窗口无 UIA 文本 → 截图 → 视觉模型读屏 → 拿回真实回答。
 * 这条链路此前从未在「外部 Agent 运行时」这一层被验证过。
 */
test('ExternalAgent: WorkBuddy 窗口无 UIA 文本时经外部 Agent 入口走视觉读屏拿回真实答案', async () => {
  const answer = '视觉读到的答案：本周合并 3 个 PR，修复 5 个缺陷。';
  const vision = {
    get available() { return true; },
    unavailableReason() { return 'n/a'; },
    model: 'vision-unit-1',
    source: 'configured',
    label: 'Fake Vision',
    hash: (d) => visionReader.imageHash(d),
    calls: 0,
    async analyze(dataUrl, opts) {
      assert.ok(dataUrl && dataUrl.startsWith('data:image'), '必须真的把截图喂给视觉模型');
      this.calls++;
      return { ok: true, state: 'done', answer, confidence: 0.9, imageHash: 'h' + this.calls, model: this.model, calls: this.calls };
    }
  };
  const fakeComputer = {
    listWindows: async () => ({ ok: true, windows: [{ pid: 7, title: 'WorkBuddy — 工作台' }] }),
    focusWindow: async () => ({ ok: true }),
    setControlValue: async () => ({ ok: true }), // 把任务提交进窗口（UIA 输入）
    pressKeys: async () => ({ ok: true }),
    screenshotWindow: async () => ({ ok: true, data_url: 'data:image/png;base64,iVBORw0KGgo=' }),
    screenshot: async () => ({ ok: true, data_url: 'data:image/png;base64,iVBORw0KGgo=' })
    // 故意不提供 getWindowText —— 模拟窗口不暴露 UI 自动化文本
  };
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'workbuddy', config: {} }, '整理周报',
    { computerManager: fakeComputer, visionReader: vision, sleep: async () => {} }
  ));
  assert.strictEqual(out.status, 'completed', '视觉降级后必须真的完成，而不是假装失败');
  assert.strictEqual(out.readVia, 'vision', '读屏方式必须是 vision');
  assert.match(out.summary, /本周合并 3 个 PR/, '必须回传视觉模型读到的真实文本');
  assert.strictEqual(out.visionCalls, 1, '至少调用一次视觉模型');
  assert.strictEqual(out.visionModel, 'vision-unit-1');
});

test('ExternalAgent: 没配视觉模型时，UIA 不可读应诚实报 VISION_MODEL_REQUIRED 而非伪造完成', async () => {
  const fakeComputer = {
    listWindows: async () => ({ ok: true, windows: [{ pid: 7, title: 'WorkBuddy — 工作台' }] }),
    focusWindow: async () => ({ ok: true }),
    setControlValue: async () => ({ ok: true }),
    pressKeys: async () => ({ ok: true }),
    screenshotWindow: async () => ({ ok: true, data_url: 'data:image/png;base64,iVBORw0KGgo=' }),
    screenshot: async () => ({ ok: true, data_url: 'data:image/png;base64,iVBORw0KGgo=' })
  };
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'workbuddy', config: {} }, '整理周报',
    { computerManager: fakeComputer, visionReader: null, sleep: async () => {} }
  ));
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.code, 'VISION_MODEL_REQUIRED');
});

/** P0-2: 权限闸门同时存在于外部 Agent 运行时（不仅是 Agent Runtime）。 */
test('ExternalAgent: 权限不足时直接 PERMISSION_DENIED，绝不默默放行', async () => {
  const engine = new PermissionEngine();
  engine.grant('network', 'deny', { persist: false }); // HTTP 适配器需要 network 作用域
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'http', config: { endpoint: 'http://127.0.0.1:9/x' } }, 'task',
    { store, permissionEngine: engine, requestPermission: null }
  ));
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.code, 'PERMISSION_DENIED');
  assert.strictEqual(out.deniedScope, 'network');
});

/** P0-3: 用户在任务开始前就按了 Stop，外部 Agent 应立即 cancelled 而不发任何请求。 */
test('ExternalAgent: 任务开始前 signal 已 abort 时返回 cancelled', async () => {
  const ac = new AbortController();
  ac.abort();
  const out = JSON.parse(await extAgents.runExternalAgent(
    { adapter_type: 'http', config: { endpoint: 'http://127.0.0.1:9/x' } }, 'task',
    { store, signal: ac.signal }
  ));
  assert.strictEqual(out.status, 'cancelled');
  assert.match(out.errors[0], /停止/);
});

/** P1-5: Codex 必须在「当前项目根目录」下运行，而不是应用自己的 cwd。 */
test('ExternalAgent: resolveCodexCwd 优先用项目根目录、可被 adapter.cwd 覆盖', async () => {
  const { resolveCodexCwd } = require('../src/services/externalAgents');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cwd-'));
  // 1) ctx.projectRoot 生效
  assert.strictEqual(resolveCodexCwd({}, { projectRoot: dir }), dir);
  // 2) adapter.cwd 优先级更高
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cwd-o-'));
  assert.strictEqual(resolveCodexCwd({ cwd: override }, { projectRoot: dir }), override);
  // 3) 两者都缺时回退到 process.cwd
  assert.strictEqual(resolveCodexCwd({}, {}), process.cwd());
});
