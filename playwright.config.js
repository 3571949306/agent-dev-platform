'use strict';
/**
 * Playwright 配置 —— GUI E2E（v2.3.1：真实 Electron 窗口 + 本地 Fake API）。
 *
 * 运行：
 *   npm run e2e
 *
 * 特性：
 *  - 每次运行使用临时 userData（%TEMP%\adp-e2e-<uuid>），不污染真实用户数据
 *  - 用例自建 Fake API 服务器（test/e2e/fake-api.js），全程离线
 *  - 不需要 Playwright 浏览器（Electron 自带 Chromium），故不配置 devices
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'test/e2e/report' }]],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
