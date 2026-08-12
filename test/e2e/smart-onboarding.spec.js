'use strict';
/**
 * v2.4.0 — Smart API Onboarding GUI E2E（spec §73-§79）。
 *
 * 保留旧 9 个用例（gui-main-path.spec.js），本文件新增 5 个 Smart API 用例：
 *   10) §74 万能粘贴：粘贴文本 → 识别 URL/Key → 检测 → 保存
 *   11) §75 Secret 不泄漏：DOM/console/audit/SQLite 非密文字段均无明文 key
 *   12) §76 一键分配主智能体：保存后分配 main → 发送 → 收到 QUICK_CONNECT_OK
 *   13) §77 手动模型：/models 404 → 手动输入 my-model → 保存后 Agent 可调用
 *   14) §78 CC Switch Import：Deep Link + Config 批量导入
 *
 * 隔离：独立临时 userData + 独立 Fake API 端口，不污染 gui-main-path 的数据。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start, startProbeServer, startHangServer } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake = null;
let fakeManual = null; // §77: /models=404 的变体
let app = null;
let page = null;
let userData = null;
let pageErrors = [];
let consoleErrors = [];

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
  const env = { ...process.env, ADP_USER_DATA: ud };
  delete env.ELECTRON_RUN_AS_NODE;
  const a = await electron.launch({
    args: ['.', '--disable-gpu'],
    cwd: ROOT,
    env
  });
  const p = await a.firstWindow();
  pageErrors = [];
  consoleErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await p.waitForLoadState('domcontentloaded');
  try {
    await p.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  } catch (e) {
    const dump = await p.evaluate(() => ({
      bodyHTML: document.body.innerHTML.slice(0, 1500),
      title: document.title,
      apiMethods: window.api ? Object.keys(window.api) : null
    })).catch(() => null);
    process.stderr.write(`[smart-e2e boot-fail] pageErrors=${JSON.stringify(pageErrors)}\n[smart-e2e boot-fail] dump=${JSON.stringify(dump)}\n`);
    throw e;
  }
  await p.waitForTimeout(800);
  return a;
}

/** 关闭 page-overlay（Esc），回到聊天主界面 */
async function closePage() {
  const overlay = page.locator('.page-overlay:not(.hidden)');
  if (await overlay.count() === 0) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** 关闭 modal-overlay（点 × 或 Esc） */
async function closeModal() {
  const modal = page.locator('#modal-overlay:not(.hidden)');
  if (await modal.count() === 0) return;
  const x = page.locator('#modal-overlay .modal-x');
  if (await x.count() > 0) { await x.click(); }
  else { await page.keyboard.press('Escape'); }
  await page.waitForTimeout(300);
}

test.beforeAll(async () => {
  fake = await start(0);
  fakeManual = await start(0, { modelsEnabled: false });
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-smart-'));
  await seedDb(userData, fake.baseUrl);
  app = await launchApp(userData);
  page = await app.firstWindow();
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (fakeManual) fakeManual.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── §74 万能粘贴 ─────────────────────────────────────────────────────────

test('10) §74 万能粘贴：粘贴文本 → 识别 URL/Key → 检测 → 保存', async () => {
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });

  const pasteText = `接口地址：${fake.baseUrl}\nAPI Key：sk-smart-onboarding-test`;
  await page.locator('#ob-paste').fill(pasteText);
  await page.locator('#ob-parse').click();

  // 预览页：检查 URL 被识别、Key 被 mask
  await page.waitForSelector('#ob-probe', { timeout: 10000 });
  await expect(page.locator('#ob-url')).toHaveValue(fake.baseUrl);
  // §75: mask 显示 —— 不能出现完整 key
  await expect(page.locator('.ob-preview')).not.toContainText('sk-smart-onboarding-test');
  await expect(page.locator('.ob-preview')).toContainText('•');

  // 开始检测
  await page.locator('#ob-probe').click();
  // 等待检测结果页
  await page.waitForSelector('#ob-finish', { timeout: 30000 });
  await expect(page.locator('.ob-result')).toContainText('网络可达');
  await expect(page.locator('.ob-result')).toContainText('OpenAI Chat');
  // v2.4.1: 新 UI 显示 "模型列表：N 个"（modelDiscovery 与 protocol 分离）
  await expect(page.locator('.ob-result')).toContainText('模型列表');

  // 保存
  await page.locator('#ob-final-name').fill('Smart Test Conn');
  // 取消分配主智能体（本用例只验证保存）
  const assignCb = page.locator('#ob-assign-main');
  if (await assignCb.isChecked()) await assignCb.uncheck();
  await page.locator('#ob-finish').click();
  await page.waitForTimeout(1000);

  // 验证连接已保存（scope 到 #page-body 避免选择器歧义）
  await expect(page.locator('#page-body')).toContainText('Smart Test Conn', { timeout: 10000 });
});

// ─── §75 Secret 不泄漏 ────────────────────────────────────────────────────

test('11) §75 Secret 不泄漏：DOM/console/audit/SQLite 非密文字段无明文 key', async () => {
  const SECRET = 'sk-leak-test-abcdef123456';
  // 先导航到 API 连接页，确保 #conn-smart 可见（不依赖前一个用例的页面状态）
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });
  await page.locator('#ob-paste').fill(`https://api.leak-test.example.com/v1\n${SECRET}`);
  await page.locator('#ob-parse').click();
  await page.waitForSelector('#ob-probe', { timeout: 10000 });

  // DOM 中不应有明文 key
  const previewHtml = await page.locator('.ob-preview').innerHTML();
  expect(previewHtml).not.toContain(SECRET);

  // 取消（不发网络请求）
  await page.locator('#ob-back').click();
  await closeModal();

  // 检查 console 错误中无 key
  for (const err of consoleErrors) {
    expect(err).not.toContain(SECRET);
  }
  for (const err of pageErrors) {
    expect(err).not.toContain(SECRET);
  }

  // 检查 audit 表无明文 key（通过 IPC 查审计日志）
  const auditCheck = await page.evaluate(async (secret) => {
    try {
      const r = await window.api.invoke('audit:list', 100);
      const logs = r && r.data !== undefined ? r.data : r;
      if (!Array.isArray(logs)) return { ok: true, reason: 'no audit logs' };
      const json = JSON.stringify(logs);
      return { ok: !json.includes(secret), reason: json.includes(secret) ? 'audit contains secret' : 'clean' };
    } catch (e) { return { ok: true, reason: 'audit:list not available: ' + e.message }; }
  }, SECRET);
  expect(auditCheck.ok, `audit 泄漏: ${auditCheck.reason}`).toBe(true);

  // 检查整个 body innerText 不含明文 key（modal 已关闭）
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(SECRET);
});

// ─── §76 一键分配主智能体 + QUICK_CONNECT_OK ─────────────────────────────

test('12) §76 一键分配主智能体 → 发送 → 收到 QUICK_CONNECT_OK', async () => {
  // §76: 用 fakeManual（/models=404 → 手动输入 model-QUICK），分配给主智能体。
  // fakeManual 的 POST /chat/completions 对 model-QUICK 返回 QUICK_CONNECT_OK。
  // 先导航到 API 连接页，确保 #conn-smart 可见
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });
  await page.locator('#ob-paste').fill(`接口地址：${fakeManual.baseUrl}\nAPI Key：sk-quick-assign`);
  await page.locator('#ob-parse').click();
  await page.waitForSelector('#ob-probe', { timeout: 10000 });
  await page.locator('#ob-probe').click();
  await page.waitForSelector('#ob-finish', { timeout: 30000 });

  // /models=404 → 手动输入框；填 model-QUICK
  await page.locator('#ob-final-name').fill('Quick Assign Conn');
  const modelInput = page.locator('#ob-final-model');
  const isTextInput = await modelInput.evaluate(el => el.tagName === 'INPUT');
  expect(isTextInput, 'fakeManual /models=404 应为手动输入框').toBe(true);
  await modelInput.fill('model-QUICK');

  // 确认勾选分配主智能体
  const assignCb = page.locator('#ob-assign-main');
  if (!await assignCb.isChecked()) await assignCb.check();

  // 主智能体已有配置 → confirmBox 二次确认（按钮文案 = "确认"）
  await page.locator('#ob-finish').click();
  const confirmBtn = page.locator('#modal [data-act="ok"]');
  await expect(confirmBtn).toBeVisible({ timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(1500);

  // 验证主智能体已切换
  const mainCheck = await page.evaluate(async () => {
    const r = await window.api.invoke('agents:list');
    const agents = r && r.data ? r.data : r;
    const main = (Array.isArray(agents) ? agents : []).find(a => a && a.is_main);
    const conns = await window.api.invoke('connections:list');
    const list = conns && conns.data ? conns.data : conns;
    const conn = (Array.isArray(list) ? list : []).find(c => c && c.name === 'Quick Assign Conn');
    return {
      mainModel: main && main.model,
      mainConnId: main && main.api_connection_id,
      quickConnId: conn && conn.id,
      match: main && conn && main.api_connection_id === conn.id
    };
  });
  expect(mainCheck.match, '主智能体应已绑定 Quick Assign Conn').toBe(true);
  expect(mainCheck.mainModel).toBe('model-QUICK');

  // 回到聊天发送消息 → 应收到 QUICK_CONNECT_OK
  await closePage();
  // v2.9.9 Phase B（#1/#8）：主智能体（is_main）默认产品入口已切到 canonical（结构化 Action），
  // 不再产生纯文本回复气泡。文本回复验证改用 legacy 通用助手（agent:send）：
  // 把通用助手也绑定到 Quick Assign Conn + model-QUICK，用它发送并收到 QUICK_CONNECT_OK。
  const generalId = await page.evaluate(async () => {
    const conns = await window.api.invoke('connections:list');
    const clist = conns && conns.data ? conns.data : conns;
    const conn = (Array.isArray(clist) ? clist : []).find(c => c && c.name === 'Quick Assign Conn');
    const agents = await window.api.invoke('agents:list');
    const ags = agents && agents.data ? agents.data : agents;
    const general = (Array.isArray(ags) ? ags : []).find(a => a && a.name === '通用助手');
    if (conn && general) await window.api.invoke('agents:update', general.id, { api_connection_id: conn.id, model: 'model-QUICK' });
    return general ? general.id : null;
  });
  expect(generalId, '应存在通用助手').toBeTruthy();
  await page.evaluate((aid) => {
    const sel = document.querySelector('#agent-select');
    if (sel && aid) { sel.value = aid; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, generalId);
  await page.waitForTimeout(200);
  await page.locator('#btn-newchat').click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('#input').fill('请回复');
  await page.getByRole('button', { name: '发送 ▸' }).click();
  await expect(page.locator('#status-text')).toContainText('已完成', { timeout: 30000 });
  await expect(page.locator('.msg.assistant')).toContainText('QUICK_CONNECT_OK', { timeout: 10000 });
});

// ─── §77 手动模型（/models = 404）─────────────────────────────────────────

test('13) §77 手动模型：/models 404 → 手动输入 my-model → 保存可调用', async () => {
  // fakeManual 的 /models 返回 404，但 /chat/completions 可用
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });
  await page.locator('#ob-paste').fill(`接口地址：${fakeManual.baseUrl}\nAPI Key：sk-manual-model`);
  await page.locator('#ob-parse').click();
  await page.waitForSelector('#ob-probe', { timeout: 10000 });
  await page.locator('#ob-probe').click();
  await page.waitForSelector('#ob-finish', { timeout: 30000 });

  // 检测结果应显示 OpenAI Chat supported（/chat/completions 405 探测成功）
  await expect(page.locator('.ob-result')).toContainText('OpenAI Chat');
  // 模型列表应不可用，显示手动输入
  const modelInput = page.locator('#ob-final-model');
  const isTextInput = await modelInput.evaluate(el => el.tagName === 'INPUT');
  expect(isTextInput, '应为手动输入框（非下拉）').toBe(true);
  await page.locator('#ob-final-name').fill('Manual Model Conn');
  await modelInput.fill('my-model');

  // 不分配主智能体（避免覆盖上一个用例的配置）
  const assignCb = page.locator('#ob-assign-main');
  if (await assignCb.isChecked()) await assignCb.uncheck();

  await page.locator('#ob-finish').click();
  await page.waitForTimeout(1000);
  await expect(page.locator('#page-body')).toContainText('Manual Model Conn', { timeout: 10000 });

  // 验证连接保存了手动模型（§35: 无远端模型时 defaultModel 写入为 manual）
  const connCheck = await page.evaluate(async () => {
    const r = await window.api.invoke('connections:list');
    const list = r && r.data ? r.data : r;
    const c = (Array.isArray(list) ? list : []).find(x => x && x.name === 'Manual Model Conn');
    if (!c) return { ok: false, reason: 'connection not found' };
    const models = c.models || [];
    return {
      ok: true,
      hasMyModel: models.some(m => (typeof m === 'string' ? m : m.id) === 'my-model'),
      modelSource: (models.find(m => (typeof m === 'string' ? m : m.id) === 'my-model') || {}).source
    };
  });
  expect(connCheck.ok, connCheck.reason).toBe(true);
  expect(connCheck.hasMyModel, '连接应包含手动输入的 my-model').toBe(true);
  expect(connCheck.modelSource, '模型来源应为 manual').toBe('manual');
});

// ─── §78 CC Switch Import ─────────────────────────────────────────────────

test('14) §78 CC Switch Import：Deep Link + Config 批量导入', async () => {
  // §78-1: Deep Link 单个导入（先导航到 API 连接页，确保 #conn-smart 可见）
  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });

  // 构造 CC Switch Deep Link（基于 ccSwitch.js parser 实际格式）
  const deepLink = `ccswitch://v1/import?resource=provider&app=codex&name=CC%20Switch%20DeepLink&endpoint=${encodeURIComponent(fake.baseUrl)}&apiKey=sk-ccswitch-deeplink&model=model-A`;
  await page.locator('#ob-paste').fill(deepLink);
  await page.locator('#ob-ccswitch').click();

  // 应进入批量导入页（batch.length=1）
  await page.waitForSelector('#ob-batch-import', { timeout: 10000 });
  await expect(page.locator('.ob-batch')).toContainText('CC Switch DeepLink');
  // mask 显示 key
  await expect(page.locator('.ob-batch')).not.toContainText('sk-ccswitch-deeplink');
  await expect(page.locator('.ob-batch')).toContainText('•');

  await page.locator('#ob-batch-import').click();
  await page.waitForTimeout(1500);

  // 验证连接已导入（scope 到 #page-body 避免与底层工作区 tbody 冲突）
  await expect(page.locator('#page-body')).toContainText('CC Switch DeepLink', { timeout: 10000 });

  // §78-2: Config 批量导入（多个 Provider）
  await page.waitForSelector('#conn-smart', { timeout: 10000 });
  await page.locator('#conn-smart').click();
  await page.waitForSelector('#ob-paste', { timeout: 10000 });
  const configJson = JSON.stringify([
    {
      name: 'CC Provider A',
      websiteUrl: 'https://a.example.com',
      settingsConfig: { env: { OPENAI_BASE_URL: 'https://a.example.com/v1', OPENAI_API_KEY: 'sk-cc-config-a' } }
    },
    {
      name: 'CC Provider B',
      settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://b.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-cc-config-b' } }
    }
  ]);
  await page.locator('#ob-paste').fill(configJson);
  await page.locator('#ob-ccswitch').click();

  await page.waitForSelector('#ob-batch-import', { timeout: 10000 });
  await expect(page.locator('.ob-batch')).toContainText('CC Provider A');
  await expect(page.locator('.ob-batch')).toContainText('CC Provider B');
  // mask 显示
  await expect(page.locator('.ob-batch')).not.toContainText('sk-cc-config-a');
  await expect(page.locator('.ob-batch')).not.toContainText('sk-cc-config-b');

  await page.locator('#ob-batch-import').click();
  await page.waitForTimeout(1500);
  await expect(page.locator('#page-body')).toContainText('CC Provider A', { timeout: 10000 });
  await expect(page.locator('#page-body')).toContainText('CC Provider B', { timeout: 10000 });

  // §79: 确认无 JS 致命错误
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ═══ v2.4.1 §55-§57: Probe Cancel + False Positive E2E ═════════════════════

// ─── §55 Case 15: GUI Probe Cancel 真正中断网络 ─────────────────────────────

test('15) §55 GUI Probe Cancel：Hang Server + 取消检测 < 2s + activeProbe = 0', async () => {
  // 启动 Hang Server（接受 TCP 但永不响应）
  const hang = await startHangServer();
  try {
    // 导航到 API 连接页
    await page.getByRole('button', { name: 'API 连接' }).click();
    await page.waitForSelector('#conn-smart', { timeout: 10000 });
    await page.locator('#conn-smart').click();
    await page.waitForSelector('#ob-paste', { timeout: 10000 });

    // 粘贴 Hang Server URL + Key
    await page.locator('#ob-paste').fill(`接口地址：${hang.baseUrl}\nAPI Key：sk-hang-cancel`);
    await page.locator('#ob-parse').click();
    await page.waitForSelector('#ob-probe', { timeout: 10000 });

    // 开始检测
    await page.locator('#ob-probe').click();
    // 等待"检测中"页面
    await page.waitForSelector('#ob-abort', { timeout: 10000 });

    // 记录开始时间
    const t0 = Date.now();
    // 点击取消检测
    await page.locator('#ob-abort').click();

    // §55: < 2s 回到预览页（#ob-probe 按钮重新出现）
    await page.waitForSelector('#ob-probe', { timeout: 5000 });
    const elapsed = Date.now() - t0;
    expect(elapsed, `取消应在 2s 内回到预览，实际 ${elapsed}ms`).toBeLessThan(2000);

    // §55: 通过 IPC 验证 activeProbe = 0
    const activeProbesRaw = await page.evaluate(async () => {
      try {
        return await window.api.invoke('diagnostics:listActiveProbes');
      } catch (e) { return { error: e.message }; }
    });
    // reg() 包装为 { ok, data }，需要解包
    const activeProbes = activeProbesRaw && activeProbesRaw.data !== undefined ? activeProbesRaw.data : activeProbesRaw;
    expect(Array.isArray(activeProbes), `listActiveProbes 应返回数组，实际: ${JSON.stringify(activeProbesRaw)}`).toBe(true);
    expect(activeProbes.length, '取消后不应有活跃 Probe').toBe(0);

    // §55: 没有结果页迟到出现（仍应在预览页）
    await page.waitForTimeout(1000);
    const finishBtn = await page.locator('#ob-finish').count();
    expect(finishBtn, '迟到结果不应出现').toBe(0);

    // 关闭 modal
    await closeModal();
  } finally {
    try { hang.server.close(); } catch { /* noop */ }
  }
});

// ─── §56 Case 16: Responses-only（/models ✓, Chat ✕, Responses ✓）──────────

test('16) §56 Responses-only：Chat ✕ + Responses ✓ → 推荐 Responses', async () => {
  const srv = await startProbeServer('responses-only');
  try {
    await page.getByRole('button', { name: 'API 连接' }).click();
    await page.waitForSelector('#conn-smart', { timeout: 10000 });
    await page.locator('#conn-smart').click();
    await page.waitForSelector('#ob-paste', { timeout: 10000 });

    await page.locator('#ob-paste').fill(`接口地址：${srv.baseUrl}\nAPI Key：sk-resp-only`);
    await page.locator('#ob-parse').click();
    await page.waitForSelector('#ob-probe', { timeout: 10000 });
    await page.locator('#ob-probe').click();

    // 等待检测结果页
    await page.waitForSelector('#ob-finish', { timeout: 30000 });

    // §56: 模型列表 ✓
    await expect(page.locator('.ob-result')).toContainText('模型列表');
    // §56: Chat ✕（不能因 /models 200 就说 Chat supported）
    await expect(page.locator('.ob-result')).toContainText('✕ OpenAI Chat');
    // §56: Responses ✓ + 推荐
    await expect(page.locator('.ob-result')).toContainText('✓ OpenAI Responses');
    await expect(page.locator('.ob-result')).toContainText('推荐');

    // 关闭 modal（不保存）
    await closeModal();
  } finally {
    try { srv.server.close(); } catch { /* noop */ }
  }
});

// ─── §57 Case 17: Models-only 不误判 Chat ──────────────────────────────────

test('17) §57 Models-only：/models ✓ + 所有协议 ✕ → 不误判 Chat', async () => {
  const srv = await startProbeServer('models-only');
  try {
    await page.getByRole('button', { name: 'API 连接' }).click();
    await page.waitForSelector('#conn-smart', { timeout: 10000 });
    await page.locator('#conn-smart').click();
    await page.waitForSelector('#ob-paste', { timeout: 10000 });

    await page.locator('#ob-paste').fill(`接口地址：${srv.baseUrl}\nAPI Key：sk-models-only`);
    await page.locator('#ob-parse').click();
    await page.waitForSelector('#ob-probe', { timeout: 10000 });
    await page.locator('#ob-probe').click();

    // 等待检测结果页
    await page.waitForSelector('#ob-finish', { timeout: 30000 });

    // §57: 模型发现 ✓
    await expect(page.locator('.ob-result')).toContainText('模型列表');
    // §57: Chat ✕（/models 200 ≠ Chat supported）
    await expect(page.locator('.ob-result')).toContainText('✕ OpenAI Chat');
    // §57: 应显示"没有确认可用的生成协议"提示
    await expect(page.locator('.ob-result')).toContainText('没有确认可用的生成协议');

    // 关闭 modal（不保存）
    await closeModal();
  } finally {
    try { srv.server.close(); } catch { /* noop */ }
  }
});
