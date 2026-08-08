'use strict';
/**
 * 集成测试：完整 Agent Loop
 * 打开项目 → 对话 → read_file → apply_patch → terminal_run → 汇报结果
 * 使用 Mock Provider 的脚本模式，无需真实 API Key。
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('../src/db/store');
const registry = require('../src/tools/registry');
const providers = require('../src/providers');
const { runAgentTurn } = require('../src/agent/runtime');
const { PermissionEngine } = require('../src/security/permissions');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-loop-'));
store.init(USER_DATA);

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-proj-'));
  fs.writeFileSync(path.join(root, 'app.js'), "const version = '1.0.0';\nconsole.log(version);\n");
  return store.projects.create({ name, rootPath: root });
}

/** Build a self-contained deps object equivalent to the one the IPC layer injects. */
function makeDeps({ project, script, events, permissionMode = 'allow', permissionEngine }) {
  const pe = permissionEngine || new PermissionEngine();
  const conn = { provider: 'mock', mockScript: script };
  // The runtime rebuilds the provider on every step; a scripted mock keeps its
  // cursor in closure state, so it must be created once (real providers are stateless).
  const provider = providers.getProvider(conn);
  return {
    store,
    project,
    projectRoot: project.root_path,
    permissionEngine: pe,
    buildProvider: async () => provider,
    getTool: (name) => {
      const b = registry.getBuiltin(name);
      return b ? { def: b.def, exec: b.exec, permission: b.permission, permissionFor: b.permissionFor, source: 'builtin' } : null;
    },
    subAgentTool: () => null,
    runSubAgent: async () => JSON.stringify({ ok: true }),
    sendChatTask: async () => '',
    requestPermission: async (req) => {
      events.push({ type: '_permission_asked', scope: req.scope, tool: req.tool });
      return { decision: permissionMode === 'deny' ? 'deny' : 'allow', range: 'task' };
    },
    emit: (type, payload) => events.push({ type, ...payload }),
    pinnedFacts: []
  };
}

const toolDefs = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
  { name: 'apply_patch', description: 'patch', parameters: { type: 'object', properties: {} } },
  { name: 'terminal_run', description: 'run', parameters: { type: 'object', properties: {} } },
  { name: 'delete_file', description: 'del', parameters: { type: 'object', properties: {} } }
];

function newAgent(extra = {}) {
  return Object.assign({
    id: 'agent-test', name: '测试主Agent', description: '你是测试 Agent', max_steps: 10,
    timeout_ms: 60000, temperature: 0.2, max_tokens: 1024, model: 'mock-fast', provider: 'mock'
  }, extra);
}

test('端到端：读文件 → 打补丁 → 跑命令 → 完成', async () => {
  const project = makeProject('e2e');
  const conv = store.conversations.create({ projectId: project.id, title: 'e2e' });
  const events = [];

  const script = [
    { toolCalls: [{ name: 'read_file', arguments: { path: 'app.js' } }] },
    { toolCalls: [{ name: 'apply_patch', arguments: { path: 'app.js', patch: "@@ -1,2 +1,2 @@\n-const version = '1.0.0';\n+const version = '2.0.0';\n console.log(version);" } }] },
    { toolCalls: [{ name: 'terminal_run', arguments: { command: 'node app.js' } }] },
    { text: '已把版本号升级到 2.0.0，并运行验证通过。' }
  ];

  const deps = makeDeps({ project, script, events });
  const r = await runAgentTurn(deps, {
    agent: newAgent(), conversationId: conv.id,
    userMessage: '把 app.js 里的版本号改成 2.0.0 并运行验证',
    history: [], toolDefs
  });

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.content, /2\.0\.0/);

  // 文件真的被改了
  const after = fs.readFileSync(path.join(project.root_path, 'app.js'), 'utf8');
  assert.match(after, /const version = '2\.0\.0';/);

  // 命令真的跑了，并且拿到真实 stdout
  const termResult = events.filter(e => e.type === 'tool_result' && e.name === 'terminal_run').pop();
  assert.ok(termResult, '应有 terminal_run 结果');
  const parsed = JSON.parse(termResult.result);
  assert.strictEqual(parsed.exit_code, 0, 'node app.js 应成功退出：' + termResult.result);
  assert.match(parsed.stdout, /2\.0\.0/);

  // 事件流完整
  const types = events.map(e => e.type);
  for (const need of ['task_start', 'tool_call', 'tool_result', 'file_changed', 'terminal_start', 'assistant_message', 'task_complete']) {
    assert.ok(types.includes(need), `缺少事件 ${need}；实际：${[...new Set(types)].join(',')}`);
  }

  // 任务收敛为 completed
  const task = store.tasks.get(r.taskId);
  assert.strictEqual(task.status, 'completed');

  // 工具结果已落库为 tool 消息，且与 assistant.tool_calls 配对
  const msgs = store.messages.list(conv.id);
  const assistantWithCalls = msgs.filter(m => m.role === 'assistant' && m.tool_calls);
  const toolMsgs = msgs.filter(m => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, assistantWithCalls.length, '每个 tool_calls 都应有配对的 tool 消息');
  for (const a of assistantWithCalls) {
    for (const tc of a.tool_calls) {
      assert.ok(toolMsgs.some(t => t.tool_call_id === tc.id), `tool_call ${tc.id} 缺少配对结果`);
    }
  }
});

test('权限：高危工具触发询问；用户拒绝则工具不执行', async () => {
  const project = makeProject('perm');
  fs.writeFileSync(path.join(project.root_path, 'victim.txt'), 'do not delete');
  const conv = store.conversations.create({ projectId: project.id, title: 'perm' });
  const events = [];

  const script = [
    { toolCalls: [{ name: 'delete_file', arguments: { path: 'victim.txt' } }] },
    { text: '已停止：用户拒绝删除。' }
  ];
  const deps = makeDeps({ project, script, events, permissionMode: 'deny' });
  await runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: '删掉 victim.txt', history: [], toolDefs });

  assert.ok(events.some(e => e.type === '_permission_asked' && e.scope === 'filesystem.delete'), '应对删除申请权限');
  assert.ok(fs.existsSync(path.join(project.root_path, 'victim.txt')), '被拒绝后文件必须还在');
  const res = events.filter(e => e.type === 'tool_result' && e.name === 'delete_file').pop();
  assert.match(res.result, /PERMISSION_DENIED/);
});

test('权限：filesystem.read 默认放行，不打扰用户', async () => {
  const project = makeProject('perm2');
  const conv = store.conversations.create({ projectId: project.id, title: 'p2' });
  const events = [];
  const deps = makeDeps({
    project, events,
    script: [{ toolCalls: [{ name: 'read_file', arguments: { path: 'app.js' } }] }, { text: 'ok' }]
  });
  await runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: '看看 app.js', history: [], toolDefs });
  assert.ok(!events.some(e => e.type === '_permission_asked'), '读文件不应弹权限');
});

test('防死循环：完全相同的工具调用第二次被拦截', async () => {
  const project = makeProject('dup');
  const conv = store.conversations.create({ projectId: project.id, title: 'dup' });
  const events = [];
  const same = { name: 'read_file', arguments: { path: 'app.js' } };
  const deps = makeDeps({ project, events, script: [{ toolCalls: [same] }, { toolCalls: [same] }, { text: '结束' }] });
  await runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: 'x', history: [], toolDefs });

  const results = events.filter(e => e.type === 'tool_result' && e.name === 'read_file');
  assert.strictEqual(results.length, 2);
  assert.match(results[1].result, /DUPLICATE_ACTION/);
});

test('未知工具返回 UNKNOWN_TOOL 而不是崩溃', async () => {
  const project = makeProject('unk');
  const conv = store.conversations.create({ projectId: project.id, title: 'unk' });
  const events = [];
  const deps = makeDeps({ project, events, script: [{ toolCalls: [{ name: 'fly_to_moon', arguments: {} }] }, { text: '抱歉' }] });
  const r = await runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: 'x', history: [], toolDefs });
  assert.strictEqual(r.ok, true);
  assert.match(events.filter(e => e.type === 'tool_result').pop().result, /UNKNOWN_TOOL/);
});

test('maxSteps 上限生效，任务标记为失败并说明原因', async () => {
  const project = makeProject('steps');
  const conv = store.conversations.create({ projectId: project.id, title: 'steps' });
  const events = [];
  // 每一步都调用不同参数的工具，永不自然结束
  const script = Array.from({ length: 20 }, (_, i) => ({ toolCalls: [{ name: 'read_file', arguments: { path: `nope${i}.txt` } }] }));
  const deps = makeDeps({ project, events, script });
  const r = await runAgentTurn(deps, { agent: newAgent({ max_steps: 3 }), conversationId: conv.id, userMessage: 'loop', history: [], toolDefs });

  const task = store.tasks.get(r.taskId);
  assert.strictEqual(task.status, 'failed');
  assert.match(task.error, /最大步数 3/);
  const done = events.filter(e => e.type === 'task_complete').pop();
  assert.strictEqual(done.status, 'max_steps');
});

test('连续工具失败会主动中止，不会空转到 maxSteps', async () => {
  const project = makeProject('fail');
  const conv = store.conversations.create({ projectId: project.id, title: 'fail' });
  const events = [];
  // read_file 读不存在的文件 → 一直失败（参数不同以避开去重）
  const script = Array.from({ length: 20 }, (_, i) => ({ toolCalls: [{ name: 'read_file', arguments: { path: `missing_${i}.txt` } }] }));
  const deps = makeDeps({ project, events, script });
  const r = await runAgentTurn(deps, { agent: newAgent({ max_steps: 30 }), conversationId: conv.id, userMessage: 'x', history: [], toolDefs });

  const task = store.tasks.get(r.taskId);
  assert.strictEqual(task.status, 'failed');
  assert.match(task.error, /连续工具失败/);
  const calls = events.filter(e => e.type === 'tool_call').length;
  assert.ok(calls <= 6, `应在 6 步内中止，实际 ${calls} 步`);
});

test('Stop：abort 后任务标记 cancelled', async () => {
  const project = makeProject('stop');
  const conv = store.conversations.create({ projectId: project.id, title: 'stop' });
  const events = [];
  const ac = new AbortController();
  const script = Array.from({ length: 10 }, (_, i) => ({ toolCalls: [{ name: 'read_file', arguments: { path: `app.js`, _i: i } }] }));
  const deps = makeDeps({ project, events, script });
  deps.abortSignal = ac.signal;

  const p = runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: 'x', history: [], toolDefs });
  setTimeout(() => ac.abort(), 15);
  const r = await p;

  assert.strictEqual(r.aborted, true, JSON.stringify(r));
  assert.strictEqual(store.tasks.get(r.taskId).status, 'cancelled');
  assert.ok(events.some(e => e.type === 'task_cancelled'));
});

test('system prompt 从 prompts 表读取并注入模型', async () => {
  const project = makeProject('sys');
  const conv = store.conversations.create({ projectId: project.id, title: 'sys' });
  const prompt = store.prompts.create({ name: 'p', content: '你必须永远用中文回答，代号 XYZZY。' });
  const events = [];

  let seenSystem = null;
  const deps = makeDeps({ project, events, script: [{ text: 'ok' }] });
  const inner = deps.buildProvider;
  deps.buildProvider = async (agent) => {
    const p = await inner(agent);
    const orig = p.streamResponse;
    p.streamResponse = async (opts) => { seenSystem = opts.system; return orig(opts); };
    return p;
  };

  await runAgentTurn(deps, {
    agent: newAgent({ system_prompt_id: prompt.id }), conversationId: conv.id,
    userMessage: 'hi', history: [], toolDefs
  });

  assert.ok(seenSystem.includes('XYZZY'), 'system prompt 未注入：' + seenSystem);
  assert.ok(seenSystem.includes(project.root_path), 'system prompt 应包含项目根目录');
});

test('历史压缩：超长历史被裁剪但保留最近轮次', async () => {
  const project = makeProject('hist');
  const conv = store.conversations.create({ projectId: project.id, title: 'hist' });
  const events = [];
  const history = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'msg' + i }));

  let seenMessages = null;
  const deps = makeDeps({ project, events, script: [{ text: 'ok' }] });
  const inner = deps.buildProvider;
  deps.buildProvider = async (agent) => {
    const p = await inner(agent);
    const orig = p.streamResponse;
    p.streamResponse = async (opts) => { seenMessages = opts.messages.slice(); return orig(opts); };
    return p;
  };

  await runAgentTurn(deps, { agent: newAgent(), conversationId: conv.id, userMessage: 'x', history, toolDefs });
  assert.ok(seenMessages.length < 60, '历史应被压缩');
  assert.strictEqual(seenMessages[seenMessages.length - 1].content, 'msg59', '最近一条必须保留');
  assert.match(seenMessages[0].content, /已压缩省略/);
});
