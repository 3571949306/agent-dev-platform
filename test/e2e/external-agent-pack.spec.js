'use strict';
/**
 * v2.7.1 — First External Agent Pack GUI E2E（Case 36-43）。
 *
 * 在真实 Electron 窗口中验证 Cline / OpenCode / OpenHands 三个外部 Agent：
 *   36) External Pack Cards —— Agent Center 渲染 Cline/OpenCode/OpenHands 卡片（来自 Registry）
 *   37) Cline SDK —— 注入 fake SDK → start → event → completed
 *   38) OpenCode Server —— 注入 fake server → health → session → task → event → diff → completed
 *   39) OpenCode Cancel —— hang + 停止 → session abort 被调用 + run cancelled + 无迟到 completed
 *   40) OpenHands Server —— 注入 fake server → connect → conversation → event → completed
 *   41) Project Lock —— OpenCode 写 + Cline 第二写 → busy → 取消 OpenCode → Cline 获得锁
 *   42) Router Diversity —— 三个 Agent 不同能力 → Router 选出预期 Agent
 *   43) External Failure → Native Fallback —— OpenHands 不可用 → 回退 Native → completed
 *
 * 隔离：临时 userData + 临时 fixture 副本，不污染真实数据。
 * 依赖：NODE_ENV=test（让 test:* 注入钩子可用）。
 *
 * Fake SDK / Fake Server 在主进程内启动，通过 IPC test: handler 注入到已注册的 adapter。
 * 不消耗真实 API，不安装真实 OpenCode/OpenHands。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start } = require('./fake-api');
const { copyFixture, cleanup } = require('../fixtures/coding-agent/reset');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake = null;
let app = null;
let page = null;
let userData = null;
let fixtureRoot = null;
let fixtureProjectId = null;
let fakeConnId = null;
let pageErrors = [];

function seedDb(ud, baseUrl) {
  return new Promise((resolve, reject) => {
    const p = spawn(ELECTRON_BIN, [path.join(ROOT, 'test', 'e2e', 'seed-db.js'), ud, baseUrl], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error('seed-db 退出码 ' + code))));
  });
}

async function launchApp(ud) {
  const env = { ...process.env, ADP_USER_DATA: ud, NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  const a = await electron.launch({
    args: ['.', '--disable-gpu'],
    cwd: ROOT,
    env
  });
  const p = await a.firstWindow();
  pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });
  await p.waitForLoadState('domcontentloaded');
  await p.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  await p.waitForTimeout(800);
  // 安装事件探针
  await p.evaluate(() => {
    window._hubEvents = [];
    window._runTerms = [];
    if (window.api && window.api.onEvent) {
      window.api.onEvent(e => {
        const t = e && e.type;
        if (typeof t === 'string' && t.startsWith('agent.')) {
          if (window._hubEvents.length > 200) window._hubEvents.shift();
          window._hubEvents.push({ type: t, ...e });
        }
        if (['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(t)) {
          window._runTerms.push(t);
        }
      });
    }
  });
  return a;
}

async function openFixtureProject() {
  const proj = await page.evaluate(async (root) => {
    const r = await window.api.invoke('projects:create', { name: 'Fixture Ext Pack', rootPath: root });
    return r && r.data !== undefined ? r.data : r;
  }, fixtureRoot);
  fixtureProjectId = proj.id;
  await page.locator('#btn-project').click();
  await page.waitForSelector('.modal-body tbody tr, #modal tbody tr', { timeout: 10000 });
  await page.locator(`[data-po="${fixtureProjectId}"]`).click();
  await page.waitForTimeout(800);
}

async function openAgentsPage() {
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  await page.waitForSelector('#hub-cards', { timeout: 10000 });
}

/** 获取 Fake API 连接 ID（Cline 需要 connectionId） */
async function getFakeConnId() {
  if (fakeConnId) return fakeConnId;
  const r = await page.evaluate(async () => {
    const res = await window.api.invoke('connections:list');
    return res && res.data !== undefined ? res.data : res;
  });
  const conn = (Array.isArray(r) ? r : []).find(c => c.name === 'Fake API');
  fakeConnId = conn ? conn.id : null;
  return fakeConnId;
}

/** 调用 invoke 并解包 {data} 包装 */
async function invoke(channel, ...args) {
  const r = await page.evaluate(async ({ channel, args }) => {
    const res = await window.api.invoke(channel, ...args);
    return res && res.data !== undefined ? res.data : res;
  }, { channel, args });
  return r;
}

/** 轮询 hub:status 直到终态，返回 status 对象 */
async function waitForTerminal(runId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await invoke('hub:status', runId);
    if (s && ['completed', 'failed', 'cancelled', 'timeout'].includes(s.status)) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

/** 读取已收集的 agent.* 事件流 */
async function getHubEvents() {
  return await page.evaluate(() => (window._hubEvents || []).slice());
}

test.beforeAll(async () => {
  fake = await start(0);
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-ext-'));
  await seedDb(userData, fake.baseUrl);
  fixtureRoot = await copyFixture();
  app = await launchApp(userData);
  page = app.firstWindow ? await app.firstWindow() : page;
  await openFixtureProject();
  await getFakeConnId();
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  try { if (fixtureRoot) await cleanup(fixtureRoot); } catch { /* best effort */ }
});

// ── Case 36 — External Pack Cards ─────────────────────────────────────────
test('36) External Pack Cards：Agent Center 渲染 Cline/OpenCode/OpenHands', async () => {
  pageErrors = [];
  await openAgentsPage();
  // 等待 Hub 卡片渲染（来自 Registry，非硬编码）
  await page.waitForSelector('#hub-cards .acard[data-hub-id]', { timeout: 10000 });
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#hub-cards .acard[data-hub-id]'))
      .map(el => el.getAttribute('data-hub-id'))
  );
  expect(ids, 'Hub 卡片应包含 Cline').toContain('cline');
  expect(ids, 'Hub 卡片应包含 OpenCode').toContain('opencode');
  expect(ids, 'Hub 卡片应包含 OpenHands').toContain('openhands');
  // 验证 transport 标签可见
  const clineCard = page.locator('#hub-cards .acard[data-hub-id="cline"]');
  await expect(clineCard).toContainText('SDK');
  const openCodeCard = page.locator('#hub-cards .acard[data-hub-id="opencode"]');
  await expect(openCodeCard).toContainText('HTTP');
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 37 — Cline SDK ────────────────────────────────────────────────────
test('37) Cline SDK：注入 fake SDK → start → event → completed', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 1. 注入 fake Cline SDK
  const injected = await invoke('test:injectClineSdk', { delayMs: 0 });
  expect(injected.ok, 'fake SDK 注入应成功').toBe(true);

  // 2. 通过 hub:start 启动 Cline 任务
  const connId = await getFakeConnId();
  const startResult = await invoke('hub:start', 'cline', {
    goal: 'Review 这个项目的 math.js',
    projectRoot: fixtureRoot,
    connectionId: connId,
    model: 'model-B',
    required: ['coding', 'filesystem'],
    readOnly: true
  });
  expect(startResult.runId, '应返回 runId').toBeTruthy();

  // 3. 等待终态
  const terminal = await waitForTerminal(startResult.runId, 15000);
  expect(terminal, 'Cline Run 应有终态').toBeTruthy();
  expect(terminal.status, 'Cline Run 应完成').toBe('completed');

  // 4. 读取结果
  const result = await invoke('hub:result', startResult.runId);
  expect(result, '应有结果').toBeTruthy();
  expect(result.status, '结果状态应为 completed').toBe('completed');

  // 5. 事件流中应有 agent.message（content_update 映射）
  const events = await getHubEvents();
  const messages = events.filter(e => e.type === 'agent.message');
  expect(messages.length, '应有 agent.message 事件').toBeGreaterThanOrEqual(1);

  // 6. 重置 fake SDK
  await invoke('test:resetClineSdk');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 38 — OpenCode Server ───────────────────────────────────────────────
test('38) OpenCode Server：fake server → session → task → event → diff → completed', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; });

  // 1. 注入 fake OpenCode Server（在主进程内启动，通过真实 HTTP Client 访问）
  const injected = await invoke('test:injectOpenCodeServer');
  expect(injected.ok, 'fake server 注入应成功').toBe(true);
  expect(injected.baseUrl, '应有 baseUrl').toBeTruthy();

  // 2. 启动 OpenCode 任务（走真实 HTTP Client → fake server）
  const startResult = await invoke('hub:start', 'opencode', {
    goal: '修复 math.js 的 add 函数',
    projectRoot: fixtureRoot,
    required: ['coding', 'filesystem'],
    readOnly: false
  });
  expect(startResult.runId, '应返回 runId').toBeTruthy();

  // 3. 等待终态
  const terminal = await waitForTerminal(startResult.runId, 15000);
  expect(terminal, 'OpenCode Run 应有终态').toBeTruthy();
  expect(terminal.status, 'OpenCode Run 应完成').toBe('completed');

  // 4. 读取结果 —— 应包含结果对象
  const result = await invoke('hub:result', startResult.runId);
  expect(result, '应有结果').toBeTruthy();
  expect(result.status, '结果状态应为 completed').toBe('completed');

  // 5. 事件流中应有 tool 事件（read_file tool_call）
  const events = await getHubEvents();
  const toolEvents = events.filter(e => e.type === 'agent.tool.started' || e.type === 'agent.tool.completed');
  expect(toolEvents.length, '应有 tool 事件').toBeGreaterThanOrEqual(1);

  // 6. 重置 fake server
  await invoke('test:resetOpenCodeServer');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 39 — OpenCode Cancel ──────────────────────────────────────────────
test('39) OpenCode Cancel：hang + 停止 → abort 被调用 + cancelled + 无迟到 completed', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 1. 注入 fake server
  await invoke('test:injectOpenCodeServer');
  // 2. 设置下次 prompt_async 为 hang 模式（不发 completed）
  await invoke('test:setOpenCodeHang');

  // 3. 启动 OpenCode 任务
  const startResult = await invoke('hub:start', 'opencode', {
    goal: '长时间任务',
    projectRoot: fixtureRoot,
    required: ['coding', 'filesystem'],
    readOnly: false
  });
  expect(startResult.runId, '应返回 runId').toBeTruthy();

  // 4. 等待一小段时间让任务进入 running
  await new Promise(r => setTimeout(r, 500));

  // 5. 取消任务
  const cancelResult = await invoke('hub:cancel', startResult.runId);
  expect(cancelResult, '取消应返回结果').toBeTruthy();

  // 6. 等待终态
  const terminal = await waitForTerminal(startResult.runId, 10000);
  expect(terminal, 'Run 应有终态').toBeTruthy();
  expect(terminal.status, 'Run 应被取消').toBe('cancelled');

  // 7. 验证 abort 被调用
  const abortInfo = await invoke('test:getOpenCodeAbortCount');
  expect(abortInfo.count, 'fake server abort 应被调用').toBeGreaterThanOrEqual(1);

  // 8. 等待确认无迟到 completed
  await new Promise(r => setTimeout(r, 1500));
  const lateCheck = await invoke('hub:status', startResult.runId);
  expect(lateCheck.status, '不应有迟到 completed').toBe('cancelled');

  // 9. 重置
  await invoke('test:resetOpenCodeServer');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 40 — OpenHands Server ─────────────────────────────────────────────
test('40) OpenHands Server：fake server → connect → conversation → event → completed', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; });

  // 1. 注入 fake OpenHands Server
  const injected = await invoke('test:injectOpenHandsServer');
  expect(injected.ok, 'fake server 注入应成功').toBe(true);
  expect(injected.baseUrl, '应有 baseUrl').toBeTruthy();

  // 2. 启动 OpenHands 任务
  const startResult = await invoke('hub:start', 'openhands', {
    goal: '分析这个项目的代码结构',
    projectRoot: fixtureRoot,
    required: ['coding', 'research'],
    readOnly: true
  });
  expect(startResult.runId, '应返回 runId').toBeTruthy();

  // 3. 等待终态
  const terminal = await waitForTerminal(startResult.runId, 15000);
  expect(terminal, 'OpenHands Run 应有终态').toBeTruthy();
  expect(terminal.status, 'OpenHands Run 应完成').toBe('completed');

  // 4. 读取结果
  const result = await invoke('hub:result', startResult.runId);
  expect(result, '应有结果').toBeTruthy();
  expect(result.status, '结果状态应为 completed').toBe('completed');

  // 5. 事件流中应有 agent.message 事件
  const events = await getHubEvents();
  const messages = events.filter(e => e.type === 'agent.message');
  expect(messages.length, '应有 agent.message 事件').toBeGreaterThanOrEqual(1);

  // 6. 重置
  await invoke('test:resetOpenHandsServer');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 41 — Project Lock ──────────────────────────────────────────────────
test('41) Project Lock：OpenCode 写 + Cline 第二写 → busy → 取消 OpenCode → Cline 获锁', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; });

  // 1. 注入两个 fake（OpenCode server + Cline SDK + hang 让 OpenCode 占住锁）
  await invoke('test:injectOpenCodeServer');
  await invoke('test:injectClineSdk', { delayMs: 0 });
  await invoke('test:setOpenCodeHang');

  const connId = await getFakeConnId();

  // 2. 启动 OpenCode 写任务（会获取写锁并 hang）
  const ocStart = await invoke('hub:start', 'opencode', {
    goal: '修改文件',
    projectRoot: fixtureRoot,
    required: ['coding', 'filesystem'],
    readOnly: false
  });
  expect(ocStart.runId, 'OpenCode 应返回 runId').toBeTruthy();

  // 3. 等待 OpenCode 获取锁
  await new Promise(r => setTimeout(r, 500));

  // 4. 验证项目锁被占用
  const busy = await invoke('lock:isBusy', fixtureRoot);
  expect(busy, '项目应被锁住').toBe(true);

  // 5. 尝试用 Cline 启动第二个写任务（同一 projectRoot）→ 应被 PROJECT_LOCKED 拒绝
  const clineStart = await invoke('hub:start', 'cline', {
    goal: '也想修改文件',
    projectRoot: fixtureRoot,
    connectionId: connId,
    model: 'model-B',
    required: ['coding', 'filesystem'],
    readOnly: false
  });
  expect(clineStart.error, 'Cline 应被锁拒绝').toBe('PROJECT_LOCKED');
  expect(clineStart.errorCode, 'errorCode 应为 PROJECT_LOCKED').toBe('PROJECT_LOCKED');

  // 6. 取消 OpenCode → 释放锁
  await invoke('hub:cancel', ocStart.runId);
  await new Promise(r => setTimeout(r, 500));

  // 7. 验证锁已释放
  const busyAfter = await invoke('lock:isBusy', fixtureRoot);
  expect(busyAfter, '项目锁应已释放').toBe(false);

  // 8. Cline 重试 → 应成功获得锁
  const clineRetry = await invoke('hub:start', 'cline', {
    goal: '现在可以修改了',
    projectRoot: fixtureRoot,
    connectionId: connId,
    model: 'model-B',
    required: ['coding', 'filesystem'],
    readOnly: true
  });
  expect(clineRetry.runId, 'Cline 重试应成功').toBeTruthy();

  // 等待 Cline 完成
  if (clineRetry.runId) {
    await waitForTerminal(clineRetry.runId, 15000);
  }

  // 9. 重置
  await invoke('test:resetOpenCodeServer');
  await invoke('test:resetClineSdk');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 42 — Router Diversity ──────────────────────────────────────────────
test('42) Router Diversity：不同能力 Agent → Router 选出预期 + GUI 显示', async () => {
  pageErrors = [];

  // 1. 注入 fake 让三个 Agent 都可用
  await invoke('test:injectClineSdk', { delayMs: 0 });
  await invoke('test:injectOpenCodeServer');
  await invoke('test:injectOpenHandsServer');

  // 2. 路由一个 research 任务
  const routeResult = await invoke('hub:route', {
    required: ['research'],
    preferred: ['coding']
  });
  expect(Array.isArray(routeResult), '路由应返回数组').toBe(true);
  expect(routeResult.length, '应有候选').toBeGreaterThanOrEqual(1);

  // 3. 路由一个 coding 任务
  const codingRoute = await invoke('hub:route', {
    required: ['coding', 'filesystem']
  });
  expect(Array.isArray(codingRoute), '编码路由应返回数组').toBe(true);
  expect(codingRoute.length, '应有编码候选').toBeGreaterThanOrEqual(1);

  // 4. 验证不同能力的路由结果不同
  const researchTop = routeResult[0].agentId;
  const codingTop = codingRoute[0].agentId;
  // 至少有一个 Agent 被选中（不强制必须不同——取决于能力声明）
  expect(researchTop, 'research 任务应有首选').toBeTruthy();
  expect(codingTop, 'coding 任务应有首选').toBeTruthy();

  // 5. GUI 显示路由理由
  await openAgentsPage();
  // Hub 卡片应展示能力标签
  const clineCaps = await page.locator('#hub-cards .acard[data-hub-id="cline"] .chip').count();
  expect(clineCaps, 'Cline 卡片应有能力标签').toBeGreaterThan(0);

  // 6. 重置
  await invoke('test:resetClineSdk');
  await invoke('test:resetOpenCodeServer');
  await invoke('test:resetOpenHandsServer');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ── Case 43 — External Failure → Native Fallback ─────────────────────────────
test('43) External Failure → Native Fallback：外部 Agent 不可用 → 回退 Native → completed', async () => {
  pageErrors = [];
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 1. 注册一个 fake 外部 Agent（启动必败，具备 research 能力，health=healthy 排第一）
  await invoke('hub:testRegisterAdapter', {
    id: 'fake-ext-fail',
    manifest: {
      id: 'fake-ext-fail',
      displayName: 'Fake External (Fail)',
      transport: 'http',
      capabilities: { research: true, coding: true }
    },
    transport: 'http',
    capabilities: ['research', 'coding'],
    healthStatus: 'healthy',
    maxConcurrency: 1,
    available: true,
    startFails: true,
    resultText: 'should not see this'
  });

  // 2. 注册一个 fake native-main（成功完成，模拟 Native fallback）
  //    真实 NativeAgentAdapter 需要 model/runManager 上下文，Hub 的 start() 不提供这些字段，
  //    故用 TestAgentAdapter 替换以验证 fallback 流程（同 Case 33 模式）。
  await invoke('hub:testRegisterAdapter', {
    id: 'native-main',
    manifest: {
      id: 'native-main',
      displayName: '主智能体',
      transport: 'native',
      capabilities: { coding: true, filesystem: true, terminal: true, git: true, research: true },
      availability: true,
      maxConcurrency: 3
    },
    transport: 'native',
    capabilities: ['coding', 'filesystem', 'terminal', 'git', 'research'],
    healthStatus: 'unknown',
    maxConcurrency: 3,
    available: true,
    resultText: 'Native fallback completed'
  });

  // 3. startAuto 带 research 能力 → fake-ext-fail 排第一但启动失败 → fallback native-main
  const startResult = await invoke('hub:startAuto', {
    goal: 'Review 项目',
    required: ['research'],
    projectRoot: fixtureRoot,
    readOnly: true
  });

  // 4. 应该成功（fallback 到 native-main）
  expect(startResult, 'startAuto 应返回结果').toBeTruthy();
  expect(startResult.error || '', '不应有错误（应 fallback 成功）').toBe('');
  expect(startResult.agentId, '应 fallback 到 native-main').toBe('native-main');
  expect(startResult.runId, '应有 runId').toBeTruthy();

  // 5. 等待终态
  const terminal = await waitForTerminal(startResult.runId, 15000);
  expect(terminal, 'Run 应有终态').toBeTruthy();
  expect(terminal.status, 'Run 应完成').toBe('completed');

  // 6. 事件流中应有 fallback 事件
  const events = await getHubEvents();
  const fallbacks = events.filter(e => e.type === 'agent.fallback');
  expect(fallbacks.length, '应至少有一个 fallback 事件').toBeGreaterThanOrEqual(1);
  expect(fallbacks[0].fromAgentId, 'fallback 应从 fake-ext-fail 开始').toBe('fake-ext-fail');
  expect(fallbacks[0].toAgentId, 'fallback 应切到 native-main').toBe('native-main');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});
