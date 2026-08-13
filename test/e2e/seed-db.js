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
// E2E fixture 代表「已配置过的既有用户」：关闭首次使用引导，
// 真实首启用户（空库）仍会看到完整 Onboarding 2.0。
store.settings.set('onboarding.completed', true);
store.settings.set('onboarding.skipped', false);

const projects = store.projects.list();
const proj = projects[0] || store.projects.create({ name: 'E2E 测试项目', rootPath: ROOT });
store.settings.set('lastProjectId', proj.id);

const main = store.agents.listNative().find(a => a.is_main);
const openai = store.connections.list().find(c => c.provider === 'openai');

// E2E 专用 Fake 连接：创建 + 同步拉取模型 + 指向主智能体
// v2.3.2：主智能体必须直接配为 Fake API + model-B，让每个 E2E Case 都能独立运行
// （否则 -g 单跑 Case 3 时主智能体仍是 OpenAI + model=null，preflight 拦截发送）。
const fakeConnName = 'Fake API';
let fakeConn = store.connections.list().find(c => c.name === fakeConnName);
if (!fakeConn && baseUrl) {
  fakeConn = store.connections.create({ name: fakeConnName, provider: 'openai', base_url: baseUrl, api_key: 'sk-test-e2e-fake' });
  // 总是把主智能体更新为 Fake API 连接 + model-B（确定 E2E 起点）
  if (main) store.agents.update(main.id, { api_connection_id: fakeConn.id, model: 'model-B' });
  // v2.9.9 Phase B（#1/#8）— 兼容保留的 legacy 通用对话智能体（非 is_main）。
  // 主编码智能体（is_main）默认产品入口切到 canonical mainAgent:run；
  // 旧 gui-main-path 用例（文本回复/fail/hang/timeout）改用这个 legacy 智能体走 agent:send。
  const generalName = '通用助手';
  if (!store.agents.list().find(a => a.name === generalName)) {
    store.agents.create({ name: generalName, is_main: false, api_connection_id: fakeConn.id, model: 'model-B', tools: [] });
  }
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
  // 重新读取 main agent，确认 update 真的写入了数据库
  const mainAfter = main ? store.agents.get(main.id) : null;
  console.log('SEED_OK project=' + proj.id + ' mainAgent=' + (main ? main.id : 'none') + ' openaiConn=' + (openai ? openai.id : 'none') + ' fakeConn=' + (fakeConn ? fakeConn.id : 'none') + (baseUrl ? ' base=' + baseUrl : ''));
  console.log('SEED_VERIFY main.model=' + (mainAfter ? mainAfter.model : 'null') + ' main.api_connection_id=' + (mainAfter ? mainAfter.api_connection_id : 'null') + ' main.is_main=' + (mainAfter ? mainAfter.is_main : 'null'));
  process.exit(0);
}
