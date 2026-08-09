'use strict';
/**
 * v2.6.0 — Agent Integration Hub GUI E2E：多 Agent 路由 / Fallback / 取消 / 委派（Case 31-35）。
 *
 * 在真实 Electron 窗口中验证 Agent Integration Hub 的核心能力：
 *   31) Agent Center —— 智能体页面可见 "Agent Integration Hub" 区段，
 *       Native / Codex / WorkBuddy 来自注册表（非硬编码），能力标签可见。
 *   32) Capability Routing —— 输入编码任务 → 路由测试 → Native / Codex 得分高于 WorkBuddy。
 *   33) Fallback —— 伪造 Codex 启动失败 → 系统回退到 Native → 时间线含 fallback 事件。
 *   34) Cancel Isolation —— 启动两个 fake Run → 取消其一 → 另一个继续运行。
 *   35) Main Agent Delegate —— 发送委派消息 → 路由选择 fake review Agent → Main Run 完成。
 *
 * 隔离：临时 userData + 临时 fixture 副本，不污染真实数据。
 * 依赖：NODE_ENV=test（让 hub:testRegisterAdapter 等测试钩子可用）。
 *
 * 说明：Hub 的 IPC 通道（hub:available / hub:route / hub:startAuto / hub:cancel ...）
 * 由后端接线任务提供。若通道尚未注册，用例会在 invoke 阶段失败——这是预期行为，
 * 单元测试（test/*.test.js）已覆盖 Hub 的路由 / 生命周期 / 健康逻辑。
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
  // 安装事件探针：agent.* 事件 + 终态事件
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

/** 通过 GUI 打开 fixture 项目（设置 renderer state.project） */
async function openFixtureProject() {
  const proj = await page.evaluate(async (root) => {
    const r = await window.api.invoke('projects:create', { name: 'Fixture Hub', rootPath: root });
    return r && r.data !== undefined ? r.data : r;
  }, fixtureRoot);
  fixtureProjectId = proj.id;
  await page.locator('#btn-project').click();
  await page.waitForSelector('.modal-body tbody tr, #modal tbody tr', { timeout: 10000 });
  await page.locator(`[data-po="${fixtureProjectId}"]`).click();
  await page.waitForTimeout(800);
}

/** 导航到智能体页面 */
async function openAgentsPage() {
  await page.getByRole('button', { name: '智能体' }).click();
  await page.waitForSelector('#hub-cards', { timeout: 10000 });
}

/** 读取 hub:available 结果（从注册表） */
async function getHubAvailable() {
  return await page.evaluate(async () => {
    const r = await window.api.invoke('hub:available');
    return r && r.data !== undefined ? r.data : r;
  });
}

/** 读取 hub:manifests 结果 */
async function getHubManifests() {
  return await page.evaluate(async () => {
    const r = await window.api.invoke('hub:manifests');
    return r && r.data !== undefined ? r.data : r;
  });
}

/** 等待终态事件到达，返回终态类型列表 */
async function waitForTerminal(timeoutMs = 30000) {
  await page.waitForFunction(() => (window._runTerms || []).length > 0, null, { timeout: timeoutMs });
  return await page.evaluate(() => (window._runTerms || []).slice());
}

/** 读取已收集的 agent.* 事件流 */
async function getHubEvents() {
  return await page.evaluate(() => (window._hubEvents || []).slice());
}

test.beforeAll(async () => {
  fake = await start(0);
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-hub-'));
  await seedDb(userData, fake.baseUrl);
  fixtureRoot = await copyFixture();
  app = await launchApp(userData);
  page = app.firstWindow ? await app.firstWindow() : page;
  await openFixtureProject();
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  try { if (fixtureRoot) await cleanup(fixtureRoot); } catch { /* best effort */ }
});

test('31) Agent Center：Hub 区段可见 + 注册表 Agent + 能力标签', async () => {
  pageErrors = [];
  await openAgentsPage();
  // Agent Integration Hub 区段可见
  await expect(page.locator('h3', { hasText: 'Agent Integration Hub' })).toBeVisible();
  await expect(page.locator('#hub-cards')).toBeVisible();
  // 路由预览区段可见
  await expect(page.locator('#hub-router-preview')).toBeVisible();
  await expect(page.locator('#hub-route-input')).toBeVisible();
  await expect(page.locator('#hub-route-btn')).toBeVisible();

  // 从注册表读取 Agent（非硬编码）—— hub:available 应返回 Native / Codex / WorkBuddy
  const available = await getHubAvailable();
  expect(Array.isArray(available), 'hub:available 应返回数组').toBe(true);
  const ids = available.map(a => a.id);
  expect(ids, '应包含 Native 主智能体').toContain('native-main');
  expect(ids, '应包含 Codex').toContain('codex');
  expect(ids, '应包含 WorkBuddy').toContain('workbuddy');

  // 等待卡片渲染（loadHubCards 是异步的）
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('#hub-cards .acard');
    return cards.length >= 3;
  }, null, { timeout: 10000 });

  // 验证卡片中有 Native / Codex / WorkBuddy 的名字
  const cardsText = await page.locator('#hub-cards').textContent();
  expect(cardsText).toContain('主智能体');
  expect(cardsText).toContain('Codex');
  expect(cardsText).toContain('WorkBuddy');

  // 验证能力标签（chip）可见 —— Native 应有 Coding / Terminal / Git 等
  const nativeCard = page.locator('#hub-cards .acard', { hasText: '主智能体' });
  await expect(nativeCard.locator('.chip', { hasText: 'Coding' })).toBeVisible();
  await expect(nativeCard.locator('.chip', { hasText: 'Terminal' })).toBeVisible();

  // 每个 Hub 卡片都应有"测试"按钮（健康检查）
  const testBtns = page.locator('#hub-cards [data-hub-test]');
  await expect(testBtns.first()).toBeVisible();
  expect(await testBtns.count()).toBeGreaterThanOrEqual(3);

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('32) Capability Routing：编码任务 → Native / Codex 得分高于 WorkBuddy', async () => {
  pageErrors = [];
  await openAgentsPage();
  // 输入编码任务描述
  const input = page.locator('#hub-route-input');
  await input.fill('重构这个模块的认证逻辑并修复单元测试');
  await page.locator('#hub-route-btn').click();

  // 等待路由结果渲染
  await page.waitForSelector('#hub-route-results .acard', { timeout: 10000 });

  // 从 IPC 直接读取路由结果做断言（GUI 只展示，断言走数据层更稳定）
  const ranked = await page.evaluate(async () => {
    const r = await window.api.invoke('hub:route', { required: ['coding', 'filesystem'], preferred: ['git'] });
    return r && r.data !== undefined ? r.data : r;
  });
  expect(Array.isArray(ranked), 'hub:route 应返回数组').toBe(true);
  expect(ranked.length, '应有候选 Agent').toBeGreaterThanOrEqual(1);

  // 按得分降序排列
  const byId = Object.fromEntries(ranked.map(r => [r.agentId, r]));
  const nativeScore = byId['native-main'] ? byId['native-main'].score : null;
  const codexScore = byId['codex'] ? byId['codex'].score : null;
  const workbuddyScore = byId['workbuddy'] ? byId['workbuddy'].score : null;

  expect(nativeScore, 'Native 应在候选中').not.toBeNull();
  expect(codexScore, 'Codex 应在候选中').not.toBeNull();
  expect(workbuddyScore, 'WorkBuddy 应在候选中').not.toBeNull();
  // Native 和 Codex 都具备 coding + filesystem，得分应高于 WorkBuddy（缺少 filesystem）
  expect(nativeScore).toBeGreaterThan(workbuddyScore);
  expect(codexScore).toBeGreaterThan(workbuddyScore);

  // GUI 结果区应展示得分 + reasons
  const resultsText = await page.locator('#hub-route-results').textContent();
  expect(resultsText).toContain('score');
  // 至少有一个 reason 展示出来（匹配 / 检查中文 reason）
  expect(resultsText.length).toBeGreaterThan(0);

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('33) Fallback：Codex 启动失败 → 回退 Native + 时间线含 fallback 事件', async () => {
  pageErrors = [];
  // 1. 注入一个"启动失败"的 fake Codex adapter（测试钩子）
  //    hub:testRegisterAdapter 让测试向 Registry 注入 fake adapter，覆盖真实 Codex。
  await page.evaluate(async () => {
    const fakeCodex = {
      id: 'codex',
      manifest: { id: 'codex', displayName: 'Codex', transport: 'cli', capabilities: { coding: true, filesystem: true, terminal: true, git: true } },
      adapterType: 'cli',
      transport: 'cli',
      capabilities: ['coding', 'filesystem', 'terminal', 'git'],
      disabled: false,
      healthStatus: 'healthy',
      maxConcurrency: 2,
      activeRunCount: 0,
      async detect() { return { available: true }; },
      async healthCheck() { return { status: 'healthy' }; },
      async startTask() { throw new Error('Codex 启动失败（测试注入）'); }
    };
    await window.api.invoke('hub:testRegisterAdapter', fakeCodex);
  });

  // 2. 清空事件探针
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 3. 通过 startAuto 触发自动路由 + fallback
  const startResult = await page.evaluate(async () => {
    const r = await window.api.invoke('hub:startAuto', {
      goal: '修复 add 函数',
      required: ['coding', 'filesystem'],
      preferred: ['git'],
      projectRoot: window.__fixtureRoot || null
    });
    return r && r.data !== undefined ? r.data : r;
  });

  // 4. 应该成功（fallback 到 Native）
  expect(startResult, 'startAuto 应返回结果').toBeTruthy();
  expect(startResult.error || '', '不应有错误（应 fallback 成功）').toBe('');
  expect(startResult.agentId, '应 fallback 到 native-main').toBe('native-main');
  expect(startResult.runId, '应有 runId').toBeTruthy();

  // 5. 事件流中应有 agent.fallback 事件
  const events = await getHubEvents();
  const fallbackEvents = events.filter(e => e.type === 'agent.fallback');
  expect(fallbackEvents.length, '应至少有一个 fallback 事件').toBeGreaterThanOrEqual(1);
  // fallback 事件应记录 fromAgentId=codex → toAgentId=native-main
  const fb = fallbackEvents[0];
  expect(fb.fromAgentId, 'fallback 应从 codex 开始').toBe('codex');
  expect(fb.toAgentId, 'fallback 应切到 native-main').toBe('native-main');

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('34) Cancel Isolation：取消一个 Run 不影响另一个', async () => {
  pageErrors = [];
  // 清空事件探针
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 1. 注册两个 fake adapter（各自挂起，模拟长时运行）
  await page.evaluate(async () => {
    const makeFake = (id, transport) => ({
      id,
      manifest: { id, displayName: id, transport, capabilities: { coding: true, filesystem: true } },
      adapterType: transport,
      transport,
      capabilities: ['coding', 'filesystem'],
      disabled: false,
      healthStatus: 'healthy',
      maxConcurrency: 1,
      activeRunCount: 0,
      async detect() { return { available: true }; },
      async healthCheck() { return { status: 'healthy' }; },
      async startTask(task, ctx) {
        // 不立即完成 —— 模拟长时运行，等 cancel 才结束
        return { ok: true, runId: ctx && ctx.runId };
      }
    });
    await window.api.invoke('hub:testRegisterAdapter', makeFake('fake-agent-a', 'http'));
    await window.api.invoke('hub:testRegisterAdapter', makeFake('fake-agent-b', 'http'));
  });

  // 2. 在两个 Agent 上各启动一个 Run
  const starts = await page.evaluate(async () => {
    const r1 = await window.api.invoke('hub:start', 'fake-agent-a', { goal: '任务 A' });
    const r2 = await window.api.invoke('hub:start', 'fake-agent-b', { goal: '任务 B' });
    return {
      a: r1 && r1.data !== undefined ? r1.data : r1,
      b: r2 && r2.data !== undefined ? r2.data : r2
    };
  });
  expect(starts.a.runId, 'Run A 应启动').toBeTruthy();
  expect(starts.b.runId, 'Run B 应启动').toBeTruthy();
  expect(starts.a.runId).not.toBe(starts.b.runId);

  // 3. 取消 Run A
  const cancelResult = await page.evaluate(async (runId) => {
    const r = await window.api.invoke('hub:cancel', runId);
    return r && r.data !== undefined ? r.data : r;
  }, starts.a.runId);
  expect(cancelResult, '取消 Run A 应返回结果').toBeTruthy();

  // 4. Run A 应为 cancelled 终态
  const statusA = await page.evaluate(async (runId) => {
    const r = await window.api.invoke('hub:status', runId);
    return r && r.data !== undefined ? r.data : r;
  }, starts.a.runId);
  expect(statusA.status, 'Run A 应为 cancelled').toBe('cancelled');

  // 5. Run B 应仍在运行（非终态）
  const statusB = await page.evaluate(async (runId) => {
    const r = await window.api.invoke('hub:status', runId);
    return r && r.data !== undefined ? r.data : r;
  }, starts.b.runId);
  expect(statusB.status, 'Run B 不应被取消').not.toBe('cancelled');
  // Run B 应处于运行态（running / starting / waiting 等）
  expect(['running', 'starting', 'waiting', 'idle']).toContain(statusB.status);

  // 6. 清理 Run B
  await page.evaluate(async (runId) => {
    await window.api.invoke('hub:cancel', runId);
  }, starts.b.runId);

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

test('35) Main Agent Delegate：委派消息 → 路由选择 review Agent → Main Run 完成', async () => {
  pageErrors = [];
  // 清空事件探针
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });

  // 1. 注册一个 fake review Agent（具备 review 能力）
  await page.evaluate(async () => {
    const fakeReview = {
      id: 'fake-review-agent',
      manifest: { id: 'fake-review-agent', displayName: 'Fake Review Agent', transport: 'http', capabilities: { coding: true, review: true, filesystem: true } },
      adapterType: 'http',
      transport: 'http',
      capabilities: ['coding', 'review', 'filesystem'],
      disabled: false,
      healthStatus: 'healthy',
      maxConcurrency: 1,
      activeRunCount: 0,
      async detect() { return { available: true }; },
      async healthCheck() { return { status: 'healthy' }; },
      async startTask(task, ctx) {
        // 立即完成，返回 review 结果
        return { ok: true, runId: ctx && ctx.runId, result: '代码审查通过：无明显问题。' };
      }
    };
    await window.api.invoke('hub:testRegisterAdapter', fakeReview);
  });

  // 2. 验证路由器会为 review 任务选择 fake-review-agent
  const routeResult = await page.evaluate(async () => {
    const r = await window.api.invoke('hub:route', { required: ['review', 'filesystem'], preferred: ['coding'] });
    return r && r.data !== undefined ? r.data : r;
  });
  expect(Array.isArray(routeResult), '路由应返回数组').toBe(true);
  expect(routeResult.length, '应有候选').toBeGreaterThanOrEqual(1);
  // fake-review-agent 应排名第一（具备 review + filesystem）
  expect(routeResult[0].agentId, '路由应首选 fake-review-agent').toBe('fake-review-agent');

  // 3. 模拟 Main Agent 委派：通过 hub:delegate 触发委派
  //    委派路径 = [main] → 子 Run，防环检查确保不会回到 main。
  const delegateResult = await page.evaluate(async () => {
    const r = await window.api.invoke('hub:delegate', {
      goal: 'Review 这个修改',
      required: ['review', 'filesystem'],
      preferred: ['coding'],
      delegationPath: ['native-main'],
      parentRunId: 'main-run-test'
    });
    return r && r.data !== undefined ? r.data : r;
  });
  expect(delegateResult, '委派应返回结果').toBeTruthy();
  expect(delegateResult.agentId, '委派应选择 fake-review-agent').toBe('fake-review-agent');
  expect(delegateResult.runId, '应有子 runId').toBeTruthy();

  // 4. 等待子 Run 完成
  const childStatus = await page.evaluate(async (runId) => {
    // 轮询最多 5 秒
    for (let i = 0; i < 50; i++) {
      const r = await window.api.invoke('hub:status', runId);
      const s = r && r.data !== undefined ? r.data : r;
      if (s && ['completed', 'failed', 'cancelled', 'timeout'].includes(s.status)) return s;
      await new Promise(res => setTimeout(res, 100));
    }
    return null;
  }, delegateResult.runId);
  expect(childStatus, '子 Run 应有状态').toBeTruthy();
  expect(childStatus.status, '子 Run 应完成').toBe('completed');

  // 5. 读取子 Run 结果 —— Main Agent 应收到 review 结果
  const childResult = await page.evaluate(async (runId) => {
    const r = await window.api.invoke('hub:result', runId);
    return r && r.data !== undefined ? r.data : r;
  }, delegateResult.runId);
  expect(childResult, '应有子 Run 结果').toBeTruthy();
  expect(childResult.result, '应包含 review 结果').toContain('代码审查');

  // 6. 事件流中应有 RUN_COMPLETED（子 Run 完成）
  const events = await getHubEvents();
  const completed = events.filter(e => e.type === 'agent.run.completed');
  expect(completed.length, '应有 run.completed 事件').toBeGreaterThanOrEqual(1);

  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});
