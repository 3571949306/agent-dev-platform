'use strict';
/**
 * P0-1 / P0-3 at the runtime level.
 *
 * The provider tests prove the adapters honour `opts.model`. These prove the
 * Agent Runtime actually *passes* it (v2.0.0 never did), records the routing
 * decision, keeps unknown cost as NULL, and turns tool screenshots into real
 * image parts on the next request.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('../src/db/store');
const providers = require('../src/providers');
const { runAgentTurn } = require('../src/agent/runtime');
const { PermissionEngine } = require('../src/security/permissions');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-route-'));
store.init(USER_DATA);

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rp-'));
  return store.projects.create({ name, rootPath: root });
}

function baseDeps({ project, conn, events, resolveModel, visionSupport, tools = {} }) {
  const provider = providers.getProvider(conn);
  return {
    provider,
    deps: {
      store,
      project,
      projectRoot: project.root_path,
      permissionEngine: new PermissionEngine(),
      buildProvider: async () => provider,
      resolveModel,
      visionSupport,
      artifactsDir: path.join(project.root_path, '.adp', 'artifacts'),
      getTool: (name) => tools[name] || null,
      subAgentTool: () => null,
      runSubAgent: async () => JSON.stringify({ ok: true }),
      sendChatTask: async () => '',
      requestPermission: async () => ({ decision: 'allow', range: 'task' }),
      emit: (type, payload) => events.push({ type, ...payload }),
      pinnedFacts: []
    }
  };
}

const AGENT = {
  id: 'a-route', name: '路由测试 Agent', description: 'sys', max_steps: 4,
  timeout_ms: 30000, temperature: 0.3, max_tokens: 512, provider: 'mock'
};

test('Runtime: Agent 选的 model-B 真的传给了 Provider（不是连接的 models[0]）', async () => {
  const project = makeProject('route1');
  const conv = store.conversations.create({ projectId: project.id, title: 'r1' });
  const events = [];
  const conn = { provider: 'mock', models: ['model-A', 'model-B'], mockText: '好的' };
  const agent = { ...AGENT, model: 'model-B' };

  const { provider, deps } = baseDeps({
    project, conn, events,
    resolveModel: () => providers.resolveModel({ agent, conn })
  });

  const r = await runAgentTurn(deps, { agent, conversationId: conv.id, userMessage: 'hi', history: [], toolDefs: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(provider.calls.length, 1, '应当只调用一次模型');
  assert.strictEqual(provider.calls[0].model, 'model-B');
  assert.strictEqual(provider.calls[0].requested, 'model-B', 'runtime 必须显式传 model 参数');
});

test('Runtime: 模型路由决策落库 model_calls，可回答“为什么用了这个模型”', async () => {
  store.modelCalls.clear();
  const project = makeProject('route2');
  const conv = store.conversations.create({ projectId: project.id, title: 'r2' });
  const events = [];
  const conn = { provider: 'mock', models: ['model-A', 'model-B'], mockText: 'ok' };
  const agent = { ...AGENT, model: 'model-B' };

  const { deps } = baseDeps({
    project, conn, events,
    resolveModel: () => ({ ...providers.resolveModel({ agent, conn }), provider: 'mock', connectionId: 'conn-1', connectionName: '本地 Mock' })
  });
  await runAgentTurn(deps, { agent, conversationId: conv.id, userMessage: 'hi', history: [], toolDefs: [] });

  const rows = store.modelCalls.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].requested_model, 'model-B');
  assert.strictEqual(rows[0].actual_model, 'model-B');
  assert.strictEqual(rows[0].model_source, 'agent');
  assert.strictEqual(rows[0].fell_back, 0);
  assert.strictEqual(rows[0].connection_name, '本地 Mock');
  assert.strictEqual(rows[0].protocol, 'mock');
  assert.strictEqual(rows[0].ok, 1);
  assert.deepStrictEqual(store.modelCalls.mismatches(), [], '不应存在“要 A 用了 B”的记录');
});

test('Runtime: Agent 未指定模型时如实记录回落来源 fellBack=1', async () => {
  store.modelCalls.clear();
  const project = makeProject('route3');
  const conv = store.conversations.create({ projectId: project.id, title: 'r3' });
  const conn = { provider: 'mock', default_model: 'model-D', models: ['model-A'], mockText: 'ok' };
  const agent = { ...AGENT, model: null };

  const { provider, deps } = baseDeps({
    project, conn, events: [],
    resolveModel: () => providers.resolveModel({ agent, conn })
  });
  await runAgentTurn(deps, { agent, conversationId: conv.id, userMessage: 'hi', history: [], toolDefs: [] });

  assert.strictEqual(provider.calls[0].model, 'model-D');
  const row = store.modelCalls.list()[0];
  assert.strictEqual(row.requested_model, null);
  assert.strictEqual(row.actual_model, 'model-D');
  assert.strictEqual(row.model_source, 'connection.default_model');
  assert.strictEqual(row.fell_back, 1);
});

test('Runtime: 模型调用失败也要记账（ok=0 + 错误原因）', async () => {
  store.modelCalls.clear();
  const project = makeProject('route4');
  const conv = store.conversations.create({ projectId: project.id, title: 'r4' });
  const agent = { ...AGENT, model: 'model-B' };
  const provider = {
    protocol: 'mock', endpoint: 'mock://x',
    streamResponse: async () => { throw new Error('上游 502'); }
  };
  const deps = {
    store, project, projectRoot: project.root_path,
    permissionEngine: new PermissionEngine(),
    buildProvider: async () => provider,
    resolveModel: () => ({ requested: 'model-B', model: 'model-B', source: 'agent', fellBack: false, connectionId: null }),
    getTool: () => null, subAgentTool: () => null,
    runSubAgent: async () => '', sendChatTask: async () => '',
    requestPermission: async () => ({ decision: 'allow' }),
    emit: () => {}, pinnedFacts: []
  };
  const r = await runAgentTurn(deps, { agent, conversationId: conv.id, userMessage: 'hi', history: [], toolDefs: [] });
  assert.strictEqual(r.ok, false);
  const row = store.modelCalls.list()[0];
  assert.strictEqual(row.ok, 0);
  assert.match(row.error, /502/);
});

test('Usage: 无法定价时 estimated_cost 必须是 NULL，汇总显示未知而不是 ¥0.00', async () => {
  const project = makeProject('route5');
  const conv = store.conversations.create({ projectId: project.id, title: 'r5' });
  const conn = { provider: 'mock', models: ['model-B'], mockText: 'ok' };
  const agent = { ...AGENT, model: 'model-B' };
  const { deps } = baseDeps({ project, conn, events: [], resolveModel: () => providers.resolveModel({ agent, conn }) });
  await runAgentTurn(deps, { agent, conversationId: conv.id, userMessage: 'hi', history: [], toolDefs: [] });

  const last = store.usage.list(1)[0];
  assert.strictEqual(last.estimated_cost, null, 'estimated_cost 应为 NULL');
  assert.strictEqual(last.requested_model, 'model-B');
  const sum = store.usage.summary();
  assert.strictEqual(sum.cost, null, '全部未定价时汇总成本应为 null（UI 显示“未知”）');
  assert.ok(sum.unpriced >= 1);
});

// ------------------------------------------------------------------- Vision
function screenshotTool() {
  return {
    def: { name: 'computer_screenshot', description: 'shot', parameters: { type: 'object', properties: {} } },
    permission: 'computer',
    source: 'builtin',
    exec: async () => ({ ok: true, data: { width: 1, height: 1, data_url: `data:image/png;base64,${PNG_1PX}` } })
  };
}

test('Vision: 视觉模型下截图作为真正的 image part 进入下一轮请求', async () => {
  const project = makeProject('vision1');
  const conv = store.conversations.create({ projectId: project.id, title: 'v1' });
  const events = [];
  const conn = {
    provider: 'mock',
    mockScript: [
      { toolCalls: [{ name: 'computer_screenshot', arguments: {} }] },
      { text: '我看到屏幕上是空白的一像素。' }
    ]
  };
  const agent = { ...AGENT, model: 'gpt-4o' };
  const { provider, deps } = baseDeps({
    project, conn, events,
    resolveModel: () => providers.resolveModel({ agent, conn }),
    visionSupport: () => true,
    tools: { computer_screenshot: screenshotTool() }
  });

  await runAgentTurn(deps, {
    agent, conversationId: conv.id, userMessage: '看一下屏幕', history: [],
    toolDefs: [{ name: 'computer_screenshot', description: 'shot', parameters: { type: 'object', properties: {} } }]
  });

  assert.strictEqual(provider.calls.length, 2, '应有两轮模型调用');
  const second = provider.calls[1].messages;
  const imgMsg = second.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
  assert.ok(imgMsg, '第二轮请求里必须带 image part，实际：' + JSON.stringify(second.map(m => m.role)));
  const part = imgMsg.content.find(p => p.type === 'image');
  assert.strictEqual(part.mime, 'image/png');
  assert.strictEqual(part.data, PNG_1PX);

  // artifact written to disk, not stuffed into the DB
  const visionEvt = events.find(e => e.type === 'vision_input');
  assert.ok(visionEvt, '应发出 vision_input 事件');
  assert.strictEqual(visionEvt.count, 1);
  assert.ok(fs.existsSync(visionEvt.files[0]), '截图应落盘为 artifact 文件');

  // the tool result the model reads must NOT contain the base64 blob
  const toolResult = events.filter(e => e.type === 'tool_result').pop();
  assert.ok(!/base64/.test(toolResult.result), '工具结果不应把 base64 塞回上下文');
  assert.match(toolResult.result, /image_file/);
});

test('Vision: 非视觉模型不塞图片，改成可执行的文字降级提示', async () => {
  const project = makeProject('vision2');
  const conv = store.conversations.create({ projectId: project.id, title: 'v2' });
  const events = [];
  const conn = {
    provider: 'mock',
    mockScript: [
      { toolCalls: [{ name: 'computer_screenshot', arguments: {} }] },
      { text: '我改用 UI 树来读取界面。' }
    ]
  };
  const agent = { ...AGENT, model: 'deepseek-r1' };
  const { provider, deps } = baseDeps({
    project, conn, events,
    resolveModel: () => providers.resolveModel({ agent, conn }),
    visionSupport: () => false,
    tools: { computer_screenshot: screenshotTool() }
  });

  await runAgentTurn(deps, {
    agent, conversationId: conv.id, userMessage: '看一下屏幕', history: [],
    toolDefs: [{ name: 'computer_screenshot', description: 'shot', parameters: { type: 'object', properties: {} } }]
  });

  const second = provider.calls[1].messages;
  assert.ok(!second.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image')), '不支持视觉时不得发送图片');
  const hint = second.filter(m => m.role === 'user').pop();
  assert.match(String(hint.content), /不具备视觉能力/);
  assert.ok(events.find(e => e.type === 'vision_skipped'), '应发出 vision_skipped 事件');
});
