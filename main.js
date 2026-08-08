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

// --smoke : boot headless-ish, load the UI, collect renderer errors, exit.
// Used by `npm run smoke` so the packaged app is never shipped with a
// renderer that throws on first paint.
const SMOKE = process.argv.includes('--smoke');
const smokeErrors = [];

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

  // Static renderer server (127.0.0.1 only; logic goes through IPC)
  const { start } = require('./src/server/static');
  const { server, port } = await start(0);
  httpServer = server;

  // Register IPC + connect MCP servers
  const handlers = require('./src/ipc/handlers');
  mainWindow = createWindow(port);
  handlers.register(mainWindow);
  await handlers.initServices();
  console.log(`Agent Dev Platform ready on http://127.0.0.1:${port}`);
  if (SMOKE) runSmoke(port);
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
    console.error('SMOKE_FAIL\n' + smokeErrors.join('\n'));
    app.exit(1);
  } else if (!probe || !probe.hasApi || probe.bodyLen < 500) {
    console.error('SMOKE_FAIL 渲染层未正常挂载: ' + JSON.stringify(probe));
    app.exit(1);
  } else {
    console.log('SMOKE_OK');
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
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) bootstrap(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
}
