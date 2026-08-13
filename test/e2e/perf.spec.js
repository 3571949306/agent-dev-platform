'use strict';
/**
 * v2.9.9 Phase B Final — B34 Responsive Matrix + B35 Renderer Performance Baseline。
 *
 * 只记录机器结果（PERF_* / RESPONSIVE_*），不制定虚构指标。
 * 全程离线：本地 Fake API + 临时 userData。
 */

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake;
let app;
let page;
let userData;

function runElectronNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [script, ...args], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

test.describe.serial('B34/B35 Responsive + Performance Baseline', () => {
  test.beforeAll(async () => {
    fake = await start(0, { workbench: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-perf-e2e-'));
    await runElectronNode(path.join(ROOT, 'test', 'e2e', 'seed-db.js'), [userData, fake.baseUrl]);
    const env = { ...process.env, ADP_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(400);
  });

  test.afterAll(async () => {
    try { if (app) await app.close(); } catch {}
    try { if (fake) await fake.close(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  });

  test('B35 boot -> workbench ready measured from real marks', async () => {
    const bootMs = await page.evaluate(() => window.__adpBench.bootMs());
    expect(Number.isFinite(bootMs)).toBeTruthy();
    expect(bootMs).toBeGreaterThan(0);
    console.log(`PERF_BOOT_TO_WORKBENCH_MS=${Math.round(bootMs)}`);
  });

  test('B35 activity switch measured on real page transitions', async () => {
    const durations = [];
    for (const target of ['connections', 'agents', 'skills', 'workflows', 'diagnostics']) {
      const ms = await page.evaluate(async (pageName) => {
        const t0 = performance.now();
        const btn = document.querySelector(`[data-page="${pageName}"]`);
        if (!btn) return -1;
        btn.click();
        // 等待 LOADING 态被真实内容替换（error/ready/empty 任一）
        for (let i = 0; i < 200; i++) {
          const body = document.querySelector('#page-body');
          if (body && !body.querySelector('[data-page-state="loading"]') && body.innerHTML.length > 40) break;
          await new Promise(r => setTimeout(r, 25));
        }
        return performance.now() - t0;
      }, target);
      expect(ms).toBeGreaterThanOrEqual(0);
      durations.push({ target, ms: Math.round(ms) });
    }
    for (const d of durations) console.log(`PERF_ACTIVITY_SWITCH_${d.target.toUpperCase()}_MS=${d.ms}`);
  });

  test('B35 open 2000-line file render measured on real path', async () => {
    const ms = await page.evaluate(() => window.__adpBench.openLargeFile(2000));
    expect(Number.isFinite(ms)).toBeTruthy();
    const renderedLines = await page.evaluate(() => document.querySelectorAll('#workspace-file-view .code-line').length);
    expect(renderedLines).toBeGreaterThan(0);
    console.log(`PERF_OPEN_2000_LINE_FILE_MS=${Math.round(ms)}`);
  });

  test('B35 render 1000 timeline events through real ingest path', async () => {
    const ms = await page.evaluate(() => window.__adpBench.ingestTimelineEvents(1000));
    expect(Number.isFinite(ms)).toBeTruthy();
    console.log(`PERF_INGEST_1000_EVENTS_MS=${Math.round(ms)}`);
  });

  test('B35 render 500 terminal updates with bounded DOM', async () => {
    // 先切到终端面板确保 DOM 目标存在
    await page.evaluate(() => { const b = document.querySelector('.btab[data-btab="terminal"]'); if (b) b.click(); });
    const ms = await page.evaluate(() => window.__adpBench.terminalUpdates(500));
    expect(Number.isFinite(ms)).toBeTruthy();
    // bounded DOM：term-out 的文本总量不超过 200KB 上限 + 少量余量
    const bytes = await page.evaluate(() => {
      const out = document.querySelector('#term-out');
      return out ? (out.textContent || '').length : 0;
    });
    expect(bytes).toBeLessThan(220 * 1024);
    console.log(`PERF_TERMINAL_500_UPDATES_MS=${Math.round(ms)}`);
    console.log(`PERF_TERMINAL_DOM_BYTES=${bytes}`);
  });

  test('B34 responsive matrix keeps composer + stop + pages usable', async () => {
    // 前置：关闭可能存在的管理页 overlay，并回到对话工作台（前面的文件预览测试会切走 task-workspace）
    await page.evaluate(() => { const c = document.querySelector('#page-close'); if (c) c.click(); });
    await page.evaluate(() => { const b = document.querySelector('[data-act="chat"]'); if (b) b.click(); });
    await page.waitForTimeout(400);
    const sizes = [
      [1280, 720],
      [1366, 768],
      [1920, 1080],
      [2560, 1440]
    ];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.waitForTimeout(350);

      // Composer 可见（B34 硬约束）
      const composerVisible = await page.evaluate(() => {
        const c = document.querySelector('#composer');
        if (!c) return false;
        const r = c.getBoundingClientRect();
        return r.width > 100 && r.height > 30;
      });
      expect(composerVisible, `composer visible at ${w}x${h}`).toBeTruthy();

      // Send/Stop 至少一个可见（Idle=Send / Running=Stop）
      const actionVisible = await page.evaluate(() => {
        const send = document.querySelector('#btn-send');
        const stop = document.querySelector('#btn-stop');
        const shown = el => el && !el.classList.contains('hidden') && el.getBoundingClientRect().width > 0;
        return shown(send) || shown(stop);
      });
      expect(actionVisible, `send/stop visible at ${w}x${h}`).toBeTruthy();

      // 关键页面在小尺寸仍可渲染（READY/EMPTY/ERROR 任一，绝不卡在 LOADING）
      const diagOk = await page.evaluate(async () => {
        const btn = document.querySelector('[data-page="diagnostics"]');
        if (!btn) return false;
        btn.click();
        for (let i = 0; i < 240; i++) {
          const body = document.querySelector('#page-body');
          if (body && !body.querySelector('[data-page-state="loading"]') && body.innerHTML.length > 40) return true;
          await new Promise(r => setTimeout(r, 25));
        }
        return false;
      });
      expect(diagOk, `diagnostics renders at ${w}x${h}`).toBeTruthy();

      // 小桌面 Inspector 自动收起（中心工作区不消失）；大尺寸可折叠可用
      const inspectorState = await page.evaluate(() => {
        const right = document.querySelector('#right');
        return right ? right.classList.contains('hidden') : true;
      });
      if (w <= 1366) expect(inspectorState, `inspector auto-collapsed at ${w}x${h}`).toBeTruthy();
      const centerAlive = await page.evaluate(() => {
        const center = document.querySelector('#center') || document.querySelector('#workspace-tabs');
        if (!center) return false;
        const r = center.getBoundingClientRect();
        return r.width > 200;
      });
      expect(centerAlive, `center workspace alive at ${w}x${h}`).toBeTruthy();

      console.log(`RESPONSIVE_${w}x${h}=PASS`);
    }
  });
});
