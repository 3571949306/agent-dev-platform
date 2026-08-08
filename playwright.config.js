'use strict';
/**
 * Playwright 配置 —— GUI E2E（仅 Windows 桌面 + 显示器环境运行）。
 * 渲染层与 Electron 桌面版共用同一套 public/ 前端，故以本地 HTTP 服务为入口。
 *
 * 前置：
 *   npm start                # 另起终端，启动 http://127.0.0.1:3733
 * 运行：
 *   npm run e2e
 */
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'test/e2e/report' }]],
  use: {
    baseURL: process.env.E2E_BASE || 'http://127.0.0.1:3733',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});
