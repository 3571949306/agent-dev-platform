'use strict';
/**
 * P3 Computer Use Production Hardening — Computer Workspace GUI E2E.
 *
 * Meaningful renderer-level proofs on a REAL Electron window (temporary
 * userData, Fake model API, fully offline):
 *   - availability chip comes from a real probe (honest vocabulary, no READY)
 *   - session view + safety status render through computer:sessions /
 *     computer:diagnostics (P3 IPC)
 *   - window list shows stable identity columns (HWND / DPI)
 *   - action history renders and NEVER contains plaintext secrets
 *   - Stop is wired to the real session-cancel path ({stopped, quiesced})
 *   - structured failure for a nonexistent window (no crash, honest code)
 *   - renderer isolation stays intact (contextIsolation / nodeIntegration)
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake = null;
let app = null;
let page = null;
let userData = null;
const pageErrors = [];

function seedDb(ud, baseUrl) {
  return new Promise((resolve, reject) => {
    const p = spawn(ELECTRON_BIN, [path.join(ROOT, 'test', 'e2e', 'seed-db.js'), ud, baseUrl], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit'
    });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('seed-db exit ' + code))));
  });
}

test.describe.serial('P3 Computer Workspace hardening', () => {
  test.beforeAll(async () => {
    fake = await start(0, {});
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-p3-e2e-'));
    await seedDb(userData, fake.baseUrl);
    const env = { ...process.env, ADP_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__inv = (...a) => window.api.invoke(...a).then(r => (r && typeof r === 'object' && 'data' in r) ? r.data : r); });
  });

  test.afterAll(async () => {
    try { if (app) await app.close(); } catch {}
    try { if (fake) await fake.close(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  });

  async function openComputerPanel() {
    await page.evaluate(() => {
      const b = document.querySelector('.btab[data-btab="computer"]');
      if (b) b.click();
    });
    await page.waitForSelector('#bottom-computer:not(.hidden)', { timeout: 10000 });
    // availability is a REAL probe (PowerShell helper ~2s): wait for the chip
    // to leave its initial 检测中 state instead of guessing a fixed delay.
    await page.waitForFunction(() => {
      const el = document.querySelector('#cp-status');
      return el && !el.textContent.includes('检测中');
    }, null, { timeout: 30000 });
    await page.waitForTimeout(400);
  }

  test('availability chip is an honest probe, never a fake READY', async () => {
    await openComputerPanel();
    const chip = await page.locator('#cp-status').textContent();
    expect(chip).toBeTruthy();
    const HONEST = ['可用', '不可用', '不支持', '未知', '异常'];
    expect(HONEST.some(s => chip.includes(s))).toBeTruthy();
    if (process.platform === 'win32') {
      // a real desktop must produce a real verdict — never 未知
      expect(chip).not.toContain('未知');
    }
    const avail = await page.evaluate(() => window.__inv('computer:availability'));
    expect(['AVAILABLE', 'UNAVAILABLE', 'UNSUPPORTED', 'UNKNOWN', 'ERROR']).toContain(avail.status);
    if (process.platform === 'win32') {
      expect(['AVAILABLE', 'UNAVAILABLE', 'ERROR']).toContain(avail.status);
      expect(typeof avail.interactiveDesktop).toBe('boolean');
    }
  });

  test('P3 session view renders safety status through computer:sessions/diagnostics', async () => {
    await openComputerPanel();
    await page.evaluate(() => { const b = document.querySelector('#cp-sessions'); if (b) b.click(); });
    await page.waitForTimeout(600);
    const out = await page.locator('#cp-out').textContent();
    expect(out).toContain('安全状态');
    const sessions = await page.evaluate(() => window.__inv('computer:sessions'));
    expect(Array.isArray(sessions)).toBeTruthy();
    const diag = await page.evaluate(() => window.__inv('computer:diagnostics'));
    expect(typeof diag.activeHelpers).toBe('number');
    expect(typeof diag.activeSessions).toBe('number');
    expect(typeof diag.tempResidue).toBe('number');
    expect(diag.tempResidue).toBe(0);
    expect(diag.clipboardTransactions).toBe(0);
  });

  test('window list shows stable identity (HWND / DPI columns)', async () => {
    await openComputerPanel();
    await page.evaluate(() => { const b = document.querySelector('#cp-win'); if (b) b.click(); });
    await page.waitForTimeout(2500);
    if (process.platform !== 'win32') return; // nothing to list off-Windows
    const head = await page.locator('#cp-out table.tbl thead').textContent();
    expect(head).toContain('HWND');
    expect(head).toContain('DPI');
    const rows = await page.locator('#cp-out table.tbl tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('action history renders and leaks no plaintext secrets', async () => {
    const SECRET = 'COMPUTER_SECRET_918273';
    await openComputerPanel();
    await page.evaluate(() => { const b = document.querySelector('#cp-history'); if (b) b.click(); });
    await page.waitForTimeout(600);
    const text = await page.locator('#cp-out').textContent();
    expect(text).toBeTruthy();
    expect(text).not.toContain(SECRET);
    const history = await page.evaluate(() => window.__inv('computer:history', 100));
    expect(Array.isArray(history)).toBeTruthy();
    expect(JSON.stringify(history)).not.toContain(SECRET);
  });

  test('Stop is wired to the real session-cancel path', async () => {
    const stop = await page.evaluate(() => window.__inv('computer:stop'));
    expect(stop).toBeTruthy();
    expect(typeof stop.stopped).toBe('number');
    expect(typeof stop.quiesced).toBe('boolean');
    expect(stop.residual).toBe(0);
    // after Stop nothing may remain alive
    const active = await page.evaluate(() => window.__inv('computer:active'));
    expect(active.active).toBe(0);
  });

  test('nonexistent window focus returns a structured failure, never a crash', async () => {
    const before = pageErrors.length;
    const r = await page.evaluate(() => window.__inv('computer:focus', '绝对不存在的窗口-p3-e2e').catch(e => ({ err: String(e && e.message || e) })));
    // structured failure: either a transport error or an honest {ok:false}
    const failed = (r && (r.ok === false || r.err));
    expect(failed).toBeTruthy();
    if (r && r.err === undefined) {
      expect(String(r.error || r.code || '')).toBeTruthy(); // honest reason surfaced
    }
    await page.waitForTimeout(300);
    expect(pageErrors.length).toBe(before); // renderer stayed clean
  });

  test('renderer isolation stays intact (no node globals leak)', async () => {
    const leak = await page.evaluate(() => ({
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      hasChildProcess: !!(window.require && (() => { try { return window.require('child_process'); } catch { return null; } })())
    }));
    expect(leak.hasRequire).toBeFalsy();
    expect(leak.hasProcess).toBeFalsy();
    expect(leak.hasChildProcess).toBeFalsy();
  });
});
