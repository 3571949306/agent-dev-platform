'use strict';
/**
 * v2.5.0 — External Config Import GUI E2E（spec §71-§79 Case 18-23）。
 *
 * 6 个新增用例：
 *   18) §74 Codex config file → Preview → Import（wire_api=responses → openai-responses）
 *   19) §75 Claude Code ENV → Preview → Import（ANTHROPIC_API_KEY → anthropic）
 *   20) §76 OpenCode multi-provider → Batch Import（选 A+B，C 不导入）
 *   21) §77 Conflict detection（预建同 baseUrl+protocol → DUPLICATE）
 *   22) §78 Missing Secret → 手动补 Key → Import（MISSING_SECRET → 成功）
 *   23) §79 OAuth / Session credential rejected（unsupported_credential，0 candidate）
 *
 * 隔离：独立临时 userData，不依赖 fake API（import 不做 Probe）。
 * Fixture：test/fixtures/external-import/ 下的 sk-test-* 假 key，不含真实凭据。
 *
 * 测试钩子：externalImport:testSetFilePick IPC 一次性设置下次 selectFile 返回的路径，
 *   避免 Playwright 无法驱动 native dialog.showOpenDialog。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'external-import');

let app = null;
let page = null;
let userData = null;
let pageErrors = [];

function seedDb(ud) {
  return new Promise((resolve, reject) => {
    // baseUrl=null：不创建 Fake API 连接，external import 不需要 Probe
    const p = spawn(ELECTRON_BIN, [path.join(ROOT, 'test', 'e2e', 'seed-db.js'), ud, ''], {
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
  p.on('pageerror', e => pageErrors.push(e.message));
  await p.waitForLoadState('domcontentloaded');
  try {
    await p.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  } catch (e) {
    const dump = await p.evaluate(() => ({
      bodyHTML: document.body.innerHTML.slice(0, 1500),
      title: document.title
    })).catch(() => null);
    process.stderr.write(`[ext-import-e2e boot-fail] pageErrors=${JSON.stringify(pageErrors)}\n[ext-import-e2e boot-fail] dump=${JSON.stringify(dump)}\n`);
    throw e;
  }
  await p.waitForTimeout(800);
  return a;
}

/** 设置下一次 externalImport:selectFile 返回的文件路径（测试钩子，一次性） */
async function setFilePick(p, filePath) {
  await p.evaluate(async (fp) => {
    await window.api.invoke('externalImport:testSetFilePick', fp);
  }, filePath);
}

/** 获取当前所有连接列表 */
async function getConnections(p) {
  return await p.evaluate(async () => {
    const r = await window.api.invoke('connections:list');
    return r && r.data !== undefined ? r.data : r;
  });
}

/** 关闭 modal-overlay */
async function closeModal(p) {
  const modal = p.locator('#modal-overlay:not(.hidden)');
  if (await modal.count() === 0) return;
  const x = p.locator('#modal-overlay .modal-x');
  if (await x.count() > 0) { await x.click(); }
  else { await p.keyboard.press('Escape'); }
  await p.waitForTimeout(300);
}

/**
 * 打开「从其他工具导入」弹窗，选择指定来源，等待自动发现完成后点击「手动选择文件」。
 * 在 CI（无 Codex/Claude/OpenCode 安装）上自动发现必然返回 0 candidate → 出现 #ext-manual。
 * 先设置 testFilePickPath，再点击 #ext-manual，fixture 文件被解析。
 */
async function openImportAndPickFixture(p, sourceType, fixturePath) {
  await p.getByRole('button', { name: 'API 连接' }).click();
  await p.waitForSelector('#conn-external', { timeout: 10000 });
  await p.locator('#conn-external').click();
  await p.waitForSelector('.ext-source-btn', { timeout: 10000 });

  // 点击来源按钮（触发自动发现）
  await p.locator(`[data-src="${sourceType}"]`).click();

  // 等待「手动选择文件」按钮出现（自动发现 0 candidate 时显示）
  await p.waitForSelector('#ext-manual', { timeout: 15000 });

  // 设置文件选择钩子，然后点击手动选择文件
  await setFilePick(p, fixturePath);
  await p.locator('#ext-manual').click();

  // 等待预览表出现
  await p.waitForSelector('#ext-preview-tbl', { timeout: 10000 });
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-extimport-'));
  await seedDb(userData);
  app = await launchApp(userData);
  page = await app.firstWindow();
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── §74 Case 18: Codex config file → Preview → Import ─────────────────────

test('18) §74 Codex config → Preview → Import（wire_api=responses → openai-responses）', async () => {
  const fixture = path.join(FIXTURES, 'codex', 'config-responses.toml');
  await openImportAndPickFixture(page, 'codex', fixture);

  // 预览应显示 1 个候选：Test Provider
  await expect(page.locator('#ext-preview-tbl')).toContainText('Test Provider');
  // §74: protocol = OpenAI Responses
  await expect(page.locator('#ext-preview-tbl')).toContainText('OpenAI Responses');
  // §75: key 必须 mask
  await expect(page.locator('#ext-preview-tbl')).not.toContainText('sk-test-codex-responses-1234567890abcdef');
  await expect(page.locator('#ext-preview-tbl')).toContainText('•');
  // 状态应为新增
  await expect(page.locator('#ext-preview-tbl')).toContainText('新增');

  // 导入
  await page.locator('#ext-import').click();
  await page.waitForTimeout(1500);

  // 结果页应显示已导入
  await expect(page.locator('#modal')).toContainText('已导入');
  await expect(page.locator('#modal')).toContainText('Test Provider');

  // 关闭弹窗，验证连接已保存
  await page.locator('#ext-done').click();
  await page.waitForTimeout(500);

  const conns = await getConnections(page);
  const conn = conns.find(c => c.name === 'Test Provider');
  expect(conn, 'Test Provider 连接应已保存').toBeTruthy();
  // §74: protocol = openai-responses
  expect(conn.provider).toBe('openai-responses');
  expect(conn.base_url).toContain('127.0.0.1:18000');
  // §74: model = model-A（写入为 manual 模型）
  const models = conn.models || [];
  const hasModelA = models.some(m => (typeof m === 'string' ? m : m.id) === 'model-A');
  expect(hasModelA, '连接应包含 model-A').toBe(true);

  // 确认无 JS 致命错误
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
});

// ─── §75 Case 19: Claude Code ENV → Preview → Import ───────────────────────

test('19) §75 Claude Code ENV → Preview → Import（ANTHROPIC_API_KEY → anthropic）', async () => {
  const fixture = path.join(FIXTURES, 'claude', 'standard.env');
  await openImportAndPickFixture(page, 'claude-code', fixture);

  // 预览应显示候选（Claude Code 标准配置，name 由 suggestName 推断）
  // §75: protocol = Anthropic
  await expect(page.locator('#ext-preview-tbl')).toContainText('Anthropic');
  // §75: key 必须 mask
  await expect(page.locator('#ext-preview-tbl')).not.toContainText('sk-test-anthropic-key-abcdef123456');
  await expect(page.locator('#ext-preview-tbl')).toContainText('•');
  // 状态应为新增
  await expect(page.locator('#ext-preview-tbl')).toContainText('新增');

  // 导入
  await page.locator('#ext-import').click();
  await page.waitForTimeout(1500);

  // 结果页应显示已导入
  await expect(page.locator('#modal')).toContainText('已导入');

  // 关闭弹窗
  await page.locator('#ext-done').click();
  await page.waitForTimeout(500);

  // 验证连接保存了 anthropic 协议
  const conns = await getConnections(page);
  const anthropicConns = conns.filter(c => c.provider === 'anthropic' && c.base_url && c.base_url.includes('127.0.0.1:18010'));
  expect(anthropicConns.length, '应存在 anthropic 协议连接').toBeGreaterThanOrEqual(1);
});

// ─── §76 Case 20: OpenCode multi-provider → Batch Import ────────────────────

test('20) §76 OpenCode multi-provider → Batch Import（A+B 导入，C 不导入）', async () => {
  const fixture = path.join(FIXTURES, 'opencode', 'multi.json');
  await openImportAndPickFixture(page, 'opencode', fixture);

  // 预览应显示 3 个候选
  await expect(page.locator('#ext-preview-tbl')).toContainText('Provider A');
  await expect(page.locator('#ext-preview-tbl')).toContainText('Provider B');
  await expect(page.locator('#ext-preview-tbl')).toContainText('Provider C');

  // 取消勾选 Provider C（§76: 选择 A+B）
  // 找到 Provider C 所在行的 checkbox
  const rowC = page.locator('tr.ext-row', { hasText: 'Provider C' });
  const cbC = rowC.locator('[data-check]');
  if (await cbC.isChecked()) await cbC.uncheck();

  // 导入
  await page.locator('#ext-import').click();
  await page.waitForTimeout(1500);

  // 结果页应显示 A 和 B 已导入
  await expect(page.locator('#modal')).toContainText('Provider A');
  await expect(page.locator('#modal')).toContainText('Provider B');
  // §76: 成功 2
  await expect(page.locator('#modal')).toContainText('成功 2');

  // 关闭弹窗
  await page.locator('#ext-done').click();
  await page.waitForTimeout(500);

  // 验证连接列表：A 和 B 存在，C 不存在
  const conns = await getConnections(page);
  expect(conns.find(c => c.name === 'Provider A'), 'Provider A 应已导入').toBeTruthy();
  expect(conns.find(c => c.name === 'Provider B'), 'Provider B 应已导入').toBeTruthy();
  expect(conns.find(c => c.name === 'Provider C'), 'Provider C 不应被导入').toBeFalsy();
});

// ─── §77 Case 21: Conflict detection (DUPLICATE) ───────────────────────────

test('21) §77 Conflict detection：预建同 baseUrl+protocol → DUPLICATE', async () => {
  // 先通过 IPC 预建一个连接，与 config-chat.toml 的 baseUrl+provider 相同
  // config-chat.toml: base_url=http://127.0.0.1:18001/v1, wire_api=chat → provider=openai
  const created = await page.evaluate(async () => {
    const r = await window.api.invoke('connections:create', {
      name: 'Pre-existing Chat Conn',
      provider: 'openai',
      base_url: 'http://127.0.0.1:18001/v1',
      api_key: 'sk-pre-existing-key-for-conflict-test'
    });
    return r && r.data !== undefined ? r.data : r;
  });
  expect(created && created.id, '预建连接应成功').toBeTruthy();

  const fixture = path.join(FIXTURES, 'codex', 'config-chat.toml');
  await openImportAndPickFixture(page, 'codex', fixture);

  // 预览应显示 Chat Provider
  await expect(page.locator('#ext-preview-tbl')).toContainText('Chat Provider');
  // §77: 状态应为重复（同 baseUrl + 同 protocol）
  await expect(page.locator('#ext-preview-tbl')).toContainText('重复');
  // §77: 应显示现有连接名
  await expect(page.locator('#ext-preview-tbl')).toContainText('Pre-existing Chat Conn');

  // 关闭弹窗（不导入，仅验证冲突检测）
  await closeModal(page);
});

// ─── §78 Case 22: Missing Secret → 手动补 Key → Import ──────────────────────

test('22) §78 Missing Secret → 手动补 Key → Import 成功', async () => {
  const fixture = path.join(FIXTURES, 'malformed', 'codex-missing-key.toml');
  await openImportAndPickFixture(page, 'codex', fixture);

  // 预览应显示 Missing Key Provider
  await expect(page.locator('#ext-preview-tbl')).toContainText('Missing Key Provider');
  // §78: 状态应为缺少密钥
  await expect(page.locator('#ext-preview-tbl')).toContainText('缺少密钥');
  // §78: 应有手动补 key 的输入框
  const manualKeyInput = page.locator('[data-manual-key]');
  await expect(manualKeyInput).toHaveCount(1);

  // 填入手动 key
  await manualKeyInput.fill('sk-test-manual-key-abcdef123456');

  // 导入
  await page.locator('#ext-import').click();
  await page.waitForTimeout(1500);

  // 结果页应显示已导入
  await expect(page.locator('#modal')).toContainText('已导入');
  await expect(page.locator('#modal')).toContainText('Missing Key Provider');

  // 关闭弹窗
  await page.locator('#ext-done').click();
  await page.waitForTimeout(500);

  // 验证连接已保存
  const conns = await getConnections(page);
  const conn = conns.find(c => c.name === 'Missing Key Provider');
  expect(conn, 'Missing Key Provider 连接应已保存（用手动补的 key）').toBeTruthy();
  expect(conn.provider).toBe('openai');
  expect(conn.base_url).toContain('127.0.0.1:18070');
});

// ─── §79 Case 23: OAuth / Session credential rejected ──────────────────────

test('23) §79 OAuth/Session credential rejected（unsupported_credential，0 candidate）', async () => {
  // 记录导入前的连接数
  const connsBefore = await getConnections(page);
  const countBefore = connsBefore.length;

  const fixture = path.join(FIXTURES, 'claude', 'session-credentials.json');

  await page.getByRole('button', { name: 'API 连接' }).click();
  await page.waitForSelector('#conn-external', { timeout: 10000 });
  await page.locator('#conn-external').click();
  await page.waitForSelector('.ext-source-btn', { timeout: 10000 });

  // 选择 Claude Code
  await page.locator('[data-src="claude-code"]').click();

  // 等待「手动选择文件」按钮
  await page.waitForSelector('#ext-manual', { timeout: 15000 });

  // 设置 fixture 路径并点击手动选择文件
  await setFilePick(page, fixture);
  await page.locator('#ext-manual').click();

  // §79: 应显示「未发现可导入配置」（0 candidate）
  await expect(page.locator('#modal')).toContainText('未发现可导入配置');
  // §79: 应显示 unsupported_credential 警告（不迁移账号登录态）
  await expect(page.locator('#modal')).toContainText('登录态');
  // §79: 不得显示完整 token
  await expect(page.locator('#modal')).not.toContainText('test-session-token-not-real-credential');
  await expect(page.locator('#modal')).not.toContainText('test-oauth-token-not-real');

  // 关闭弹窗
  await page.locator('#ext-back').click();
  await closeModal(page);

  // 验证没有新连接被创建
  const connsAfter = await getConnections(page);
  expect(connsAfter.length, '不应创建任何新连接').toBe(countBefore);
});
