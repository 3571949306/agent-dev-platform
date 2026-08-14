'use strict';

/**
 * P4 External Agent verification GUI truth states (Cases 160-180).
 * One real Electron renderer/main-process pair; no model provider is configured.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');
const SAFE_TEMP = path.join(os.tmpdir(), 'adp-external-safe-verification');

let app;
let page;
let userData;

function seedDb(ud) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [path.join(ROOT, 'test', 'e2e', 'seed-db.js'), ud, ''], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`seed-db exited ${code}`)));
  });
}

async function invoke(channel, ...args) {
  return page.evaluate(async ({ channel, args }) => {
    const response = await window.api.invoke(channel, ...args);
    return response && response.data !== undefined ? response.data : response;
  }, { channel, args });
}

async function openAgentCenter() {
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  await page.waitForSelector('#hub-cards .acard[data-hub-id]', { timeout: 30000 });
}

test.describe.serial('P4 External Agent Verification GUI', () => {
  test.beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-p4-ext-'));
    await seedDb(userData);
    const env = { ...process.env, ADP_USER_DATA: userData, NODE_ENV: 'test' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await openAgentCenter();
  });

  test.afterAll(async () => {
    try { if (app) await app.close(); } catch { /* already closed */ }
    try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('160) Agent Center exposes every registered external runtime from the Hub registry', async () => {
    const manifests = await invoke('hub:manifests');
    const expected = manifests.filter(item => item.source === 'external').map(item => item.id).sort();
    const cards = await page.locator('#hub-cards [data-hub-id]').evaluateAll(nodes => nodes.map(node => node.dataset.hubId).sort());
    for (const id of expected) expect(cards).toContain(id);
    expect(expected.length).toBeGreaterThanOrEqual(6);
  });

  test('161) every external card offers Safe Test while native cards do not', async () => {
    const manifests = await invoke('hub:manifests');
    for (const manifest of manifests) {
      const count = await page.locator(`[data-hub-id="${manifest.id}"] [data-hub-safe]`).count();
      expect(count).toBe(manifest.source === 'external' ? 1 : 0);
    }
  });

  test('162) every external card exposes Real Verification as a separate action', async () => {
    const externalCards = page.locator('#hub-cards .acard:has([data-hub-real])');
    const safeCount = await page.locator('#hub-cards [data-hub-safe]').count();
    expect(await externalCards.count()).toBe(safeCount);
    await expect(externalCards.first().locator('[data-hub-real]')).toHaveText('Real Verification');
  });

  test('163) Safe Test is explicitly labelled zero quota and zero model calls', async () => {
    const buttons = page.locator('[data-hub-safe]');
    expect(await buttons.count()).toBeGreaterThan(0);
    for (let i = 0; i < await buttons.count(); i++) {
      await expect(buttons.nth(i)).toHaveAttribute('title', '0 quota / 0 model calls');
    }
  });

  test('164) availability is rendered only from the strict truth-state vocabulary', async () => {
    const values = await page.locator('#hub-cards .acard .chip').evaluateAll(nodes =>
      nodes.map(node => node.textContent.trim()).filter(text => text.startsWith('状态：')).map(text => text.slice(3))
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'ERROR']).toContain(value);
  });

  test('165) Health is displayed independently from availability and verification', async () => {
    const card = page.locator('#hub-cards .acard[data-hub-id="codex"]');
    await expect(card.locator('.chip').filter({ hasText: '状态：' })).toHaveCount(1);
    await expect(card.locator('.chip').filter({ hasText: '运行：' })).toHaveCount(1);
    await expect(card.locator('.chip').filter({ hasText: '验证：' })).toHaveCount(1);
  });

  test('166) verification labels come from the registry level rather than a health alias', async () => {
    const labels = await page.locator('#hub-cards .chip[title*="验证级别"]').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/^验证：/);
      expect(label).not.toMatch(/健康|降级|不可用/);
    }
  });

  test('167) each verification card renders all six canonical dimensions', async () => {
    const card = page.locator('#hub-cards .acard[data-hub-id="codex"]');
    const keys = await card.locator('.ver-k').allTextContents();
    expect(keys).toEqual(['安装', '认证', '本机探测', '协议实现', '真实本机协议', '真实模型任务']);
  });

  test('168) Installed and Configured are shown as separate facts', async () => {
    const cardText = await page.locator('#hub-cards .acard[data-hub-id="opencode"]').innerText();
    expect(cardText).toContain('Installed:');
    expect(cardText).toContain('Configured:');
  });

  test('169) transport and actual runtime have distinct fields', async () => {
    const cardText = await page.locator('#hub-cards .acard[data-hub-id="claude-code"]').innerText();
    expect(cardText).toContain('Transport:');
    expect(cardText).toContain('Runtime:');
  });

  test('170) default startup never claims a real task was verified', async () => {
    const values = await page.locator('#hub-cards .ver-row').filter({ hasText: '真实模型任务' }).locator('.ver-v').allTextContents();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.trim()).toBe('未验证');
  });

  test('171) unavailable agents are never presented as Ready or verified', async () => {
    const unavailable = page.locator('#hub-cards .acard', { has: page.locator('.chip', { hasText: '状态：UNAVAILABLE' }) });
    expect(await unavailable.count()).toBeGreaterThan(0);
    for (let i = 0; i < await unavailable.count(); i++) {
      const text = await unavailable.nth(i).innerText();
      expect(text).not.toContain('Real Task Verified: Yes');
    }
  });

  test('172) Agent Center DOM does not expose authorization, cookie or API-secret values', async () => {
    const html = await page.locator('#hub-cards').innerHTML();
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/i);
    expect(html).not.toMatch(/Cookie=[^;\s]+/i);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{8,}/i);
  });

  test('173) sessions IPC exposes display state but no credential-bearing keys', async () => {
    const sessions = await invoke('hub:sessions');
    const serialized = JSON.stringify(sessions);
    expect(serialized).not.toMatch(/apiKey|password|refreshToken|accessToken|cookie/i);
    expect(Array.isArray(sessions.sessions)).toBe(true);
    expect(Array.isArray(sessions.authStates)).toBe(true);
  });

  test('174) backend blocks Real Verification when explicit consent is absent', async () => {
    const result = await invoke('hub:verify-real', { agentId: 'codex', explicitConsent: false });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('REAL_VERIFICATION_REQUIRES_CONFIRMATION');
  });

  test('175) blocked Real Verification reports exactly zero paid and model calls', async () => {
    const result = await invoke('hub:verify-real', { agentId: 'codex', explicitConsent: false });
    expect(result.paidCalls).toBe(0);
    expect(result.modelCalls).toBe(0);
  });

  test('176) dismissing the Real Verification dialog sends no task', async () => {
    let dialogSeen = false;
    page.once('dialog', async dialog => { dialogSeen = true; await dialog.dismiss(); });
    await page.locator('[data-hub-real="codex"]').click();
    await page.waitForTimeout(200);
    expect(dialogSeen).toBe(true);
    await expect(page.locator('[data-hub-real="codex"]')).toBeEnabled();
  });

  test('177) Real Verification confirmation explains quota risk and temporary-project isolation', async () => {
    let message = '';
    page.once('dialog', async dialog => { message = dialog.message(); await dialog.dismiss(); });
    await page.locator('[data-hub-real="codex"]').click();
    await page.waitForTimeout(100);
    expect(message).toContain('订阅/API 使用额度');
    expect(message).toContain('临时项目');
    expect(message).toContain('不会修改你的开发项目');
  });

  test('178) Safe Test returns real detection evidence with zero model/provider calls', async () => {
    const result = await invoke('hub:verify-safe', 'codex');
    expect(result.agentId).toBe('codex');
    expect(result.paidCalls).toBe(0);
    expect(result.modelCalls).toBe(0);
    expect(result.detection).toBeTruthy();
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  test('179) Safe Test evidence refreshes Last Verified without claiming a real task', async () => {
    await openAgentCenter();
    const card = page.locator('#hub-cards .acard[data-hub-id="codex"]');
    await expect(card).toContainText('Last Verified:');
    await expect(card).not.toContainText('Last Verified: Never');
    await expect(card).toContainText('Real Task Verified: No');
  });

  test('180) Safe Test removes its owned temporary verification repository', async () => {
    const residue = fs.existsSync(SAFE_TEMP) ? fs.readdirSync(SAFE_TEMP) : [];
    expect(residue).toEqual([]);
  });
});
