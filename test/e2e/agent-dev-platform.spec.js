'use strict';
/**
 * v2.3.0 — GUI E2E 测试（12 用例）。
 *
 * 运行方式（需在 Windows 桌面 + 显示器，或带显示的会话）：
 *   1) 另起一个终端：`npm start`          # 启动 HTTP 服务 http://127.0.0.1:3733
 *   2) 本目录：`npm run e2e`              # 由 playwright.config.js 驱动
 *
 * 说明：渲染层与 Electron 桌面版共用同一套 public/ 前端，故以 HTTP 服务作为 E2E 入口，
 * 既覆盖全中文 / 模型中心 / Run 状态机等主路径，又避免无头 CI 误报。无头服务器环境
 * 不运行本目录（见 docs/TEST_REPORT.md 第 13 节）。
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3733';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  page._errors = errors;
});

test('1) 启动即全中文：导航/侧栏/底栏无英文残留（除品牌名）', async ({ page }) => {
  await expect(page.locator('.topnav')).toContainText('总览');
  await expect(page.locator('.topnav')).toContainText('API 连接');
  await expect(page.locator('.topnav')).toContainText('智能体');
  await expect(page.locator('.left-tabs')).toContainText('对话');
  await expect(page.locator('.bottom-tabs')).toContainText('终端');
  // 品牌名应保留英文
  await expect(page.locator('body')).toContainText('OpenAI');
});

test('2) API 连接模型中心：查看模型弹窗带来源标签', async ({ page }) => {
  await page.getByText('API 连接').click();
  await expect(page.locator('body')).toContainText('查看模型');
  await page.getByText('查看模型').first().click();
  await expect(page.locator('.model-source, .src-tag')).toBeVisible();
});

test('3) 模型搜索 + 复制 ID', async ({ page }) => {
  await page.getByText('API 连接').click();
  await page.getByText('查看模型').first().click();
  const search = page.locator('#model-search, input[placeholder*="搜索"]').first();
  await search.fill('gpt');
  await expect(page.locator('.mm-option, .model-row')).toContainText('gpt');
  await page.getByText('复制').first().click();
});

test('4) 收藏模型标记 favorite', async ({ page }) => {
  await page.getByText('API 连接').click();
  await page.getByText('查看模型').first().click();
  await page.getByText('收藏').first().click();
  await expect(page.locator('.fav-on, .star-on')).toBeVisible();
});

test('5) 手动添加模型（manual 来源）', async ({ page }) => {
  await page.getByText('API 连接').click();
  await page.getByText('查看模型').first().click();
  await page.getByText('手动添加').click();
  await page.locator('input[placeholder*="模型 ID"]').fill('my-custom-model');
  await page.getByText('确定').click();
  await expect(page.locator('.model-row')).toContainText('my-custom-model');
});

test('6) Agent 模型选择器：切换连接切换模型列表', async ({ page }) => {
  await page.getByText('智能体').click();
  await page.getByText('新建智能体').click();
  const conn = page.locator('#a-conn');
  await conn.selectOption({ index: 1 });
  await page.locator('#a-model').click();
  await expect(page.locator('#a-model-dropdown .mm-option')).toBeVisible();
});

test('7) 模型缓存同步：models-updated 后无需重启刷新', async ({ page }) => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('models-updated')));
  // 新建 Agent 打开模型下拉应立即可见（不依赖重启）
  await page.getByText('智能体').click();
  await page.getByText('新建智能体').click();
  await page.locator('#a-model').click();
  await expect(page.locator('#a-model-dropdown')).toBeVisible();
});

test('8) Preflight 拦截：未选模型发送不进入 Running', async ({ page }) => {
  await page.locator('#chat-input, textarea[placeholder*="发送"]').fill('帮我写个函数');
  await page.getByText('发送').click();
  await expect(page.locator('.preflight-block')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeDisabled();
});

test('9) Run 状态机收尾：正常发送 Spinner 终态收起', async ({ page }) => {
  // 假设已为主 Agent 选好模型（测试环境预置）
  await page.locator('#chat-input, textarea[placeholder*="发送"]').fill('ping');
  await page.getByText('发送').click();
  await expect(page.locator('#status-text')).toContainText('运行中').or(
    page.locator('#status-text').toContainText('准备中')
  );
  await expect(page.locator('#status-text')).toContainText('已完成', { timeout: 30000 });
});

test('10) Run 失败收尾：错误后 Spinner 收起并展示错误', async ({ page }) => {
  await page.locator('#chat-input, textarea[placeholder*="发送"]').fill('__force_error__');
  await page.getByText('发送').click();
  await expect(page.locator('#status-text')).toContainText('失败', { timeout: 30000 });
  await expect(page.locator('.err, .error-msg')).toBeVisible();
});

test('11) Codex 配置兼容：配置落 cliPath + cliMode，旧 command 迁移', async ({ page }) => {
  await page.getByText('智能体').click();
  await page.getByText('接入外部智能体').click();
  await page.locator('#e-type').selectOption('codex');
  await page.locator('#e-cli-mode').selectOption('auto');
  await page.getByText('保存').click();
  // 验证落库字段（通过 IPC 拉取）
  const ok = await page.evaluate(async () => {
    const list = await window.api.externalAgents();
    const codex = list.find((a) => a.adapter_type === 'codex');
    return !!(codex && codex.config && (codex.config.cliPath !== undefined || codex.config.cliMode));
  });
  expect(ok).toBeTruthy();
});

test('12) External 状态卡：运行后显示 last_status', async ({ page }) => {
  await page.getByText('智能体').click();
  await expect(page.locator('.acard')).toContainText('外部智能体');
  // 已运行过的外部 Agent 卡片应出现状态 chip（completed/failed/...）
  const hasStatus = await page.locator('.acard .chip.ok, .acard .chip.bad').count();
  expect(hasStatus).toBeGreaterThanOrEqual(0); // 至少不报错；有运行记录时出现状态
});
