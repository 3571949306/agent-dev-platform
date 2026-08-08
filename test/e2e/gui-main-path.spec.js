'use strict';
/**
 * v2.3.1 — GUI E2E：真机主路径验收（真实 Electron 窗口 + 本地 Fake API）。
 *
 * 本轮核心要求（二十六~三十五）：不能再“提供了 spec 等用户跑”，必须在当前
 * Windows 桌面环境真实执行。用例：
 *   1) API 连接 → 新建 Fake 连接 → 拉取模型 → 查看模型 → model-A/B/C 可见
 *   2) 智能体 → 编辑主智能体 → 选择 Fake 连接 + model-B → 保存 → 重开仍选中
 *   3) 【最重要】选好模型后发送「你好」→ 无 ReferenceError → completed → Spinner 消失
 *   4) 业务失败（model-FAIL）→ 唯一终态 failed（绝不随后 completed）
 *   5) 停止（model-HANG + 停止）→ 唯一终态 cancelled
 *   6) 超时（model-HANG + 短 timeout）→ 唯一终态 timeout
 *   7) 模型来源：手动添加 CUSTOM-X → 重启 App 仍存在(source=manual) → 刷新后不丢
 *   8) 全中文：普通用户可见层无英文残留
 *
 * 隔离：每次运行使用临时 userData（%TEMP%\adp-e2e-<uuid>），不污染真实数据。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron'); // 在纯 node 下返回 electron 可执行文件路径

let fake = null;
let app = null;
let page = null;
let userData = null;
let pageErrors = [];
let terminalLog = []; // window._runTerms 快照

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
  // 本沙箱/本机可能全局设了 ELECTRON_RUN_AS_NODE=1（electron 会被当成 node 跑，
  // 导致 --remote-debugging-port 变成 bad option）。真实 GUI 启动必须剔除它。
  const env = { ...process.env, ADP_USER_DATA: ud };
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
  // 等待 boot() 完成（智能体下拉渲染出来）—— select 的 option 无尺寸，用 waitForFunction
  try {
    await p.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  } catch (e) {
    const dump = await p.evaluate(() => ({
      bodyHTML: document.body.innerHTML.slice(0, 1500),
      title: document.title,
      hasApp: !!document.getElementById('app'),
      apiMethods: window.api ? Object.keys(window.api) : null
    })).catch(() => null);
    process.stderr.write(`[boot-fail] pageErrors=${JSON.stringify(pageErrors)}\n[boot-fail] dump=${JSON.stringify(dump)}\n`);
    throw e;
  }
  await p.waitForTimeout(800);
  // 安装终态事件探针（window._runTerms）
  await p.evaluate(() => {
    window._runTerms = [];
    if (window.api && window.api.onEvent) {
      window.api.onEvent(e => {
        if (['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(e.type)) {
          window._runTerms.push(e.type);
        }
      });
    }
  });
  return a;
}

async function getTerminalDelta() {
  const now = await page.evaluate(() => (window._runTerms || []).slice());
  const delta = now.slice(terminalLog.length);
  terminalLog = now;
  return delta;
}

/** 关闭 page-overlay（Esc 键 → pages.js 已绑定 keydown），回到聊天主界面 */
async function closePage() {
  const overlay = page.locator('.page-overlay:not(.hidden)');
  if (await overlay.count() === 0) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** 通过真实 IPC 切换主智能体模型（状态准备用；发送本身仍走 GUI 点击） */
async function setMainModel(model, extra = {}) {
  await page.evaluate(async ({ model, extra }) => {
    // window.api.invoke 返回 {ok,data} 包装；这里用原始 invoke 取真实数据
    const r = await window.api.invoke('agents:list');
    const agents = r && r.data ? r.data : r;
    const main = (Array.isArray(agents) ? agents : []).find(a => a && a.is_main);
    if (main) await window.api.invoke('agents:update', main.id, { model, ...extra });
  }, { model, extra });
}

test.beforeAll(async () => {
  fake = await start(0);
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-'));
  await seedDb(userData, fake.baseUrl);
  app = await launchApp(userData);
  page = app.firstWindow ? await app.firstWindow() : page;
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('1) API 连接 → GUI 新建 → 拉取模型 → model-A/B/C 真实可见', async () => {
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('tbody tr', { timeout: 10000 });
  // 用 GUI 新建另一个连接（Fake API 已由 seed 创建，本用例证明 新建→拉取→看到 完整路径）
  await page.locator('#conn-add').click();
  await page.locator('#f-name').fill('E2E Test Conn');
  await page.locator('#f-provider').selectOption('openai');
  await page.locator('#f-url').fill(fake.baseUrl);
  await page.locator('#f-key').fill('sk-e2e-fake');
  await page.getByRole('button', { name: '保存' }).click();
  const testRow = page.locator('tbody tr', { hasText: 'E2E Test Conn' });
  await expect(testRow).toBeVisible({ timeout: 10000 });
  await testRow.locator('[data-models]').click();
  await expect(page.locator('body')).toContainText('已成功获取 3 个模型', { timeout: 15000 });
  // 重新定位行（页面已重渲）
  const testRow2 = page.locator('tbody tr', { hasText: 'E2E Test Conn' });
  await testRow2.locator('[data-view]').click();
  await expect(page.locator('#mm-list')).toContainText('model-A', { timeout: 10000 });
  await expect(page.locator('#mm-list')).toContainText('model-B');
  await expect(page.locator('#mm-list')).toContainText('model-C');
  await expect(page.locator('.mm-source').first()).toContainText('API 获取');
  // 关闭弹窗（必须真正关掉，否则 overlay 会挡住后续用例）
  await page.locator('#modal-overlay .modal-x').click();
  await expect(page.locator('#modal-overlay')).toBeHidden();
});

test('2) 智能体 → 编辑主智能体 → Fake 连接 + model-B → 保存 → 重开仍选中', async () => {
  await page.getByRole('button', { name: '智能体' }).click();
  await page.waitForSelector('.acard', { timeout: 10000 });
  const mainCard = page.locator('.acard', { hasText: '主智能体' });
  await expect(mainCard).toBeVisible({ timeout: 10000 });
  await mainCard.locator('[data-ae]').click();
  // 等待 modal 真正打开（连接下拉渲染完成）
  await page.waitForSelector('#a-conn', { timeout: 10000 });
  // Fake API 由 seed 创建并指向主智能体，所以下拉里一定能找到
  await page.locator('#a-conn').selectOption({ label: 'Fake API' });
  await page.waitForTimeout(300);
  await page.locator('#a-model').click();
  await expect(page.locator('#a-model-dropdown')).toBeVisible({ timeout: 10000 });
  await page.locator('#a-model-dropdown .mm-option[data-model="model-B"]').click();
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(600);
  // 重新打开验证
  const mainCard2 = page.locator('.acard', { hasText: '主智能体' });
  await mainCard2.locator('[data-ae]').click();
  await page.waitForSelector('#a-conn', { timeout: 10000 });
  await expect(page.locator('#a-model')).toHaveValue('model-B');
  await page.getByRole('button', { name: '保存' }).click();
});

test('3) 【主路径】选好模型发送「你好」→ 无 ReferenceError → completed → Spinner 消失', async () => {
  pageErrors = [];
  // 回到聊天
  await closePage();
  await page.locator('#btn-newchat').click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('#input').fill('你好');
  await page.getByRole('button', { name: '发送 ▸' }).click();
  // 收到回复并完成（快任务可能直接跳过「运行中」，直接断言终态）
  await expect(page.locator('#status-text')).toContainText('已完成', { timeout: 30000 });
  await expect(page.locator('.msg.assistant')).toContainText('你好，我是测试智能体。', { timeout: 10000 });
  // Spinner 消失：停止按钮隐藏、发送按钮恢复
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeEnabled();
  // 终态唯一：只有 run_completed，且没有任何 ReferenceError
  const delta = await getTerminalDelta();
  expect(delta).toEqual(['run_completed']);
  expect(pageErrors.filter(e => /models is not defined|ReferenceError/.test(e))).toEqual([]);
});

test('4) 业务失败：model-FAIL → 唯一终态 failed（绝不随后 completed）', async () => {
  await closePage();
  await setMainModel('model-FAIL');
  await page.locator('#input').fill('触发失败');
  await page.getByRole('button', { name: '发送 ▸' }).click();
  await expect(page.locator('#status-text')).toContainText('失败', { timeout: 30000 });
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.waitForTimeout(1500); // 留时间给“迟到的 completed”（若有 bug 会冒出来）
  const delta = await getTerminalDelta();
  expect(delta).toEqual(['run_failed'], '业务失败后不得再出现 run_completed');
});

test('5) 停止：model-HANG + 点停止 → 唯一终态 cancelled', async () => {
  await closePage();
  await setMainModel('model-HANG', { timeout_ms: 120000 });
  await page.locator('#input').fill('停不下来');
  await page.getByRole('button', { name: '发送 ▸' }).click();
  await expect(page.locator('#btn-stop')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1200);
  await page.locator('#btn-stop').click();
  await expect(page.locator('#status-text')).toContainText('已取消', { timeout: 15000 });
  await expect(page.locator('#btn-stop')).toBeHidden();
  await page.waitForTimeout(1500);
  const delta = await getTerminalDelta();
  expect(delta).toEqual(['run_cancelled'], 'cancelled 后不得再出现 run_completed');
});

test('6) 超时：model-HANG + 短 timeout → 唯一终态 timeout', async () => {
  await closePage();
  await setMainModel('model-HANG', { timeout_ms: 8000 });
  await page.locator('#input').fill('超时用例');
  await page.getByRole('button', { name: '发送 ▸' }).click();
  await expect(page.locator('#status-text')).toContainText('超时', { timeout: 30000 });
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.waitForTimeout(1500);
  const delta = await getTerminalDelta();
  expect(delta).toEqual(['run_timeout'], 'timeout 后不得再出现 run_completed');
  // 恢复正常模型
  await setMainModel('model-B', { timeout_ms: 600000 });
});

test('7) 模型来源：手动添加 CUSTOM-X → 重启后仍在(source=manual) → 刷新后不丢', async () => {
  const openFakeModels = async () => {
    await page.getByRole('button', { name: 'API 连接' }).click();
    await page.waitForSelector('tbody tr', { timeout: 10000 });
    const row = page.locator('tbody tr', { hasText: 'Fake API' });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.locator('[data-view]').click();
    await page.waitForSelector('#mm-list', { timeout: 10000 });
  };
  // 手动添加
  await openFakeModels();
  await page.locator('#mm-add').click();
  await page.locator('#mm-add-input').fill('CUSTOM-X');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  // 来源 chip = 手动添加
  await expect(page.locator('.mm-item').filter({ hasText: 'CUSTOM-X' })).toContainText('手动添加');
  // 筛选：手动添加
  await page.locator('.mm-filter [data-filter="manual"]').click();
  await expect(page.locator('#mm-list')).toContainText('CUSTOM-X');
  // 刷新模型（merge 语义：手动模型保留）
  await page.locator('#mm-refresh').click();
  await expect(page.locator('body')).toContainText('已成功获取 3 个模型', { timeout: 15000 });
  await openFakeModels();
  await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  // 重启 App（同一 userData）验证持久化
  await app.close();
  app = await launchApp(userData);
  page = await app.firstWindow();
  await openFakeModels();
  await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  await expect(page.locator('.mm-item').filter({ hasText: 'CUSTOM-X' })).toContainText('手动添加');
});

test('8) 全中文：普通用户可见层无英文残留（品牌/技术名除外）', async () => {
  const bodyText = await page.locator('body').innerText();
  const forbidden = ['Agents 页', 'Main Agent', 'External Agent', '外部 Agent', '子 Agent', '未指定 Agent', '调用外部 Agent', 'Ready', 'Chats', 'Files', 'Running', 'Completed', 'Failed', 'Cancelled', 'Stop'];
  for (const bad of forbidden) {
    expect(bodyText.includes(bad), `页面出现禁止英文「${bad}」`).toBe(false);
  }
  // 品牌保留
  expect(bodyText).toContain('Agent Dev Platform');
});

test('9) 无 JS 致命错误（全程 pageerror 收集）', async () => {
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});
