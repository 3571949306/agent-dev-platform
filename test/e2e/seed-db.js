'use strict';
/**
 * E2E seed —— 在 ELECTRON_RUN_AS_NODE=1 下运行（匹配 better-sqlite3 的 Electron ABI）。
 * 用法：electron test/e2e/seed-db.js <userData> [baseUrl]
 * 职责：初始化临时数据库 + 种子默认数据 + 创建测试项目 + 创建并预填 Fake API 模型。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const userData = process.argv[2];
const baseUrl = process.argv[3] || null;

const store = require(path.join(ROOT, 'src', 'db', 'store'));
const { seedDefaults } = require(path.join(ROOT, 'src', 'db', 'seed'));

fs.mkdirSync(userData, { recursive: true });
store.init(userData);
if (!store.settings.get('_initialized')) {
  seedDefaults(store);
  store.settings.set('_initialized', true);
}

const projects = store.projects.list();
const proj = projects[0] || store.projects.create({ name: 'E2E 测试项目', rootPath: ROOT });
store.settings.set('lastProjectId', proj.id);

const main = store.agents.listNative().find(a => a.is_main);
const openai = store.connections.list().find(c => c.provider === 'openai');

// E2E 专用 Fake 连接：创建 + 同步拉取模型 + 指向主智能体
const fakeConnName = 'Fake API';
let fakeConn = store.connections.list().find(c => c.name === fakeConnName);
if (!fakeConn && baseUrl) {
  fakeConn = store.connections.create({ name: fakeConnName, provider: 'openai', base_url: baseUrl, api_key: 'sk-e2e-fake' });
  if (main && !main.api_connection_id) store.agents.update(main.id, { api_connection_id: fakeConn.id });
  try {
    const url = new URL(baseUrl + '/models');
    const models = new Promise((resolve, reject) => {
      const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, res => {
        let body = ''; res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body).data.map(m => m.id)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
    });
    models.then(ids => { store.connections.setModels(fakeConn.id, ids); printSummary(); })
      .catch(e => { console.error('[seed] 拉取 Fake 模型失败:', e.message); printSummary(); });
    return; // 异步路径在 then/catch 里退出
  } catch (e) {
    console.error('[seed] 拉取 Fake 模型失败:', e.message);
  }
}
printSummary();

function printSummary() {
  console.log('SEED_OK project=' + proj.id + ' mainAgent=' + (main ? main.id : 'none') + ' openaiConn=' + (openai ? openai.id : 'none') + ' fakeConn=' + (fakeConn ? fakeConn.id : 'none') + (baseUrl ? ' base=' + baseUrl : ''));
  process.exit(0);
}