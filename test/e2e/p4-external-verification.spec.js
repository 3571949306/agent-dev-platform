'use strict';

/**
 * P4 External Agent verification GUI truth states (Cases 160-192).
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
let closureRoot;
const rendererErrors = [];
const assertedSecurityBlocks = [];

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
    closureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-p4-closure-'));
    const env = {
      ...process.env,
      ADP_USER_DATA: userData,
      NODE_ENV: 'test',
      // This is deliberately present: GUI consent must still win.
      ADP_P4_ALLOW_REAL_AGENT_TASKS: '1',
      RUN_REAL_EXTERNAL_AGENT_TESTS: '1'
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/Refused to execute inline script.*Content Security Policy/i.test(text)) assertedSecurityBlocks.push(text);
      else rendererErrors.push(`console:${text}`);
    });
    page.on('pageerror', error => rendererErrors.push(`pageerror:${error.message}`));
    await page.evaluate(() => {
      window.__p4Unhandled = [];
      window.addEventListener('unhandledrejection', event => window.__p4Unhandled.push(String(event.reason && event.reason.message || event.reason)));
    });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await openAgentCenter();
  });

  test.afterAll(async () => {
    try { if (app) await app.close(); } catch { /* already closed */ }
    try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (closureRoot) fs.rmSync(closureRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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

  test('167) each verification card renders all seven canonical dimensions', async () => {
    const card = page.locator('#hub-cards .acard[data-hub-id="codex"]');
    const keys = await card.locator('.ver-k').allTextContents();
    expect(keys).toEqual(['安装', '认证', '本机探测', '协议实现', '真实本机协议', '真实响应', '项目任务']);
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
    const values = await page.locator('#hub-cards .ver-row').filter({ hasText: '项目任务' }).locator('.ver-v').allTextContents();
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
    await expect(card).toContainText('Project Task: NOT_VERIFIED');
  });

  test('180) Safe Test removes its owned temporary verification repository', async () => {
    const residue = fs.existsSync(SAFE_TEMP) ? fs.readdirSync(SAFE_TEMP) : [];
    expect(residue).toEqual([]);
  });

  test('181) Safe Verification reports exact zero dispatch/provider/model/paid calls', async () => {
    const result = await invoke('hub:verify-safe', 'codex');
    expect(result.callCountEvidence).toBe('EXACT');
    expect([result.taskDispatches, result.platformProviderCalls, result.externalModelCalls, result.paidCalls]).toEqual([0, 0, 0, 0]);
  });

  test('182) canonical env opt-in cannot bypass a GUI request with explicitConsent=false', async () => {
    const result = await invoke('hub:verify-real', { agentId: 'codex', explicitConsent: false });
    expect(result.errorCode).toBe('REAL_VERIFICATION_REQUIRES_CONFIRMATION');
    expect(result.taskDispatches).toBe(0);
  });

  test('183) Claude external-login UNKNOWN remains UNKNOWN before any real task', async () => {
    const available = await invoke('hub:available');
    const claude = available.find(item => item.id === 'claude-code');
    expect(claude).toBeTruthy();
    expect(claude.auth && claude.auth.authenticated).not.toBe(true);
    if (claude.auth) expect(claude.auth.state).not.toBe('AUTHENTICATED');
  });

  test('184) WorkBuddy availability never hides missing or incomplete window identity', async () => {
    const available = await invoke('hub:available');
    const verification = await invoke('hub:verification');
    const workbuddy = available.find(item => item.id === 'workbuddy');
    expect(workbuddy).toBeTruthy();
    if (workbuddy.available) {
      expect(workbuddy.windowIdentity && workbuddy.windowIdentity.hwnd).toBeTruthy();
      expect(workbuddy.windowIdentity && workbuddy.windowIdentity.pid).toBeTruthy();
    } else {
      expect(['NOT_INSTALLED', 'UNAVAILABLE', 'AUTH_UNKNOWN', 'ERROR']).toContain(workbuddy.availability);
    }
    const localTruth = available.map(item => ({
      id: item.id,
      transport: item.transport,
      installed: item.installed,
      configured: item.configured,
      available: item.available,
      auth: item.auth && item.auth.state || 'UNKNOWN',
      level: verification[item.id] && verification[item.id].level || 'not_verified',
      response: verification[item.id] && verification[item.id].summary && verification[item.id].summary.agentResponseVerified === true,
      projectTask: verification[item.id] && verification[item.id].summary && verification[item.id].summary.agentTaskVerified === true
    }));
    console.log(`P4_LOCAL_ENVIRONMENT=${JSON.stringify(localTruth)}`);
  });

  test('185) ambiguous desktop detection fixture stays unavailable and receives no verification upgrade', async () => {
    await invoke('hub:testRegisterAdapter', {
      id: 'workbuddy-ambiguous-e2e',
      manifest: { id: 'workbuddy-ambiguous-e2e', displayName: 'WorkBuddy Ambiguous Fixture', source: 'external', transport: 'desktop', capabilities: { coding: true, filesystem: true } },
      transport: 'desktop', capabilities: ['coding', 'filesystem'], available: false,
      detectResult: { available: false, installed: false, configured: false, ambiguous: true, detail: 'AMBIGUOUS_EXTERNAL_AGENT_WINDOW' }
    });
    const available = await invoke('hub:available');
    const fixture = available.find(item => item.id === 'workbuddy-ambiguous-e2e');
    expect(fixture.available).toBe(false);
    const verification = await invoke('hub:verification');
    expect(verification['workbuddy-ambiguous-e2e'].level).not.toBe('real_protocol_verified');
  });

  test('186) Response and Project Task are distinct GUI facts', async () => {
    await openAgentCenter();
    const text = await page.locator('[data-hub-id="workbuddy"]').innerText();
    expect(text).toContain('Response:');
    expect(text).toContain('Project Task:');
    expect(text).not.toContain('Fully Verified');
  });

  test('187) response-only evidence renders UNKNOWN calls without project-writer verification', async () => {
    await invoke('hub:testRegisterAdapter', {
      id: 'p4-callcount-e2e',
      manifest: { id: 'p4-callcount-e2e', displayName: 'P4 Call Count Fixture', source: 'external', transport: 'http', capabilities: { coding: true, filesystem: true } },
      transport: 'http', capabilities: ['coding', 'filesystem'],
      detectResult: { available: true, installed: true, configured: true, version: null, path: null }
    });
    await invoke('hub:verification');
    await invoke('hub:testRecordVerificationEvidence', 'p4-callcount-e2e', {
      type: 'agent_response', status: 'pass', verificationKind: 'response',
      source: 'P4 E2E response fixture', taskDispatches: 1, platformProviderCalls: 0,
      externalModelCalls: null, paidCalls: null, callCountEvidence: 'UNOBSERVABLE_EXTERNAL_RUNTIME'
    });
    await openAgentCenter();
    const card = page.locator('[data-hub-id="p4-callcount-e2e"]');
    await expect(card).toContainText('External Model Calls: UNKNOWN');
    await expect(card).toContainText('Paid Calls: UNKNOWN');
    await expect(card).toContainText('Project Task: NOT_VERIFIED');
  });

  test('188) response-only evidence never renders a project-task or Fully Verified claim', async () => {
    const card = page.locator('[data-hub-id="p4-callcount-e2e"]');
    const text = await card.innerText();
    expect(text).toContain('Response: Verified');
    expect(text).toContain('Project Task: NOT_VERIFIED');
    expect(text).not.toContain('Fully Verified');
  });

  test('189) adapter-completed mutation with no filesystem effect appears FAILED', async () => {
    const id = 'p4-false-completion-e2e';
    await invoke('hub:testRegisterAdapter', {
      id,
      manifest: { id, displayName: 'P4 False Completion Fixture', source: 'external', transport: 'sdk', capabilities: { coding: true, filesystem: true } },
      transport: 'sdk', capabilities: ['coding', 'filesystem'], resultText: 'claimed done'
    });
    const started = await invoke('hub:start', id, {
      goal: 'create expected file', projectRoot: closureRoot, required: ['coding', 'filesystem'],
      verificationExpectedFile: 'never-created.txt', verificationExpectedContent: 'EXPECTED'
    });
    await expect.poll(async () => (await invoke('hub:status', started.runId)).status).toBe('failed');
    const result = await invoke('hub:result', started.runId);
    expect(result.status).toBe('failed');
    expect(result.result.effectObserved).toBe(false);
    expect(result.result.verificationStatus).toBe('EXTERNAL_EFFECT_NOT_OBSERVED');
  });

  test('190) pending quiescence is visible in diagnostics and Problems until cleanup', async () => {
    const id = 'p4-pending-terminal-e2e';
    await invoke('hub:testRegisterAdapter', {
      id,
      manifest: { id, displayName: 'P4 Pending Terminal Fixture', source: 'external', transport: 'sdk', capabilities: { coding: true } },
      transport: 'sdk', capabilities: ['coding'], quiesced: false, resultText: 'response'
    });
    const started = await invoke('hub:start', id, { goal: 'read only response', projectRoot: closureRoot, required: [], readOnly: true, responseOnly: true });
    await expect.poll(async () => {
      const diagnostics = await invoke('hub:testDiagnostics');
      return diagnostics.hub.controls.some(control => control.runId === started.runId && control.pendingTerminal && control.lockHeld);
    }).toBe(true);
    const problems = await invoke('problems:list', { includeResolved: true });
    expect(problems.some(problem => problem.code === 'AGENT_CANCEL_NOT_QUIESCED'
      && (problem.run_id === started.runId || problem.runId === started.runId))).toBe(true);
    await invoke('hub:testSetAdapterQuiesced', id, true);
    await expect.poll(async () => (await invoke('hub:status', started.runId)).status).toBe('completed');
    const diagnostics = await invoke('hub:testDiagnostics');
    expect(diagnostics.hub.pendingTerminalFinalizers).toBe(0);
    expect(diagnostics.projectLock.readLocks).toEqual([]);
  });

  test('191) nested secret fixture is absent from evidence and Agent Center DOM', async () => {
    const secrets = ['ADP_P4_SECRET_91A7', 'ADP_P4_TOKEN_83B2', 'ADP_P4_COOKIE_15C4'];
    await invoke('hub:testRecordVerificationEvidence', 'p4-callcount-e2e', {
      type: 'protocol', status: 'fail', reason: secrets[0],
      details: { nested: [secrets[0], `Authorization: Bearer ${secrets[1]}`, `Cookie=${secrets[2]}`] }
    });
    const verification = await invoke('hub:verification');
    const serialized = JSON.stringify(verification['p4-callcount-e2e']);
    await openAgentCenter();
    const dom = await page.locator('#hub-cards').innerHTML();
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      expect(dom).not.toContain(secret);
    }
  });

  test('192) closure scenarios leave zero unexpected renderer errors', async () => {
    const unhandled = await page.evaluate(() => window.__p4Unhandled || []);
    expect(unhandled).toEqual([]);
    for (const blocked of assertedSecurityBlocks) expect(blocked).toMatch(/script-src 'self'/);
    expect(rendererErrors).toEqual([]);
  });
});
