'use strict';
/**
 * v2.6.0 — Main Agent GUI E2E：自主编码闭环真机验收（Case 27-30）。
 *
 * 在真实 Electron 窗口中，通过 mainAgent:testSetModel 注入 FakeCodingModel，
 * 调用 mainAgent:run 触发自主编码 Run，验证：
 *   27) 编码成功 —— 读取→测试失败→修复→测试通过→完成 → completed + GUI 卡片
 *   28) 修复循环 —— 第一次 patch 错→第二次 patch 对 → completed + 修复横幅
 *   29) 停止 —— 长命令 + 点停止 → cancelled
 *   30) 必需验证失败 —— 模型提前 complete 但 npm test 失败 → 不得 completed
 *
 * 隔离：临时 userData + 临时 fixture 副本，不污染真实数据。
 * 依赖：NODE_ENV=test（让 mainAgent:testSetModel 可用）。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start } = require('./fake-api');
const {
  buildFixAddScript, buildRepairLoopScript,
  buildPrematureCompleteScript, buildHangScript
} = require('../../src/agent/runtime/fakeCodingModel');
const { copyFixture, cleanup, resetToBroken } = require('../fixtures/coding-agent/reset');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake = null;
let app = null;
let page = null;
let userData = null;
let fixtureRoot = null;
let fixtureProjectId = null;
let pageErrors = [];

function seedDb(ud, baseUrl) {
  return new Promise((resolve, reject) => {
    const p = spawn(ELECTRON_BIN, [path.join(ROOT, 'test', 'e2e', 'seed-db.js'), ud, baseUrl], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit'
    });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('seed-db 退出码 ' + code))));
  });
}

async function launchApp(ud) {
  // NODE_ENV=test 让 mainAgent:testSetModel 可用
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
  // 安装事件探针：终态事件 + mainAgent:* 事件
  await p.evaluate(() => {
    window._runTerms = [];
    window._mainAgentEvents = [];
    if (window.api && window.api.onEvent) {
      window.api.onEvent(e => {
        const t = e && e.type;
        if (['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(t)) {
          window._runTerms.push(t);
        }
        if (typeof t === 'string' && t.startsWith('mainAgent:')) {
          if (window._mainAgentEvents.length > 100) window._mainAgentEvents.shift();
          window._mainAgentEvents.push({ type: t, runId: e.runId, conv: e.conversationId, state: e.state, passed: e.passed, round: e.round });
        }
      });
    }
  });
  return a;
}

/** 读取终态事件（全量） */
async function getTerminalEvents() {
  return await page.evaluate(() => (window._runTerms || []).slice());
}

/** 读取 mainAgent:* 事件流（全量，用于断言） */
async function getMainAgentEvents() {
  return await page.evaluate(() => (window._mainAgentEvents || []).slice());
}

/** 等待终态事件到达，返回终态类型列表 */
async function waitForTerminal(timeoutMs = 60000) {
  await page.waitForFunction(
    () => (window._runTerms || []).length > 0,
    null,
    { timeout: timeoutMs }
  );
  return await getTerminalEvents();
}

/** 通过 GUI 打开 fixture 项目（设置 renderer state.project） */
async function openFixtureProject() {
  // 1. IPC 创建项目
  const proj = await page.evaluate(async (root) => {
    const r = await window.api.invoke('projects:create', { name: 'Fixture Coding', rootPath: root });
    return r && r.data !== undefined ? r.data : r;
  }, fixtureRoot);
  fixtureProjectId = proj.id;
  // 2. GUI 打开项目菜单 → 点击「打开」
  await page.locator('#btn-project').click();
  await page.waitForSelector('.modal-body tbody tr, #modal tbody tr', { timeout: 10000 });
  const openBtn = page.locator(`[data-po="${fixtureProjectId}"]`);
  await openBtn.click();
  await page.waitForTimeout(800);
}

/** 通过 GUI 新建对话（设置 renderer state.conv），返回 conversationId */
async function createConversationViaGui() {
  await page.locator('#btn-newchat').click();
  await page.waitForTimeout(800);
  // 从 API 读取最新对话
  const convId = await page.evaluate(async (pid) => {
    const r = await window.api.invoke('conversations:list', pid);
    const list = r && r.data !== undefined ? r.data : r;
    return Array.isArray(list) && list.length ? list[0].id : null;
  }, fixtureProjectId);
  return convId;
}

/** 注入 FakeCodingModel + 触发 mainAgent:run */
async function runMainAgent(script, opts = {}) {
  // 1. 重置 fixture 到「有 bug」基线
  await resetToBroken(fixtureRoot);
  // 2. 清空上一轮的终态/事件探针
  await page.evaluate(() => { window._runTerms = []; window._mainAgentEvents = []; });
  // 3. 注入 FakeCodingModel
  await page.evaluate(async (scr) => {
    await window.api.invoke('mainAgent:testSetModel', { script: scr, opts: { name: 'E2E-Fake' } });
  }, script);
  // 4. GUI 新建对话（设置 state.conv，让 mainAgent 事件 mine=true）
  const conversationId = await createConversationViaGui();
  expect(conversationId, '应创建对话').toBeTruthy();
  // 5. 获取主智能体 ID
  const agentId = await page.evaluate(async () => {
    const r = await window.api.invoke('agents:list');
    const agents = r && r.data ? r.data : r;
    const main = (Array.isArray(agents) ? agents : []).find(a => a && a.is_main);
    return main ? main.id : null;
  });
  expect(agentId, '应找到主智能体').toBeTruthy();
  // 6. 触发 mainAgent:run
  const result = await page.evaluate(async (params) => {
    const r = await window.api.invoke('mainAgent:run', params);
    return r && r.data !== undefined ? r.data : r;
  }, {
    conversationId, agentId,
    goal: opts.goal || '修复 add 函数并确保测试通过',
    verification: opts.verification || [],
    requiredFiles: opts.requiredFiles || [],
    timeoutMs: opts.timeoutMs || 60000,
    useInjectedModel: true
  });
  return { result, conversationId, agentId };
}

test.beforeAll(async () => {
  fake = await start(0);
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-ma-'));
  await seedDb(userData, fake.baseUrl);
  fixtureRoot = await copyFixture();
  app = await launchApp(userData);
  page = app.firstWindow ? await app.firstWindow() : page;
  // 通过 GUI 打开 fixture 项目（设置 renderer state.project）
  await openFixtureProject();
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  try { if (fixtureRoot) await cleanup(fixtureRoot); } catch { /* best effort */ }
});

test('27) 编码成功：读取→测试失败→修复→测试通过→completed + GUI 卡片', async () => {
  pageErrors = [];
  const { result } = await runMainAgent(buildFixAddScript(), {
    goal: '修复 add 函数，让 npm test 通过',
    verification: [{ type: 'command', command: 'npm test', required: true }]
  });
  expect(result.runId, 'mainAgent:run 应返回 runId').toBeTruthy();
  // 等待终态 completed
  const terms = await waitForTerminal(60000);
  expect(terms).toContain('run_completed');
  // 状态栏显示「已完成」
  await expect(page.locator('#status-text')).toContainText('已完成');
  // 停止按钮隐藏、发送按钮恢复
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeEnabled();
  // GUI 元素：应有 mainAgent 事件流
  const maEvents = await getMainAgentEvents();
  const types = maEvents.map(e => e.type);
  expect(types).toContain('mainAgent:runStarted');
  expect(types).toContain('mainAgent:action');
  expect(types.some(t => t === 'mainAgent:toolResult' || t === 'mainAgent:testResult')).toBe(true);
  // 时间线面板应有条目（切换到时间线 tab 让面板可见）
  await page.locator('.btab[data-btab="timeline"]').click();
  await expect(page.locator('#bottom-timeline .tl-list .tl-row').first()).toBeVisible({ timeout: 5000 });
  // 文件确实被修复
  const after = fs.readFileSync(path.join(fixtureRoot, 'src', 'math.js'), 'utf8');
  expect(after).toContain('return a + b');
  // 无 JS 致命错误
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('28) 修复循环：第一次 patch 错→第二次 patch 对→completed + 修复横幅', async () => {
  pageErrors = [];
  await runMainAgent(buildRepairLoopScript(), {
    goal: '修复 add 函数（需要两次 patch）',
    verification: [{ type: 'command', command: 'npm test', required: true }]
  });
  const terms = await waitForTerminal(60000);
  expect(terms).toContain('run_completed');
  await expect(page.locator('#status-text')).toContainText('已完成');
  // 应有修复横幅
  const maEvents = await getMainAgentEvents();
  const repairs = maEvents.filter(e => e.type === 'mainAgent:repairStart');
  expect(repairs.length, '应至少有一次 repairStart 事件').toBeGreaterThanOrEqual(1);
  // 修复横幅应在 DOM 中可见
  await expect(page.locator('.ma-repair-banner').first()).toBeVisible({ timeout: 5000 });
  // 文件最终被修复
  const after = fs.readFileSync(path.join(fixtureRoot, 'src', 'math.js'), 'utf8');
  expect(after).toContain('return a + b');
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('29) 停止：长命令 + 点停止→cancelled', async () => {
  pageErrors = [];
  await runMainAgent(buildHangScript(), {
    goal: '运行长命令（测试停止）',
    timeoutMs: 120000
  });
  // 等待停止按钮可见（Run 已启动）
  await expect(page.locator('#btn-stop')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500); // 确保命令已在运行
  await page.locator('#btn-stop').click();
  // 等待终态 cancelled
  const terms = await waitForTerminal(30000);
  expect(terms).toContain('run_cancelled');
  await expect(page.locator('#status-text')).toContainText('已取消');
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeEnabled();
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('30) 必需验证失败：模型提前 complete 但 npm test 失败→不得 completed', async () => {
  pageErrors = [];
  await runMainAgent(buildPrematureCompleteScript(), {
    goal: '修复 add 函数',
    verification: [{ type: 'command', command: 'npm test', required: true }]
  });
  // 等待终态（不应是 completed，应是 failed 或 timeout）
  const terms = await waitForTerminal(60000);
  expect(terms.includes('run_completed'), '验证失败不得 completed').toBe(false);
  // 应有终态（failed 或 timeout）
  expect(terms.some(t => ['run_failed', 'run_timeout', 'run_cancelled'].includes(t))).toBe(true);
  // 应触发 repair（完成策略未满足）
  const maEvents = await getMainAgentEvents();
  const repairs = maEvents.filter(e => e.type === 'mainAgent:repairStart');
  expect(repairs.length, '完成策略未满足应触发 repair').toBeGreaterThanOrEqual(1);
  // 文件不应是正确修复（模型改成了除法，verification 失败）
  const after = fs.readFileSync(path.join(fixtureRoot, 'src', 'math.js'), 'utf8');
  expect(after).not.toContain('return a + b');
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});
