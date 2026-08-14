'use strict';
/**
 * v2.8.0 — ACP Runtime / Codex / Claude / External Session E2E（Case 54-65，spec §123）。
 *
 * 在真实 Electron 窗口 + 真实 ACP 子进程中验证"通用外部 Agent 通信层"：
 *   54) ACP Agent Center —— 注册真实 AcpAgentAdapter（指向 fake ACP Agent 子进程）
 *       → hub:available 暴露 transportLabel/installed/auth，智能体页面渲染 ACP 卡片。
 *   55) ACP Capability Handshake —— v1 握手成功 → Run COMPLETED；
 *       期望能力未满足（mcpHttp）→ FAILED(CAPABILITY_NEGOTIATION_FAILED)，绝不降级硬发。
 *   56) ACP Permission Request —— 权限交集：只读父 Run 拒绝 shell → refusal(ok=false)；
 *       读写父 Run 放行 edit → end_turn(ok=true)。绝不取并集。
 *   57) ACP Cancel —— session/cancel 通知 → 唯一终态 run_cancelled（不是 failed）。
 *   58) ACP Timeout —— Agent 挂死 → 唯一终态 run_timeout（超时 ≠ 取消）。
 *   59) ACP Crash —— Agent 进程中途退出 → run_failed(ACP_UNEXPECTED_EXIT)，绝不判 COMPLETED。
 *   60) ACP Resume —— resumeSessionId → session/resume → 同一 sessionId 继续（Session ≠ Run）。
 *   61) Codex Deep Adapter —— codex 已注册 + transportLabel + auth 面 + 路由候选。
 *   62) Claude Adapter —— claude-code 已注册 + transportLabel + auth 面。
 *   63) Codex auth-required —— getAuthStatus=required → AUTH_REQUIRED 落库 + GUI「需要登录」。
 *   64) Claude auth-required —— 无 API Key → UNKNOWN（平台不读凭据）→ GUI 如实展示未认证。
 *   65) External Session persistence —— external_agent_sessions 落库 + 唯一索引幂等 + 无凭据字段。
 *
 * 隔离：临时 userData + 临时 fixture 副本；fake ACP Agent 纯本地确定性实现（无网络、无 LLM）。
 * 依赖：NODE_ENV=test（hub:testRegisterAcpAdapter / hub:testSetCodexAuth 钩子可用）。
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { start } = require('./fake-api');
const { copyFixture, cleanup } = require('../fixtures/coding-agent/reset');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake = null;
let app = null;
let page = null;
let userData = null;
let fixtureRoot = null;
let fixtureProjectId = null;
let pageErrors = [];

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
  const env = { ...process.env, ADP_USER_DATA: ud, NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  // 确定性：剥离可能影响 auth 判定的真实凭据环境变量（绝不把真凭据带进 E2E）
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const a = await electron.launch({
    args: ['.', '--disable-gpu'],
    cwd: ROOT,
    env
  });
  const p = await a.firstWindow();
  pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });
  await p.waitForLoadState('domcontentloaded');
  await p.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  await p.waitForTimeout(800);
  // 事件探针：agent.* 事件 + 终态事件
  await p.evaluate(() => {
    window._hubEvents = [];
    window._runTerms = [];
    if (window.api && window.api.onEvent) {
      window.api.onEvent(e => {
        const t = e && e.type;
        if (typeof t === 'string' && t.startsWith('agent.')) {
          if (window._hubEvents.length > 400) window._hubEvents.shift();
          window._hubEvents.push({ type: t, ...e });
        }
        if (['run_completed', 'run_failed', 'run_cancelled', 'run_timeout', 'run_interrupted'].includes(t)) {
          window._runTerms.push(t);
        }
      });
    }
  });
  return a;
}

/** 通用 IPC invoke（自动解包 { data } 信封） */
async function invoke(channel, ...args) {
  return await page.evaluate(async ({ ch, a }) => {
    const r = await window.api.invoke(ch, ...a);
    return r && r.data !== undefined ? r.data : r;
  }, { ch: channel, a: args });
}

/** 注册一个指向 fake ACP Agent 子进程的真实 AcpAgentAdapter */
async function registerAcp(id, agentConfig = {}, adapterConfig = {}) {
  const r = await invoke('hub:testRegisterAcpAdapter', {
    manifest: { id, displayName: id, transport: 'acp', capabilities: { coding: true }, maxConcurrency: 2 },
    agentConfig,
    adapterConfig
  });
  expect(r && r.ok, `注册 ${id} 应成功`).toBe(true);
  return r;
}

/** 启动一个 Hub Run，返回 runId */
async function startHubRun(agentId, task = {}) {
  const r = await invoke('hub:start', agentId, { goal: '修复 add 函数的边界条件', ...task });
  expect(r && r.runId, `${agentId} 应返回 runId`).toBeTruthy();
  return r.runId;
}

/** 轮询 hub:status 直到满足谓词 */
async function pollStatus(runId, pred, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await invoke('hub:status', runId);
    if (last && pred(last)) return last;
    await new Promise(res => setTimeout(res, 100));
  }
  return last;
}

/** 等待终态事件数量达到 n，返回终态列表 */
async function waitTerms(n, timeoutMs = 45000) {
  await page.waitForFunction(target => (window._runTerms || []).length >= target, n, { timeout: timeoutMs });
  return await page.evaluate(() => (window._runTerms || []).slice());
}

/** 清空事件探针 */
async function resetProbes() {
  await page.evaluate(() => { window._hubEvents = []; window._runTerms = []; });
}

async function getHubEvents() {
  return await page.evaluate(() => (window._hubEvents || []).slice());
}

async function openAgentsPage() {
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  await page.waitForSelector('#hub-cards', { timeout: 10000 });
}

function assertNoFatals() {
  const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  expect(fatals).toEqual([]);
}

test.beforeAll(async () => {
  fake = await start(0);
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-acp-'));
  await seedDb(userData, fake.baseUrl);
  fixtureRoot = await copyFixture();
  app = await launchApp(userData);
  page = app.firstWindow ? await app.firstWindow() : page;
  // 创建并打开 fixture 项目（会话落库需要 projectRoot）
  const proj = await invoke('projects:create', { name: 'Fixture ACP', rootPath: fixtureRoot });
  fixtureProjectId = proj.id;
});

test.afterAll(async () => {
  try { if (app) await app.close(); } catch { /* already closed */ }
  try { if (fake) fake.server.close(); } catch { /* already closed */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  try { if (fixtureRoot) await cleanup(fixtureRoot); } catch { /* best effort */ }
});

test('54) ACP Agent Center：真实 ACP 适配器注册 + transportLabel + 卡片渲染', async () => {
  pageErrors = [];
  await registerAcp('fake-acp');

  const available = await invoke('hub:available');
  expect(Array.isArray(available)).toBe(true);
  const entry = available.find(a => a.id === 'fake-acp');
  expect(entry, 'hub:available 应包含 fake-acp').toBeTruthy();
  expect(entry.transportLabel, 'ACP transport 标签').toBe('ACP');
  expect(entry.installed, 'fake agent 命令应探测为已安装').toBe(true);
  expect(entry.transport).toBe('acp');
  // 认证状态只暴露状态机展示值，握手前为 UNKNOWN
  expect(entry.auth, '应暴露 auth 状态对象').toBeTruthy();
  expect(entry.auth.state).toBe('UNKNOWN');
  expect(JSON.stringify(entry), 'available 输出绝不含凭据字段').not.toMatch(/token|cookie|secret/i);

  // GUI 卡片渲染
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="fake-acp"]');
  }, null, { timeout: 15000 });
  const card = page.locator('#hub-cards .acard[data-hub-id="fake-acp"]');
  await expect(card.locator('.chip', { hasText: 'ACP' })).toBeVisible();
  assertNoFatals();
});

test('55) ACP Capability Handshake：v1 握手成功 COMPLETED；期望能力缺失 → FAILED', async () => {
  pageErrors = [];
  await resetProbes();

  // 正向：默认 fake agent（v1 形状，无违规）→ COMPLETED。
  // 自包含注册：失败用例会触发 worker 重启，跨用例状态依赖不可靠。
  await registerAcp('fake-acp-hs');
  const runId = await startHubRun('fake-acp-hs', { projectRoot: fixtureRoot, projectId: fixtureProjectId });
  const terms = await waitTerms(1);
  expect(terms).toEqual(['run_completed']);

  const status = await invoke('hub:status', runId);
  expect(status.status).toBe('completed');

  const res = await invoke('hub:result', runId);
  expect(res, '应有结果').toBeTruthy();
  const result = res.result || res;
  expect(result.ok, 'end_turn 应判成功').toBe(true);
  expect(result.status).toBe('completed');
  // sessionId 由 Agent 生成并经结果回传（Session ≠ Run）
  expect(result.sessionId, 'sessionId 由 Agent 生成并回传').toBe('fake-session-1');
  // 流式 chunk 累积出 summary（DEFAULT_UPDATES 的两段文本）
  expect(String(result.summary || '')).toContain('修改');

  // 事件流：应见到 agent.* 归一化事件（消息 / 工具 / 计划）
  const events = await getHubEvents();
  const types = events.map(e => e.type);
  expect(types.some(t => t === 'agent.message' || t === 'agent.message.chunk' || t.startsWith('agent.message')), '应有消息类事件').toBe(true);

  // 反向：期望 mcpHttp 但 fake 未声明 → CAPABILITY_NEGOTIATION_FAILED（绝不降级硬发）
  await registerAcp('fake-acp-cap', {}, { expectedAcpCapabilities: { mcpHttp: true } });
  await resetProbes();
  const badRunId = await startHubRun('fake-acp-cap', { projectRoot: fixtureRoot });
  const badTerms = await waitTerms(1);
  expect(badTerms).toEqual(['run_failed']);
  const badEvents = await getHubEvents();
  const failed = badEvents.find(e => e.type === 'agent.run.failed');
  expect(failed, '应有 run.failed 事件').toBeTruthy();
  expect(String(failed.errorCode || '')).toContain('CAPABILITY_NEGOTIATION_FAILED');
  assertNoFatals();
});

test('56) ACP Permission Request：权限交集（只读拒绝 → refusal；读写放行 → end_turn）', async () => {
  pageErrors = [];
  const permToolCall = {
    toolCallId: 'tool-perm',
    title: 'npm test',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm test' }
  };
  await registerAcp('fake-acp-perm', { requestPermission: permToolCall });

  // A) 只读父 Run：shell 属于写操作 → PARENT_READ_ONLY 拒绝 → agent refusal 收尾
  await resetProbes();
  const runA = await startHubRun('fake-acp-perm', { projectRoot: fixtureRoot, readOnly: true });
  expect(await waitTerms(1)).toEqual(['run_completed']); // refusal 也是 completed（不是 failed）
  const resA = await invoke('hub:result', runA);
  const resultA = resA.result || resA;
  expect(resultA.ok, '权限被拒 → refusal → ok=false').toBe(false);
  expect(String(resultA.stopReason)).toBe('refusal');
  expect(JSON.stringify(resultA.errors || [])).toContain('refusal');

  // B) 读写父 Run：交集通过且无 resolver → allow_once 放行 → end_turn 成功
  await resetProbes();
  const runB = await startHubRun('fake-acp-perm', { projectRoot: fixtureRoot });
  expect(await waitTerms(1)).toEqual(['run_completed']);
  const resB = await invoke('hub:result', runB);
  const resultB = resB.result || resB;
  expect(resultB.ok, '权限放行 → end_turn → ok=true').toBe(true);
  expect(String(resultB.stopReason)).toBe('end_turn');
  assertNoFatals();
});

test('57) ACP Cancel：session/cancel 通知 → 唯一终态 cancelled', async () => {
  pageErrors = [];
  await registerAcp('fake-acp-cancel', { promptDelayMs: 15000 });
  await resetProbes();

  const runId = await startHubRun('fake-acp-cancel', { projectRoot: fixtureRoot });
  // 等到 Run 进入运行态（会话已建立）再取消
  await pollStatus(runId, s => s && s.status === 'running', 20000);

  const cancelResult = await invoke('hub:cancel', runId);
  expect(cancelResult, '取消应返回').toBeTruthy();

  const terms = await waitTerms(1);
  expect(terms, '取消的唯一终态是 cancelled（不是 failed）').toEqual(['run_cancelled']);
  const status = await invoke('hub:status', runId);
  expect(status.status).toBe('cancelled');
  // 等待 800ms 确认没有第二个终态事件（exactly-once）
  await page.waitForTimeout(800);
  const finalTerms = await page.evaluate(() => (window._runTerms || []).slice());
  expect(finalTerms).toEqual(['run_cancelled']);
  assertNoFatals();
});

test('58) ACP Timeout：Agent 挂死 → 唯一终态 timeout（超时 ≠ 取消）', async () => {
  pageErrors = [];
  await registerAcp('fake-acp-timeout', { hangOnPrompt: true }, { timeoutMs: 6000 });
  await resetProbes();

  const runId = await startHubRun('fake-acp-timeout', { projectRoot: fixtureRoot });
  const terms = await waitTerms(1, 60000);
  expect(terms, '挂死的唯一终态是 timeout').toEqual(['run_timeout']);

  const status = await invoke('hub:status', runId);
  expect(status.status).toBe('timeout');
  const res = await invoke('hub:result', runId);
  const result = res.result || res;
  expect(result.ok).toBe(false);
  expect(String(result.errorCode || '')).toContain('TIMEOUT');
  assertNoFatals();
});

test('59) ACP Crash：进程意外退出 → FAILED（绝不当成 COMPLETED）', async () => {
  pageErrors = [];
  await registerAcp('fake-acp-crash', { exitOnPrompt: true });
  await resetProbes();

  const runId = await startHubRun('fake-acp-crash', { projectRoot: fixtureRoot });
  const terms = await waitTerms(1);
  expect(terms, '意外退出只能判 failed').toEqual(['run_failed']);

  const status = await invoke('hub:status', runId);
  expect(status.status).toBe('failed');
  const res = await invoke('hub:result', runId);
  const result = res.result || res;
  expect(result.ok).toBe(false);
  expect(String(result.errorCode || '')).toContain('UNEXPECTED_EXIT');
  assertNoFatals();
});

test('60) ACP Resume：session/resume 复用同一 sessionId（Session ≠ Run）', async () => {
  pageErrors = [];
  await resetProbes();

  // 自包含：自己注册适配器并 resume fake agent 的 sessionId
  await registerAcp('fake-acp-resume');
  const runId = await startHubRun('fake-acp-resume', { projectRoot: fixtureRoot, resumeSessionId: 'fake-session-1' });
  expect(await waitTerms(1)).toEqual(['run_completed']);

  const status = await invoke('hub:status', runId);
  expect(status.status).toBe('completed');

  const res = await invoke('hub:result', runId);
  const result = res.result || res;
  expect(result.ok).toBe(true);
  expect(result.sessionId, 'resume 后 sessionId 保持不变').toBe('fake-session-1');
  assertNoFatals();
});

test('61) Codex Deep Adapter：注册 + transportLabel + auth 面 + 路由候选', async () => {
  pageErrors = [];
  // CI 机器无真实 codex CLI：预设探测结果，验证适配器表面（深度协议行为由单测覆盖）
  const det = await invoke('hub:testSetCodexDetected', {});
  expect(det.ok).toBe(true);

  const manifests = await invoke('hub:manifests');
  expect(manifests.map(m => m.id), 'codex 应在注册表').toContain('codex');

  const available = await invoke('hub:available');
  const codex = available.find(a => a.id === 'codex');
  expect(codex, 'hub:available 应包含 codex').toBeTruthy();
  // 深度集成标签：未运行时给候选集，绝不出现"文本抓取"这类降级描述
  expect(['Codex App Server', 'Codex Exec (structured)', 'Codex CLI (legacy)', 'App Server / Exec'])
    .toContain(codex.transportLabel);
  expect(codex.auth, 'codex 应暴露 auth 状态对象').toBeTruthy();
  expect(typeof codex.auth.authenticated).toBe('boolean');
  expect(JSON.stringify(codex.auth), 'auth 输出绝不含凭据本体').not.toMatch(/token|cookie|secret/i);

  // P4 自动路由 fail-closed：检测到安装不等于真实任务验证，不能自动入选。
  const automatic = await invoke('hub:route', { required: ['coding', 'filesystem'], preferred: ['git'] });
  expect(automatic.map(r => r.agentId), '仅有本机探测证据的 codex 不得自动路由').not.toContain('codex');
  // 手动指定仍可查看候选；实际启动还会经过健康、认证和权限门禁。
  const explicit = await invoke('hub:route', { agentId: 'codex', required: ['coding', 'filesystem'], preferred: ['git'] });
  expect(explicit.map(r => r.agentId), '手动指定时 codex 应保留在候选中').toContain('codex');

  // GUI：智能体页面渲染 Codex 卡片
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="codex"]');
  }, null, { timeout: 15000 });
  assertNoFatals();
});

test('62) Claude Adapter：注册 + transportLabel + auth 面', async () => {
  pageErrors = [];
  const manifests = await invoke('hub:manifests');
  expect(manifests.map(m => m.id), 'claude-code 应在注册表').toContain('claude-code');

  const available = await invoke('hub:available');
  const claude = available.find(a => a.id === 'claude-code');
  expect(claude, 'hub:available 应包含 claude-code').toBeTruthy();
  expect(['Claude Agent SDK', 'Claude CLI (structured)', 'ACP', 'Agent SDK / CLI'])
    .toContain(claude.transportLabel);
  expect(claude.auth, 'claude-code 应暴露 auth 状态对象').toBeTruthy();
  expect(JSON.stringify(claude.auth), 'auth 输出绝不含凭据本体').not.toMatch(/token|cookie|secret/i);

  // GUI：智能体页面渲染 Claude 卡片
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="claude-code"]');
  }, null, { timeout: 15000 });
  assertNoFatals();
});

test('63) Codex auth-required：AUTH_REQUIRED 状态映射 + 落库 + GUI「需要登录」', async () => {
  pageErrors = [];
  // 先保证 codex 在 available 里（探测预设），再模拟 app-server getAuthStatus 读取结果：未登录
  await invoke('hub:testSetCodexDetected', {});
  const hook = await invoke('hub:testSetCodexAuth', 'required');
  expect(hook.ok).toBe(true);
  expect(hook.auth.state, '真实 getAuthState 应映射为 AUTH_REQUIRED').toBe('AUTH_REQUIRED');
  expect(hook.auth.authenticated).toBe(false);

  const available = await invoke('hub:available');
  const codex = available.find(a => a.id === 'codex');
  expect(codex.auth.state).toBe('AUTH_REQUIRED');
  expect(codex.auth.authenticated).toBe(false);
  expect(codex.auth.detail, 'detail 是人类可读说明而非凭据').toContain('登录');

  // spec §110：非 UNKNOWN 的认证状态应落库（hub:sessions 读 external_agent_auth_states）
  const hub = await invoke('hub:sessions');
  const row = (hub.authStates || []).find(r => r.agent_id === 'codex');
  expect(row, 'codex 认证状态应落库').toBeTruthy();
  expect(row.state).toBe('AUTH_REQUIRED');
  expect(JSON.stringify(row), '落库记录绝不含凭据').not.toMatch(/token|cookie|secret/i);

  // GUI：卡片显示「需要登录」chip
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="codex"]');
  }, null, { timeout: 15000 });
  const card = page.locator('#hub-cards .acard[data-hub-id="codex"]');
  await expect(card.locator('.chip', { hasText: '需要登录' })).toBeVisible();
  assertNoFatals();
});

test('64) Claude auth-required：无 API Key → UNKNOWN（平台不读凭据）→ GUI 如实展示', async () => {
  pageErrors = [];
  const available = await invoke('hub:available');
  const claude = available.find(a => a.id === 'claude-code');
  // 平台绝不读取 Claude 登录凭据文件来"核实"登录态：无显式 API Key 时只能是 UNKNOWN
  expect(claude.auth.state).toBe('UNKNOWN');
  expect(claude.auth.authenticated, '无法核实登录态时绝不声称已认证').toBe(false);

  // GUI：UNKNOWN → 「认证状态未知」chip（如实降级，不虚构"已登录"）
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="claude-code"]');
  }, null, { timeout: 15000 });
  const card = page.locator('#hub-cards .acard[data-hub-id="claude-code"]');
  await expect(card.locator('.chip', { hasText: '认证状态未知' })).toBeVisible();
  assertNoFatals();
});

test('65) External Session persistence：external_agent_sessions 落库 + 幂等 + 无凭据', async () => {
  pageErrors = [];
  // 自包含：创建会话 + resume 同一会话，验证唯一索引幂等
  await registerAcp('fake-acp-sess');
  await resetProbes();
  const run1 = await startHubRun('fake-acp-sess', { projectRoot: fixtureRoot, projectId: fixtureProjectId });
  expect(await waitTerms(1)).toEqual(['run_completed']);
  await resetProbes();
  const run2 = await startHubRun('fake-acp-sess', { projectRoot: fixtureRoot, resumeSessionId: 'fake-session-1' });
  expect(await waitTerms(1)).toEqual(['run_completed']);

  const hub = await invoke('hub:sessions');
  expect(Array.isArray(hub.sessions)).toBe(true);

  const rows = hub.sessions.filter(s => s.agent_id === 'fake-acp-sess' && s.external_session_id === 'fake-session-1');
  expect(rows.length, '唯一索引保证同一外部会话只有一行（创建 + resume 幂等）').toBe(1);
  const row = rows[0];
  expect(row.transport).toBe('acp');
  expect(!!row.resumable, 'fake agent 声明 resume 能力 → resumable').toBe(true);
  expect(row.project_root, '会话应记录 projectRoot').toBeTruthy();
  expect(row.last_status, '应有最近状态').toBeTruthy();
  // spec §111：持久化视图不得含任何凭据字段
  expect(JSON.stringify(row)).not.toMatch(/token|apiKey|secret|credential/i);

  // GUI：会话面板只展示尾 4 位短标识，不暴露完整 sessionId
  await openAgentsPage();
  await page.waitForFunction(() => {
    return !!document.querySelector('#hub-cards .acard[data-hub-id="fake-acp-sess"]');
  }, null, { timeout: 15000 });
  const card = page.locator('#hub-cards .acard[data-hub-id="fake-acp-sess"]');
  await expect(card).toContainText('Session');
  // hubSessionShort('fake-session-1') → 去非字母数字后取尾 4 位大写
  await expect(card).toContainText('#ION1');
  await expect(card).toContainText('可继续');
  const cardText = await card.textContent();
  expect(cardText, '卡片不得展示完整外部 sessionId').not.toContain('fake-session-1');
  assertNoFatals();
});
