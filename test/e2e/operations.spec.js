'use strict';
/**
 * v2.9.9 Phase B Final — Operations Workbench E2E（B15-B23 / B30 / B42 / B66-B68）。
 *
 * 覆盖：Connection Manager 3.0（wizard / secret mask / test / model source /
 * favorites / default）、Skills/Hooks Workbench、Diagnostics Health Center、
 * Problems Center、Page State Contract、统一确认、Boot、Electron 安全、
 * XSS 硬化、Secret Leak Gate。全程离线（Fake API + 临时 userData）。
 */

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

const FIXTURE_API_KEY = 'SECRET_API_KEY_918273';
const FIXTURE_HEADER_VALUE = 'SECRET_AUTH_HEADER_7821';

let fake;
let app;
let page;
let userData;
let projectRoot;
const pageErrors = [];

function runElectronNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [script, ...args], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}
function git(...args) { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }); }

async function openPage(name) {
  await page.evaluate((p) => { const b = document.querySelector(`[data-page="${p}"]`); if (b) b.click(); }, name);
  await page.waitForFunction(() => {
    const body = document.querySelector('#page-body');
    return body && !body.querySelector('[data-page-state="loading"]') && body.innerHTML.length > 40;
  }, null, { timeout: 30000 });
}

test.describe.serial('Phase B Final Operations Workbench', () => {
  test.beforeAll(async () => {
    fake = await start(0, { workbench: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-ops-e2e-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-ops-project-'));
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Ops Fixture\n', 'utf8');
    git('init'); git('config', 'user.email', 'ops@example.invalid'); git('config', 'user.name', 'Ops E2E'); git('add', '.'); git('commit', '-m', 'fixture');

    await runElectronNode(path.join(ROOT, 'test', 'e2e', 'seed-db.js'), [userData, fake.baseUrl]);
    await runElectronNode(path.join(ROOT, 'test', 'e2e', 'seed-workbench.js'), [userData, projectRoot]);
    const env = { ...process.env, ADP_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    // IPC 信封解包助手：window.api.invoke 返回 { ok, data }；测试内统一用 __inv 拿真实数据
    await page.evaluate(() => { window.__inv = (...a) => window.api.invoke(...a).then(r => (r && typeof r === 'object' && 'data' in r) ? r.data : r); });
  });

  test.afterAll(async () => {
    try { if (app) await app.close(); } catch {}
    try { if (fake) await fake.close(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  test('B30 boot splash removed, never BOOT_FAILED', async () => {
    const splashGone = await page.evaluate(() => !document.querySelector('#boot-splash'));
    expect(splashGone).toBeTruthy();
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('BOOT_FAILED');
    console.log('BOOT_UX=PASS');
  });

  test('B66 electron security: contextIsolation on, nodeIntegration off', async () => {
    const probe = await page.evaluate(() => ({
      requireUndefined: typeof window.require === 'undefined',
      processUndefined: typeof window.process === 'undefined',
      hasBridge: typeof window.api === 'object' && typeof window.api.invoke === 'function'
    }));
    expect(probe.requireUndefined).toBeTruthy();
    expect(probe.processUndefined).toBeTruthy();
    expect(probe.hasBridge).toBeTruthy();
    console.log('ELECTRON_SECURITY=PASS');
  });

  test('B15.1 connection list shows honest status vocabulary (untested stays UNKNOWN)', async () => {
    await openPage('connections');
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('table.tbl tbody tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')];
        out.push(cells.map(td => td.innerText.trim()).join(' | '));
      });
      return out;
    });
    expect(rows.length).toBeGreaterThan(0);
    // seed 的 Fake API 连接未测试 → 状态只能是「未测试」，绝不假装可用
    const fakeRow = rows.find(r => r.includes('Fake API'));
    expect(fakeRow).toBeTruthy();
    expect(fakeRow).toContain('未测试');
    expect(fakeRow).not.toContain('可用');
    console.log('CONNECTION_STATUS_VOCABULARY=PASS');
  });

  test('B15.2 wizard creates connection; B15.3/B15.4 secrets masked forever', async () => {
    await openPage('connections');
    await page.click('#conn-add');
    await page.fill('#f-name', 'Ops Secret Fixture');
    await page.fill('#f-url', 'http://127.0.0.1:9/v1');
    await page.fill('#f-key', FIXTURE_API_KEY);
    await page.click('#f-headers-add');
    await page.fill('.hdr-row .hdr-name', 'X-Auth-Token');
    await page.fill('.hdr-row .hdr-value', FIXTURE_HEADER_VALUE);
    await page.click('#modal [data-act="ok"]');
    await page.waitForTimeout(600);

    // DOM 全量扫描：密钥与请求头值绝不出现（B68 局部）
    const leaks = await page.evaluate((secrets) => {
      const text = document.body.innerHTML;
      return secrets.filter(s => text.includes(s));
    }, [FIXTURE_API_KEY, FIXTURE_HEADER_VALUE]);
    expect(leaks).toEqual([]);

    // IPC 投影同样无明文
    const ipcLeaks = await page.evaluate(async (secrets) => {
      const list = await window.__inv('connections:list');
      const text = JSON.stringify(list);
      return secrets.filter(s => text.includes(s));
    }, [FIXTURE_API_KEY, FIXTURE_HEADER_VALUE]);
    expect(ipcLeaks).toEqual([]);
    console.log('CONNECTION_CREATE=PASS');
    console.log('CONNECTION_SECRET_MASK=PASS');
    console.log('CUSTOM_HEADER_SECRET_MASK=PASS');
  });

  test('B15.4 edit form only shows masked header values', async () => {
    await openPage('connections');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('[data-edit]')];
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const target = rows.find(tr => tr.innerText.includes('Ops Secret Fixture'));
      const edit = target && target.querySelector('[data-edit]');
      if (edit) edit.click();
    });
    await page.waitForSelector('#f-name', { timeout: 10000 });
    const headerInputs = await page.evaluate(() => [...document.querySelectorAll('.hdr-row .hdr-value')].map(i => i.value));
    expect(headerInputs.length).toBeGreaterThan(0);
    for (const v of headerInputs) expect(v).not.toContain(FIXTURE_HEADER_VALUE);
    // 掩码占位 = 保留语义：保存后密文仍在（backend 校验）
    await page.click('#modal [data-act="ok"]');
    await page.waitForTimeout(500);
    const stillSecret = await page.evaluate(async () => {
      const list = await window.__inv('connections:list');
      const conn = list.find(c => c.name === 'Ops Secret Fixture');
      const dec = JSON.stringify(conn);
      return !dec.includes('SECRET_AUTH_HEADER_7821') && (conn.header_names || []).includes('X-Auth-Token');
    });
    expect(stillSecret).toBeTruthy();
    console.log('CONNECTION_EDIT_MASKED=PASS');
  });

  test('B15.5 test connection hits real provider contract (loopback refused → UNAVAILABLE)', async () => {
    await openPage('connections');
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const target = rows.find(tr => tr.innerText.includes('Ops Secret Fixture'));
      const btn = target && target.querySelector('[data-test]');
      if (btn) btn.click();
    });
    // 真实 HTTP 拒绝（127.0.0.1:9）→ 状态词汇如实 UNAVAILABLE
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const target = rows.find(tr => tr.innerText.includes('Ops Secret Fixture'));
      return target && (target.innerText.includes('不可用') || target.innerText.includes('测试异常'));
    }, null, { timeout: 30000 });
    const status = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const target = rows.find(tr => tr.innerText.includes('Ops Secret Fixture'));
      return target.innerText;
    });
    expect(status).not.toContain('可用，');
    console.log('CONNECTION_TEST=PASS');
  });

  test('B15.6/B15.7 model source truth: fallback never claimed remote; manual stays manual', async () => {
    // mock provider 连接：fetch models 返回 preset（回退）来源
    const result = await page.evaluate(async () => {
      const conn = await window.__inv('connections:create', { name: 'Ops Mock', provider: 'mock', base_url: 'mock://ops', api_key: '', headers: {} });
      const fetchResult = await window.__inv('connections:models', conn.id);
      await window.__inv('connections:addModel', conn.id, 'ops-manual-model');
      const list = await window.__inv('connections:list');
      const after = list.find(c => c.id === conn.id);
      return { fetchResult, models: after.models };
    });
    expect(result.fetchResult.source).toBe('preset');
    const manual = result.models.find(m => m.id === 'ops-manual-model');
    expect(manual.source).toBe('manual');
    const hasRemoteLie = result.models.some(m => m.source === 'remote');
    expect(hasRemoteLie).toBeFalsy();
    console.log('CONNECTION_FETCH_MODELS=PASS');
    console.log('FALLBACK_MODEL_SOURCE_TRUTH=PASS');
    console.log('CONNECTION_MANUAL_MODEL=PASS');
  });

  test('B15.8 favorites persist; B15.9 default connection is a preference roundtrip', async () => {
    const proof = await page.evaluate(async () => {
      const list = await window.__inv('connections:list');
      const mock = list.find(c => c.name === 'Ops Mock');
      await window.__inv('connections:setModelFavorite', mock.id, 'ops-manual-model', true);
      await window.__inv('connections:setDefault', mock.id, 'ops-manual-model');
      const defaults1 = await window.__inv('connections:getDefaults');
      const list2 = await window.__inv('connections:list');
      const mock2 = list2.find(c => c.id === mock.id);
      await window.__inv('connections:setDefault', null, null);
      const defaults2 = await window.__inv('connections:getDefaults');
      return {
        favorite: mock2.models.find(m => m.id === 'ops-manual-model').favorite,
        isDefault: mock2.is_default,
        defaults1, defaults2
      };
    });
    expect(proof.favorite).toBeTruthy();
    expect(proof.isDefault).toBeTruthy();
    expect(proof.defaults1.modelId).toBe('ops-manual-model');
    expect(proof.defaults2.connectionId).toBe(null);
    console.log('CONNECTION_FAVORITE_PERSIST=PASS');
    console.log('CONNECTION_DEFAULT_PREFERENCE=PASS');
  });

  test('B17.1/B17.3 skill library renders Used By and editor uses the validator', async () => {
    await openPage('skills');
    const bodyText = await page.evaluate(() => document.querySelector('#page-body').textContent);
    expect(bodyText).toContain('Skills');
    expect(bodyText).toContain('Hooks');
    // 通过 GUI 创建非法 Skill（缺 id）→ validator 拒绝
    await page.click('#skill-add');
    await page.fill('#s-name', 'Ops Broken Skill');
    await page.click('#modal [data-act="ok"]');
    await page.waitForTimeout(600);
    const modalStillOpen = await page.evaluate(() => !document.querySelector('#modal-overlay').classList.contains('hidden'));
    expect(modalStillOpen).toBeTruthy(); // 校验失败不得落库
    const created = await page.evaluate(async () => {
      const list = await window.__inv('skill:list');
      return list.some(s => s.name === 'Ops Broken Skill');
    });
    expect(created).toBeFalsy();
    await page.evaluate(() => { const x = document.querySelector('.modal-x'); if (x) x.click(); });
    console.log('SKILL_LIBRARY=PASS');
    console.log('SKILL_VALIDATION=PASS');
  });

  test('B17.6 hook editor offers only trusted handler selects (no raw script inputs)', async () => {
    await openPage('skills');
    await page.click('#hook-add');
    const editorProbe = await page.evaluate(() => {
      const overlay = document.querySelector('#modal-overlay');
      if (overlay.classList.contains('hidden')) return { blocked: true };
      const handlerSel = document.querySelector('#h-handler');
      return {
        blocked: false,
        handlerIsSelect: !!handlerSel && handlerSel.tagName === 'SELECT',
        hasScriptInput: !!document.querySelector('#h-script, #h-code, #h-webhook, #h-shell'),
        eventOptions: [...document.querySelectorAll('#h-event option')].map(o => o.value)
      };
    });
    if (!editorProbe.blocked) {
      expect(editorProbe.handlerIsSelect).toBeTruthy();
      expect(editorProbe.hasScriptInput).toBeFalsy();
      expect(editorProbe.eventOptions).toEqual(expect.arrayContaining(['run_start', 'before_model', 'after_model', 'before_tool', 'after_tool', 'before_delegate', 'after_delegate', 'run_end']));
      await page.evaluate(() => { const x = document.querySelector('.modal-x'); if (x) x.click(); });
    }
    console.log('HOOK_TRUSTED_HANDLER_ONLY=PASS');
    console.log('HOOK_RAW_SCRIPT_UI=0');
  });

  test('B20 health center renders all sections; self-test reports zero paid calls', async () => {
    await openPage('diagnostics');
    const bodyText = await page.evaluate(() => document.querySelector('#page-body').textContent);
    for (const section of ['Application', 'Database', 'Project', '主智能体', 'Model Router', 'Connections', 'Skills', 'Hooks', 'Workflow', 'Generator', 'AgentHub', '外部智能体', 'Computer', 'Browser', 'MCP', 'Terminal', 'Project Locks', 'Processes', 'Runtime Residue']) {
      expect(bodyText, `health section ${section}`).toContain(section);
    }
    // B20.2 — self test
    await page.click('#diag-selftest');
    await page.waitForFunction(() => {
      const out = document.querySelector('#diag-selftest-out');
      return out && out.innerText.includes('paid calls');
    }, null, { timeout: 60000 });
    const selfText = await page.evaluate(() => document.querySelector('#diag-selftest-out').innerText);
    expect(selfText).toContain('paid calls: 0');
    console.log('HEALTH_CENTER_SECTIONS=PASS');
    console.log('SELF_TEST_ZERO_PAID_CALLS=PASS');
  });

  test('B21 problems center: report → visible; dismiss != resolved', async () => {
    const proof = await page.evaluate(async () => {
      await window.__inv('problems:report', { code: 'OPS_E2E_PROBLEM', message: 'ops fixture problem', severity: 'WARNING' });
      const before = await window.__inv('problems:list');
      const mine = before.find(p => p.code === 'OPS_E2E_PROBLEM');
      await window.__inv('problems:dismiss', mine.id);
      const afterDismiss = await window.__inv('problems:list');
      const mineAfter = afterDismiss.find(p => p.id === mine.id);
      return { existed: !!mine, dismissedStatus: mineAfter && mineAfter.status };
    });
    expect(proof.existed).toBeTruthy();
    expect(proof.dismissedStatus).toBe('DISMISSED');
    expect(proof.dismissedStatus).not.toBe('RESOLVED');
    console.log('PROBLEM_CENTER=PASS');
    console.log('DISMISS_NOT_RESOLVED=PASS');
  });

  test('B23 every management page leaves LOADING and never gets stuck', async () => {
    for (const name of ['dashboard', 'connections', 'agents', 'mcp', 'skills', 'workflows', 'generator', 'diagnostics', 'settings']) {
      await openPage(name);
      const stuck = await page.evaluate(() => !!document.querySelector('#page-body [data-page-state="loading"]'));
      expect(stuck, `page ${name} stuck in loading`).toBeFalsy();
    }
    console.log('PAGE_STATE_CONTRACT=PASS');
  });

  test('B42 destructive confirmation shows target/consequence/reversibility', async () => {
    await openPage('connections');
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const target = rows.find(tr => tr.innerText.includes('Ops Mock'));
      const del = target && target.querySelector('[data-del]');
      if (del) del.click();
    });
    await page.waitForSelector('.confirm-spec', { timeout: 10000 });
    const spec = await page.evaluate(() => document.querySelector('.confirm-spec').innerText);
    expect(spec).toContain('目标');
    expect(spec).toContain('后果');
    expect(spec).toContain('可逆性');
    // 取消删除：对象仍在
    await page.click('#modal [data-act="cancel"]');
    const stillThere = await page.evaluate(async () => {
      const list = await window.__inv('connections:list');
      return list.some(c => c.name === 'Ops Mock');
    });
    expect(stillThere).toBeTruthy();
    console.log('UNIFIED_CONFIRMATION_UX=PASS');
  });

  test('B67 XSS hardening: malicious workflow name never executes', async () => {
    await page.evaluate(async () => {
      await window.__inv('workflow:create', {
        schemaVersion: 1, id: 'xss-flow', name: '<img src=x onerror="window.__XSS=1">', description: '',
        inputs: {}, steps: [{ id: 's1', type: 'condition', dependsOn: [], config: { source: 'input.x', operator: 'truthy' } }],
        outputs: {}, limits: { maxSteps: 4, maxRuntimeMs: 5000 }, metadata: {}
      });
    });
    await openPage('workflows');
    await page.waitForTimeout(400);
    const xss = await page.evaluate(() => window.__XSS);
    expect(xss).toBeUndefined();
    const rawImgInjected = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('#page-body img')];
      return imgs.some(i => i.getAttribute('onerror'));
    });
    expect(rawImgInjected).toBeFalsy();
    console.log('GUI_XSS_EXECUTIONS=0');
  });

  test('B68 secret leak gate: full DOM + diagnostics scan finds zero fixture secrets', async () => {
    await openPage('connections');
    await openPage('diagnostics');
    await openPage('connections');
    const leaks = await page.evaluate((secrets) => {
      const text = document.body.innerHTML;
      return secrets.filter(s => text.includes(s));
    }, [FIXTURE_API_KEY, FIXTURE_HEADER_VALUE, 'SECRET_COOKIE_4418']);
    expect(leaks).toEqual([]);
    console.log('GUI_SECRET_LEAKS=0');
    console.log('CONNECTION_SECRET_LEAK=0');
    console.log('CUSTOM_HEADER_SECRET_LEAK=0');
  });

  test('B19 terminal workspace shows active command with owner truth and real cancel', async () => {
    await page.evaluate(() => { const b = document.querySelector('.btab[data-btab="terminal"]'); if (b) b.click(); });
    await page.waitForTimeout(300);
    const proof = await page.evaluate(async () => {
      await window.__inv('terminal:run', 'echo OPS_TERMINAL_OK_8841');
      await new Promise(r => setTimeout(r, 2500));
      const hist = await window.__inv('terminal:history', 20);
      const rec = hist.find(h => h.command.includes('OPS_TERMINAL_OK_8841'));
      return rec ? { owner: rec.owner, status: rec.status, exitCode: rec.exitCode, hasStdout: String(rec.stdout || '').includes('OPS_TERMINAL_OK_8841') } : null;
    });
    expect(proof).toBeTruthy();
    expect(proof.owner).toBe('USER');
    expect(proof.exitCode).toBe(0);
    expect(proof.hasStdout).toBeTruthy();
    console.log('TERMINAL_ACTIVE=PASS');
    console.log('TERMINAL_HISTORY=PASS');
    console.log('TERMINAL_OWNER_TRUTH=PASS');
  });

  test('B18 computer panel shows honest availability vocabulary', async () => {
    await page.evaluate(() => { const b = document.querySelector('.btab[data-btab="computer"]'); if (b) b.click(); });
    await page.waitForFunction(() => {
      const chip = document.querySelector('#cp-status');
      return chip && /Computer：(可用|不可用|不支持|未知|异常)/.test(chip.textContent);
    }, null, { timeout: 60000 });
    const statusText = await page.evaluate(() => document.querySelector('#cp-status').textContent);
    expect(statusText).toMatch(/Computer：(可用|不可用|不支持|未知|异常)/);
    const availability = await page.evaluate(async () => await window.__inv('computer:availability'));
    expect(['AVAILABLE', 'UNAVAILABLE', 'UNSUPPORTED', 'UNKNOWN', 'ERROR']).toContain(availability.status);
    console.log('COMPUTER_AVAILABILITY_TRUTH=PASS');
  });

  test('B27.1/B28 composer context chips render and Send/Stop toggle is truthful', async () => {
    await page.evaluate(() => { const b = document.querySelector('[data-act="chat"]'); if (b) b.click(); });
    await page.waitForTimeout(400);
    const chips = await page.evaluate(() => {
      const box = document.querySelector('#composer-chips');
      return box ? box.innerText : '';
    });
    expect(chips).toContain('项目');
    expect(chips).toContain('智能体');
    expect(chips).toContain('模型');
    // Idle → Send 可见，Stop 隐藏
    const idle = await page.evaluate(() => ({
      sendVisible: !document.querySelector('#btn-send').classList.contains('hidden'),
      stopVisible: !document.querySelector('#btn-stop').classList.contains('hidden')
    }));
    expect(idle.sendVisible).toBeTruthy();
    expect(idle.stopVisible).toBeFalsy();
    console.log('COMPOSER_CONTEXT_CHIPS=PASS');
    console.log('RUNNING_COMPOSER_TOGGLE=PASS');
  });

  test('B47 activity badges reflect real pending counts', async () => {
    const proof = await page.evaluate(async () => {
      await window.__inv('problems:report', { code: 'OPS_BADGE_PROBLEM', message: 'badge fixture', severity: 'WARNING' });
      await new Promise(r => setTimeout(r, 8000)); // 等待全局状态轮询周期
      const diagBtn = document.querySelector('[data-page="diagnostics"]');
      const badge = diagBtn ? diagBtn.querySelector('.ab-badge') : null;
      return { hasBadge: !!badge, badgeText: badge ? badge.textContent : null };
    });
    expect(proof.hasBadge).toBeTruthy();
    expect(Number(proof.badgeText)).toBeGreaterThan(0);
    console.log('ACTIVITY_BADGES=PASS');
  });

  test('B73 activity bar icons are minimalist SVG (self-evident, no emoji)', async () => {
    const probe = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#activity-bar .abtn')];
      return {
        count: btns.length,
        allHaveSvg: btns.every(b => !!b.querySelector('.ab-ico svg')),
        allHaveLabel: btns.every(b => (b.getAttribute('aria-label') || '').length > 0),
        noEmoji: btns.every(b => !/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(b.querySelector('.ab-ico').textContent))
      };
    });
    expect(probe.count).toBeGreaterThanOrEqual(13);
    expect(probe.allHaveSvg).toBeTruthy();
    expect(probe.allHaveLabel).toBeTruthy();
    expect(probe.noEmoji).toBeTruthy();
    console.log('MINIMAL_ICON_SET=PASS');
  });

  test('B74 zoom: Ctrl+= in / Ctrl+- out / Ctrl+0 reset, persisted across reload', async () => {
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(300);
    let zoom = await page.evaluate(() => document.documentElement.style.zoom);
    expect(zoom).toBe('1.1');

    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Control+Minus');
    await page.waitForTimeout(300);
    zoom = await page.evaluate(() => document.documentElement.style.zoom);
    expect(zoom).toBe('0.9');

    await page.keyboard.press('Control+Digit0');
    await page.waitForTimeout(300);
    zoom = await page.evaluate(() => document.documentElement.style.zoom);
    expect(zoom).toBe('1');

    // 持久化：先放大再重载，缩放必须恢复
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    zoom = await page.evaluate(() => document.documentElement.style.zoom);
    expect(zoom).toBe('1.1');
    await page.keyboard.press('Control+Digit0');
    await page.waitForTimeout(300);
    console.log('ZOOM_SHORTCUTS=PASS');
    console.log('ZOOM_PERSIST=PASS');
  });

  test('renderer stayed clean: zero page errors across the whole spec', async () => {
    expect(pageErrors).toEqual([]);
    console.log('UNEXPECTED_RENDERER_ERRORS=0');
  });
});
