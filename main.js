'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// v2.3.1 (GUI E2E)：独立 userData —— E2E 用临时目录跑真实 GUI，绝不污染真实用户数据。
if (process.env.ADP_USER_DATA) {
  try { app.setPath('userData', process.env.ADP_USER_DATA); } catch { /* 忽略非法路径 */ }
}

let mainWindow = null;
let httpServer = null;
let handlersModule = null;
let shutdownStarted = false;
let shutdownComplete = false;

// --smoke : boot headless-ish, load the UI, collect renderer errors, exit.
// Used by `npm run smoke` so the packaged app is never shipped with a
// renderer that throws on first paint.
const SMOKE = process.argv.includes('--smoke');
const INTEGRATION_SMOKE = process.argv.includes('--integration-smoke');
// v2.9.0 Real Runtime Smoke Closure：--real-ai-smoke 在真实 App 主进程内跑 Real AI
// Orchestrator Smoke（真实 app 身份 → safeStorage 可解密平台 Connection 密钥，
// store 路径与生产完全一致）。不透传任何窗口/服务初始化。
const REAL_AI_SMOKE = process.argv.includes('--real-ai-smoke');
const smokeErrors = [];

// --smoke-result-file=<path> : write the smoke outcome as JSON to a file so
// the 7z portable wrapper can verify boot without relying on stdout (which
// it doesn't reliably forward). §71
const SMOKE_RESULT_FILE = (() => {
  const arg = process.argv.find(a => a.startsWith('--smoke-result-file='));
  return arg ? arg.slice('--smoke-result-file='.length) : null;
})();
const APP_VERSION = (() => { try { return require('./package.json').version || 'unknown'; } catch { return 'unknown'; } })();

async function bootstrap() {
  const userDataPath = app.getPath('userData');
  const store = require('./src/db/store');
  store.init(userDataPath);

  // First-run: migrate v1 JSON (if present) then seed defaults
  const initialized = store.settings.get('_initialized');
  if (!initialized) {
    const { seedDefaults, findLegacyDataJson } = require('./src/db/seed');
    const legacy = findLegacyDataJson(userDataPath, __dirname);
    if (legacy) {
      const bak = legacy + '.migrated.bak';
      try { fs.copyFileSync(legacy, bak); } catch {}
      store.migrateFromJson(legacy);
    }
    seedDefaults(store);
    store.settings.set('_initialized', true);
  }

  if (INTEGRATION_SMOKE) {
    await runIntegrationSmoke(userDataPath);
    return;
  }

  if (REAL_AI_SMOKE) {
    await runRealAiSmoke();
    return;
  }

  // Static renderer server (127.0.0.1 only; logic goes through IPC)
  const { start } = require('./src/server/static');
  const { server, port } = await start(0);
  httpServer = server;

  // Register IPC + connect MCP servers
  const handlers = require('./src/ipc/handlers');
  handlersModule = handlers;
  mainWindow = createWindow(port);
  handlers.register(mainWindow);
  await handlers.initServices();
  console.log(`Agent Dev Platform ready on http://127.0.0.1:${port}`);
  if (SMOKE) runSmoke(port);
}

async function runIntegrationSmoke(userDataPath) {
  const { ClineSidecarManager } = require('./src/agents/integrations/cline/sidecarManager');
  const manager = new ClineSidecarManager({
    resourcesPath: process.resourcesPath,
    dataDir: path.join(userDataPath, 'cline')
  });
  let code = 0;
  try {
    const probe = await manager.probe(__dirname);
    if (!probe.ok || probe.runtime !== 'ClineCore' || probe.networkCall !== false || !probe.coreConstructible) {
      throw new Error('Packaged ClineCore probe returned an invalid health result');
    }
    console.log(`CLINE_PACKAGED_INTEGRATION_SMOKE_OK node=${probe.nodeVersion} sdk=${probe.clineSdkVersion} networkCall=false`);
  } catch (error) {
    code = 1;
    console.error(`CLINE_PACKAGED_INTEGRATION_SMOKE_FAILED ${error.message}`);
  } finally {
    const stopped = await manager.shutdown();
    if (!stopped.ok || manager.child) {
      code = 1;
      console.error(`CLINE_PACKAGED_INTEGRATION_SMOKE_FAILED sidecar shutdown: ${stopped.error || 'child still present'}`);
    }
  }
  app.exit(code);
}

/**
 * v2.9.0 Real Runtime Smoke Closure — 在真实 App 主进程内跑 Real AI Smoke。
 * 真实 app 身份保证：safeStorage（DPAPI + app 绑定熵）能解密平台 Connection 密钥，
 * store.init(userData) 与生产同一 DB —— §5 Store Connection 优先级真正生效。
 * connectionId 可经 --real-ai-connection=<id> 传入；dry-run 经 --real-ai-dry-run
 * （验证 resolution/session/decrypt/model，0 provider call，不消耗 paid attempt）。
 */
async function runRealAiSmoke() {
  const arg = process.argv.find(a => a.startsWith('--real-ai-connection='));
  const connectionId = arg ? arg.slice('--real-ai-connection='.length) : null;
  const dryRunFlag = process.argv.includes('--real-ai-dry-run') || process.env.REAL_AI_SMOKE_DRY_RUN === '1';
  // smoke 脚本读 process.argv[2] 作为 connectionId，--dry-run 作为旗标
  const argv = [process.execPath, path.join(__dirname, 'scripts', 'real-ai-orchestrator-smoke.js'), connectionId || ''];
  if (dryRunFlag) argv.push('--dry-run');
  process.argv = argv;
  // §71 同款：把结果写到 TEMP 文件，退出码/结果不依赖 stdio 转发链
  // （guard 可经 REAL_AI_RESULT_FILE 预生成路径，已存在则复用）
  const os = require('os');
  if (!process.env.REAL_AI_RESULT_FILE) {
    process.env.REAL_AI_RESULT_FILE = path.join(os.tmpdir(), `adp-real-ai-result-${process.pid}.json`);
  }
  const resultFile = process.env.REAL_AI_RESULT_FILE;
  try {
    const { main } = require('./scripts/real-ai-orchestrator-smoke');
    await main();   // main() 内部 process.exit（PASS=0 / FAIL=1 / ENV=2 / BLOCKED=3/4 / SKIP=0）
  } catch (e) {
    console.log('REAL_AI_ORCHESTRATOR_SMOKE');
    console.log('Status: FAIL');
    console.log(`Reason: ${(e && e.code) || 'UNEXPECTED'}`);
    console.log(`Message: ${e && e.message}`);
    app.exit(1);
  }
  // 兑底（main 理论上必 exit）：以结果文件为准决定退出码
  let code = 1;
  try { code = JSON.parse(fs.readFileSync(resultFile, 'utf8')).exitCode ?? 1; } catch { /* keep 1 */ }
  app.exit(code);
}

function writeSmokeResultFile(result) {
  if (!SMOKE_RESULT_FILE) return;
  try {
    fs.writeFileSync(SMOKE_RESULT_FILE, JSON.stringify(result, null, 2));
  } catch (e) {
    // File write failed — stdout output above remains the fallback. §71
    console.error('SMOKE_RESULT_FILE_WRITE_FAILED ' + e.message);
  }
}

async function runSmoke(port) {
  const wc = mainWindow.webContents;
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) smokeErrors.push(`[console] ${message} (${sourceId}:${line})`);
  });
  wc.on('render-process-gone', (_e, d) => smokeErrors.push(`[renderer gone] ${d.reason}`));
  wc.on('preload-error', (_e, p, err) => smokeErrors.push(`[preload] ${p}: ${err.message}`));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => smokeErrors.push(`[load] ${code} ${desc}`));

  await new Promise(r => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await new Promise(r => setTimeout(r, 2500)); // let boot() finish its IPC round-trips

  // Ask the renderer to report what it actually rendered.
  let probe;
  try {
    probe = await wc.executeJavaScript(`(() => ({
      hasApi: typeof window.api === 'object',
      title: document.querySelector('.brand, .topbar')?.textContent?.trim().slice(0, 60) || null,
      agentOptions: document.querySelectorAll('#agent-select option').length,
      chatItems: document.querySelectorAll('.chat-item').length,
      messages: document.querySelectorAll('.msg, .bubble').length,
      fatal: document.body.innerText.includes('必须在 Agent Dev Platform') || false,
      bodyLen: document.body.innerHTML.length
    }))()`);
  } catch (e) { smokeErrors.push('[probe] ' + e.message); }

  console.log('SMOKE_PROBE ' + JSON.stringify(probe || null));

  // Exercise the Diagnostics page (P1-5) so render-time errors surface here
  // instead of only in the user's face. Clicks the nav button, waits for the
  // async connection load, then checks the capability matrix rendered.
  try {
    await wc.executeJavaScript(`(() => { const b = document.querySelector('[data-page="diagnostics"]'); if (b) b.click(); return !!b; })()`);
    await new Promise(r => setTimeout(r, 700));
    const diag = await wc.executeJavaScript(`(() => ({
      title: document.querySelector('#page-title')?.textContent || null,
      hasRunBtn: !!document.querySelector('#diag-run'),
      hasMatrix: !!document.querySelector('#diag-matrix'),
      hasEmpty: !!document.querySelector('#diag-goto-api'),
      hasErr: !!document.querySelector('#page-body .err')
    }))()`);
    console.log('SMOKE_DIAG ' + JSON.stringify(diag));
    if (diag.hasErr) smokeErrors.push('[diag] 诊断页渲染抛错');
    else if (!((diag.hasRunBtn && diag.hasMatrix) || diag.hasEmpty)) smokeErrors.push('[diag] 诊断页未正确渲染: ' + JSON.stringify(diag));
  } catch (e) { smokeErrors.push('[diag] ' + e.message); }

  if (smokeErrors.length) {
    const error = smokeErrors.join('\n');
    console.error('SMOKE_FAIL\n' + error);
    writeSmokeResultFile({ ok: false, error, timestamp: new Date().toISOString() });
    app.exit(1);
  } else if (!probe || !probe.hasApi || probe.bodyLen < 500) {
    const error = '渲染层未正常挂载: ' + JSON.stringify(probe);
    console.error('SMOKE_FAIL ' + error);
    writeSmokeResultFile({ ok: false, error, timestamp: new Date().toISOString() });
    app.exit(1);
  } else {
    console.log('SMOKE_OK');
    writeSmokeResultFile({
      ok: true,
      smoke: 'SMOKE_OK',
      timestamp: new Date().toISOString(),
      version: APP_VERSION
    });
    app.exit(0);
  }
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1366, height: 850, minWidth: 1000, minHeight: 640,
    title: 'Agent Dev Platform',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, minWidth: 800, minHeight: 560, backgroundColor: '#0d1117', autoHideMenuBar: true, title: '对话窗口' } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { if (win === mainWindow) mainWindow = null; });
  return win;
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (httpServer) { try { httpServer.close(); } catch {} httpServer = null; }
  app.quit();
});
app.on('before-quit', event => {
  if (shutdownComplete || !handlersModule?.shutdownServices) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(handlersModule.shutdownServices()).finally(() => {
    shutdownComplete = true;
    if (httpServer) { try { httpServer.close(); } catch {} httpServer = null; }
    app.quit();
  });
});
app.on('will-quit', () => {
  // The sidecar also treats stdin EOF as shutdown; this is the final lifecycle
  // backstop for forced app exits after before-quit cleanup has begun.
  if (!shutdownComplete && handlersModule?.shutdownServices) void handlersModule.shutdownServices();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) bootstrap(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
}
